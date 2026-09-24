const crypto = require('crypto');

const QUOTE_TTL_MS = 2 * 60 * 1000;
const CONNECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secretKey() {
  const s = process.env.CONNECTOR_SECRET_KEY;
  if (!s || s.length < 16) {
    throw new Error('CONNECTOR_SECRET_KEY must be set (min 16 chars) for signed tokens');
  }
  return crypto.createHash('sha256').update(s).digest(); // 32 bytes
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(str) {
  return Buffer.from(str, 'base64url');
}

/** Encrypt JSON payload → token (iv.ciphertext.tag.sig) */
function seal(payload, ttlMs) {
  const key = secretKey();
  const body = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + ttlMs,
  };
  const plaintext = Buffer.from(JSON.stringify(body), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, enc]);
  const sig = crypto.createHmac('sha256', key).update(packed).digest();
  return `${b64url(packed)}.${b64url(sig)}`;
}

function open(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [packedB64, sigB64] = token.split('.');
  if (!packedB64 || !sigB64) return null;
  try {
    const key = secretKey();
    const packed = fromB64url(packedB64);
    const sig = fromB64url(sigB64);
    const expected = crypto.createHmac('sha256', key).update(packed).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;

    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const enc = packed.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    const body = JSON.parse(plaintext);
    if (!body.exp || Date.now() > body.exp) return null;
    return body;
  } catch {
    return null;
  }
}

function createQuoteToken(plan, credsFingerprint) {
  return seal({ typ: 'quote', fp: credsFingerprint, plan }, QUOTE_TTL_MS);
}

function readQuoteToken(token) {
  const body = open(token);
  if (!body || body.typ !== 'quote' || !body.plan) return null;
  return {
    quote_id: token,
    expires_at: body.exp,
    credsFingerprint: body.fp,
    plan: body.plan,
  };
}

function createConnectionToken({ apiKey, apiSecret, label }) {
  return seal({
    typ: 'conn',
    apiKey,
    apiSecret,
    label: label || null,
  }, CONNECTION_TTL_MS);
}

function readConnectionToken(token) {
  const body = open(token);
  if (!body || body.typ !== 'conn' || !body.apiKey || !body.apiSecret) return null;
  return {
    apiKey: body.apiKey,
    apiSecret: body.apiSecret,
    label: body.label,
    expires_at: body.exp,
  };
}

function credsFingerprint(creds) {
  return crypto.createHash('sha256').update(creds.apiKey || '').digest('hex').slice(0, 12);
}

module.exports = {
  QUOTE_TTL_MS,
  CONNECTION_TTL_MS,
  createQuoteToken,
  readQuoteToken,
  createConnectionToken,
  readConnectionToken,
  credsFingerprint,
};
