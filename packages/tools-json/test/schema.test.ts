import { describe, it, expect } from 'vitest';
import { inferSchema, mergeSchemas, splitNullable, schemaKey } from '../src/schema.js';
import { emitTypeScript, defaultTypeScriptOptions } from '../src/emit-typescript.js';
import { emitZod, defaultZodOptions } from '../src/emit-zod.js';
import { emitJsonSchema, defaultJsonSchemaOptions } from '../src/emit-json-schema.js';

const ts = (value: unknown, over: Partial<typeof defaultTypeScriptOptions> = {}) =>
  emitTypeScript(inferSchema(value), { ...defaultTypeScriptOptions, ...over }).code;

describe('type inference', () => {
  it('infers a flat object', () => {
    expect(ts({ id: 1, name: 'Ada', active: true })).toContain(
      'export interface Root {\n  id: number;\n  name: string;\n  active: boolean;\n}',
    );
  });

  it('marks a field optional when some array elements omit it', () => {
    const code = ts([{ id: 1, nickname: 'Ada' }, { id: 2 }]);
    expect(code).toContain('id: number;');
    expect(code).toContain('nickname?: string;');
  });

  it('marks a field nullable when it is sometimes null', () => {
    const code = ts([{ bio: 'hello' }, { bio: null }]);
    expect(code).toContain('bio: string | null;');
  });

  it('handles a field that is both absent and null', () => {
    const code = ts([{ a: 1, b: 'x' }, { a: 2, b: null }, { a: 3 }]);
    expect(code).toContain('b?: string | null;');
  });

  it('names nested object types from their key, singularising arrays', () => {
    const code = ts({ users: [{ name: 'Ada', address: { city: 'London' } }] });
    expect(code).toContain('interface User {');
    expect(code).toContain('interface Address {');
    expect(code).toContain('users: User[];');
    expect(code).toContain('address: Address;');
  });

  it('collapses structurally identical shapes onto one type', () => {
    const code = ts({
      sender: { id: 1, label: 'a' },
      receiver: { id: 2, label: 'b' },
    });
    // Both fields share a shape, so only one interface is generated for them.
    const interfaces = code.match(/interface \w+/g) ?? [];
    expect(interfaces).toHaveLength(2); // Root + the shared shape
  });

  it('widens integers to number when a float appears', () => {
    const schema = mergeSchemas(inferSchema(1), inferSchema(1.5));
    expect(schema).toEqual({ kind: 'number', integer: false });
  });

  it('quotes keys that are not valid identifiers', () => {
    const result = emitTypeScript(inferSchema({ 'content-type': 'json' }), defaultTypeScriptOptions);
    expect(result.code).toContain('"content-type": string;');
    expect(result.warnings.join(' ')).toMatch(/not a valid TypeScript identifier/);
  });

  it('leaves an empty array as unknown[] rather than guessing', () => {
    expect(ts({ tags: [] })).toContain('tags: unknown[];');
  });

  it('unions mixed array element types', () => {
    expect(ts({ mixed: [1, 'two'] })).toContain('mixed: (number | string)[];');
  });

  it('emits a type alias when the root is an array of primitives', () => {
    expect(ts([1, 2, 3])).toContain('type Root = number[];');
  });
});

describe('literal union inference', () => {
  it('detects an enum when values repeat', () => {
    const rows = [
      { status: 'active' }, { status: 'active' },
      { status: 'banned' }, { status: 'banned' },
    ];
    expect(ts(rows)).toContain('status: "active" | "banned";');
  });

  it('does not turn a single sample into a literal', () => {
    expect(ts({ name: 'Ada' })).toContain('name: string;');
  });

  it('does not treat free text as an enum', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ note: `note ${i}` }));
    expect(ts(rows)).toContain('note: string;');
  });

  it('can be disabled', () => {
    const rows = [{ s: 'a' }, { s: 'a' }, { s: 'b' }, { s: 'b' }];
    expect(ts(rows, { inferLiteralUnions: false })).toContain('s: string;');
  });
});

describe('zod emitter', () => {
  const zod = (value: unknown, over: Partial<typeof defaultZodOptions> = {}) =>
    emitZod(inferSchema(value), { ...defaultZodOptions, ...over }).code;

  it('emits optional and nullable distinctly', () => {
    const code = zod([{ a: 1, b: 'x' }, { a: 2, b: null }, { a: 3 }]);
    expect(code).toContain('a: z.number().int()');
    expect(code).toMatch(/b: z\.string\(\)\.nullable\(\)\.optional\(\)/);
  });

  it('applies Zod 4 top-level format schemas', () => {
    const code = zod({ email: 'ada@example.com', id: '3f0c2e1a-1111-4222-8333-444455556666' });
    expect(code).toContain('z.email()');
    expect(code).toContain('z.uuid()');
  });

  it('applies Zod 3 chained formats when targeting v3', () => {
    const code = zod({ email: 'ada@example.com' }, { version: 'v3' });
    expect(code).toContain('z.string().email()');
  });

  it('references nested schemas by const, declared before use', () => {
    const code = zod({ team: { name: 'Core' } });
    expect(code).toContain('export const TeamSchema = z.object({');
    expect(code.indexOf('export const TeamSchema')).toBeLessThan(code.indexOf('team: TeamSchema'));
  });

  it('emits z.enum for detected enums', () => {
    const rows = [{ s: 'a' }, { s: 'a' }, { s: 'b' }, { s: 'b' }];
    expect(zod(rows)).toContain('z.enum(["a", "b"])');
  });
});

describe('json schema emitter', () => {
  const schema = (value: unknown, over: Partial<typeof defaultJsonSchemaOptions> = {}) =>
    JSON.parse(emitJsonSchema(inferSchema(value), { ...defaultJsonSchemaOptions, ...over }).code);

  it('lists only non-optional keys as required', () => {
    const doc = schema([{ a: 1, b: 2 }, { a: 3 }]);
    expect(doc.$defs.Root.required).toEqual(['a']);
  });

  it('hoists nested shapes into $defs and references them', () => {
    const doc = schema({ team: { name: 'Core' } });
    expect(doc.$defs.Team).toBeDefined();
    expect(doc.$defs.Root.properties.team.$ref).toBe('#/$defs/Team');
  });

  it('uses definitions and anyOf for nullable refs under draft-07', () => {
    const doc = schema([{ team: { name: 'Core' } }, { team: null }], { draft: 'draft-07' });
    expect(doc.definitions).toBeDefined();
    expect(doc.definitions.Root.properties.team.anyOf).toBeDefined();
  });

  it('expresses a nullable primitive as a type array', () => {
    const doc = schema([{ bio: 'x' }, { bio: null }]);
    expect(doc.$defs.Root.properties.bio.type).toEqual(['string', 'null']);
  });

  it('carries detected string formats through', () => {
    const doc = schema({ when: '2026-08-25T12:00:00Z' });
    expect(doc.$defs.Root.properties.when.format).toBe('date-time');
  });
});

describe('splitNullable', () => {
  it('separates null out of a union', () => {
    const { schema, nullable } = splitNullable(
      mergeSchemas(inferSchema('x'), inferSchema(null)),
    );
    expect(nullable).toBe(true);
    expect(schemaKey(schema)).toBe('string');
  });
});
