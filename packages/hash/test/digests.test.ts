import { describe, it, expect } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { md5 } from '../src/md5.js';
import { sha1 } from '../src/sha1.js';
import { sha256 } from '../src/sha256.js';
import { crc32 } from '../src/crc32.js';
import { hmac, type HashAlgorithm } from '../src/hmac.js';
import { toHex, parseDigest, textToBytes } from '../src/index.js';
import { hashTools } from '../src/tools.js';
import { defaultOptions } from '@tools/core';

const bytes = (text: string) => new TextEncoder().encode(text);

/** Lengths either side of the 64-byte block and the 56-byte padding boundary. */
const LENGTHS = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 4096];

describe.each([
  ['md5', md5] as const,
  ['sha1', sha1] as const,
  ['sha256', sha256] as const,
])('%s', (name, fn) => {
  it('matches the published empty-input vector', () => {
    expect(toHex(fn(new Uint8Array()))).toBe(createHash(name).update('').digest('hex'));
  });

  it('agrees with node:crypto across block boundaries', () => {
    for (const length of LENGTHS) {
      const input = randomBytes(length);
      expect(toHex(fn(new Uint8Array(input))), `length ${length}`).toBe(
        createHash(name).update(input).digest('hex'),
      );
    }
  });

  it('agrees with node:crypto on random input', () => {
    for (let i = 0; i < 40; i++) {
      const input = randomBytes(Math.floor(Math.random() * 600));
      expect(toHex(fn(new Uint8Array(input)))).toBe(createHash(name).update(input).digest('hex'));
    }
  });

  it('handles multi-byte UTF-8 the same way node does', () => {
    const text = 'Ada 💡 Lovelace — 東京';
    expect(toHex(fn(bytes(text)))).toBe(createHash(name).update(text, 'utf8').digest('hex'));
  });
});

describe('hmac', () => {
  it.each(['md5', 'sha1', 'sha256'] as HashAlgorithm[])(
    'agrees with node:crypto for %s across key lengths',
    (algorithm) => {
      for (const keyLength of [0, 1, 32, 63, 64, 65, 200]) {
        for (const messageLength of [0, 10, 64, 200]) {
          const key = randomBytes(keyLength);
          const message = randomBytes(messageLength);
          expect(
            toHex(hmac(algorithm, new Uint8Array(key), new Uint8Array(message))),
            `${algorithm} key ${keyLength} message ${messageLength}`,
          ).toBe(createHmac(algorithm, key).update(message).digest('hex'));
        }
      }
    },
  );
});

describe('crc32', () => {
  it('matches the standard check value', () => {
    // The CRC-32/ISO-HDLC check value for "123456789".
    expect(crc32(bytes('123456789')).toString(16)).toBe('cbf43926');
  });
  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
  it('changes with a single flipped bit', () => {
    expect(crc32(bytes('hello'))).not.toBe(crc32(bytes('hellp')));
  });
});

describe('digest parsing', () => {
  it('reads a published hex checksum', () => {
    const digest = sha256(bytes('hello'));
    expect(parseDigest(toHex(digest))).toEqual(digest);
  });
  it('reads it with whitespace, as copied from a checksums file', () => {
    expect(toHex(parseDigest('  d41d8c\n d98f00b2 04e98009 98ecf8427e ')!)).toBe(
      'd41d8cd98f00b204e9800998ecf8427e',
    );
  });
  it('reads base64 as well as hex', () => {
    const digest = sha256(bytes('hello'));
    const base64 = Buffer.from(digest).toString('base64');
    expect(parseDigest(base64)).toEqual(digest);
  });
  it('returns undefined for something that is not a digest', () => {
    expect(parseDigest('')).toBeUndefined();
    expect(parseDigest('not a digest!!')).toBeUndefined();
  });
});

describe('textToBytes', () => {
  it('encodes as UTF-8', () => {
    expect(textToBytes('é')).toEqual(new Uint8Array([0xc3, 0xa9]));
  });
});

describe('tools', () => {
  const tool = (id: string) => hashTools.find((t) => t.id === id)!;
  const run = (id: string, input: string, over: Record<string, unknown> = {}) =>
    tool(id).run([input], { ...defaultOptions(tool(id)), ...over } as any);

  it('computes a digest matching node:crypto', () => {
    const result = run('hash-generator', 'hello');
    expect(result.ok && result.value.content).toContain(
      createHash('sha256').update('hello').digest('hex'),
    );
  });

  it('reports MATCH against a correct published checksum', () => {
    const expected = createHash('sha256').update('hello').digest('hex');
    const result = run('hash-generator', 'hello', { expected });
    expect(result.ok && result.value.content).toMatch(/^MATCH/);
  });

  it('reports NO MATCH and names the likely cause on a length mismatch', () => {
    const md5Hex = createHash('md5').update('hello').digest('hex');
    const result = run('hash-generator', 'hello', { expected: md5Hex });
    expect(result.ok && result.value.content).toMatch(/^NO MATCH/);
    expect(result.ok && result.value.content).toMatch(/right algorithm/);
  });

  it('computes an HMAC matching node:crypto', () => {
    const result = run('hmac-generator', 'payload', { secret: 'k' });
    expect(result.ok && result.value.content).toContain(
      createHmac('sha256', 'k').update('payload').digest('hex'),
    );
  });

  it('strips the algorithm prefix providers put on signatures', () => {
    const sig = createHmac('sha256', 'k').update('payload').digest('hex');
    const result = run('hmac-generator', 'payload', { secret: 'k', expected: `sha256=${sig}` });
    expect(result.ok && result.value.content).toMatch(/^MATCH/);
  });

  it('asks for the secret rather than signing with an empty one', () => {
    const result = run('hmac-generator', 'payload');
    expect(result.ok).toBe(false);
  });
});
