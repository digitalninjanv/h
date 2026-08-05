/// <reference lib="webworker" />

import type { ImageAnalysis, TraceResult, TraceSettings } from '@/lib/types';

type WorkerRequest = {
  id: string;
  filename: string;
  buffer: ArrayBuffer;
  settings: TraceSettings;
};

type WorkerResponse =
  | { id: string; type: 'progress'; progress: number; stage: string; note?: string }
  | { id: string; type: 'result'; result: TraceResult }
  | { id: string; type: 'error'; error: string };

type Stats = {
  uniqueColors: number;
  edgeDensity: number;
  alphaCoverage: number;
  complexity: number;
  textLikelihood: number;
  meanLuminance: number;
};

const scope = self as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    const result = await runPipeline(request, (progress, stage, note) => {
      const message: WorkerResponse = { id: request.id, type: 'progress', progress, stage, note };
      scope.postMessage(message);
    });

    const response: WorkerResponse = { id: request.id, type: 'result', result };
    scope.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id: request.id,
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown worker failure',
    };
    scope.postMessage(response);
  }
};

async function runPipeline(
  request: WorkerRequest,
  progress: (progress: number, stage: string, note?: string) => void,
): Promise<TraceResult> {
  const started = performance.now();
  progress(4, 'decode', 'Loading file into a bitmap');

  const blob = new Blob([request.buffer], { type: inferMime(request.filename) });
  const bitmap = await createImageBitmap(blob);

  const analysis = await analyzeImage(bitmap, request.settings);
  progress(14, 'analyze', `Detected ${analysis.kind} input`);

  const processed = await preprocess(bitmap, request.settings, analysis, (p, note) => {
    progress(14 + Math.round(p * 0.32), 'preprocess', note);
  });

  progress(52, 'trace', 'Vectorizing raster data');
  const svg = await traceToSvg(processed, request.settings, analysis);

  progress(76, 'optimize', 'Polishing SVG output');
  const finalSvg = await finalizeSvg(svg, processed.width, processed.height);
  const previewSvg = buildPreviewSvg(finalSvg, processed.width, processed.height);
  const processingMs = Math.round(performance.now() - started);

  const result: TraceResult = {
    svg: finalSvg,
    previewSvg,
    originalWidth: bitmap.width,
    originalHeight: bitmap.height,
    outputWidth: processed.width,
    outputHeight: processed.height,
    processingMs,
    svgBytes: new Blob([finalSvg]).size,
    textDetected: analysis.textLikelihood >= 0.54,
    ocrText: '',
    warnings: [...analysis.warnings],
    analysis,
  };

  progress(100, 'done', 'Ready');
  return result;
}

function inferMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

