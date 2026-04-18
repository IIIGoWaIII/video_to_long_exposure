import { useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const DEFAULT_FPS = 2;
const SEARCH_RADIUS = 8;
const STEP = 2;
const SCALE_FOR_ALIGN = 0.25;
const FFMPEG_BASE_URL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function acesTonemap(x) {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  return Math.max(0, Math.min(1, (x * (a * x + b)) / (x * (c * x + d) + e)));
}

function gammaCorrect(v) {
  return Math.max(0, Math.min(1, Math.pow(v, 1 / 2.2)));
}

function degamma(v) {
  return Math.max(0, Math.pow(v, 2.2));
}

function buildTonemapLut() {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const linear = srgbToLinear(i / 255);
    const tonemapped = acesTonemap(linear);
    lut[i] = gammaCorrect(tonemapped);
  }
  return lut;
}

const TONEMAP_LUT = buildTonemapLut();

function applyTonemap(hdrFloat, counts, width, height, exposure, frameCount, lut) {
  const result = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    let r = hdrFloat[idx] * exposure;
    let g = hdrFloat[idx + 1] * exposure;
    let b = hdrFloat[idx + 2] * exposure;
    if (counts && counts[i] > 0) {
      r /= counts[i];
      g /= counts[i];
      b /= counts[i];
    }
    const tonemappedR = acesTonemap(r);
    const tonemappedG = acesTonemap(g);
    const tonemappedB = acesTonemap(b);
    result[idx] = Math.round(gammaCorrect(tonemappedR) * 255);
    result[idx + 1] = Math.round(gammaCorrect(tonemappedG) * 255);
    result[idx + 2] = Math.round(gammaCorrect(tonemappedB) * 255);
    result[idx + 3] = 255;
  }
  return result;
}

let ffmpegSingleton = null;
let ffmpegLoadPromise = null;

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getDeviceCapabilities() {
  const memoryGb = Number(navigator.deviceMemory || 4);
  const cores = Number(navigator.hardwareConcurrency || 4);
  return { memoryGb, cores, strongDevice: memoryGb >= 6 || cores >= 6 };
}

function createVideoElement(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    video.onloadedmetadata = () => resolve({ video, objectUrl });
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read this video file."));
    };
  });
}

