// app.js : point d'entrée
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { checkout, webhook, startReconcile } = require('./routes/payments');
const authRoutes = require('./routes/auth');
const promoRoutes = require('./routes/promo');
const adminRoutes = require('./routes/admin');
const predictionRoutes = require('./routes/predictions');

const app = express();
app.set('trust proxy', 1); // derrière le proxy de Render : IP réelle pour la limitation de débit
app.use(helmet());
app.use(cors({ origin: process.env.APP_URL, credentials: true }));

// La notification CinetPay (formulaire) est lue par sa propre route : à monter AVANT express.json()
app.use('/webhooks', webhook);

app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/auth', authRoutes);
app.use('/promo', promoRoutes);
app.use('/payments', checkout);
app.use('/predictions', predictionRoutes.predictions);
app.use('/admin', adminRoutes);
app.use('/results', predictionRoutes.results);
app.use(express.static(require('path').join(__dirname, 'public'))); // le site (HTML/CSS/JS)

// Erreurs : jamais de détail technique côté client
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`Corner API sur le port ${port}`); startReconcile(); });