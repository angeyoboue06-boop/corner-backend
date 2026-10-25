// routes/admin.js : gestion des pronostics et des codes promo (réservé aux admins)
const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Za-z0-9_-]{4,40}$/;
const str = (v, max) => { const s = String(v == null ? '' : v).trim(); return s.length >= 1 && s.length <= max ? s : null; };
const audit = (userId, action, detail, ip) => db.query(
  `INSERT INTO audit_log (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)`,
  [userId, action, JSON.stringify(detail), ip]);

// --- Pronostics --------------------------------------------------------------

// Crée le match ET le pronostic en une seule requête (pratique depuis un téléphone)
router.post('/predictions', async (req, res, next) => {
  const b = req.body || {};
  const league = str(b.league, 80), home = str(b.home_team, 80), away = str(b.away_team, 80);
  const selection = str(b.selection, 120), analysis = str(b.analysis, 2000);
  const odds = Number(b.odds), confidence = Number(b.confidence);
  const kickoff = new Date(b.kickoff_at);
  const tier = b.tier === 'premium' ? 'premium' : b.tier === 'free' ? 'free' : null;
  const publish = b.publish === true;

  if (!league || !home || !away || !selection || !analysis || !tier || isNaN(kickoff.getTime()))
    return res.status(422).json({ error: 'invalid_input' });
  if (!(odds >= 1.01 && odds <= 1000)) return res.status(422).json({ error: 'invalid_odds' });
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5)
    return res.status(422).json({ error: 'invalid_confidence' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ev = await client.query(
      `INSERT INTO events (league, home_team, away_team, kickoff_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [league, home, away, kickoff.toISOString()]);
    const pr = await client.query(
      `INSERT INTO predictions
         (event_id, selection, odds, confidence, analysis, tier, state, publish_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [ev.rows[0].id, selection, odds.toFixed(2), confidence, analysis, tier,
       publish ? 'published' : 'draft', publish ? new Date().toISOString() : null, req.user.id]);
    await client.query('COMMIT');
    await audit(req.user.id, 'prediction.create', { id: pr.rows[0].id, tier, publish }, req.ip);
    res.status(201).json({ id: pr.rows[0].id, state: publish ? 'published' : 'draft' });
  } catch (e) {
    await client.query('ROLLBACK'); next(e);
  } finally { client.release(); }
});

// Liste (tous états confondus) pour le tableau de bord admin
router.get('/predictions', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.id, e.league, e.home_team, e.away_team, e.kickoff_at, p.selection, p.odds,
              p.confidence, p.tier, p.state, p.result
         FROM predictions p JOIN events e ON e.id = p.event_id
        ORDER BY e.kickoff_at DESC LIMIT 100`);
    res.json({ predictions: rows });
  } catch (e) { next(e); }
});

router.patch('/predictions/:id/publish', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(422).json({ error: 'invalid_id' });
    const { rows } = await db.query(
      `UPDATE predictions SET state = 'published', publish_at = COALESCE(publish_at, now())
        WHERE id = $1 AND state = 'draft' RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_already_published' });
    await audit(req.user.id, 'prediction.publish', { id: req.params.id }, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch('/predictions/:id/result', async (req, res, next) => {
  try {
    const result = (req.body || {}).result;
    if (!UUID_RE.test(req.params.id)) return res.status(422).json({ error: 'invalid_id' });
    if (!['won', 'lost', 'void'].includes(result)) return res.status(422).json({ error: 'invalid_result' });
    const { rows } = await db.query(
      `UPDATE predictions SET result = $2::prediction_result, settled_at = now()
        WHERE id = $1 AND state = 'published' RETURNING id`, [req.params.id, result]);
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_not_published' });
    await audit(req.user.id, 'prediction.settle', { id: req.params.id, result }, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Codes promo -------------------------------------------------------------

router.post('/promo-codes', async (req, res, next) => {
  try {
    const b = req.body || {};
    const code = String(b.code || '').trim();
    const days = b.access_days == null ? 30 : Number(b.access_days);
    const max = b.max_redemptions == null ? null : Number(b.max_redemptions);
    const until = b.valid_until ? new Date(b.valid_until) : null;

    if (!CODE_RE.test(code)) return res.status(422).json({ error: 'invalid_code_format' });
    if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(422).json({ error: 'invalid_access_days' });
    if (max !== null && (!Number.isInteger(max) || max < 1)) return res.status(422).json({ error: 'invalid_max_redemptions' });
    if (until && isNaN(until.getTime())) return res.status(422).json({ error: 'invalid_valid_until' });

    try {
      await db.query(
        `INSERT INTO promo_codes (code, max_redemptions, access_days, valid_until, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [code, max, days, until ? until.toISOString() : null, req.user.id]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'code_exists' });
      throw e;
    }
    await audit(req.user.id, 'promo.create', { code, max, days }, req.ip);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/promo-codes', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT code, max_redemptions, redeemed_count, access_days, valid_until, active
         FROM promo_codes ORDER BY created_at DESC LIMIT 100`);
    res.json({ codes: rows });
  } catch (e) { next(e); }
});

// Désactiver un code sans le supprimer
router.patch('/promo-codes/:code/deactivate', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE promo_codes SET active = false WHERE code = $1 RETURNING id`, [req.params.code]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    await audit(req.user.id, 'promo.deactivate', { code: req.params.code }, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Vérification des comptes bookmaker --------------------------------------

router.get('/claims', async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const { rows } = await db.query(
      `SELECT c.id, c.bookmaker, c.account_id, c.status, c.created_at, u.email, u.display_name
         FROM bookmaker_claims c JOIN users u ON u.id = c.user_id
        WHERE c.status = $1::bookmaker_status ORDER BY c.created_at LIMIT 100`, [status]);
    res.json({ claims: rows });
  } catch (e) { next(e); }
});

// Valider : vérifié à la main dans l'espace affilié du bookmaker. Ouvre le premium.
router.patch('/claims/:id/approve', async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(422).json({ error: 'invalid_id' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query(
      `UPDATE bookmaker_claims SET status = 'approved', reviewed_by = $2, reviewed_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING user_id, redemption_id`, [req.params.id, req.user.id]);
    if (!c.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found_or_already_reviewed' }); }

    const days = await client.query(
      `UPDATE promo_redemptions r SET consumed_at = now() FROM promo_codes pc
        WHERE r.id = $1 AND pc.id = r.promo_code_id RETURNING pc.access_days`, [c.rows[0].redemption_id]);
    await client.query(
      `INSERT INTO premium_access (user_id, payment_id, source, ends_at)
       VALUES ($1, NULL, 'promo', now() + make_interval(days => $2))`,
      [c.rows[0].user_id, days.rows[0].access_days]);
    await client.query('COMMIT');
    await audit(req.user.id, 'claim.approve', { id: req.params.id }, req.ip);
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

// Refuser : libère l'identifiant (il pourra être redéposé) et le code pour la personne
router.patch('/claims/:id/reject', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(422).json({ error: 'invalid_id' });
    const reason = str((req.body || {}).reason, 200);
    const { rows } = await db.query(
      `UPDATE bookmaker_claims SET status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING id`, [req.params.id, reason, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_already_reviewed' });
    await audit(req.user.id, 'claim.reject', { id: req.params.id }, req.ip);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;