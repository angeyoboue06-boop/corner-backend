// middleware/auth.js
// Dépendances : express, jsonwebtoken, cookie-parser, express-rate-limit, pg
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db'); // export d'un Pool pg

const JWT_SECRET = process.env.JWT_SECRET; // 32 octets aléatoires minimum
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET manquant ou trop court');

function signAccessToken(user) {
  return jwt.sign({ role: user.role }, JWT_SECRET, { subject: user.id, expiresIn: '15m', algorithm: 'HS256' });
}

// 1. Authentification : lit le jeton d'accès (cookie HttpOnly) ------------
function authenticate(req, res, next) {
  const token = req.cookies && req.cookies.access_token;
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    const p = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: p.sub, role: p.role };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}

// 2. Accès premium : vérifié en base à CHAQUE requête ---------------------
// Le JWT ne dit rien du premium : un abonnement révoqué ou expiré
// cesse de fonctionner immédiatement, sans attendre l'expiration du jeton.
async function requirePremium(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT 1
         FROM premium_access pa
         JOIN users u ON u.id = pa.user_id AND u.deleted_at IS NULL
        WHERE pa.user_id = $1
          AND pa.status = 'active'
          AND pa.starts_at <= now() AND pa.ends_at > now()
        LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) {
      return res.status(403).json({ error: 'premium_required' });
    }
    res.set('Cache-Control', 'private, no-store'); // jamais en cache partagé / CDN
    next();
  } catch (e) {
    next(e); // le gestionnaire d'erreurs global répond 500 sans détail
  }
}

// Le rôle admin est relu en base à chaque requête (comme le premium)
async function requireAdmin(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM users WHERE id = $1 AND role = 'admin' AND deleted_at IS NULL`, [req.user.id]);
    if (!rows.length) return res.status(403).json({ error: 'forbidden' });
    res.set('Cache-Control', 'private, no-store');
    next();
  } catch (e) { next(e); }
}

// 3. Limitation de débit --------------------------------------------------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const promoLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });

module.exports = { signAccessToken, authenticate, requirePremium, requireAdmin, authLimiter, promoLimiter };