import {
  defineTool,
  ok,
  readBoolean,
  readString,
  type Result,
  type ToolOutput,
} from '@tools/core';

import { decodeJwt } from './decode.js';
import { CLAIM_DESCRIPTIONS, TIME_CLAIMS, formatTimestamp, validityOf } from './claims.js';
import { analyzeJwt } from './analyze.js';
import { hmacSha256, timingSafeEqual } from './hmac.js';
import { base64UrlToBytes, bytesToBase64Url, textToBytes } from './base64url.js';

const JWT_INPUT = {
  label: 'JWT',
  placeholder:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkYSIsImlhdCI6MTUxNjIzOTAyMn0.signature',
  language: 'text' as const,
  accept: ['.txt', '.jwt'] as const,
};

/** The one answer that matters most on these pages. */
const PRIVACY_FAQ = {
  question: 'Is it safe to paste a real token here?',
  answer:
    'That is the case this page is built for. Decoding happens in your browser as a pure function, and the page ships a Content-Security-Policy of connect-src ‘none’ - the browser physically refuses to let it open a network connection. Open your network tab, or disconnect entirely: it keeps working.',
};

const describeClaims = (payload: unknown, now: number): string[] => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const description = CLAIM_DESCRIPTIONS[key];
    const rendered =
      TIME_CLAIMS.has(key) && typeof value === 'number'
        ? formatTimestamp(value, now)
        : JSON.stringify(value);
    lines.push(`${key}: ${rendered}`);
    if (description) lines.push(`    ${description}`);
  }
  return lines;
};

const decoderTool = defineTool({
  id: 'jwt-decode',
  slug: 'jwt-decoder',
  label: 'JWT decoder',
  blurb: 'Decode a token, read its claims, and see exactly when it expires.',
  category: 'Inspect',
  seo: {
    title: 'JWT Decoder - Decode and Inspect Tokens Without Uploading Them',
    description:
      'Decode a JWT in your browser. Reads the header and payload, explains every registered claim, converts timestamps to readable dates, and shows whether the token is expired. Nothing is uploaded.',
    heading: 'JWT Decoder',
    intro:
      'Paste a token to read its header and payload. Registered claims are explained, NumericDate timestamps become readable dates with a countdown, and you get a straight answer on whether the token is currently valid.',
    keywords: ['jwt decoder', 'decode jwt', 'jwt debugger', 'jwt viewer online', 'read jwt token'],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Does decoding a JWT mean it is verified?',
        answer:
          'No, and the distinction matters. Anyone can decode a JWT - the payload is base64, not encryption. Decoding tells you what the token claims; only checking the signature against the right key tells you whether to believe it. Use the verifier for that.',
      },
      {
        question: 'Why does my token show as expired when it just worked?',
        answer:
          'exp is compared against your machine’s clock. If the countdown looks wrong by a consistent amount, the clock is the usual culprit - which is also why servers with drifting clocks reject tokens that ought to be fine.',
      },
      {
        question: 'My token has five segments and will not decode.',
        answer:
          'Five segments means a JWE - the payload is encrypted, not just signed. There is nothing to read without the decryption key, and no online decoder can change that.',
      },
    ],
  },
  inputs: [JWT_INPUT] as const,
  options: [
    {
      kind: 'select',
      key: 'view',
      label: 'Show',
      choices: [
        { value: 'both', label: 'Header and payload' },
        { value: 'payload', label: 'Payload only' },
        { value: 'header', label: 'Header only' },
        { value: 'claims', label: 'Explained claims' },
      ],
      default: 'both',
    },
    { kind: 'boolean', key: 'readableDates', label: 'Readable timestamps', default: true },
  ],
  run(inputs, options): Result<ToolOutput> {
    const decoded = decodeJwt(inputs[0] ?? '');
    if (!decoded.ok) return decoded;

    const now = Date.now();
    const jwt = decoded.value;
    const validity = validityOf(jwt.payload, now);
    const view = readString(options, 'view', 'both');
    const readable = readBoolean(options, 'readableDates', true);

    let content: string;
    if (view === 'claims') {
      const lines = describeClaims(jwt.payload, now);
      content = lines.length > 0 ? lines.join('\n') + '\n' : 'The payload carries no claims.\n';
    } else {
      const payloadText = JSON.stringify(jwt.payload, null, 2);
      const headerText = JSON.stringify(jwt.header, null, 2);
      const dateNote =
        readable && validity.state !== 'no-expiry' ? `\n// ${validity.detail}\n` : '\n';
      content =
        view === 'header'
          ? headerText + '\n'
          : view === 'payload'
            ? payloadText + dateNote
            : `// Header\n${headerText}\n\n// Payload\n${payloadText}${dateNote}`;
    }

    const stats = [
      { label: 'alg', value: jwt.algorithm },
      { label: 'status', value: validity.state },
    ];
    if (jwt.keyId) stats.push({ label: 'kid', value: jwt.keyId });

    return ok({
      content,
      language: view === 'claims' ? 'text' : 'json',
      filename: 'jwt.json',
      stats,
      warnings:
        jwt.algorithm.toLowerCase() === 'none'
          ? ['This token is unsigned (alg: none). Anything in it can be altered freely.']
          : [],
    });
  },
});

