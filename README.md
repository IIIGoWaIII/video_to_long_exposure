# Video to Long Exposure Web App

Browser app that converts video into a long-exposure image.

## What it does

- Upload a video file
- Choose frame rate (default `2`, same as your bash script)
- Toggle **Align frames** checkbox
- Auto-convert unsupported video formats (like MOV/MKV) to MP4 in browser
- Generate one averaged output image
- Download JPG result
- Adaptive mobile limits (strong phones get higher limits)
- Optional advanced toggle to ignore mobile safety limits

## Local run

```bash
npm install
npm run dev
```

Then open the local URL from Vite.

## Deploy to Vercel

1. Import this repo/project in Vercel.
2. Framework preset: `Vite`.
3. Build command: `npm run build`.
4. Output directory: `dist`.

(`vercel.json` is included)

## Deploy to Netlify

1. Import this repo/project in Netlify.
2. Build command: `npm run build`.
3. Publish directory: `dist`.

(`netlify.toml` is included)

## Notes

- Processing is done in browser (no backend).
- Mobile support is included with safety limits for frame count and resolution.
- If clip is too heavy, lower FPS or trim video duration.
