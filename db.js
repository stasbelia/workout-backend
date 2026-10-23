require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionTimeoutMillis: 5_000,
  query_timeout: 20_000,
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

module.exports = pool;
