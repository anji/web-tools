/**
 * Secret and PII detection for JSON.
 *
 * This is the tool that justifies the whole local-only architecture: the
 * documents people most want to inspect are exactly the ones they must not
 * paste into someone else's server. Detection is deliberately two-sided --
 * suspicious key names and suspicious value shapes -- because either alone
 * misses too much.
 */

export type FindingKind =
  | 'secret'
  | 'credential'
  | 'token'
  | 'private-key'
  | 'email'
  | 'phone'
  | 'credit-card'
  | 'ip-address'
  | 'national-id';

export interface Finding {
  path: string;
  key: string;
  kind: FindingKind;
  /** What matched: the key name, the value shape, or both. */
  reason: string;
  /** Never the raw value -- a masked preview only. */
  preview: string;
  confidence: 'high' | 'medium';
}

export type RedactStyle = 'mask' | 'placeholder' | 'label' | 'remove';

export interface RedactOptions {
  style: RedactStyle;
  /** Characters left visible at each end when style is 'mask'. */
  keepChars: number;
  detectEmails: boolean;
  detectPhones: boolean;
  detectIpAddresses: boolean;
  detectCreditCards: boolean;
  /** Extra key names to treat as sensitive, comma separated. */
  extraKeys: string;
}

export const defaultRedactOptions: RedactOptions = {
  style: 'mask',
  keepChars: 2,
  detectEmails: true,
  detectPhones: true,
  detectIpAddresses: false,
  detectCreditCards: true,
  extraKeys: '',
};

const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|secret|token|api[_-]?key|apikey|authorization|auth[_-]?token|credential|private[_-]?key|client[_-]?secret|access[_-]?key|refresh[_-]?token|session[_-]?id|cookie|bearer|signature|salt|otp|pin|ssn|social[_-]?security|tax[_-]?id|passport|license[_-]?key)/i;

interface ValuePattern {
  kind: FindingKind;
  reason: string;
  test: RegExp;
  confidence: 'high' | 'medium';
}

const VALUE_PATTERNS: readonly ValuePattern[] = [
  { kind: 'private-key', reason: 'PEM private key block', test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, confidence: 'high' },
  { kind: 'token', reason: 'JSON Web Token', test: /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/, confidence: 'high' },
  { kind: 'credential', reason: 'AWS access key id', test: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, confidence: 'high' },
  { kind: 'token', reason: 'GitHub token', test: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/, confidence: 'high' },
  { kind: 'token', reason: 'Slack token', test: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, confidence: 'high' },
  { kind: 'token', reason: 'Stripe live key', test: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/, confidence: 'high' },
  { kind: 'token', reason: 'Google API key', test: /\bAIza[0-9A-Za-z_-]{35}\b/, confidence: 'high' },
  { kind: 'credential', reason: 'connection string with inline password', test: /\b[a-z][a-z0-9+.-]*:\/\/[^:/\s]+:[^@/\s]+@/i, confidence: 'high' },
  { kind: 'credential', reason: 'HTTP Basic credentials', test: /^Basic\s+[A-Za-z0-9+/=]{8,}$/, confidence: 'medium' },
];

const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9][0-9\s().-]{7,17}[0-9]$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CARD_CANDIDATE = /^[0-9][0-9 -]{11,21}[0-9]$/;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function maskPreview(text: string, keep: number): string {
  if (text.length <= keep * 2) return '*'.repeat(text.length);
  return text.slice(0, keep) + '*'.repeat(Math.min(12, text.length - keep * 2)) + text.slice(-keep);
}

