const crypto = require('crypto');
const { publicGet, signedPost } = require('./coindcxClient');

function tickerMap(tickers) {
  const map = {};
  if (!Array.isArray(tickers)) return map;
  for (const t of tickers) map[t.market] = t;
  return map;
}

function detailsMap(details) {
  const map = {};
  if (!Array.isArray(details)) return map;
  for (const d of details) {
    if (d.coindcx_name) map[d.coindcx_name] = d;
  }
  return map;
}

function normalizeCoin(coin) {
  let c = String(coin || '').trim().toUpperCase().replace(/^\$/, '');
  // Strip quote suffixes only when a base asset remains (BTCINR → BTC), not USDT/INR themselves
  if (c.length > 3 && c.endsWith('INR')) c = c.slice(0, -3);
  else if (c.length > 4 && c.endsWith('USDT')) c = c.slice(0, -4);
  return c;
}

/** Best INR price for a currency code. */
function priceInInr(currency, map) {
  const c = normalizeCoin(currency);
  if (c === 'INR' || c === '') {
    return { price_inr: 1, market: 'INR', last_price: 1, change_24_hour: '0', bid: 1, ask: 1 };
  }

  const inrPair = `${c}INR`;
  if (map[inrPair]) {
    const t = map[inrPair];
    return {
      coin: c,
      price_inr: parseFloat(t.last_price),
      market: inrPair,
      last_price: parseFloat(t.last_price),
      change_24_hour: t.change_24_hour,
      bid: parseFloat(t.bid),
      ask: parseFloat(t.ask),
      high: t.high,
      low: t.low,
      volume: t.volume,
    };
  }

  const usdtPair = `${c}USDT`;
  const usdtInr = map.USDTINR;
  if (map[usdtPair] && usdtInr) {
    const lastUsdt = parseFloat(map[usdtPair].last_price);
    const usdtRate = parseFloat(usdtInr.last_price);
    const bidUsdt = parseFloat(map[usdtPair].bid);
    const askUsdt = parseFloat(map[usdtPair].ask);
    return {
      coin: c,
      price_inr: lastUsdt * usdtRate,
      market: `${usdtPair}→USDTINR`,
      trade_market: usdtPair,
      last_price: lastUsdt,
      usdt_inr: usdtRate,
      change_24_hour: map[usdtPair].change_24_hour,
      bid: bidUsdt * usdtRate,
      ask: askUsdt * usdtRate,
      high: map[usdtPair].high,
      low: map[usdtPair].low,
      volume: map[usdtPair].volume,
    };
  }

  return { coin: c, price_inr: null, market: null, last_price: null };
}

/** Prefer INR market for trading; fall back to USDT. */
function resolveTradeMarket(coin, tickMap, detMap) {
  const c = normalizeCoin(coin);
  const inr = `${c}INR`;
  const usdt = `${c}USDT`;
  if (tickMap[inr] && detMap[inr]) {
    return { market: inr, details: detMap[inr], ticker: tickMap[inr], quote_currency: 'INR' };
  }
  if (tickMap[usdt] && detMap[usdt]) {
    return { market: usdt, details: detMap[usdt], ticker: tickMap[usdt], quote_currency: 'USDT' };
  }
  return null;
}

/** Resolve candle/orderbook `pair` string from coin (e.g. I-BTC_INR). */
function resolvePair(coin, detMap, preferQuote = 'INR') {
  const c = normalizeCoin(coin);
  const preferred = `${c}${preferQuote}`;
  const fallback = preferQuote === 'INR' ? `${c}USDT` : `${c}INR`;
  const details = detMap[preferred] || detMap[fallback] || detMap[c];
  if (!details?.pair) return null;
  return {
    coin: c,
    market: details.coindcx_name,
    pair: details.pair,
    details,
    quote_currency: details.base_currency_short_name || preferQuote,
  };
}

function roundQty(qty, precision) {
  const p = Number.isFinite(precision) ? precision : 4;
  const f = 10 ** p;
  return Math.floor(qty * f) / f;
}

