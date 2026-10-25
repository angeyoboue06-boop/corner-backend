// routes/payments.js : paiement par CinetPay (Wave, Orange Money, MTN, Moov)
// Documentation officielle : https://docs.cinetpay.com (API Checkout v2)
//
// Principe de sécurité : le navigateur et la notification ne décident JAMAIS du succès d'un paiement.
// Seule la réponse de l'API « Vérification de transaction » de CinetPay (appelée depuis le serveur,
// avec la clé secrète) compte, et elle est recoupée avec NOTRE base : montant, devise, utilisateur.
//
// Variables : CINETPAY_API_KEY, CINETPAY_SITE_ID, CINETPAY_SECRET_KEY, CINETPAY_MODE (live | test),
//             APP_URL, API_URL
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { authenticate } = require('../middleware/auth');

const API = 'https://api-checkout.cinetpay.com/v2/payment';
const CURRENCY = 'XOF';

// Les formules vivent UNIQUEMENT ici, côté serveur : le client envoie le nom de la formule,
// jamais un montant ni une durée. (Le montant doit être un multiple de 5 pour CinetPay.)
const PLANS = {
  mensuel:     { price: 8000,  days: 30,  label: '1 mois' },
  trimestriel: { price: 10000, days: 90,  label: '3 mois' },
  annuel:      { price: 80000, days: 365, label: '1 an' },
};
// CinetPay n'a pas de bac à sable pour cette API : pour essayer pour de vrai à petit prix,
// la formule « essai » (100 FCFA, 1 jour) n'existe QUE si CINETPAY_MODE=test.
const plans = () => (process.env.CINETPAY_MODE === 'test'
  ? { ...PLANS, essai: { price: 100, days: 1, label: 'essai' } } : PLANS);
const hasPlan = (k) => Object.prototype.hasOwnProperty.call(plans(), k);

const cinetpay = async (path, body) => {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: process.env.CINETPAY_API_KEY, site_id: process.env.CINETPAY_SITE_ID, ...body }),
    signal: AbortSignal.timeout(15000),
  });
  return r.json();
};

const audit = (client, userId, action, detail) => client.query(
  `INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3)`,
  [userId, action, JSON.stringify(detail)]);

// --- Signature HMAC des notifications (en-tête x-token) ---------------------
// Ordre des champs imposé par la documentation CinetPay. Retourne null si la clé secrète
// n'est pas configurée (contrôle désactivé), sinon true/false.
const HMAC_FIELDS = ['cpm_site_id', 'cpm_trans_id', 'cpm_trans_date', 'cpm_amount', 'cpm_currency', 'signature',
  'payment_method', 'cel_phone_num', 'cpm_phone_prefixe', 'cpm_language', 'cpm_version',
  'cpm_payment_config', 'cpm_page_action', 'cpm_custom', 'cpm_designation', 'cpm_error_message'];
function hmacOk(body, token) {
  const secret = process.env.CINETPAY_SECRET_KEY;
  if (!secret) return null;
  if (typeof token !== 'string' || !token) return false;
  const data = HMAC_FIELDS.map((f) => String(body[f] == null ? '' : body[f])).join('');
  const mine = Buffer.from(crypto.createHmac('sha256', secret).update(data).digest('hex'));
  const theirs = Buffer.from(token.toLowerCase());
  return mine.length === theirs.length && crypto.timingSafeEqual(mine, theirs);
}

