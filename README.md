# PNG to SVG Converter

A local-first PNG/JPG/WebP to SVG converter built with Next.js, TypeScript, Tailwind CSS, Web Workers, OffscreenCanvas, WASM tracing, SVGO browser optimization, and local OCR.

## What it does

- Runs fully in the browser after the app loads
- Keeps image processing local
- Vectorizes simple logos, icons, badges, flat art, and text-heavy assets
- Provides live preview, comparison, zoom, and export tools
- Supports SVG and PNG download
- Includes a light service worker for offline-after-load use

## Tech stack

- Next.js (App Router)
- React
- TypeScript
- Tailwind CSS
- Web Worker + OffscreenCanvas
- `@cadit-app/potrace-ts + imagetracerjs` (usened to 0.1.0) for raster-to-SVG tracing
- `svgo/browser` for final SVG optimization
- `tesseract.js` for optional local OCR

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Build

```bash
npm run build
npm run start
```

## Deploy to Vercel

1. Push the repo to GitHub.
2. Import the project in Vercel.
3. Keep the default Next.js framework detection.
4. Deploy.

The project uses `output: 'export'`, so the build output is static and the app stays local-first.

## Notes on accuracy

This app is optimized for:

- logos
- icons
- badges
- flat illustrations
- text assets

Very detailed photos can still be traced, but the SVG may become heavier and less perfect. For complex images, try `Photo` mode with `Max detail`, then raise `Detail level` and lower `Simplification` carefully.

## File structure

```text
app/
  globals.css
  layout.tsx
  page.tsx
components/
  dropzone.tsx
  service-worker.tsx
  sw-status.tsx
lib/
  format.ts
  persistent-state.ts
  svg.ts
  types.ts
public/
  icon.svg
  manifest.webmanifest
  sw.js
workers/
  vectorize.worker.ts
```

## License

Use it freely in your own projects.
