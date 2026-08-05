'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dropzone } from '@/components/dropzone';
import { ServiceWorkerRegistrar } from '@/components/service-worker';
import { SwStatus } from '@/components/sw-status';
import { formatBytes, formatMs, round, toPct } from '@/lib/format';
import { usePersistentState } from '@/lib/persistent-state';
import type { ImageAnalysis, TraceResult, TraceSettings, TraceMode, QualityPreset } from '@/lib/types';
import {
  createPreviewSvg,
  downloadBlob,
  makePngDownloadFilename,
  makeSvgDownloadFilename,
  sanitizeSvg,
  svgToDataUrl,
  svgToPngBlob,
} from '@/lib/svg';

type WorkerMessage =
  | { id: string; type: 'progress'; progress: number; stage: string; note?: string }
  | { id: string; type: 'result'; result: TraceResult }
  | { id: string; type: 'error'; error: string };

const defaultSettings: TraceSettings = {
  mode: 'auto',
  quality: 'balanced',
  backgroundRemove: true,
  textPreserve: true,
  threshold: 24,
  smoothing: 28,
  simplification: 42,
  colorLimit: 24,
  detailLevel: 72,
  noiseReduction: 20,
  edgePreservation: 72,
  maxDimension: 2200,
};

const presetDescriptions: Record<QualityPreset, string> = {
  draft: 'Faster, lighter output',
  balanced: 'Best default balance',
  'max-detail': 'Highest fidelity, heavier SVG',
};

const modeDescriptions: Record<TraceMode, string> = {
  auto: 'Auto-detect input type',
  logo: 'Good for logos and badges',
  photo: 'More layers for complex images',
  'flat-icon': 'Preserve flat shapes and edges',
};

