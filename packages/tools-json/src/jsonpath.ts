import { ok, err } from '@tools/core';
import type { Result } from '@tools/core';

/**
 * A dependency-free JSONPath subset covering what people actually paste into a
 * query box: child access, wildcards, recursive descent, index/slice selection
 * and single-comparison filters.
 */

type Comparison = '==' | '!=' | '<' | '<=' | '>' | '>=' | '=~';

interface Filter {
  /** Property chain after the `@`, e.g. ['user', 'age']. Empty means `@` itself. */
  path: string[];
  op?: Comparison;
  value?: unknown;
}

type Segment =
  | { t: 'child'; name: string }
  | { t: 'wildcard' }
  | { t: 'descend'; name?: string }
  | { t: 'index'; indices: number[] }
  | { t: 'slice'; start?: number; end?: number; step: number }
  | { t: 'filter'; filter: Filter };

export interface Match {
  path: string;
  value: unknown;
}

function parseLiteral(raw: string): unknown {
  const text = raw.trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  const n = Number(text);
  return Number.isNaN(n) ? text : n;
}

function parseFilter(body: string): Filter {
  // Strip the optional ?( ... ) wrapper that most examples in the wild include.
  let inner = body.trim();
  if (inner.startsWith('?')) inner = inner.slice(1).trim();
  if (inner.startsWith('(') && inner.endsWith(')')) inner = inner.slice(1, -1).trim();

  const opMatch = /(==|!=|<=|>=|=~|<|>)/.exec(inner);
  const lhs = opMatch ? inner.slice(0, opMatch.index).trim() : inner;
  const chain = lhs
    .replace(/^@/, '')
    .split(/[.[\]]/)
    .map((s) => s.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  if (!opMatch) return { path: chain };
  return {
    path: chain,
    op: opMatch[0] as Comparison,
    value: parseLiteral(inner.slice(opMatch.index + opMatch[0].length)),
  };
}

export function parseJsonPath(expression: string): Result<Segment[]> {
  let src = expression.trim();
  if (src.length === 0) return err('Enter a JSONPath expression, for example $.users[*].email');
  if (src.startsWith('$')) src = src.slice(1);

  const segments: Segment[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === '.') {
      if (src[i + 1] === '.') {
        i += 2;
        if (src[i] === '*') {
          segments.push({ t: 'descend' });
          i++;
        } else if (src[i] === '[') {
          segments.push({ t: 'descend' });
        } else {
          const start = i;
          while (i < src.length && /[A-Za-z0-9_$-]/.test(src[i]!)) i++;
          const name = src.slice(start, i);
          if (!name) return err(`Expected a property name after ".." at position ${start}.`);
          segments.push({ t: 'descend', name });
        }
        continue;
      }

      i++;
      if (src[i] === '*') {
        segments.push({ t: 'wildcard' });
        i++;
        continue;
      }
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$-]/.test(src[i]!)) i++;
      const name = src.slice(start, i);
      if (!name) return err(`Expected a property name after "." at position ${start}.`);
      segments.push({ t: 'child', name });
      continue;
    }

    if (ch === '[') {
      const close = findClosingBracket(src, i);
      if (close === -1) return err(`Unclosed "[" at position ${i}.`);
      const body = src.slice(i + 1, close).trim();
      i = close + 1;

      if (body === '*') {
        segments.push({ t: 'wildcard' });
        continue;
      }
      if (body.startsWith('?')) {
        segments.push({ t: 'filter', filter: parseFilter(body) });
        continue;
      }
      if (
        (body.startsWith("'") && body.endsWith("'")) ||
        (body.startsWith('"') && body.endsWith('"'))
      ) {
        segments.push({ t: 'child', name: body.slice(1, -1) });
        continue;
      }
      if (body.includes(':')) {
        const [s, e, st] = body.split(':');
        const slice: Segment = { t: 'slice', step: st && st.trim() ? Number(st) : 1 };
        if (s && s.trim()) slice.start = Number(s);
        if (e && e.trim()) slice.end = Number(e);
        segments.push(slice);
        continue;
      }
      const indices = body.split(',').map((p) => Number(p.trim()));
      if (indices.some((n) => Number.isNaN(n))) {
        segments.push({ t: 'child', name: body });
        continue;
      }
      segments.push({ t: 'index', indices });
      continue;
    }

    // Allow a leading bare property, e.g. `users[0]` without the `$.`.
    if (/[A-Za-z_$]/.test(ch ?? '')) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$-]/.test(src[i]!)) i++;
      segments.push({ t: 'child', name: src.slice(start, i) });
      continue;
    }

    return err(`Unexpected character "${ch}" at position ${i}.`);
  }

  return ok(segments);
}

