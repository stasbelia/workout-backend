const { readFile } = require('node:fs/promises');
const path = require('node:path');
const pool = require('../db');

async function main() {
  try {
    await pool.query(await readFile(path.join(__dirname, '../migrations/006-profile-workout-templates.sql'), 'utf8'));
    console.log('Профіль і шаблони тренувань підготовлено.');
  } catch {
    console.error('Не вдалося підготувати профіль і шаблони тренувань. Перевірте підключення та права PostgreSQL.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
void main();
