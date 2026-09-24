const router = require('express').Router();
const { resolveCredentials, signedPost } = require('../utils/coindcxClient');
const {
  buildTradePlan,
  saveQuote,
  takeQuote,
  peekQuote,
  credsFingerprint,
  liveOrdersAllowed,
  waitForFill,
  extractOrderId,
} = require('../utils/marketHelpers');
const { sendSpokenError } = require('../utils/spokenErrors');

function requireCreds(req, res) {
  const creds = resolveCredentials(req);
  if (!creds) {
    res.status(401).json({
      error: 'CoinDCX account not connected',
      spoken_summary: 'Connect your CoinDCX account first. Paste your API key using the connect step.',
      message: 'Pass X-COINDCX-CONNECTION token, or X-COINDCX-API-KEY + X-COINDCX-API-SECRET.',
    });
    return null;
  }
  return creds;
}

async function placeAndWait(creds, plan) {
  const body = {
    market: plan.market,
    side: plan.side,
    order_type: 'market_order',
    total_quantity: plan.total_quantity,
    client_order_id: `muse-${plan.side}-${Date.now()}`,
  };
  const created = await signedPost('/exchange/v1/orders/create', body, creds);
  if (created.status >= 400) {
    return { ok: false, create: created };
  }
  const orderId = extractOrderId(created.data);
  let fill = { order: null, timed_out: false };
  if (orderId) {
    fill = await waitForFill(creds, orderId, { timeoutMs: 12000, intervalMs: 700 });
  }
  return { ok: true, create: created, orderId, fill };
}

function fillSpoken(plan, fill) {
  const order = fill?.order;
  const status = order?.status || 'submitted';
  if (status === 'filled') {
    const avg = order.avg_price || plan.unit_price;
    const fee = order.fee_amount != null ? ` Fee ₹${Number(order.fee_amount).toFixed(2)}.` : '';
    return `Done. ${plan.side === 'buy' ? 'Bought' : 'Sold'} ${order.total_quantity || plan.total_quantity} ${plan.coin} at ₹${avg}.${fee}`;
  }
  if (fill?.timed_out) {
    return `Order submitted (${status}). Still settling — check back in a moment.`;
  }
  return `Order ${status}: ${plan.spoken_summary}`;
}