function roundPrice(price, precision) {
  const p = Number.isFinite(precision) ? precision : 2;
  const f = 10 ** p;
  return Math.round(price * f) / f;
}

async function loadMarketContext() {
  const [tickRes, detRes] = await Promise.all([
    publicGet('/exchange/ticker'),
    publicGet('/exchange/v1/markets_details'),
  ]);
  if (tickRes.status >= 400) throw Object.assign(new Error('Failed to load tickers'), { status: tickRes.status, data: tickRes.data });
  if (detRes.status >= 400) throw Object.assign(new Error('Failed to load market details'), { status: detRes.status, data: detRes.data });
  return {
    tickMap: tickerMap(tickRes.data),
    detMap: detailsMap(detRes.data),
    tickers: tickRes.data,
    details: detRes.data,
  };
}

async function buildHoldings(creds) {
  const [balRes, ctx] = await Promise.all([
    signedPost('/exchange/v1/users/balances', {}, creds),
    loadMarketContext(),
  ]);
  if (balRes.status >= 400) {
    const err = new Error('Failed to load balances');
    err.status = balRes.status;
    err.data = balRes.data;
    throw err;
  }

  const holdings = (Array.isArray(balRes.data) ? balRes.data : [])
    .filter((b) => parseFloat(b.balance) > 0 || parseFloat(b.locked_balance || 0) > 0)
    .map((b) => {
      const free = parseFloat(b.balance) || 0;
      const locked = parseFloat(b.locked_balance) || 0;
      const total = free + locked;
      const px = priceInInr(b.currency, ctx.tickMap);
      const valueInr = px.price_inr != null ? total * px.price_inr : null;
      const ch = parseFloat(px.change_24_hour);
      // Estimate value ~24h ago from % change: past = current / (1 + ch/100)
      let value_24h_ago = null;
      let pnl_24h_inr = null;
      if (valueInr != null && Number.isFinite(ch) && ch !== -100) {
        value_24h_ago = valueInr / (1 + ch / 100);
        pnl_24h_inr = valueInr - value_24h_ago;
      }
      return {
        currency: b.currency,
        balance: free,
        locked_balance: locked,
        total,
        price_inr: px.price_inr,
        value_inr: valueInr,
        market: px.market,
        change_24_hour: px.change_24_hour ?? null,
        pnl_24h_inr,
        bid: px.bid ?? null,
        ask: px.ask ?? null,
      };
    })
    .sort((a, b) => (b.value_inr || 0) - (a.value_inr || 0));

  const totalValueInr = holdings.reduce((s, h) => s + (h.value_inr || 0), 0);
  const totalPnl24h = holdings.reduce((s, h) => s + (h.pnl_24h_inr || 0), 0);

  return { holdings, totalValueInr, totalPnl24h, ctx, balances: balRes.data };
}

/**
 * Build a voice-friendly trade plan.
 * side: buy|sell
 * inputs: { coin, amount_inr?, quantity?, all? }
 */