// ---------------------------------------------------------------------------
// settle(txId) : UNIQUE endroit où un paiement peut ouvrir l'accès premium.
// Appelé par la notification, par la vérification demandée au retour, et par le rattrapage.
// Retourne { state } : succeeded | pending | failed | mismatch | review | unknown | error
// ---------------------------------------------------------------------------
async function settle(txId, onlyUserId) {
  const pre = await db.query(
    `SELECT user_id, status FROM payments WHERE provider_session_id = $1 AND provider = 'cinetpay'`, [txId]);
  if (!pre.rows[0] || (onlyUserId && pre.rows[0].user_id !== onlyUserId)) return { state: 'unknown' };
  if (pre.rows[0].status === 'succeeded') return { state: 'succeeded' }; // déjà traité : aucun appel réseau

  let check;
  try { check = await cinetpay('/check', { transaction_id: txId }); }
  catch (e) { console.error('cinetpay_check_error', txId, e.message); return { state: 'error' }; }
  const d = (check && check.data) || {};
  const code = String(check && check.code);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const pay = await client.query(
      `SELECT id, user_id, amount_cents, currency, status, plan
         FROM payments WHERE provider_session_id = $1 AND provider = 'cinetpay' FOR UPDATE`, [txId]);
    const p = pay.rows[0];
    if (!p) { await client.query('ROLLBACK'); return { state: 'unknown' }; }
    if (p.status === 'succeeded') { await client.query('COMMIT'); return { state: 'succeeded' }; } // idempotent

    let state = 'pending';
    if (code === '00' && d.status === 'ACCEPTED') {
      // Ce qui a été encaissé doit être EXACTEMENT ce que NOUS avons enregistré pour CET utilisateur.
      const md = d.metadata == null ? '' : String(d.metadata).trim();
      if (Number(d.amount) !== p.amount_cents || d.currency !== p.currency || (md && md !== p.user_id)) {
        await client.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [p.id]);
        await audit(client, p.user_id, 'payment.amount_mismatch', { tx: txId, paid: d.amount, cur: d.currency });
        state = 'mismatch';
      } else if (!hasPlan(p.plan)) { // formule inconnue : on n'invente aucune durée, un humain tranche
        await audit(client, p.user_id, 'payment.unknown_plan', { payment: p.id, plan: p.plan });
        state = 'review';
      } else {
        await client.query(`UPDATE payments SET status = 'succeeded', verified_at = now() WHERE id = $1`, [p.id]);
        // Un renouvellement s'ajoute À LA SUITE de l'accès en cours (rien n'est perdu).
        await client.query(
          `INSERT INTO premium_access (user_id, payment_id, source, starts_at, ends_at)
           VALUES ($1, $2, 'payment', now(),
             GREATEST(now(), COALESCE((SELECT max(ends_at) FROM premium_access
                                        WHERE user_id = $1 AND status = 'active'), now()))
             + make_interval(days => $3))`,
          [p.user_id, p.id, plans()[p.plan].days]);
        await audit(client, p.user_id, 'payment.verified', { payment: p.id, method: d.payment_method });
        state = 'succeeded';
      }
    } else if (d.status === 'REFUSED' || code === '600' || code === '627') { // refusé, annulé, échoué
      await client.query(`UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'pending'`, [p.id]);
      state = 'failed';
    }
    // 623 / 662 / 663 / WAITING_FOR_CUSTOMER, ou tout statut inconnu : AUCUN changement, AUCUN accès.
    await client.query('COMMIT');
    return { state };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('settle_error', txId, e.message);
    return { state: 'error' };
  } finally { client.release(); }
}

// ---------------------------------------------------------------------------
// Routes utilisateur : /payments/checkout, /payments/verify, /payments/return
// ---------------------------------------------------------------------------
const checkout = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} '-]/gu, '').trim().slice(0, 30) || 'Client';

// Formules et prix tels que le serveur les applique : le site les affiche, il ne les décide pas.
checkout.get('/plans', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ plans: Object.entries(plans()).map(([k, v]) => ({ k, n: v.label, p: v.price, days: v.days })) });
});

checkout.post('/checkout', authenticate, limiter, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const planKey = String((req.body || {}).plan || '');
    if (!hasPlan(planKey)) return res.status(422).json({ error: 'invalid_plan' });
    const plan = plans()[planKey];

    // Déjà abonné : on n'accepte un renouvellement que dans les 7 derniers jours.
    const active = await db.query(
      `SELECT 1 FROM premium_access WHERE user_id = $1 AND status = 'active'
          AND ends_at > now() + interval '7 days' LIMIT 1`, [userId]);
    if (active.rows.length) return res.status(409).json({ error: 'already_premium' });

    // Anti double-clic : un seul paiement en cours à la fois.
    const recent = await db.query(
      `SELECT 1 FROM payments WHERE user_id = $1 AND provider = 'cinetpay' AND status = 'pending'
          AND created_at > now() - interval '2 minutes' LIMIT 1`, [userId]);
    if (recent.rows.length) return res.status(429).json({ error: 'payment_in_progress' });

    const u = await db.query(`SELECT email, display_name FROM users WHERE id = $1`, [userId]);
    const name = cleanName(u.rows[0].display_name);
    const txId = 'CRN' + Date.now() + crypto.randomBytes(4).toString('hex'); // unique et imprévisible

    // Enregistré AVANT l'appel : montant, utilisateur et formule viennent de NOTRE serveur.
    await db.query(
      `INSERT INTO payments (user_id, provider, provider_session_id, amount_cents, currency, plan)
       VALUES ($1, 'cinetpay', $2, $3, $4, $5)`,
      [userId, txId, plan.price, CURRENCY, planKey]);

    let out;
    try {
      out = await cinetpay('', {
        transaction_id: txId,
        amount: plan.price,
        currency: CURRENCY,
        description: `Corner Premium ${plan.label}`, // pas de caractères spéciaux (# / $ _ &)
        customer_id: userId,
        customer_name: name,
        customer_surname: name,
        customer_email: u.rows[0].email,
        channels: 'MOBILE_MONEY', // Wave, Orange Money, MTN, Moov (la carte exige des champs en plus)
        lang: 'fr',
        metadata: userId, // renvoyé par CinetPay : recoupé à la confirmation
        notify_url: `${process.env.API_URL}/webhooks/cinetpay`,
        return_url: `${process.env.API_URL}/payments/return`,
      });
    } catch (e) { out = null; console.error('cinetpay_init_error', e.message); }

    const url = out && out.data && out.data.payment_url;
    // On ne redirige que vers le guichet officiel (jamais vers une adresse imposée par une réponse altérée).
    if (!out || String(out.code) !== '201' || !/^https:\/\/([a-z0-9-]+\.)*cinetpay\.com\//i.test(String(url))) {
      await db.query(`UPDATE payments SET status = 'failed' WHERE provider_session_id = $1`, [txId]);
      console.error('cinetpay_init_failed', out && out.code, out && out.message);
      return res.status(502).json({ error: 'payment_provider_error' });
    }
    res.json({ url });
  } catch (e) { next(e); }
});

