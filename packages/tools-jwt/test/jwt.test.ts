import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { decodeJwt } from '../src/decode.js';
import { analyzeJwt } from '../src/analyze.js';
import { validityOf, formatRelative } from '../src/claims.js';
import { jwtTools } from '../src/tools.js';
import { defaultOptions } from '@tools/core';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (header: unknown, payload: unknown, secret = 'test-secret') => {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
};

const NOW = Date.UTC(2026, 0, 1) ;
const nowSec = Math.floor(NOW / 1000);

describe('decodeJwt', () => {
  it('decodes header and payload', () => {
    const token = sign({ alg: 'HS256', typ: 'JWT' }, { sub: '123', name: 'Ada' });
    const result = decodeJwt(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.algorithm).toBe('HS256');
    expect(result.value.payload).toEqual({ sub: '123', name: 'Ada' });
  });

  it('strips a Bearer prefix', () => {
    const token = sign({ alg: 'HS256' }, { a: 1 });
    expect(decodeJwt(`Bearer ${token}`).ok).toBe(true);
  });

  it('identifies a JWE rather than failing vaguely', () => {
    const result = decodeJwt('a.b.c.d.e');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/JWE/);
  });

  it('explains a token with the wrong number of segments', () => {
    const result = decodeJwt('not-a-jwt');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.hint).toMatch(/opaque session token|API key/i);
  });

  it('rejects standard base64 with a specific hint', () => {
    const result = decodeJwt('ab+c.def.ghi');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.hint).toMatch(/plain base64/i);
  });

  it('reports a segment that decodes but is not JSON', () => {
    const result = decodeJwt(`${Buffer.from('hello').toString('base64url')}.e30.sig`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not valid JSON/);
  });

  it('handles UTF-8 payloads', () => {
    const token = sign({ alg: 'HS256' }, { name: 'Ada 💡 Lovelace', city: '東京' });
    const result = decodeJwt(token);
    expect(result.ok && (result.value.payload as any).name).toBe('Ada 💡 Lovelace');
    expect(result.ok && (result.value.payload as any).city).toBe('東京');
  });
});

describe('validity', () => {
  it('reports an expired token', () => {
    expect(validityOf({ exp: nowSec - 60 }, NOW).state).toBe('expired');
  });
  it('reports a not-yet-valid token', () => {
    expect(validityOf({ nbf: nowSec + 60 }, NOW).state).toBe('not-yet-valid');
  });
  it('reports a live token', () => {
    expect(validityOf({ exp: nowSec + 3600 }, NOW).state).toBe('valid');
  });
  it('reports a token with no expiry', () => {
    expect(validityOf({ sub: 'x' }, NOW).state).toBe('no-expiry');
  });
  it('formats relative times in the largest sensible unit', () => {
    expect(formatRelative(nowSec + 3600, NOW)).toBe('in 1 hour');
    expect(formatRelative(nowSec - 172800, NOW)).toBe('2 days ago');
    expect(formatRelative(nowSec + 30, NOW)).toBe('in 30 seconds');
  });
});

