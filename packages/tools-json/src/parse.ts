import { ok, err } from '@tools/core';
import type { Result, ToolError } from '@tools/core';

/**
 * `JSON.parse` throws messages whose wording differs across V8, SpiderMonkey and
 * JavaScriptCore, and none of them tell you what to actually do about it. This
 * module normalises the location and adds a hint derived from the surrounding
 * text -- "you left a trailing comma" beats "Unexpected token }" every time.
 */

export interface Position {
  line: number;
  column: number;
  offset: number;
}

export function offsetToPosition(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: clamped - lastNewline, offset: clamped };
}

function locate(text: string, message: string): Position | undefined {
  // Newer V8 appends "(line 3 column 5)"; SpiderMonkey uses "at line 3 column 5".
  const lineCol = /line (\d+) column (\d+)/.exec(message);
  if (lineCol?.[1] && lineCol[2]) {
    const line = Number(lineCol[1]);
    const column = Number(lineCol[2]);
    let offset = 0;
    let seen = 1;
    for (let i = 0; i < text.length && seen < line; i++) {
      if (text.charCodeAt(i) === 10) {
        seen++;
        offset = i + 1;
      }
    }
    return { line, column, offset: offset + column - 1 };
  }

  const pos = /at position (\d+)/.exec(message);
  if (pos?.[1]) return offsetToPosition(text, Number(pos[1]));

  return undefined;
}

const HINTS: ReadonlyArray<{ test: (text: string, at: number) => boolean; hint: string }> = [
  {
    // Look backwards past whitespace from the offending bracket for a comma.
    test: (text, at) => {
      const ch = text[at];
      if (ch !== '}' && ch !== ']') return false;
      for (let i = at - 1; i >= 0; i--) {
        const c = text[i]!;
        if (c === ',') return true;
        if (!/\s/.test(c)) return false;
      }
      return false;
    },
    hint: 'Looks like a trailing comma before the closing bracket. JSON does not allow one, unlike JavaScript.',
  },
  {
    test: (text) => /(^|[{,[]\s*)'[^']*'\s*:/m.test(text) || /:\s*'[^']*'/.test(text),
    hint: 'Strings and keys must use double quotes in JSON. Single quotes are JavaScript, not JSON.',
  },
  {
    test: (text) => /[{,]\s*[A-Za-z_$][A-Za-z0-9_$]*\s*:/.test(text),
    hint: 'Object keys must be wrapped in double quotes, e.g. {"name": 1} rather than {name: 1}.',
  },
  {
    test: (text) => /(^|\s)\/\//.test(text) || /\/\*/.test(text),
    hint: 'Comments are not valid JSON. Strip the // and /* */ blocks, or use JSON5/JSONC instead.',
  },
  {
    test: (text) => /\b(True|False|None)\b/.test(text),
    hint: 'This looks like a Python dict. JSON uses true, false and null rather than True, False and None.',
  },
  {
    test: (text) => /\b(NaN|Infinity|-Infinity|undefined)\b/.test(text),
    hint: 'NaN, Infinity and undefined are not valid JSON values. Use null, or a string, instead.',
  },
];

function hintFor(text: string, at: number | undefined): string | undefined {
  for (const { test, hint } of HINTS) {
    if (test(text, at ?? 0)) return hint;
  }
  return undefined;
}

export function parseJson(text: string): Result<unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return err({ message: 'Nothing to parse yet.', hint: 'Paste or drop some JSON to get started.' });
  }

  try {
    return ok(JSON.parse(text));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const position = locate(text, message);
    const hint = hintFor(text, position?.offset);

    const error: ToolError = {
      // Strip the engine's own position suffix; we render location separately.
      message: message
        .replace(/\s*(in JSON )?at position \d+.*$/i, '')
        .replace(/\s*at line \d+ column \d+ of the JSON data\.?$/i, '')
        .replace(/^JSON\.parse:\s*/i, '')
        .trim(),
      ...(position ? { line: position.line, column: position.column, offset: position.offset } : {}),
      ...(hint ? { hint } : {}),
    };
    return { ok: false, error };
  }
}

/** Counts nodes so tools can report "1,204 keys across 3 levels". */
export function measure(value: unknown): { nodes: number; depth: number; keys: number } {
  let nodes = 0;
  let keys = 0;
  let maxDepth = 0;

  const walk = (v: unknown, depth: number): void => {
    nodes++;
    if (depth > maxDepth) maxDepth = depth;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
    } else if (v !== null && typeof v === 'object') {
      for (const [, item] of Object.entries(v as Record<string, unknown>)) {
        keys++;
        walk(item, depth + 1);
      }
    }
  };

  walk(value, 1);
  return { nodes, depth: maxDepth, keys };
}