export default function Page() {
  const [settings, setSettings] = usePersistentState<TraceSettings>('png-to-svg-settings-v1', defaultSettings);
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number; type: string } | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState('input.png');
  const [svg, setSvg] = useState('');
  const [previewSvg, setPreviewSvg] = useState('');
  const [result, setResult] = useState<TraceResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'ready' | 'processing' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('Waiting for file');
  const [compare, setCompare] = useState(58);
  const [showOverlay, setShowOverlay] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrWarning, setOcrWarning] = useState<string | null>(null);
  const [pngPreviewUrl, setPngPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const fileRef = useRef<File | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      if (pngPreviewUrl) URL.revokeObjectURL(pngPreviewUrl);
    };
  }, [sourceUrl, pngPreviewUrl]);

  useEffect(() => {
    if (!result) return;
    setSvg(result.svg);
    setPreviewSvg(result.previewSvg);
    setStatus('done');
    setProgress(100);
    setStage('Done');
  }, [result]);

  const stats = useMemo(() => {
    if (!result) return null;
    const svgKb = result.svgBytes / 1024;
    const ratio = result.originalWidth * result.originalHeight
      ? (result.outputWidth * result.outputHeight) / (result.originalWidth * result.originalHeight)
      : 1;
    return {
      processing: formatMs(result.processingMs),
      svgSize: formatBytes(result.svgBytes),
      svgKb,
      ratio,
      complexity: toPct(result.analysis.estimatedComplexity),
      edges: toPct(result.analysis.edgeDensity),
      text: toPct(result.analysis.textLikelihood),
    };
  }, [result]);

  const handleFile = async (file: File) => {
    setError(null);
    setOcrWarning(null);
    setSvg('');
    setPreviewSvg('');
    setResult(null);
    setOcrText('');
    setPngPreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });

    if (!file.type.startsWith('image/')) {
      setStatus('error');
      setError('Format tidak didukung. Gunakan PNG, JPG, atau WebP.');
      return;
    }

    if (file.size > 28 * 1024 * 1024) {
      setStatus('error');
      setError('File terlalu besar untuk mode browser-first. Kompres dulu atau turunkan resolusi.');
      return;
    }

    fileRef.current = file;
    setFileInfo({ name: file.name, size: file.size, type: file.type });
    setSourceName(file.name);

    const url = URL.createObjectURL(file);
    setSourceUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    setStatus('ready');
    setProgress(1);
    setStage('Ready');

    const buffer = await file.arrayBuffer();
    void runJob(file.name, buffer, settings);
  };

  const runJob = async (filename: string, buffer: ArrayBuffer, nextSettings: TraceSettings) => {
    setBusy(true);
    setStatus('processing');
    setProgress(5);
    setStage('Starting worker');
    setOcrLoading(false);

    workerRef.current?.terminate();
    const worker = new Worker(new URL('../workers/vectorize.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    jobIdRef.current = id;

    const pending = new Promise<TraceResult>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const message = event.data;
        if (message.id !== id) return;

        if (message.type === 'progress') {
          setProgress(Math.max(0, Math.min(100, message.progress)));
          setStage(message.note ? `${message.stage}: ${message.note}` : message.stage);
          return;
        }

        if (message.type === 'error') {
          reject(new Error(message.error));
          return;
        }

        resolve(message.result);
      };

      worker.onerror = (event) => {
        reject(new Error(event.message || 'Worker crashed'));
      };
    });

    worker.postMessage({ id, filename, buffer, settings: nextSettings }, [buffer]);

    try {
      const traced = await pending;
      if (jobIdRef.current !== id) return;

      setResult(traced);
      setError(traced.warnings.length ? traced.warnings[0] : null);
      setStatus('done');
      setBusy(false);

      if (traced.textDetected && nextSettings.textPreserve) {
        void runOcr(fileRef.current, traced.analysis);
      }
    } catch (err) {
      setStatus('error');
      setBusy(false);
      setError(err instanceof Error ? err.message : 'Terjadi error saat tracing.');
      setStage('Error');
    } finally {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    }
  };

  const runOcr = async (file: File | null, analysis: ImageAnalysis) => {
    if (!file) return;
    setOcrLoading(true);
    setOcrWarning(null);

    try {
      const mod = await import('tesseract.js');
      const worker = await mod.createWorker('eng');
      const blobUrl = URL.createObjectURL(file);

      try {
        const result = await worker.recognize(blobUrl);
        const text = result?.data?.text?.trim() || '';
        setOcrText(text);
        if (!text) {
          setOcrWarning('OCR tidak menemukan teks yang stabil. Untuk teks kecil, gunakan resolusi lebih tinggi atau mode max-detail.');
        } else if ((result?.data?.confidence ?? 0) < 60) {
          setOcrWarning('OCR terdeteksi, tetapi confidence masih rendah. Coba naikkan detail atau kurangi noise.');
        }
      } finally {
        URL.revokeObjectURL(blobUrl);
        await worker.terminate();
      }
    } catch {
      setOcrWarning('OCR lokal tidak berhasil dijalankan. Tracing tetap berlanjut memakai mode best effort.');
    } finally {
      setOcrLoading(false);
    }
  };

  const updateSetting = <K extends keyof TraceSettings>(key: K, value: TraceSettings[K]) => {
    setSettings((previous) => {
      const next = { ...previous, [key]: value };
      if (fileRef.current) {
        void fileRef.current.arrayBuffer().then((buffer) => runJob(fileRef.current!.name, buffer, next));
      }
      return next;
    });
  };

  const onDownloadSvg = async () => {
    if (!svg) return;
    const blob = new Blob([sanitizeSvg(svg)], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlob(blob, makeSvgDownloadFilename(sourceName));
  };

  const onCopySvg = async () => {
    if (!svg) return;
    await navigator.clipboard.writeText(sanitizeSvg(svg));
  };

  const onDownloadPng = async () => {
    if (!svg || !result) return;
    const blob = await svgToPngBlob(svg, result.outputWidth, result.outputHeight);
    downloadBlob(blob, makePngDownloadFilename(sourceName));
  };

  const loadExample = () => {
    setError(null);
    setFileInfo({ name: 'example-logo.png', size: 178_256, type: 'image/png' });
    setSourceName('example-logo.png');
    setSourceUrl('/icon.svg');
    setStatus('ready');
    setStage('Example loaded');
  };

  const svgMarkup = useMemo(() => {
    if (!previewSvg) return '';
    return createPreviewSvg(previewSvg);
  }, [previewSvg]);

  const originalPreview = sourceUrl ? (
    <img
      src={sourceUrl}
      alt="Original preview"
      className="h-full w-full object-contain"
      draggable={false}
    />
  ) : (
    <div className="flex h-full items-center justify-center text-center text-sm text-slate-400">
      <div>
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-slate-300">PNG</div>
        <p>Upload a PNG, JPG, or WebP to start tracing locally.</p>
      </div>
    </div>
  );

  const svgPreview = svgMarkup ? (
    <iframe
      title="SVG preview"
      className="h-full w-full rounded-2xl border border-white/10 bg-white"
      sandbox=""
      srcDoc={`<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:white;overflow:hidden}svg{width:100%;height:100%;object-fit:contain}</style></head><body>${svgMarkup}</body></html>`}
    />
  ) : (
    <div className="flex h-full items-center justify-center text-center text-sm text-slate-400">
      <div>
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-slate-300">SVG</div>
        <p>Your traced output will appear here.</p>
      </div>
    </div>
  );

  return (
    <main className="min-h-screen">
      <ServiceWorkerRegistrar />
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-4 py-4 md:px-6 md:py-6 xl:px-8">
        <section className="panel overflow-hidden">
          <div className="grid gap-6 p-6 lg:grid-cols-[1.25fr_0.75fr] lg:p-8">
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-3">
                <SwStatus />
                <span className="chip">Client-side tracing</span>
                <span className="chip">No database</span>
                <span className="chip">Vercel-ready</span>
              </div>
              <div className="space-y-3">
                <h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-white md:text-6xl">
                  PNG to SVG Converter built for accuracy, privacy, and speed.
                </h1>
                <p className="max-w-3xl text-sm leading-7 text-slate-300 md:text-base">
                  Everything runs in the browser. Upload an image, tune the trace profile, inspect the result, then download a clean SVG or PNG preview without ever sending your file to a backend.
                </p>
              </div>
              <div className="grid gap-3 text-sm text-slate-300 sm:grid-cols-3">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="label mb-2">Best use</p>
                  <p>Logo, icon, flat asset, badge, and text-heavy graphics.</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="label mb-2">Engine</p>
                  <p>WASM tracing in a Web Worker with SVG optimization in-browser.</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <p className="label mb-2">Safety</p>
                  <p>No upload, no storage server, and no database involved.</p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <Dropzone disabled={busy} onFile={(file) => void handleFile(file)} />
              <button className="btn w-full" type="button" onClick={loadExample}>
                Load demo preview
              </button>
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[360px_1fr]">
          <aside className="panel space-y-6 p-5 md:p-6">
            <div className="space-y-4">
              <div>
                <p className="panel-title">Trace controls</p>
                <p className="mt-1 text-sm text-slate-400">Tune the result based on the kind of image you uploaded.</p>
              </div>

              <ControlGroup label="Mode" description={modeDescriptions[settings.mode]}>
                <select
                  className="input"
                  value={settings.mode}
                  onChange={(e) => updateSetting('mode', e.target.value as TraceMode)}
                >
                  {Object.keys(modeDescriptions).map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </ControlGroup>

              <ControlGroup label="Quality" description={presetDescriptions[settings.quality]}>
                <select
                  className="input"
                  value={settings.quality}
                  onChange={(e) => updateSetting('quality', e.target.value as QualityPreset)}
                >
                  {Object.keys(presetDescriptions).map((preset) => (
                    <option key={preset} value={preset}>
                      {preset}
                    </option>
                  ))}
                </select>
              </ControlGroup>

              <SliderControl label="Threshold" value={settings.threshold} min={0} max={100} onChange={(v) => updateSetting('threshold', v)} />
              <SliderControl label="Smoothing" value={settings.smoothing} min={0} max={100} onChange={(v) => updateSetting('smoothing', v)} />
              <SliderControl label="Simplification" value={settings.simplification} min={0} max={100} onChange={(v) => updateSetting('simplification', v)} />
              <SliderControl label="Color limit" value={settings.colorLimit} min={4} max={64} onChange={(v) => updateSetting('colorLimit', v)} />
              <SliderControl label="Detail level" value={settings.detailLevel} min={0} max={100} onChange={(v) => updateSetting('detailLevel', v)} />
              <SliderControl label="Noise reduction" value={settings.noiseReduction} min={0} max={100} onChange={(v) => updateSetting('noiseReduction', v)} />
              <SliderControl label="Edge preservation" value={settings.edgePreservation} min={0} max={100} onChange={(v) => updateSetting('edgePreservation', v)} />
              <SliderControl label="Max dimension" value={settings.maxDimension} min={800} max={4000} step={50} onChange={(v) => updateSetting('maxDimension', v)} />

              <ToggleRow label="Background remove" checked={settings.backgroundRemove} onChange={(checked) => updateSetting('backgroundRemove', checked)} />
              <ToggleRow label="Text preserve" checked={settings.textPreserve} onChange={(checked) => updateSetting('textPreserve', checked)} />
            </div>

            <div className="space-y-3 rounded-3xl border border-white/10 bg-black/20 p-4">
              <p className="panel-title">Processing state</p>
              <div className="h-2 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-gradient-to-r from-sky-400 via-cyan-400 to-emerald-400 transition-all" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-sm text-slate-300">{stage}</p>
              <p className="text-xs text-slate-500">{busy ? 'Worker processing is active.' : 'Ready for the next file.'}</p>
            </div>

            {fileInfo && (
              <div className="space-y-3 rounded-3xl border border-white/10 bg-black/20 p-4 text-sm text-slate-300">
                <p className="panel-title">Input file</p>
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-400">Name</span>
                    <span className="truncate text-right text-slate-100">{fileInfo.name}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-400">Size</span>
                    <span className="text-slate-100">{formatBytes(fileInfo.size)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-400">Type</span>
                    <span className="text-slate-100">{fileInfo.type || 'unknown'}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-3">
              <button className="btn btn-primary w-full" type="button" onClick={onDownloadSvg} disabled={!svg}>
                Download SVG
              </button>
              <button className="btn w-full" type="button" onClick={onCopySvg} disabled={!svg}>
                Copy SVG to clipboard
              </button>
              <button className="btn w-full" type="button" onClick={onDownloadPng} disabled={!svg}>
                Download SVG as PNG
              </button>
            </div>

            {error && (
              <div className="rounded-3xl border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-100">
                {error}
              </div>
            )}
          </aside>

          <section className="space-y-6">
            <div className="grid gap-6 xl:grid-cols-2">
              <PreviewCard title="Original preview" subtitle="Source image stays local" content={originalPreview} />
              <PreviewCard title="Vector preview" subtitle="Optimized SVG output" content={svgPreview} />
            </div>

            <div className="panel space-y-5 p-5 md:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="panel-title">Before / after comparison</p>
                  <p className="mt-1 text-sm text-slate-400">Slide to compare the original bitmap with the traced SVG output.</p>
                </div>
                <label className="flex items-center gap-3 text-sm text-slate-300">
                  <input type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)} />
                  Show overlay mode
                </label>
              </div>

              <div className="grid gap-5 xl:grid-cols-[1fr_280px]">
                <div className="relative min-h-[360px] overflow-hidden rounded-3xl border border-white/10 bg-slate-950">
                  <div className="absolute inset-0">{originalPreview}</div>
                  {showOverlay && (
                    <div className="absolute inset-0 overflow-hidden" style={{ width: `${compare}%` }}>
                      <div className="h-full w-full bg-white">{svgPreview}</div>
                    </div>
                  )}
                  {!showOverlay && (
                    <div className="absolute inset-0 bg-white">{svgPreview}</div>
                  )}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-4 py-3 text-xs text-white/90">
                    {showOverlay ? 'Move the slider to inspect differences.' : 'Switch on overlay mode for direct comparison.'}
                  </div>
                </div>

                <div className="space-y-4 rounded-3xl border border-white/10 bg-black/20 p-4">
                  <p className="panel-title">Comparison slider</p>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={compare}
                    onChange={(e) => setCompare(Number(e.target.value))}
                    className="w-full accent-sky-400"
                  />
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Original</span>
                    <span>{compare}% SVG</span>
                  </div>
                  <div className="space-y-2 text-sm text-slate-300">
                    <p>Use this to judge path accuracy, text readability, and shape fidelity.</p>
                    <p className="text-slate-500">For dense photos, switch to photo mode and expect larger SVGs.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
              <div className="panel space-y-4 p-5 md:p-6">
                <p className="panel-title">Result metadata</p>
                {stats && result ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <MetaCard label="Processing" value={stats.processing} />
                    <MetaCard label="SVG size" value={stats.svgSize} />
                    <MetaCard label="Complexity" value={stats.complexity} />
                    <MetaCard label="Edges" value={stats.edges} />
                    <MetaCard label="Text likelihood" value={stats.text} />
                    <MetaCard label="Output scale" value={`${round(stats.ratio * 100, 1)}%`} />
                  </div>
                ) : (
                  <div className="rounded-3xl border border-white/10 bg-white/5 p-4 text-sm text-slate-400">
                    The metadata panel will populate after tracing finishes.
                  </div>
                )}
              </div>

              <div className="panel space-y-4 p-5 md:p-6">
                <p className="panel-title">Text handling</p>
                <div className="space-y-3 text-sm text-slate-300">
                  <p>
                    {ocrLoading
                      ? 'Running local OCR to inspect text regions...'
                      : ocrText
                        ? 'OCR extracted text from the local image.'
                        : 'Text detection runs best on high-resolution inputs with clean contrast.'}
                  </p>
                  {ocrWarning && <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-3 text-amber-100">{ocrWarning}</div>}
                  {ocrText && (
                    <pre className="max-h-56 overflow-auto rounded-2xl border border-white/10 bg-black/30 p-3 text-xs leading-6 text-slate-200">
                      {ocrText}
                    </pre>
                  )}
                  <p className="text-slate-500">
                    For the cleanest result, use logo or flat icon mode on text-heavy images, then increase detail if letters start to deform.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function ControlGroup({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <p className="label">{label}</p>
        <p className="text-xs text-slate-500">{description}</p>
      </div>
      {children}
    </div>
  );
}

function SliderControl({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="label">{label}</p>
        <span className="text-xs text-slate-400">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-sky-400"
      />
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-sky-400"
      />
    </label>
  );
}

function PreviewCard({
  title,
  subtitle,
  content,
}: {
  title: string;
  subtitle: string;
  content: React.ReactNode;
}) {
  return (
    <div className="panel min-h-[420px] overflow-hidden p-4 md:p-5">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <p className="panel-title">{title}</p>
          <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
        </div>
      </div>
      <div className="flex min-h-[360px] items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-white">
        {content}
      </div>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}
