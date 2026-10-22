const { readFile } = require('node:fs/promises');
const path = require('node:path');
const pool = require('../db');

async function main() {
  try {
    const sql = await readFile(path.join(__dirname, '../migrations/002-avatar.sql'), 'utf8');
    await pool.query(sql);
    console.log('Міграція аватара застосована. Дані користувачів збережено.');
  } catch {
    console.error('Міграція не завершена. Перевірте підключення до PostgreSQL і права на зміну таблиць.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
void main();