function findClosingBracket(src: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

function resolveChain(value: unknown, chain: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of chain) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function testFilter(value: unknown, filter: Filter): boolean {
  const actual = resolveChain(value, filter.path);
  if (!filter.op) return actual !== undefined && actual !== null && actual !== false;

  switch (filter.op) {
    case '==':
      return actual === filter.value || JSON.stringify(actual) === JSON.stringify(filter.value);
    case '!=':
      return !(actual === filter.value || JSON.stringify(actual) === JSON.stringify(filter.value));
    case '=~':
      try {
        return typeof actual === 'string' && new RegExp(String(filter.value)).test(actual);
      } catch {
        return false;
      }
    default:
      break;
  }

  if (typeof actual !== 'number' || typeof filter.value !== 'number') return false;
  switch (filter.op) {
    case '<':
      return actual < filter.value;
    case '<=':
      return actual <= filter.value;
    case '>':
      return actual > filter.value;
    case '>=':
      return actual >= filter.value;
  }
}

const childPath = (base: string, key: string | number): string =>
  typeof key === 'number'
    ? `${base}[${key}]`
    : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
      ? `${base}.${key}`
      : `${base}[${JSON.stringify(key)}]`;

function entriesOf(value: unknown): Array<[string | number, unknown]> {
  if (Array.isArray(value)) return value.map((v, i) => [i, v]);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>);
  }
  return [];
}

export function queryJsonPath(root: unknown, expression: string): Result<Match[]> {
  const parsed = parseJsonPath(expression);
  if (!parsed.ok) return parsed;

  let nodes: Match[] = [{ path: '$', value: root }];

  for (const segment of parsed.value) {
    const next: Match[] = [];

    for (const node of nodes) {
      switch (segment.t) {
        case 'child': {
          const v = node.value;
          if (v !== null && typeof v === 'object' && segment.name in (v as object)) {
            next.push({
              path: childPath(node.path, segment.name),
              value: (v as Record<string, unknown>)[segment.name],
            });
          }
          break;
        }

        case 'wildcard':
          for (const [key, value] of entriesOf(node.value)) {
            next.push({ path: childPath(node.path, key), value });
          }
          break;

        case 'descend': {
          // Pre-order walk so ancestors are reported before descendants.
          const stack: Match[] = [node];
          while (stack.length > 0) {
            const current = stack.pop()!;
            const children = entriesOf(current.value);
            for (let k = children.length - 1; k >= 0; k--) {
              const [key, value] = children[k]!;
              const match = { path: childPath(current.path, key), value };
              if (segment.name === undefined || key === segment.name) next.push(match);
              stack.push(match);
            }
          }
          break;
        }

        case 'index':
          if (Array.isArray(node.value)) {
            for (const raw of segment.indices) {
              const idx = raw < 0 ? node.value.length + raw : raw;
              if (idx >= 0 && idx < node.value.length) {
                next.push({ path: `${node.path}[${idx}]`, value: node.value[idx] });
              }
            }
          }
          break;

        case 'slice': {
          if (!Array.isArray(node.value)) break;
          const len = node.value.length;
          const step = segment.step === 0 ? 1 : segment.step;
          let start = segment.start ?? (step > 0 ? 0 : len - 1);
          let end = segment.end ?? (step > 0 ? len : -len - 1);
          if (start < 0) start += len;
          if (end < 0) end += len;
          if (step > 0) {
            for (let k = Math.max(0, start); k < Math.min(len, end); k += step) {
              next.push({ path: `${node.path}[${k}]`, value: node.value[k] });
            }
          } else {
            for (let k = Math.min(len - 1, start); k > Math.max(-1, end); k += step) {
              next.push({ path: `${node.path}[${k}]`, value: node.value[k] });
            }
          }
          break;
        }

        case 'filter':
          for (const [key, value] of entriesOf(node.value)) {
            if (testFilter(value, segment.filter)) {
              next.push({ path: childPath(node.path, key), value });
            }
          }
          break;
      }
    }

    nodes = next;
  }

  return ok(nodes);
}
