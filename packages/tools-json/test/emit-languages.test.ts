import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inferSchema } from '../src/schema.js';
import { emitGo, defaultGoOptions } from '../src/emit-go.js';
import { emitCSharp, defaultCSharpOptions } from '../src/emit-csharp.js';
import { emitPython, defaultPythonOptions } from '../src/emit-python.js';

const go = (v: unknown, o: Partial<typeof defaultGoOptions> = {}) =>
  emitGo(inferSchema(v), { ...defaultGoOptions, ...o }).code;
const cs = (v: unknown, o: Partial<typeof defaultCSharpOptions> = {}) =>
  emitCSharp(inferSchema(v), { ...defaultCSharpOptions, ...o }).code;
const py = (v: unknown, o: Partial<typeof defaultPythonOptions> = {}) =>
  emitPython(inferSchema(v), { ...defaultPythonOptions, ...o }).code;

/** Sample shapes every language emitter is held to. */
const SAMPLES: Array<[string, unknown]> = [
  ['array of records', [{ id: 1, name: 'Ada' }, { id: 2 }]],
  ['nullable and optional', [{ a: 1, b: 'x' }, { a: 2, b: null }, { a: 3 }]],
  ['nested objects', { team: { lead: { name: 'Ada' } } }],
  ['arrays of objects', { users: [{ id: 1 }, { id: 2 }] }],
  ['formats', { at: '2026-01-02T03:04:05Z', id: '3f0c2e1a-1111-4222-8333-444455556666' }],
  ['awkward keys', { 'content-type': 'json', '2fa': true, class: 'x' }],
  ['empty containers', { a: {}, b: [] }],
  ['mixed union', { v: [1, 'two'] }],
  ['scalar root', 42],
];

describe('Go', () => {
  it('uses pointers for nullable and optional fields', () => {
    const code = go([{ a: 1, b: 'x' }, { a: 2, b: null }, { a: 3 }]);
    expect(code).toContain('*string');
    expect(code).toMatch(/A\s+\*?int64\s+`json:"a"`/);
  });

  it('marks only absent keys omitempty, not merely nullable ones', () => {
    const code = go([{ present: null }, { present: 'x', missing: 1 }]);
    expect(code).toContain('`json:"present"`');
    expect(code).toContain('omitempty');
    expect(code.match(/omitempty/g)).toHaveLength(1);
  });

  it('applies Go initialism conventions', () => {
    const code = go({ id: 1, api_url: 'x', user_id: 'y', html_body: 'z' });
    expect(code).toContain('ID ');
    expect(code).toContain('APIURL');
    expect(code).toContain('UserID');
    expect(code).toContain('HTMLBody');
  });

  it('can use time.Time and imports it only when used', () => {
    expect(go({ at: '2026-01-02T03:04:05Z' }, { useTimeType: true })).toContain('import "time"');
    expect(go({ at: '2026-01-02T03:04:05Z' }, { useTimeType: false })).not.toContain('time');
  });

  it('does not point at slices, which are already nil-able', () => {
    const code = go([{ tags: ['a'] }, { tags: null }]);
    expect(code).not.toContain('*[]');
  });

  it('warns when pointers are disabled', () => {
    const result = emitGo(inferSchema({ a: 1 }), { ...defaultGoOptions, usePointers: false });
    expect(result.warnings.join(' ')).toMatch(/cannot tell/i);
  });

  it('avoids colliding the root alias with its element type', () => {
    const code = go([{ id: 1 }]);
    expect(code).toContain('type RootItem struct');
    expect(code).toContain('type Root []RootItem');
  });
});

