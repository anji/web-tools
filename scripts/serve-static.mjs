#!/usr/bin/env node
/**
 * Serves a built site locally with the headers from its own `_headers` file.
 *
 * Parsing the real file rather than restating the headers here is the point:
 * a CSP that drifts from what Cloudflare will actually serve is a CSP that
 * proves nothing.
 *
 *   node scripts/serve-static.mjs sites/json/dist 4330
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.argv[2] ?? 'dist';
const PORT = Number(process.argv[3] ?? 4330);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json',
  '.xml': 'application/xml', '.txt': 'text/plain', '.ico': 'image/x-icon',
};

/** Parses the subset of the `_headers` format we use: path blocks plus rules. */
async function loadHeaderRules(root) {
  const text = await readFile(join(root, '_headers'), 'utf8').catch(() => '');
  const rules = [];
  let current;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    const idx = raw.indexOf(':');
    if (current && idx > 0) {
      current.headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
    }
  }
  return rules;
}

const matches = (pattern, path) =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

const rules = await loadHeaderRules(ROOT);

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = join(ROOT, path);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
  }

  const headers = {};
  for (const rule of rules) {
    if (matches(rule.pattern, path)) Object.assign(headers, rule.headers);
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ...headers });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html', ...headers });
    res.end(await readFile(join(ROOT, '404.html')).catch(() => 'Not found'));
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
