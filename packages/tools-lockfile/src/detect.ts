import { parse as parseYaml } from 'yaml';
import { ok, err } from '@tools/core';
import type { Result } from '@tools/core';
import type { Lockfile, LockEntry, LockFormat } from './types.js';
import { entryKey } from './types.js';
import { sortVersions } from './semver.js';
import { parseNpm } from './formats/npm.js';
import { parsePnpm } from './formats/pnpm.js';
import { parseYarnBerry, parseYarnClassic } from './formats/yarn.js';

/** Identifies the format from the content, since a paste carries no filename. */
export function detectFormat(text: string): LockFormat | undefined {
  const head = text.slice(0, 4096);
  if (/^\s*\{/.test(text)) {
    if (/"lockfileVersion"/.test(head) || /"packages"\s*:/.test(head)) return 'npm';
    return 'npm';
  }
  if (/^#\s*yarn lockfile v1/m.test(head) || /^# yarn lockfile/m.test(head)) return 'yarn';
  if (/^__metadata:/m.test(head)) return 'yarn-berry';
  if (/^lockfileVersion:/m.test(head)) return 'pnpm';
  // A berry lockfile without __metadata still uses npm: descriptors.
  if (/^"?[^\s:]+@npm:/m.test(head)) return 'yarn-berry';
  if (/^\s+version\s+"/m.test(head)) return 'yarn';
  return undefined;
}

export function parseLockfile(text: string, forced?: LockFormat): Result<Lockfile> {
  if (text.trim().length === 0) {
    return err({ message: 'Nothing to read yet.', hint: 'Paste or drop a lockfile.' });
  }

  const format = forced ?? detectFormat(text);
  if (!format) {
    return err({
      message: 'Could not tell which kind of lockfile this is.',
      hint: 'Supported: package-lock.json, pnpm-lock.yaml, yarn.lock (v1 and Berry). Pick the format explicitly if detection is wrong.',
    });
  }

  let parsed: { entries: LockEntry[]; lockfileVersion?: string; notes: string[] };

  try {
    if (format === 'npm') {
      const root = JSON.parse(text) as unknown;
      if (root === null || typeof root !== 'object') {
        return err({ message: 'The file parsed as JSON but is not an object.' });
      }
      parsed = parseNpm(root as Record<string, unknown>);
    } else if (format === 'yarn') {
      parsed = parseYarnClassic(text);
    } else {
      const root = parseYaml(text) as unknown;
      if (root === null || typeof root !== 'object') {
        return err({ message: 'The file parsed as YAML but is not a mapping.' });
      }
      parsed =
        format === 'pnpm'
          ? parsePnpm(root as Record<string, unknown>)
          : parseYarnBerry(root as Record<string, unknown>);
    }
  } catch (e) {
    return err({
      message: `Could not read this as ${format}: ${e instanceof Error ? e.message : String(e)}`,
      hint: 'A partial copy-paste is the usual cause — lockfiles have to be complete to parse.',
    });
  }

  if (parsed.entries.length === 0) {
    return err({
      message: `Read the file as ${format}, but found no packages in it.`,
      hint: parsed.notes.join(' ') || 'The file may be empty or of a layout this tool does not know.',
    });
  }

  const entries = new Map<string, LockEntry>();
  const versions = new Map<string, Set<string>>();
  for (const entry of parsed.entries) {
    entries.set(entryKey(entry.name, entry.version), entry);
    const set = versions.get(entry.name) ?? new Set<string>();
    set.add(entry.version);
    versions.set(entry.name, set);
  }

  const byName = new Map<string, string[]>();
  for (const [name, set] of versions) byName.set(name, sortVersions([...set]));

  const lockfile: Lockfile = { format, entries, byName, notes: parsed.notes };
  if (parsed.lockfileVersion !== undefined) lockfile.lockfileVersion = parsed.lockfileVersion;
  return ok(lockfile);
}
