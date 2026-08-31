export { sha256, timingSafeEqual } from './sha256.js';
export { sha1 } from './sha1.js';
export { md5 } from './md5.js';
export { crc32 } from './crc32.js';
export { hmac, hash, type HashAlgorithm } from './hmac.js';

/** Lowercase hex, the form checksums are published in. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Parses hex or base64, for comparing against a published checksum. */
export function parseDigest(text: string): Uint8Array | undefined {
  const trimmed = text.trim().replace(/\s+/g, '');
  if (trimmed.length === 0) return undefined;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const bytes = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  try {
    const binary = atob(trimmed.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

export { hashTools } from './tools.js';
