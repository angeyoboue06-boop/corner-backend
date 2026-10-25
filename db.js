// db.js : pool de connexions PostgreSQL (Neon ou local)
const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL manquant');

const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

module.exports = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: true }, // Neon exige TLS
  max: 10,
  idleTimeoutMillis: 30000,
});