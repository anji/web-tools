import { defineTool, ok, readBoolean, readNumber, readString, type Result, type ToolOutput } from '@tools/core';
import { parseCron, nextOccurrences } from './cron.js';
import {
  formatInZone, formatOffset, isValidTimeZone, offsetAt, resolveWallTime,
  wallTimeAt, zoneAbbreviation, type WallTime,
} from './timezone.js';

const ZONE_OPTION = {
  kind: 'text' as const,
  key: 'timeZone',
  label: 'Time zone',
  default: 'UTC',
  placeholder: 'Europe/London',
  help: 'An IANA name, such as America/New_York.',
};

const PRIVACY_FAQ = {
  question: 'Does anything get sent anywhere?',
  answer:
    'No. Both tools are pure functions in your tab, using the time zone database your browser already ships. The page cannot open a network connection — its Content-Security-Policy sets connect-src to ‘none’.',
};

const DST_FAQ = {
  question: 'Why does it matter whether a local time is ambiguous?',
  answer:
    'Because twice a year a wall-clock reading is either missing or doubled. When clocks go forward, 02:30 simply does not occur — a job scheduled then may not run at all. When they go back, 01:30 occurs twice, and a job scheduled then may run twice. Both are real outages that get diagnosed as flaky infrastructure, and neither is visible in a converter that quietly picks one instant.',
};

const DEFAULT_TS = '1767225600';

