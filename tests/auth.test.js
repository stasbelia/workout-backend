const assert = require('node:assert/strict');
const { before, beforeEach, after, test } = require('node:test');
const { spawnSync } = require('node:child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Тестовий ключ існує лише в цьому процесі; справжній .env не змінюється.
const TEST_SECRET = 'test-only-key-for-auth-integration-tests';
process.env.JWT_SECRET = TEST_SECRET;

const pool = require('../db');
const app = require('../server');
const testUser = {
  id: 7,
  email: 'demo@example.test',
  password: bcrypt.hashSync('test-passphrase', 4),
  created_at: '2026-01-01T00:00:00.000Z',
};

let server;
let baseUrl;
let queryCalls;
let databaseRows;
let databaseError;

// Підставна база: жоден тест не підключається до PostgreSQL.
pool.query = async (sql, values) => {
  queryCalls.push({ sql, values });
  if (databaseError) throw databaseError;
  return { rows: databaseRows };
};

before(async () => {
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  queryCalls = [];
  databaseRows = [testUser];
  databaseError = null;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

function makeToken(payload = { userId: testUser.id }, options = { expiresIn: '1h' }, secret = TEST_SECRET) {
  return jwt.sign(payload, secret, options);
}

async function getMe(authorization, path = '/api/auth/me') {
  const headers = authorization ? { Authorization: authorization } : {};
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('без токена повертається 401 і база не викликається', async () => {
  const result = await getMe();
  assert.equal(result.status, 401);
  assert.equal(queryCalls.length, 0);
});

for (const header of ['Basic abc', 'Bearer', 'Bearer token extra', 'Bearer invalid.token.value']) {
  test(`неправильний заголовок ${header} повертає 401`, async () => {
    assert.equal((await getMe(header)).status, 401);
    assert.equal(queryCalls.length, 0);
  });
}

test('прострочений токен не проходить', async () => {
  const token = makeToken({ userId: testUser.id }, { expiresIn: -1 });
  assert.equal((await getMe(`Bearer ${token}`)).status, 401);
  assert.equal(queryCalls.length, 0);
});

test('токен з чужим підписом не проходить', async () => {
  const token = makeToken({ userId: testUser.id }, { expiresIn: '1h' }, 'another-test-key');
  assert.equal((await getMe(`Bearer ${token}`)).status, 401);
  assert.equal(queryCalls.length, 0);
});

test('зміна userId без нового підпису не проходить', async () => {
  const parts = makeToken().split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  parts[1] = Buffer.from(JSON.stringify({ ...payload, userId: 99 })).toString('base64url');
  assert.equal((await getMe(`Bearer ${parts.join('.')}`)).status, 401);
  assert.equal(queryCalls.length, 0);
});

for (const algorithm of ['HS384', 'none']) {
  test(`алгоритм ${algorithm} не дозволений`, async () => {
    const token = makeToken({ userId: testUser.id }, { algorithm, expiresIn: '1h' }, algorithm === 'none' ? null : TEST_SECRET);
    assert.equal((await getMe(`Bearer ${token}`)).status, 401);
    assert.equal(queryCalls.length, 0);
  });
}

test('токен без строку дії не проходить', async () => {
  const token = makeToken({ userId: testUser.id }, {});
  assert.equal((await getMe(`Bearer ${token}`)).status, 401);
  assert.equal(queryCalls.length, 0);
});

for (const userId of [undefined, '7', 0, -1, 1.5]) {
  test(`неправильний userId ${userId} не проходить`, async () => {
    const token = makeToken({ userId });
    assert.equal((await getMe(`Bearer ${token}`)).status, 401);
    assert.equal(queryCalls.length, 0);
  });
}

test('чинний токен повертає власного користувача без пароля та хешу', async () => {
  const result = await getMe(`Bearer ${makeToken()}`, '/api/auth/me?userId=99');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    user: { id: testUser.id, email: testUser.email, createdAt: testUser.created_at },
  });
  assert.deepEqual(queryCalls[0].values, [testUser.id]);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('видалений користувач не отримує даних навіть з чинним токеном', async () => {
  databaseRows = [];
  assert.equal((await getMe(`Bearer ${makeToken()}`)).status, 401);
});

test('недоступна база повертає 500 без внутрішніх деталей', async () => {
  databaseError = new Error('private database connection details');
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await getMe(`Bearer ${makeToken()}`);
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: 'Не вдалося отримати дані користувача.' });
  } finally {
    console.error = originalError;
  }
});

test('звичайний вхід залишається доступним і видає токен для /me', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testUser.email, password: 'test-passphrase' }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal((await getMe(`Bearer ${data.token}`)).status, 200);
});

test('сервер відмовляється запускатися без JWT_SECRET', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server')"], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, JWT_SECRET: '' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET не налаштований/);
});

test('маршрут аватара підключений до основного сервера та вимагає JWT', async () => {
  const response = await fetch(`${baseUrl}/api/avatar/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/jpeg', fileSize: 1234 }),
  });
  assert.equal(response.status, 401);
  assert.equal(queryCalls.length, 0);
});

test('відсутні налаштування S3 дають 503 лише для аватара; сесія працює', async () => {
  const bucket = process.env.S3_AVATAR_BUCKET;
  delete process.env.S3_AVATAR_BUCKET;
  try {
    const response = await fetch(`${baseUrl}/api/avatar/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${makeToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'image/jpeg', fileSize: 1234 }),
    });
    assert.equal(response.status, 503);
    assert.equal((await getMe(`Bearer ${makeToken()}`)).status, 200);
  } finally {
    if (bucket !== undefined) process.env.S3_AVATAR_BUCKET = bucket;
  }
});
