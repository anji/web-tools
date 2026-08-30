import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inferSchema } from '../src/schema.js';
import { emitGo, defaultGoOptions } from '../src/emit-go.js';
import { emitCSharp, defaultCSharpOptions } from '../src/emit-csharp.js';
import { emitPython, defaultPythonOptions } from '../src/emit-python.js';
import { emitJava, defaultJavaOptions } from '../src/emit-java.js';
import { emitRust, defaultRustOptions } from '../src/emit-rust.js';

const go = (v: unknown, o: Partial<typeof defaultGoOptions> = {}) =>
  emitGo(inferSchema(v), { ...defaultGoOptions, ...o }).code;
const cs = (v: unknown, o: Partial<typeof defaultCSharpOptions> = {}) =>
  emitCSharp(inferSchema(v), { ...defaultCSharpOptions, ...o }).code;
const py = (v: unknown, o: Partial<typeof defaultPythonOptions> = {}) =>
  emitPython(inferSchema(v), { ...defaultPythonOptions, ...o }).code;
const java = (v: unknown, o: Partial<typeof defaultJavaOptions> = {}) =>
  emitJava(inferSchema(v), { ...defaultJavaOptions, ...o }).code;
const rs = (v: unknown, o: Partial<typeof defaultRustOptions> = {}) =>
  emitRust(inferSchema(v), { ...defaultRustOptions, ...o }).code;

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


describe('Java', () => {
  it('boxes primitives that can be absent or null', () => {
    // A Java `long` cannot hold null, so an optional number must become Long.
    const code = java([{ always: 1, sometimes: 2 }, { always: 3 }]);
    expect(code).toMatch(/long always/);
    expect(code).toMatch(/Long sometimes/);
  });

  it('leaves reference types unboxed', () => {
    const code = java([{ s: 'x' }, { s: null }]);
    expect(code).toContain('String s');
  });

  it('warns when boxing is disabled', () => {
    const result = emitJava(inferSchema([{ a: 1 }, {}]), {
      ...defaultJavaOptions,
      useBoxedTypes: false,
    });
    expect(result.warnings.join(' ')).toMatch(/cannot represent absence/i);
  });

  it('names a boxed type in the root hint, since generics reject primitives', () => {
    expect(java(42)).toContain('TypeReference<Long>');
    expect(java(42)).not.toContain('TypeReference<long>');
  });

  it('presents each type as its own file, since Java allows one public type per file', () => {
    const code = java({ team: { name: 'Core' } });
    expect(code).toContain('// Team.java');
    expect(code).toContain('// Root.java');
  });

  it('scopes imports to the file that needs them', () => {
    const code = java({ tags: ['a'], team: { name: 'x' } });
    const teamFile = code.split('// Root.java')[0]!;
    expect(teamFile).not.toContain('java.util.List');
  });

  it('generates getters and setters in class mode', () => {
    const code = java({ userName: 'a', active: true }, { style: 'class' });
    expect(code).toContain('private String userName;');
    expect(code).toContain('public String getUserName()');
    expect(code).toContain('public void setUserName(String userName)');
    expect(code).toContain('public boolean isActive()');
  });

  it('renames fields that collide with Java keywords', () => {
    expect(java({ class: 'x', static: 1 })).toContain('classValue');
  });
});

