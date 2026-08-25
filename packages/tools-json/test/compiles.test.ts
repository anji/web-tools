import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inferSchema } from '../src/schema.js';
import { emitTypeScript, defaultTypeScriptOptions } from '../src/emit-typescript.js';
import { emitZod, defaultZodOptions } from '../src/emit-zod.js';

/**
 * The promise of a code generator is that the code it emits compiles. Asserting
 * on substrings cannot catch a duplicate identifier or a forward reference, so
 * these cases go through the real compiler.
 */
function typechecks(code: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gen-'));
  try {
    writeFileSync(join(dir, 'generated.ts'), code);
    execFileSync(
      'npx',
      ['tsc', '--noEmit', '--strict', '--target', 'ES2022', '--moduleResolution', 'bundler',
       '--module', 'ESNext', '--skipLibCheck', join(dir, 'generated.ts')],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    return { ok: true, output: '' };
  } catch (e: any) {
    return { ok: false, output: String(e.stdout ?? e.message) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLES: Array<[string, unknown]> = [
  ['array of records', [{ id: 1, name: 'Ada' }, { id: 2 }]],
  ['single object', { id: 1, nested: { deep: { deeper: true } } }],
  ['array of primitives', [1, 2, 3]],
  ['nested arrays of objects', { groups: [{ users: [{ id: 1 }] }] }],
  ['mixed unions and nulls', [{ v: 1 }, { v: 'x' }, { v: null }]],
  ['awkward keys', { 'content-type': 'json', '2fa': true, class: 'x' }],
  ['empty object and array', { a: {}, b: [] }],
  ['repeated shapes', { sender: { id: 1 }, receiver: { id: 2 } }],
];

describe('generated TypeScript compiles', () => {
  for (const [name, sample] of SAMPLES) {
    it(name, () => {
      const { code } = emitTypeScript(inferSchema(sample), defaultTypeScriptOptions);
      const result = typechecks(code);
      expect(result.ok, `${result.output}\n--- generated ---\n${code}`).toBe(true);
    });
  }
});

describe('root naming', () => {
  it('does not collide the root alias with its element type', () => {
    const { code } = emitTypeScript(inferSchema([{ id: 1 }]), defaultTypeScriptOptions);
    expect(code).toContain('interface RootItem {');
    expect(code).toContain('type Root = RootItem[];');
  });

  it('uses the singular of a plural root name for the element type', () => {
    const { code } = emitTypeScript(inferSchema([{ id: 1 }]), {
      ...defaultTypeScriptOptions,
      rootName: 'Users',
    });
    expect(code).toContain('interface User {');
    expect(code).toContain('type Users = User[];');
  });

  it('emits one const per name in Zod for a root array', () => {
    const { code } = emitZod(inferSchema([{ id: 1 }]), defaultZodOptions);
    const consts = [...code.matchAll(/export const (\w+)/g)].map((m) => m[1]);
    expect(new Set(consts).size).toBe(consts.length);
  });
});
