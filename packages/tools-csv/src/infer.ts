import type { Schema, StringSchema, StringFormat, ObjectField } from '@tools/codegen';
import { unionOf } from '@tools/codegen';
import type { ParseResult } from './parse.js';
import { normaliseRow } from './parse.js';

/**
 * Turns parsed columns into the same Schema the language emitters consume, so
 * a CSV inherits every generator the JSON side already has.
 *
 * An empty cell becomes a union with null rather than an absent key: a column
 * always exists, it is the value that is missing. That distinction is what
 * makes the emitters produce *string in Go, Option<String> in Rust and str |
 * None in Python without any CSV-specific code.
 */

export interface InferOptions {
  /** Comma-separated tokens treated as missing, beyond the empty string. */
  nullTokens: string;
  detectNumbers: boolean;
  detectBooleans: boolean;
  detectDates: boolean;
  inferEnums: boolean;
}

export const defaultInferOptions: InferOptions = {
  nullTokens: 'NULL,null,N/A,NA,-',
  detectNumbers: true,
  detectBooleans: true,
  detectDates: true,
  inferEnums: true,
};

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;
const URI = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/;
const TRUE = new Set(['true', 'TRUE', 'True']);
const FALSE = new Set(['false', 'FALSE', 'False']);

const MAX_TRACKED_VALUES = 24;

/**
 * A value that merely looks numeric is not always a number. A leading zero
 * means the zero carries meaning -- a zip code, a product code, a phone
 * number -- and parsing it loses data silently. The same goes for integers
 * beyond IEEE-754's exact range, which is where snowflake ids and long account
 * numbers live.
 */
export function isSafeInteger(text: string): boolean {
  if (!INTEGER.test(text)) return false;
  const digits = text.replace('-', '');
  if (digits.length > 1 && digits.startsWith('0')) return false;
  return Number.isSafeInteger(Number(text));
}

function isDecimal(text: string): boolean {
  if (!DECIMAL.test(text)) return false;
  // The pattern also matches a bare integer. One reaching here is an integer
  // isSafeInteger already rejected -- a leading zero, or a magnitude beyond
  // exact representation. Calling it a float loses exactly the same digits, so
  // it has to stay a string.
  if (INTEGER.test(text)) return isSafeInteger(text);
  const digits = text.replace('-', '');
  // 0.5 is fine; 01.5 is a formatted string.
  if (/^0\d/.test(digits)) return false;
  return Number.isFinite(Number(text));
}

function detectFormat(values: readonly string[]): StringFormat | undefined {
  const test = (re: RegExp) => values.every((v) => re.test(v));
  if (test(UUID)) return 'uuid';
  if (test(ISO_DATE_TIME)) return 'date-time';
  if (test(ISO_DATE)) return 'date';
  if (test(EMAIL)) return 'email';
  if (test(URI)) return 'uri';
  return undefined;
}

export interface ColumnInference {
  name: string;
  schema: Schema;
  nullable: boolean;
  /** Cells that were empty or a null token. */
  missing: number;
  total: number;
}

export function inferColumn(
  name: string,
  rawValues: readonly string[],
  options: InferOptions,
): ColumnInference {
  const nullTokens = new Set(
    options.nullTokens.split(',').map((t) => t.trim()).filter((t) => t.length > 0),
  );

  const present: string[] = [];
  let missing = 0;
  for (const raw of rawValues) {
    const value = raw.trim();
    if (value === '' || nullTokens.has(value)) missing++;
    else present.push(value);
  }

  let base: Schema;

  if (present.length === 0) {
    base = { kind: 'unknown' };
  } else if (options.detectBooleans && present.every((v) => TRUE.has(v) || FALSE.has(v))) {
    // Deliberately not 0/1: that is indistinguishable from an integer column.
    base = { kind: 'boolean' };
  } else if (options.detectNumbers && present.every(isSafeInteger)) {
    base = { kind: 'number', integer: true };
  } else if (options.detectNumbers && present.every((v) => isSafeInteger(v) || isDecimal(v))) {
    base = { kind: 'number', integer: false };
  } else {
    const distinct = new Set<string>();
    let tooMany = false;
    for (const v of present) {
      if (distinct.size >= MAX_TRACKED_VALUES && !distinct.has(v)) {
        tooMany = true;
        break;
      }
      distinct.add(v);
    }

    const format = options.detectDates ? detectFormat(present) : detectFormat(present);
    const stringSchema: StringSchema = { kind: 'string', samples: present.length };
    if (format && (options.detectDates || (format !== 'date' && format !== 'date-time'))) {
      stringSchema.format = format;
    }
    if (options.inferEnums && !tooMany) stringSchema.values = distinct;
    else if (options.inferEnums) stringSchema.tooManyValues = true;
    base = stringSchema;
  }

  const nullable = missing > 0;
  return {
    name,
    // Union with null so the emitters produce their own idiomatic optionality.
    schema: nullable && base.kind !== 'unknown' ? unionOf([base, { kind: 'null' }]) : base,
    nullable,
    missing,
    total: rawValues.length,
  };
}

export function inferColumns(parsed: ParseResult, options: InferOptions): ColumnInference[] {
  return parsed.headers.map((name, index) =>
    inferColumn(
      name,
      parsed.rows.map((row) => normaliseRow(row, parsed.headers.length)[index] ?? ''),
      options,
    ),
  );
}

/** The whole table as an array-of-rows schema, ready for any emitter. */
export function inferTableSchema(columns: readonly ColumnInference[]): Schema {
  const fields = new Map<string, ObjectField>();
  for (const column of columns) {
    fields.set(column.name, { schema: column.schema, optional: false });
  }
  return { kind: 'array', items: { kind: 'object', fields } };
}

/** Converts a row to real JS values using the inferred column types. */
export function coerceRow(
  row: readonly string[],
  columns: readonly ColumnInference[],
  options: InferOptions,
): Record<string, unknown> {
  const nullTokens = new Set(
    options.nullTokens.split(',').map((t) => t.trim()).filter((t) => t.length > 0),
  );
  const out: Record<string, unknown> = {};
  const normalised = normaliseRow(row, columns.length);

  for (const [index, column] of columns.entries()) {
    const raw = (normalised[index] ?? '').trim();
    if (raw === '' || nullTokens.has(raw)) {
      out[column.name] = null;
      continue;
    }
    const bare = column.schema.kind === 'union'
      ? column.schema.options.find((o) => o.kind !== 'null') ?? column.schema
      : column.schema;

    switch (bare.kind) {
      case 'boolean':
        out[column.name] = TRUE.has(raw);
        break;
      case 'number':
        out[column.name] = Number(raw);
        break;
      default:
        out[column.name] = normalised[index] ?? '';
    }
  }
  return out;
}