function classify(
  key: string,
  value: unknown,
  options: RedactOptions,
  extraKeys: readonly string[],
): { kind: FindingKind; reason: string; confidence: 'high' | 'medium' } | undefined {
  const keyIsSensitive =
    SENSITIVE_KEY.test(key) || extraKeys.some((k) => k && key.toLowerCase().includes(k));

  if (typeof value !== 'string') {
    // Non-string values under a sensitive key still count -- a numeric PIN is
    // just as leaky as a string one.
    if (keyIsSensitive && (typeof value === 'number' || typeof value === 'boolean')) {
      return { kind: 'secret', reason: `key name "${key}" looks sensitive`, confidence: 'medium' };
    }
    return undefined;
  }

  for (const pattern of VALUE_PATTERNS) {
    if (pattern.test.test(value)) {
      return { kind: pattern.kind, reason: pattern.reason, confidence: pattern.confidence };
    }
  }

  if (keyIsSensitive) {
    return { kind: 'secret', reason: `key name "${key}" looks sensitive`, confidence: 'high' };
  }

  if (options.detectEmails && EMAIL.test(value)) {
    return { kind: 'email', reason: 'email address', confidence: 'high' };
  }

  if (options.detectCreditCards && CARD_CANDIDATE.test(value)) {
    const digits = value.replace(/[^0-9]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      return { kind: 'credit-card', reason: 'card number (passes Luhn check)', confidence: 'high' };
    }
  }

  if (options.detectIpAddresses) {
    const m = IPV4.exec(value);
    if (m && m.slice(1).every((p) => Number(p) <= 255)) {
      return { kind: 'ip-address', reason: 'IPv4 address', confidence: 'medium' };
    }
  }

  if (options.detectPhones && PHONE.test(value)) {
    // E.164 caps a phone number at 15 digits. Without the upper bound a 16-digit
    // card number that fails the Luhn check falls through to here and gets
    // mislabelled as a phone number.
    const digits = value.replace(/[^0-9]/g, '').length;
    if (digits >= 9 && digits <= 15) {
      return { kind: 'phone', reason: 'phone number', confidence: 'medium' };
    }
  }

  return undefined;
}

export interface RedactResult {
  value: unknown;
  findings: Finding[];
}

export function redactJson(root: unknown, options: RedactOptions): RedactResult {
  const findings: Finding[] = [];
  const extraKeys = options.extraKeys
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const replacement = (
    value: unknown,
    kind: FindingKind,
  ): unknown => {
    switch (options.style) {
      case 'placeholder':
        return '[REDACTED]';
      case 'label':
        return `<${kind}>`;
      case 'remove':
        return undefined;
      case 'mask':
        return typeof value === 'string'
          ? maskPreview(value, options.keepChars)
          : '[REDACTED]';
    }
  };

  const walk = (value: unknown, path: string, key: string): unknown => {
    if (Array.isArray(value)) {
      return value.map((item, i) => walk(item, `${path}[${i}]`, key));
    }

    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(childKey)
          ? `${path}.${childKey}`
          : `${path}[${JSON.stringify(childKey)}]`;
        const next = walk(childValue, childPath, childKey);
        if (next !== undefined) out[childKey] = next;
      }
      return out;
    }

    const hit = classify(key, value, options, extraKeys);
    if (!hit) return value;

    findings.push({
      path,
      key,
      kind: hit.kind,
      reason: hit.reason,
      preview: maskPreview(String(value), options.keepChars),
      confidence: hit.confidence,
    });
    return replacement(value, hit.kind);
  };

  return { value: walk(root, '$', ''), findings };
}

export function renderFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return 'No secrets or personal data detected.\n\nThis is a heuristic scan, not a guarantee. Review anything you are about to share.\n';
  }

  const byKind = new Map<FindingKind, Finding[]>();
  for (const f of findings) {
    const bucket = byKind.get(f.kind);
    if (bucket) bucket.push(f);
    else byKind.set(f.kind, [f]);
  }

  const lines: string[] = [
    `${findings.length} potential issue${findings.length === 1 ? '' : 's'} found`,
    '',
  ];
  for (const [kind, group] of byKind) {
    lines.push(`${kind} (${group.length})`);
    for (const f of group) {
      lines.push(`  ${f.path}`);
      lines.push(`    ${f.reason} - ${f.confidence} confidence`);
      lines.push(`    value: ${f.preview}`);
    }
    lines.push('');
  }
  lines.push('Heuristic scan. Review anything you are about to share.');
  return lines.join('\n') + '\n';
}
