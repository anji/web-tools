import { useState } from 'react';
import { copyToClipboard, downloadText, type ToolOutput, type ToolError } from '@tools/core';

interface Props {
  output?: ToolOutput;
  error?: ToolError;
  busy: boolean;
}

const MIME: Record<string, string> = {
  json: 'application/json',
  csv: 'text/csv',
  yaml: 'text/yaml',
  typescript: 'text/typescript',
};

export function OutputPane({ output, error, busy }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!output) return;
    if (await copyToClipboard(output.content)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Output</span>
        {output && (
          <div className="flex items-center gap-3 text-xs">
            <button type="button" onClick={copy} className="text-slate-400 transition hover:text-sky-400">
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() =>
                downloadText(output.filename, output.content, MIME[output.language] ?? 'text/plain')
              }
              className="text-slate-400 transition hover:text-sky-400"
            >
              Download
            </button>
          </div>
        )}
      </div>

      {output && output.stats && output.stats.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2">
          {output.stats.map((stat) => (
            <span
              key={stat.label}
              className="rounded-full border border-slate-700 bg-slate-800/60 px-2.5 py-0.5 text-xs text-slate-300"
            >
              <span className="text-slate-500">{stat.label}</span> {stat.value}
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-4 rounded-md border border-rose-900/60 bg-rose-950/30 p-4">
            <p className="font-mono text-sm text-rose-300">{error.message}</p>
            {error.line !== undefined && (
              <p className="mt-1 font-mono text-xs text-rose-400/70">
                line {error.line}
                {error.column !== undefined ? `, column ${error.column}` : ''}
              </p>
            )}
            {error.hint && <p className="mt-3 text-sm leading-relaxed text-slate-300">{error.hint}</p>}
          </div>
        ) : output ? (
          <pre className="p-4 font-mono text-[13px] leading-relaxed text-slate-100">
            <code>{output.content}</code>
          </pre>
        ) : (
          <p className="p-4 text-sm text-slate-600">
            {busy ? 'Working…' : 'Output appears here as you type.'}
          </p>
        )}
      </div>

      {output && output.warnings && output.warnings.length > 0 && (
        <div className="border-t border-slate-800 bg-amber-950/20 px-4 py-3">
          {output.warnings.map((warning) => (
            <p key={warning} className="text-xs leading-relaxed text-amber-200/80">
              {warning}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
