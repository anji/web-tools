/** Registered claim names from RFC 7519, plus the OIDC ones people meet daily. */
export const CLAIM_DESCRIPTIONS: Readonly<Record<string, string>> = {
  iss: 'Issuer — who created and signed this token',
  sub: 'Subject — who the token is about, usually a user id',
  aud: 'Audience — who the token is intended for; a recipient must reject it if not listed',
  exp: 'Expiration — the token must be rejected at or after this time',
  nbf: 'Not before — the token must be rejected before this time',
  iat: 'Issued at — when the token was created',
  jti: 'JWT ID — a unique identifier, used to prevent replay',
  azp: 'Authorised party — the client the token was issued to',
  scope: 'Scope — the permissions granted, space separated',
  scp: 'Scope — the permissions granted',
  nonce: 'Nonce — binds the token to a specific authentication request',
  sid: 'Session ID',
  typ: 'Type — normally JWT',
  alg: 'Algorithm — how the signature was computed',
  kid: 'Key ID — which key to verify against',
  cty: 'Content type — set when the payload is itself a nested JWT',
};

/** Claims whose value is a NumericDate: seconds since the Unix epoch. */
export const TIME_CLAIMS = new Set(['exp', 'nbf', 'iat', 'auth_time', 'updated_at']);

export function formatRelative(seconds: number, now: number): string {
  const delta = seconds - Math.floor(now / 1000);
  const abs = Math.abs(delta);

  // Largest unit that still yields a number above 1, so "in 3 days" rather
  // than "in 259200 seconds".
  const scales: ReadonlyArray<[limit: number, size: number, unit: string]> = [
    [60, 1, 'second'],
    [3600, 60, 'minute'],
    [86400, 3600, 'hour'],
    [2592000, 86400, 'day'],
    [31536000, 2592000, 'month'],
    [Number.POSITIVE_INFINITY, 31536000, 'year'],
  ];

  const scale = scales.find(([limit]) => abs < limit)!;
  const value = Math.round(abs / scale[1]);
  const plural = value === 1 ? '' : 's';
  return delta >= 0 ? `in ${value} ${scale[2]}${plural}` : `${value} ${scale[2]}${plural} ago`;
}

export function formatTimestamp(seconds: number, now: number): string {
  if (!Number.isFinite(seconds)) return 'not a valid timestamp';
  const iso = new Date(seconds * 1000).toISOString().replace('.000', '');
  return `${iso} (${formatRelative(seconds, now)})`;
}

export type ValidityState = 'valid' | 'expired' | 'not-yet-valid' | 'no-expiry';

export function validityOf(
  payload: unknown,
  now: number,
): { state: ValidityState; detail: string } {
  if (payload === null || typeof payload !== 'object') {
    return { state: 'no-expiry', detail: 'The payload is not an object, so it carries no claims.' };
  }
  const record = payload as Record<string, unknown>;
  const nowSeconds = Math.floor(now / 1000);
  const exp = record['exp'];
  const nbf = record['nbf'];

  if (typeof nbf === 'number' && nowSeconds < nbf) {
    return { state: 'not-yet-valid', detail: `Not valid until ${formatTimestamp(nbf, now)}.` };
  }
  if (typeof exp !== 'number') {
    return {
      state: 'no-expiry',
      detail: 'No exp claim, so this token never expires on its own.',
    };
  }
  if (nowSeconds >= exp) {
    return { state: 'expired', detail: `Expired ${formatTimestamp(exp, now)}.` };
  }
  return { state: 'valid', detail: `Expires ${formatTimestamp(exp, now)}.` };
}
