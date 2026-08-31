/**
 * Just enough semver to classify a version change.
 *
 * Not a full range resolver -- lockfiles record exact versions, so all that is
 * needed is parse and compare. Written here rather than pulled in because the
 * whole comparison surface is a hundred lines and a dependency that itself has
 * dependencies is a poor look in a supply-chain tool.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseVersion(text: string): Version | undefined {
  const match = PATTERN.exec(text.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** -1, 0 or 1, following the semver precedence rules. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // A version with a prerelease has lower precedence than one without.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    // A larger set of fields wins when all preceding fields are equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (x !== y) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export type Bump = 'major' | 'minor' | 'patch' | 'prerelease' | 'downgrade' | 'none' | 'unknown';

/**
 * Classifies a version change. A move backwards is called out separately
 * rather than folded into its size: an unexplained downgrade in a lockfile is
 * more interesting than a routine bump, whatever its magnitude.
 */
export function classifyChange(before: string, after: string): Bump {
  if (before === after) return 'none';

  const a = parseVersion(before);
  const b = parseVersion(after);
  if (!a || !b) return 'unknown';

  const direction = compareVersions(a, b);
  if (direction === 0) return 'none';
  if (direction > 0) return 'downgrade';

  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch) return 'patch';
  return 'prerelease';
}

/** Sorts version strings ascending, leaving unparseable ones at the end. */
export function sortVersions(versions: readonly string[]): string[] {
  return [...versions].sort((x, y) => {
    const a = parseVersion(x);
    const b = parseVersion(y);
    if (!a && !b) return x < y ? -1 : x > y ? 1 : 0;
    if (!a) return 1;
    if (!b) return -1;
    return compareVersions(a, b);
  });
}
