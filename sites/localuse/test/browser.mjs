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

// --- LLM tooling: deterministic tools for people building with models
{
  await page.goto(`${BASE}/llm/tool-definition-generator/`, { waitUntil: 'networkidle' });
  await check('tool definition generator inlines nested shapes', async () => {
    await type('textarea', '{"query":"revenue","filter":{"since":"2026-01-01"}}');
    const out = await output();
    const definition = JSON.parse(out);
    if (!definition.input_schema?.properties?.filter?.properties?.since) {
      throw new Error('nested shape not inlined: ' + out.slice(0, 300));
    }
    if (out.includes('$ref') || out.includes('$defs')) throw new Error('used $ref, which providers vary on');
  });

  await page.goto(`${BASE}/llm/tool-definition-linter/`, { waitUntil: 'networkidle' });
  await check('linter catches a custom tool shadowing a built-in name', async () => {
    await type('textarea', JSON.stringify({
      name: 'bash',
      description: 'A custom tool that happens to be called bash and runs things.',
      input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
    }));
    const out = await output();
    if (!/Anthropic-defined/.test(out)) throw new Error('shadowed built-in not flagged: ' + out.slice(0, 300));
  });

  await page.goto(`${BASE}/llm/streaming-response-inspector/`, { waitUntil: 'networkidle' });
  await check('stream inspector reassembles tool arguments and spots a cut-off call', async () => {
    const frame = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    await type('textarea',
      frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' } }) +
      frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ci' } }));
    const out = await output();
    if (!/cut off mid-stream/.test(out)) throw new Error('incomplete arguments not flagged: ' + out.slice(0, 300));
    if (!/TRUNCATED/.test(out)) throw new Error('missing message_stop not reported');
  });
}

// --- Hash and time: exactness is the reason these exist
{
  const { createHash } = await import('node:crypto');

  await page.goto(`${BASE}/encoding/hash-generator/`, { waitUntil: 'networkidle' });
  await check('hash generator agrees with the platform crypto library', async () => {
    await type('textarea', 'hello');
    const expected = createHash('sha256').update('hello').digest('hex');
    const out = await output();
    if (!out.includes(expected)) throw new Error('digest mismatch: ' + out.slice(0, 200));
  });

  await check('checksum verification answers match and mismatch', async () => {
    const field = page.locator('input[type="text"]').last();
    await field.fill(createHash('sha256').update('hello').digest('hex'));
    await page.waitForTimeout(600);
    if (!/^MATCH/.test(await output())) throw new Error('correct checksum not accepted');
    await field.fill(createHash('md5').update('hello').digest('hex'));
    await page.waitForTimeout(600);
    const out = await output();
    if (!/NO MATCH/.test(out)) throw new Error('wrong checksum accepted');
    if (!/right algorithm/.test(out)) throw new Error('mismatch did not explain the length difference');
  });

  await page.goto(`${BASE}/time/timestamp-converter/`, { waitUntil: 'networkidle' });
  await check('timestamp converter flags a local time that occurs twice', async () => {
    await type('textarea', '2026-11-01 01:30');
    await page.locator('input[type="text"]').first().fill('America/New_York');
    await page.waitForTimeout(700);
    const out = await output();
    if (!/occurs twice/.test(out)) throw new Error('DST repeat not flagged: ' + out.slice(0, 300));
  });

  await page.goto(`${BASE}/time/cron-tester/`, { waitUntil: 'networkidle' });
  await check('cron tester explains the day-of-month OR day-of-week rule', async () => {
    await type('textarea', '0 0 1 * MON');
    const out = await output();
    if (!/fires when EITHER/.test(out)) throw new Error('OR rule not surfaced: ' + out.slice(0, 300));
  });

  await check('cron tester reports an expression that can never fire', async () => {
    await type('textarea', '0 0 30 2 *');
    if (!/never fires/.test(await output())) throw new Error('30 February was not caught');
  });
}

// --- Lockfile diff: the supply-chain signal is the whole point
{
  const mk = (pkgs) => JSON.stringify({
    name: 'app', lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      ...Object.fromEntries(Object.entries(pkgs).map(([n, v]) => [`node_modules/${n}`, v])),
    },
  });
  const before = mk({
    react: { version: '17.0.2' },
    lodash: { version: '4.17.21', integrity: 'sha512-ORIG' },
  });
  const after = mk({
    react: { version: '18.2.0' },
    lodash: { version: '4.17.21', integrity: 'sha512-TAMPERED' },
  });

  await page.goto(`${BASE}/dependencies/lockfile-diff/`, { waitUntil: 'networkidle' });
  await check('lockfile diff flags a changed integrity on an unchanged version', async () => {
    await page.locator('textarea').nth(0).fill(before);
    await page.locator('textarea').nth(1).fill(after);
    await page.waitForTimeout(700);
    const out = await output();
    if (!/SECURITY \(1\)/.test(out)) throw new Error('integrity change not flagged: ' + out.slice(0, 300));
    if (!/MAJOR \(1\)/.test(out)) throw new Error('react major bump not grouped');
    // The version did not change, so it must not appear as a version change.
    if (/lodash\s+4\.17\.21 →/.test(out)) throw new Error('reported an unchanged version as changed');
  });
}

