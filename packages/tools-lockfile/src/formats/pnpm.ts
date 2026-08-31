import type { LockEntry } from '../types.js';

/**
 * pnpm-lock.yaml.
 *
 * The package key has shifted across lockfile versions -- "/lodash/4.17.21" in
 * v5, "/lodash@4.17.21" in v6, and a bare "lodash@4.17.21" under `snapshots` in
 * v9 -- so the key is normalised rather than assumed.
 */
export function parsePnpm(root: Record<string, unknown>): {
  entries: LockEntry[];
  lockfileVersion?: string;
  notes: string[];
} {
  const notes: string[] = [];
  const entries: LockEntry[] = [];
  const lockfileVersion =
    root['lockfileVersion'] !== undefined ? String(root['lockfileVersion']) : undefined;

  const packages = root['packages'];
  if (packages === null || typeof packages !== 'object') {
    notes.push('No "packages" section found.');
    return { entries, lockfileVersion, notes };
  }

  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    const parsed = splitKey(key);
    if (!parsed) continue;
    const entry: LockEntry = { name: parsed.name, version: parsed.version };

    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const resolution = record['resolution'];
      if (resolution !== null && typeof resolution === 'object') {
        const res = resolution as Record<string, unknown>;
        if (typeof res['integrity'] === 'string') entry.integrity = res['integrity'];
        if (typeof res['tarball'] === 'string') entry.resolved = res['tarball'];
      }
      // v9 moved the version out of the key for some entries.
      if (typeof record['version'] === 'string') entry.version = record['version'];
    }
    entries.push(entry);
  }

  return { entries, lockfileVersion, notes };
}

/** Handles /name/version, /name@version and name@version, scoped or not. */
export function splitKey(key: string): { name: string; version: string } | undefined {
  let rest = key.startsWith('/') ? key.slice(1) : key;
  // Peer suffixes such as "(react@18.2.0)" are not part of the version.
  const peerIndex = rest.indexOf('(');
  if (peerIndex !== -1) rest = rest.slice(0, peerIndex);

  const at = rest.lastIndexOf('@');
  if (at > 0) {
    const name = rest.slice(0, at);
    const version = rest.slice(at + 1);
    if (name.length > 0 && version.length > 0) return { name, version };
  }

  // v5 style: /@scope/name/1.2.3 or /name/1.2.3
  const slash = rest.lastIndexOf('/');
  if (slash > 0) {
    const name = rest.slice(0, slash);
    const version = rest.slice(slash + 1);
    if (name.length > 0 && /^\d/.test(version)) return { name, version };
  }
  return undefined;
}
