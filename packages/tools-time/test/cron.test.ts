import { describe, it, expect } from 'vitest';
import { parseCron, nextOccurrences } from '../src/cron.js';

const parse = (text: string) => {
  const r = parseCron(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const fail = (text: string) => {
  const r = parseCron(text);
  if (r.ok) throw new Error('expected a failure');
  return r.error;
};
const next = (expr: string, from: string, zone = 'UTC', count = 5) =>
  nextOccurrences(parse(expr), Date.parse(from), zone, count).map((o) =>
    new Date(o.utc).toISOString(),
  );

describe('parsing', () => {
  it('reads wildcards, lists, ranges and steps', () => {
    expect([...parse('0 * * * *').minutes]).toEqual([0]);
    expect([...parse('0,30 * * * *').minutes]).toEqual([0, 30]);
    expect([...parse('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parse('0 9-17 * * *').hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parse('0 9-17/4 * * *').hours]).toEqual([9, 13, 17]);
  });

  it('reads month and day names', () => {
    expect([...parse('0 0 1 JAN *').months]).toEqual([1]);
    expect([...parse('0 0 * * MON-FRI').daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it('treats 7 and 0 as the same Sunday', () => {
    expect([...parse('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it('expands the @ shorthands', () => {
    expect([...parse('@daily').hours]).toEqual([0]);
    expect([...parse('@hourly').minutes]).toEqual([0]);
    expect([...parse('@weekly').daysOfWeek]).toEqual([0]);
  });

  it('treats ? as a wildcard', () => {
    expect(parse('0 0 ? * *').domRestricted).toBe(false);
  });

  it('rejects bad input with a usable message', () => {
    expect(fail('0 0 * *').message).toMatch(/Expected 5 fields/);
    expect(fail('99 * * * *').message).toMatch(/out of range/);
    expect(fail('* * * * NOTADAY').message).toMatch(/not valid/);
    expect(fail('*/0 * * * *').message).toMatch(/step of 0/);
    expect(fail('@nonsense').hint).toMatch(/@yearly/);
  });

  it('explains a six-field expression instead of just failing', () => {
    expect(fail('0 0 12 * * ?').message).toMatch(/six-field/);
  });

  it('explains that @reboot has no schedule', () => {
    expect(fail('@reboot').message).toMatch(/no schedule/);
  });
});

describe('occurrences', () => {
  it('lists the next fire times', () => {
    expect(next('0 9 * * *', '2026-01-01T10:00:00Z', 'UTC', 3)).toEqual([
      '2026-01-02T09:00:00.000Z',
      '2026-01-03T09:00:00.000Z',
      '2026-01-04T09:00:00.000Z',
    ]);
  });

  it('does not fire at the starting instant itself', () => {
    expect(next('0 9 * * *', '2026-01-01T09:00:00Z', 'UTC', 1)).toEqual([
      '2026-01-02T09:00:00.000Z',
    ]);
  });

  it('handles a sparse yearly schedule without scanning minute by minute', () => {
    expect(next('0 0 29 2 *', '2026-01-01T00:00:00Z', 'UTC', 2)).toEqual([
      '2028-02-29T00:00:00.000Z',
      '2032-02-29T00:00:00.000Z',
    ]);
  });

  it('applies the OR rule when both day fields are restricted', () => {
    // 1st of the month OR any Monday — not the intersection.
    const times = next('0 0 1 * MON', '2026-04-01T12:00:00Z', 'UTC', 4);
    expect(times).toEqual([
      '2026-04-06T00:00:00.000Z', // Monday
      '2026-04-13T00:00:00.000Z',
      '2026-04-20T00:00:00.000Z',
      '2026-04-27T00:00:00.000Z',
    ]);
    // The 1st of May fires too, even though it is a Friday.
    expect(next('0 0 1 * MON', '2026-04-28T00:00:00Z', 'UTC', 1)).toEqual([
      '2026-05-01T00:00:00.000Z',
    ]);
  });

  it('uses only the restricted field when one is a wildcard', () => {
    expect(next('0 0 15 * *', '2026-01-01T00:00:00Z', 'UTC', 2)).toEqual([
      '2026-01-15T00:00:00.000Z',
      '2026-02-15T00:00:00.000Z',
    ]);
  });
});

describe('timezone-aware scheduling', () => {
  it('fires at local wall time, not UTC', () => {
    // 09:00 in New York in January is 14:00 UTC.
    expect(next('0 9 * * *', '2026-01-01T00:00:00Z', 'America/New_York', 1)).toEqual([
      '2026-01-01T14:00:00.000Z',
    ]);
    // The same expression in July is 13:00 UTC, because the offset changed.
    expect(next('0 9 * * *', '2026-07-01T00:00:00Z', 'America/New_York', 1)).toEqual([
      '2026-07-01T13:00:00.000Z',
    ]);
  });

  it('flags a fire time that the clocks skipped over', () => {
    // 02:30 does not exist on 8 March 2026 in New York.
    const occurrences = nextOccurrences(
      parse('30 2 * * *'), Date.parse('2026-03-07T12:00:00Z'), 'America/New_York', 2,
    );
    expect(occurrences[0]?.ambiguity).toBe('nonexistent');
    expect(occurrences[1]?.ambiguity).toBe('unique');
  });

  it('flags a fire time that happens twice', () => {
    // 01:30 occurs twice on 1 November 2026 in New York.
    const occurrences = nextOccurrences(
      parse('30 1 * * *'), Date.parse('2026-10-31T12:00:00Z'), 'America/New_York', 2,
    );
    expect(occurrences[0]?.ambiguity).toBe('ambiguous');
  });

  it('reports no ambiguity in a zone without DST', () => {
    const occurrences = nextOccurrences(
      parse('30 1 * * *'), Date.parse('2026-03-01T00:00:00Z'), 'Asia/Kolkata', 40,
    );
    expect(occurrences.every((o) => o.ambiguity === 'unique')).toBe(true);
  });
});

describe('expressions that never fire', () => {
  it('returns nothing for a date that does not exist', () => {
    // 30 February is syntactically valid and can never happen.
    expect(nextOccurrences(parse('0 0 30 2 *'), Date.parse('2026-01-01T00:00:00Z'), 'UTC', 1))
      .toHaveLength(0);
  });

  it('returns nothing for a day that does not exist in its month', () => {
    expect(nextOccurrences(parse('0 0 31 4 *'), Date.parse('2026-01-01T00:00:00Z'), 'UTC', 1))
      .toHaveLength(0);
  });

  it('still finds a legitimately sparse schedule', () => {
    expect(nextOccurrences(parse('0 0 29 2 *'), Date.parse('2026-01-01T00:00:00Z'), 'UTC', 2))
      .toHaveLength(2);
  });
});
