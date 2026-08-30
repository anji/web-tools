import { ok, err } from '@tools/core';
import type { Result } from '@tools/core';
import { base64UrlToText, isBase64Url } from './base64url.js';

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: unknown;
  /** The signature, left as base64url -- it is bytes, not text. */
  signature: string;
  /** header.payload, which is what the signature is actually computed over. */
  signingInput: string;
  algorithm: string;
  type?: string;
  keyId?: string;
}

function parseSegment(
  segment: string,
  label: string,
): Result<Record<string, unknown> | unknown> {
  if (!isBase64Url(segment)) {
    return err({
      message: `The ${label} is not valid base64url.`,
      hint: 'base64url allows A-Z, a-z, 0-9, - and _ only. A + or / means the token was encoded with plain base64, and a trailing = means the padding was not stripped.',
    });
  }
  let text: string;
  try {
    text = base64UrlToText(segment);
  } catch {
    return err({ message: `The ${label} could not be decoded.` });
  }
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return err({
      message: `The ${label} decoded, but is not valid JSON.`,
      hint: `It decoded to: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
    });
  }
}

export function decodeJwt(input: string): Result<DecodedJwt> {
  const token = input.trim().replace(/^Bearer\s+/i, '');

  if (token.length === 0) {
    return err({ message: 'Nothing to decode yet.', hint: 'Paste a JWT to get started.' });
  }

  const parts = token.split('.');

  if (parts.length === 5) {
    return err({
      message: 'This is a JWE, not a JWS.',
      hint: 'Five segments means the payload is encrypted rather than merely signed. There is nothing to read without the decryption key -- no tool can decode it, here or anywhere.',
    });
  }

  if (parts.length !== 3) {
    return err({
      message: `A JWT has three dot-separated segments; this has ${parts.length}.`,
      hint:
        parts.length === 1
          ? 'No dots at all -- this may be an opaque session token or an API key rather than a JWT.'
          : 'A truncated copy-paste is the usual cause. Check nothing was cut off at either end.',
    });
  }

  const [headerPart, payloadPart, signature] = parts as [string, string, string];

  const header = parseSegment(headerPart, 'header');
  if (!header.ok) return header;
  if (header.value === null || typeof header.value !== 'object' || Array.isArray(header.value)) {
    return err({ message: 'The header decoded to something other than a JSON object.' });
  }

  const payload = parseSegment(payloadPart, 'payload');
  if (!payload.ok) return payload;

  const headerObject = header.value as Record<string, unknown>;
  const alg = headerObject['alg'];
  const typ = headerObject['typ'];
  const kid = headerObject['kid'];

  return ok({
    header: headerObject,
    payload: payload.value,
    signature,
    signingInput: `${headerPart}.${payloadPart}`,
    algorithm: typeof alg === 'string' ? alg : 'unknown',
    ...(typeof typ === 'string' ? { type: typ } : {}),
    ...(typeof kid === 'string' ? { keyId: kid } : {}),
  });
}
