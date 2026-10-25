// routes/auth.js : inscription, connexion, rotation des jetons, profil
const express = require('express');
const crypto = require('crypto');
const argon2 = require('argon2');
const db = require('../db');
const { authenticate, authLimiter, signAccessToken } = require('../middleware/auth');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const cookieBase = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
};

// Hash factice : même temps de réponse quand l'e-mail n'existe pas (anti-énumération)
let dummyHash;
const getDummy = async () => dummyHash || (dummyHash = await argon2.hash('dummy-password', { type: argon2.argon2id }));

async function startSession(req, res, user) {
  const raw = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + interval '30 days', $3, $4)`,
    [user.id, sha256(raw), (req.get('user-agent') || '').slice(0, 255), req.ip]);
  res.cookie('access_token', signAccessToken(user), { ...cookieBase, maxAge: 15 * 60 * 1000 });
  res.cookie('refresh_token', raw, { ...cookieBase, path: '/auth', maxAge: 30 * 24 * 3600 * 1000 });
}

function clearSession(res) {
  res.clearCookie('access_token', cookieBase);
  res.clearCookie('refresh_token', { ...cookieBase, path: '/auth' });
}

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').trim();
    const password = String(b.password || '');
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(422).json({ error: 'invalid_email' });
    if (name.length < 1 || name.length > 60) return res.status(422).json({ error: 'invalid_name' });
    if (password.length < 8 || password.length > 200) return res.status(422).json({ error: 'invalid_password' });

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    let user;
    try {
      const { rows } = await db.query(
        `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
         RETURNING id, role, display_name`, [email, hash, name]);
      user = rows[0];
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'email_taken' });
      throw e;
    }
    await startSession(req, res, user);
    res.status(201).json({ user: { id: user.id, name: user.display_name } });
  } catch (e) { next(e); }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const { rows } = await db.query(
      `SELECT id, role, display_name, password_hash FROM users
        WHERE email = $1 AND deleted_at IS NULL`, [email]);
    const user = rows[0];
    const ok = await argon2.verify(user ? user.password_hash : await getDummy(), password);
    if (!user || !ok) return res.status(401).json({ error: 'invalid_credentials' });

    await startSession(req, res, user);
    await db.query(`INSERT INTO audit_log (user_id, action, ip) VALUES ($1, 'login', $2)`, [user.id, req.ip]);
    res.json({ user: { id: user.id, name: user.display_name } });
  } catch (e) { next(e); }
});

// Rotation : chaque jeton de rafraîchissement ne sert qu'une fois
router.post('/refresh', async (req, res, next) => {
  try {
    const raw = req.cookies && req.cookies.refresh_token;
    if (!raw) return res.status(401).json({ error: 'not_authenticated' });

    const { rows } = await db.query(
      `SELECT rt.id, rt.user_id, rt.revoked_at, rt.expires_at, u.role
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id AND u.deleted_at IS NULL
        WHERE rt.token_hash = $1`, [sha256(raw)]);
    const t = rows[0];
    if (!t) { clearSession(res); return res.status(401).json({ error: 'invalid_token' }); }

    if (t.revoked_at) {
      // Jeton déjà utilisé : possible vol. On coupe toutes les sessions de cet utilisateur.
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.user_id]);
      clearSession(res);
      return res.status(401).json({ error: 'invalid_token' });
    }
    if (new Date(t.expires_at) <= new Date()) { clearSession(res); return res.status(401).json({ error: 'expired' }); }

    const used = await db.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`, [t.id]);
    if (!used.rows.length) { clearSession(res); return res.status(401).json({ error: 'invalid_token' }); }

    await startSession(req, res, { id: t.user_id, role: t.role });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
  try {
    const raw = req.cookies && req.cookies.refresh_token;
    if (raw) await db.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(raw)]);
    clearSession(res);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Profil + état d'avancement du parcours premium (pour le front)
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.display_name, u.role,
              (SELECT max(ends_at) FROM premium_access pa
                WHERE pa.user_id = u.id AND pa.status = 'active' AND pa.ends_at > now()) AS premium_until,
              EXISTS (SELECT 1 FROM promo_redemptions r
                WHERE r.user_id = u.id AND r.consumed_at IS NULL) AS promo_validated
         FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL`, [req.user.id]);
    if (!rows[0]) return res.status(401).json({ error: 'not_authenticated' });
    const u = rows[0];
    res.set('Cache-Control', 'private, no-store');
    res.json({
      id: u.id, email: u.email, name: u.display_name,
      premium: !!u.premium_until, premium_until: u.premium_until,
      promo_validated: u.promo_validated,
    });
  } catch (e) { next(e); }
});

module.exports = router;