// Appelé par le site au retour du guichet : interroge CinetPay pour NOTRE dernière transaction.
// Ne fait confiance à rien venant du navigateur (aucun identifiant n'est lu dans la requête).
checkout.post('/verify', authenticate, limiter, async (req, res, next) => {
  try {
    const last = await db.query(
      `SELECT provider_session_id FROM payments WHERE user_id = $1 AND provider = 'cinetpay'
        ORDER BY created_at DESC LIMIT 1`, [req.user.id]);
    if (!last.rows[0]) return res.json({ status: 'none' });
    const { state } = await settle(last.rows[0].provider_session_id, req.user.id);
    res.set('Cache-Control', 'no-store');
    res.json({ status: state === 'succeeded' ? 'succeeded' : (state === 'failed' || state === 'mismatch') ? 'failed' : 'pending' });
  } catch (e) { next(e); }
});

// Page de retour du guichet : redirection SEULEMENT. Aucune écriture, aucune activation.
checkout.all('/return', (req, res) => {
  res.redirect(303, `${String(process.env.APP_URL || '').replace(/\/$/, '')}/?paiement=retour#espace`);
});

// ---------------------------------------------------------------------------
// POST /webhooks/cinetpay : notification (CinetPay la rappelle jusqu'à obtenir 200)
// ---------------------------------------------------------------------------
const webhook = express.Router();

// CinetPay « ping » l'adresse en GET pour s'assurer qu'elle répond 200 : obligatoire.
webhook.get('/cinetpay', (req, res) => res.status(200).send('ok'));

webhook.post('/cinetpay',
  express.urlencoded({ extended: false, limit: '10kb' }),
  express.json({ limit: '10kb' }),
  async (req, res) => {
    const body = req.body || {};
    const txId = String(body.cpm_trans_id || '').trim();
    if (!/^CRN[0-9a-f]{1,60}$/i.test(txId)) return res.status(400).send('invalid');
    if (body.cpm_site_id != null && String(body.cpm_site_id) !== String(process.env.CINETPAY_SITE_ID)) {
      return res.status(400).send('invalid');
    }
    if (hmacOk(body, req.get('x-token')) === false) { // signature présente mais fausse : rejet sans effet
      console.error('cinetpay_bad_hmac', txId);
      return res.status(401).send('invalid');
    }
    let state;
    try { ({ state } = await settle(txId)); }
    catch (e) { console.error('webhook_error', txId, e.message); return res.status(500).send('retry'); }
    if (state === 'unknown') return res.status(404).send('unknown');
    if (state === 'error') return res.status(500).send('retry'); // CinetPay renverra la notification
    res.send('ok');
  });

// ---------------------------------------------------------------------------
// Rattrapage : si une notification se perd (serveur endormi, panne), on interroge CinetPay.
// Les paiements en attente depuis plus de 24 h sont clos comme échoués (sans accès).
// ---------------------------------------------------------------------------
async function reconcile(limit = 20) {
  const { rows } = await db.query(
    `SELECT provider_session_id FROM payments WHERE provider = 'cinetpay' AND status = 'pending'
        AND created_at < now() - interval '10 minutes' ORDER BY created_at LIMIT $1`, [limit]);
  for (const r of rows) {
    const { state } = await settle(r.provider_session_id);
    if (state === 'pending') {
      await db.query(
        `UPDATE payments SET status = 'failed' WHERE provider_session_id = $1 AND status = 'pending'
            AND created_at < now() - interval '24 hours'`, [r.provider_session_id]);
    }
  }
  return rows.length;
}
function startReconcile() {
  setTimeout(() => reconcile().catch((e) => console.error('reconcile_error', e.message)), 30 * 1000).unref();
  setInterval(() => reconcile().catch((e) => console.error('reconcile_error', e.message)), 5 * 60 * 1000).unref();
}

if (process.env.NODE_ENV === 'production' && !process.env.CINETPAY_SECRET_KEY) {
  console.warn('CINETPAY_SECRET_KEY absente : la signature x-token des notifications n\'est pas contrôlée (la vérification auprès de CinetPay reste active).');
}
if (process.env.CINETPAY_MODE === 'test') console.warn('CINETPAY_MODE=test : la formule « essai » (100 FCFA) est ouverte. Repasser en live avant le lancement.');

module.exports = { checkout, webhook, settle, reconcile, startReconcile, hmacOk };