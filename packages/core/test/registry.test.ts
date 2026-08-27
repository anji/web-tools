import { describe, it, expect } from 'vitest';
import { createRegistry, type Section, type SiteBrand } from '../src/registry.js';
import { defineTool, defaultOptions, readBoolean, readNumber, readString } from '../src/tool.js';
import { ok, err, attempt } from '../src/result.js';
import { formatBytes } from '../src/files.js';

const brand: SiteBrand = {
  name: 'Test',
  origin: 'https://example.test',
  tagline: 't',
  description: 'd',
};

const tool = (id: string, slug: string, category = 'General') =>
  defineTool({
    id,
    slug,
    label: id,
    blurb: 'b',
    category,
    seo: { title: 't', description: 'd', heading: 'h', intro: 'i', keywords: [] },
    inputs: [{ label: 'In', language: 'text' }] as const,
    run: () => ok({ content: '', language: 'text' as const, filename: 'f.txt' }),
  });

const section = (slug: string, tools: ReturnType<typeof tool>[]): Section => ({
  slug,
  name: slug,
  tagline: 't',
  description: 'd',
  intro: 'i',
  tools,
});

describe('registry validation', () => {
  it('rejects duplicate section slugs', () => {
    expect(() => createRegistry(brand, [section('a', []), section('a', [])])).toThrow(
      /Duplicate section slug/,
    );
  });

  it('rejects duplicate tool slugs inside one section', () => {
    expect(() =>
      createRegistry(brand, [section('a', [tool('one', 'dup'), tool('two', 'dup')])]),
    ).toThrow(/Duplicate tool slug/);
  });

  it('allows the same tool slug in different sections', () => {
    // /json/diff and /csv/diff are distinct URLs, so this must not throw.
    expect(() =>
      createRegistry(brand, [section('json', [tool('a', 'diff')]), section('csv', [tool('b', 'diff')])]),
    ).not.toThrow();
  });
});

describe('registry queries', () => {
  const registry = createRegistry(brand, [
    section('json', [tool('fmt', 'formatter'), tool('diff', 'diff')]),
    section('pdf', []),
  ]);

  it('splits live from planned by whether tools exist', () => {
    expect(registry.live().map((s) => s.slug)).toEqual(['json']);
    expect(registry.planned().map((s) => s.slug)).toEqual(['pdf']);
  });

  it('builds section and tool paths with trailing slashes', () => {
    const json = registry.section('json')!;
    expect(registry.sectionPath(json)).toBe('/json/');
    expect(registry.toolPath(json, json.tools[0]!)).toBe('/json/formatter/');
  });

  it('flattens every tool across sections', () => {
    expect(registry.allTools().map((t) => t.id)).toEqual(['fmt', 'diff']);
  });

  it('lists the homepage, every section and every tool in the sitemap', () => {
    // Planned sections are indexable: they carry real curated content.
    expect(registry.urls()).toEqual([
      'https://example.test/',
      'https://example.test/json/',
      'https://example.test/pdf/',
      'https://example.test/json/formatter/',
      'https://example.test/json/diff/',
    ]);
  });

  it('returns undefined for an unknown section', () => {
    expect(registry.section('nope')).toBeUndefined();
  });
});

describe('option handling', () => {
  const def = {
    options: [
      { kind: 'boolean', key: 'flag', label: 'f', default: true },
      { kind: 'select', key: 'mode', label: 'm', choices: [{ value: 'a', label: 'A' }], default: 'a' },
      { kind: 'number', key: 'size', label: 's', default: 4 },
    ],
  } as const;

  it('collects declared defaults', () => {
    expect(defaultOptions(def as any)).toEqual({ flag: true, mode: 'a', size: 4 });
  });

  it('falls back when a value is missing or the wrong type', () => {
    expect(readBoolean({ a: 'yes' }, 'a', false)).toBe(false);
    expect(readBoolean({ a: true }, 'a', false)).toBe(true);
    expect(readString({ a: 3 }, 'a', 'x')).toBe('x');
    expect(readNumber({ a: 'nope' }, 'a', 7)).toBe(7);
    expect(readNumber({}, 'missing', 7)).toBe(7);
  });

  it('rejects non-finite numbers, which would otherwise reach a tool', () => {
    expect(readNumber({ a: Number.NaN }, 'a', 2)).toBe(2);
    expect(readNumber({ a: Number.POSITIVE_INFINITY }, 'a', 2)).toBe(2);
  });
});

describe('result helpers', () => {
  it('wraps success and failure', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('boom')).toEqual({ ok: false, error: { message: 'boom' } });
  });

  it('turns a thrown error into a Result rather than propagating it', () => {
    const result = attempt(() => {
      throw new Error('kaboom');
    }, 'try again');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('kaboom');
    expect(result.error.hint).toBe('try again');
  });
});

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
  });
});