// --- JWT: the section where the privacy claim is doing the most work
{
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const { createHmac } = await import('node:crypto');
  const signingInput = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '123', name: 'Ada', iss: 'auth.test' })}`;
  const token = `${signingInput}.${createHmac('sha256', 'correct-horse').update(signingInput).digest('base64url')}`;
  const unsigned = `${b64({ alg: 'none' })}.${b64({ sub: 'admin', password: 'hunter2' })}.`;

  await page.goto(`${BASE}/jwt/jwt-decoder/`, { waitUntil: 'networkidle' });
  await check('jwt decoder reads the payload', async () => {
    await type('textarea', token);
    const out = await output();
    if (!out.includes('"name": "Ada"')) throw new Error('payload not decoded: ' + out.slice(0, 200));
  });

  await page.goto(`${BASE}/jwt/jwt-security-check/`, { waitUntil: 'networkidle' });
  await check('jwt security check flags alg:none without echoing the secret', async () => {
    await type('textarea', unsigned);
    const out = await output();
    if (!/CRITICAL/.test(out)) throw new Error('alg:none not flagged: ' + out.slice(0, 200));
    if (!/password/.test(out)) throw new Error('readable sensitive claim not flagged');
    if (out.includes('hunter2')) throw new Error('the finding echoed the secret value');
  });

  await page.goto(`${BASE}/jwt/jwt-signature-verifier/`, { waitUntil: 'networkidle' });
  await check('jwt signature verifies in-browser against the real secret', async () => {
    await type('textarea', token);
    await page.locator('input[type="text"]').first().fill('correct-horse');
    await page.waitForTimeout(600);
    if (!/Signature is valid/.test(await output())) throw new Error('valid signature not accepted');
    await page.locator('input[type="text"]').first().fill('wrong-secret');
    await page.waitForTimeout(600);
    if (!/does not match/.test(await output())) throw new Error('wrong secret not rejected');
  });

  await check('a section that gained tools is no longer a placeholder', async () => {
    await page.goto(`${BASE}/jwt/`, { waitUntil: 'networkidle' });
    const body = await page.textContent('body');
    if (/have not built this section yet/i.test(body)) throw new Error('still showing placeholder');
    if (!body.includes('JWT decoder')) throw new Error('tools not listed');
  });
}

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

await check('every section page is either live or an honest placeholder', async () => {
  // Driven off the sitemap so it keeps working as sections flip from
  // placeholder to live, rather than naming slugs that go stale.
  // Read it out-of-band rather than navigating: an XML document carries no
  // <link rel="icon">, so the browser falls back to /favicon.ico and logs a 404
  // that has nothing to do with the site.
  const xml = await (await page.request.get(`${BASE}/sitemap.xml`)).text();
  // Only single-segment paths are sections; two segments is a tool page.
  const slugs = [...xml.matchAll(/<loc>https?:\/\/[^/]+\/([a-z-]+)\/<\/loc>/g)]
    .map((m) => m[1])
    .filter((s, i, all) => all.indexOf(s) === i);
  if (slugs.length < 5) throw new Error(`only found ${slugs.length} sections in the sitemap`);

  for (const slug of slugs) {
    await page.goto(`${BASE}/${slug}/`, { waitUntil: 'networkidle' });
    const body = await page.textContent('body');
    const isPlaceholder = /have not built this section yet/i.test(body);
    if (isPlaceholder) {
      // A placeholder must point somewhere or explain why it cannot.
      const hasAlternative = /runs locally|sends to a server|self-hosted/.test(body);
      const explainsGap = /next on the list/i.test(body);
      if (!hasAlternative && !explainsGap) {
        throw new Error(`/${slug}/ is a placeholder that offers nothing`);
      }
    } else if (!/tools$/m.test(body) && !body.includes('tools')) {
      throw new Error(`/${slug}/ is neither live nor a placeholder`);
    }
  }
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