describe('security analysis', () => {
  const find = (header: unknown, payload: unknown) =>
    analyzeJwt(
      (decodeJwt(sign(header, payload)) as any).value,
      NOW,
    );
  const titles = (f: ReturnType<typeof find>) => f.map((x) => x.title).join(' | ');

  it('flags alg:none as critical', () => {
    const findings = find({ alg: 'none' }, { sub: 'x', exp: nowSec + 60, iss: 'a', aud: 'b' });
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.title).toMatch(/none/);
  });

  it('flags a missing expiry', () => {
    expect(titles(find({ alg: 'HS256' }, { sub: 'x' }))).toMatch(/No expiry/);
  });

  it('flags a missing audience', () => {
    expect(titles(find({ alg: 'HS256' }, { sub: 'x', exp: nowSec + 60 }))).toMatch(/No audience/);
  });

  it('flags sensitive claims sitting readable in the payload', () => {
    const findings = find({ alg: 'HS256' }, { sub: 'x', password: 'hunter2', exp: nowSec + 60 });
    const hit = findings.find((f) => f.title.includes('Sensitive'));
    expect(hit?.severity).toBe('high');
    expect(hit?.title).toContain('password');
  });

  it('finds sensitive claims nested inside objects', () => {
    const findings = find({ alg: 'HS256' }, { user: { api_key: 'abc' }, exp: nowSec + 60 });
    expect(titles(findings)).toMatch(/user\.api_key/);
  });

  it('never puts the sensitive value itself in the finding', () => {
    const findings = find({ alg: 'HS256' }, { password: 'hunter2', exp: nowSec + 60 });
    expect(JSON.stringify(findings)).not.toContain('hunter2');
  });

  it('flags a remote key header', () => {
    expect(titles(find({ alg: 'HS256', jku: 'https://evil.test/keys' }, { exp: nowSec + 60 })))
      .toMatch(/remote key/i);
  });

  it('flags a kid containing path characters', () => {
    expect(titles(find({ alg: 'HS256', kid: '../../etc/passwd' }, { exp: nowSec + 60 })))
      .toMatch(/path characters/i);
  });

  it('flags an unrecognised algorithm', () => {
    expect(titles(find({ alg: 'HS255' }, { exp: nowSec + 60 }))).toMatch(/Unrecognised/);
  });

  it('notes that HMAC is symmetric without treating it as a defect', () => {
    const findings = find({ alg: 'HS256' }, { exp: nowSec + 60, iss: 'a', aud: 'b' });
    const hit = findings.find((f) => f.title.includes('symmetric'));
    expect(hit?.severity).toBe('info');
  });

  it('sorts the most severe finding first', () => {
    const findings = find({ alg: 'none' }, { sub: 'x' });
    expect(findings[0]?.severity).toBe('critical');
  });
});

describe('tools', () => {
  const tool = (id: string) => jwtTools.find((t) => t.id === id)!;
  const run = (id: string, input: string, over: Record<string, unknown> = {}) =>
    tool(id).run([input], { ...defaultOptions(tool(id)), ...over } as any);

  it('the verifier accepts a correctly signed token', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'x' }, 'correct-horse');
    const result = run('jwt-verify', token, { secret: 'correct-horse' });
    expect(result.ok && result.value.content).toMatch(/Signature is valid/);
  });

  it('the verifier rejects a wrong secret and says what to check', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'x' }, 'correct-horse');
    const result = run('jwt-verify', token, { secret: 'wrong' });
    expect(result.ok && result.value.content).toMatch(/does not match/);
    expect(result.ok && result.value.content).toMatch(/base64-encoded/);
  });

  it('the verifier detects a tampered payload', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user' }, 'k');
    const parts = token.split('.');
    const tampered = `${parts[0]}.${b64({ sub: 'admin' })}.${parts[2]}`;
    const result = run('jwt-verify', tampered, { secret: 'k' });
    expect(result.ok && result.value.content).toMatch(/does not match/);
  });

  it('the verifier declines an asymmetric token with an explanation', () => {
    const result = run('jwt-verify', sign({ alg: 'RS256' }, { a: 1 }), { secret: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.hint).toMatch(/public key/i);
  });

  it('the decoder explains claims on request', () => {
    const token = sign({ alg: 'HS256' }, { iss: 'auth.test', exp: nowSec + 60 });
    const result = run('jwt-decode', token, { view: 'claims' });
    expect(result.ok && result.value.content).toMatch(/Issuer/);
  });

  it('the decoder warns on an unsigned token', () => {
    const result = run('jwt-decode', sign({ alg: 'none' }, { a: 1 }));
    expect(result.ok && result.value.warnings?.join(' ')).toMatch(/unsigned/i);
  });

  it('the security check filters by severity', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'x' });
    const all = run('jwt-analyze', token, { minSeverity: 'info' });
    const high = run('jwt-analyze', token, { minSeverity: 'high' });
    expect(all.ok && high.ok && all.value.content.length).toBeGreaterThan(
      high.ok ? high.value.content.length : 0,
    );
  });

  it('every tool reports a decode failure rather than throwing', () => {
    for (const t of jwtTools) {
      const result = t.run(['garbage'], defaultOptions(t) as any);
      expect(result.ok).toBe(false);
    }
  });
});
