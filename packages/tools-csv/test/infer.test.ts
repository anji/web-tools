import { describe, it, expect } from 'vitest';
import { parseCsv, defaultParseOptions } from '../src/parse.js';
import { inferColumn, inferColumns, inferTableSchema, coerceRow, defaultInferOptions, isSafeInteger } from '../src/infer.js';
import { toSql, defaultSqlOptions } from '../src/to-sql.js';
import { profileColumns, findDuplicateRows } from '../src/analyze.js';
import { csvTools } from '../src/tools.js';
import { defaultOptions } from '@tools/core';
import { emitTypeScript, defaultTypeScriptOptions, emitGo, defaultGoOptions,
         emitRust, defaultRustOptions, emitPython, defaultPythonOptions, splitNullable } from '@tools/codegen';

const col = (values: string[], over = {}) =>
  inferColumn('c', values, { ...defaultInferOptions, ...over });
const kindOf = (values: string[], over = {}) => splitNullable(col(values, over).schema).schema.kind;

describe('column type inference', () => {
  it('detects integers, decimals and booleans', () => {
    expect(kindOf(['1', '2', '3'])).toBe('number');
    expect(kindOf(['1.5', '2.25'])).toBe('number');
    expect(kindOf(['true', 'false'])).toBe('boolean');
  });

  it('keeps leading zeros as strings', () => {
    // 01234 parsed as a number is 1234, and the zip code is gone.
    expect(kindOf(['01234', '00501', '90210'])).toBe('string');
    expect(isSafeInteger('01234')).toBe(false);
    expect(isSafeInteger('0')).toBe(true);
  });

  it('keeps integers beyond exact representation as strings', () => {
    // Number('9007199254740993') is 9007199254740992 -- the value is already
    // wrong before anything downstream sees it, and float64 loses it too.
    expect(kindOf(['9007199254740993', '9007199254740994'])).toBe('string');
    expect(kindOf(['1', '9007199254740993'])).toBe('string');
  });

  it('does not treat 0 and 1 as booleans', () => {
    // Indistinguishable from an integer column, and guessing wrong is worse
    // than leaving it a number.
    expect(kindOf(['0', '1', '1', '0'])).toBe('number');
  });

  it('marks a column with blanks as nullable', () => {
    const c = col(['1', '', '3']);
    expect(c.nullable).toBe(true);
    expect(c.missing).toBe(1);
    expect(splitNullable(c.schema).nullable).toBe(true);
  });

  it('honours configurable null tokens', () => {
    expect(col(['1', 'N/A', '3']).nullable).toBe(true);
    expect(col(['1', 'N/A', '3'], { nullTokens: '' }).nullable).toBe(false);
    expect(kindOf(['1', 'N/A', '3'], { nullTokens: '' })).toBe('string');
  });

  it('detects formats', () => {
    const dt = splitNullable(col(['2026-01-02T03:04:05Z', '2026-02-02T03:04:05Z']).schema).schema;
    expect(dt.kind === 'string' && dt.format).toBe('date-time');
    const id = splitNullable(col(['3f0c2e1a-1111-4222-8333-444455556666']).schema).schema;
    expect(id.kind === 'string' && id.format).toBe('uuid');
  });

  it('treats an all-empty column as unknown rather than guessing', () => {
    expect(col(['', '', '']).schema.kind).toBe('unknown');
  });

  it('mixed content falls back to string', () => {
    expect(kindOf(['1', 'two', '3'])).toBe('string');
  });
});

describe('inherited code generation', () => {
  const csv = `id,zip,score,active,status,notes
1,01234,90.5,true,active,
2,00501,88,false,archived,hi
3,90210,,true,active,there
4,10001,75.25,false,archived,`;
  const parsed = (parseCsv(csv, defaultParseOptions) as any).value;
  const schema = inferTableSchema(inferColumns(parsed, defaultInferOptions));

  it('produces TypeScript with nullability and enums', () => {
    const code = emitTypeScript(schema, { ...defaultTypeScriptOptions, rootName: 'Rows' }).code;
    expect(code).toContain('zip: string;');
    expect(code).toContain('score: number | null;');
    expect(code).toContain('status: "active" | "archived";');
    expect(code).toContain('type Rows = Row[];');
  });

  it('produces Go with pointers for nullable columns', () => {
    const code = emitGo(schema, { ...defaultGoOptions, rootName: 'Rows' }).code;
    expect(code).toContain('*float64');
    // gofmt column padding depends on the widest field, so match loosely.
    expect(code).toMatch(/Zip\s+string/);
  });

  it('produces Rust with Option for nullable columns', () => {
    expect(emitRust(schema, { ...defaultRustOptions, rootName: 'Rows' }).code)
      .toContain('pub score: Option<f64>');
  });

  it('produces Python with | None for nullable columns', () => {
    expect(emitPython(schema, { ...defaultPythonOptions, rootName: 'Rows' }).code)
      .toContain('score: float | None');
  });
});

