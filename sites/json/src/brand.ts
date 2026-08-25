/**
 * Everything site-specific lives here. Standing up the next tool site means
 * copying sites/json, swapping this file, and pointing it at a different tools
 * package -- the shell, the shared UI and the SEO plumbing come along unchanged.
 */
export const brand = {
  name: 'iHateJSON',
  origin: 'https://ihatejson.com',
  tagline: 'JSON tools that never upload your data',
  description:
    'A dozen JSON tools that run entirely in your browser. Format, convert to TypeScript or Zod, diff, query with JSONPath, and strip secrets before you share. No upload, no account, no limits.',
  accent: 'sky',
  repo: 'https://github.com/anji/web-tools',
  siblings: [] as ReadonlyArray<{ name: string; href: string; blurb: string }>,
};
