const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'template-tests-only-not-a-production-secret';
const pool = require('../db');
const app = require('../server');
let db, server, base, owner = 1000, workout, second, foreign;
let failSets, loseCommitReply, queries, queue = Promise.resolve();
async function query(sql, values) {
  queries.push({ sql, values });
  if (failSets && sql.includes('INSERT INTO exercise_templates')) throw new Error('private-db-marker');
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
  for (const name of ['003-workouts.sql', '004-workout-exercises.sql', '005-exercise-templates.sql', '007-workout-completion.sql','008-workout-editing.sql']) {
    const sql = await readFile(require('node:path').join(__dirname, '../migrations', name), 'utf8');
    await db.exec(sql); await db.exec(sql);
  }
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/api/exercise-templates`;
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
async function request(body, user = owner, path = '', method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ userId: user }, process.env.JWT_SECRET, { expiresIn: '1h' })}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}
async function count() { return (await db.query('SELECT count(*)::int AS n FROM exercise_templates')).rows[0].n; }

test('JWT перевіряється до бази для читання, запису і видалення шаблонів', async () => {
  for (const [method, path] of [['GET', ''], ['POST', ''], ['DELETE', '/1']]) assert.equal((await fetch(base + path, { method })).status, 401);
  assert.equal(queries.length, 0);
});
test('шаблон з нотаткою і підходами читається після нового входу лише власником', async () => {
  const result = await request(draft({ name: '  Мій жим  ', notes: '  Пауза  ' }));
  assert.equal(result.status, 201);
  assert.equal(result.data.template.name, 'Мій жим'); assert.equal(result.data.template.notes, 'Пауза');
  assert.deepEqual(result.data.template.sets, [{ reps: 10, weightKg: 40 }, { reps: 8, weightKg: 42.5 }]);
  assert.deepEqual((await request()).data.templates, [result.data.template]);
  assert.deepEqual((await request(undefined, owner + 1)).data.templates, []);
  assert.deepEqual(Object.keys(result.data.template).sort(), ['createdAt','id','name','notes','sets']);
});
test('однакові запити, новий UUID та регістр назви не дублюють шаблон', async () => {
  const body = draft();
  const results = await Promise.all([request(body), request(body)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200,201]);
  assert.equal((await request({ ...body, clientRequestId: randomUUID(), name: body.name.toLowerCase() })).status, 200);
  assert.equal(await count(), 1);
  assert.equal((await request({ ...body, sets: [{ reps: 1 }] })).status, 409);
  assert.equal((await request({ ...body, name: 'Інша назва' })).status, 409);
  assert.equal((await request({ ...body, clientRequestId: randomUUID(), notes: 'Інші дані' })).status, 409);
  assert.equal((await request(body, owner + 1)).status, 201);
});
test('неправильні дані, підміна власника та завеликі запити відхиляються', async () => {
  const changes = [{userId: owner+1}, {id: 1}, {name:''}, {name:'a'.repeat(101)}, {notes:null}, {sets:[]}, {sets:Array(31).fill({reps:1})},
    ...[0,1001,1.5,'10',null].map(reps=>({sets:[{reps}]})),
    ...[-1,1000.01,1.234,'40',true].map(weightKg=>({sets:[{reps:10,weightKg}]})), {sets:[{reps:10,position:4}]}];
  for (const change of changes) assert.equal((await request(draft(change))).status, 400);
  assert.equal((await request(draft({notes:'a'.repeat(5000)}))).status,413);
  assert.equal(await count(),0);
});
test('повторення і вага мають спільні з вправами межі; null і 0 різні', async () => {
  const result = await request(draft({sets:[{reps:1},{reps:1000,weightKg:1000},{reps:4,weightKg:0},{reps:8,weightKg:0.29}]}));
  assert.equal(result.status,201);
  assert.deepEqual(result.data.template.sets.map(s=>s.weightKg),[null,1000,0,0.29]);
});
test('чужий ID не видаляє шаблон; повтор видалення безпечний', async () => {
  const saved = (await request(draft())).data.template;
  assert.equal((await request(undefined,owner+1,`/${saved.id}`,'DELETE')).status,204);
  assert.equal(await count(),1);
  assert.equal((await request(undefined,owner,`/${saved.id}`,'DELETE')).status,204);
  assert.equal((await request(undefined,owner,`/${saved.id}`,'DELETE')).status,204);
  assert.equal(await count(),0);
});
test('видалення шаблону не змінює тренування та записані підходи', async () => {
  const saved = (await request(draft())).data.template;
  const ex=(await db.query("INSERT INTO workout_exercises(workout_id,client_request_id,name,position) VALUES($1,$2,'Присідання',1) RETURNING id",[workout,randomUUID()])).rows[0].id;
  await db.query('INSERT INTO exercise_sets(exercise_id,position,reps,weight_kg) VALUES($1,1,10,40)',[ex]);
  await request(undefined,owner,`/${saved.id}`,'DELETE');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM exercise_sets')).rows[0].n,1);
});
test('неправильний шлях, зайві параметри та видалений користувач відхиляються', async () => {
  for (const id of ['0','-1','01','1.5','2147483648',"1'OR'1"]) assert.equal((await request(undefined,owner,`/${id}`,'DELETE')).status,400);
  assert.equal((await request(undefined,owner,'?userId=1')).status,400);
  await db.query('DELETE FROM users WHERE id=$1',[owner]);
  for (const [body,path,method] of [[undefined,'','GET'],[draft(),'','POST'],[undefined,'/1','DELETE']]) assert.equal((await request(body,owner,path,method)).status,401);
});
test('збій запису відкочує зміни й не розкриває деталі бази', async () => {
  failSets = true;
  const result = await request(draft());
  assert.equal(result.status,500); assert.doesNotMatch(JSON.stringify(result.data),/private-db-marker/); assert.equal(await count(),0);
});
test('втрата відповіді COMMIT і повтор з новим UUID повертають той самий шаблон', async () => {
  const body = draft(); loseCommitReply=true;
  assert.equal((await request(body)).status,500);
  assert.equal((await request({...body,clientRequestId:randomUUID()})).status,200);
  assert.equal(await count(),1);
});
test('ліміт 100 шаблонів, повтор на ліміті й місце після видалення', async () => {
  const first=(await request(draft())).data.template;
  await db.query(`INSERT INTO exercise_templates(user_id,client_request_id,name,sets)
    SELECT $1,md5(n::text)::uuid,'Вправа '||n,'[{"reps":1,"weightKg":null}]'::jsonb FROM generate_series(1,99) n`,[owner]);
  assert.equal((await request(draft({name:'Новий'}))).status,409);
  assert.equal((await request(draft())).status,200);
  assert.equal((await request()).data.templates.length,100);
  await request(undefined,owner,`/${first.id}`,'DELETE');
  assert.equal((await request(draft({name:'Новий'}))).status,201);
});
test('SQL у назві зберігається як текст; видалення акаунта прибирає його шаблони', async () => {
  const name="'); DROP TABLE users; --";
  assert.equal((await request(draft({name}))).data.template.name,name);
  await db.query('DELETE FROM users WHERE id=$1',[owner]);
  assert.equal(await count(),0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n,1);
});
