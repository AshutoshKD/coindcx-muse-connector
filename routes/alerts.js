const router = require('express').Router();
const {
  createAlert,
  listAlerts,
  deleteAlert,
  checkAlerts,
  normalizeCoin,
} = require('../utils/marketHelpers');

// POST /alerts  { coin, target_price_inr, direction?: "above"|"below", label? }
router.post('/', (req, res) => {
  const { coin, target_price_inr, direction, label } = req.body;
  if (!coin || target_price_inr == null) {
    return res.status(400).json({
      error: 'Required: coin, target_price_inr. Optional: direction (above|below), label',
    });
  }
  if (!Number.isFinite(Number(target_price_inr)) || Number(target_price_inr) <= 0) {
    return res.status(400).json({ error: 'target_price_inr must be a positive number' });
  }

  const alert = createAlert({ coin, target_price_inr, direction, label });
  res.status(201).json({
    alert,
    spoken_summary: `Okay — I'll watch for ${normalizeCoin(coin)} ${alert.direction} ₹${alert.target_price_inr}.`,
  });
});

// GET /alerts
router.get('/', (req, res) => {
  const alerts = listAlerts();
  res.json({
    count: alerts.length,
    alerts,
    spoken_summary: alerts.length
      ? `You have ${alerts.length} price alert${alerts.length === 1 ? '' : 's'} set.`
      : 'You have no price alerts.',
  });
});

// GET /alerts/check — evaluate against live prices
router.get('/check', async (req, res) => {
  try {
    const results = await checkAlerts();
    const triggered = results.filter((r) => r.status === 'triggered');
    res.json({
      checked: results.length,
      triggered_count: triggered.length,
      alerts: results,
      spoken_summary: triggered.length
        ? triggered.map((t) => t.spoken).join(' ')
        : results.length
          ? 'No alerts triggered right now.'
          : 'No alerts to check.',
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /alerts/:id
router.delete('/:id', (req, res) => {
  const ok = deleteAlert(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Alert not found' });
  res.json({ success: true, spoken_summary: 'Alert removed.' });
});

module.exports = router;
