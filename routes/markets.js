const router = require('express').Router();
const { publicGet } = require('../utils/coindcxClient');
const {
  normalizeCoin,
  priceInInr,
  loadMarketContext,
  resolvePair,
} = require('../utils/marketHelpers');

const PERIOD_CONFIG = {
  '1h': { interval: '1m', bars: 60, label: 'the last hour' },
  '4h': { interval: '15m', bars: 16, label: 'the last 4 hours' },
  '1d': { interval: '1h', bars: 24, label: 'today' },
  '1w': { interval: '1d', bars: 7, label: 'this week' },
  '1M': { interval: '1d', bars: 30, label: 'this month' },
};

// GET /markets/price?coin=BTC — voice-friendly single coin price in INR
router.get('/price', async (req, res) => {
  const coin = normalizeCoin(req.query.coin || req.query.symbol);
  if (!coin) return res.status(400).json({ error: 'Required query: coin (e.g. BTC, ETH, DOGE)' });

  try {
    const { tickMap } = await loadMarketContext();
    const px = priceInInr(coin, tickMap);
    if (px.price_inr == null) {
      return res.status(404).json({ error: `No price found for ${coin}` });
    }
    const ch = parseFloat(px.change_24_hour);
    res.json({
      coin,
      price_inr: px.price_inr,
      market: px.market,
      last_price: px.last_price,
      bid: px.bid,
      ask: px.ask,
      change_24_hour: px.change_24_hour,
      high: px.high,
      low: px.low,
      spoken_summary: Number.isFinite(ch)
        ? `${coin} is ₹${px.price_inr.toLocaleString('en-IN', { maximumFractionDigits: 2 })}, ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(2)}% in 24 hours.`
        : `${coin} is ₹${px.price_inr.toLocaleString('en-IN', { maximumFractionDigits: 2 })}.`,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /markets/movers?limit=10&quote=INR — top gainers / losers
router.get('/movers', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const quote = (req.query.quote || 'INR').toUpperCase(); // INR | USDT | ALL

  try {
    const { data, status } = await publicGet('/exchange/ticker');
    if (status >= 400) return res.status(status).json({ error: data });

    let list = Array.isArray(data) ? data.slice() : [];
    if (quote !== 'ALL') {
      list = list.filter((t) => String(t.market).endsWith(quote));
    }

    const scored = list
      .map((t) => ({
        market: t.market,
        last_price: parseFloat(t.last_price),
        change_24_hour: parseFloat(t.change_24_hour),
        volume: parseFloat(t.volume),
        high: t.high,
        low: t.low,
      }))
      .filter((t) => Number.isFinite(t.change_24_hour));

    const gainers = [...scored].sort((a, b) => b.change_24_hour - a.change_24_hour).slice(0, limit);
    const losers = [...scored].sort((a, b) => a.change_24_hour - b.change_24_hour).slice(0, limit);

    const topGainer = gainers[0];
    res.json({
      quote,
      gainers,
      losers,
      spoken_summary: topGainer
        ? `Top gainer is ${topGainer.market}, up ${topGainer.change_24_hour.toFixed(2)}% in 24 hours.`
        : 'No mover data available.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /markets/summary?coin=BTC&period=1d
 * Voice: "How did Bitcoin do this week?"
 */
router.get('/summary', async (req, res) => {
  const coin = normalizeCoin(req.query.coin);
  const period = String(req.query.period || '1d');
  const cfg = PERIOD_CONFIG[period];
  if (!coin) {
    return res.status(400).json({
      error: 'Required: coin',
      spoken_summary: 'Which coin should I summarize?',
    });
  }
  if (!cfg) {
    return res.status(400).json({
      error: 'period must be one of 1h, 4h, 1d, 1w, 1M',
      spoken_summary: 'I can summarize 1 hour, 4 hours, 1 day, 1 week, or 1 month.',
    });
  }

  try {
    const { detMap, tickMap } = await loadMarketContext();
    const resolved = resolvePair(coin, detMap, 'INR');
    if (!resolved) {
      return res.status(404).json({
        error: `No market pair for ${coin}`,
        spoken_summary: `I couldn't find candle data for ${coin}.`,
      });
    }

    const { data, status } = await publicGet('/market_data/candles', {
      pair: resolved.pair,
      interval: cfg.interval,
      limit: cfg.bars,
    });
    if (status >= 400) return res.status(status).json({ error: data });

    const candles = Array.isArray(data) ? data.slice().reverse() : [];
    if (!candles.length) {
      return res.status(404).json({
        error: 'No candles',
        spoken_summary: `No candle data for ${coin} ${cfg.label}.`,
      });
    }

    const open = parseFloat(candles[0].open);
    const close = parseFloat(candles[candles.length - 1].close);
    const high = Math.max(...candles.map((c) => parseFloat(c.high)));
    const low = Math.min(...candles.map((c) => parseFloat(c.low)));
    const volume = candles.reduce((s, c) => s + (parseFloat(c.volume) || 0), 0);
    const changePct = open ? ((close - open) / open) * 100 : 0;
    const direction = changePct >= 0 ? 'up' : 'down';
    const px = priceInInr(coin, tickMap);

    res.json({
      coin,
      period,
      market: resolved.market,
      pair: resolved.pair,
      open,
      high,
      low,
      close,
      volume,
      change_percent: changePct,
      current_price_inr: px.price_inr,
      candles_used: candles.length,
      spoken_summary:
        `${coin} ${cfg.label}: ${direction} ${Math.abs(changePct).toFixed(2)}%, ` +
        `from ${open.toLocaleString('en-IN', { maximumFractionDigits: 4 })} to ` +
        `${close.toLocaleString('en-IN', { maximumFractionDigits: 4 })}. ` +
        `High ${high.toLocaleString('en-IN', { maximumFractionDigits: 4 })}, ` +
        `low ${low.toLocaleString('en-IN', { maximumFractionDigits: 4 })}.`,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * GET /markets/spread?coin=BTC
 * Voice: "Is the market liquid right now?"
 */
router.get('/spread', async (req, res) => {
  const coin = normalizeCoin(req.query.coin);
  if (!coin) {
    return res.status(400).json({
      error: 'Required: coin',
      spoken_summary: 'Which coin’s spread should I check?',
    });
  }

  try {
    const { detMap, tickMap } = await loadMarketContext();
    const resolved = resolvePair(coin, detMap, 'INR');
    if (!resolved) {
      return res.status(404).json({
        error: `No market for ${coin}`,
        spoken_summary: `I couldn't find an order book for ${coin}.`,
      });
    }

    const depth = Number(req.query.depth) || 20;
    const { data, status } = await publicGet('/market_data/orderbook', {
      pair: resolved.pair,
      depth,
    }, true);
    if (status >= 400) return res.status(status).json({ error: data });

    const toLevels = (side) => {
      const raw = data?.[side] || [];
      if (Array.isArray(raw)) {
        return raw.map((row) => {
          if (Array.isArray(row)) return { price: parseFloat(row[0]), qty: parseFloat(row[1]) };
          return {
            price: parseFloat(row.price ?? row[0]),
            qty: parseFloat(row.quantity ?? row.qty ?? row[1]),
          };
        }).filter((l) => Number.isFinite(l.price) && Number.isFinite(l.qty));
      }
      if (raw && typeof raw === 'object') {
        return Object.entries(raw)
          .map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) }))
          .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.qty));
      }
      return [];
    };

    let bids = toLevels('bids').sort((a, b) => b.price - a.price);
    let asks = toLevels('asks').sort((a, b) => a.price - b.price);

    const ticker = tickMap[resolved.market];
    if ((!bids.length || !asks.length) && ticker) {
      const bid = parseFloat(ticker.bid);
      const ask = parseFloat(ticker.ask);
      if (Number.isFinite(bid) && Number.isFinite(ask)) {
        bids = [{ price: bid, qty: 0 }];
        asks = [{ price: ask, qty: 0 }];
      }
    }

    if (!bids.length || !asks.length) {
      return res.status(404).json({
        error: 'Empty order book',
        spoken_summary: `I couldn't read the order book for ${coin} right now.`,
      });
    }

    const bestBid = bids[0].price;
    const bestAsk = asks[0].price;
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadBps = mid ? (spread / mid) * 10000 : 0;
    const bidDepth = bids.slice(0, 10).reduce((s, l) => s + l.qty * l.price, 0);
    const askDepth = asks.slice(0, 10).reduce((s, l) => s + l.qty * l.price, 0);

    let liquidity = 'moderate';
    if (spreadBps < 5) liquidity = 'tight / liquid';
    else if (spreadBps < 20) liquidity = 'okay';
    else if (spreadBps < 50) liquidity = 'wide';
    else liquidity = 'illiquid';

    res.json({
      coin,
      market: resolved.market,
      pair: resolved.pair,
      best_bid: bestBid,
      best_ask: bestAsk,
      mid,
      spread,
      spread_bps: spreadBps,
      bid_depth_top10_quote: bidDepth,
      ask_depth_top10_quote: askDepth,
      liquidity,
      spoken_summary:
        `${coin} spread is ${spread.toLocaleString('en-IN', { maximumFractionDigits: 4 })} ` +
        `(${spreadBps.toFixed(1)} bps) — ${liquidity}. ` +
        `Bid ₹${bestBid.toLocaleString('en-IN', { maximumFractionDigits: 4 })}, ` +
        `ask ₹${bestAsk.toLocaleString('en-IN', { maximumFractionDigits: 4 })}.`,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /markets/tickers — all market tickers
router.get('/tickers', async (req, res) => {
  try {
    const { data, status } = await publicGet('/exchange/ticker');
    if (status >= 400) return res.status(status).json({ error: data });

    const market = (req.query.market || '').toUpperCase();
    if (market) {
      const hit = Array.isArray(data)
        ? data.find((t) => t.market === market)
        : null;
      if (!hit) return res.status(404).json({ error: `Market ${market} not found` });
      return res.json({ market, ticker: hit });
    }

    res.json({ count: data.length, tickers: data.slice(0, Number(req.query.limit) || 50) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /markets/list — market symbols
router.get('/list', async (req, res) => {
  try {
    const { data, status } = await publicGet('/exchange/v1/markets');
    if (status >= 400) return res.status(status).json({ error: data });
    res.json({ count: data.length, markets: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /markets/details — precision, min qty, etc.
router.get('/details', async (req, res) => {
  try {
    const { data, status } = await publicGet('/exchange/v1/markets_details');
    if (status >= 400) return res.status(status).json({ error: data });

    const market = (req.query.market || '').toUpperCase();
    if (market) {
      const hit = Array.isArray(data)
        ? data.find((m) => m.coindcx_name === market || m.symbol === market)
        : null;
      if (!hit) return res.status(404).json({ error: `Market ${market} not found` });
      return res.json({ market, details: hit });
    }

    res.json({ count: data.length, details: data.slice(0, Number(req.query.limit) || 20) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /markets/orderbook?pair=B-BTC_USDT&depth=20
router.get('/orderbook', async (req, res) => {
  const pair = req.query.pair;
  if (!pair) return res.status(400).json({ error: 'Required query: pair (e.g. B-BTC_USDT)' });
  try {
    const { data, status } = await publicGet('/market_data/orderbook', {
      pair,
      depth: req.query.depth || 20,
    }, true);
    if (status >= 400) return res.status(status).json({ error: data });
    res.json({ pair, orderbook: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /markets/candles — interval mode or from/to mode
router.get('/candles', async (req, res) => {
  const { pair, from, to, resolution = '1h', interval, limit } = req.query;
  if (!pair) {
    return res.status(400).json({
      error: 'Required: pair. Optional: interval (1m,15m,1h,1d) + limit, or from/to/resolution',
    });
  }
  try {
    if (interval) {
      const { data, status } = await publicGet('/market_data/candles', {
        pair,
        interval,
        limit: limit || 100,
        startTime: from,
        endTime: to,
      });
      if (status >= 400) return res.status(status).json({ error: data });
      return res.json({ pair, interval, candles: data });
    }
    if (!from || !to) {
      return res.status(400).json({
        error: 'Provide interval=1m|15m|1h|1d, or from + to (+ resolution)',
      });
    }
    const { data, status } = await publicGet('/market_data/candles', {
      pair, from, to, resolution,
    }, true);
    if (status >= 400) return res.status(status).json({ error: data });
    res.json({ pair, resolution, candles: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /markets/trades?pair=B-BTC_USDT
router.get('/trades', async (req, res) => {
  const pair = req.query.pair;
  if (!pair) return res.status(400).json({ error: 'Required query: pair' });
  try {
    const { data, status } = await publicGet('/market_data/trade_history', {
      pair,
      limit: req.query.limit || 50,
    }, true);
    if (status >= 400) return res.status(status).json({ error: data });
    res.json({ pair, trades: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
