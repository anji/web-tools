import { ok, err } from '@tools/core';
import type { Result } from '@tools/core';
import { resolveWallTime, wallTimeAt, type Ambiguity, type WallTime } from './timezone.js';

/**
 * Standard five-field cron, plus the @-shorthands.
 *
 * The rule worth knowing: when day-of-month *and* day-of-week are both
 * restricted, cron fires when EITHER matches, not both. "0 0 1 * MON" runs on
 * the first of the month AND every Monday. Almost every explanation of cron
 * gets this backwards, and so does almost everyone writing one.
 */

export interface CronExpression {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Whether each day field was left as a wildcard, which decides the OR rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
  source: string;
}

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const DAY_NAMES = ['sun','mon','tue','wed','thu','fri','sat'];

const SHORTHANDS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
  label: string;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59, label: 'minute' },
  { min: 0, max: 23, label: 'hour' },
  { min: 1, max: 31, label: 'day of month' },
  { min: 1, max: 12, names: MONTH_NAMES, label: 'month' },
  { min: 0, max: 7, names: DAY_NAMES, label: 'day of week' },
];

function parseField(text: string, spec: FieldSpec): Result<Set<number>> {
  const values = new Set<number>();
  // Quartz uses ? for "no specific value"; treat it as a wildcard.
  const field = text === '?' ? '*' : text;

  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      return err({ message: `"${part}" has an invalid step in the ${spec.label} field.` });
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (step === 0) return err({ message: `A step of 0 is not valid in the ${spec.label} field.` });

    let start: number;
    let end: number;

    if (rangePart === '*' || rangePart === undefined || rangePart === '') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      const from = toNumber(a ?? '', spec);
      const to = toNumber(b ?? '', spec);
      if (from === undefined || to === undefined) {
        return err({ message: `"${rangePart}" is not a valid range in the ${spec.label} field.` });
      }
      start = from;
      end = to;
    } else {
      const single = toNumber(rangePart, spec);
      if (single === undefined) {
        return err({
          message: `"${rangePart}" is not valid in the ${spec.label} field.`,
          hint: `Expected ${spec.min}-${spec.max}${spec.names ? `, or a name such as ${spec.names[0]!.toUpperCase()}` : ''}.`,
        });
      }
      start = single;
      // A bare value with a step means "from here onwards", as in 5/15.
      end = stepPart === undefined ? single : spec.max;
    }

    if (start < spec.min || end > spec.max || start > end) {
      return err({
        message: `${start}-${end} is out of range for the ${spec.label} field.`,
        hint: `Valid values are ${spec.min}-${spec.max}.`,
      });
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }

  if (values.size === 0) return err({ message: `The ${spec.label} field matched nothing.` });
  return ok(values);
}

function toNumber(text: string, spec: FieldSpec): number | undefined {
  const trimmed = text.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (spec.names) {
    const index = spec.names.indexOf(trimmed.slice(0, 3));
    if (index !== -1) return spec.min === 0 ? index : index + 1;
  }
  return undefined;
}

export function parseCron(input: string): Result<CronExpression> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return err({ message: 'Nothing to parse yet.', hint: 'Try 0 9 * * MON-FRI for weekdays at 09:00.' });
  }

  const expanded = SHORTHANDS[trimmed.toLowerCase()] ?? trimmed;
  if (trimmed.startsWith('@') && SHORTHANDS[trimmed.toLowerCase()] === undefined) {
    if (trimmed.toLowerCase() === '@reboot') {
      return err({
        message: '@reboot has no schedule to compute.',
        hint: 'It runs once when the machine starts, so there are no fire times to list.',
      });
    }
    return err({
      message: `Unknown shorthand "${trimmed}".`,
      hint: 'Supported: @yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly.',
    });
  }

  const parts = expanded.split(/\s+/);
  if (parts.length === 6) {
    return err({
      message: 'This looks like a six-field expression with seconds.',
      hint: 'Quartz and some schedulers add a leading seconds field. Drop it and use the standard five fields, since the seconds precision is not represented here.',
    });
  }
  if (parts.length !== 5) {
    return err({
      message: `Expected 5 fields, found ${parts.length}.`,
      hint: 'The order is minute, hour, day-of-month, month, day-of-week.',
    });
  }

  const parsed: Set<number>[] = [];
  for (const [index, spec] of FIELDS.entries()) {
    const field = parseField(parts[index]!, spec);
    if (!field.ok) return field;
    parsed.push(field.value);
  }

  // Both 0 and 7 name Sunday.
  const daysOfWeek = new Set([...parsed[4]!].map((d) => (d === 7 ? 0 : d)));

  const domText = parts[2]!;
  const dowText = parts[4]!;

  return ok({
    minutes: parsed[0]!,
    hours: parsed[1]!,
    daysOfMonth: parsed[2]!,
    months: parsed[3]!,
    daysOfWeek,
    domRestricted: domText !== '*' && domText !== '?',
    dowRestricted: dowText !== '*' && dowText !== '?',
    source: trimmed,
  });
}

export interface Occurrence {
  utc: number;
  wall: WallTime;
  ambiguity: Ambiguity;
}

const dayOfWeek = (y: number, m: number, d: number): number =>
  new Date(Date.UTC(y, m - 1, d)).getUTCDay();

function dayMatches(expr: CronExpression, y: number, m: number, d: number): boolean {
  if (!expr.months.has(m)) return false;
  const dom = expr.daysOfMonth.has(d);
  const dow = expr.daysOfWeek.has(dayOfWeek(y, m, d));

  // The OR rule: restricted on both means either can trigger the day.
  if (expr.domRestricted && expr.dowRestricted) return dom || dow;
  if (expr.domRestricted) return dom;
  if (expr.dowRestricted) return dow;
  return true;
}

/**
 * Days to scan before giving up. Eight years, because the sparsest legitimate
 * schedule is 29 February and two of those need more than five. Rejecting a
 * day is a cheap set lookup, so a wide window costs nothing.
 */
const MAX_DAYS = 366 * 8;

export function nextOccurrences(
  expr: CronExpression,
  from: number,
  timeZone: string,
  count: number,
): Occurrence[] {
  const occurrences: Occurrence[] = [];
  const start = wallTimeAt(from, timeZone);
  const hours = [...expr.hours].sort((a, b) => a - b);
  const minutes = [...expr.minutes].sort((a, b) => a - b);

  let cursor = Date.UTC(start.year, start.month - 1, start.day);

  for (let dayIndex = 0; dayIndex < MAX_DAYS && occurrences.length < count; dayIndex++) {
    const date = new Date(cursor);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    cursor += 86400000;

    if (!dayMatches(expr, y, m, d)) continue;
    const isFirstDay = dayIndex === 0;

    for (const hour of hours) {
      if (isFirstDay && hour < start.hour) continue;
      for (const minute of minutes) {
        if (isFirstDay && hour === start.hour && minute <= start.minute) continue;

        const wall: WallTime = { year: y, month: m, day: d, hour, minute, second: 0 };
        const resolved = resolveWallTime(wall, timeZone);
        occurrences.push({ utc: resolved.utc, wall, ambiguity: resolved.ambiguity });
        if (occurrences.length >= count) break;
      }
      if (occurrences.length >= count) break;
    }
  }

  return occurrences;
}
