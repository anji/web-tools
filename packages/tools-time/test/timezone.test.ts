import { describe, it, expect } from 'vitest';
import { wallTimeAt, offsetAt, resolveWallTime, formatInZone, formatOffset, isValidTimeZone } from '../src/timezone.js';

const wall = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  ({ year: y, month: mo, day: d, hour: h, minute: mi, second: s });

describe('offsets', () => {
  it('reads a fixed-offset zone', () => {
    // India has no DST and sits at +05:30 all year.
    expect(offsetAt(Date.UTC(2026, 0, 1), 'Asia/Kolkata')).toBe(330);
    expect(offsetAt(Date.UTC(2026, 6, 1), 'Asia/Kolkata')).toBe(330);
  });

  it('tracks a DST change', () => {
    expect(offsetAt(Date.UTC(2026, 0, 15), 'America/New_York')).toBe(-300); // EST
    expect(offsetAt(Date.UTC(2026, 6, 15), 'America/New_York')).toBe(-240); // EDT
  });

  it('formats offsets including half-hour zones', () => {
    expect(formatOffset(330)).toBe('+05:30');
    expect(formatOffset(-300)).toBe('-05:00');
    expect(formatOffset(0)).toBe('+00:00');
  });
});

describe('wall clock readings', () => {
  it('converts an instant into a zone', () => {
    // 2026-01-01T00:00Z is 05:30 on the 1st in India.
    expect(wallTimeAt(Date.UTC(2026, 0, 1), 'Asia/Kolkata')).toEqual(wall(2026, 1, 1, 5, 30));
  });

  it('handles midnight without rendering it as hour 24', () => {
    const w = wallTimeAt(Date.UTC(2026, 0, 1, 5, 30), 'Asia/Kolkata');
    expect(w.hour).toBe(11);
    expect(wallTimeAt(Date.UTC(2026, 0, 1), 'UTC').hour).toBe(0);
  });

  it('formats with the zone offset rather than forcing UTC', () => {
    expect(formatInZone(Date.UTC(2026, 0, 1), 'Asia/Kolkata')).toBe('2026-01-01T05:30:00+05:30');
    expect(formatInZone(Date.UTC(2026, 0, 1), 'UTC')).toBe('2026-01-01T00:00:00+00:00');
  });
});

describe('DST edges', () => {
  it('resolves an ordinary time uniquely', () => {
    const r = resolveWallTime(wall(2026, 6, 15, 12, 0), 'America/New_York');
    expect(r.ambiguity).toBe('unique');
    expect(new Date(r.utc).toISOString()).toBe('2026-06-15T16:00:00.000Z');
  });

  it('reports a time that never happens', () => {
    // US clocks jump 02:00 -> 03:00 on 8 March 2026, so 02:30 does not exist.
    const r = resolveWallTime(wall(2026, 3, 8, 2, 30), 'America/New_York');
    expect(r.ambiguity).toBe('nonexistent');
  });

  it('reports a time that happens twice, with both instants', () => {
    // Clocks go back 02:00 -> 01:00 on 1 November 2026, so 01:30 occurs twice.
    const r = resolveWallTime(wall(2026, 11, 1, 1, 30), 'America/New_York');
    expect(r.ambiguity).toBe('ambiguous');
    expect(r.alternativeUtc).toBeDefined();
    // The two instants are exactly an hour apart.
    expect(r.alternativeUtc! - r.utc).toBe(3600000);
    expect(r.offsetMinutes).toBe(-240); // EDT first
    expect(r.alternativeOffsetMinutes).toBe(-300); // then EST
  });

  it('does the same for a European transition', () => {
    // UK clocks go forward on 29 March 2026 at 01:00.
    expect(resolveWallTime(wall(2026, 3, 29, 1, 30), 'Europe/London').ambiguity).toBe('nonexistent');
    // and back on 25 October 2026 at 02:00.
    expect(resolveWallTime(wall(2026, 10, 25, 1, 30), 'Europe/London').ambiguity).toBe('ambiguous');
  });

  it('never reports ambiguity in a zone without DST', () => {
    for (const month of [1, 3, 6, 10, 11]) {
      expect(resolveWallTime(wall(2026, month, 15, 1, 30), 'Asia/Kolkata').ambiguity).toBe('unique');
    }
  });

  it('round-trips every resolved instant back to the wall time it came from', () => {
    for (const zone of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Sydney']) {
      for (const month of [1, 4, 7, 10]) {
        const w = wall(2026, month, 15, 9, 45, 30);
        const r = resolveWallTime(w, zone);
        expect(wallTimeAt(r.utc, zone), `${zone} ${month}`).toEqual(w);
      }
    }
  });
});

describe('zone validation', () => {
  it('accepts real zones and rejects invented ones', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
