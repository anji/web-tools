import type { LockDiff, PackageChange } from './diff.js';
import type { Lockfile } from './types.js';
import type { Bump } from './semver.js';

const HEADINGS: Array<[Bump, string]> = [
  ['downgrade', 'DOWNGRADED'],
  ['major', 'MAJOR'],
  ['minor', 'MINOR'],
  ['patch', 'PATCH'],
  ['prerelease', 'PRERELEASE'],
];

const pad = (changes: readonly PackageChange[]): number =>
  changes.reduce((max, c) => Math.max(max, c.name.length), 0);

export interface RenderOptions {
  /** Hide patch-level bumps, which are usually the bulk of a lockfile diff. */
  hidePatch: boolean;
  /** Show only the security alerts. */
  alertsOnly: boolean;
}

export function renderDiff(
  before: Lockfile,
  after: Lockfile,
  diff: LockDiff,
  options: RenderOptions,
): string {
  const lines: string[] = [];
  const changed = diff.changes.length;

  lines.push(
    `${changed} package${changed === 1 ? '' : 's'} changed` +
      `  ·  ${diff.counts.added} added` +
      `  ·  ${diff.counts.removed} removed` +
      `  ·  ${diff.totalBefore} → ${diff.totalAfter} total`,
  );
  if (diff.formatChanged) {
    lines.push(`Format changed: ${before.format} → ${after.format}. Comparing across package managers is approximate.`);
  }
  lines.push('');

  if (diff.alerts.length > 0) {
    lines.push(`SECURITY (${diff.alerts.length})`);
    for (const alert of diff.alerts) {
      lines.push(`  ${alert.name}${alert.version ? `  ${alert.version}` : ''}`);
      lines.push(`      ${alert.detail}`);
      if (alert.before && alert.after) {
        lines.push(`      was  ${truncate(alert.before)}`);
        lines.push(`      now  ${truncate(alert.after)}`);
      }
    }
    lines.push('');
  } else {
    lines.push('No integrity, downgrade or registry alerts.', '');
  }

  if (options.alertsOnly) {
    return lines.join('\n') + trailer(diff);
  }

  for (const [bump, heading] of HEADINGS) {
    if (bump === 'patch' && options.hidePatch) continue;
    const group = diff.changes.filter((c) => c.kind === 'changed' && c.bump === bump);
    if (group.length === 0) continue;
    const width = pad(group);
    lines.push(`${heading} (${group.length})`);
    for (const c of group) {
      lines.push(`  ${c.name.padEnd(width)}  ${c.before} → ${c.after}`);
    }
    lines.push('');
  }

  if (options.hidePatch && diff.counts.patch > 0) {
    lines.push(`${diff.counts.patch} patch update${diff.counts.patch === 1 ? '' : 's'} hidden.`, '');
  }

  const multi = diff.changes.filter((c) => c.kind === 'versions');
  if (multi.length > 0) {
    const width = pad(multi);
    lines.push(`VERSION SETS (${multi.length})`);
    for (const c of multi) lines.push(`  ${c.name.padEnd(width)}  ${c.before} → ${c.after}`);
    lines.push('');
  }

  for (const [kind, heading] of [['added', 'ADDED'], ['removed', 'REMOVED']] as const) {
    const group = diff.changes.filter((c) => c.kind === kind);
    if (group.length === 0) continue;
    const width = pad(group);
    lines.push(`${heading} (${group.length})`);
    for (const c of group) {
      lines.push(`  ${c.name.padEnd(width)}  ${kind === 'added' ? c.after : c.before}`);
    }
    lines.push('');
  }

  if (changed === 0) lines.push('No package versions differ between these two lockfiles.', '');

  return lines.join('\n') + trailer(diff);
}

const truncate = (text: string): string => (text.length > 72 ? text.slice(0, 69) + '…' : text);

const trailer = (diff: LockDiff): string =>
  diff.alerts.length > 0
    ? '\nAlerts are heuristics on the lockfile alone. They cannot tell you whether a change\nwas legitimate — only that it is the kind worth asking about.\n'
    : '\n';
