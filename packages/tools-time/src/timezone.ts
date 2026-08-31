/**
 * Wall-clock arithmetic in a named zone, using only Intl.
 *
 * The awkward direction is local to UTC. An offset is a function of the
 * instant, but the instant is what we are solving for, so it has to be found
 * by iteration -- and around a DST transition the answer is not unique. A local
 * time can occur twice (the clocks went back over it) or not at all (they
 * jumped over it), and silently picking one is how "my job ran twice" and "my
 * job never ran" bugs get written.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type Ambiguity = 'unique' | 'ambiguous' | 'nonexistent';

export interface Resolved {
  /** Epoch milliseconds. For an ambiguous time this is the earlier instant. */
  utc: number;
  ambiguity: Ambiguity;
  /** Offset in minutes east of UTC at that instant. */
  offsetMinutes: number;
  /** The second instant, when the wall time occurs twice. */
  alternativeUtc?: number;
  alternativeOffsetMinutes?: number;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading in `timeZone` at a given instant. */
export function wallTimeAt(utc: number, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(utc));
  const get = (type: string): number => {
    const value = parts.find((p) => p.type === type)?.value ?? '0';
    return Number(value);
  };
  // Intl renders midnight as hour 24 in some engines.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

const asUtcMs = (w: WallTime): number =>
  Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/** Offset in minutes east of UTC that `timeZone` was at `utc`. */
export function offsetAt(utc: number, timeZone: string): number {
  return (asUtcMs(wallTimeAt(utc, timeZone)) - utc) / 60000;
}

/**
 * Resolves a wall time in a zone to an instant, reporting whether that reading
 * is unique, doubled or missing.
 */
export function resolveWallTime(wall: WallTime, timeZone: string): Resolved {
  const target = asUtcMs(wall);

  // Two candidates bracket every transition: one using the offset before it and
  // one using the offset after. A candidate is real only if reading the clock
  // back at that instant reproduces the wall time we started from.
  const guess = target - offsetAt(target, timeZone) * 60000;
  const offsets = new Set<number>([
    offsetAt(guess - 86400000, timeZone),
    offsetAt(guess, timeZone),
    offsetAt(guess + 86400000, timeZone),
  ]);

  const valid: Array<{ utc: number; offsetMinutes: number }> = [];
  for (const offsetMinutes of offsets) {
    const candidate = target - offsetMinutes * 60000;
    const back = wallTimeAt(candidate, timeZone);
    if (asUtcMs(back) === target) valid.push({ utc: candidate, offsetMinutes });
  }

  valid.sort((a, b) => a.utc - b.utc);

  if (valid.length === 0) {
    // The clocks jumped over this reading. The instant the jump landed on is
    // the useful answer, and it is what cron implementations tend to use.
    return { utc: guess, ambiguity: 'nonexistent', offsetMinutes: offsetAt(guess, timeZone) };
  }
  if (valid.length === 1) {
    return { utc: valid[0]!.utc, ambiguity: 'unique', offsetMinutes: valid[0]!.offsetMinutes };
  }
  return {
    utc: valid[0]!.utc,
    ambiguity: 'ambiguous',
    offsetMinutes: valid[0]!.offsetMinutes,
    alternativeUtc: valid[1]!.utc,
    alternativeOffsetMinutes: valid[1]!.offsetMinutes,
  };
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** ISO-8601 with the zone's own offset, rather than forcing everything to Z. */
export function formatInZone(utc: number, timeZone: string): string {
  const w = wallTimeAt(utc, timeZone);
  const offset = offsetAt(utc, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${formatOffset(offset)}`;
}

export function zoneAbbreviation(utc: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date(utc));
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}
