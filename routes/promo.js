// routes/promo.js : code promo + identifiant de compte bookmaker
// Le code seul ne donne PAS l'accès : la personne indique son compte chez le bookmaker,
// et un administrateur vérifie dans l'espace affilié que ce compte vient bien du code.
const express = require('express');
const db = require('../db');
const { authenticate, promoLimiter } = require('../middleware/auth');

const router = express.Router();
const ACCOUNT_RE = /^[A-Za-z0-9._@-]{3,40}$/;

router.post('/redeem', authenticate, promoLimiter, async (req, res, next) => {
  const b = req.body || {};
  const code = String(b.code || '').trim();
  const bookmaker = String(b.bookmaker || '').trim();
  const accountId = String(b.account_id || '').trim();

  if (!code || code.length > 40) return res.status(422).json({ error: 'invalid_code' });
  if (bookmaker.length < 2 || bookmaker.length > 40) return res.status(422).json({ error: 'invalid_bookmaker' });
  if (!ACCOUNT_RE.test(accountId)) return res.status(422).json({ error: 'invalid_account_id' });
  const accountKey = accountId.toLowerCase();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Quota atomique : ne peut pas être dépassé même avec des requêtes simultanées
    const { rows } = await client.query(
      `UPDATE promo_codes SET redeemed_count = redeemed_count + 1
        WHERE code = $1 AND active
          AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
          AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
        RETURNING id`, [code]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'invalid_code' }); // même message pour tout échec
    }

    const red = await client.query(
      `INSERT INTO promo_redemptions (promo_code_id, user_id) VALUES ($1, $2) RETURNING id`,
      [rows[0].id, req.user.id]);

    // L'index unique refuse un compte bookmaker déjà utilisé par quelqu'un d'autre
    await client.query(
      `INSERT INTO bookmaker_claims (user_id, redemption_id, bookmaker, account_id, account_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.user.id, red.rows[0].id, bookmaker, accountId, accountKey]);

    await client.query(
      `INSERT INTO audit_log (user_id, action, ip) VALUES ($1, 'promo.claim', $2)`, [req.user.id, req.ip]);
    await client.query('COMMIT');
    res.status(202).json({ status: 'pending' }); // en attente de vérification
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      // Soit la personne a déjà utilisé ce code, soit ce compte bookmaker est déjà pris
      const dup = /bookmaker_account_once/.test(e.constraint || '');
      return res.status(409).json({ error: dup ? 'account_already_used' : 'already_redeemed' });
    }
    next(e);
  } finally {
    client.release();
  }
});

module.exports = router;