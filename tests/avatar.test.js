const assert = require('node:assert/strict');
const { before, beforeEach, after, test } = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const createAvatarRouter = require('../avatarRoutes');
const { createAvatarStorage, MAX_AVATAR_BYTES } = require('../avatarStorage');

process.env.JWT_SECRET = 'avatar-tests-only-signing-key';
const fakeCredentials = {
  accessKeyId: 'TEST_ACCESS_KEY_ID',
  secretAccessKey: 'fake-secret-for-local-tests-only',
};
const fakeEnv = { AWS_REGION: 'eu-central-1', S3_AVATAR_BUCKET: 'avatar-tests-only' };
const storage = createAvatarStorage({ env: fakeEnv, credentials: fakeCredentials });
let server;
let baseUrl;
let queries;
let signCalls;
let databaseFailure;
let deletedUser;
let storageFailure;
let userCounter = 100;

const app = express();
app.use('/api/avatar', createAvatarRouter({
  pool: {
    async query(sql, values) {
      queries.push({ sql, values });
      if (databaseFailure) throw new Error('private DB details');
      return { rows: deletedUser ? [] : [{ id: values[0] }] };
    },
  },
  storage: {
    async createUpload(input) {
      signCalls.push(input);
      if (storageFailure) throw new Error('private AWS details');
      return storage.createUpload(input);
    },
  },
}));

