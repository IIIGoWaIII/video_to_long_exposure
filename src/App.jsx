import { useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const DEFAULT_FPS = 2;
const MAX_PIXELS_MOBILE_BASE = 1280 * 720;
const MAX_FRAMES_MOBILE_BASE = 80;
const MAX_FRAMES_DESKTOP = 180;
const SEARCH_RADIUS = 8;
const STEP = 2;
const SCALE_FOR_ALIGN = 0.25;
const FFMPEG_BASE_URL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

let ffmpegSingleton = null;
let ffmpegLoadPromise = null;

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getDeviceCapabilities() {
  const memoryGb = Number(navigator.deviceMemory || 4);
  const cores = Number(navigator.hardwareConcurrency || 4);
  return {
    memoryGb,
    cores,
    strongDevice: memoryGb >= 6 || cores >= 6
  };
}

function getAdaptiveMobileLimits() {
  const { strongDevice } = getDeviceCapabilities();
  if (strongDevice) {
    return {
      maxFrames: 180,
      maxPixels: 1920 * 1080
    };
  }

  return {
    maxFrames: MAX_FRAMES_MOBILE_BASE,
    maxPixels: MAX_PIXELS_MOBILE_BASE
  };
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

    video.onloadedmetadata = () => {
      resolve({ video, objectUrl });
    };

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
  setStatus("Converting input to MP4...");

  const safeInputName = `input-${Date.now()}.bin`;
  const outputName = `converted-${Date.now()}.mp4`;

  await ffmpeg.writeFile(safeInputName, await fetchFile(file));
  await ffmpeg.exec([
    "-i",
    safeInputName,
    "-movflags",
    "faststart",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    outputName
  ]);

  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(safeInputName);
  await ffmpeg.deleteFile(outputName);

  return new File([data.buffer], `${file.name.replace(/\.[^/.]+$/, "") || "video"}.mp4`, {
    type: "video/mp4"
  });
}

async function seekVideo(video, timeSeconds) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    const onError = () => {
      video.removeEventListener("error", onError);
      reject(new Error("Video seek failed."));
    };
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

  for (let y = 0; y < targetH; y += 1) {
    for (let x = 0; x < targetW; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x / targetW) * width));
      const sy = Math.min(height - 1, Math.floor((y / targetH) * height));
      const idx = (sy * width + sx) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
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

  let error = 0;
  let count = 0;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const refIdx = y * width + x;
      const candX = x - shiftX;
      const candY = y - shiftY;
      const candIdx = candY * width + candX;
      error += Math.abs(reference[refIdx] - candidate[candIdx]);
      count += 1;
    }
  }

  if (count === 0) return Number.POSITIVE_INFINITY;
  return error / count;
}

function estimateTranslation(refDownscaled, candidateDownscaled) {
  let best = { dx: 0, dy: 0, score: Number.POSITIVE_INFINITY };

  for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += STEP) {
    for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += STEP) {
      const score = scoreShift(
        refDownscaled.luma,
        candidateDownscaled.luma,
        refDownscaled.width,
        refDownscaled.height,
        dx,
        dy
      );
      if (score < best.score) {
        best = { dx, dy, score };
      }
    }
  }

  return {
    dx: Math.round(best.dx / SCALE_FOR_ALIGN),
    dy: Math.round(best.dy / SCALE_FOR_ALIGN)
  };
}

function addFrameToAccumulator(frameData, sums, counts, width, height, shiftX, shiftY) {
  const data = frameData.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - shiftX;
      const sourceY = y - shiftY;
      if (sourceX < 0 || sourceY < 0 || sourceX >= width || sourceY >= height) {
        continue;
      }
      const dstPixel = y * width + x;
      const srcPixel = sourceY * width + sourceX;
      const srcIdx = srcPixel * 4;
      sums[dstPixel * 4] += data[srcIdx];
      sums[dstPixel * 4 + 1] += data[srcIdx + 1];
      sums[dstPixel * 4 + 2] += data[srcIdx + 2];
      sums[dstPixel * 4 + 3] += data[srcIdx + 3];
      counts[dstPixel] += 1;
    }
  }
}

