const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'security-tests-only-not-a-production-secret';
const pool = require('../db');
const app = require('../server');
let server;
let base;
let calls = [];
let rows = [];
let dbError;
pool.query = async (sql, values) => {
  calls.push({ sql, values });
  if (dbError) throw dbError;
  return { rows };
};
before(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});
async function request(path, body, ip, raw = false) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: raw ? body : JSON.stringify(body),
  });
}

test('некоректний JSON та завеликий запит не розкривають стек або дані', async () => {
  for (const [body, status] of [['{"password":"private-marker"', 400], ['x'.repeat(3000), 413]]) {
    const response = await request('/api/auth/login', body, '192.0.2.1', true);
    assert.equal(response.status, status);
    const text = await response.text();
    assert.doesNotMatch(text, /private-marker|SyntaxError|node_modules|<html/i);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-powered-by'), null);
  }
});

test('неправильні типи і пароль понад 72 байти відхиляються до запиту БД', async () => {
  calls = [];
  const cases = [null, [], {}, { email: ['a@example.test'], password: 'password' },
    { email: 'a@example.test', password: {} }, { email: 'a@example.test', password: 'я'.repeat(37) },
    { email: 'a@example.test', password: 'password', userId: 1 }];
  for (const body of cases) {
    assert.equal((await request('/api/auth/login', body, '192.0.2.2')).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('підбір пароля обмежується; зміна підробленого лівого XFF не обходить ліміт', async () => {
  calls = [];
  rows = [];
  const body = { email: 'absent@example.test', password: 'incorrect-password' };
  for (let i = 0; i < 20; i++) {
    assert.equal((await request('/api/auth/login', body, `198.51.100.${i + 1}, 192.0.2.3`)).status, 401);
  }
  assert.equal((await request('/api/auth/login', body, '198.51.100.99, 192.0.2.3')).status, 429);
  assert.equal(calls.length, 20);
  // Інша IP-адреса не блокується разом з попередньою.
  assert.equal((await request('/api/auth/login', body, '192.0.2.4')).status, 401);
});

test('реєстрація має окремий ліміт і короткий пароль не записується до БД', async () => {
  calls = [];
  for (let i = 0; i < 5; i++) {
    assert.equal((await request('/api/auth/register', { email: 'a@example.test', password: 'short' }, '192.0.2.5')).status, 400);
  }
  assert.equal((await request('/api/auth/register', { email: 'a@example.test', password: 'a-valid-password' }, '192.0.2.5')).status, 429);
  assert.equal(calls.length, 0);
});

test('SQL-інʼєкція в email залишається параметром запиту', async () => {
  calls = [];
  rows = [];
  const email = "x'OR'1'='1@example.test";
  assert.equal((await request('/api/auth/login', { email, password: 'irrelevant' }, '192.0.2.6')).status, 401);
  assert.equal(calls[0].sql, 'SELECT id, email, password FROM users WHERE email = $1');
  assert.deepEqual(calls[0].values, [email]);
});

test('реєстрація повертає лише публічні поля і зберігає хеш замість пароля', async () => {
  calls = [];
  rows = [{ id: 1, email: 'new@example.test', created_at: '2026-01-01', password: 'must-not-be-returned' }];
  const password = 'only-a-test-password';
  const response = await request('/api/auth/register', { email: rows[0].email, password }, '192.0.2.7');
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.deepEqual(data.user, { id: 1, email: rows[0].email, createdAt: rows[0].created_at });
  assert.notEqual(calls[0].values[1], password);
  assert.equal(await bcrypt.compare(password, calls[0].values[1]), true);
});

test('збої БД не потрапляють у відповідь чи журнал разом із приватними деталями', async () => {
  dbError = new Error('private-db-host-and-password');
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    for (const path of ['/api/auth/login', '/api/auth/register']) {
      const response = await request(path, { email: 'a@example.test', password: 'a-test-password' }, '192.0.2.8');
      assert.equal(response.status, 500);
      assert.doesNotMatch(await response.text(), /private-db/);
    }
    assert.doesNotMatch(logs.join('\n'), /private-db/);
  } finally { console.error = original; dbError = null; }
});

test('невідомий маршрут не віддає HTML та має no-store', async () => {
  const response = await fetch(base + '/not-a-route');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { error: 'Маршрут не знайдено.' });
});
