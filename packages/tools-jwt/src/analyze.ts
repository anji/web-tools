import type { DecodedJwt } from './decode.js';
import { validityOf } from './claims.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  severity: Severity;
  title: string;
  detail: string;
}

const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|secret|api[_-]?key|private[_-]?key|client[_-]?secret|credit|card|cvv|ssn|social[_-]?security|token|refresh)/i;

const KNOWN_ALGS = new Set([
  'HS256','HS384','HS512','RS256','RS384','RS512',
  'ES256','ES384','ES512','PS256','PS384','PS512','EdDSA',
]);

const DAY = 86400;

export function analyzeJwt(jwt: DecodedJwt, now: number): Finding[] {
  const findings: Finding[] = [];
  const payload =
    jwt.payload !== null && typeof jwt.payload === 'object' && !Array.isArray(jwt.payload)
      ? (jwt.payload as Record<string, unknown>)
      : undefined;

  // --- Algorithm ---------------------------------------------------------
  const alg = jwt.algorithm;
  if (alg.toLowerCase() === 'none') {
    findings.push({
      severity: 'critical',
      title: 'Algorithm is "none"',
      detail:
        'This token is unsigned. Anyone can edit the payload and it stays "valid" to any verifier that trusts the header. A verifier must be configured with the algorithm it expects rather than reading it from the token.',
    });
  } else if (!KNOWN_ALGS.has(alg)) {
    findings.push({
      severity: 'high',
      title: `Unrecognised algorithm "${alg}"`,
      detail:
        'This is not one of the algorithms registered for JOSE. A verifier that does not recognise it may fall back to rejecting the token, or worse, to not checking at all.',
    });
  } else if (alg.startsWith('HS')) {
    findings.push({
      severity: 'info',
      title: `${alg} is symmetric`,
      detail:
        'The same secret both signs and verifies, so every service that can check this token can also mint one. If some of those services are less trusted than others, an asymmetric algorithm such as RS256 or EdDSA limits the blast radius.',
    });
  }

  if (jwt.header['crit'] !== undefined) {
    findings.push({
      severity: 'medium',
      title: 'Uses the "crit" header',
      detail:
        'crit marks extensions a verifier must understand or reject. Implementations differ in how strictly they honour it.',
    });
  }

  for (const remote of ['jku', 'x5u']) {
    if (typeof jwt.header[remote] === 'string') {
      findings.push({
        severity: 'high',
        title: `Header points at a remote key (${remote})`,
        detail: `${remote} tells the verifier to fetch the key from ${String(jwt.header[remote]).slice(0, 80)}. If the verifier does not pin that origin to an allow-list, an attacker who can influence the URL can supply their own key and forge tokens.`,
      });
    }
  }

  const kid = jwt.header['kid'];
  if (typeof kid === 'string' && /[./\\]|\0/.test(kid)) {
    findings.push({
      severity: 'high',
      title: 'Key id contains path characters',
      detail:
        'A kid used to build a filename or SQL query is a classic injection point. This one contains characters that would matter in either.',
    });
  }

  // --- Lifetime ----------------------------------------------------------
  const validity = validityOf(jwt.payload, now);
  if (validity.state === 'expired') {
    findings.push({ severity: 'info', title: 'Token has expired', detail: validity.detail });
  } else if (validity.state === 'not-yet-valid') {
    findings.push({ severity: 'info', title: 'Token is not valid yet', detail: validity.detail });
  }

  if (payload) {
    const exp = payload['exp'];
    const iat = payload['iat'];

    if (typeof exp !== 'number') {
      findings.push({
        severity: 'high',
        title: 'No expiry claim',
        detail:
          'Without exp the token is valid forever. Anything that leaks it - a log line, a browser history entry, a screenshot - is a permanent credential until the signing key is rotated.',
      });
    } else if (typeof iat === 'number' && exp - iat > 30 * DAY) {
      findings.push({
        severity: 'medium',
        title: `Very long lifetime (${Math.round((exp - iat) / DAY)} days)`,
        detail:
          'A token this long-lived is close to a permanent credential. Short access tokens plus a refresh token limit the damage from a leak.',
      });
    }

    if (payload['iss'] === undefined) {
      findings.push({
        severity: 'low',
        title: 'No issuer claim',
        detail: 'Without iss, a verifier trusting several issuers cannot tell which one signed this.',
      });
    }
    if (payload['aud'] === undefined) {
      findings.push({
        severity: 'medium',
        title: 'No audience claim',
        detail:
          'Without aud, a token minted for one service is accepted by any other service that trusts the same key. That is how a token for a low-value API gets replayed against a high-value one.',
      });
    }

    // --- Confidentiality ------------------------------------------------
    // The payload is base64, not encryption. People forget this constantly.
    const flagged: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(key)) flagged.push(path ? `${path}.${key}` : key);
        walk(child, path ? `${path}.${key}` : key);
      }
    };
    walk(payload, '');

    if (flagged.length > 0) {
      findings.push({
        severity: 'high',
        title: `Sensitive-looking claims in the payload (${flagged.join(', ')})`,
        detail:
          'A JWT payload is base64, not encryption. Anyone holding the token can read it without the key - including whoever finds it in a log. If a value must stay secret, it does not belong in a JWS.',
      });
    }
  } else {
    findings.push({
      severity: 'medium',
      title: 'Payload is not a JSON object',
      detail: 'Most verifiers expect a claims object and will reject anything else.',
    });
  }

  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
