export interface OutsourcedSensitiveContext {
  activationCode?: string | null;
  activationCodes?: Array<string | null | undefined>;
  pixCode?: string | null;
  pixCodes?: Array<string | null | undefined>;
}

const PIX_PATTERN = /000201[A-Za-z0-9+/.=_-]{20,}/g;
const CLIENT_SECRET_PATTERN = /\b(?:seti|pi|cs)_[A-Za-z0-9_=-]*_secret_[A-Za-z0-9_=-]+/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JSON_SECRET_FIELD_PATTERN = /("(?:code|pix_code|client_secret|access_token|token|password)"\s*:\s*")([^"]+)(")/gi;
const URL_CREDENTIAL_PATTERN = /\bhttps?:\/\/([^:\s/@]+):([^@\s]+)@/gi;

export function redactOutsourcedSensitiveText(
  value: string | null | undefined,
  context: OutsourcedSensitiveContext = {},
): string {
  let redacted = String(value ?? '')
    .replace(JSON_SECRET_FIELD_PATTERN, '$1[redacted]$3')
    .replace(CLIENT_SECRET_PATTERN, '[redacted-client-secret]')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted-token]')
    .replace(URL_CREDENTIAL_PATTERN, 'http://[redacted-proxy-credentials]@')
    .replace(PIX_PATTERN, '[redacted-pix-code]');

  redacted = replaceLiteralSecrets(
    redacted,
    [context.activationCode, ...(context.activationCodes ?? [])],
    '[redacted-activation-code]',
  );
  redacted = replaceLiteralSecrets(
    redacted,
    [context.pixCode, ...(context.pixCodes ?? [])],
    '[redacted-pix-code]',
  );

  return redacted.replace(/\s+/g, ' ').trim().slice(0, 1000) || 'unknown_error';
}

function replaceLiteralSecrets(
  value: string,
  secrets: Array<string | null | undefined>,
  replacement: string,
): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, replacement);
  }
  return redacted;
}
