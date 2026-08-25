/** Deterministic re-serialisation. Shared by the format, minify and sort tools. */

export interface FormatOptions {
  /** Number of spaces, or 'tab'. */
  indent: number | 'tab';
  sortKeys: boolean;
  minify: boolean;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortValue(v);
    return out;
  }
  return value;
}

export function formatJson(value: unknown, options: FormatOptions): string {
  const prepared = options.sortKeys ? sortValue(value) : value;
  if (options.minify) return JSON.stringify(prepared);
  const indent = options.indent === 'tab' ? '\t' : options.indent;
  return JSON.stringify(prepared, null, indent) + '\n';
}
