const { readFile } = require('node:fs/promises');
const path = require('node:path');
const pool = require('../db');

async function main() {
  try {
    await pool.query(await readFile(path.join(__dirname, '../migrations/004-workout-exercises.sql'), 'utf8'));
    console.log('Таблицю вправ підготовлено.');
  } catch {
    console.error('Не вдалося підготувати таблицю вправ. Перевірте підключення та права PostgreSQL.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
void main();
