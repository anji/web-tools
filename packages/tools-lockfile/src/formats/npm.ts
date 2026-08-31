import type { LockEntry } from '../types.js';

/**
 * package-lock.json, all three layouts.
 *
 * v2 and v3 use a flat `packages` map keyed by install path; v1 uses a nested
 * `dependencies` tree. v2 carries both for backwards compatibility, so the flat
 * map is preferred when present -- it is authoritative and avoids walking the
 * tree twice.
 */
export function parseNpm(root: Record<string, unknown>): {
  entries: LockEntry[];
  lockfileVersion?: string;
  notes: string[];
} {
  const notes: string[] = [];
  const entries: LockEntry[] = [];
  const lockfileVersion =
    root['lockfileVersion'] !== undefined ? String(root['lockfileVersion']) : undefined;

  const packages = root['packages'];
  if (packages !== null && typeof packages === 'object') {
    for (const [path, value] of Object.entries(packages as Record<string, unknown>)) {
      // "" is the project itself, not a dependency.
      if (path === '' || value === null || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      const name = nameFromPath(path, record);
      const version = record['version'];
      if (!name || typeof version !== 'string') continue;
      entries.push(buildEntry(name, version, record));
    }
    return { entries, lockfileVersion, notes };
  }

  const dependencies = root['dependencies'];
  if (dependencies !== null && typeof dependencies === 'object') {
    walkV1(dependencies as Record<string, unknown>, entries);
    return { entries, lockfileVersion, notes };
  }

  notes.push('No "packages" or "dependencies" section found.');
  return { entries, lockfileVersion, notes };
}

/**
 * "node_modules/a/node_modules/b" is package b. Everything before the last
 * node_modules segment is where it was installed, not what it is.
 */
function nameFromPath(path: string, record: Record<string, unknown>): string | undefined {
  if (typeof record['name'] === 'string' && record['name'].length > 0) {
    return record['name'];
  }
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  const name = index === -1 ? path : path.slice(index + marker.length);
  return name.length > 0 ? name : undefined;
}

function buildEntry(name: string, version: string, record: Record<string, unknown>): LockEntry {
  const entry: LockEntry = { name, version };
  if (typeof record['integrity'] === 'string') entry.integrity = record['integrity'];
  if (typeof record['resolved'] === 'string') entry.resolved = record['resolved'];
  return entry;
}

function walkV1(node: Record<string, unknown>, out: LockEntry[]): void {
  for (const [name, value] of Object.entries(node)) {
    if (value === null || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record['version'] === 'string') {
      out.push(buildEntry(name, record['version'], record));
    }
    const nested = record['dependencies'];
    if (nested !== null && typeof nested === 'object') {
      walkV1(nested as Record<string, unknown>, out);
    }
  }
}
