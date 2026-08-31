import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, classifyChange, sortVersions } from '../src/semver.js';

const cmp = (a: string, b: string) => compareVersions(parseVersion(a)!, parseVersion(b)!);

describe('parsing', () => {
  it('parses plain and prefixed versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('v1.2.3')?.major).toBe(1);
  });
  it('parses prereleases and ignores build metadata', () => {
    expect(parseVersion('1.0.0-alpha.1')?.prerelease).toEqual(['alpha', '1']);
    expect(parseVersion('1.0.0+build.5')?.prerelease).toEqual([]);
  });
  it('returns undefined for things that are not versions', () => {
    for (const bad of ['latest', '1.2', 'file:../x', '^1.2.3', '']) {
      expect(parseVersion(bad), bad).toBeUndefined();
    }
  });
});

describe('precedence', () => {
  it('orders by major, minor then patch', () => {
    expect(cmp('1.0.0', '2.0.0')).toBe(-1);
    expect(cmp('1.2.0', '1.10.0')).toBe(-1);
    expect(cmp('1.0.10', '1.0.9')).toBe(1);
  });
  it('ranks a prerelease below its release', () => {
    expect(cmp('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(cmp('1.0.0', '1.0.0-alpha')).toBe(1);
  });
  it('follows the spec ordering for prerelease identifiers', () => {
    // From the semver spec's own example chain.
    const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
                   '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(cmp(chain[i]!, chain[i + 1]!), `${chain[i]} < ${chain[i + 1]}`).toBe(-1);
    }
  });
  it('ranks numeric identifiers below alphanumeric ones', () => {
    expect(cmp('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });
  it('ignores build metadata in comparison', () => {
    expect(cmp('1.0.0+a', '1.0.0+b')).toBe(0);
  });
});

describe('change classification', () => {
  it('names the size of a bump', () => {
    expect(classifyChange('1.0.0', '2.0.0')).toBe('major');
    expect(classifyChange('1.0.0', '1.1.0')).toBe('minor');
    expect(classifyChange('1.0.0', '1.0.1')).toBe('patch');
    expect(classifyChange('1.0.0-a', '1.0.0-b')).toBe('prerelease');
  });
  it('calls a move backwards a downgrade whatever its size', () => {
    expect(classifyChange('2.0.0', '1.0.0')).toBe('downgrade');
    expect(classifyChange('1.0.1', '1.0.0')).toBe('downgrade');
    expect(classifyChange('1.0.0', '1.0.0-rc.1')).toBe('downgrade');
  });
  it('reports none and unknown honestly', () => {
    expect(classifyChange('1.0.0', '1.0.0')).toBe('none');
    expect(classifyChange('1.0.0', 'file:../local')).toBe('unknown');
  });
});

describe('sorting', () => {
  it('sorts ascending and parks unparseable versions at the end', () => {
    expect(sortVersions(['2.0.0', 'weird', '1.0.0', '1.0.0-rc.1']))
      .toEqual(['1.0.0-rc.1', '1.0.0', '2.0.0', 'weird']);
  });
});
