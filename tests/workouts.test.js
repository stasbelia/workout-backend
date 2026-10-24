const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'workout-tests-only-not-a-real-secret';
const pool = require('../db');
const app = require('../server');
let db, server, base, owner = 100, calls = 0, fail = false;
pool.query = async (...args) => {
  calls++;
  if (fail) throw new Error('private-database-details');
  return db.query(...args);
};
before(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE users (id integer PRIMARY KEY)');
  const sql = await readFile(require('node:path').join(__dirname, '../migrations/003-workouts.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  await db.exec(await readFile(require('node:path').join(__dirname, '../migrations/007-workout-completion.sql'), 'utf8'));
  await db.exec(await readFile(require('node:path').join(__dirname, '../migrations/004-workout-exercises.sql'), 'utf8'));
  await db.exec(await readFile(require('node:path').join(__dirname, '../migrations/008-workout-editing.sql'), 'utf8'));
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/api/workouts`;
});
beforeEach(async () => {
  owner += 2;
  calls = 0; fail = false;
  await db.exec('TRUNCATE users CASCADE');
  await db.query('INSERT INTO users VALUES ($1), ($2)', [owner, owner + 1]);
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await db.close();
  await pool.end();
});
const draft = (changes = {}) => ({ title: 'Верх тіла', date: '2026-10-23', notes: 'Легке тренування', clientRequestId: randomUUID(), ...changes });
async function request(body, userId = owner, query = '') {
  const response = await fetch(base + query, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}

test('обидва маршрути вимагають токен до звернення до бази', async () => {
  for (const method of ['GET', 'POST']) assert.equal((await fetch(base, { method })).status, 401);
  assert.equal(calls, 0);
});
test('створення зберігає поля; новий запит повертає запис з PostgreSQL', async () => {
  const body = draft({ title: '  Ноги  ', notes: '  Присідання\nБез поспіху  ' });
  const saved = await request(body);
  assert.equal(saved.status, 201);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(saved.data.workout).sort(), ['completedAt', 'createdAt', 'date', 'id', 'notes', 'revision', 'title']);
  assert.equal(saved.data.workout.title, 'Ноги');
  assert.equal(saved.data.workout.date, body.date);
  assert.equal(saved.data.workout.notes, 'Присідання\nБез поспіху');
  const list = await request();
  assert.deepEqual(list.data, { workouts: [saved.data.workout], nextCursor: null });
});
test('інший користувач не бачить записів і не може підставити userId', async () => {
  await request(draft());
  assert.deepEqual((await request(undefined, owner + 1)).data.workouts, []);
  assert.equal((await request(draft({ userId: owner + 1 }))).status, 400);
  assert.equal((await request(undefined, owner, '?userId=1')).status, 400);
});
test('повтор після втрати відповіді та паралельні повтори не створюють дублікатів', async () => {
  const body = draft();
  const first = await request(body);
  const repeats = await Promise.all([request(body), request(body)]);
  for (const result of repeats) {
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.workout, first.data.workout);
  }
  assert.equal((await request()).data.workouts.length, 1);
  assert.equal((await request({ ...body, title: 'Інша назва' })).status, 409);
  // Той самий ключ іншого користувача не відкриває чужий запис.
  assert.equal((await request(body, owner + 1)).status, 201);
});
test('некоректні поля та неможливі календарні дати відхиляються до SQL', async () => {
  for (const change of [
    { title: '' }, { title: '   ' }, { title: [] }, { title: 'a'.repeat(101) }, { title: 'a\nb' },
    { notes: null }, { notes: {} }, { notes: 'a'.repeat(501) }, { notes: '\u0000' },
    { date: '2026-02-29' }, { date: '2024-04-31' }, { date: '2026-13-01' },
    { date: '2026-10-23T00:00:00Z' }, { date: '1899-12-31' }, { date: '2101-01-01' },
    { clientRequestId: 'not-a-uuid' }, { extra: 'field' },
  ]) assert.equal((await request(draft(change))).status, 400, JSON.stringify(change));
  for (const body of [null, [], 'text']) assert.equal((await request(body)).status, 400);
  assert.equal(calls, 0);
  assert.equal((await request(draft({ date: '2024-02-29', notes: undefined }))).status, 201);
});
test('SQL у назві зберігається як звичайний текст', async () => {
  const title = "'); DROP TABLE users; --";
  assert.equal((await request(draft({ title }))).data.workout.title, title);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
});
test('сторінки мають стабільний порядок за датою та ID, без чужих записів і пропусків', async () => {
  const ids = [];
  for (let i = 0; i < 23; i++) ids.push((await request(draft({ date: i < 3 ? '2026-10-24' : '2026-10-23' }))).data.workout.id);
  await request(draft({ date: '2026-10-25' }), owner + 1);
  const first = (await request()).data;
  assert.equal(first.workouts.length, 20);
  const second = (await request(undefined, owner, `?cursor=${encodeURIComponent(first.nextCursor)}`)).data;
  assert.equal(second.workouts.length, 3);
  assert.equal(second.nextCursor, null);
  const all = [...first.workouts, ...second.workouts].map((item) => item.id);
  assert.deepEqual(all, [...ids.slice(0, 3).reverse(), ...ids.slice(3).reverse()]);
  assert.equal(new Set(all).size, 23);
});
test('небезпечні або неправильні курсори відхиляються до SQL', async () => {
  for (const cursor of ['2026-02-29:1', '2026-10-23:0', '2026-10-23:2147483648', "'OR'1", '2026-10-23:1.5']) {
    assert.equal((await request(undefined, owner, `?cursor=${encodeURIComponent(cursor)}`)).status, 400);
  }
  assert.equal((await request(undefined, owner, '?cursor=a&cursor=b')).status, 400);
  assert.equal(calls, 0);
});
test('видалений користувач із ще чинним JWT отримує 401', async () => {
  await db.query('DELETE FROM users WHERE id=$1', [owner]);
  assert.equal((await request()).status, 401);
  assert.equal((await request(draft())).status, 401);
});
test('ліміт запитів спільний для токенів одного користувача, інший користувач не блокується', async () => {
  for (let i = 0; i < 60; i++) assert.equal((await request({})).status, 400);
  assert.equal((await request({})).status, 429);
  assert.equal(calls, 0);
  assert.equal((await request(undefined, owner + 1)).status, 200);
});
test('помилки JSON, розміру та бази не розкривають приватні деталі', async () => {
  const token = jwt.sign({ userId: owner }, process.env.JWT_SECRET, { expiresIn: '1h' });
  for (const [body, status] of [['{', 400], ['x'.repeat(5000), 413]]) {
    const response = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /SyntaxError|node_modules|<html/);
  }
  fail = true;
  for (const body of [undefined, draft()]) {
    const result = await request(body);
    assert.equal(result.status, 500);
    assert.doesNotMatch(JSON.stringify(result.data), /private-database/);
  }
});
