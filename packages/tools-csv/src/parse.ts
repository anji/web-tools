import { ok, err } from '@tools/core';
import type { Result } from '@tools/core';

/**
 * A CSV parser that survives real files.
 *
 * RFC 4180 is the easy half. The half that breaks naive split(',') parsers is
 * everything files actually contain: quoted delimiters, newlines inside quotes,
 * doubled quotes, a UTF-8 BOM that turns the first header into "﻿id",
 * semicolon delimiters from European Excel, lone-\r line endings from classic
 * Mac exports, and rows with the wrong number of fields.
 */

export type LineEnding = '\n' | '\r\n' | '\r' | 'mixed' | 'none';

export interface ParseOptions {
  /** Empty string means detect it. */
  delimiter: string;
  quote: string;
  /** 'auto' guesses from whether the first row looks like labels. */
  header: boolean | 'auto';
  trimFields: boolean;
  skipEmptyLines: boolean;
  /** 0 means no limit. Guards the tab against a million-row paste. */
  maxRows: number;
}

export const defaultParseOptions: ParseOptions = {
  delimiter: '',
  quote: '"',
  header: 'auto',
  trimFields: false,
  skipEmptyLines: true,
  maxRows: 10000,
};

export interface RaggedRow {
  /** 1-indexed, counting the header. */
  line: number;
  got: number;
  expected: number;
}

export interface ParseResult {
  headers: string[];
  rows: string[][];
  delimiter: string;
  hadBom: boolean;
  lineEnding: LineEnding;
  raggedRows: RaggedRow[];
  /** True when maxRows stopped the parse early. */
  truncated: boolean;
  /** Data rows kept, excluding the header. */
  rowCount: number;
  /** True when the first row was consumed as column names. */
  usedHeader: boolean;
}

const CANDIDATES = [',', ';', '\t', '|'];

/**
 * Picks the delimiter whose field count is most *consistent* across lines, not
 * the one that appears most. A description column full of commas beats raw
 * frequency; it does not beat consistency.
 */
export function detectDelimiter(text: string, quote: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best = ',';
  let bestScore = -1;

  for (const candidate of CANDIDATES) {
    const counts = countFieldsPerLine(sample, candidate, quote).slice(0, 20);
    if (counts.length === 0) continue;

    const first = counts[0]!;
    if (first < 2) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    // Consistency dominates; field count only breaks ties.
    const score = consistent * 1000 + Math.min(first, 50);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function countFieldsPerLine(text: string, delimiter: string, quote: string): number[] {
  const counts: number[] = [];
  let fields = 1;
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === quote) {
        if (text[i + 1] === quote) i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === quote) inQuotes = true;
    else if (ch === delimiter) fields++;
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      counts.push(fields);
      fields = 1;
    }
  }
  if (fields > 1 || counts.length === 0) counts.push(fields);
  return counts;
}

function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const present = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (present === 0) return 'none';
  if (present > 1) return 'mixed';
  if (crlf > 0) return '\r\n';
  if (lf > 0) return '\n';
  return '\r';
}

/** A first row of non-numeric labels above rows containing numbers is a header. */
function looksLikeHeader(first: string[], rest: string[][]): boolean {
  if (first.length === 0) return false;
  if (first.some((c) => c.trim() === '')) return false;
  if (first.every((c) => /^-?\d+(\.\d+)?$/.test(c.trim()))) return false;
  if (new Set(first.map((c) => c.trim().toLowerCase())).size !== first.length) return false;

  const sample = rest.slice(0, 20);
  if (sample.length === 0) return true;
  // If any column holds numbers below a non-numeric label, that is a header.
  for (let col = 0; col < first.length; col++) {
    const label = first[col]!.trim();
    const values = sample.map((r) => r[col] ?? '').filter((v) => v.trim() !== '');
    if (values.length === 0) continue;
    const labelNumeric = /^-?\d+(\.\d+)?$/.test(label);
    const valuesNumeric = values.every((v) => /^-?\d+(\.\d+)?$/.test(v.trim()));
    if (!labelNumeric && valuesNumeric) return true;
  }
  return true;
}

export function parseCsv(input: string, options: ParseOptions): Result<ParseResult> {
  if (input.trim().length === 0) {
    return err({ message: 'Nothing to parse yet.', hint: 'Paste or drop a CSV to get started.' });
  }

  // A BOM left in place becomes part of the first header name, which then fails
  // to match anything downstream.
  const hadBom = input.charCodeAt(0) === 0xfeff;
  const text = hadBom ? input.slice(1) : input;

  const quote = options.quote || '"';
  const delimiter = options.delimiter || detectDelimiter(text, quote);
  const lineEnding = detectLineEnding(text);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let quoteStartLine = 0;
  let line = 1;
  let truncated = false;

  const endField = (): void => {
    record.push(options.trimFields ? field.trim() : field);
    field = '';
  };
  const endRecord = (): boolean => {
    endField();
    const empty = record.length === 1 && record[0]!.trim() === '';
    if (!(empty && options.skipEmptyLines)) records.push(record);
    record = [];
    // maxRows counts data rows; the header, if any, is taken from the first.
    if (options.maxRows > 0 && records.length > options.maxRows) {
      truncated = true;
      return false;
    }
    return true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === quote) {
        if (text[i + 1] === quote) {
          field += quote;
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }

    if (ch === quote && field === '') {
      inQuotes = true;
      quoteStartLine = line;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      if (!endRecord()) break;
    } else {
      field += ch;
    }
  }

  if (inQuotes) {
    return err({
      message: `A quoted field starting on line ${quoteStartLine} is never closed.`,
      hint: 'An odd number of quote characters, usually a value containing a " that was not doubled. Inside a quoted field, one " is written as "".',
    });
  }

  if (!truncated && (field !== '' || record.length > 0)) endRecord();

  if (records.length === 0) {
    return err({ message: 'No rows found.', hint: 'The input decoded but contained no fields.' });
  }

  const first = records[0]!;
  const useHeader =
    options.header === 'auto' ? looksLikeHeader(first, records.slice(1)) : options.header;

  const headers = useHeader
    ? first.map((h, i) => (h.trim() === '' ? `column_${i + 1}` : h.trim()))
    : first.map((_, i) => `column_${i + 1}`);
  const rows = useHeader ? records.slice(1) : records;

  const raggedRows: RaggedRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.length !== headers.length) {
      raggedRows.push({
        line: index + (useHeader ? 2 : 1),
        got: row.length,
        expected: headers.length,
      });
    }
  }

  return ok({
    headers,
    rows,
    delimiter,
    hadBom,
    lineEnding,
    raggedRows,
    truncated,
    rowCount: rows.length,
    usedHeader: useHeader,
  });
}

/** Pads or trims a row so it lines up with the header. */
export function normaliseRow(row: readonly string[], width: number): string[] {
  if (row.length === width) return [...row];
  if (row.length > width) return row.slice(0, width);
  return [...row, ...Array<string>(width - row.length).fill('')];
}
