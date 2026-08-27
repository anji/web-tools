#!/usr/bin/env node
/**
 * Functional checks against the built site, driven in a real browser.
 *
 * The unit tests cover the engines; this covers what only a browser can tell
 * us -- that the island hydrates, that changing an option re-runs the tool,
 * that a two-input tool renders two panes, and that the SEO metadata survives
 * the build. The last two checks are load-bearing: no third-party requests,
 * and no console errors.
 *
 *   node scripts/serve-static.mjs sites/json/dist 4330 &
 *   node sites/json/test/browser.mjs http://127.0.0.1:4330
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4330';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();

const requests = [];
page.on('request', (r) => {
  const url = r.url();
  if (!url.startsWith(BASE) && !url.startsWith('data:') && !url.startsWith('blob:')) requests.push(url);
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' -- ' + e.message]); }
}

const type = async (sel, text) => {
  await page.fill(sel, '');
  await page.fill(sel, text);
  await page.waitForTimeout(400);
};
const output = async () => (await page.textContent('pre code').catch(() => '')) ?? '';

// --- JSON -> TypeScript
await page.goto(`${BASE}/json/json-to-typescript/`, { waitUntil: 'networkidle' });
await check('json-to-typescript generates interfaces with optional + nullable', async () => {
  await type('textarea', JSON.stringify([
    { id: 1, name: 'Ada', team: { name: 'Core' }, bio: null },
    { id: 2, name: 'Grace', team: { name: 'Compilers' } },
  ]));
  const out = await output();
  if (!out.includes('interface Team')) throw new Error('no Team interface: ' + out.slice(0, 200));
  if (!out.includes('bio?: null;') && !out.includes('bio?:')) throw new Error('bio not optional: ' + out);
});

await check('option toggle re-runs the tool', async () => {
  await page.getByText('readonly fields', { exact: true }).click();
  await page.waitForTimeout(350);
  const out = await output();
  if (!out.includes('readonly id')) throw new Error('readonly not applied: ' + out.slice(0, 200));
});

// --- Formatter error reporting
await page.goto(`${BASE}/json/json-formatter/`, { waitUntil: 'networkidle' });
await check('formatter explains a trailing comma with a line number', async () => {
  await type('textarea', '{\n  "a": 1,\n}');
  const body = await page.textContent('body');
  if (!/trailing comma/i.test(body)) throw new Error('no trailing-comma hint');
  if (!/line 3/.test(body)) throw new Error('no line number: ' + body.slice(0, 300));
});
await check('formatter reports stats on valid input', async () => {
  await type('textarea', '{"a":{"b":[1,2]}}');
  const body = await page.textContent('body');
  if (!/keys/.test(body) || !/depth/.test(body)) throw new Error('no stats chips');
});

// --- Diff (two inputs)
await page.goto(`${BASE}/json/json-diff/`, { waitUntil: 'networkidle' });
await check('diff renders two input panes and compares them', async () => {
  const areas = await page.locator('textarea').count();
  if (areas !== 2) throw new Error('expected 2 textareas, got ' + areas);
  await page.locator('textarea').nth(0).fill('{"name":"Ada","legacy":1}');
  await page.locator('textarea').nth(1).fill('{"name":"Grace"}');
  await page.waitForTimeout(400);
  const out = await output();
  if (!out.includes('~ $.name: "Ada" -> "Grace"')) throw new Error('bad diff: ' + out);
  if (!out.includes('- $.legacy')) throw new Error('missing removal: ' + out);
});

// --- JSONPath
await page.goto(`${BASE}/json/jsonpath-tester/`, { waitUntil: 'networkidle' });
await check('jsonpath filter expression evaluates', async () => {
  await type('textarea', '{"items":[{"sku":"A1","price":5},{"sku":"B2","price":25}]}');
  const pathInput = page.locator('input[type="text"]').first();
  await pathInput.fill('$.items[?(@.price > 10)].sku');
  await page.waitForTimeout(400);
  const out = await output();
  if (!out.includes('B2') || out.includes('A1')) throw new Error('bad filter result: ' + out);
});

// --- Redaction
await page.goto(`${BASE}/json/json-redact-secrets/`, { waitUntil: 'networkidle' });
await check('secret scanner masks by key name, by value shape, and PII', async () => {
  // Deliberately no vendor-prefixed token here: a realistic one trips GitHub's
  // own push protection, and these two cover both detection paths anyway --
  // api_key by key name, the JWT by value shape.
  const secret = '9f8c2a1e4b7d0c3f6a5e8b1d';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.s1gn4tur3';
  await type('textarea', `{"email":"ada@example.com","api_key":"${secret}","tok":"${jwt}"}`);
  const out = await output();
  if (out.includes(secret)) throw new Error('key-name detection failed: secret in output');
  if (out.includes(jwt)) throw new Error('value-shape detection failed: JWT in output');
  if (out.includes('ada@example.com')) throw new Error('email not masked');
});

// --- CSV
await page.goto(`${BASE}/json/json-to-csv/`, { waitUntil: 'networkidle' });
await check('csv flattens nested objects and unions columns', async () => {
  await type('textarea', '[{"id":1,"team":{"name":"Core"}},{"id":2,"extra":true}]');
  const out = await output();
  if (!out.includes('id,team.name,extra')) throw new Error('bad header: ' + out);
});

// --- SEO / privacy assertions
await page.goto(`${BASE}/json/json-to-zod/`, { waitUntil: 'networkidle' });
await check('tool page carries canonical, description and FAQ JSON-LD', async () => {
  const canonical = await page.getAttribute('link[rel=canonical]', 'href');
  if (canonical !== 'https://localuse.dev/json/json-to-zod/') throw new Error('canonical: ' + canonical);
  const desc = await page.getAttribute('meta[name=description]', 'content');
  if (!desc || desc.length < 50) throw new Error('missing description');
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  if (!ld.some((s) => s.includes('FAQPage'))) throw new Error('no FAQPage schema');
  if (!ld.some((s) => s.includes('BreadcrumbList'))) throw new Error('no breadcrumbs');
});

// --- Hub navigation and the curated placeholder sections
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await check('homepage lists the live section and links into it', async () => {
  const link = page.locator('a[href="/json/"]').first();
  if ((await page.locator('a[href="/json/"]').count()) === 0) throw new Error('no link to /json/');
  await link.click();
  await page.waitForLoadState('networkidle');
  if (!page.url().includes('/json/')) throw new Error('did not navigate: ' + page.url());
  const body = await page.textContent('body');
  if (!body.includes('JSON tools')) throw new Error('section page missing heading');
});

await check('section page links to each of its tools', async () => {
  const links = await page.locator('a[href^="/json/json-"], a[href^="/json/jsonpath"], a[href^="/json/yaml-"]').count();
  if (links < 12) throw new Error(`expected >=12 tool links, got ${links}`);
});

await page.goto(`${BASE}/pdf/`, { waitUntil: 'networkidle' });
await check('planned section labels externals and marks them as off-site', async () => {
  const body = await page.textContent('body');
  if (!/have not built this section yet/i.test(body)) throw new Error('missing not-built notice');
  if (!body.includes('runs locally')) throw new Error('missing local label');
  const ext = page.locator('a[href^="https://www.ihatepdf.cv"]').first();
  if ((await ext.count()) === 0) throw new Error('recommendation link missing');
  if ((await ext.getAttribute('rel')) !== 'noopener') throw new Error('external link missing rel=noopener');
});

await check('planned section honestly flags a non-local recommendation', async () => {
  await page.goto(`${BASE}/regex/`, { waitUntil: 'networkidle' });
  const body = await page.textContent('body');
  if (!body.includes('sends to a server')) throw new Error('non-local tool not flagged');
});

await check('a section with no recommendations still says something useful', async () => {
  await page.goto(`${BASE}/csv/`, { waitUntil: 'networkidle' });
  const body = await page.textContent('body');
  if (!/next on the list/i.test(body)) throw new Error('empty section has no copy');
});

await check('no third-party network requests from any page', async () => {
  if (requests.length > 0) throw new Error('external requests: ' + requests.join(', '));
});

await check('no console or page errors across the run', async () => {
  if (errors.length > 0) throw new Error(errors.slice(0, 3).join(' | '));
});

await browser.close();

for (const [status, name] of results) console.log(`${status}  ${name}`);
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
