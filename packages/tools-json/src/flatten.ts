/** Dot/bracket path flattening, shared by the CSV and flatten tools. */

export interface FlattenOptions {
  /** Separator between object keys, conventionally '.'. */
  separator: string;
  /** Encode array indices as `items[0]` rather than `items.0`. */
  bracketArrays: boolean;
  /** Stop descending past this depth; deeper values are JSON-encoded inline. */
  maxDepth: number;
  /** Leave arrays as a single JSON-encoded cell rather than one column each. */
  arraysAsJson: boolean;
}

export const defaultFlattenOptions: FlattenOptions = {
  separator: '.',
  bracketArrays: true,
  maxDepth: 12,
  arraysAsJson: false,
};

export function flattenValue(
  value: unknown,
  options: FlattenOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const walk = (v: unknown, path: string, depth: number): void => {
    const isPlainObject = v !== null && typeof v === 'object' && !Array.isArray(v);
    const isArray = Array.isArray(v);

    if (depth >= options.maxDepth && (isPlainObject || isArray)) {
      out[path] = JSON.stringify(v);
      return;
    }

    if (isArray) {
      if (options.arraysAsJson) {
        out[path] = JSON.stringify(v);
        return;
      }
      if (v.length === 0) {
        out[path] = '';
        return;
      }
      v.forEach((item, i) => {
        const next = options.bracketArrays
          ? `${path}[${i}]`
          : path
            ? `${path}${options.separator}${i}`
            : String(i);
        walk(item, next, depth + 1);
      });
      return;
    }

    if (isPlainObject) {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) {
        out[path] = '';
        return;
      }
      for (const [key, item] of entries) {
        walk(item, path ? `${path}${options.separator}${key}` : key, depth + 1);
      }
      return;
    }

    out[path] = v;
  };

  walk(value, '', 0);
  return out;
}

export function unflattenValue(flat: Record<string, unknown>, separator: string): unknown {
  const root: Record<string, unknown> = {};

  for (const [path, value] of Object.entries(flat)) {
    // Split on the separator, then peel bracketed indices off each segment.
    const segments: Array<string | number> = [];
    for (const part of path.split(separator)) {
      const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
      if (!match) {
        segments.push(part);
        continue;
      }
      if (match[1]) segments.push(match[1]);
      for (const idx of match[2]?.match(/\d+/g) ?? []) segments.push(Number(idx));
    }

    let cursor: any = root;
    for (let i = 0; i < segments.length; i++) {
      const key = segments[i]!;
      const isLast = i === segments.length - 1;
      if (isLast) {
        cursor[key] = value;
        break;
      }
      const nextIsIndex = typeof segments[i + 1] === 'number';
      if (cursor[key] === undefined || typeof cursor[key] !== 'object') {
        cursor[key] = nextIsIndex ? [] : {};
      }
      cursor = cursor[key];
    }
  }

  return root;
}
