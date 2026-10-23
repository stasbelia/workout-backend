const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const createRouter = require('../avatarRoutes');
const normalizeAvatar = require('../avatarImage');
const { createAvatarStorage, MAX_AVATAR_BYTES } = require('../avatarStorage');
const { cleanAvatarJobs } = require('../avatarCleanup');
const AvatarError = require('../avatarErrors');

process.env.JWT_SECRET = 'local-complete-tests-only';
let db;
let server;
let baseUrl;
let router;
let originalImage;
let objects;
let statements;
let failSave;
let failUpdate;
let failCommitResponse;
let failDelete;
const signedStorage = createAvatarStorage({
  env: { AWS_REGION: 'eu-central-1', S3_AVATAR_BUCKET: 'avatar-tests-only' },
  credentials: { accessKeyId: 'TEST_ACCESS_KEY_ID', secretAccessKey: 'fake-local-test-secret' },
});
async function query(sql, values) {
  statements.push(sql);
  if (failUpdate && sql.startsWith('UPDATE users')) throw new Error('simulated database failure');
  const result = await db.query(sql, values);
  if (failCommitResponse && sql === 'COMMIT') { failCommitResponse = false; throw new Error('simulated lost commit reply'); }
  return result;
}
const pool = { query, connect: async () => ({ query, release() {} }) };
const storage = {
  createUpload: signedStorage.createUpload,
  readUrl: signedStorage.readUrl,
  async readPending(key) {
    if (!objects.has(key)) throw new AvatarError(400, 'Фото не знайдено. Завантажте його ще раз.');
    return objects.get(key);
  },
  async saveVerified(key, bytes) {
    if (failSave) throw new Error('simulated S3 failure');
    objects.set(key, bytes);
  },
  async remove(key) {
    if (failDelete) throw new Error('simulated deletion failure');
    objects.delete(key);
  },
};
const pending = (id = 7) => `avatars/pending/${id}/${randomUUID()}.jpg`;