// POST /orders/quote
router.post('/quote', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  const { side = 'buy', coin, amount_inr, quantity, all } = req.body;
  if (!['buy', 'sell'].includes(String(side).toLowerCase())) {
    return res.status(400).json({
      error: 'side must be buy or sell',
      spoken_summary: 'Say whether you want to buy or sell.',
    });
  }

  try {
    const plan = await buildTradePlan(String(side).toLowerCase(), {
      coin, amount_inr, quantity, all,
    }, creds);
    const entry = saveQuote(plan, credsFingerprint(creds));

    res.json({
      quote_id: entry.quote_id,
      expires_in_seconds: entry.expires_in_seconds,
      needs_confirmation: true,
      executable: plan.executable,
      warnings: plan.warnings,
      spoken_summary: plan.spoken_summary + (plan.executable ? ' Confirm to place this order.' : ' Fix warnings before confirming.'),
      plan,
      note: 'quote_id is a signed token — works across serverless instances.',
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

// POST /orders/confirm  { quote_id }
router.post('/confirm', async (req, res) => {
  if (!liveOrdersAllowed()) {
    return res.status(403).json({
      error: 'Live orders disabled',
      spoken_summary: 'Live trading is turned off on this connector right now.',
    });
  }

  const creds = requireCreds(req, res);
  if (!creds) return;

  const { quote_id } = req.body;
  if (!quote_id) {
    return res.status(400).json({
      error: 'Required: quote_id',
      spoken_summary: 'I need the quote id from the previous price check to confirm.',
    });
  }

  const entry = takeQuote(quote_id);
  if (!entry) {
    return res.status(410).json({
      error: 'Quote expired or invalid',
      spoken_summary: 'That quote expired. Ask me again and I will get a fresh price.',
    });
  }
  if (entry.credsFingerprint !== credsFingerprint(creds)) {
    return res.status(403).json({
      error: 'Quote belongs to a different account connection.',
      spoken_summary: 'This quote was for a different CoinDCX account. Please quote again.',
    });
  }
  if (!entry.plan.executable) {
    return res.status(400).json({
      error: 'Quote was not executable',
      warnings: entry.plan.warnings,
      spoken_summary: entry.plan.warnings?.[0] || 'This quote cannot be executed.',
    });
  }

  try {
    const placed = await placeAndWait(creds, entry.plan);
    if (!placed.ok) {
      return sendSpokenError(res, placed.create.status, { data: placed.create.data }, entry.plan);
    }
    res.json({
      success: true,
      order_id: placed.orderId,
      status: placed.fill.order?.status || 'submitted',
      timed_out: placed.fill.timed_out,
      spoken_summary: fillSpoken(entry.plan, placed.fill),
      plan: entry.plan,
      result: placed.create.data,
      order: placed.fill.order,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, entry.plan);
  }
});

// GET /orders/quote peek — for signed tokens, re-validates
router.get('/quote/:id', (req, res) => {
  // Express may truncate long tokens in path — prefer POST body for confirm
  const entry = peekQuote(req.params.id);
  if (!entry) {
    return res.status(404).json({
      error: 'Quote not found or expired',
      spoken_summary: 'That quote expired. Ask for a new quote.',
      hint: 'Prefer POST /orders/confirm with quote_id in the JSON body (tokens are long).',
    });
  }
  res.json({
    expires_at: new Date(entry.expires_at).toISOString(),
    plan: entry.plan,
  });
});

// POST /orders/buy
router.post('/buy', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  const { coin, amount_inr, quantity, confirm } = req.body;
  try {
    const plan = await buildTradePlan('buy', { coin, amount_inr, quantity }, creds);

    if (!confirm) {
      const entry = saveQuote(plan, credsFingerprint(creds));
      return res.json({
        needs_confirmation: true,
        quote_id: entry.quote_id,
        expires_in_seconds: entry.expires_in_seconds,
        executable: plan.executable,
        warnings: plan.warnings,
        spoken_summary: plan.spoken_summary + ' Say confirm to buy.',
        plan,
      });
    }

    if (!liveOrdersAllowed()) {
      return res.status(403).json({ error: 'Live orders disabled', plan, spoken_summary: 'Live trading is off.' });
    }
    if (!plan.executable) {
      return res.status(400).json({
        error: 'Order not executable',
        warnings: plan.warnings,
        plan,
        spoken_summary: plan.warnings?.[0] || 'Cannot place this buy.',
      });
    }

    const placed = await placeAndWait(creds, plan);
    if (!placed.ok) {
      return sendSpokenError(res, placed.create.status, { data: placed.create.data }, plan);
    }
    res.json({
      success: true,
      order_id: placed.orderId,
      status: placed.fill.order?.status || 'submitted',
      spoken_summary: fillSpoken(plan, placed.fill),
      plan,
      result: placed.create.data,
      order: placed.fill.order,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

// POST /orders/sell
router.post('/sell', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  const { coin, amount_inr, quantity, all, confirm } = req.body;
  try {
    const plan = await buildTradePlan('sell', { coin, amount_inr, quantity, all }, creds);

    if (!confirm) {
      const entry = saveQuote(plan, credsFingerprint(creds));
      return res.json({
        needs_confirmation: true,
        quote_id: entry.quote_id,
        expires_in_seconds: entry.expires_in_seconds,
        executable: plan.executable,
        warnings: plan.warnings,
        spoken_summary: plan.spoken_summary + ' Say confirm to sell.',
        plan,
      });
    }

    if (!liveOrdersAllowed()) {
      return res.status(403).json({ error: 'Live orders disabled', plan, spoken_summary: 'Live trading is off.' });
    }
    if (!plan.executable) {
      return res.status(400).json({
        error: 'Order not executable',
        warnings: plan.warnings,
        plan,
        spoken_summary: plan.warnings?.[0] || 'Cannot place this sell.',
      });
    }

    const placed = await placeAndWait(creds, plan);
    if (!placed.ok) {
      return sendSpokenError(res, placed.create.status, { data: placed.create.data }, plan);
    }
    res.json({
      success: true,
      order_id: placed.orderId,
      status: placed.fill.order?.status || 'submitted',
      spoken_summary: fillSpoken(plan, placed.fill),
      plan,
      result: placed.create.data,
      order: placed.fill.order,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

// Raw create
router.post('/create', async (req, res) => {
  if (!liveOrdersAllowed()) {
    return res.status(403).json({ error: 'Live orders disabled', spoken_summary: 'Live trading is off.' });
  }

  const creds = requireCreds(req, res);
  if (!creds) return;

  const {
    market,
    side,
    order_type = 'limit_order',
    total_quantity,
    price_per_unit,
    client_order_id,
  } = req.body;

  if (!market || !side || !total_quantity) {
    return res.status(400).json({
      error: 'Required: market, side, total_quantity',
      spoken_summary: 'Missing order details.',
    });
  }

  if (order_type === 'limit_order' && (price_per_unit === undefined || price_per_unit === null)) {
    return res.status(400).json({ error: 'price_per_unit required for limit_order' });
  }

  const body = {
    market: String(market).toUpperCase(),
    side: String(side).toLowerCase(),
    order_type,
    total_quantity: Number(total_quantity),
  };
  if (price_per_unit !== undefined) body.price_per_unit = Number(price_per_unit);
  if (client_order_id) body.client_order_id = String(client_order_id);

  try {
    const { data, status } = await signedPost('/exchange/v1/orders/create', body, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    const orderId = extractOrderId(data);
    const fill = orderId ? await waitForFill(creds, orderId) : { order: null, timed_out: false };
    res.json({
      success: true,
      auth_source: creds.source,
      result: data,
      order: fill.order,
      spoken_summary: fill.order?.status === 'filled'
        ? `Order filled at ₹${fill.order.avg_price}.`
        : 'Order submitted.',
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.post('/status', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Required: id' });

  try {
    const { data, status } = await signedPost('/exchange/v1/orders/status', { id }, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    res.json({
      order: data,
      spoken_summary: `Order ${id} is ${data?.status || 'unknown'}.`,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.get('/active', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  const body = {};
  if (req.query.market) body.market = String(req.query.market).toUpperCase();

  try {
    const { data, status } = await signedPost('/exchange/v1/orders/active_orders', body, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    const orders = data?.orders || data || [];
    const count = Array.isArray(orders) ? orders.length : 0;
    res.json({
      orders: data,
      spoken_summary: count ? `You have ${count} open order${count === 1 ? '' : 's'}.` : 'You have no open orders.',
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

/**
 * GET /orders/count?market=BTCINR&side=buy
 * Voice: "Do I have any open orders?"
 */
router.get('/count', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  const market = req.query.market ? String(req.query.market).toUpperCase() : null;
  const side = req.query.side ? String(req.query.side).toLowerCase() : null;

  try {
    // CoinDCX active_orders_count requires market; without it, list actives and count
    if (market) {
      const body = { market };
      if (side) body.side = side;
      const { data, status } = await signedPost('/exchange/v1/orders/active_orders_count', body, creds);
      if (status >= 400) return sendSpokenError(res, status, { data }, {});
      const count = data?.count ?? data?.data?.count ?? 0;
      res.json({
        market,
        side: side || 'all',
        count,
        spoken_summary: count
          ? `You have ${count} open ${side || ''} order${count === 1 ? '' : 's'} on ${market}.`.replace(/\s+/g, ' ').trim()
          : `You have no open orders on ${market}.`,
        raw: data,
      });
      return;
    }

    const { data, status } = await signedPost('/exchange/v1/orders/active_orders', {}, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    let orders = data?.orders || data || [];
    if (!Array.isArray(orders)) orders = [];
    if (side) orders = orders.filter((o) => String(o.side).toLowerCase() === side);
    res.json({
      market: 'ALL',
      side: side || 'all',
      count: orders.length,
      spoken_summary: orders.length
        ? `You have ${orders.length} open order${orders.length === 1 ? '' : 's'}.`
        : 'You have no open orders.',
      orders,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

/** POST /orders/status-multiple { ids?: [], client_order_ids?: [] } */
router.post('/status-multiple', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  const { ids, client_order_ids } = req.body;
  if ((!ids || !ids.length) && (!client_order_ids || !client_order_ids.length)) {
    return res.status(400).json({
      error: 'Required: ids or client_order_ids array',
      spoken_summary: 'Tell me which order ids to check.',
    });
  }

  const body = {};
  if (ids?.length) body.ids = ids.map(String);
  if (client_order_ids?.length) body.client_order_ids = client_order_ids.map(String);

  try {
    const { data, status } = await signedPost('/exchange/v1/orders/status_multiple', body, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    const list = Array.isArray(data) ? data : (data?.orders || []);
    const filled = list.filter((o) => o.status === 'filled').length;
    res.json({
      orders: data,
      count: list.length,
      spoken_summary: list.length
        ? `Checked ${list.length} order${list.length === 1 ? '' : 's'}; ${filled} filled.`
        : 'No matching orders found.',
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.post('/cancel', async (req, res) => {
  if (!liveOrdersAllowed()) {
    return res.status(403).json({ error: 'Live orders disabled' });
  }
  const creds = requireCreds(req, res);
  if (!creds) return;
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Required: id' });

  try {
    const { data, status } = await signedPost('/exchange/v1/orders/cancel', { id }, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    res.json({ success: true, result: data, spoken_summary: `Cancelled order ${id}.` });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

/** POST /orders/cancel-by-ids { ids?: [], client_order_ids?: [] } */
router.post('/cancel-by-ids', async (req, res) => {
  if (!liveOrdersAllowed()) {
    return res.status(403).json({
      error: 'Live orders disabled',
      spoken_summary: 'Live trading is turned off.',
    });
  }
  const creds = requireCreds(req, res);
  if (!creds) return;

  const { ids, client_order_ids } = req.body;
  if ((!ids || !ids.length) && (!client_order_ids || !client_order_ids.length)) {
    return res.status(400).json({
      error: 'Required: ids or client_order_ids array',
      spoken_summary: 'Tell me which order ids to cancel.',
    });
  }

  const body = {};
  if (ids?.length) body.ids = ids;
  if (client_order_ids?.length) body.client_order_ids = client_order_ids;

  try {
    const { data, status } = await signedPost('/exchange/v1/orders/cancel_by_ids', body, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    const n = ids?.length || client_order_ids?.length || 0;
    res.json({
      success: true,
      result: data,
      spoken_summary: `Cancelled ${n} order${n === 1 ? '' : 's'}.`,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.post('/cancel-all', async (req, res) => {
  if (!liveOrdersAllowed()) {
    return res.status(403).json({ error: 'Live orders disabled' });
  }
  const creds = requireCreds(req, res);
  if (!creds) return;

  const body = {};
  if (req.body.market) body.market = String(req.body.market).toUpperCase();
  if (req.body.side) body.side = String(req.body.side).toLowerCase();

  try {
    const { data, status } = await signedPost('/exchange/v1/orders/cancel_all', body, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    res.json({
      success: true,
      result: data,
      spoken_summary: body.market
        ? `Cancelled all open orders on ${body.market}.`
        : 'Cancelled all open orders.',
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.post('/edit', async (req, res) => {
  if (!liveOrdersAllowed()) {
    return res.status(403).json({ error: 'Live orders disabled' });
  }
  const creds = requireCreds(req, res);
  if (!creds) return;
  const { id, price_per_unit } = req.body;
  if (!id || price_per_unit === undefined) {
    return res.status(400).json({ error: 'Required: id, price_per_unit' });
  }

  try {
    const { data, status } = await signedPost(
      '/exchange/v1/orders/edit',
      { id, price_per_unit: Number(price_per_unit) },
      creds,
    );
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    res.json({ success: true, result: data, spoken_summary: `Updated order ${id} price.` });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

/**
 * POST /orders/create-multiple
 * Body: { orders: [ { market, side, order_type, total_quantity, price_per_unit?, ecode? } ] }
 * Max 10; INR markets typically use ecode "I"
 */
router.post('/create-multiple', async (req, res) => {
  if (!liveOrdersAllowed()) {
    return res.status(403).json({
      error: 'Live orders disabled',
      spoken_summary: 'Live trading is turned off.',
    });
  }
  const creds = requireCreds(req, res);
  if (!creds) return;

  const ordersIn = req.body.orders;
  if (!Array.isArray(ordersIn) || !ordersIn.length) {
    return res.status(400).json({
      error: 'Required: orders array (max 10)',
      spoken_summary: 'Provide a list of orders to place.',
    });
  }
  if (ordersIn.length > 10) {
    return res.status(400).json({
      error: 'Maximum 10 orders per request',
      spoken_summary: 'CoinDCX allows at most 10 orders at once.',
    });
  }

  const ts = Date.now();
  const orders = ordersIn.map((o, i) => {
    const market = String(o.market || '').toUpperCase();
    const row = {
      side: String(o.side || '').toLowerCase(),
      order_type: o.order_type || 'limit_order',
      market,
      total_quantity: Number(o.total_quantity),
      timestamp: ts,
      ecode: o.ecode || (market.endsWith('INR') ? 'I' : 'B'),
      client_order_id: o.client_order_id || `muse-multi-${ts}-${i}`,
    };
    if (o.price_per_unit != null) row.price_per_unit = Number(o.price_per_unit);
    return row;
  });

  try {
    const { data, status } = await signedPost('/exchange/v1/orders/create_multiple', { orders }, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    res.json({
      success: true,
      result: data,
      spoken_summary: `Submitted ${orders.length} orders.`,
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

router.get('/history', async (req, res) => {
  const creds = requireCreds(req, res);
  if (!creds) return;

  const body = { limit: Number(req.query.limit) || 50 };
  if (req.query.from_id) body.from_id = req.query.from_id;
  if (req.query.symbol) body.symbol = String(req.query.symbol).toUpperCase();

  try {
    const { data, status } = await signedPost('/exchange/v1/orders/trade_history', body, creds);
    if (status >= 400) return sendSpokenError(res, status, { data }, {});
    const n = Array.isArray(data) ? data.length : 0;
    res.json({
      trades: data,
      spoken_summary: n ? `Here are your last ${n} trades.` : 'No recent trades.',
    });
  } catch (err) {
    return sendSpokenError(res, err.status || 500, err, {});
  }
});

module.exports = router;