function makeResultImage(sums, counts, width, height) {
  const result = new ImageData(width, height);
  const out = result.data;
  for (let i = 0; i < width * height; i += 1) {
    const count = counts[i];
    if (count === 0) continue;
    out[i * 4] = clamp(Math.round(sums[i * 4] / count), 0, 255);
    out[i * 4 + 1] = clamp(Math.round(sums[i * 4 + 1] / count), 0, 255);
    out[i * 4 + 2] = clamp(Math.round(sums[i * 4 + 2] / count), 0, 255);
    out[i * 4 + 3] = clamp(Math.round(sums[i * 4 + 3] / count), 0, 255);
  }
  return result;
}

function buildFrameTimes(duration, fps) {
  const interval = 1 / fps;
  const times = [];
  for (let t = 0; t < duration; t += interval) {
    times.push(t);
  }
  return times;
}

export default function App() {
  const [videoFile, setVideoFile] = useState(null);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [alignFrames, setAlignFrames] = useState(true);
  const [downscale, setDownscale] = useState(true);
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
      setError("Frame rate must be greater than 0.");
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
        throw new Error(
          `Too many frames (${frameTimes.length}). Lower FPS or trim clip. Limit on this device: ${maxFrames}.`
        );
      }
      if (!ignoreMobileLimits && mobile && width * height > maxPixels) {
        throw new Error(
          "Resolution too high for mobile processing. Enable downscale or use a lower-resolution clip."
        );
      }

      const workCanvas = document.createElement("canvas");
      const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
      workCanvas.width = width;
      workCanvas.height = height;

      const previewCanvas = canvasRef.current;
      previewCanvas.width = width;
      previewCanvas.height = height;
      const previewCtx = previewCanvas.getContext("2d");

      setStatus(`Sampling ${frameTimes.length} frames...`);

      const frameCache = [];
      for (let i = 0; i < frameTimes.length; i += 1) {
        await seekVideo(video, frameTimes[i]);
        workCtx.drawImage(video, 0, 0, width, height);
        const imageData = workCtx.getImageData(0, 0, width, height);
        frameCache.push(imageData);
        setProgress(Math.round(((i + 1) / (frameTimes.length * 2)) * 100));
      }

      const sums = new Float64Array(width * height * 4);
      const counts = new Uint32Array(width * height);
      let refDownscaled = null;

      setStatus(alignFrames ? "Aligning and averaging..." : "Averaging...");

      for (let i = 0; i < frameCache.length; i += 1) {
        const frame = frameCache[i];
        let shiftX = 0;
        let shiftY = 0;

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

        addFrameToAccumulator(frame, sums, counts, width, height, shiftX, shiftY);
        setProgress(50 + Math.round(((i + 1) / frameCache.length) * 50));
      }

      const result = makeResultImage(sums, counts, width, height);
      previewCtx.putImageData(result, 0, 0);
      const finalUrl = previewCanvas.toDataURL("image/jpeg", 0.95);
      setOutputUrl(finalUrl);
      setStatus("Done. Download your long exposure image.");
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
          <input
            type="file"
            accept="video/*"
            onChange={(event) => setVideoFile(event.target.files?.[0] ?? null)}
            disabled={processing}
          />
        </label>

        <label className="field">
          <span>Frame rate (frames/sec)</span>
          <input
            type="number"
            min="0.25"
            max="24"
            step="0.25"
            value={fps}
            onChange={(event) => setFps(Number(event.target.value))}
            disabled={processing}
          />
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={alignFrames}
            onChange={(event) => setAlignFrames(event.target.checked)}
            disabled={processing}
          />
          <span>Align frames (reduce camera shake)</span>
        </label>

        <label className="row">
          <input
            type="checkbox"
            checked={downscale}
            onChange={(event) => setDownscale(event.target.checked)}
            disabled={processing}
          />
          <span>Downscale on mobile (safer)</span>
        </label>

        {mobile ? (
          <>
            <p className="hint">
              Mobile profile: {deviceCaps.memoryGb}GB RAM hint, {deviceCaps.cores} CPU threads.
              {deviceCaps.strongDevice ? " Strong mode enabled." : " Safe mode enabled."}
            </p>
            <label className="row">
              <input
                type="checkbox"
                checked={ignoreMobileLimits}
                onChange={(event) => setIgnoreMobileLimits(event.target.checked)}
                disabled={processing}
              />
              <span>Ignore mobile safety limits (advanced)</span>
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
