import { useCallback, useRef, useState } from 'react';
import { formatBytes, readFileAsText, type ToolInputSpec } from '@tools/core';

interface Props {
  spec: ToolInputSpec;
  value: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
}

/** Reading a file this large into a textarea locks up the tab; refuse instead. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function InputPane({ spec, value, onChange, onError }: Props) {
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const ingest = useCallback(
    async (file: File) => {
      if (file.size > MAX_FILE_BYTES) {
        onError(
          `${file.name} is ${formatBytes(file.size)}. The editor caps files at ${formatBytes(MAX_FILE_BYTES)} so the tab stays responsive.`,
        );
        return;
      }
      onChange(await readFileAsText(file));
    },
    [onChange, onError],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          {spec.label}
        </span>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {value.length > 0 && <span>{formatBytes(new Blob([value]).size)}</span>}
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="text-slate-400 transition hover:text-sky-400"
          >
            Open file
          </button>
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange('')}
              className="text-slate-400 transition hover:text-rose-400"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div
        className={`relative flex min-h-0 flex-1 ${dragging ? 'ring-2 ring-inset ring-sky-500' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void ingest(file);
        }}
      >
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={spec.placeholder}
          spellCheck={false}
          autoComplete="off"
          className="min-h-[16rem] w-full flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed text-slate-100 placeholder:text-slate-600 focus:outline-none"
        />
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/80 text-sm font-medium text-sky-400">
            Drop to load — the file is read locally, never uploaded
          </div>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={spec.accept?.join(',')}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void ingest(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
