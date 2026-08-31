import { describe, it, expect } from 'vitest';
import { parseLockfile } from '../src/detect.js';
import { diffLockfiles } from '../src/diff.js';
import { renderDiff } from '../src/render.js';

const npm = (packages: Record<string, unknown>) =>
  JSON.stringify({ name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' }, ...packages } });

const pkg = (path: string, version: string, extra: Record<string, unknown> = {}) =>
  ({ [`node_modules/${path}`]: { version, ...extra } });

const lock = (text: string) => {
  const r = parseLockfile(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const diff = (a: string, b: string) => diffLockfiles(lock(a), lock(b));

describe('version changes', () => {
  it('classifies each size of bump', () => {
    const d = diff(
      npm({ ...pkg('a', '1.0.0'), ...pkg('b', '1.0.0'), ...pkg('c', '1.0.0') }),
      npm({ ...pkg('a', '2.0.0'), ...pkg('b', '1.1.0'), ...pkg('c', '1.0.1') }),
    );
    const byName = Object.fromEntries(d.changes.map((c) => [c.name, c.bump]));
    expect(byName).toEqual({ a: 'major', b: 'minor', c: 'patch' });
    expect(d.counts.major).toBe(1);
  });

  it('reports added and removed packages', () => {
    const d = diff(npm(pkg('gone', '1.0.0')), npm(pkg('fresh', '2.0.0')));
    expect(d.changes.find((c) => c.name === 'fresh')?.kind).toBe('added');
    expect(d.changes.find((c) => c.name === 'gone')?.kind).toBe('removed');
    expect(d.counts.added).toBe(1);
    expect(d.counts.removed).toBe(1);
  });

  it('says nothing changed when nothing changed', () => {
    const same = npm(pkg('a', '1.0.0'));
    expect(diff(same, same).changes).toHaveLength(0);
  });

  it('handles a package present at several versions', () => {
    const d = diff(
      npm({ ...pkg('lodash', '3.10.1'), ...pkg('x/node_modules/lodash', '4.17.20') }),
      npm({ ...pkg('lodash', '4.17.21') }),
    );
    const change = d.changes.find((c) => c.name === 'lodash');
    expect(change?.kind).toBe('versions');
    expect(change?.beforeVersions).toEqual(['3.10.1', '4.17.20']);
  });
});

describe('security alerts', () => {
  it('flags the same version resolving to a different integrity hash', () => {
    const d = diff(
      npm(pkg('lodash', '4.17.21', { integrity: 'sha512-ORIGINAL' })),
      npm(pkg('lodash', '4.17.21', { integrity: 'sha512-DIFFERENT' })),
    );
    const alert = d.alerts.find((a) => a.kind === 'integrity-changed');
    expect(alert?.name).toBe('lodash');
    expect(alert?.detail).toMatch(/should not happen/i);
    // The version itself did not change, so it is not a version change.
    expect(d.changes).toHaveLength(0);
  });

  it('flags an integrity hash that was dropped', () => {
    const d = diff(
      npm(pkg('a', '1.0.0', { integrity: 'sha512-AAA' })),
      npm(pkg('a', '1.0.0')),
    );
    expect(d.alerts.find((x) => x.kind === 'integrity-removed')).toBeDefined();
  });

  it('flags a downgrade separately from its size', () => {
    const d = diff(npm(pkg('a', '2.0.0')), npm(pkg('a', '1.9.0')));
    expect(d.changes[0]?.bump).toBe('downgrade');
    expect(d.alerts.find((x) => x.kind === 'downgrade')).toBeDefined();
  });

  it('flags a version that changed registry host', () => {
    const d = diff(
      npm(pkg('a', '1.0.0', { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' })),
      npm(pkg('a', '1.0.0', { resolved: 'https://evil.example.com/a/-/a-1.0.0.tgz' })),
    );
    const alert = d.alerts.find((x) => x.kind === 'registry-changed');
    expect(alert?.before).toBe('registry.npmjs.org');
    expect(alert?.after).toBe('evil.example.com');
  });

  it('does not flag a registry path change on the same host', () => {
    const d = diff(
      npm(pkg('a', '1.0.0', { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' })),
      npm(pkg('a', '1.0.0', { resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz?x=1' })),
    );
    expect(d.alerts).toHaveLength(0);
  });

  it('stays quiet on an ordinary upgrade', () => {
    const d = diff(
      npm(pkg('a', '1.0.0', { integrity: 'sha512-AAA' })),
      npm(pkg('a', '1.0.1', { integrity: 'sha512-BBB' })),
    );
    // A new version legitimately has a new hash — that is not an alert.
    expect(d.alerts).toHaveLength(0);
    expect(d.changes[0]?.bump).toBe('patch');
  });
});

describe('rendering', () => {
  const render = (a: string, b: string, over = {}) =>
    renderDiff(lock(a), lock(b), diff(a, b), { hidePatch: false, alertsOnly: false, ...over });

  it('leads with the summary and the security section', () => {
    const out = render(
      npm(pkg('a', '1.0.0', { integrity: 'sha512-AAA' })),
      npm(pkg('a', '1.0.0', { integrity: 'sha512-BBB' })),
    );
    expect(out).toMatch(/^0 packages changed/);
    expect(out).toContain('SECURITY (1)');
    expect(out).toContain('heuristics');
  });

  it('says so plainly when there is nothing to report', () => {
    const out = render(npm(pkg('a', '1.0.0')), npm(pkg('a', '1.0.0')));
    expect(out).toContain('No integrity, downgrade or registry alerts.');
    expect(out).toContain('No package versions differ');
  });

  it('can hide the patch noise', () => {
    const before = npm({ ...pkg('a', '1.0.0'), ...pkg('b', '1.0.0') });
    const after = npm({ ...pkg('a', '2.0.0'), ...pkg('b', '1.0.1') });
    const out = render(before, after, { hidePatch: true });
    expect(out).toContain('MAJOR (1)');
    expect(out).not.toContain('PATCH (1)');
    expect(out).toContain('1 patch update hidden');
  });

  it('can show only the alerts', () => {
    const out = render(
      npm({ ...pkg('a', '1.0.0'), ...pkg('b', '2.0.0', { integrity: 'sha512-X' }) }),
      npm({ ...pkg('a', '9.0.0'), ...pkg('b', '2.0.0', { integrity: 'sha512-Y' }) }),
      { alertsOnly: true },
    );
    expect(out).toContain('SECURITY (1)');
    expect(out).not.toContain('MAJOR');
  });

  it('notes when the two files are different package managers', () => {
    const pnpmText = `lockfileVersion: '6.0'\n\npackages:\n\n  /a@1.0.0:\n    resolution: {integrity: sha512-AAA}\n`;
    const d = diffLockfiles(lock(npm(pkg('a', '1.0.0'))), lock(pnpmText));
    expect(d.formatChanged).toBe(true);
    expect(renderDiff(lock(npm(pkg('a', '1.0.0'))), lock(pnpmText), d, { hidePatch: false, alertsOnly: false }))
      .toMatch(/Format changed: npm → pnpm/);
  });
});
