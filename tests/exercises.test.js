const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'exercise-tests-only-not-a-production-secret';
const pool = require('../db');
const app = require('../server');
let db, server, base, owner = 1000, workout, second, foreign;
let failSets, loseCommitReply, queries, queue = Promise.resolve();
async function query(sql, values) {
  queries.push({ sql, values });
  if (failSets && sql.includes('INSERT INTO exercise_sets')) throw new Error('private-db-marker');
  const result = await db.query(sql, values);
  if (sql === 'COMMIT' && loseCommitReply) { loseCommitReply = false; throw new Error('simulated lost commit response'); }
  return result;
}
pool.query = query;
// PGlite has one connection; serialize test transactions. Real PostgreSQL locks
// are additionally checked by the HTTPS smoke test with concurrent requests.
pool.connect = async () => {
  const previous = queue;
  let release;
  queue = new Promise((resolve) => { release = resolve; });
  await previous;
  return { query, release };
};
before(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE users(id integer PRIMARY KEY)');
  for (const name of ['003-workouts.sql', '004-workout-exercises.sql', '007-workout-completion.sql','008-workout-editing.sql']) {
    const sql = await readFile(require('node:path').join(__dirname, '../migrations', name), 'utf8');
    await db.exec(sql); await db.exec(sql);
  }
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/api/workouts`;
});
beforeEach(async () => {
  owner += 2; queries = []; failSets = loseCommitReply = false;
  await db.exec('TRUNCATE users CASCADE');
  await db.query('INSERT INTO users VALUES ($1),($2)', [owner, owner + 1]);
  async function create(user) {
    return (await db.query("INSERT INTO workouts(user_id,client_request_id,title,workout_date) VALUES($1,$2,'Ноги','2026-10-23') RETURNING id", [user, randomUUID()])).rows[0].id;
  }
  workout = await create(owner); second = await create(owner); foreign = await create(owner + 1);
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await db.close();
  await pool.end();
});
const draft = (changes = {}) => ({ name: 'Присідання', notes: 'Контрольований рух', sets: [{ reps: 10, weightKg: 40 }, { reps: 8, weightKg: 42.5 }], clientRequestId: randomUUID(), ...changes });
async function request(id = workout, body, user = owner, suffix = '') {
  const response = await fetch(`${base}/${id}${body === undefined ? '' : '/exercises'}${suffix}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${jwt.sign({ userId: user }, process.env.JWT_SECRET, { expiresIn: '1h' })}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
async function counts() {
  return (await db.query('SELECT (SELECT count(*)::int FROM workout_exercises) AS exercises, (SELECT count(*)::int FROM exercise_sets) AS sets')).rows[0];
}

test('деталі та додавання вправ вимагають JWT до звернення до бази', async () => {
  for (const [method, path] of [['GET', `/${workout}`], ['POST', `/${workout}/exercises`]]) {
    assert.equal((await fetch(base + path, { method })).status, 401);
  }
  assert.equal(queries.length, 0);
});
test('старе тренування відкривається з порожнім списком, міграція не змінює його дані', async () => {
  const detail = await request();
  assert.equal(detail.status, 200);
  assert.equal(detail.data.workout.title, 'Ноги');
  assert.equal(detail.data.workout.date, '2026-10-23');
  assert.deepEqual(detail.data.exercises, []);
});
test('вправа та всі підходи зберігаються разом і читаються після нового запиту', async () => {
  const saved = await request(workout, draft({ name: '  Присідання  ', notes: '  Повільно\nБез поспіху  ' }));
  assert.equal(saved.status, 201);
  const exercise = saved.data.exercise;
  assert.equal(exercise.name, 'Присідання');
  assert.equal(exercise.notes, 'Повільно\nБез поспіху');
  assert.deepEqual(exercise.sets, [{ position: 1, reps: 10, weightKg: 40 }, { position: 2, reps: 8, weightKg: 42.5 }]);
  assert.deepEqual((await request()).data.exercises, [exercise]);
  assert.deepEqual(Object.keys(exercise).sort(), ['createdAt', 'id', 'name', 'notes', 'position', 'revision', 'sets']);
});
test('чуже і відсутнє тренування повертають однаковий 404 без читання чужих вправ', async () => {
  await request(foreign, draft(), owner + 1);
  for (const id of [foreign, 2147483647]) {
    assert.deepEqual(await request(id), { status: 404, data: { error: 'Тренування не знайдено.' } });
    assert.equal((await request(id, draft())).status, 404);
  }
  assert.deepEqual(await counts(), { exercises: 1, sets: 2 });
});
test('підміна власника, тренування чи позицій у JSON відхиляється', async () => {
  for (const change of [{ userId: owner + 1 }, { workoutId: foreign }, { position: 5 }, { sets: [{ reps: 10, position: 9 }] }]) {
    assert.equal((await request(workout, draft(change))).status, 400);
  }
  assert.deepEqual(await counts(), { exercises: 0, sets: 0 });
});
test('некоректні ID та SQL у шляху відхиляються до бази', async () => {
  for (const id of ['0', '-1', '1.5', '01', '2147483648', "1'OR'1"]) {
    assert.equal((await request(id)).status, 400);
    assert.equal((await request(id, draft())).status, 400);
  }
  assert.equal(queries.length, 0);
});
test('неправильні поля, кількість підходів, повторення та вага не створюють записів', async () => {
  const changes = [{ name: '' }, { name: 'a'.repeat(101) }, { name: [] }, { notes: null }, { notes: 'a'.repeat(501) },
    { name: 'one\ntwo' }, { sets: [] }, { sets: null }, { sets: Array(31).fill({ reps: 1 }) },
    ...[0, -1, 1.5, 1001, '10', null].map((reps) => ({ sets: [{ reps }] })),
    ...[-1, 1000.01, 1.234, '20', {}, true].map((weightKg) => ({ sets: [{ reps: 10, weightKg }] })),
  ];
  for (const change of changes) assert.equal((await request(workout, draft(change))).status, 400, JSON.stringify(change));
  assert.deepEqual(await counts(), { exercises: 0, sets: 0 });
});
test('граничні значення, нульова і невказана вага приймаються', async () => {
  const result = await request(workout, draft({ notes: undefined, sets: [{ reps: 1 }, { reps: 1000, weightKg: 1000 }, { reps: 5, weightKg: 0 }, { reps: 6, weightKg: 0.29 }] }));
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.exercise.sets.map((set) => set.weightKg), [null, 1000, 0, 0.29]);
});
test('повтор і паралельні однакові запити не дублюють вправу та підходи', async () => {
  const body = draft();
  const results = await Promise.all([request(workout, body), request(workout, body)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
  assert.equal(results[0].data.exercise.id, results[1].data.exercise.id);
  assert.deepEqual(await counts(), { exercises: 1, sets: 2 });
  assert.equal((await request(workout, { ...body, sets: [{ reps: 12 }] })).status, 409);
  assert.equal((await request(second, body)).status, 201);
});
test('паралельні різні вправи отримують різні послідовні позиції', async () => {
  const results = await Promise.all([request(workout, draft()), request(workout, draft({ name: 'Випади' }))]);
  assert.deepEqual(results.map((result) => result.status), [201, 201]);
  assert.deepEqual(results.map((result) => result.data.exercise.position).sort(), [1, 2]);
  const detail = await request();
  assert.deepEqual(detail.data.exercises.map((item) => item.position), [1, 2]);
});
test('збій запису підходів відкочує і саму вправу, помилка не містить деталей бази', async () => {
  failSets = true;
  const result = await request(workout, draft());
  assert.equal(result.status, 500);
  assert.doesNotMatch(JSON.stringify(result.data), /private-db-marker/);
  assert.deepEqual(await counts(), { exercises: 0, sets: 0 });
});
test('втрата відповіді COMMIT дозволяє безпечний повтор після фактичного збереження', async () => {
  const body = draft(); loseCommitReply = true;
  assert.equal((await request(workout, body)).status, 500);
  assert.equal((await request(workout, body)).status, 200);
  assert.deepEqual(await counts(), { exercises: 1, sets: 2 });
});
test('ліміт 100 вправ не обходиться; повтор збереженої вправи працює й на ліміті', async () => {
  const first = draft(); const saved = await request(workout, first);
  await db.query("INSERT INTO workout_exercises(workout_id,client_request_id,name,position) VALUES($1,$2,'Остання',100)", [workout, randomUUID()]);
  assert.equal((await request(workout, draft())).status, 409);
  assert.equal((await request(workout, first)).data.exercise.id, saved.data.exercise.id);
});
test('видалений користувач із чинним токеном не читає і не додає вправи', async () => {
  await db.query('DELETE FROM users WHERE id=$1', [owner]);
  assert.equal((await request()).status, 401);
  assert.equal((await request(workout, draft())).status, 401);
});
test('SQL у назві є текстом; видалення власного тестового тренування прибирає залежні записи', async () => {
  const name = "'); DROP TABLE users; --";
  assert.equal((await request(workout, draft({ name }))).data.exercise.name, name);
  await db.query('DELETE FROM workouts WHERE id=$1', [workout]);
  assert.deepEqual(await counts(), { exercises: 0, sets: 0 });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
});