const timestampTool = defineTool({
  id: 'timestamp-converter',
  slug: 'timestamp-converter',
  label: 'Timestamp converter',
  blurb: 'Convert epoch time to any zone, with ambiguous and missing local times flagged.',
  category: 'Convert',
  seo: {
    title: 'Unix Timestamp Converter - Any Time Zone, DST Aware',
    description:
      'Convert a Unix timestamp to a readable date in any IANA time zone, or a date back to epoch. Detects seconds, milliseconds, microseconds and nanoseconds, and flags local times that are ambiguous or do not exist.',
    heading: 'Timestamp Converter',
    intro:
      'Paste an epoch timestamp or a date and get it in the zone you care about. The unit is detected from the magnitude, and any local time that falls in a daylight-saving gap or repeat is called out rather than silently resolved.',
    keywords: ['unix timestamp converter', 'epoch converter', 'timestamp to date', 'convert epoch to date', 'utc to local time'],
    faq: [
      PRIVACY_FAQ,
      DST_FAQ,
      {
        question: 'How does it know whether my number is seconds or milliseconds?',
        answer:
          'From its magnitude. Ten digits is seconds, thirteen is milliseconds, sixteen microseconds, nineteen nanoseconds — the ranges do not overlap for any date in the modern era. You can override it if your value is genuinely outside that.',
      },
      {
        question: 'The date is a day out from what I expected.',
        answer:
          'Almost always a zone difference rather than a wrong timestamp. An instant near midnight falls on different calendar days depending on where you read the clock, which is why every line here carries its offset rather than an abbreviation alone.',
      },
    ],
  },
  inputs: [
    {
      label: 'Timestamp or date',
      placeholder: `${DEFAULT_TS}\nor 2026-01-01 09:30:00`,
      language: 'text' as const,
      accept: ['.txt'] as const,
    },
  ] as const,
  options: [
    ZONE_OPTION,
    {
      kind: 'select',
      key: 'unit',
      label: 'Unit',
      choices: [
        { value: 'auto', label: 'Detect' },
        { value: 's', label: 'Seconds' },
        { value: 'ms', label: 'Milliseconds' },
        { value: 'us', label: 'Microseconds' },
        { value: 'ns', label: 'Nanoseconds' },
      ],
      default: 'auto',
    },
  ],
  run(inputs, options): Result<ToolOutput> {
    const raw = (inputs[0] ?? '').trim();
    if (raw.length === 0) {
      return { ok: false, error: { message: 'Nothing to convert yet.', hint: 'Paste a timestamp or a date.' } };
    }

    const timeZone = readString(options, 'timeZone', 'UTC') || 'UTC';
    if (!isValidTimeZone(timeZone)) {
      return {
        ok: false,
        error: {
          message: `"${timeZone}" is not a time zone this browser knows.`,
          hint: 'Use an IANA name such as Europe/London or America/New_York, not an abbreviation like BST.',
        },
      };
    }

    const numeric = /^-?\d+$/.test(raw);
    let utc: number;
    let detectedUnit = readString(options, 'unit', 'auto');
    let interpretedWall: WallTime | undefined;

    if (numeric) {
      const value = Number(raw);
      if (detectedUnit === 'auto') {
        const digits = raw.replace('-', '').length;
        detectedUnit = digits >= 18 ? 'ns' : digits >= 15 ? 'us' : digits >= 12 ? 'ms' : 's';
      }
      const divisor = { s: 1 / 1000, ms: 1, us: 1000, ns: 1000000 }[detectedUnit] ?? 1;
      utc = detectedUnit === 's' ? value * 1000 : value / divisor;
      if (!Number.isFinite(utc)) {
        return { ok: false, error: { message: 'That number is out of range for a date.' } };
      }
    } else {
      // A bare date string is read as wall time in the chosen zone, which is
      // what someone typing one almost always means.
      const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
      if (!match) {
        const parsed = Date.parse(raw);
        if (Number.isNaN(parsed)) {
          return {
            ok: false,
            error: {
              message: 'Could not read that as a timestamp or a date.',
              hint: 'Try an epoch number, or an ISO date such as 2026-01-01 09:30.',
            },
          };
        }
        utc = parsed;
      } else {
        interpretedWall = {
          year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
          hour: Number(match[4] ?? 0), minute: Number(match[5] ?? 0), second: Number(match[6] ?? 0),
        };
        utc = resolveWallTime(interpretedWall, timeZone).utc;
      }
      detectedUnit = 'date';
    }

    const lines: string[] = [];
    const seconds = Math.floor(utc / 1000);

    lines.push(`${timeZone}   ${formatInZone(utc, timeZone)}   ${zoneAbbreviation(utc, timeZone)}`);
    lines.push(`UTC        ${new Date(utc).toISOString()}`);
    lines.push('');
    lines.push(`epoch seconds       ${seconds}`);
    lines.push(`epoch milliseconds  ${utc}`);
    lines.push(`offset              ${formatOffset(offsetAt(utc, timeZone))}`);

    if (interpretedWall) {
      const resolved = resolveWallTime(interpretedWall, timeZone);
      if (resolved.ambiguity === 'ambiguous') {
        lines.push(
          '',
          'This local time occurs twice — the clocks went back over it.',
          `  first   ${new Date(resolved.utc).toISOString()}  (${formatOffset(resolved.offsetMinutes)})`,
          `  second  ${new Date(resolved.alternativeUtc!).toISOString()}  (${formatOffset(resolved.alternativeOffsetMinutes!)})`,
          'The first is used above. Anything scheduled at this time may run twice.',
        );
      } else if (resolved.ambiguity === 'nonexistent') {
        lines.push(
          '',
          'This local time never occurs — the clocks jumped over it.',
          `The instant shown is where the jump landed. Anything scheduled at this time may not run at all.`,
        );
      }
    }

    const stats = [
      { label: 'zone', value: timeZone },
      { label: 'read as', value: detectedUnit },
    ];

    return ok({ content: lines.join('\n') + '\n', language: 'text', filename: 'timestamp.txt', stats });
  },
});

