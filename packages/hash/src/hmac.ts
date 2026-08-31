import { sha256 } from './sha256.js';
import { sha1 } from './sha1.js';
import { md5 } from './md5.js';

export type HashAlgorithm = 'sha256' | 'sha1' | 'md5';

const DIGEST_SIZE: Record<HashAlgorithm, number> = { sha256: 32, sha1: 20, md5: 16 };
const BLOCK_SIZE = 64; // All three use a 512-bit block.

const HASHES: Record<HashAlgorithm, (input: Uint8Array) => Uint8Array> = {
  sha256,
  sha1,
  md5,
};

export function hash(algorithm: HashAlgorithm, message: Uint8Array): Uint8Array {
  return HASHES[algorithm](message);
}

/** Generic HMAC, replacing the SHA-256-only version this package grew from. */
export function hmac(
  algorithm: HashAlgorithm,
  key: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  const digest = HASHES[algorithm];
  let normalised = key;
  if (normalised.length > BLOCK_SIZE) normalised = digest(normalised);

  const padded = new Uint8Array(BLOCK_SIZE);
  padded.set(normalised);

  const inner = new Uint8Array(BLOCK_SIZE + message.length);
  const outer = new Uint8Array(BLOCK_SIZE + DIGEST_SIZE[algorithm]);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    inner[i] = padded[i]! ^ 0x36;
    outer[i] = padded[i]! ^ 0x5c;
  }
  inner.set(message, BLOCK_SIZE);
  outer.set(digest(inner), BLOCK_SIZE);
  return digest(outer);
}
