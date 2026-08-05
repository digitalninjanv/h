export function makeSvgDownloadFilename(inputName: string): string {
  const base = inputName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${base || 'vectorized'}.svg`;
}

export function makePngDownloadFilename(inputName: string): string {
  const base = inputName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${base || 'vectorized'}.png`;
}

export function withViewBox(svg: string, width: number, height: number): string {
  const hasViewBox = /viewBox\s*=\s*["'][^"']+["']/.test(svg);
  if (hasViewBox) return svg;
  return svg.replace(
    /<svg\b([^>]*?)>/i,
    (_match, attrs) => `<svg${attrs} viewBox="0 0 ${Math.max(1, Math.round(width))} ${Math.max(1, Math.round(height))}">`,
  );
}

export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/xmlns:xlink="[^"]*"/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function createPreviewSvg(svg: string): string {
  const cleaned = sanitizeSvg(svg);
  return cleaned;
}

export async function svgToPngBlob(svg: string, width: number, height: number): Promise<Blob> {
  const svgWithViewBox = withViewBox(sanitizeSvg(svg), width, height);
  const blob = new Blob([svgWithViewBox], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.max(1, Math.round(width * pixelRatio));
    canvas.height = Math.max(1, Math.round(height * pixelRatio));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const pngBlob = await canvasToBlob(canvas);
    return pngBlob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to create PNG blob'));
    }, 'image/png');
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function loadImage(src: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Unable to load SVG preview'));
    img.src = src;
  });
}
