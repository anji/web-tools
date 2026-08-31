import { defineTool, ok, readString, type Result, type ToolOutput } from '@tools/core';
import { hash, hmac, type HashAlgorithm } from './hmac.js';
import { crc32 } from './crc32.js';
import { timingSafeEqual } from './sha256.js';
import { toHex, toBase64, textToBytes, parseDigest } from './index.js';

const TEXT_INPUT = {
  label: 'Text',
  placeholder: 'Anything you want a digest of',
  language: 'text' as const,
  accept: ['.txt', '.json', '.md'] as const,
};

const PRIVACY_FAQ = {
  question: 'Is what I paste sent anywhere?',
  answer:
    'No. The digest is computed in your browser, and the page cannot open a network connection — its Content-Security-Policy sets connect-src to ‘none’. That is the point for this tool in particular: people hash secrets, tokens and payloads to compare them, and every online hash generator that computes server-side receives the plaintext first.',
};

const BINARY_FAQ = {
  question: 'Can I hash a binary file, like a downloaded release?',
  answer:
    'Not yet, and it is better to say so than to quietly return the wrong answer. Files here are read as UTF-8 text, and any byte sequence that is not valid UTF-8 is replaced during decoding — so a digest of a zip or an installer would be computed over corrupted input and would never match the published checksum. Use shasum or certutil locally for binaries until this handles bytes properly.',
};

const ALGORITHM_OPTION = {
  kind: 'select' as const,
  key: 'algorithm',
  label: 'Algorithm',
  choices: [
    { value: 'sha256', label: 'SHA-256' },
    { value: 'sha1', label: 'SHA-1' },
    { value: 'md5', label: 'MD5' },
  ],
  default: 'sha256',
};

const readAlgorithm = (value: string): HashAlgorithm =>
  value === 'md5' || value === 'sha1' ? value : 'sha256';

const hashTool = defineTool({
  id: 'hash-generator',
  slug: 'hash-generator',
  label: 'Hash generator',
  blurb: 'Compute SHA-256, SHA-1, MD5 and CRC-32, and check one against a published value.',
  category: 'Crypto',
  seo: {
    title: 'SHA-256, MD5 and SHA-1 Hash Generator - Computed In Your Browser',
    description:
      'Generate SHA-256, SHA-1, MD5 and CRC-32 digests in your browser, in hex or base64, and compare against a published checksum. The text never leaves the page.',
    heading: 'Hash Generator',
    intro:
      'Compute a digest of some text, or paste a published checksum alongside it and get a straight answer on whether they match. Every algorithm here is checked against the platform’s own crypto library in this project’s tests.',
    keywords: ['sha256 generator', 'md5 hash generator', 'sha1 hash online', 'checksum calculator', 'hash generator online'],
    faq: [
      PRIVACY_FAQ,
      BINARY_FAQ,
      {
        question: 'Why offer MD5 and SHA-1 at all?',
        answer:
          'Because they are still what a great many projects publish beside their downloads, and Git object ids are SHA-1. Both are broken for anything adversarial — MD5 collisions are trivial and SHA-1 collisions have been demonstrated — so use them to verify against an existing published value, never to sign or store anything.',
      },
      {
        question: 'Is CRC-32 a hash?',
        answer:
          'No, and it sits here only because it appears beside hashes everywhere. It is a checksum for catching accidental corruption in zip and png files. It is trivial to forge deliberately, so it tells you a file was not damaged in transit and nothing more.',
      },
    ],
  },
  inputs: [TEXT_INPUT] as const,
  options: [
    ALGORITHM_OPTION,
    {
      kind: 'select',
      key: 'encoding',
      label: 'Output',
      choices: [
        { value: 'hex', label: 'Hex' },
        { value: 'base64', label: 'Base64' },
      ],
      default: 'hex',
    },
    { kind: 'text', key: 'expected', label: 'Expected checksum', default: '', placeholder: 'paste to verify' },
  ],
  run(inputs, options): Result<ToolOutput> {
    const text = inputs[0] ?? '';
    if (text.length === 0) {
      return { ok: false, error: { message: 'Nothing to hash yet.', hint: 'Paste some text to get started.' } };
    }

    const bytes = textToBytes(text);
    const algorithm = readAlgorithm(readString(options, 'algorithm', 'sha256'));
    const useHex = readString(options, 'encoding', 'hex') !== 'base64';

    const digest = hash(algorithm, bytes);
    const rendered = useHex ? toHex(digest) : toBase64(digest);

    const lines = [
      `${algorithm.toUpperCase()}  ${rendered}`,
      `CRC-32    ${crc32(bytes).toString(16).padStart(8, '0')}`,
      '',
      `${bytes.length} byte${bytes.length === 1 ? '' : 's'} of UTF-8 input`,
    ];

    const stats: Array<{ label: string; value: string }> = [
      { label: algorithm, value: rendered.slice(0, 16) + '…' },
    ];

    const expectedRaw = readString(options, 'expected', '').trim();
    if (expectedRaw.length > 0) {
      const expected = parseDigest(expectedRaw);
      if (!expected) {
        lines.unshift('The expected value could not be read as hex or base64.', '');
      } else {
        const matches = timingSafeEqual(digest, expected);
        lines.unshift(matches ? 'MATCH' : 'NO MATCH', '');
        if (!matches) {
          lines.push(
            '',
            expected.length !== digest.length
              ? `The expected value is ${expected.length} bytes but ${algorithm.toUpperCase()} produces ${digest.length} — check you picked the right algorithm.`
              : 'Same length, different content. A trailing newline on the input is the usual cause when comparing file contents.',
          );
        }
        stats.unshift({ label: 'verify', value: matches ? 'match' : 'no match' });
      }
    }

    return ok({ content: lines.join('\n') + '\n', language: 'text', filename: 'digest.txt', stats });
  },
});