async function buildTradePlan(side, { coin, amount_inr, quantity, all }, creds) {
  const c = normalizeCoin(coin);
  if (!c) {
    const err = new Error('coin is required (e.g. BTC, DOGE)');
    err.status = 400;
    throw err;
  }

  const ctx = await loadMarketContext();
  const resolved = resolveTradeMarket(c, ctx.tickMap, ctx.detMap);
  if (!resolved) {
    const err = new Error(`No tradeable market found for ${c}`);
    err.status = 404;
    throw err;
  }

  const { market, details, ticker, quote_currency } = resolved;
  const targetPrec = details.target_currency_precision ?? 4;
  const basePrec = details.base_currency_precision ?? 2;
  const minQty = parseFloat(details.min_quantity) || 0;
  const minNotional = parseFloat(details.min_notional) || 0;

  const last = parseFloat(ticker.last_price);
  const ask = parseFloat(ticker.ask) || last;
  const bid = parseFloat(ticker.bid) || last;
  const unitPrice = side === 'buy' ? ask : bid;

  let qty;
  let mode;

  if (all && side === 'sell') {
    const balRes = await signedPost('/exchange/v1/users/balances', {}, creds);
    if (balRes.status >= 400) {
      const err = new Error('Failed to load balances');
      err.status = balRes.status;
      err.data = balRes.data;
      throw err;
    }
    const row = (balRes.data || []).find((b) => String(b.currency).toUpperCase() === c);
    const free = row ? parseFloat(row.balance) || 0 : 0;
    qty = roundQty(free, targetPrec);
    mode = 'all';
    if (qty <= 0 && free > 0) {
      const err = new Error(
        `You have ${free} ${c}, but this market only allows precision ${targetPrec} (min sellable unit too large for your balance).`,
      );
      err.status = 400;
      throw err;
    }
  } else if (amount_inr != null && amount_inr !== '') {
    const inr = Number(amount_inr);
    if (!Number.isFinite(inr) || inr <= 0) {
      const err = new Error('amount_inr must be a positive number');
      err.status = 400;
      throw err;
    }
    // Convert INR budget → quote currency if market is USDT-quoted
    let spendInQuote = inr;
    if (quote_currency === 'USDT') {
      const usdtInr = ctx.tickMap.USDTINR ? parseFloat(ctx.tickMap.USDTINR.last_price) : null;
      if (!usdtInr) {
        const err = new Error('USDTINR rate unavailable');
        err.status = 502;
        throw err;
      }
      spendInQuote = inr / usdtInr;
    }
    qty = roundQty(spendInQuote / unitPrice, targetPrec);
    mode = 'amount_inr';
  } else if (quantity != null && quantity !== '') {
    qty = roundQty(Number(quantity), targetPrec);
    mode = 'quantity';
  } else {
    const err = new Error('Provide amount_inr, quantity, or all:true (sell only)');
    err.status = 400;
    throw err;
  }

  if (!Number.isFinite(qty) || qty <= 0) {
    const err = new Error('Computed quantity is zero — try a larger amount');
    err.status = 400;
    throw err;
  }

  const estNotionalQuote = qty * unitPrice;
  let estNotionalInr = estNotionalQuote;
  if (quote_currency === 'USDT' && ctx.tickMap.USDTINR) {
    estNotionalInr = estNotionalQuote * parseFloat(ctx.tickMap.USDTINR.last_price);
  }

  // CoinDCX market details don't expose fee %; INR spot taker is typically ~0.59%
  const feePercent = Number(process.env.COINDCX_TAKER_FEE_PERCENT || '0.59');
  const estimatedFeeInr = (estNotionalInr * feePercent) / 100;
  const estimatedNetInr = side === 'buy'
    ? estNotionalInr + estimatedFeeInr
    : Math.max(0, estNotionalInr - estimatedFeeInr);

  const warnings = [];
  if (qty < minQty) warnings.push(`Quantity ${qty} is below min_quantity ${minQty}`);
  if (estNotionalQuote < minNotional) {
    warnings.push(`Notional ${estNotionalQuote.toFixed(4)} ${quote_currency} is below min_notional ${minNotional}`);
  }

  const spoken = side === 'buy'
    ? `Buy about ${qty} ${c} for ~₹${estNotionalInr.toFixed(2)} plus ~₹${estimatedFeeInr.toFixed(2)} fee (${feePercent}%), total ~₹${estimatedNetInr.toFixed(2)}`
    : `Sell about ${qty} ${c} for ~₹${estNotionalInr.toFixed(2)} minus ~₹${estimatedFeeInr.toFixed(2)} fee (${feePercent}%), you get ~₹${estimatedNetInr.toFixed(2)}`;

  return {
    side,
    coin: c,
    mode,
    market,
    quote_currency,
    order_type: 'market_order',
    total_quantity: qty,
    unit_price: unitPrice,
    last_price: last,
    estimated_notional_quote: roundPrice(estNotionalQuote, basePrec),
    estimated_notional_inr: roundPrice(estNotionalInr, 2),
    fee_percent: feePercent,
    estimated_fee_inr: roundPrice(estimatedFeeInr, 2),
    estimated_total_inr: roundPrice(estimatedNetInr, 2),
    min_quantity: minQty,
    min_notional: minNotional,
    warnings,
    spoken_summary: spoken,
    executable: warnings.length === 0,
  };
}

