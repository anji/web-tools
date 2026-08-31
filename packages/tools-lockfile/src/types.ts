export type LockFormat = 'npm' | 'pnpm' | 'yarn' | 'yarn-berry';

export interface LockEntry {
  name: string;
  version: string;
  /** Subresource integrity hash, where the format records one. */
  integrity?: string;
  /** Where the tarball came from. A change here is a registry change. */
  resolved?: string;
}

export interface Lockfile {
  format: LockFormat;
  /** The format's own version marker, when it states one. */
  lockfileVersion?: string;
  /** Keyed `name@version`, since a lockfile may hold several versions of one package. */
  entries: Map<string, LockEntry>;
  /** name -> every version present, ascending. */
  byName: Map<string, string[]>;
  /** Parse problems that did not stop the file being read. */
  notes: string[];
}

export const entryKey = (name: string, version: string): string => `${name}@${version}`;