const cronTool = defineTool({
  id: 'cron-tester',
  slug: 'cron-tester',
  label: 'Cron tester',
  blurb: 'See exactly when a cron expression fires, in your zone, DST included.',
  category: 'Inspect',
  seo: {
    title: 'Cron Expression Tester - See the Next Fire Times, Not a Description',
    description:
      'Paste a cron expression and get the actual next fire times in any time zone, with daylight-saving gaps and repeats flagged. Handles the day-of-month and day-of-week OR rule correctly.',
    heading: 'Cron Tester',
    intro:
      'Descriptions of cron expressions are easy to agree with and easy to be wrong about. This gives you the dates instead — the next fire times in the zone the scheduler runs in, so you can check the schedule against what you meant.',
    keywords: ['cron tester', 'cron expression next run', 'crontab tester', 'cron schedule preview', 'when does my cron run'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'What is the day-of-month and day-of-week rule?',
        answer:
          'When both fields are restricted, cron fires when EITHER matches — not both. "0 0 1 * MON" runs on the first of every month AND on every Monday, which is usually far more often than the author intended. When one field is a wildcard, only the other applies. It is the most commonly misread rule in cron, which is why this lists dates rather than describing the expression.',
      },
      DST_FAQ,
      {
        question: 'It says my expression never fires.',
        answer:
          'Then it genuinely never does. "0 0 30 2 *" is valid syntax for the thirtieth of February, and "0 0 31 4 *" for the thirty-first of April. Both parse cleanly and neither will ever run — a bug no linter catches and no description reveals.',
      },
      {
        question: 'Are seconds and special characters supported?',
        answer:
          'Not yet. The five standard fields, names such as MON and JAN, ranges, lists, steps, ? as a wildcard and the @-shorthands all work. Quartz extensions — a leading seconds field, L, W, # — do not, and a six-field expression is reported as such rather than misread.',
      },
    ],
  },
  inputs: [
    {
      label: 'Cron expression',
      placeholder: '0 9 * * MON-FRI',
      language: 'text' as const,
      accept: ['.txt'] as const,
    },
  ] as const,
  options: [
    ZONE_OPTION,
    { kind: 'number', key: 'count', label: 'Fire times', default: 10, min: 1, max: 50, step: 5 },
    { kind: 'boolean', key: 'showUtc', label: 'Also show UTC', default: false },
  ],
  run(inputs, options): Result<ToolOutput> {
    const parsed = parseCron(inputs[0] ?? '');
    if (!parsed.ok) return parsed;

    const timeZone = readString(options, 'timeZone', 'UTC') || 'UTC';
    if (!isValidTimeZone(timeZone)) {
      return {
        ok: false,
        error: {
          message: `"${timeZone}" is not a time zone this browser knows.`,
          hint: 'Use an IANA name such as Europe/London, not an abbreviation like BST.',
        },
      };
    }

    const count = readNumber(options, 'count', 10);
    const showUtc = readBoolean(options, 'showUtc', false);
    const now = Date.now();
    const occurrences = nextOccurrences(parsed.value, now, timeZone, count);

    if (occurrences.length === 0) {
      return ok({
        content:
          'This expression never fires.\n\n' +
          'It parses cleanly but matches no real date — a day-of-month that does not\n' +
          'exist in the months selected is the usual cause, such as 30 February or\n' +
          '31 April.\n',
        language: 'text',
        filename: 'cron.txt',
        stats: [{ label: 'fires', value: 'never' }],
      });
    }

    const lines: string[] = [`${parsed.value.source}   in ${timeZone}`, ''];
    let flagged = 0;

    for (const occurrence of occurrences) {
      const local = formatInZone(occurrence.utc, timeZone);
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
        .format(new Date(occurrence.utc));
      let line = `  ${weekday}  ${local}`;
      if (showUtc) line += `   ${new Date(occurrence.utc).toISOString()}`;
      if (occurrence.ambiguity === 'ambiguous') {
        line += '   ← local time occurs twice today; may run twice';
        flagged++;
      } else if (occurrence.ambiguity === 'nonexistent') {
        line += '   ← local time skipped by DST; may not run';
        flagged++;
      }
      lines.push(line);
    }

    if (parsed.value.domRestricted && parsed.value.dowRestricted) {
      lines.push(
        '',
        'Both day-of-month and day-of-week are restricted, so this fires when EITHER',
        'matches. If you meant the intersection, cron cannot express it directly.',
      );
    }
    if (flagged > 0) {
      lines.push('', `${flagged} of these fall on a daylight-saving boundary. Schedulers differ on what they do there.`);
    }

    return ok({
      content: lines.join('\n') + '\n',
      language: 'text',
      filename: 'cron.txt',
      stats: [
        { label: 'zone', value: timeZone },
        { label: 'shown', value: String(occurrences.length) },
        ...(flagged > 0 ? [{ label: 'dst edge', value: String(flagged) }] : []),
      ],
    });
  },
});

export const timeTools = [timestampTool, cronTool];
