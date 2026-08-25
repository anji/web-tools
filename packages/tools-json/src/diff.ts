/**
 * Structural JSON diff. A text diff of two pretty-printed API responses is
 * mostly noise -- reordered keys and reindented blocks -- so this compares the
 * parsed values and reports paths.
 */

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface Change {
  kind: ChangeKind;
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface DiffOptions {
  /** 'index' compares arrays position by position; 'id' matches on an id key. */
  arrayStrategy: 'index' | 'id';
  /** Key used to pair up array elements when arrayStrategy is 'id'. */
  idKey: string;
  /** Treat key order as irrelevant (it always is in JSON, but be explicit). */
  ignoreArrayOrder: boolean;
}

export const defaultDiffOptions: DiffOptions = {
  arrayStrategy: 'index',
  idKey: 'id',
  ignoreArrayOrder: false,
};

function formatPathSegment(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function keyOf(item: unknown, idKey: string): string | undefined {
  if (!isObject(item)) return undefined;
  const raw = item[idKey];
  if (raw === undefined || raw === null) return undefined;
  return String(raw);
}

export function diffJson(before: unknown, after: unknown, options: DiffOptions): Change[] {
  const changes: Change[] = [];

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (Object.is(a, b)) return;

    if (isObject(a) && isObject(b)) {
      for (const key of Object.keys(a)) {
        if (key in b) walk(a[key], b[key], path + formatPathSegment(key));
        else changes.push({ kind: 'removed', path: path + formatPathSegment(key), before: a[key] });
      }
      for (const key of Object.keys(b)) {
        if (!(key in a)) {
          changes.push({ kind: 'added', path: path + formatPathSegment(key), after: b[key] });
        }
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      if (options.arrayStrategy === 'id') {
        diffArraysById(a, b, path);
        return;
      }
      if (options.ignoreArrayOrder) {
        diffArraysAsSets(a, b, path);
        return;
      }
      const max = Math.max(a.length, b.length);
      for (let i = 0; i < max; i++) {
        if (i >= a.length) changes.push({ kind: 'added', path: `${path}[${i}]`, after: b[i] });
        else if (i >= b.length) changes.push({ kind: 'removed', path: `${path}[${i}]`, before: a[i] });
        else walk(a[i], b[i], `${path}[${i}]`);
      }
      return;
    }

    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changes.push({ kind: 'changed', path: path || '$', before: a, after: b });
    }
  };

  const diffArraysById = (a: readonly unknown[], b: readonly unknown[], path: string): void => {
    const idKey = options.idKey;
    const beforeById = new Map<string, unknown>();
    const unkeyedBefore: unknown[] = [];
    for (const item of a) {
      const k = keyOf(item, idKey);
      if (k === undefined) unkeyedBefore.push(item);
      else beforeById.set(k, item);
    }

    const unkeyedAfter: unknown[] = [];
    for (const item of b) {
      const k = keyOf(item, idKey);
      if (k === undefined) {
        unkeyedAfter.push(item);
        continue;
      }
      if (beforeById.has(k)) {
        walk(beforeById.get(k), item, `${path}[${idKey}=${k}]`);
        beforeById.delete(k);
      } else {
        changes.push({ kind: 'added', path: `${path}[${idKey}=${k}]`, after: item });
      }
    }
    for (const [k, item] of beforeById) {
      changes.push({ kind: 'removed', path: `${path}[${idKey}=${k}]`, before: item });
    }
    // Elements without the id key fall back to positional comparison.
    const max = Math.max(unkeyedBefore.length, unkeyedAfter.length);
    for (let i = 0; i < max; i++) {
      if (i >= unkeyedBefore.length) {
        changes.push({ kind: 'added', path: `${path}[?${i}]`, after: unkeyedAfter[i] });
      } else if (i >= unkeyedAfter.length) {
        changes.push({ kind: 'removed', path: `${path}[?${i}]`, before: unkeyedBefore[i] });
      } else {
        walk(unkeyedBefore[i], unkeyedAfter[i], `${path}[?${i}]`);
      }
    }
  };

  const diffArraysAsSets = (a: readonly unknown[], b: readonly unknown[], path: string): void => {
    const counts = new Map<string, number>();
    for (const item of a) {
      const k = JSON.stringify(item) ?? 'undefined';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const item of b) {
      const k = JSON.stringify(item) ?? 'undefined';
      const n = counts.get(k) ?? 0;
      if (n > 0) counts.set(k, n - 1);
      else changes.push({ kind: 'added', path, after: item });
    }
    for (const [k, n] of counts) {
      for (let i = 0; i < n; i++) {
        changes.push({ kind: 'removed', path, before: JSON.parse(k) as unknown });
      }
    }
  };

  walk(before, after, '');
  return changes;
}

const preview = (value: unknown): string => {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 120 ? text.slice(0, 117) + '...' : text;
};

export function renderDiff(changes: readonly Change[]): string {
  if (changes.length === 0) return 'No differences. The two documents are structurally identical.\n';

  const lines: string[] = [];
  for (const change of changes) {
    const path = change.path.startsWith('.') ? '$' + change.path : change.path || '$';
    switch (change.kind) {
      case 'added':
        lines.push(`+ ${path}: ${preview(change.after)}`);
        break;
      case 'removed':
        lines.push(`- ${path}: ${preview(change.before)}`);
        break;
      case 'changed':
        lines.push(`~ ${path}: ${preview(change.before)} -> ${preview(change.after)}`);
        break;
    }
  }
  return lines.join('\n') + '\n';
}
