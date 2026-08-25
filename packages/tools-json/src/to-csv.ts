import { flattenValue, type FlattenOptions } from './flatten.js';

export interface CsvOptions extends FlattenOptions {
  delimiter: string;
  /** Emit a header row of column names. */
  header: boolean;
  /** Quote every field, not just the ones that need it. */
  quoteAll: boolean;
  /** \n or \r\n. Excel prefers CRLF. */
  newline: '\n' | '\r\n';
  /** Prepend a UTF-8 BOM so Excel reads non-ASCII correctly. */
  bom: boolean;
}

export interface CsvResult {
  csv: string;
  columns: string[];
  rows: number;
  warnings: string[];
}

function csvEscape(value: unknown, delimiter: string, quoteAll: boolean): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const mustQuote =
    quoteAll || text.includes(delimiter) || text.includes('"') || /[\r\n]/.test(text);
  return mustQuote ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Accepts either a top-level array of records or a single object (rendered as a
 * one-row sheet). Columns are the union of every row's keys in first-seen order,
 * because API responses routinely omit null-valued fields on some records.
 */
export function jsonToCsv(value: unknown, options: CsvOptions): CsvResult {
  const warnings: string[] = [];
  let records: unknown[];

  if (Array.isArray(value)) {
    records = value;
  } else if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    // A common wrapper shape: { data: [...] } or { results: [...] }.
    const arrayEntry = entries.find(([, v]) => Array.isArray(v));
    if (arrayEntry && entries.length <= 4) {
      records = arrayEntry[1] as unknown[];
      warnings.push(`Used the "${arrayEntry[0]}" array as the row source.`);
    } else {
      records = [value];
    }
  } else {
    records = [value];
  }

  const columns: string[] = [];
  const seen = new Set<string>();
  const flatRows = records.map((record) => {
    const flat = flattenValue(record, options);
    for (const key of Object.keys(flat)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
    return flat;
  });

  // A scalar array flattens to the empty path; give it a usable column name.
  const headerNames = columns.map((c) => (c === '' ? 'value' : c));

  const lines: string[] = [];
  if (options.header) {
    lines.push(headerNames.map((c) => csvEscape(c, options.delimiter, options.quoteAll)).join(options.delimiter));
  }
  for (const row of flatRows) {
    lines.push(
      columns
        .map((c) => csvEscape(row[c], options.delimiter, options.quoteAll))
        .join(options.delimiter),
    );
  }

  if (columns.length > 200) {
    warnings.push(
      `${columns.length} columns. Try "arrays as JSON" or a lower max depth to keep the sheet readable.`,
    );
  }

  const body = lines.join(options.newline) + options.newline;
  return {
    csv: (options.bom ? '﻿' : '') + body,
    columns: headerNames,
    rows: flatRows.length,
    warnings,
  };
}
