/**
 * base64url, the encoding JWT uses: the base64 alphabet with - and _ swapped
 * in, and the padding dropped. Decoding with a plain base64 routine silently
 * mangles any token containing those characters, which is a common enough bug
 * that a token "looking corrupt" is usually the decoder's fault.
 */

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function isBase64Url(input: string): boolean {
  return BASE64URL.test(input);
}

export function base64UrlToBytes(input: string): Uint8Array {
  const standard = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes to text, treating the payload as UTF-8 as the spec requires. */
export function base64UrlToText(input: string): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(base64UrlToBytes(input));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function textToBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}
