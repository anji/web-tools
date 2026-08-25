# web-tools

Privacy-first browser tools. Every tool is a pure function that runs in the
user's tab: no upload, no account, no server. One shared core, many
independently deployed sites.

The first site is a JSON toolbox with twelve tools.

```
packages/core        the tool contract, worker bridge, WASM loader, registry
packages/ui          the React shell every tool's UI is rendered from
packages/tools-json  the twelve JSON tools and the engines behind them
sites/json           the deployable Astro site (12 pages + sitemap + robots)
```

## Why it is split this way

The user-visible product is dozens of small single-purpose pages, because that
is the SEO surface. The engineering problem is that dozens of pages must not
mean dozens of hand-written UIs. So a tool declares itself as data:

```ts
defineTool({
  slug: 'json-to-zod',          // the indexable URL
  seo: { title, description, heading, intro, faq },
  inputs: [{ label: 'JSON', language: 'json' }],
  options: [{ kind: 'boolean', key: 'applyFormats', label: '…', default: true }],
  run(inputs, options) { /* pure, returns a Result */ },
});
```

From that one object the platform derives the page, its `<title>` and meta
description, its FAQ and FAQPage JSON-LD, its breadcrumbs, its sitemap entry,
its nav and footer placement, its card on the homepage, and its entire
interactive UI. Adding a tool means writing its `run` function and its copy.

`run` being pure is what makes the privacy claim structurally true rather than
a promise: it takes strings and returns a `Result`, has no DOM and no network,
and is therefore also trivially testable in node and runnable in a worker.

## The JSON engine

Twelve tools, but one inference pass. TypeScript, Zod and JSON Schema are three
emitters over the same inferred `Schema`, which is why they agree with each
other about optionality and nullability — the place most converters drift.

What it does that the common free converters do not:

- **Merges every array element**, so a key missing from some records becomes
  optional and a key sometimes null becomes nullable. A key that is both gets
  both (`bio?: string | null`).
- **Names nested types** from their key, singularising array keys (`users` →
  `User`), and collapses structurally identical shapes onto one type instead of
  emitting a hundred identical interfaces.
- **Detects enums** conservatively: a bounded set of values, each seen more than
  once. One sample object yields `string`, not a literal type.
- **Explains parse failures** — line, column, and the actual cause (trailing
  comma, single quotes, Python `True`, comments), not "Unexpected token }".
- **Diffs structurally**, so key order and reindentation are not changes, with
  optional id-matching for reordered arrays.
- **Detects secrets two ways**: suspicious key names *and* suspicious value
  shapes (JWTs, AWS keys, GitHub/Slack/Stripe tokens, PEM blocks, connection
  strings with inline passwords, Luhn-valid card numbers).

JSONPath is implemented here rather than pulled in — wildcards, recursive
descent, slices, and single-comparison filters including `=~`.

## Tests

```
pnpm test          # 82 tests
```

Eight of them run generated TypeScript through the real compiler, because
substring assertions cannot catch a duplicate identifier or a forward
reference — the exact class of bug that shipped in the first draft of the
naming pass.

The browser checks live in `sites/json`. The load-bearing one asserts that a
full session across every tool makes **zero third-party network requests**. If
that ever fails, the product's central claim is false, so it is a test rather
than a policy.

## Running it

```
pnpm install
pnpm --filter @tools/site-json dev
pnpm --filter @tools/site-json build     # static output in sites/json/dist
```

The build is fully static: 12 pre-rendered tool pages, a homepage, a 404, a
sitemap and a robots.txt. It deploys to any static host.

## Adding the next site

The split exists so that site #2 is mostly copy:

1. `packages/tools-<niche>` — the tools. Pure functions plus their SEO copy.
2. Copy `sites/json` and swap `src/brand.ts` and the tools import in
   `src/registry.ts`.
3. Deploy it on its own domain.

`packages/core` already carries the worker bridge and a cached WASM loader with
a cross-origin-isolation check, which the JSON site does not need but the image,
audio and video sites will. Those sites additionally need COOP/COEP headers set
at the host for threaded WASM builds.

Cross-linking between the sites is the `siblings` list in each `brand.ts`,
rendered in the footer.
