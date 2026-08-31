import { defineTool, ok, readBoolean, readString, type Result, type ToolOutput } from '@tools/core';
import { parseLockfile } from './detect.js';
import { diffLockfiles } from './diff.js';
import { renderDiff } from './render.js';
import type { LockFormat } from './types.js';

const LOCK_INPUT = (label: string) => ({
  label,
  placeholder: 'Paste package-lock.json, pnpm-lock.yaml or yarn.lock',
  language: 'text' as const,
  accept: ['.json', '.yaml', '.lock', '.txt'] as const,
});

const PRIVACY_FAQ = {
  question: 'Is my lockfile uploaded anywhere?',
  answer:
    'No. Both files are parsed in your browser as pure functions, and the page is served with a Content-Security-Policy of connect-src ‘none’, so it cannot open a network connection at all. That matters here because a lockfile is a map of your dependency surface, and private ones name your internal registry.',
};

const diffTool = defineTool({
  id: 'lockfile-diff',
  slug: 'lockfile-diff',
  label: 'Lockfile diff',
  blurb: 'See what actually changed between two lockfiles, and what should worry you.',
  category: 'Inspect',
  seo: {
    title: 'Lockfile Diff - What Actually Changed in package-lock.json',
    description:
      'Compare two lockfiles and get the real answer: which packages were added, removed, upgraded or downgraded, grouped by semver impact — plus integrity and registry changes worth a second look. npm, pnpm and yarn. Nothing uploaded.',
    heading: 'Lockfile Diff',
    intro:
      'A lockfile diff in a pull request is thousands of unreadable lines. Paste both versions here and get the question everyone actually asks: which packages changed, by how much, and is any of it suspicious.',
    keywords: [
      'lockfile diff',
      'package-lock.json diff',
      'compare package-lock',
      'pnpm-lock diff',
      'yarn.lock diff',
    ],
    faq: [
      PRIVACY_FAQ,
      {
        question: 'Why does a changed integrity hash matter?',
        answer:
          'Because a published version is supposed to be immutable. If the same version resolves to a different hash than it did before, the artefact behind that fixed version changed — and your build now installs something different while every version number stayed the same. That is worth an explanation before it is merged, and it is exactly the change a line-by-line diff buries.',
      },
      {
        question: 'Which lockfiles are supported?',
        answer:
          'package-lock.json in all three layouts, pnpm-lock.yaml, and yarn.lock in both the classic v1 format and Berry. The format is detected from the content, so you can paste without saying which is which — and you can compare across package managers, though the result is approximate when you do.',
      },
      {
        question: 'What counts as an alert?',
        answer:
          'Four things: the same version with a different integrity hash, an integrity hash that was dropped entirely, a version that moved backwards, and a version now resolving from a different host. They are heuristics on the lockfile alone — they tell you a change is the kind worth asking about, not that it is malicious.',
      },
      {
        question: 'It is mostly patch bumps. Can I hide those?',
        answer:
          'Yes — they are usually the bulk of a lockfile diff and rarely the reason you are looking. Hide them to leave the major, minor and downgraded changes, or switch to alerts only when you are reviewing for supply-chain risk rather than for what upgraded.',
      },
    ],
  },
  inputs: [LOCK_INPUT('Before'), LOCK_INPUT('After')] as const,
  options: [
    {
      kind: 'select',
      key: 'format',
      label: 'Format',
      choices: [
        { value: '', label: 'Detect' },
        { value: 'npm', label: 'package-lock.json' },
        { value: 'pnpm', label: 'pnpm-lock.yaml' },
        { value: 'yarn', label: 'yarn.lock (v1)' },
        { value: 'yarn-berry', label: 'yarn.lock (Berry)' },
      ],
      default: '',
    },
    { kind: 'boolean', key: 'hidePatch', label: 'Hide patch bumps', default: false },
    { kind: 'boolean', key: 'alertsOnly', label: 'Alerts only', default: false, help: 'For a supply-chain review.' },
  ],
  run(inputs, options): Result<ToolOutput> {
    const forcedRaw = readString(options, 'format', '');
    const forced = forcedRaw === '' ? undefined : (forcedRaw as LockFormat);

    const before = parseLockfile(inputs[0] ?? '', forced);
    if (!before.ok) {
      return { ok: false, error: { ...before.error, message: `Before: ${before.error.message}` } };
    }
    const after = parseLockfile(inputs[1] ?? '', forced);
    if (!after.ok) {
      return { ok: false, error: { ...after.error, message: `After: ${after.error.message}` } };
    }

    const diff = diffLockfiles(before.value, after.value);
    const content = renderDiff(before.value, after.value, diff, {
      hidePatch: readBoolean(options, 'hidePatch', false),
      alertsOnly: readBoolean(options, 'alertsOnly', false),
    });

    const stats = [
      { label: 'changed', value: String(diff.changes.length) },
      { label: 'added', value: String(diff.counts.added) },
      { label: 'removed', value: String(diff.counts.removed) },
      { label: 'major', value: String(diff.counts.major) },
    ];
    if (diff.alerts.length > 0) {
      stats.unshift({ label: 'alerts', value: String(diff.alerts.length) });
    }

    return ok({
      content,
      language: 'text',
      filename: 'lockfile-diff.txt',
      stats,
      warnings: diff.alerts.some((a) => a.kind === 'integrity-changed')
        ? ['An integrity hash changed without the version changing. Find out why before merging.']
        : [],
    });
  },
});

export const lockfileTools = [diffTool];