before(async () => {
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  queries = [];
  signCalls = [];
  databaseFailure = deletedUser = storageFailure = false;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function upload(body = { contentType: 'image/jpeg', fileSize: 1234 }, options = {}) {
  const userId = options.userId ?? ++userCounter;
  const authorization = options.authorization ?? `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  const response = await fetch(`${baseUrl}/api/avatar/upload`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: options.raw ?? JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('аватар: без авторизації немає звернення до БД чи підписання', async () => {
  assert.equal((await upload(undefined, { authorization: '' })).status, 401);
  assert.equal(queries.length, 0);
  assert.equal(signCalls.length, 0);
});

test('аватар: прострочений і підроблений токени відхиляються', async () => {
  for (const token of [
    jwt.sign({ userId: 7 }, process.env.JWT_SECRET, { expiresIn: -1 }),
    jwt.sign({ userId: 7 }, 'another-test-key', { expiresIn: '1h' }),
  ]) {
    assert.equal((await upload(undefined, { authorization: `Bearer ${token}` })).status, 401);
  }
  assert.equal(queries.length, 0);
  assert.equal(signCalls.length, 0);
});

for (const body of [
  null, [], {}, { contentType: 'image/jpeg' },
  { contentType: 'image/svg+xml', fileSize: 10 },
  { contentType: 'image/heic', fileSize: 10 },
  { contentType: '__proto__', fileSize: 10 },
  ...[0, -1, 1.5, '100', MAX_AVATAR_BYTES + 1, Number.MAX_SAFE_INTEGER].map((fileSize) => ({ contentType: 'image/jpeg', fileSize })),
  { contentType: 'image/jpeg', fileSize: 10, userId: 99 },
  { contentType: 'image/jpeg', fileSize: 10, key: 'avatars/99/overwrite.jpg' },
]) {
  test(`аватар: неправильні параметри ${JSON.stringify(body)} відхиляються до БД`, async () => {
    assert.equal((await upload(body)).status, 400);
    assert.equal(queries.length, 0);
    assert.equal(signCalls.length, 0);
  });
}

test('аватар: пошкоджений JSON і завеликий запит мають зрозумілі відповіді', async () => {
  assert.deepEqual((await upload(undefined, { raw: '{broken' })).body, { error: 'Некоректний JSON.' });
  assert.equal((await upload({ padding: 'x'.repeat(3000) })).status, 413);
  assert.equal(queries.length, 0);
});

test('аватар: дозвіл прив’язаний до JWT, точного ключа, MIME, 5 МіБ та 5 хвилин', async () => {
  const beforeSigning = Date.now();
  const result = await upload({ contentType: 'image/jpeg', fileSize: MAX_AVATAR_BYTES }, { userId: 7 });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(queries, [{ sql: 'SELECT id FROM users WHERE id = $1', values: [7] }]);
  assert.deepEqual(signCalls, [{ userId: 7, contentType: 'image/jpeg' }]);
  const { url, fields, key, expiresIn, maxFileSize } = result.body.upload;
  assert.match(url, /^https:\/\/avatar-tests-only\.s3\.eu-central-1\.amazonaws\.com\/?$/);
  assert.match(key, /^avatars\/pending\/7\/[\da-f-]{36}\.jpg$/);
  assert.equal(fields.key, key);
  assert.equal(fields['Content-Type'], 'image/jpeg');
  assert.equal(fields.acl, undefined);
  assert.equal(expiresIn, 300);
  assert.equal(maxFileSize, MAX_AVATAR_BYTES);
  assert.ok(fields['X-Amz-Signature']);
  assert.ok(!JSON.stringify(result.body).includes(fakeCredentials.secretAccessKey));

  // Перевіряємо справжню підписану політику SDK, а не підставний результат.
  const policy = JSON.parse(Buffer.from(fields.Policy, 'base64').toString());
  assert.ok(policy.conditions.some((condition) => JSON.stringify(condition) === JSON.stringify(['content-length-range', 1, MAX_AVATAR_BYTES])));
  assert.ok(policy.conditions.some((condition) => JSON.stringify(condition) === JSON.stringify(['eq', '$Content-Type', 'image/jpeg'])));
  assert.ok(policy.conditions.some((condition) => condition.key === key));
  assert.ok(policy.conditions.some((condition) => condition.bucket === fakeEnv.S3_AVATAR_BUCKET));
  assert.ok(Date.parse(policy.expiration) >= beforeSigning + 299_000);
  assert.ok(Date.parse(policy.expiration) <= Date.now() + 300_000);
});

test('аватар: PNG та мінімальний розмір дозволені, повторні запити мають різні ключі', async () => {
  const first = await upload({ contentType: 'image/png', fileSize: 1 }, { userId: 8 });
  const second = await upload({ contentType: 'image/png', fileSize: 1 }, { userId: 8 });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(first.body.upload.key, /\.png$/);
  assert.notEqual(first.body.upload.key, second.body.upload.key);
});

test('аватар: видалений користувач не отримує дозволу', async () => {
  deletedUser = true;
  assert.equal((await upload()).status, 401);
  assert.equal(signCalls.length, 0);
});

test('аватар: помилка БД повертає 500 без внутрішніх деталей', async () => {
  databaseFailure = true;
  const result = await upload();
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'Не вдалося перевірити користувача.' });
  assert.equal(signCalls.length, 0);
});

test('аватар: помилка підписання повертає 503 без даних AWS', async () => {
  storageFailure = true;
  const result = await upload();
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'Завантаження фото тимчасово недоступне. Спробуйте пізніше.' });
});

test('аватар: шоста спроба за хвилину отримує 429, інший користувач має власний ліміт', async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await upload(undefined, { userId: 9001 })).status, 200);
  }
  const blocked = await upload(undefined, { userId: 9001 });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal(signCalls.length, 5);
  assert.equal((await upload(undefined, { userId: 9002 })).status, 200);
});

test('аватар: відсутня конфігурація не запускає пошук справжніх ключів', async () => {
  const unconfigured = createAvatarStorage({ env: {} });
  await assert.rejects(unconfigured.createUpload({ userId: 7, contentType: 'image/jpeg' }), /не налаштоване/);
});

test('аватар: недоступні тестові credentials коректно переривають підписання', async () => {
  const unavailable = createAvatarStorage({
    env: fakeEnv,
    credentials: async () => { throw new Error('test credentials unavailable'); },
  });
  await assert.rejects(unavailable.createUpload({ userId: 7, contentType: 'image/jpeg' }), /test credentials unavailable/);
});
