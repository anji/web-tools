import { describe, it, expect } from 'vitest';
import { parseJson, measure } from '../src/parse.js';
import { diffJson, renderDiff, defaultDiffOptions } from '../src/diff.js';
import { queryJsonPath, parseJsonPath } from '../src/jsonpath.js';
import { jsonToCsv } from '../src/to-csv.js';
import { flattenValue, unflattenValue, defaultFlattenOptions } from '../src/flatten.js';
import { redactJson, defaultRedactOptions } from '../src/redact.js';
import { jsonToYaml, yamlToJson, defaultYamlOptions } from '../src/yaml.js';

describe('parse diagnostics', () => {
  it('reports the line and column of a syntax error', () => {
    const result = parseJson('{\n  "a": 1,\n  "b" 2\n}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.line).toBe(3);
  });

  it('explains a trailing comma', () => {
    const result = parseJson('{\n  "a": 1,\n}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.hint).toMatch(/trailing comma/i);
  });

  it('explains single quotes', () => {
    const result = parseJson("{'a': 1}");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.hint).toMatch(/double quotes/i);
  });

  it('recognises a Python dict', () => {
    const result = parseJson('{"a": True}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.hint).toMatch(/Python/i);
  });

  it('recognises comments', () => {
    const result = parseJson('{\n  // note\n  "a": 1\n}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.hint).toMatch(/Comments/i);
  });

  it('measures nodes, keys and depth', () => {
    expect(measure({ a: { b: [1, 2] } })).toEqual({ nodes: 5, depth: 4, keys: 2 });
  });
});

describe('diff', () => {
  const diff = (a: unknown, b: unknown, over = {}) =>
    diffJson(a, b, { ...defaultDiffOptions, ...over });

  it('reports added, removed and changed paths', () => {
    const changes = diff({ name: 'Ada', legacy: 1 }, { name: 'Grace', email: 'g@x.com' });
    expect(changes).toEqual([
      { kind: 'changed', path: '.name', before: 'Ada', after: 'Grace' },
      { kind: 'removed', path: '.legacy', before: 1 },
      { kind: 'added', path: '.email', after: 'g@x.com' },
    ]);
  });

  it('ignores key order', () => {
    expect(diff({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('matches array elements by id when asked', () => {
    const before = [{ id: 1, v: 'a' }, { id: 2, v: 'b' }];
    const after = [{ id: 2, v: 'b' }, { id: 1, v: 'z' }];
    const changes = diff(before, after, { arrayStrategy: 'id' });
    expect(changes).toEqual([{ kind: 'changed', path: '[id=1].v', before: 'a', after: 'z' }]);
  });

  it('reports positional churn when comparing arrays by index', () => {
    const changes = diff([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }]);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('treats arrays as sets when order is ignored', () => {
    expect(diff(['a', 'b'], ['b', 'a'], { ignoreArrayOrder: true })).toEqual([]);
  });

  it('renders a readable report', () => {
    const out = renderDiff(diff({ a: 1 }, { a: 2 }));
    expect(out).toContain('~ $.a: 1 -> 2');
  });

  it('says so when there is no difference', () => {
    expect(renderDiff([])).toMatch(/No differences/);
  });
});

describe('jsonpath', () => {
  const doc = {
    store: {
      items: [
        { sku: 'A1', price: 5, tags: ['cheap'] },
        { sku: 'B2', price: 25, tags: ['premium', 'new'] },
        { sku: 'C3', price: 50 },
      ],
    },
  };
  const values = (path: string) => {
    const r = queryJsonPath(doc, path);
    if (!r.ok) throw new Error(r.error.message);
    return r.value.map((m) => m.value);
  };

  it('walks child paths', () => {
    expect(values('$.store.items[0].sku')).toEqual(['A1']);
  });

  it('expands wildcards', () => {
    expect(values('$.store.items[*].sku')).toEqual(['A1', 'B2', 'C3']);
  });

  it('supports recursive descent', () => {
    expect(values('$..sku')).toEqual(['A1', 'B2', 'C3']);
  });

  it('supports slices', () => {
    expect(values('$.store.items[0:2].sku')).toEqual(['A1', 'B2']);
  });

  it('supports negative indices', () => {
    expect(values('$.store.items[-1].sku')).toEqual(['C3']);
  });

  it('filters by numeric comparison', () => {
    expect(values('$.store.items[?(@.price > 10)].sku')).toEqual(['B2', 'C3']);
  });

  it('filters by existence', () => {
    expect(values('$.store.items[?(@.tags)].sku')).toEqual(['A1', 'B2']);
  });

  it('filters by regular expression', () => {
    expect(values('$.store.items[?(@.sku =~ ^B)].sku')).toEqual(['B2']);
  });

  it('reports the path of each match', () => {
    const r = queryJsonPath(doc, '$.store.items[1].sku');
    expect(r.ok && r.value[0]?.path).toBe('$.store.items[1].sku');
  });

  it('returns an error for an unparseable expression', () => {
    expect(parseJsonPath('$.').ok).toBe(false);
  });

  it('returns no matches rather than failing on a missing key', () => {
    expect(values('$.nope.deeper')).toEqual([]);
  });
});

describe('csv', () => {
  const csv = (value: unknown, over = {}) =>
    jsonToCsv(value, {
      ...defaultFlattenOptions,
      delimiter: ',',
      header: true,
      quoteAll: false,
      newline: '\n' as const,
      bom: false,
      ...over,
    });

  it('flattens nested objects into dotted columns', () => {
    const out = csv([{ id: 1, team: { name: 'Core' } }]);
    expect(out.csv).toBe('id,team.name\n1,Core\n');
  });

  it('takes the column union across rows', () => {
    const out = csv([{ a: 1 }, { b: 2 }]);
    expect(out.columns).toEqual(['a', 'b']);
    expect(out.csv).toBe('a,b\n1,\n,2\n');
  });

  it('escapes delimiters, quotes and newlines', () => {
    const out = csv([{ v: 'a,b' }, { v: 'say "hi"' }, { v: 'line\nbreak' }]);
    expect(out.csv).toContain('"a,b"');
    expect(out.csv).toContain('"say ""hi"""');
    expect(out.csv).toContain('"line\nbreak"');
  });

  it('unwraps a single-array envelope', () => {
    const out = csv({ data: [{ a: 1 }] });
    expect(out.rows).toBe(1);
    expect(out.warnings.join(' ')).toMatch(/"data" array/);
  });

  it('can encode arrays as a single JSON cell', () => {
    const out = csv([{ tags: ['a', 'b'] }], { arraysAsJson: true });
    expect(out.csv).toBe('tags\n"[""a"",""b""]"\n');
  });
});

describe('flatten', () => {
  it('round-trips nested objects', () => {
    const original = { user: { name: 'Ada', langs: ['en', 'fr'] } };
    const flat = flattenValue(original, defaultFlattenOptions);
    expect(flat).toEqual({ 'user.name': 'Ada', 'user.langs[0]': 'en', 'user.langs[1]': 'fr' });
    expect(unflattenValue(flat, '.')).toEqual(original);
  });

  it('encodes deep values as JSON past the depth limit', () => {
    const flat = flattenValue({ a: { b: { c: 1 } } }, { ...defaultFlattenOptions, maxDepth: 2 });
    expect(flat['a.b']).toBe('{"c":1}');
  });
});

describe('redaction', () => {
  const redact = (value: unknown, over = {}) =>
    redactJson(value, { ...defaultRedactOptions, ...over });

  it('flags a sensitive key name', () => {
    const { findings } = redact({ password: 'hunter2' });
    expect(findings[0]?.kind).toBe('secret');
    expect(findings[0]?.confidence).toBe('high');
  });

  it('flags a JWT by shape regardless of key name', () => {
    const { findings } = redact({ blob: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef' });
    expect(findings[0]?.reason).toMatch(/JSON Web Token/);
  });

  it('flags an AWS access key id', () => {
    const { findings } = redact({ v: 'AKIAIOSFODNN7EXAMPLE' });
    expect(findings[0]?.reason).toMatch(/AWS/);
  });

  it('flags a connection string with an inline password', () => {
    const { findings } = redact({ url: 'postgres://user:s3cret@db.internal:5432/app' });
    expect(findings[0]?.reason).toMatch(/connection string/);
  });

  it('only flags card numbers that pass Luhn', () => {
    expect(redact({ card: '4242424242424242' }).findings).toHaveLength(1);
    expect(redact({ card: '4242424242424243' }).findings).toHaveLength(0);
  });

  it('never puts the raw value in the finding', () => {
    const { findings } = redact({ password: 'hunter2secret' });
    expect(findings[0]?.preview).not.toContain('hunter2secret');
  });

  it('masks in place by default, preserving structure', () => {
    const { value } = redact({ user: { password: 'hunter2' } });
    // keepChars defaults to 2, so the ends survive and the middle is starred out.
    expect((value as any).user.password).toBe('hu***r2');
    expect(Object.keys((value as any).user)).toEqual(['password']);
  });

  it('reports the path of a nested finding', () => {
    const { findings } = redact({ session: { auth_token: 'abcdef123456' } });
    expect(findings[0]?.path).toBe('$.session.auth_token');
  });

  it('removes the key entirely when asked', () => {
    const { value } = redact({ a: 1, password: 'x' }, { style: 'remove' });
    expect(Object.keys(value as object)).toEqual(['a']);
  });

  it('labels by type when asked', () => {
    const { value } = redact({ email: 'ada@example.com' }, { style: 'label' });
    expect((value as any).email).toBe('<email>');
  });

  it('honours extra key names', () => {
    expect(redact({ account_no: '12345' }).findings).toHaveLength(0);
    expect(redact({ account_no: '12345' }, { extraKeys: 'account_no' }).findings).toHaveLength(1);
  });

  it('leaves ordinary data alone', () => {
    const { findings } = redact({ name: 'Ada', count: 42, active: true });
    expect(findings).toHaveLength(0);
  });
});

describe('yaml', () => {
  it('round-trips through YAML', () => {
    const original = { name: 'ada', roles: ['admin', 'editor'], nested: { n: 1 } };
    const yaml = jsonToYaml(original, defaultYamlOptions);
    expect(yaml.ok).toBe(true);
    if (!yaml.ok) return;
    const back = yamlToJson(yaml.value);
    expect(back.ok && back.value).toEqual(original);
  });

  it('reports the location of invalid YAML', () => {
    const result = yamlToJson('a: 1\n\tb: 2\n');
    expect(result.ok).toBe(false);
  });
});
