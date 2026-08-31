/**
 * CRC-32 (ISO-HDLC), the checksum inside zip and png. Not a hash: it detects
 * accidental corruption and nothing else, which is worth saying out loud
 * because it sits next to hashes in every tool that offers it.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(message: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of message) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
