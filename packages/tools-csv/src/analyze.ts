import { splitNullable } from '@tools/codegen';
import type { ColumnInference } from './infer.js';
import type { ParseResult } from './parse.js';
import { normaliseRow } from './parse.js';

export interface ColumnProfile {
  name: string;
  type: string;
  nullable: boolean;
  missing: number;
  distinct: number;
  /** Sample of distinct values, never the whole column. */
  examples: string[];
  min?: string;
  max?: string;
  minLength?: number;
  maxLength?: number;
}

const describeType = (column: ColumnInference): string => {
  const { schema: bare } = splitNullable(column.schema);
  switch (bare.kind) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return bare.integer ? 'integer' : 'decimal';
    case 'string':
      return bare.format ? `string (${bare.format})` : 'string';
    case 'unknown':
      return 'empty';
    default:
      return 'mixed';
  }
};

export function profileColumns(
  parsed: ParseResult,
  columns: readonly ColumnInference[],
  nullTokens: ReadonlySet<string>,
): ColumnProfile[] {
  return columns.map((column, index) => {
    const values = parsed.rows
      .map((row) => (normaliseRow(row, columns.length)[index] ?? '').trim())
      .filter((v) => v !== '' && !nullTokens.has(v));

    const distinct = new Set(values);
    const { schema: bare } = splitNullable(column.schema);
    const profile: ColumnProfile = {
      name: column.name,
      type: describeType(column),
      nullable: column.nullable,
      missing: column.missing,
      distinct: distinct.size,
      examples: [...distinct].slice(0, 3),
    };

    if (values.length > 0) {
      if (bare.kind === 'number') {
        const numbers = values.map(Number).filter(Number.isFinite);
        if (numbers.length > 0) {
          profile.min = String(Math.min(...numbers));
          profile.max = String(Math.max(...numbers));
        }
      } else {
        const lengths = values.map((v) => v.length);
        profile.minLength = Math.min(...lengths);
        profile.maxLength = Math.max(...lengths);
        const sorted = [...distinct].sort();
        profile.min = sorted[0];
        profile.max = sorted[sorted.length - 1];
      }
    }
    return profile;
  });
}

export function findDuplicateRows(parsed: ParseResult): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of parsed.rows) {
    const key = JSON.stringify(normaliseRow(row, parsed.headers.length));
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return duplicates;
}

export function renderProfile(
  parsed: ParseResult,
  profiles: readonly ColumnProfile[],
  duplicates: number,
): string {
  const lines: string[] = [
    `${parsed.rowCount.toLocaleString()} rows × ${parsed.headers.length} columns`,
    `delimiter: ${parsed.delimiter === '\t' ? 'tab' : parsed.delimiter}   header row: ${parsed.usedHeader ? 'yes' : 'no'}${parsed.hadBom ? '   BOM: stripped' : ''}`,
    '',
  ];

  if (parsed.truncated) {
    lines.push('Only the first rows were read; raise the row limit to profile the whole file.', '');
  }
  if (duplicates > 0) {
    lines.push(`${duplicates} duplicate row${duplicates === 1 ? '' : 's'}.`, '');
  }
  if (parsed.raggedRows.length > 0) {
    const preview = parsed.raggedRows
      .slice(0, 5)
      .map((r) => `line ${r.line} has ${r.got} of ${r.expected}`)
      .join(', ');
    lines.push(
      `${parsed.raggedRows.length} row${parsed.raggedRows.length === 1 ? '' : 's'} with the wrong field count: ${preview}${parsed.raggedRows.length > 5 ? ', …' : ''}`,
      '',
    );
  }

  for (const p of profiles) {
    lines.push(`${p.name}`);
    lines.push(`    type      ${p.type}${p.nullable ? ' (nullable)' : ''}`);
    lines.push(
      `    missing   ${p.missing}${parsed.rowCount > 0 ? ` (${((p.missing / parsed.rowCount) * 100).toFixed(1)}%)` : ''}`,
    );
    lines.push(`    distinct  ${p.distinct}`);
    if (p.min !== undefined) lines.push(`    range     ${p.min} … ${p.max}`);
    if (p.maxLength !== undefined) lines.push(`    length    ${p.minLength} … ${p.maxLength}`);
    if (p.examples.length > 0) lines.push(`    examples  ${p.examples.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}
