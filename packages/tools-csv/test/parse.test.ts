import { describe, it, expect } from 'vitest';
import { parseCsv, detectDelimiter, defaultParseOptions } from '../src/parse.js';

const parse = (text: string, over = {}) => {
  const r = parseCsv(text, { ...defaultParseOptions, ...over });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const fail = (text: string, over = {}) => {
  const r = parseCsv(text, { ...defaultParseOptions, ...over });
  if (r.ok) throw new Error('expected a failure');
  return r.error;
};

describe('the things that break naive parsers', () => {
  it('keeps a delimiter that sits inside quotes', () => {
    const r = parse('a,b\n"x,y",z');
    expect(r.rows[0]).toEqual(['x,y', 'z']);
  });

  it('keeps a newline that sits inside quotes', () => {
    const r = parse('a,b\n"line1\nline2",z');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.[0]).toBe('line1\nline2');
  });

  it('unescapes a doubled quote', () => {
    const r = parse('a\n"say ""hi"""');
    expect(r.rows[0]?.[0]).toBe('say "hi"');
  });

  it('strips a UTF-8 BOM rather than baking it into the first header', () => {
    const r = parse('﻿id,name\n1,Ada');
    expect(r.headers).toEqual(['id', 'name']);
    expect(r.hadBom).toBe(true);
  });

  it('handles CRLF, LF and lone CR line endings', () => {
    expect(parse('a,b\r\n1,2').rows[0]).toEqual(['1', '2']);
    expect(parse('a,b\n1,2').rows[0]).toEqual(['1', '2']);
    expect(parse('a,b\r1,2').rows[0]).toEqual(['1', '2']);
  });

  it('reports the line where an unclosed quote began', () => {
    const error = fail('a,b\n1,2\n"oops,3');
    expect(error.message).toMatch(/line 3/);
    expect(error.hint).toMatch(/doubled/);
  });

  it('does not lose the final row when there is no trailing newline', () => {
    expect(parse('a,b\n1,2\n3,4').rowCount).toBe(2);
  });

  it('ignores a trailing newline rather than emitting a blank row', () => {
    expect(parse('a,b\n1,2\n').rowCount).toBe(1);
  });

  it('preserves empty fields', () => {
    expect(parse('a,b,c\n1,,3').rows[0]).toEqual(['1', '', '3']);
  });

  it('preserves leading and trailing spaces unless asked to trim', () => {
    expect(parse('a\n  x  ').rows[0]?.[0]).toBe('  x  ');
    expect(parse('a\n  x  ', { trimFields: true }).rows[0]?.[0]).toBe('x');
  });
});

describe('delimiter detection', () => {
  it('finds semicolons, tabs and pipes', () => {
    expect(detectDelimiter('a;b;c\n1;2;3', '"')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3', '"')).toBe('\t');
    expect(detectDelimiter('a|b|c\n1|2|3', '"')).toBe('|');
  });

  it('prefers consistency over raw frequency', () => {
    // The description column is full of commas, but only the semicolon yields
    // the same field count on every line.
    const text = 'id;description\n1;"a, b, c, d"\n2;"e, f, g, h"\n3;"i, j, k, l"';
    expect(detectDelimiter(text, '"')).toBe(';');
  });

  it('defaults to comma for a single column', () => {
    expect(detectDelimiter('name\nAda\nGrace', '"')).toBe(',');
  });
});

describe('header detection', () => {
  it('treats text labels above numbers as a header', () => {
    const r = parse('id,score\n1,90\n2,80');
    expect(r.usedHeader).toBe(true);
    expect(r.headers).toEqual(['id', 'score']);
    expect(r.rowCount).toBe(2);
  });

  it('treats an all-numeric first row as data', () => {
    const r = parse('1,2,3\n4,5,6');
    expect(r.usedHeader).toBe(false);
    expect(r.headers).toEqual(['column_1', 'column_2', 'column_3']);
    expect(r.rowCount).toBe(2);
  });

  it('rejects a first row with duplicate labels as a header', () => {
    const r = parse('a,a\n1,2');
    expect(r.usedHeader).toBe(false);
  });

  it('names an empty header cell rather than leaving it blank', () => {
    const r = parse('id,,name\n1,x,Ada');
    expect(r.headers[1]).toBe('column_2');
  });

  it('can be forced either way', () => {
    expect(parse('1,2\n3,4', { header: true }).usedHeader).toBe(true);
    expect(parse('a,b\n1,2', { header: false }).rowCount).toBe(2);
  });
});

describe('ragged rows', () => {
  it('reports rows whose width differs from the header', () => {
    const r = parse('a,b,c\n1,2,3\n4,5\n6,7,8,9');
    expect(r.raggedRows).toEqual([
      { line: 3, got: 2, expected: 3 },
      { line: 4, got: 4, expected: 3 },
    ]);
  });

  it('parses successfully despite them', () => {
    expect(parse('a,b\n1\n2,3,4').rowCount).toBe(2);
  });
});

describe('limits', () => {
  it('truncates at maxRows and says so', () => {
    const text = 'a\n' + Array.from({ length: 100 }, (_, i) => i).join('\n');
    const r = parse(text, { maxRows: 10 });
    expect(r.truncated).toBe(true);
    expect(r.rowCount).toBeLessThanOrEqual(11);
  });

  it('does not truncate when under the limit', () => {
    expect(parse('a\n1\n2\n3', { maxRows: 10 }).truncated).toBe(false);
  });
});