const hmacTool = defineTool({
  id: 'hmac-generator',
  slug: 'hmac-generator',
  label: 'HMAC generator',
  blurb: 'Sign a payload with a shared secret, without the secret leaving the tab.',
  category: 'Crypto',
  seo: {
    title: 'HMAC Generator - SHA-256, SHA-1 and MD5, Computed Locally',
    description:
      'Generate an HMAC over a payload with your shared secret, in hex or base64. Computed in your browser, with the key never transmitted.',
    heading: 'HMAC Generator',
    intro:
      'Compute an HMAC to check a webhook signature or reproduce one a service expects. The secret is typed here and used here — the page is forbidden from opening a network connection at all.',
    keywords: ['hmac generator', 'hmac sha256 online', 'webhook signature generator', 'calculate hmac', 'hmac calculator'],
    faq: [
      {
        question: 'Am I safe pasting a real signing secret?',
        answer:
          'Judge it rather than trusting it. The computation is a pure function in page JavaScript and the page ships a Content-Security-Policy of connect-src ‘none’, so the browser blocks any request it might attempt — a restriction the page cannot lift on itself. Load it, disconnect from the network, and it still works. Every deploy is gated on an automated check that tries to exfiltrate by each available route and fails the release if any succeeds.',
      },
      {
        question: 'My webhook signature does not match. What now?',
        answer:
          'Almost always the payload rather than the key. Signatures are computed over the exact raw request body — before any JSON parse and re-serialise, which reorders keys and changes whitespace. Check for a trailing newline too, and whether the provider prefixes the signature with something like "sha256=" that has to be stripped before comparing.',
      },
      BINARY_FAQ,
    ],
  },
  inputs: [TEXT_INPUT] as const,
  options: [
    { kind: 'text', key: 'secret', label: 'Secret', default: '', placeholder: 'shared signing secret' },
    ALGORITHM_OPTION,
    {
      kind: 'select',
      key: 'encoding',
      label: 'Output',
      choices: [
        { value: 'hex', label: 'Hex' },
        { value: 'base64', label: 'Base64' },
      ],
      default: 'hex',
    },
    { kind: 'text', key: 'expected', label: 'Expected signature', default: '', placeholder: 'paste to verify' },
  ],
  run(inputs, options): Result<ToolOutput> {
    const text = inputs[0] ?? '';
    if (text.length === 0) {
      return { ok: false, error: { message: 'Nothing to sign yet.', hint: 'Paste the payload to get started.' } };
    }
    const secret = readString(options, 'secret', '');
    if (secret.length === 0) {
      return {
        ok: false,
        error: {
          message: 'Enter the shared secret.',
          hint: 'It is used here in the page and nowhere else — the page cannot open a network connection.',
        },
      };
    }

    const algorithm = readAlgorithm(readString(options, 'algorithm', 'sha256'));
    const useHex = readString(options, 'encoding', 'hex') !== 'base64';
    const digest = hmac(algorithm, textToBytes(secret), textToBytes(text));
    const rendered = useHex ? toHex(digest) : toBase64(digest);

    const lines = [`HMAC-${algorithm.toUpperCase()}  ${rendered}`];
    const stats: Array<{ label: string; value: string }> = [
      { label: 'hmac', value: rendered.slice(0, 16) + '…' },
    ];

    const expectedRaw = readString(options, 'expected', '').trim();
    if (expectedRaw.length > 0) {
      // Providers commonly prefix the algorithm, as in "sha256=abc…".
      const stripped = expectedRaw.replace(/^(sha256|sha1|md5)=/i, '');
      const expected = parseDigest(stripped);
      if (!expected) {
        lines.unshift('The expected signature could not be read as hex or base64.', '');
      } else {
        const matches = timingSafeEqual(digest, expected);
        lines.unshift(matches ? 'MATCH' : 'NO MATCH', '');
        if (!matches) {
          lines.push(
            '',
            'Signatures are computed over the exact raw body. If the payload here was',
            're-serialised from JSON, the bytes differ from what was signed even when the',
            'data is identical.',
          );
        }
        stats.unshift({ label: 'verify', value: matches ? 'match' : 'no match' });
      }
    }

    return ok({ content: lines.join('\n') + '\n', language: 'text', filename: 'hmac.txt', stats });
  },
});

export const hashTools = [hashTool, hmacTool];
