// routes/predictions.js
const express = require('express');
const db = require('../db');
const { authenticate, requirePremium } = require('../middleware/auth');

const COLS = `p.id, e.league, e.home_team, e.away_team, e.kickoff_at,
              p.selection, p.odds, p.confidence, p.analysis`;
const TODAY = `p.state = 'published'
               AND (p.publish_at IS NULL OR p.publish_at <= now())
               AND e.kickoff_at::date = current_date`;

const predictions = express.Router();

// Public : ne sélectionne JAMAIS de contenu premium
predictions.get('/today', async (req, res, next) => {
  try {
    const free = await db.query(
      `SELECT ${COLS} FROM predictions p JOIN events e ON e.id = p.event_id
        WHERE ${TODAY} AND p.tier = 'free' ORDER BY e.kickoff_at`);
    const locked = await db.query(
      `SELECT count(*)::int AS n FROM predictions p JOIN events e ON e.id = p.event_id
        WHERE ${TODAY} AND p.tier = 'premium'`);
    res.json({ free: free.rows, premium_locked: locked.rows[0].n });
  } catch (e) { next(e); }
});

// Premium : authentification PUIS vérification de l'abonnement en base
predictions.get('/premium', authenticate, requirePremium, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${COLS} FROM predictions p JOIN events e ON e.id = p.event_id
        WHERE ${TODAY} AND p.tier = 'premium' ORDER BY e.kickoff_at`);
    res.json({ predictions: rows });
  } catch (e) { next(e); }
});

// Résultats publics (vue sans analyse), paginés
const results = express.Router();
results.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { rows } = await db.query(
      `SELECT * FROM public_results ORDER BY day DESC, id LIMIT $1 OFFSET $2`, [limit, offset]);
    res.json({ results: rows, limit, offset });
  } catch (e) { next(e); }
});

module.exports = { predictions, results };