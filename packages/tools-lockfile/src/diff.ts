import type { Lockfile, LockEntry } from './types.js';
import { entryKey } from './types.js';
import { classifyChange, sortVersions, type Bump } from './semver.js';

export type ChangeKind = 'added' | 'removed' | 'changed' | 'versions';

export interface PackageChange {
  name: string;
  kind: ChangeKind;
  before?: string;
  after?: string;
  bump?: Bump;
  /** Version sets, when a package is present at several versions. */
  beforeVersions?: string[];
  afterVersions?: string[];
}

export type AlertKind = 'integrity-changed' | 'downgrade' | 'registry-changed' | 'integrity-removed';

export interface Alert {
  kind: AlertKind;
  name: string;
  version?: string;
  detail: string;
  before?: string;
  after?: string;
}

export interface LockDiff {
  changes: PackageChange[];
  alerts: Alert[];
  counts: Record<Bump, number> & { added: number; removed: number };
  totalBefore: number;
  totalAfter: number;
  formatChanged: boolean;
}

const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(url);
  return match?.[1]?.toLowerCase();
};

export function diffLockfiles(before: Lockfile, after: Lockfile): LockDiff {
  const changes: PackageChange[] = [];
  const alerts: Alert[] = [];
  const counts = {
    major: 0, minor: 0, patch: 0, prerelease: 0, downgrade: 0, none: 0, unknown: 0,
    added: 0, removed: 0,
  };

  const names = new Set([...before.byName.keys(), ...after.byName.keys()]);

  for (const name of [...names].sort()) {
    const beforeVersions = before.byName.get(name);
    const afterVersions = after.byName.get(name);

    if (!beforeVersions) {
      changes.push({ name, kind: 'added', after: afterVersions!.join(', '), afterVersions });
      counts.added++;
      continue;
    }
    if (!afterVersions) {
      changes.push({ name, kind: 'removed', before: beforeVersions.join(', '), beforeVersions });
      counts.removed++;
      continue;
    }

    // Versions present on both sides can still differ in what they point at.
    // That is the case worth shouting about: the same version resolving to a
    // different tarball means the artefact changed under a fixed name.
    for (const version of beforeVersions) {
      if (!afterVersions.includes(version)) continue;
      const a = before.entries.get(entryKey(name, version));
      const b = after.entries.get(entryKey(name, version));
      if (!a || !b) continue;
      collectAlerts(a, b, alerts);
    }

    const identical =
      beforeVersions.length === afterVersions.length &&
      beforeVersions.every((v, i) => v === afterVersions[i]);
    if (identical) continue;

    if (beforeVersions.length === 1 && afterVersions.length === 1) {
      const from = beforeVersions[0]!;
      const to = afterVersions[0]!;
      const bump = classifyChange(from, to);
      counts[bump]++;
      changes.push({ name, kind: 'changed', before: from, after: to, bump });
      if (bump === 'downgrade') {
        alerts.push({
          kind: 'downgrade',
          name,
          before: from,
          after: to,
          detail: 'Version moved backwards. Routine when pinning to fix a regression, worth a second look otherwise.',
        });
      }
      continue;
    }

    changes.push({
      name,
      kind: 'versions',
      before: beforeVersions.join(', '),
      after: afterVersions.join(', '),
      beforeVersions: sortVersions(beforeVersions),
      afterVersions: sortVersions(afterVersions),
    });
    counts.unknown++;
  }

  return {
    changes,
    alerts,
    counts,
    totalBefore: before.entries.size,
    totalAfter: after.entries.size,
    formatChanged: before.format !== after.format,
  };
}

function collectAlerts(a: LockEntry, b: LockEntry, alerts: Alert[]): void {
  if (a.integrity && b.integrity && a.integrity !== b.integrity) {
    alerts.push({
      kind: 'integrity-changed',
      name: a.name,
      version: a.version,
      before: a.integrity,
      after: b.integrity,
      detail:
        'Same version, different integrity hash. The published artefact for a fixed version changed, which should not happen. Treat as suspicious until explained.',
    });
  } else if (a.integrity && !b.integrity) {
    alerts.push({
      kind: 'integrity-removed',
      name: a.name,
      version: a.version,
      detail: 'The integrity hash was dropped for this version, so installs are no longer verified against it.',
    });
  }

  const beforeHost = hostOf(a.resolved);
  const afterHost = hostOf(b.resolved);
  if (beforeHost && afterHost && beforeHost !== afterHost) {
    alerts.push({
      kind: 'registry-changed',
      name: a.name,
      version: a.version,
      before: beforeHost,
      after: afterHost,
      detail: 'This version now comes from a different host. Expected when moving to a private registry, and a red flag when not.',
    });
  }
}