async function getFfmpeg(setStatus) {
  if (ffmpegSingleton) return ffmpegSingleton;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;
  ffmpegLoadPromise = (async () => {
    setStatus("Loading converter...");
    const ffmpeg = new FFmpeg();
    const coreURL = await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm`, "application/wasm");
    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegSingleton = ffmpeg;
    return ffmpeg;
  })();
  return ffmpegLoadPromise;
}

async function transcodeToMp4(file, setStatus) {
  const ffmpeg = await getFfmpeg(setStatus);
  setStatus("Converting...");
  const safeInputName = `input-${Date.now()}.bin`;
  const outputName = `converted-${Date.now()}.mp4`;
  await ffmpeg.writeFile(safeInputName, await fetchFile(file));
  await ffmpeg.exec([
    "-i", safeInputName,
    "-movflags", "faststart",
    "-pix_fmt", "yuv420p",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-c:a", "aac",
    outputName
  ]);
  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(safeInputName);
  await ffmpeg.deleteFile(outputName);
  return new File([data.buffer], `${file.name.replace(/\.[^/.]+$/, "") || "video"}.mp4`, { type: "video/mp4" });
}

async function seekVideo(video, timeSeconds) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { video.removeEventListener("seeked", onSeeked); resolve(); };
    const onError = () => { video.removeEventListener("error", onError); reject(new Error("Seek failed")); };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = timeSeconds;
  });
}

function downscaleLuma(imageData, width, height, scale) {
  const targetW = Math.max(16, Math.floor(width * scale));
  const targetH = Math.max(16, Math.floor(height * scale));
  const result = new Uint8ClampedArray(targetW * targetH);
  const data = imageData.data;
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(width - 1, Math.floor((x / targetW) * width));
      const sy = Math.min(height - 1, Math.floor((y / targetH) * height));
      const idx = (sy * width + sx) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      result[y * targetW + x] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
  }
  return { luma: result, width: targetW, height: targetH };
}

function scoreShift(reference, candidate, width, height, shiftX, shiftY) {
  const startX = Math.max(0, shiftX);
  const startY = Math.max(0, shiftY);
  const endX = Math.min(width, width + shiftX);
  const endY = Math.min(height, height + shiftY);
  let error = 0, count = 0;
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const refIdx = y * width + x;
      const candX = x - shiftX, candY = y - shiftY;
      const candIdx = candY * width + candX;
      error += Math.abs(reference[refIdx] - candidate[candIdx]);
      count++;
    }
  }
  if (count === 0) return Number.POSITIVE_INFINITY;
  return error / count;
}

function estimateTranslation(refDownscaled, candidateDownscaled) {
  let best = { dx: 0, dy: 0, score: Number.POSITIVE_INFINITY };
  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += STEP) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += STEP) {
      const score = scoreShift(refDownscaled.luma, candidateDownscaled.luma, refDownscaled.width, refDownscaled.height, dx, dy);
      if (score < best.score) best = { dx, dy, score };
    }
  }
  return { dx: Math.round(best.dx / SCALE_FOR_ALIGN), dy: Math.round(best.dy / SCALE_FOR_ALIGN) };
}

function addFrameToHdrAccumulator(frameData, hdrBuffer, width, height, shiftX, shiftY) {
  const data = frameData.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = x - shiftX;
      const sourceY = y - shiftY;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) continue;
      const dstPixel = y * width + x;
      const srcPixel = sourceY * width + sourceX;
      const srcIdx = srcPixel * 4;
      const dstIdx = dstPixel * 4;
      hdrBuffer[dstIdx] += degamma(data[srcIdx] / 255);
      hdrBuffer[dstIdx + 1] += degamma(data[srcIdx + 1] / 255);
      hdrBuffer[dstIdx + 2] += degamma(data[srcIdx + 2] / 255);
    }
  }
}

function addFrameToMeanAccumulator(frameData, hdrBuffer, counts, width, height, shiftX, shiftY) {
  const data = frameData.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = x - shiftX;
      const sourceY = y - shiftY;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) continue;
      const dstPixel = y * width + x;
      const srcPixel = sourceY * width + sourceX;
      const srcIdx = srcPixel * 4;
      const dstIdx = dstPixel * 4;
      hdrBuffer[dstIdx] += degamma(data[srcIdx] / 255);
      hdrBuffer[dstIdx + 1] += degamma(data[srcIdx + 1] / 255);
      hdrBuffer[dstIdx + 2] += degamma(data[srcIdx + 2] / 255);
      counts[dstPixel]++;
    }
  }
}

function addFrameToOriginalMeanAccumulator(frameData, sums, width, height, shiftX, shiftY) {
  const data = frameData.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = x - shiftX;
      const sourceY = y - shiftY;
      const dstPixel = y * width + x;
      const dstIdx = dstPixel * 4;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) {
        continue;
      }
      const srcPixel = sourceY * width + sourceX;
      const srcIdx = srcPixel * 4;
      sums[dstIdx] += data[srcIdx];
      sums[dstIdx + 1] += data[srcIdx + 1];
      sums[dstIdx + 2] += data[srcIdx + 2];
      sums[dstIdx + 3] += data[srcIdx + 3];
    }
  }
}

function makeOriginalMeanImage(sums, width, height, frameCount) {
  const out = new Uint8ClampedArray(width * height * 4);
  const denominator = Math.max(1, frameCount);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    out[idx] = Math.round(sums[idx] / denominator);
    out[idx + 1] = Math.round(sums[idx + 1] / denominator);
    out[idx + 2] = Math.round(sums[idx + 2] / denominator);
    out[idx + 3] = Math.round(sums[idx + 3] / denominator);
  }
  return new ImageData(out, width, height);
}

function buildFrameTimes(duration, fps) {
  const interval = 1 / fps;
  const times = [];
  for (let t = 0; t < duration; t += interval) times.push(t);
  return times;
}

const MAX_FRAMES_DESKTOP = 180;
const MAX_PIXELS_MOBILE_BASE = 1280 * 720;
const MAX_FRAMES_MOBILE_BASE = 80;

function getAdaptiveMobileLimits() {
  const { strongDevice } = getDeviceCapabilities();
  if (strongDevice) return { maxFrames: 180, maxPixels: 1920 * 1080 };
  return { maxFrames: MAX_FRAMES_MOBILE_BASE, maxPixels: MAX_PIXELS_MOBILE_BASE };
}

export default function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [alignFrames, setAlignFrames] = useState(true);
  const [downscale, setDownscale] = useState(true);
  const [exposure, setExposure] = useState(1);
  const [meanBlend, setMeanBlend] = useState(false);
  const [originalMeanBlend, setOriginalMeanBlend] = useState(false);
  const [ignoreMobileLimits, setIgnoreMobileLimits] = useState(false);
  const [status, setStatus] = useState("Select video, then hit Generate.");
  const [progress, setProgress] = useState(0);
  const [outputUrl, setOutputUrl] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const canvasRef = useRef(null);

  const mobile = useMemo(() => isMobileDevice(), []);
  const deviceCaps = useMemo(() => getDeviceCapabilities(), []);

  async function run() {
    if (!videoFile || processing) return;
    if (!Number.isFinite(Number(fps)) || Number(fps) <= 0) {
      setError("Frame rate must be > 0.");
      return;
    }
    setProcessing(true);
    setError("");
    setOutputUrl("");
    setProgress(0);
    setStatus("Loading video...");
    let objectUrl = "";
    let workingFile = videoFile;

    try {
      let videoResult;
      try {
        videoResult = await createVideoElement(workingFile);
      } catch {
        workingFile = await transcodeToMp4(videoFile, setStatus);
        videoResult = await createVideoElement(workingFile);
      }
      const { video, objectUrl: localUrl } = videoResult;
      objectUrl = localUrl;

      const baseWidth = video.videoWidth;
      const baseHeight = video.videoHeight;
      const scale = downscale && mobile ? 0.5 : 1;
      const width = Math.max(2, Math.floor(baseWidth * scale));
      const height = Math.max(2, Math.floor(baseHeight * scale));

      const frameTimes = buildFrameTimes(video.duration, Number(fps));
      const adaptiveLimits = mobile ? getAdaptiveMobileLimits() : null;
      const maxFrames = mobile ? adaptiveLimits.maxFrames : MAX_FRAMES_DESKTOP;
      const maxPixels = mobile ? adaptiveLimits.maxPixels : Number.POSITIVE_INFINITY;
      if (!ignoreMobileLimits && frameTimes.length > maxFrames) {
        throw new Error(`Too many frames (${frameTimes.length}). Lower FPS or trim clip. Limit: ${maxFrames}.`);
      }
      if (!ignoreMobileLimits && mobile && width * height > maxPixels) {
        throw new Error("Resolution too high for mobile. Enable downscale.");
      }

      setStatus(`Sampling ${frameTimes.length} frames...`);

      const workCanvas = document.createElement("canvas");
      workCanvas.width = width;
      workCanvas.height = height;
      const workCtx = workCanvas.getContext("2d");

      const frameCache = [];
      for (let i = 0; i < frameTimes.length; i++) {
        await seekVideo(video, frameTimes[i]);
        workCtx.drawImage(video, 0, 0, width, height);
        frameCache.push(workCtx.getImageData(0, 0, width, height));
        setProgress(Math.round(((i + 1) / frameTimes.length) * 40));
      }

      const hdrBuffer = new Float32Array(width * height * 4);
      const counts = meanBlend ? new Uint32Array(width * height) : null;
      const originalSums = originalMeanBlend ? new Float64Array(width * height * 4) : null;
      let refDownscaled = null;

      setStatus(
        alignFrames
          ? originalMeanBlend
            ? "Aligning and original mean blending..."
            : meanBlend
            ? "Aligning and averaging..."
            : "Aligning and accumulating HDR..."
          : originalMeanBlend
          ? "Original mean blending..."
          : meanBlend
          ? "Averaging..."
          : "Accumulating HDR..."
      );

      for (let i = 0; i < frameCache.length; i++) {
        const frame = frameCache[i];
        let shiftX = 0, shiftY = 0;

        if (alignFrames) {
          const thisDownscaled = downscaleLuma(frame, width, height, SCALE_FOR_ALIGN);
          if (!refDownscaled) {
            refDownscaled = thisDownscaled;
          } else {
            const shift = estimateTranslation(refDownscaled, thisDownscaled);
            shiftX = shift.dx;
            shiftY = shift.dy;
          }
        }

        if (originalMeanBlend) {
          addFrameToOriginalMeanAccumulator(frame, originalSums, width, height, shiftX, shiftY);
        } else if (meanBlend) {
          addFrameToMeanAccumulator(frame, hdrBuffer, counts, width, height, shiftX, shiftY);
        } else {
          addFrameToHdrAccumulator(frame, hdrBuffer, width, height, shiftX, shiftY);
        }
        setProgress(40 + Math.round(((i + 1) / frameCache.length) * 40));
      }

      setProgress(85);
      let result;
      if (originalMeanBlend) {
        setStatus("Building original mean blend...");
        result = makeOriginalMeanImage(originalSums, width, height, frameCache.length);
      } else {
        setStatus("Applying tonemapping...");
        const tonemapped = applyTonemap(
          hdrBuffer,
          counts,
          width,
          height,
          exposure,
          meanBlend ? frameCache.length : 1,
          TONEMAP_LUT
        );
        result = new ImageData(tonemapped, width, height);
      }

      const previewCanvas = canvasRef.current;
      previewCanvas.width = width;
      previewCanvas.height = height;
      const previewCtx = previewCanvas.getContext("2d");
      previewCtx.putImageData(result, 0, 0);

      const finalUrl = previewCanvas.toDataURL("image/jpeg", 0.95);
      setOutputUrl(finalUrl);
      setStatus("Done. Download your HDR long exposure.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
      setStatus("Failed.");
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setProcessing(false);
    }
  }

  return (
    <main className="page">
      <section className="card">
        <h1>Video to Long Exposure</h1>
        <p className="sub">Turn video into one long-exposure image in browser.</p>

        <label className="field">
          <span>Video file</span>
          <input type="file" accept="video/*" onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)} disabled={processing} />
        </label>

        <label className="field">
          <span>Frame rate (frames/sec)</span>
          <input type="number" min="0.25" max="24" step="0.25" value={fps} onChange={(e) => setFps(Number(e.target.value))} disabled={processing} />
        </label>

        <label className="row">
          <input type="checkbox" checked={alignFrames} onChange={(e) => setAlignFrames(e.target.checked)} disabled={processing} />
          <span>Align frames (reduce camera shake)</span>
        </label>

        <label className="field">
          <span>Exposure</span>
          <input type="number" min="0.01" max="4" step="0.01" value={exposure} onChange={(e) => setExposure(Number(e.target.value))} disabled={processing} />
        </label>

        <label className="row">
          <input type="checkbox" checked={meanBlend} onChange={(e) => setMeanBlend(e.target.checked)} disabled={processing} />
          <span>Mean blend (average frames)</span>
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={originalMeanBlend}
            onChange={(e) => setOriginalMeanBlend(e.target.checked)}
            disabled={processing}
          />
          <span>Original mean blending (classic, no tonemap)</span>
        </label>

        <label className="row">
          <input type="checkbox" checked={downscale} onChange={(e) => setDownscale(e.target.checked)} disabled={processing} />
          <span>Downscale on mobile (saver)</span>
        </label>

        {mobile ? (
          <>
            <p className="hint">
              Mobile: {deviceCaps.memoryGb}GB RAM, {deviceCaps.cores} CPU.{deviceCaps.strongDevice ? " Strong." : " Safe."}
            </p>
            <label className="row">
              <input type="checkbox" checked={ignoreMobileLimits} onChange={(e) => setIgnoreMobileLimits(e.target.checked)} disabled={processing} />
              <span>Ignore mobile limits (advanced)</span>
            </label>
          </>
        ) : null}

        <button onClick={run} disabled={!videoFile || processing}>
          {processing ? "Working..." : "Generate Long Exposure"}
        </button>

        <div className="progressWrap" aria-hidden={!processing}>
          <div className="progressBar" style={{ width: `${progress}%` }} />
        </div>
        <p className="status">{status}</p>
        {error ? <p className="error">{error}</p> : null}

        <canvas ref={canvasRef} className="preview" />

        {outputUrl ? (
          <a className="download" href={outputUrl} download="long-exposure.jpg">
            Download Image
          </a>
        ) : null}
      </section>
    </main>
  );
}