async function analyzeImage(bitmap: ImageBitmap, settings: TraceSettings): Promise<ImageAnalysis> {
  const maxSide = Math.max(bitmap.width, bitmap.height);
  const sampleScale = Math.max(1, Math.round(maxSide / 160));
  const width = Math.max(1, Math.round(bitmap.width / sampleScale));
  const height = Math.max(1, Math.round(bitmap.height / sampleScale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);

  const image = ctx.getImageData(0, 0, width, height);
  const stats = sampleStats(image);
  const kind = classify(stats, settings, width, height);

  const warnings: string[] = [];
  if (maxSide > 2600) warnings.push('Input is large. The app will downscale before tracing to keep output responsive.');
  if (stats.complexity > 0.85) warnings.push('Very complex input. SVG may become large; logo or icon sources work best.');
  if (kind === 'text') warnings.push('Text-like content detected. Best effort tracing is enabled, but OCR-like shapes may still need manual review.');
  if (kind === 'photo') warnings.push('Photo-like input detected. SVG output can become heavy; logo or icon mode usually works better.');

  return {
    width: bitmap.width,
    height: bitmap.height,
    kind,
    dominantColors: stats.uniqueColors,
    edgeDensity: stats.edgeDensity,
    alphaCoverage: stats.alphaCoverage,
    estimatedComplexity: stats.complexity,
    textLikelihood: stats.textLikelihood,
    recommendedMode: kind === 'photo' ? 'photo' : kind === 'text' ? 'logo' : kind === 'logo' ? 'flat-icon' : 'auto',
    warnings,
  };
}

function sampleStats(image: ImageData): Stats {
  const { data, width, height } = image;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 140));
  const unique = new Set<number>();
  let alphaCount = 0;
  let edgeScore = 0;
  let textScore = 0;
  let brightnessVar = 0;
  let sampleCount = 0;
  let luminanceSum = 0;

  const luminances: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      const a = data[idx + 3]!;
      if (a < 250) alphaCount += 1;

      unique.add(((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5));
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      luminances.push(lum);
      luminanceSum += lum;

      if (x + step < width) {
        const idx2 = (y * width + (x + step)) * 4;
        const lum2 = 0.299 * data[idx2]! + 0.587 * data[idx2 + 1]! + 0.114 * data[idx2 + 2]!;
        edgeScore += Math.abs(lum - lum2);
        textScore += Math.abs(lum - lum2) > 24 ? 1 : 0;
      }

      if (y + step < height) {
        const idx3 = ((y + step) * width + x) * 4;
        const lum3 = 0.299 * data[idx3]! + 0.587 * data[idx3 + 1]! + 0.114 * data[idx3 + 2]!;
        edgeScore += Math.abs(lum - lum3);
        textScore += Math.abs(lum - lum3) > 24 ? 1 : 0;
      }

      sampleCount += 1;
    }
  }

  const mean = luminances.reduce((sum, n) => sum + n, 0) / Math.max(1, luminances.length);
  for (const n of luminances) brightnessVar += (n - mean) ** 2;
  brightnessVar /= Math.max(1, luminances.length);

  const edgeDensity = clamp(edgeScore / Math.max(1, sampleCount * 240), 0, 1);
  const alphaCoverage = clamp(alphaCount / Math.max(1, sampleCount), 0, 1);
  const uniqueColors = unique.size;
  const complexity = clamp((uniqueColors / 240) * 0.52 + edgeDensity * 0.34 + alphaCoverage * 0.14, 0, 1);
  const textLikelihood = clamp((textScore / Math.max(1, sampleCount * 1.8)) * 0.48 + (brightnessVar / 6000) * 0.52, 0, 1);

  return {
    uniqueColors,
    edgeDensity,
    alphaCoverage,
    complexity,
    textLikelihood,
    meanLuminance: luminanceSum / Math.max(1, sampleCount),
  };
}

function classify(stats: Stats, settings: TraceSettings, width: number, height: number): ImageAnalysis['kind'] {
  const lowColor = stats.uniqueColors < 96;
  const highColor = stats.uniqueColors > 240;
  const highEdge = stats.edgeDensity > 0.22;
  const textLike = stats.textLikelihood > 0.56 && highEdge && lowColor;
  const photoLike = highColor && highEdge && stats.complexity > 0.62;
  const logoLike = lowColor && stats.edgeDensity < 0.18 && Math.max(width, height) <= 2400;

  if (settings.mode === 'photo' || photoLike) return 'photo';
  if (textLike) return 'text';
  if (settings.mode === 'flat-icon' || logoLike) return 'logo';
  return 'mixed';
}

