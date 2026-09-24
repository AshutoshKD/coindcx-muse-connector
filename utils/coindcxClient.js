const crypto = require('crypto');
const axios = require('axios');
const { readConnectionToken } = require('./tokens');

const API_BASE = process.env.COINDCX_API_BASE_URL || 'https://api.coindcx.com';
const PUBLIC_BASE = process.env.COINDCX_PUBLIC_BASE_URL || 'https://public.coindcx.com';

function signBody(body, apiSecret) {
  const jsonBody = JSON.stringify(body);
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(jsonBody)
    .digest('hex');
  return { jsonBody, signature };
}

/**
 * Resolve CoinDCX credentials for a request.
 * Priority:
 * 1. X-COINDCX-CONNECTION (encrypted token from POST /account/connect)
 * 2. X-COINDCX-API-KEY + X-COINDCX-API-SECRET headers
 * 3. Env COINDCX_API_KEY/SECRET (local/dev only)
 */
function resolveCredentials(req) {
  const connHeader = req?.headers?.['x-coindcx-connection'];
  if (connHeader) {
    const opened = readConnectionToken(connHeader);
    if (opened) {
      return {
        apiKey: opened.apiKey,
        apiSecret: opened.apiSecret,
        source: 'connection_token',
        expires_at: opened.expires_at,
      };
    }
  }

  const headerKey = req?.headers?.['x-coindcx-api-key'];
  const headerSecret = req?.headers?.['x-coindcx-api-secret'];
  if (headerKey && headerSecret) {
    return { apiKey: headerKey, apiSecret: headerSecret, source: 'headers' };
  }

  if (process.env.COINDCX_API_KEY && process.env.COINDCX_API_SECRET) {
    return {
      apiKey: process.env.COINDCX_API_KEY,
      apiSecret: process.env.COINDCX_API_SECRET,
      source: 'env',
    };
  }
  return null;
}

async function signedPost(path, body = {}, credentials) {
  if (!credentials?.apiKey || !credentials?.apiSecret) {
    const err = new Error('Missing CoinDCX API credentials');
    err.status = 401;
    throw err;
  }

  const payload = { ...body, timestamp: Date.now() };
  const { jsonBody, signature } = signBody(payload, credentials.apiSecret);

  const { data, status } = await axios.post(`${API_BASE}${path}`, jsonBody, {
    headers: {
      'Content-Type': 'application/json',
      'X-AUTH-APIKEY': credentials.apiKey,
      'X-AUTH-SIGNATURE': signature,
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  return { data, status, payload };
}

async function publicGet(path, params = {}, usePublicHost = false) {
  const base = usePublicHost ? PUBLIC_BASE : API_BASE;
  const { data, status } = await axios.get(`${base}${path}`, {
    params,
    timeout: 15000,
    validateStatus: () => true,
  });
  return { data, status };
}

module.exports = {
  API_BASE,
  PUBLIC_BASE,
  signBody,
  resolveCredentials,
  signedPost,
  publicGet,
};