describe('Rust', () => {
  it('wraps optional and nullable fields in Option', () => {
    const code = rs([{ a: 1, b: 'x' }, { a: 2, b: null }, { a: 3 }]);
    expect(code).toContain('pub a: i64,');
    expect(code).toContain('pub b: Option<String>,');
  });

  it('renames non-snake_case keys rather than emitting invalid identifiers', () => {
    const code = rs({ userName: 'a' });
    expect(code).toContain('#[serde(rename = "userName")]');
    expect(code).toContain('pub user_name: String,');
  });

  it('uses raw identifiers for keywords', () => {
    const code = rs({ type: 'x', match: 1 });
    expect(code).toContain('pub r#type: String,');
    expect(code).toContain('pub r#match: i64,');
    // A raw identifier is still the same name, so no rename is needed.
    expect(code).not.toContain('rename = "type"');
  });

  it('suffixes the keywords raw identifiers cannot express', () => {
    const code = rs({ self: 1, crate: 2 });
    expect(code).toContain('self_');
    expect(code).toContain('crate_');
    expect(code).toContain('rename = "self"');
  });

  it('skips serialising None so absent stays absent on the way out', () => {
    expect(rs([{ a: 1 }, {}])).toContain('skip_serializing_if = "Option::is_none"');
  });

  it('warns when Value appears', () => {
    const result = emitRust(inferSchema({ mixed: [1, 'two'] }), defaultRustOptions);
    expect(result.warnings.join(' ')).toMatch(/serde_json::Value/);
  });

  it('warns that disabling Option makes deserialisation fail outright', () => {
    const result = emitRust(inferSchema([{ a: 1 }, {}]), {
      ...defaultRustOptions,
      useOption: false,
    });
    expect(result.warnings.join(' ')).toMatch(/no null/i);
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

const hasJava = run('javac', ['-version']).ok;

describe.runIf(hasJava)('generated Java compiles', () => {
  // Jackson is not available offline, so the annotation is stubbed. That is
  // enough to prove the generated types and annotation targets are valid.
  const STUB = `package com.fasterxml.jackson.annotation;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME)
@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.METHOD, ElementType.RECORD_COMPONENT})
public @interface JsonProperty { String value() default ""; }
`;

  for (const [name, sample] of SAMPLES) {
    for (const style of ['record', 'class'] as const) {
      it(`${name} (${style})`, () => {
        const dir = mkdtempSync(join(tmpdir(), 'gen-java-'));
        try {
          mkdirSync(join(dir, 'com/fasterxml/jackson/annotation'), { recursive: true });
          writeFileSync(join(dir, 'com/fasterxml/jackson/annotation/JsonProperty.java'), STUB);

          // Each "// X.java" block is a separate compilation unit.
          const code = java(sample, { style });
          const files: string[] = [];
          for (const block of code.split(/^\/\/ (?=\w+\.java$)/m)) {
            const match = /^(\w+)\.java\n([\s\S]*)$/.exec(block.trim());
            if (!match) continue;
            const file = `${match[1]}.java`;
            writeFileSync(join(dir, file), match[2]!);
            files.push(file);
          }
          if (files.length === 0) {
            // A scalar root produces no Java type at all, only a hint about
            // what to deserialise into. There is nothing to compile, but the
            // hint must still name a type generics can actually hold.
            expect(code).toMatch(/^\/\/ Deserialise as: [A-Z]/m);
            return;
          }

          const result = run('javac', ['-nowarn', '-cp', '.', ...files], dir);
          expect(result.ok, `${result.out}\n--- generated ---\n${code}`).toBe(true);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

// A prepared crate with serde is required; skipped when it is absent so the
// suite still runs on a machine without one.
const RUST_CRATE = process.env.RUST_CHECK_CRATE ?? '/tmp/rustcheck';
const hasRustCrate = run('cargo', ['--version']).ok && existsSync(join(RUST_CRATE, 'Cargo.toml'));

describe.runIf(hasRustCrate)('generated Rust compiles and is rustfmt-clean', () => {
  for (const [name, sample] of SAMPLES) {
    it(name, () => {
      const lib = join(RUST_CRATE, 'src', 'lib.rs');
      writeFileSync(lib, rs(sample, { useRichTypes: true }));
      const check = run('cargo', ['check', '--quiet'], RUST_CRATE);
      expect(check.ok, check.out).toBe(true);
      // As with gofmt, matching rustfmt means nobody reformats what they paste.
      const fmt = run('rustfmt', ['--check', '--edition', '2021', lib]);
      expect(fmt.out.trim(), `not rustfmt-formatted:\n${fmt.out}`).toBe('');
    });
  }
});