async function preprocess(
  bitmap: ImageBitmap,
  settings: TraceSettings,
  analysis: ImageAnalysis,
  progress: (progress: number, note?: string) => void,
): Promise<ImageData> {
  const maxDim = Math.max(1, settings.maxDimension);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Unable to create preprocessing canvas');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);

  let image = ctx.getImageData(0, 0, width, height);
  progress(0.15, 'Balancing contrast and noise');

  if (settings.backgroundRemove || analysis.kind === 'logo' || settings.mode === 'flat-icon') {
    image = removeBackground(image, settings.threshold);
  }

  if (settings.noiseReduction > 0) {
    image = denoise(image, settings.noiseReduction);
  }

  if (settings.smoothing > 0) {
    image = smooth(image, settings.smoothing);
  }

  if (settings.edgePreservation > 0) {
    image = preserveEdges(image, settings.edgePreservation);
  }

  if (settings.textPreserve || analysis.kind === 'text') {
    image = boostText(image);
  }

  if (settings.mode === 'flat-icon' || analysis.kind === 'logo') {
    image = posterize(image, settings.colorLimit);
  } else if (settings.mode === 'photo') {
    image = softQuantize(image, settings.colorLimit);
  }

  ctx.putImageData(image, 0, 0);
  progress(0.72, 'Preparing trace input');

  return ctx.getImageData(0, 0, width, height);
}

async function traceToSvg(image: ImageData, settings: TraceSettings, analysis: ImageAnalysis): Promise<string> {
  const kind = settings.mode === 'auto' ? analysis.recommendedMode : settings.mode;
  const scale = Math.max(1, Math.round(1000 / Math.max(image.width, image.height)));

  if (kind === 'photo' || (kind === 'auto' && analysis.kind === 'photo')) {
    const imagetracerModule = await import('imagetracerjs');
    const ImageTracer = ((imagetracerModule as any).default ?? imagetracerModule) as {
      imagedataToSVG: (imageData: ImageData, options?: Record<string, unknown> | string) => string;
    };

    const options = {
      ltres: Math.max(0.1, 1.2 - settings.smoothing / 140),
      qtres: Math.max(0.1, 1.1 - settings.simplification / 140),
      pathomit: Math.max(0, Math.round(10 - settings.noiseReduction / 12)),
      rightangleenhance: true,
      colorsampling: 2,
      numberofcolors: clampInt(Math.round(settings.colorLimit), 4, 32),
      mincolorratio: 0,
      colorquantcycles: 3,
      layering: 0,
      strokewidth: 0,
      linefilter: settings.edgePreservation > 40,
      scale,
      roundcoords: 2,
      viewbox: true,
      desc: false,
      blurradius: settings.noiseReduction > 50 ? 2 : 0,
      blurdelta: 20,
    };

    return ImageTracer.imagedataToSVG(image, options);
  }

  const potraceModule = await import('@cadit-app/potrace-ts');
  const thresholdValue = settings.threshold >= 0 ? clampInt(Math.round(settings.threshold), 0, 255) : potraceModule.calculateAutoThreshold(image);
  const work = shouldInvertMonochrome(image, analysis, settings) ? invertImageData(image) : image;
  const bitmap = potraceModule.imageDataToBitmap(work, thresholdValue);
  const paths = potraceModule.traceBitmap(bitmap, {
    turnpolicy: kind === 'text' ? 'black' : 'minority',
    turdsize: clampInt(Math.round(settings.noiseReduction / 10), 0, 24),
    optcurve: true,
    alphamax: kind === 'flat-icon' ? 1.2 : kind === 'logo' ? 1.0 : 0.9,
    opttolerance: kind === 'text' ? 0.2 : kind === 'photo' ? 0.35 : 0.25,
  } as any);

  return potraceModule.getSVG(paths, 1);
}

function shouldInvertMonochrome(image: ImageData, analysis: ImageAnalysis, settings: TraceSettings): boolean {
  if (settings.mode === 'photo') return false;
  const mean = averageLuminance(image);
  if (analysis.kind === 'text' || analysis.kind === 'logo') {
    return mean < 118;
  }
  return mean < 112;
}

function averageLuminance(image: ImageData): number {
  const { data } = image;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += luminance(data[i]!, data[i + 1]!, data[i + 2]!);
    count += 1;
  }
  return sum / Math.max(1, count);
}

function inferMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function removeBackground(image: ImageData, threshold: number): ImageData {
  const { data, width, height } = image;
  const bg = sampleBorderBackground(data, width, height);
  const tolerance = 12 + threshold * 1.35;
  const out = new Uint8ClampedArray(data);

  for (let i = 0; i < out.length; i += 4) {
    const d = colorDistance(out[i]!, out[i + 1]!, out[i + 2]!, bg.r, bg.g, bg.b);
    if (d <= tolerance) {
      out[i + 3] = 0;
    }
  }

  return new ImageData(out, width, height);
}

function sampleBorderBackground(data: Uint8ClampedArray, width: number, height: number) {
  const points = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [Math.floor(width / 2), 0],
    [Math.floor(width / 2), height - 1],
    [0, Math.floor(height / 2)],
    [width - 1, Math.floor(height / 2)],
  ] as const;

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (const [x, y] of points) {
    const idx = (y * width + x) * 4;
    r += data[idx]!;
    g += data[idx + 1]!;
    b += data[idx + 2]!;
    count += 1;
  }

  return { r: r / count, g: g / count, b: b / count };
}

function denoise(image: ImageData, amount: number): ImageData {
  if (amount <= 0) return image;
  const { width, height, data } = image;
  const strength = Math.min(1, amount / 100);
  if (strength < 0.15) return image;

  const out = new Uint8ClampedArray(data);
  const radius = strength > 0.65 ? 1 : 0;
  if (!radius) return image;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = (y * width + x) * 4;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let count = 0;

      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const n = ((y + oy) * width + (x + ox)) * 4;
          sr += data[n]!;
          sg += data[n + 1]!;
          sb += data[n + 2]!;
          sa += data[n + 3]!;
          count += 1;
        }
      }

      const blend = strength * 0.5;
      out[idx] = lerp(data[idx]!, sr / count, blend);
      out[idx + 1] = lerp(data[idx + 1]!, sg / count, blend);
      out[idx + 2] = lerp(data[idx + 2]!, sb / count, blend);
      out[idx + 3] = lerp(data[idx + 3]!, sa / count, blend);
    }
  }

  return new ImageData(out, width, height);
}

function smooth(image: ImageData, amount: number): ImageData {
  const strength = Math.min(1, amount / 100);
  if (strength < 0.15) return image;
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = (y * width + x) * 4;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let count = 0;

      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const n = ((y + oy) * width + (x + ox)) * 4;
          sr += data[n]!;
          sg += data[n + 1]!;
          sb += data[n + 2]!;
          sa += data[n + 3]!;
          count += 1;
        }
      }

      const blend = strength * 0.36;
      out[idx] = lerp(data[idx]!, sr / count, blend);
      out[idx + 1] = lerp(data[idx + 1]!, sg / count, blend);
      out[idx + 2] = lerp(data[idx + 2]!, sb / count, blend);
      out[idx + 3] = lerp(data[idx + 3]!, sa / count, blend);
    }
  }

  return new ImageData(out, width, height);
}

function preserveEdges(image: ImageData, amount: number): ImageData {
  const boost = Math.min(1, amount / 100);
  if (boost <= 0.08) return image;

  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = (y * width + x) * 4;
      const left = idx - 4;
      const right = idx + 4;
      const up = idx - width * 4;
      const down = idx + width * 4;

      const center = luminance(data[idx]!, data[idx + 1]!, data[idx + 2]!);
      const gradient = Math.abs(center - luminance(data[left]!, data[left + 1]!, data[left + 2]!)) +
        Math.abs(center - luminance(data[right]!, data[right + 1]!, data[right + 2]!)) +
        Math.abs(center - luminance(data[up]!, data[up + 1]!, data[up + 2]!)) +
        Math.abs(center - luminance(data[down]!, data[down + 1]!, data[down + 2]!));

      if (gradient > 80) {
        out[idx] = clampByte(data[idx]! + (data[idx]! - 128) * boost * 0.14);
        out[idx + 1] = clampByte(data[idx + 1]! + (data[idx + 1]! - 128) * boost * 0.14);
        out[idx + 2] = clampByte(data[idx + 2]! + (data[idx + 2]! - 128) * boost * 0.14);
      }
    }
  }

  return new ImageData(out, width, height);
}

