const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'completion-tests-only-not-a-production-secret';
const pool = require('../db'), app = require('../server');
let db, server, base, owner = 7000, workout, foreign, empty, future, queries, failUpdate, loseCommit;
let queue = Promise.resolve();
async function query(sql, values) {
  queries.push(sql);
  if (failUpdate && sql.includes('UPDATE workouts SET') && sql.includes('completed_at=')) throw new Error('private-db-marker');
  const result = await db.query(sql, values);
  if (loseCommit && sql === 'COMMIT') { loseCommit = false; throw new Error('lost reply'); }
  return result;
}
pool.query = query;
pool.connect = async () => { const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); await previous; return { query, release }; };
before(async () => {
  db = new PGlite();
  await db.exec('CREATE TABLE users(id integer PRIMARY KEY,email text,password text,created_at timestamptz DEFAULT now())');
  for (const name of ['003-workouts.sql', '004-workout-exercises.sql', '005-exercise-templates.sql', '006-profile-workout-templates.sql', '007-workout-completion.sql','008-workout-editing.sql']) {
    const sql = await readFile(require('node:path').join(__dirname, '../migrations', name), 'utf8'); await db.exec(sql); await db.exec(sql);
  }
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async () => {
  owner += 2; queries = []; failUpdate = loseCommit = false; await db.exec('TRUNCATE users CASCADE');
  await db.query("INSERT INTO users(id,email,password) VALUES($1,'owner@example.test','fake'),($2,'other@example.test','fake')", [owner, owner + 1]);
  async function make(user, date, sets) {
    const id = (await db.query("INSERT INTO workouts(user_id,client_request_id,title,workout_date) VALUES($1,$2,'Верх',$3) RETURNING id", [user, randomUUID(), date])).rows[0].id;
    if (sets) {
      const e = (await db.query("INSERT INTO workout_exercises(workout_id,client_request_id,name,position) VALUES($1,$2,'Жим',1) RETURNING id", [id, randomUUID()])).rows[0].id;
      await db.query('INSERT INTO exercise_sets(exercise_id,position,reps,weight_kg) VALUES($1,1,10,40)', [e]);
    }
    return id;
  }
  workout = await make(owner, '2026-10-23', true); empty = await make(owner, '2026-10-22', false);
  future = await make(owner, '2026-10-24', true); foreign = await make(owner + 1, '2026-10-23', true);
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); if (db) await db.close(); await pool.end(); });
async function request(path, body, user = owner, method = body === undefined ? 'GET' : 'PATCH') {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${jwt.sign({ userId: user }, process.env.JWT_SECRET, { expiresIn: '1h' })}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const state = completed => ({ completed, today: '2026-10-23' });
const complete = (id = workout, body = state(true), user = owner) => request(`/workouts/${id}/completion`, body, user);
const profile = () => request('/profile?year=2026&today=2026-10-23');

test('завершення вимагає JWT до SQL', async () => {
  queries = []; assert.equal((await fetch(`${base}/workouts/${workout}/completion`, { method: 'PATCH' })).status, 401); assert.equal(queries.length, 0);
});
test('попередні й нові записи незавершені, календар спочатку порожній', async () => {
  assert.equal((await request('/workouts/' + workout)).data.workout.completedAt, null);
  assert.ok((await request('/workouts')).data.workouts.every(w => w.completedAt === null));
  assert.equal((await profile()).data.activity.totalWorkouts, 0);
  const result = await request('/workouts', { title: 'Новий', date: '2026-10-23', notes: '', clientRequestId: randomUUID() }, owner, 'POST');
  assert.equal(result.status, 201); assert.equal(result.data.workout.completedAt, null);
});
test('завершення зберігає час, повторний запит і новий JWT читають той самий стан', async () => {
  const first = await complete(); assert.equal(first.status, 200); assert.ok(Number.isFinite(Date.parse(first.data.workout.completedAt)));
  assert.equal((await complete()).data.workout.completedAt, first.data.workout.completedAt);
  assert.equal((await request('/workouts/' + workout)).data.workout.completedAt, first.data.workout.completedAt);
  assert.equal((await request('/workouts')).data.workouts.find(w => w.id === workout).completedAt, first.data.workout.completedAt);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM workout_exercises WHERE workout_id=$1', [workout])).rows[0].n, 1);
});
test('паралельні завершення дають один час, календар рахує один запис', async () => {
  const results = await Promise.all([complete(), complete()]); assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(results[0].data.workout.completedAt, results[1].data.workout.completedAt);
  assert.deepEqual((await profile()).data.activity, { year: 2026, today: '2026-10-23', totalWorkouts: 1, yearWorkouts: 1, activeDays: 1, days: [{ date: '2026-10-23', count: 1 }] });
});
test('скасування завершення прибирає запис зі статистики без видалення вправ', async () => {
  await complete(); const result = await complete(workout, state(false)); assert.equal(result.status, 200); assert.equal(result.data.workout.completedAt, null);
  assert.equal((await complete(workout, state(false))).data.workout.completedAt, null);
  assert.equal((await profile()).data.activity.totalWorkouts, 0); assert.equal((await request('/workouts/' + workout)).data.exercises.length, 1);
});
test('чужі й відсутні записи повертають однаковий 404, чужий календар не змінюється', async () => {
  for (const id of [foreign, 2147483647]) for (const completed of [true, false]) assert.equal((await complete(id, state(completed))).status, 404);
  assert.equal((await db.query('SELECT completed_at FROM workouts WHERE id=$1', [foreign])).rows[0].completed_at, null);
});
test('порожній і майбутній план не можна завершити, скасування дозволене', async () => {
  for (const id of [empty, future]) { assert.equal((await complete(id)).status, 409); assert.equal((await complete(id, state(false))).status, 200); }
  assert.equal((await profile()).data.activity.totalWorkouts, 0);
});
test('власника, час завершення, типи й неправильні дати не можна підставити через JSON', async () => {
  for (const body of [{}, null, [], { completed: 'true', today: '2026-10-23' }, { completed: true }, { ...state(true), userId: owner + 1 }, { ...state(true), completedAt: '2026-01-01' }, { completed: true, today: '2026-02-29' }]) assert.equal((await complete(workout, body)).status, 400);
  for (const id of ['0', '-1', 'abc', '2147483648']) assert.equal((await complete(id)).status, 400);
  assert.equal((await request(`/workouts/${workout}/completion?owner=1`, state(true))).status, 400);
  assert.equal((await complete(workout, { ...state(true), padding: 'x'.repeat(5000) })).status, 413);
});
test('збій UPDATE відкочує стан; повтор після втрати відповіді COMMIT не зсуває час', async () => {
  failUpdate = true; const failed = await complete(); assert.equal(failed.status, 500); assert.doesNotMatch(JSON.stringify(failed), /private-db-marker/); failUpdate = false;
  assert.equal((await request('/workouts/' + workout)).data.workout.completedAt, null);
  loseCommit = true; assert.equal((await complete()).status, 500);
  const saved = (await request('/workouts/' + workout)).data.workout.completedAt;
  assert.ok(saved); assert.equal((await complete()).data.workout.completedAt, saved);
});
test('шаблон завершеного тренування створює незавершену копію з усіма підходами', async () => {
  await complete(); const t = await request('/workout-templates', { sourceWorkoutId: workout, name: 'Верх A', clientRequestId: randomUUID() }, owner, 'POST'); assert.equal(t.status, 201);
  const copy = await request(`/workout-templates/${t.data.template.id}/workouts`, { title: 'Копія', date: '2026-10-23', notes: '', clientRequestId: randomUUID() }, owner, 'POST');
  assert.equal(copy.status, 201); assert.equal(copy.data.workout.completedAt, null);
  assert.equal((await request('/workouts/' + copy.data.workout.id)).data.exercises[0].sets[0].reps, 10);
  assert.equal((await profile()).data.activity.totalWorkouts, 1);
});
test('календар використовує дату тренування, високосний день і лише власні завершені записи', async () => {
  await complete(); await db.query("UPDATE workouts SET workout_date='2024-02-29' WHERE id=$1", [workout]);
  await complete(foreign, state(true), owner + 1);
  const a = (await request('/profile?year=2024&today=2026-10-23')).data.activity;
  assert.deepEqual(a.days, [{ date: '2024-02-29', count: 1 }]); assert.equal(a.totalWorkouts, 1); assert.equal(a.yearWorkouts, 1);
  assert.equal((await profile()).data.activity.yearWorkouts, 0);
});
test('видалений користувач із чинним токеном не змінює стан', async () => {
  await db.query('DELETE FROM users WHERE id=$1', [owner]); assert.equal((await complete()).status, 401);
});