describe('C#', () => {
  it('marks nullable and optional properties with ?', () => {
    const code = cs([{ a: 1, b: 'x' }, { a: 2, b: null }, { a: 3 }]);
    expect(code).toContain('#nullable enable');
    // b is absent from one record and null in another, so it is both.
    expect(code).toContain('string? B');
    // a is in every record, so it must NOT be marked nullable.
    expect(code).toContain('public long A');
    expect(code).not.toContain('long? A');
  });

  it('emits serializer attributes preserving the original key', () => {
    expect(cs({ user_name: 'a' })).toContain('[JsonPropertyName("user_name")]');
    expect(cs({ user_name: 'a' }, { serializer: 'newtonsoft' })).toContain('[JsonProperty("user_name")]');
    expect(cs({ user_name: 'a' }, { serializer: 'none' })).not.toContain('[Json');
  });

  it('uses Guid and DateTime for detected formats', () => {
    const code = cs({ id: '3f0c2e1a-1111-4222-8333-444455556666', at: '2026-01-02T03:04:05Z' });
    expect(code).toContain('Guid Id');
    expect(code).toContain('DateTime At');
    expect(code).toContain('using System;');
  });

  it('renames a property that would collide with its enclosing type (CS0542)', () => {
    // {"user": {"user": ...}} generates class User with a User property, which
    // does not compile.
    const code = cs({ user: { user: 'nested' } });
    expect(code).toContain('class User');
    expect(code).not.toMatch(/class User\b[\s\S]*?public string\?? User \{/);
  });

  it('supports records', () => {
    expect(cs({ a: 1 }, { style: 'record' })).toContain('public record Root');
  });

  it('tells you how to deserialise an array root', () => {
    expect(cs([{ a: 1 }])).toContain('List<RootItem>');
  });
});

describe('Python', () => {
  it('emits Pydantic models with aliases for renamed keys', () => {
    const code = py({ userName: 'a' });
    expect(code).toContain('class Root(BaseModel)');
    expect(code).toContain('user_name: str = Field(alias="userName")');
  });

  it('distinguishes nullable from optional', () => {
    const code = py([{ a: 1, b: 'x' }, { a: 2, b: null }, { a: 3 }]);
    expect(code).toContain('b: str | None = None');
    // a is present in every record, so it stays required.
    expect(code).toMatch(/^\s+a: int$/m);
  });

  it('can emit Optional[...] instead of modern unions', () => {
    expect(py([{ b: 'x' }, { b: null }], { modernUnions: false })).toContain('Optional[str]');
  });

  it('escapes Python keywords used as keys', () => {
    expect(py({ class: 'x', from: 'y' })).toContain('class_');
  });

  it('handles a Mongo-style _id without tripping Pydantic private attributes', () => {
    const code = py({ _id: 'abc' });
    expect(code).toContain('id: str = Field(alias="_id")');
    expect(code).not.toMatch(/^\s+_id/m);
  });

  it('never emits a leading underscore, which Pydantic rejects outright', () => {
    const code = py({ '2fa': true, _id: 'x', __weird__: 1 });
    for (const line of code.split('\n').filter((l) => /^ {4}\w/.test(l))) {
      expect(line.trimStart().startsWith('_')).toBe(false);
    }
    expect(code).toContain('field_2fa');
  });

  it('emits a single dataclasses import', () => {
    const code = py({ userName: 'a' }, { style: 'dataclass' });
    expect(code.match(/from dataclasses import/g)).toHaveLength(1);
    expect(code).toContain('from dataclasses import dataclass, field');
  });

  it('warns that plain dataclasses do not apply aliases themselves', () => {
    const result = emitPython(inferSchema({ userName: 'a' }), {
      ...defaultPythonOptions,
      style: 'dataclass',
    });
    expect(result.warnings.join(' ')).toMatch(/do not map JSON keys/i);
  });

  it('orders required fields before defaulted ones', () => {
    // Python raises at import time if a defaulted field precedes a plain one.
    const code = py([{ optionalFirst: 1, required: 2 }, { required: 3 }], { style: 'dataclass' });
    const lines = code.split('\n').filter((l) => l.startsWith('    ') && l.includes(':'));
    const firstDefault = lines.findIndex((l) => l.includes('= None') || l.includes('default=None'));
    const lastPlain = lines.map((l, i) => (/= /.test(l) ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
    expect(firstDefault).toBeGreaterThan(lastPlain);
  });
});

// --- The real proof: hand the output to the actual toolchains ----------------

function run(cmd: string, args: string[], cwd?: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
    return { ok: true, out };
  } catch (e: any) {
    return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? e.message) };
  }
}

const hasGo = run('go', ['version']).ok;

describe.runIf(hasGo)('generated Go compiles and is gofmt-clean', () => {
  for (const [name, sample] of SAMPLES) {
    it(name, () => {
      const dir = mkdtempSync(join(tmpdir(), 'gen-go-'));
      try {
        writeFileSync(join(dir, 'main.go'), go(sample, { useTimeType: true }) + '\nfunc main() {}\n');
        run('go', ['mod', 'init', 'gen'], dir);
        const vet = run('go', ['vet', './...'], dir);
        expect(vet.ok, vet.out).toBe(true);
        // An empty listing means the emitter's own spacing already matches
        // gofmt, so nobody has to reformat what they paste.
        const fmt = run('gofmt', ['-l', dir]);
        expect(fmt.out.trim(), `not gofmt-formatted:\n${fmt.out}`).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

const hasPython = run('python3', ['-c', 'import sys']).ok;
const hasPydantic = run('python3', ['-c', 'import pydantic']).ok;

describe.runIf(hasPython)('generated Python imports cleanly', () => {
  for (const [name, sample] of SAMPLES) {
    it(`${name} (dataclass)`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'gen-py-'));
      try {
        writeFileSync(join(dir, 'models.py'), py(sample, { style: 'dataclass' }));
        const result = run('python3', [join(dir, 'models.py')]);
        expect(result.ok, result.out).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  describe.runIf(hasPydantic)('pydantic', () => {
    for (const [name, sample] of SAMPLES) {
      it(`${name} (pydantic)`, () => {
        const dir = mkdtempSync(join(tmpdir(), 'gen-py-'));
        try {
          writeFileSync(join(dir, 'models.py'), py(sample, { style: 'pydantic' }));
          const result = run('python3', [join(dir, 'models.py')]);
          expect(result.ok, result.out).toBe(true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
});