const { createQuoteToken, readQuoteToken, credsFingerprint } = require('./tokens');
const QUOTE_TTL_MS = 2 * 60 * 1000;

function saveQuote(plan, fingerprint) {
  const quote_id = createQuoteToken(plan, fingerprint);
  return {
    quote_id,
    created_at: Date.now(),
    expires_at: Date.now() + QUOTE_TTL_MS,
    expires_in_seconds: Math.floor(QUOTE_TTL_MS / 1000),
    credsFingerprint: fingerprint,
    plan,
  };
}

function takeQuote(quote_id) {
  // Stateless: validate signature + expiry (token is the quote_id)
  return readQuoteToken(quote_id);
}

function peekQuote(quote_id) {
  return readQuoteToken(quote_id);
}

async function waitForFill(creds, orderId, { timeoutMs = 15000, intervalMs = 800 } = {}) {
  const start = Date.now();
  let last = null;
  const terminal = new Set(['filled', 'partially_cancelled', 'cancelled', 'rejected']);

  while (Date.now() - start < timeoutMs) {
    const { data, status } = await signedPost('/exchange/v1/orders/status', { id: orderId }, creds);
    if (status < 400) {
      last = data;
      const st = String(data?.status || '').toLowerCase();
      if (terminal.has(st)) return { order: data, timed_out: false };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { order: last, timed_out: true };
}

function extractOrderId(createResult) {
  return createResult?.orders?.[0]?.id || createResult?.id || null;
}

// ── Alerts store (in-memory; persistence skipped per request) ─────
const alerts = new Map();

function createAlert({ coin, target_price_inr, direction = 'above', label }) {
  const id = crypto.randomBytes(6).toString('hex');
  const alert = {
    id,
    coin: normalizeCoin(coin),
    target_price_inr: Number(target_price_inr),
    direction: direction === 'below' ? 'below' : 'above',
    label: label || null,
    created_at: new Date().toISOString(),
    triggered: false,
    triggered_at: null,
  };
  alerts.set(id, alert);
  return alert;
}

function listAlerts() {
  return Array.from(alerts.values());
}

function deleteAlert(id) {
  return alerts.delete(id);
}

async function checkAlerts() {
  const { tickMap } = await loadMarketContext();
  const results = [];
  for (const alert of alerts.values()) {
    const px = priceInInr(alert.coin, tickMap);
    if (px.price_inr == null) {
      results.push({ ...alert, current_price_inr: null, status: 'no_price' });
      continue;
    }
    const hit = alert.direction === 'above'
      ? px.price_inr >= alert.target_price_inr
      : px.price_inr <= alert.target_price_inr;
    if (hit && !alert.triggered) {
      alert.triggered = true;
      alert.triggered_at = new Date().toISOString();
    }
    results.push({
      ...alert,
      current_price_inr: px.price_inr,
      status: hit ? 'triggered' : 'watching',
      spoken: hit
        ? `${alert.coin} is ₹${px.price_inr.toFixed(2)}, ${alert.direction} your target ₹${alert.target_price_inr}`
        : `${alert.coin} is ₹${px.price_inr.toFixed(2)}, still watching for ${alert.direction} ₹${alert.target_price_inr}`,
    });
  }
  return results;
}

function liveOrdersAllowed() {
  return String(process.env.ALLOW_LIVE_ORDERS).toLowerCase() === 'true';
}

module.exports = {
  tickerMap,
  detailsMap,
  normalizeCoin,
  priceInInr,
  resolveTradeMarket,
  resolvePair,
  roundQty,
  loadMarketContext,
  buildHoldings,
  buildTradePlan,
  saveQuote,
  takeQuote,
  peekQuote,
  credsFingerprint,
  waitForFill,
  extractOrderId,
  createAlert,
  listAlerts,
  deleteAlert,
  checkAlerts,
  liveOrdersAllowed,
  QUOTE_TTL_MS,
};
