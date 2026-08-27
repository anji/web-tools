# web-tools

Privacy-first browser tools. Every tool is a pure function that runs in the
user's tab: no upload, no account, no server. One shared core, many
independently deployed sites.

The first site is a JSON toolbox with twelve tools.

```
packages/core        the tool contract, worker bridge, WASM loader, registry
packages/ui          the React shell every tool's UI is rendered from
packages/tools-json  the twelve JSON tools and the engines behind them
sites/localuse       the deployed site: localuse.dev
```

## Site structure

One domain, sections as subdirectories — `localuse.dev/json/json-to-typescript`.
Subdirectories rather than subdomains because Google largely treats a subdomain
as a separate site, and a new domain has too little authority to spend splitting
it up.

A **section** is a niche. A section with tools is ours. A section without them is
a placeholder that links to whoever does it best today, each recommendation
labelled with whether it actually runs on the reader's device — including when
the honest answer is no. Those pages get replaced by our own tools *at the same
URL*, so links shared while a section is a placeholder keep working.

That placeholder state is not filler. It makes the hub useful on day one instead
of after niche number five, and the local/not-local labelling is itself the
thing no other tool directory offers.

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

The browser checks live in `sites/localuse/test`. The load-bearing one asserts that a
full session across every tool makes **zero third-party network requests**. If
that ever fails, the product's central claim is false, so it is a test rather
than a policy.

## Running it

```
pnpm install
pnpm dev                                   # localuse.dev, locally
pnpm --filter @tools/site-localuse build   # static output in sites/localuse/dist
```

The build is fully static: 21 pre-rendered pages — 12 tools, 7 section landings,
a homepage and a 404 — plus a sitemap and robots.txt. It deploys to any static
host.

## Deploying

Deploys go to **Cloudflare Workers static assets**, driven by GitHub Actions —
not the Cloudflare Pages git integration. Two reasons, both structural:

- Pages caps you at **5 projects per repository**, and this repo is designed to
  hold considerably more than five sites.
- Pages is in maintenance mode; Cloudflare points new projects at Workers,
  which serves static assets natively and bills them at zero.

Pushing deploys from CI rather than letting a git integration pull sidesteps the
per-repo project limit entirely, and lets one workflow fan out across every site.

`.github/workflows/deploy.yml` does:

1. **test** — typecheck and unit tests across the workspace.
2. **changed** — works out which sites need rebuilding. A change under
   `packages/` is shared and rebuilds everything; a change under `sites/<name>/`
   rebuilds only that site. A push touching neither deploys nothing.
3. **deploy** — a matrix over the changed sites. Each builds, verifies, and
   `wrangler deploy`s independently, with `fail-fast: false` so one bad site
   cannot block the others.

Two repository secrets are required: `CLOUDFLARE_API_TOKEN` (Workers Scripts:
Edit) and `CLOUDFLARE_ACCOUNT_ID`.

Each site owns a `wrangler.jsonc` whose only meaningful field is the Worker
name, and a `public/_headers` that Astro copies into `dist/`.

### The CSP is a feature, not boilerplate

`public/_headers` sets `connect-src 'none'`. The page is then *structurally*
unable to open a fetch, an XHR, a WebSocket, a beacon or a remote module — the
browser refuses. The privacy promise stops depending on us not adding an
analytics snippet later, and starts being enforced by the user's own browser.

`scripts/verify-egress.mjs` proves it on every deploy: it loads a real page
under the real headers, confirms the tool still produces output (a broken page
would trivially make no requests), then attempts every egress primitive and
requires that none receives a response. Deploys fail if any gets through.

`scripts/serve-static.mjs` parses the site's actual `_headers` file rather than
restating the rules, so the verification cannot drift from what ships.

## Adding the next site

The split exists so that site #2 is mostly copy:

1. `packages/tools-<niche>` — the tools. Pure functions plus their SEO copy.
2. Add them to the matching section in `sites/localuse/src/sections.ts`. The
   section stops being a placeholder the moment `tools` is non-empty; the
   homepage, nav, footer and sitemap all follow automatically.

To give a niche its own domain later instead, the same tools package plugs into
a new `sites/<name>/` with its own `brand.ts` — which is why the tools never
import anything site-specific.
3. Copy `wrangler.jsonc` and change the `name`; copy `public/_headers`.
4. Copy `test/browser.mjs` and point its assertions at the new tools.

The deploy workflow needs no edit — it discovers sites by listing `sites/*`.

`packages/core` already carries the worker bridge and a cached WASM loader with
a cross-origin-isolation check, which the JSON site does not need but the image,
audio and video sites will. Those sites additionally need COOP/COEP headers set
at the host for threaded WASM builds.

Cross-linking between the sites is the `siblings` list in each `brand.ts`,
rendered in the footer.