before(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL)');
  const migration = await readFile(require('node:path').join(__dirname, '../migrations/002-avatar.sql'), 'utf8');
  await db.exec(migration);
  // Повторний запуск міграції не повинен псувати вже створені поля.
  await db.exec(migration);
  originalImage = await sharp({ create: { width: 700, height: 600, channels: 3, background: '#2266aa' } })
    .withMetadata({ exif: { IFD0: { Artist: 'Local test metadata' } } }).png().toBuffer();
  const app = express();
  app.use('/api/avatar', (req, res, next) => router(req, res, next));
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await db.exec("TRUNCATE users, avatar_cleanup_jobs; INSERT INTO users(id,email) VALUES (7,'one@example.test'),(8,'two@example.test')");
  objects = new Map();
  statements = [];
  failSave = failUpdate = failCommitResponse = failDelete = false;
  router = createRouter({ pool, storage });
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await db.close();
});
async function request(path = '', body, userId = 7) {
  const response = await fetch(`${baseUrl}/api/avatar${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function row() { return (await db.query('SELECT * FROM users WHERE id=7')).rows[0]; }

test('міграція повторювана, а користувач без аватара отримує null', async () => {
  assert.equal((await row()).email, 'one@example.test');
  assert.deepEqual(await request(), { status: 200, body: { avatar: null } });
});
test('читання та підтвердження аватара без JWT відхиляються до БД', async () => {
  const beforeQueries = statements.length;
  const get = await fetch(`${baseUrl}/api/avatar`);
  const complete = await fetch(`${baseUrl}/api/avatar/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: pending() }),
  });
  assert.equal(get.status, 401);
  assert.equal(complete.status, 401);
  assert.equal(statements.length, beforeQueries);
});
test('повний цикл: перевірка PNG → JPEG → запис у PostgreSQL → читання після нового входу', async () => {
  const key = pending();
  objects.set(key, originalImage);
  assert.ok((await sharp(originalImage).metadata()).exif);
  const result = await request('/complete', { key });
  assert.equal(result.status, 200);
  const user = await row();
  assert.match(user.avatar_key, /^avatars\/verified\/7\/[0-9a-f-]+\.jpg$/);
  assert.equal(user.avatar_upload_key, key);
  const meta = await sharp(objects.get(user.avatar_key)).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 512);
  assert.equal(meta.exif, undefined);
  assert.ok(statements.some((sql) => sql.endsWith('FOR UPDATE')));
  const restored = await request();
  assert.equal(restored.status, 200);
  assert.ok(restored.body.avatar.url.includes(encodeURIComponent(user.avatar_key).replaceAll('%2F', '/')));
  assert.ok(Date.parse(restored.body.avatar.expiresAt) > Date.now());
  assert.equal((await request('', undefined, 8)).body.avatar, null);
});
test('чужий ключ і довільний шлях не доходять до S3', async () => {
  for (const key of [pending(8), 'avatars/pending/7/../../other.jpg', 'avatars/verified/7/photo.jpg']) {
    assert.equal((await request('/complete', { key })).status, 400);
  }
  assert.equal((await row()).avatar_key, null);
});
test('відсутній файл і неправдивий MIME не створюють аватар', async () => {
  assert.equal((await request('/complete', { key: pending() })).status, 400);
  const key = pending();
  objects.set(key, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  assert.equal((await request('/complete', { key })).status, 400);
  assert.equal((await row()).avatar_key, null);
});
test('пошкоджене зображення, надмірні байти та розміри відхиляються', async () => {
  const hugeDimensions = await sharp({ create: { width: 4097, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  for (const bytes of [Buffer.from([0xff, 0xd8, 0xff, 0, 0]), Buffer.alloc(MAX_AVATAR_BYTES + 1), hugeDimensions]) {
    await assert.rejects(normalizeAvatar(bytes), (error) => error.status === 400);
  }
});
test('помилка S3 залишає попередній аватар', async () => {
  await db.query('UPDATE users SET avatar_key=$1 WHERE id=7', ['avatars/verified/7/old.jpg']);
  const key = pending(); objects.set(key, originalImage); failSave = true;
  assert.equal((await request('/complete', { key })).status, 503);
  assert.equal((await row()).avatar_key, 'avatars/verified/7/old.jpg');
});
test('помилка запису відкочує транзакцію та не видаляє старий аватар', async () => {
  const key = pending(); objects.set(key, originalImage); failUpdate = true;
  assert.equal((await request('/complete', { key })).status, 503);
  assert.equal((await row()).avatar_key, null);
  assert.equal((await db.query('SELECT * FROM avatar_cleanup_jobs')).rows.length, 1);
  assert.ok(statements.includes('ROLLBACK'));
  // Запис про новий файл пережив ROLLBACK: його приберуть після захисної паузи.
  await db.query("UPDATE avatar_cleanup_jobs SET available_at = now() - interval '1 second'");
  await cleanAvatarJobs({ pool, storage });
  assert.equal([...objects.keys()].filter((name) => name.startsWith('avatars/verified/')).length, 0);
});
test('повтор після втрати відповіді COMMIT повертає вже збережений аватар', async () => {
  const key = pending(); objects.set(key, originalImage); failCommitResponse = true;
  assert.equal((await request('/complete', { key })).status, 503);
  const saved = (await row()).avatar_key;
  assert.ok(saved);
  objects.delete(key);
  const retried = await request('/complete', { key });
  assert.equal(retried.status, 200);
  assert.equal((await row()).avatar_key, saved);
  assert.ok(objects.has(saved));
});
test('підміна pending після підтвердження не змінює перевірений аватар', async () => {
  const key = pending(); objects.set(key, originalImage);
  await request('/complete', { key });
  const saved = (await row()).avatar_key;
  const originalBytes = objects.get(saved);
  objects.set(key, Buffer.from('malicious replacement'));
  assert.equal((await request('/complete', { key })).status, 200);
  assert.deepEqual(objects.get(saved), originalBytes);
});
test('підтвердження має власний ліміт: п’ять повторів дозволені, шостий — 429', async () => {
  const key = pending(); objects.set(key, originalImage);
  for (let n = 0; n < 5; n++) assert.equal((await request('/complete', { key })).status, 200);
  assert.equal((await request('/complete', { key })).status, 429);
  assert.equal((await request('/upload', { contentType: 'image/jpeg', fileSize: 1000 })).status, 200);
});
test('прибирання видаляє старе фото та pending, але не чинний аватар', async () => {
  const key = pending(); objects.set(key, originalImage);
  await request('/complete', { key });
  const first = (await row()).avatar_key;
  const next = pending(); objects.set(next, originalImage);
  await request('/complete', { key: next });
  const current = (await row()).avatar_key;
  failDelete = true;
  await assert.rejects(cleanAvatarJobs({ pool, storage }));
  assert.ok((await db.query('SELECT * FROM avatar_cleanup_jobs')).rows.length);
  failDelete = false;
  await cleanAvatarJobs({ pool, storage });
  assert.equal(objects.has(key), false);
  assert.equal(objects.has(next), false);
  assert.equal(objects.has(first), false);
  assert.equal(objects.has(current), true);
  assert.equal((await db.query('SELECT * FROM avatar_cleanup_jobs')).rows.length, 0);
  // Навіть помилково поставлений у чергу поточний ключ не видаляється.
  await db.query('INSERT INTO avatar_cleanup_jobs(object_key) VALUES ($1)', [current]);
  await cleanAvatarJobs({ pool, storage });
  assert.equal(objects.has(current), true);
});
test('видалений користувач не підтверджує фото та не читає аватар', async () => {
  await db.query('DELETE FROM users WHERE id=7');
  assert.equal((await request()).status, 401);
  assert.equal((await request('/complete', { key: pending() })).status, 401);
});
test('потік S3 контролюється за фактичними байтами, а не лише Content-Length', async () => {
  const actualStorage = createAvatarStorage({
    env: { AWS_REGION: 'eu-central-1', S3_AVATAR_BUCKET: 'avatar-tests-only' },
    client: { send: async () => ({ ContentLength: 1, Body: Readable.from([Buffer.alloc(MAX_AVATAR_BYTES + 1)]) }) },
  });
  await assert.rejects(actualStorage.readPending(pending()), (error) => error.status === 400);
});
test('завеликий Content-Length S3 відхиляється до завантаження тіла в пам’ять', async () => {
  let consumed = false;
  const body = Readable.from((async function* () { consumed = true; yield Buffer.alloc(1); })());
  const actualStorage = createAvatarStorage({
    env: { AWS_REGION: 'eu-central-1', S3_AVATAR_BUCKET: 'avatar-tests-only' },
    client: { send: async () => ({ ContentLength: MAX_AVATAR_BYTES + 1, Body: body }) },
  });
  await assert.rejects(actualStorage.readPending(pending()), (error) => error.status === 400);
  assert.equal(consumed, false);
  assert.equal(body.destroyed, true);
});