const analyzerTool = defineTool({
  id: 'jwt-analyze',
  slug: 'jwt-security-check',
  label: 'JWT security check',
  blurb: 'Check a token for alg:none, missing expiry, unbounded audience and leaked claims.',
  category: 'Inspect',
  seo: {
    title: 'JWT Security Checker - alg:none, Expiry and Claim Analysis',
    description:
      'Check a JWT for security problems in your browser: alg:none, remote key headers, missing exp or aud, excessive lifetimes, and sensitive data sitting readable in the payload. Nothing is uploaded.',
    heading: 'JWT Security Check',
    intro:
      'Paste a token and get the problems worth knowing about, ranked by severity - from an unsigned alg:none token down to a missing issuer claim. The checks are about the token itself, not the service that issued it.',
    keywords: [
      'jwt security',
      'jwt alg none',
      'jwt vulnerability check',
      'analyse jwt token',
      'jwt best practices checker',
    ],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'What is the alg:none attack?',
        answer:
          'A JWT header names its own algorithm, so a verifier that trusts that field can be handed a token claiming alg:none - meaning unsigned - and accept it. The attacker edits the payload to say whatever they like. The fix is to configure the verifier with the algorithm it expects rather than reading it from the token.',
      },
      {
        question: 'Why does it flag claims like password or api_key?',
        answer:
          'Because a JWS payload is base64-encoded, not encrypted. Every holder of the token can read it, and tokens end up in logs, browser histories, referrer headers and screenshots. If a value has to stay secret it belongs behind the token, not inside it.',
      },
      {
        question: 'A clean result means the token is secure?',
        answer:
          'No. These are checks on the token in front of you. They cannot tell you whether the signing key is strong, whether it has leaked, whether the issuer validates anything, or whether the verifier checks the signature at all. Treat a clean result as "nothing obvious", not "safe".',
      },
    ],
  },
  inputs: [JWT_INPUT] as const,
  options: [
    {
      kind: 'select',
      key: 'minSeverity',
      label: 'Minimum severity',
      choices: [
        { value: 'info', label: 'Everything' },
        { value: 'low', label: 'Low and above' },
        { value: 'medium', label: 'Medium and above' },
        { value: 'high', label: 'High and above' },
      ],
      default: 'info',
    },
  ],
  run(inputs, options): Result<ToolOutput> {
    const decoded = decodeJwt(inputs[0] ?? '');
    if (!decoded.ok) return decoded;

    const findings = analyzeJwt(decoded.value, Date.now());
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const floor = rank[readString(options, 'minSeverity', 'info')] ?? 4;
    const shown = findings.filter((f) => rank[f.severity]! <= floor);

    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) counts[f.severity]++;

    const lines: string[] =
      shown.length === 0
        ? ['Nothing flagged at this severity.', '']
        : shown.flatMap((f) => [`[${f.severity.toUpperCase()}] ${f.title}`, `  ${f.detail}`, '']);

    lines.push(
      'These checks look at the token only. They cannot tell you whether the signing key is',
      'strong, whether it has leaked, or whether the verifier checks the signature at all.',
    );

    return ok({
      content: lines.join('\n') + '\n',
      language: 'text',
      filename: 'jwt-findings.txt',
      stats: [
        { label: 'critical', value: String(counts.critical) },
        { label: 'high', value: String(counts.high) },
        { label: 'medium', value: String(counts.medium) },
      ],
    });
  },
});

