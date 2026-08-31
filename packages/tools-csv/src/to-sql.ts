import type { Schema } from '@tools/codegen';
import { splitNullable } from '@tools/codegen';
import type { ColumnInference } from './infer.js';
import { normaliseRow } from './parse.js';

export type Dialect = 'postgres' | 'mysql' | 'sqlite';

export interface SqlOptions {
  dialect: Dialect;
  tableName: string;
  createTable: boolean;
  insertRows: boolean;
  /** Rows per INSERT statement. */
  batchSize: number;
  /** NOT NULL on columns where no cell was empty. */
  inferNotNull: boolean;
  dropIfExists: boolean;
}

export const defaultSqlOptions: SqlOptions = {
  dialect: 'postgres',
  tableName: 'my_table',
  createTable: true,
  insertRows: true,
  batchSize: 100,
  inferNotNull: true,
  dropIfExists: false,
};

const quoteIdentifier = (name: string, dialect: Dialect): string =>
  dialect === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;

function columnType(schema: Schema, dialect: Dialect, maxLength: number): string {
  const { schema: bare } = splitNullable(schema);

  switch (bare.kind) {
    case 'boolean':
      return dialect === 'postgres' ? 'BOOLEAN' : dialect === 'mysql' ? 'TINYINT(1)' : 'INTEGER';
    case 'number':
      if (bare.integer) return dialect === 'sqlite' ? 'INTEGER' : 'BIGINT';
      return dialect === 'postgres' ? 'DOUBLE PRECISION' : dialect === 'mysql' ? 'DOUBLE' : 'REAL';
    case 'string':
      switch (bare.format) {
        case 'date-time':
          return dialect === 'postgres' ? 'TIMESTAMPTZ' : dialect === 'mysql' ? 'DATETIME' : 'TEXT';
        case 'date':
          return dialect === 'sqlite' ? 'TEXT' : 'DATE';
        case 'uuid':
          return dialect === 'postgres' ? 'UUID' : dialect === 'mysql' ? 'CHAR(36)' : 'TEXT';
        default:
          break;
      }
      // MySQL cannot index an unbounded TEXT the way it can a VARCHAR, so a
      // bounded column is worth emitting where the data supports one.
      if (dialect === 'mysql' && maxLength > 0 && maxLength <= 512) {
        return `VARCHAR(${Math.min(1024, Math.max(16, Math.ceil(maxLength * 1.5)))})`;
      }
      return 'TEXT';
    default:
      return dialect === 'postgres' ? 'JSONB' : 'TEXT';
  }
}

function literal(value: string | null, schema: Schema, dialect: Dialect): string {
  if (value === null) return 'NULL';
  const { schema: bare } = splitNullable(schema);

  if (bare.kind === 'boolean') {
    const isTrue = /^true$/i.test(value);
    return dialect === 'postgres' ? (isTrue ? 'TRUE' : 'FALSE') : isTrue ? '1' : '0';
  }
  if (bare.kind === 'number') return value;
  return `'${value.replace(/'/g, "''")}'`;
}

export interface SqlResult {
  sql: string;
  statements: number;
}

export function toSql(
  columns: readonly ColumnInference[],
  rows: readonly (readonly string[])[],
  nullTokens: ReadonlySet<string>,
  options: SqlOptions,
): SqlResult {
  const dialect = options.dialect;
  const table = quoteIdentifier(options.tableName || 'my_table', dialect);
  const parts: string[] = [];
  let statements = 0;

  const maxLengths = columns.map((_, index) =>
    rows.reduce((max, row) => Math.max(max, (normaliseRow(row, columns.length)[index] ?? '').length), 0),
  );

  if (options.dropIfExists) {
    parts.push(`DROP TABLE IF EXISTS ${table};`);
    statements++;
  }

  if (options.createTable) {
    const defs = columns.map((column, index) => {
      const type = columnType(column.schema, dialect, maxLengths[index] ?? 0);
      const notNull = options.inferNotNull && !column.nullable ? ' NOT NULL' : '';
      return `  ${quoteIdentifier(column.name, dialect)} ${type}${notNull}`;
    });
    parts.push(`CREATE TABLE ${table} (\n${defs.join(',\n')}\n);`);
    statements++;
  }

  if (options.insertRows && rows.length > 0) {
    const columnList = columns.map((c) => quoteIdentifier(c.name, dialect)).join(', ');
    const batchSize = Math.max(1, options.batchSize);

    for (let start = 0; start < rows.length; start += batchSize) {
      const batch = rows.slice(start, start + batchSize).map((row) => {
        const normalised = normaliseRow(row, columns.length);
        const values = columns.map((column, index) => {
          const raw = (normalised[index] ?? '').trim();
          const isNull = raw === '' || nullTokens.has(raw);
          return literal(isNull ? null : normalised[index] ?? '', column.schema, dialect);
        });
        return `  (${values.join(', ')})`;
      });
      parts.push(`INSERT INTO ${table} (${columnList}) VALUES\n${batch.join(',\n')};`);
      statements++;
    }
  }

  return { sql: parts.join('\n\n') + '\n', statements };
}
