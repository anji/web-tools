import type { LockEntry } from '../types.js';

/**
 * Yarn Berry (v2+) lockfiles are YAML with keys like "lodash@npm:^4.17.21".
 * The version lives in the body, so the descriptor's range is discarded.
 */
export function parseYarnBerry(root: Record<string, unknown>): {
  entries: LockEntry[];
  lockfileVersion?: string;
  notes: string[];
} {
  const entries: LockEntry[] = [];
  const notes: string[] = [];
  let lockfileVersion: string | undefined;

  for (const [key, value] of Object.entries(root)) {
    if (key === '__metadata') {
      if (value !== null && typeof value === 'object') {
        const meta = value as Record<string, unknown>;
        if (meta['version'] !== undefined) lockfileVersion = String(meta['version']);
      }
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const version = record['version'];
    if (typeof version !== 'string') continue;

    // One entry may satisfy several descriptors: "a@npm:^1, a@npm:~1.2".
    const name = descriptorName(key.split(',')[0]!.trim());
    if (!name) continue;

    const entry: LockEntry = { name, version };
    if (typeof record['checksum'] === 'string') entry.integrity = record['checksum'];
    if (typeof record['resolution'] === 'string') entry.resolved = record['resolution'];
    entries.push(entry);
  }

  return { entries, lockfileVersion, notes };
}

/** "@scope/pkg@npm:^1.0.0" -> "@scope/pkg" */
export function descriptorName(descriptor: string): string | undefined {
  const bare = descriptor.replace(/^"|"$/g, '');
  const at = bare.lastIndexOf('@');
  if (at <= 0) return bare.length > 0 ? bare : undefined;
  return bare.slice(0, at);
}

/**
 * Yarn Classic (v1) is its own indentation-based format rather than YAML:
 *
 *   lodash@^4.17.21:
 *     version "4.17.21"
 *     resolved "https://…"
 *     integrity sha512-…
 */
export function parseYarnClassic(text: string): {
  entries: LockEntry[];
  lockfileVersion?: string;
  notes: string[];
} {
  const entries: LockEntry[] = [];
  const notes: string[] = [];
  const lines = text.split(/\r?\n/);

  let currentName: string | undefined;
  let current: Partial<LockEntry> = {};

  const flush = (): void => {
    if (currentName && typeof current.version === 'string') {
      const entry: LockEntry = { name: currentName, version: current.version };
      if (current.integrity) entry.integrity = current.integrity;
      if (current.resolved) entry.resolved = current.resolved;
      entries.push(entry);
    }
    currentName = undefined;
    current = {};
  };

  for (const raw of lines) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    if (!/^\s/.test(raw)) {
      // A new descriptor block begins at column zero and ends in a colon.
      flush();
      const header = raw.replace(/:\s*$/, '');
      currentName = descriptorName(header.split(',')[0]!.trim());
      continue;
    }

    const match = /^\s+(version|resolved|integrity)\s+"?([^"]*)"?\s*$/.exec(raw);
    if (!match) continue;
    const [, field, value] = match as unknown as [string, string, string];
    if (field === 'version') current.version = value;
    else if (field === 'resolved') current.resolved = value;
    else current.integrity = value;
  }
  flush();

  if (entries.length === 0) notes.push('No package blocks were found.');
  return { entries, lockfileVersion: '1', notes };
}