function boostText(image: ImageData): ImageData {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < out.length; i += 4) {
    const lum = luminance(out[i]!, out[i + 1]!, out[i + 2]!);
    const contrast = clamp((lum - 128) * 0.14 + 128, 0, 255);
    out[i] = clampByte(out[i]! * 0.65 + contrast * 0.35);
    out[i + 1] = clampByte(out[i + 1]! * 0.65 + contrast * 0.35);
    out[i + 2] = clampByte(out[i + 2]! * 0.65 + contrast * 0.35);
  }
  return new ImageData(out, width, height);
}

function posterize(image: ImageData, colorLimit: number): ImageData {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);
  const levels = Math.max(4, Math.min(64, Math.round(colorLimit)));
  const step = 255 / Math.max(1, levels - 1);

  for (let i = 0; i < out.length; i += 4) {
    out[i] = Math.round(out[i]! / step) * step;
    out[i + 1] = Math.round(out[i + 1]! / step) * step;
    out[i + 2] = Math.round(out[i + 2]! / step) * step;
  }
  return new ImageData(out, width, height);
}

function softQuantize(image: ImageData, colorLimit: number): ImageData {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);
  const levels = Math.max(6, Math.min(96, Math.round(colorLimit * 1.25)));
  const step = 255 / Math.max(1, levels - 1);

  for (let i = 0; i < out.length; i += 4) {
    out[i] = clampByte(Math.round(out[i]! / step) * step);
    out[i + 1] = clampByte(Math.round(out[i + 1]! / step) * step);
    out[i + 2] = clampByte(Math.round(out[i + 2]! / step) * step);
  }
  return new ImageData(out, width, height);
}

async function finalizeSvg(svg: string, width: number, height: number): Promise<string> {
  const fixed = ensureSvgBasics(svg, width, height);

  try {
    const { optimize } = await import('svgo/browser');
    const optimized = optimize(fixed, {
      multipass: true,
      plugins: [
        'preset-default',
        { name: 'removeViewBox', active: false },
        { name: 'removeTitle', active: true },
        { name: 'removeDesc', active: true },
        { name: 'removeDimensions', active: true },
      ],
    }) as unknown as { data: string };

    return ensureSvgBasics(optimized.data ?? fixed, width, height);
  } catch {
    return fixed
      .replace(/\s{2,}/g, ' ')
      .replace(/>\s+</g, '><')
      .trim();
  }
}

function buildPreviewSvg(svg: string, width: number, height: number): string {
  return ensureSvgBasics(svg, width, height);
}

function ensureSvgBasics(svg: string, width: number, height: number): string {
  const clean = svg
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/xmlns:xlink="[^"]*"/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (/viewBox\s*=/.test(clean) && /<svg[^>]*width=/.test(clean)) return clean;

  return clean.replace(/<svg([^>]*?)>/i, (_match, attrs) => {
    const hasWidth = /width=/.test(attrs);
    const hasHeight = /height=/.test(attrs);
    const hasViewBox = /viewBox=/.test(attrs);
    const extra = [
      hasWidth ? '' : ` width="${Math.max(1, Math.round(width))}"`,
      hasHeight ? '' : ` height="${Math.max(1, Math.round(height))}"`,
      hasViewBox ? '' : ` viewBox="0 0 ${Math.max(1, Math.round(width))} ${Math.max(1, Math.round(height))}"`,
      /xmlns=/.test(attrs) ? '' : ' xmlns="http://www.w3.org/2000/svg"',
    ].join('');
    return `<svg${attrs}${extra}>`;
  });
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

function clampByte(v: number): number {
  return clampInt(v, 0, 255);
}

function invertImageData(image: ImageData): ImageData {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255 - out[i]!;
    out[i + 1] = 255 - out[i + 1]!;
    out[i + 2] = 255 - out[i + 2]!;
  }
  return new ImageData(out, width, height);
}
