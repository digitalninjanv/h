'use client';

import { useMemo, useRef, useState } from 'react';

interface DropzoneProps {
  disabled?: boolean;
  onFile: (file: File) => void;
}

export function Dropzone({ disabled, onFile }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [active, setActive] = useState(false);

  const hint = useMemo(() => 'PNG, JPG, or WebP. Everything is processed locally in your browser.', []);

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        if (!disabled) setActive(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setActive(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        if (disabled) return;
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
      className={`group rounded-3xl border border-dashed p-6 transition ${
        active ? 'border-sky-400/60 bg-sky-500/10' : 'border-white/10 bg-white/5 hover:bg-white/[0.07]'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.currentTarget.value = '';
        }}
      />
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-lg font-semibold text-slate-100">Drop image here</p>
            <p className="mt-1 text-sm text-slate-400">{hint}</p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Select file
          </button>
        </div>
        <div className="grid gap-2 text-sm text-slate-400 sm:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">Best for logo, icon, badge, flat art</div>
          <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">Text-aware best effort preview</div>
          <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">No upload, no backend, no database</div>
        </div>
      </div>
    </div>
  );
}
