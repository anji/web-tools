/**
 * The shared shape that JSON -> TypeScript, JSON -> Zod and JSON -> JSON Schema
 * are all emitted from. Inferring once and emitting three ways is what keeps the
 * three tools consistent with each other; users notice immediately when the
 * TypeScript output and the Zod output disagree about whether a field is
 * optional.
 */

export type StringFormat = 'date-time' | 'date' | 'email' | 'uri' | 'uuid' | 'ipv4';

export interface StringSchema {
  kind: 'string';
  format?: StringFormat;
  /** Distinct observed values, used for literal-union / enum detection. */
  values?: Set<string>;
  /** Set once we have seen more distinct values than are worth enumerating. */
  tooManyValues?: boolean;
  /** How many string samples contributed, so emitters can judge confidence. */
  samples: number;
}

export interface ObjectField {
  schema: Schema;
  /** True when at least one observed object lacked this key. */
  optional: boolean;
}

export type Schema =
  | { kind: 'unknown' }
  | { kind: 'null' }
  | { kind: 'boolean' }
  | { kind: 'number'; integer: boolean }
  | StringSchema
  | { kind: 'array'; items: Schema }
  | { kind: 'object'; fields: Map<string, ObjectField> }
  | { kind: 'union'; options: Schema[] };

/** Cap on how many distinct string values we track before giving up on enums. */
const MAX_TRACKED_VALUES = 24;

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;
const URI = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

function detectFormat(value: string): StringFormat | undefined {
  if (UUID.test(value)) return 'uuid';
  if (ISO_DATE_TIME.test(value)) return 'date-time';
  if (ISO_DATE.test(value)) return 'date';
  if (EMAIL.test(value)) return 'email';
  if (URI.test(value)) return 'uri';
  if (IPV4.test(value) && value.split('.').every((p) => Number(p) <= 255)) return 'ipv4';
  return undefined;
}

export function inferSchema(value: unknown): Schema {
  if (value === null) return { kind: 'null' };
  switch (typeof value) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'number':
      return { kind: 'number', integer: Number.isInteger(value) };
    case 'string': {
      const format = detectFormat(value);
      const s: StringSchema = { kind: 'string', values: new Set([value]), samples: 1 };
      if (format) s.format = format;
      return s;
    }
    default:
      break;
  }

  if (Array.isArray(value)) {
    // Merging every element (not just the first) is the difference between
    // handling a real API response and handling a toy one.
    let items: Schema = { kind: 'unknown' };
    for (const el of value) items = mergeSchemas(items, inferSchema(el));
    return { kind: 'array', items };
  }

  if (typeof value === 'object') {
    const fields = new Map<string, ObjectField>();
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      fields.set(key, { schema: inferSchema(v), optional: false });
    }
    return { kind: 'object', fields };
  }

  return { kind: 'unknown' };
}

/** Structural identity, used for dedupe and for union member comparison. */
export function schemaKey(schema: Schema): string {
  switch (schema.kind) {
    case 'unknown':
    case 'null':
    case 'boolean':
      return schema.kind;
    case 'number':
      return schema.integer ? 'int' : 'number';
    case 'string':
      return schema.format ? `string:${schema.format}` : 'string';
    case 'array':
      return `array<${schemaKey(schema.items)}>`;
    case 'object': {
      const parts = [...schema.fields.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, f]) => `${k}${f.optional ? '?' : ''}:${schemaKey(f.schema)}`);
      return `{${parts.join(',')}}`;
    }
    case 'union':
      return `(${schema.options.map(schemaKey).sort().join('|')})`;
  }
}

export function mergeSchemas(a: Schema, b: Schema): Schema {
  if (a.kind === 'unknown') return b;
  if (b.kind === 'unknown') return a;

  if (a.kind === 'object' && b.kind === 'object') {
    const fields = new Map<string, ObjectField>();
    for (const [key, fa] of a.fields) {
      const fb = b.fields.get(key);
      fields.set(
        key,
        fb
          ? { schema: mergeSchemas(fa.schema, fb.schema), optional: fa.optional || fb.optional }
          : // Present in a, absent in b: every later object must treat it as optional.
            { schema: fa.schema, optional: true },
      );
    }
    for (const [key, fb] of b.fields) {
      if (!a.fields.has(key)) fields.set(key, { schema: fb.schema, optional: true });
    }
    return { kind: 'object', fields };
  }

  if (a.kind === 'array' && b.kind === 'array') {
    return { kind: 'array', items: mergeSchemas(a.items, b.items) };
  }

  if (a.kind === 'number' && b.kind === 'number') {
    return { kind: 'number', integer: a.integer && b.integer };
  }

  if (a.kind === 'string' && b.kind === 'string') {
    const merged: StringSchema = { kind: 'string', samples: a.samples + b.samples };
    if (a.format && a.format === b.format) merged.format = a.format;

    if (a.tooManyValues || b.tooManyValues) {
      merged.tooManyValues = true;
    } else {
      const values = new Set<string>(a.values);
      for (const v of b.values ?? []) values.add(v);
      if (values.size > MAX_TRACKED_VALUES) merged.tooManyValues = true;
      else merged.values = values;
    }
    return merged;
  }

  if (schemaKey(a) === schemaKey(b)) return a;

  return unionOf([a, b]);
}

/** Flattens nested unions and drops structural duplicates. */
export function unionOf(schemas: readonly Schema[]): Schema {
  const flat: Schema[] = [];
  const seen = new Set<string>();

  const push = (s: Schema): void => {
    if (s.kind === 'union') {
      for (const o of s.options) push(o);
      return;
    }
    if (s.kind === 'unknown') return;
    const key = schemaKey(s);
    if (seen.has(key)) return;
    seen.add(key);
    flat.push(s);
  };

  for (const s of schemas) push(s);

  if (flat.length === 0) return { kind: 'unknown' };
  if (flat.length === 1) return flat[0]!;
  return { kind: 'union', options: flat };
}

/** Splits `T | null` into its non-null part plus a nullability flag. */
export function splitNullable(schema: Schema): { schema: Schema; nullable: boolean } {
  if (schema.kind === 'null') return { schema: { kind: 'unknown' }, nullable: true };
  if (schema.kind !== 'union') return { schema, nullable: false };

  const nonNull = schema.options.filter((o) => o.kind !== 'null');
  if (nonNull.length === schema.options.length) return { schema, nullable: false };
  return { schema: unionOf(nonNull), nullable: true };
}