describe('coercion', () => {
  it('converts cells to real values using the inferred types', () => {
    const parsed = (parseCsv('n,f,b,s\n1,1.5,true,x', defaultParseOptions) as any).value;
    const columns = inferColumns(parsed, defaultInferOptions);
    expect(coerceRow(parsed.rows[0], columns, defaultInferOptions)).toEqual({
      n: 1, f: 1.5, b: true, s: 'x',
    });
  });

  it('emits null for a missing cell', () => {
    const parsed = (parseCsv('a,b\n1,\n2,x', defaultParseOptions) as any).value;
    const columns = inferColumns(parsed, defaultInferOptions);
    expect(coerceRow(parsed.rows[0], columns, defaultInferOptions).b).toBeNull();
  });
});

describe('SQL generation', () => {
  const csv = `id,name,score,active,created
1,Ada,90.5,true,2026-01-02T03:04:05Z
2,O'Brien,,false,2026-02-02T03:04:05Z`;
  const parsed = (parseCsv(csv, defaultParseOptions) as any).value;
  const columns = inferColumns(parsed, defaultInferOptions);
  const sql = (over = {}) =>
    toSql(columns, parsed.rows, new Set(['NULL', 'N/A']), { ...defaultSqlOptions, ...over }).sql;

  it('maps types per dialect', () => {
    expect(sql({ dialect: 'postgres' })).toContain('"score" DOUBLE PRECISION');
    expect(sql({ dialect: 'postgres' })).toContain('"created" TIMESTAMPTZ');
    expect(sql({ dialect: 'mysql' })).toContain('`created` DATETIME');
    expect(sql({ dialect: 'sqlite' })).toContain('"id" INTEGER');
  });

  it('applies NOT NULL only where the data has no gaps', () => {
    const out = sql();
    expect(out).toContain('"id" BIGINT NOT NULL');
    expect(out).toContain('"score" DOUBLE PRECISION,');
  });

  it('escapes single quotes rather than breaking the statement', () => {
    expect(sql()).toContain("'O''Brien'");
  });

  it('writes NULL unquoted for missing values', () => {
    expect(sql()).toMatch(/,\s*NULL,/);
  });

  it('writes booleans in each dialect form', () => {
    expect(sql({ dialect: 'postgres' })).toContain('TRUE');
    expect(sql({ dialect: 'mysql' })).toMatch(/\(1, /);
  });

  it('quotes identifiers per dialect', () => {
    expect(sql({ dialect: 'mysql', tableName: 'my table' })).toContain('`my table`');
    expect(sql({ dialect: 'postgres', tableName: 'my table' })).toContain('"my table"');
  });

  it('batches inserts', () => {
    const many = Array.from({ length: 250 }, (_, i) => `${i},n,1,true,2026-01-02T03:04:05Z`).join('\n');
    const p = (parseCsv('id,name,score,active,created\n' + many, defaultParseOptions) as any).value;
    const result = toSql(inferColumns(p, defaultInferOptions), p.rows, new Set(), {
      ...defaultSqlOptions, batchSize: 100,
    });
    expect(result.statements).toBe(4); // create + 3 insert batches
  });
});

describe('profiling', () => {
  it('reports type, missing and distinct per column', () => {
    const parsed = (parseCsv('a,b\n1,x\n2,\n3,x', defaultParseOptions) as any).value;
    const columns = inferColumns(parsed, defaultInferOptions);
    const profiles = profileColumns(parsed, columns, new Set());
    expect(profiles[0]?.type).toBe('integer');
    expect(profiles[1]?.missing).toBe(1);
    expect(profiles[1]?.distinct).toBe(1);
  });

  it('counts duplicate rows', () => {
    const parsed = (parseCsv('a\n1\n1\n2', defaultParseOptions) as any).value;
    expect(findDuplicateRows(parsed)).toBe(1);
  });
});

describe('row type naming', () => {
  const tool = csvTools.find((t) => t.id === 'csv-to-code')!;
  const run = (over: Record<string, unknown> = {}) =>
    tool.run(['id,name\n1,Ada\n2,Grace'], { ...defaultOptions(tool), ...over } as any);

  it('names the struct what the user asked for, not <name>Item', () => {
    const result = run({ rootName: 'Row', language: 'go' });
    expect(result.ok && result.value.content).toContain('type Row struct');
    expect(result.ok && result.value.content).toContain('type Rows []Row');
    expect(result.ok && result.value.content).not.toContain('RowItem');
  });

  it('does the same for TypeScript', () => {
    const result = run({ rootName: 'Customer', language: 'typescript' });
    expect(result.ok && result.value.content).toContain('interface Customer {');
    expect(result.ok && result.value.content).toContain('type Customers = Customer[];');
  });

  it('does not double-pluralise a name that is already plural', () => {
    const result = run({ rootName: 'Users', language: 'typescript' });
    expect(result.ok && result.value.content).toContain('interface User {');
    expect(result.ok && result.value.content).not.toContain('Userss');
  });
});
