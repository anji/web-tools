import { describe, it, expect } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { sha256, hmacSha256, timingSafeEqual } from '../src/hmac.js';

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('sha256', () => {
  it('matches the published empty-string vector', () => {
    expect(hex(sha256(new Uint8Array()))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the published "abc" vector', () => {
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('agrees with node:crypto across lengths that straddle the block boundary', () => {
    // 55/56/64 are where the padding logic changes; get those wrong and short
    // inputs still pass while real tokens fail.
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const input = randomBytes(length);
      const expected = createHash('sha256').update(input).digest('hex');
      expect(hex(sha256(new Uint8Array(input))), `length ${length}`).toBe(expected);
    }
  });

  it('agrees with node:crypto on random input', () => {
    for (let i = 0; i < 50; i++) {
      const input = randomBytes(Math.floor(Math.random() * 500));
      expect(hex(sha256(new Uint8Array(input)))).toBe(
        createHash('sha256').update(input).digest('hex'),
      );
    }
  });
});

describe('hmacSha256', () => {
  it('agrees with node:crypto for keys shorter, equal to and longer than the block', () => {
    for (const keyLength of [0, 1, 32, 63, 64, 65, 200]) {
      for (const messageLength of [0, 10, 64, 200]) {
        const key = randomBytes(keyLength);
        const message = randomBytes(messageLength);
        const expected = createHmac('sha256', key).update(message).digest('hex');
        expect(
          hex(hmacSha256(new Uint8Array(key), new Uint8Array(message))),
          `key ${keyLength}, message ${messageLength}`,
        ).toBe(expected);
      }
    }
  });

  it('matches a known JWT signing vector', () => {
    const signingInput =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ';
    const expected = createHmac('sha256', 'your-256-bit-secret')
      .update(signingInput)
      .digest('base64url');
    const actual = hmacSha256(
      new TextEncoder().encode('your-256-bit-secret'),
      new TextEncoder().encode(signingInput),
    );
    expect(Buffer.from(actual).toString('base64url')).toBe(expected);
  });
});

describe('timingSafeEqual', () => {
  it('compares content, not identity', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