const verifierTool = defineTool({
  id: 'jwt-verify',
  slug: 'jwt-signature-verifier',
  label: 'JWT signature verifier',
  blurb: 'Check an HS256 signature against your secret, without the secret leaving the tab.',
  category: 'Inspect',
  seo: {
    title: 'Verify a JWT Signature (HS256) - Your Secret Never Leaves the Tab',
    description:
      'Verify an HMAC-signed JWT against your signing secret entirely in the browser. HS256, HS384 and HS512 tokens, with the secret typed locally and never transmitted.',
    heading: 'JWT Signature Verifier',
    intro:
      'Check whether an HMAC-signed token really was signed with your secret. The secret is the most sensitive thing you own, which is exactly why this computation happens in your tab and the page is forbidden from opening a network connection at all.',
    keywords: [
      'verify jwt signature',
      'jwt signature checker',
      'validate jwt hs256',
      'check jwt signature online',
      'jwt secret verification',
    ],
    faq: [
      {
        question: 'Am I really safe typing my signing secret into a web page?',
        answer:
          'Judge it rather than trusting it. The verification is a pure function in page JavaScript, and the page is served with a Content-Security-Policy of connect-src ‘none’, so the browser blocks any fetch, XHR, WebSocket or beacon it might attempt - a restriction the page cannot lift on itself. Load the page, disconnect from the network, and verify offline. Every deploy is gated on an automated check that tries to exfiltrate data by each of those routes and fails the release if any succeeds.',
      },
      {
        question: 'Which algorithms are supported?',
        answer:
          'The HMAC family - HS256, HS384 and HS512 - because those verify with a shared secret you already hold. RS256, ES256 and the other asymmetric algorithms verify with a public key and are not supported here yet.',
      },
      {
        question: 'The signature does not match. What now?',
        answer:
          'Usually the secret rather than the token. Check whether your secret is base64-encoded at rest - many frameworks store it that way and decode before signing, so pasting the encoded form fails. Also check for a trailing newline, which a copy from a file or an environment variable commonly carries.',
      },
    ],
  },
  inputs: [JWT_INPUT] as const,
  options: [
    { kind: 'text', key: 'secret', label: 'Signing secret', default: '', placeholder: 'your-256-bit-secret' },
    {
      kind: 'select',
      key: 'secretEncoding',
      label: 'Secret is',
      choices: [
        { value: 'utf8', label: 'Plain text' },
        { value: 'base64url', label: 'Base64 / base64url' },
      ],
      default: 'utf8',
    },
  ],
  run(inputs, options): Result<ToolOutput> {
    const decoded = decodeJwt(inputs[0] ?? '');
    if (!decoded.ok) return decoded;

    const jwt = decoded.value;
    const secret = readString(options, 'secret', '');

    if (jwt.algorithm !== 'HS256') {
      const asymmetric = /^(RS|ES|PS|Ed)/.test(jwt.algorithm);
      return {
        ok: false,
        error: {
          message: `This token uses ${jwt.algorithm}, which this tool cannot verify.`,
          hint: asymmetric
            ? 'Asymmetric algorithms verify with a public key rather than a shared secret. Only the HMAC family is supported here so far.'
            : jwt.algorithm.toLowerCase() === 'none'
              ? 'There is no signature to check: the token is unsigned. That is itself the finding.'
              : 'Only HS256 is supported so far.',
        },
      };
    }

    if (secret.length === 0) {
      return {
        ok: false,
        error: {
          message: 'Enter the signing secret to check the signature.',
          hint: 'It is used here in the page and nowhere else — the page cannot open a network connection.',
        },
      };
    }

    const keyBytes =
      readString(options, 'secretEncoding', 'utf8') === 'base64url'
        ? base64UrlToBytes(secret.replace(/\s+/g, ''))
        : textToBytes(secret);

    const expected = hmacSha256(keyBytes, textToBytes(jwt.signingInput));
    const actual = base64UrlToBytes(jwt.signature);
    const matches = timingSafeEqual(expected, actual);

    const validity = validityOf(jwt.payload, Date.now());
    const lines = matches
      ? [
          'Signature is valid.',
          '',
          `The token really was signed with this secret using ${jwt.algorithm}.`,
          '',
          `Expiry: ${validity.detail}`,
          '',
          'A valid signature means the token is authentic and unmodified. It does not mean the',
          'token is still in date, nor that it was meant for the service checking it - a verifier',
          'still has to check exp and aud itself.',
        ]
      : [
          'Signature does not match.',
          '',
          'Either the secret is wrong or the token was altered after signing.',
          '',
          `Expected: ${bytesToBase64Url(expected)}`,
          `Found:    ${jwt.signature}`,
          '',
          'If the secret is stored base64-encoded, switch the encoding option above — that is the',
          'most common cause. A trailing newline on a copied secret is the second.',
        ];

    return ok({
      content: lines.join('\n') + '\n',
      language: 'text',
      filename: 'jwt-verification.txt',
      stats: [
        { label: 'signature', value: matches ? 'valid' : 'invalid' },
        { label: 'alg', value: jwt.algorithm },
      ],
    });
  },
});

export const jwtTools = [decoderTool, analyzerTool, verifierTool];
