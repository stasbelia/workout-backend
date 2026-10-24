const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'editing-tests-only-not-a-production-secret';
const pool = require('../db'), app = require('../server');
let db, server, base, owner = 9000, workout, foreign, empty, future, queries, failUpdate, failSets, loseCommit;
let queue = Promise.resolve();
async function query(sql, values) {
  queries.push(sql);
  if (failUpdate && sql.includes('UPDATE workouts SET') && sql.includes('completed_at=')) throw new Error('private-db-marker');
  if (failSets && sql.includes('INSERT INTO exercise_sets')) throw new Error('private-sets-marker');
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
  owner += 2; queries = []; failUpdate = failSets = loseCommit = false; await db.exec('TRUNCATE users CASCADE');
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
  return { status: response.status, data: response.status===204 ? null : await response.json() };
}
const state = completed => ({ completed, today: '2026-10-23' });
const complete = (id = workout, body = state(true), user = owner) => request(`/workouts/${id}/completion`, body, user);
const profile = () => request('/profile?year=2026&today=2026-10-23');

const get = async (id=workout,user=owner) => (await request('/workouts/'+id,undefined,user)).data;
const patchWorkout = (body,id=workout,user=owner) => request('/workouts/'+id,body,user,'PATCH');
const workoutBody = (w,changes={}) => ({title:w.title,date:w.date,notes:w.notes,expectedRevision:w.revision,today:'2026-10-23',...changes});
const exerciseBody = (e,changes={}) => ({name:e.name,notes:e.notes,sets:e.sets.map(({reps,weightKg})=>({reps,weightKg})),expectedRevision:e.revision,...changes});
const editExercise = (id,body,user=owner,parent=workout) => request(`/workouts/${parent}/exercises/${id}`,body,user,'PATCH');
const remove = (id,revision,user=owner) => request('/workouts/'+id,{expectedRevision:revision},user,'DELETE');
const removeExercise = (e,parent=workout,user=owner) => request(`/workouts/${parent}/exercises/${e.id}`,{expectedRevision:e.revision},user,'DELETE');

test('усі зміни вимагають JWT до SQL',async()=>{
 queries=[];for(const method of ['PATCH','DELETE'])for(const route of [`/workouts/${workout}`,`/workouts/${workout}/exercises/1`])assert.equal((await fetch(base+route,{method})).status,401);assert.equal(queries.length,0);
});
test('редагування назви, дати й нотатки зберігає вправи та збільшує версію лише один раз',async()=>{
 const before=await get();const body=workoutBody(before.workout,{title:'Нова назва',date:'2024-02-29',notes:'Змінено'});
 const saved=await patchWorkout(body);assert.equal(saved.status,200);assert.equal(saved.data.workout.revision,1);
 assert.equal((await patchWorkout(body)).data.workout.revision,1);assert.equal((await get()).workout.date,'2024-02-29');assert.deepEqual((await get()).exercises,before.exercises);
});
test('паралельні різні зміни тієї самої версії не затирають одна одну',async()=>{
 const w=(await get()).workout;const results=await Promise.all([patchWorkout(workoutBody(w,{title:'A'})),patchWorkout(workoutBody(w,{title:'B'}))]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await get()).workout.revision,1);
});
test('завершене тренування переноситься в календарі, на майбутню дату — лише після скасування',async()=>{
 await complete();let w=(await get()).workout;assert.equal(w.revision,1);
 assert.equal((await patchWorkout(workoutBody(w,{date:'2026-10-24'}))).status,409);
 const r=await patchWorkout(workoutBody(w,{date:'2024-02-29'}));assert.equal(r.status,200);assert.equal(r.data.workout.completedAt,w.completedAt);
 assert.deepEqual((await request('/profile?year=2024&today=2026-10-23')).data.activity.days,[{date:'2024-02-29',count:1}]);
});
test('вправу й підходи можна змінити, додати й прибрати атомарно; 0 кг і невказана вага різні',async()=>{
 const before=await get(),e=before.exercises[0];const body=exerciseBody(e,{name:'Жим гантелей',notes:'Новий темп',sets:[{reps:8,weightKg:42.5},{reps:6,weightKg:null},{reps:5,weightKg:0}]});
 const r=await editExercise(e.id,body);assert.equal(r.status,200);assert.equal(r.data.exercise.revision,1);assert.deepEqual(r.data.exercise.sets.map(({reps,weightKg})=>({reps,weightKg})),body.sets);
 assert.equal((await editExercise(e.id,body)).data.exercise.revision,1);assert.equal((await get()).workout.revision,before.workout.revision+1);
 const smaller=await editExercise(e.id,exerciseBody(r.data.exercise,{sets:[{reps:10,weightKg:45}]}));assert.equal(smaller.status,200);assert.equal(smaller.data.exercise.sets.length,1);
});
test('збій нового підходу відкочує назву, попередні підходи й обидві версії',async()=>{
 const before=await get();failSets=true;const r=await editExercise(before.exercises[0].id,exerciseBody(before.exercises[0],{name:'Не зберігати'}));assert.equal(r.status,500);assert.doesNotMatch(JSON.stringify(r),/private-sets-marker/);failSets=false;assert.deepEqual(await get(),before);
});
test('повтор після втрати відповіді COMMIT не переписує підходи вдруге',async()=>{
 const e=(await get()).exercises[0],body=exerciseBody(e,{sets:[{reps:7,weightKg:12.5}]});loseCommit=true;
 assert.equal((await editExercise(e.id,body)).status,500);const now=await get();assert.equal(now.exercises[0].revision,1);
 assert.equal((await editExercise(e.id,body)).status,200);assert.deepEqual(await get(),now);
});
test('чужі тренування й вправи недоступні; вправу не можна підставити від іншого тренування',async()=>{
 const e=(await get()).exercises[0];const other=(await get(foreign,owner+1)).exercises[0];
 assert.equal((await patchWorkout(workoutBody((await get()).workout),foreign)).status,404);
 assert.equal((await editExercise(e.id,exerciseBody(e),owner+1)).status,404);
 assert.equal((await editExercise(other.id,exerciseBody(other))).status,404);
 assert.equal((await remove(foreign,0)).status,204);assert.equal((await removeExercise(other)).status,204);assert.equal((await get(foreign,owner+1)).exercises.length,1);
});
test('неправильні поля, типи, версії, підходи й query відхиляються',async()=>{
 const detail=await get();const w=workoutBody(detail.workout),e=exerciseBody(detail.exercises[0]);
 for(const change of [{expectedRevision:-1},{expectedRevision:'0'},{expectedRevision:1.5},{date:'2026-02-29'},{title:''},{userId:owner+1},{completedAt:'2026-01-01'}])assert.equal((await patchWorkout({...w,...change})).status,400);
 for(const change of [{sets:[]},{sets:[{reps:0,weightKg:10}]},{sets:[{reps:10,weightKg:-1}]},{sets:[{reps:10,weightKg:1.234}]},{clientRequestId:randomUUID()},{userId:owner+1}])assert.equal((await editExercise(detail.exercises[0].id,{...e,...change})).status,400);
 assert.equal((await request(`/workouts/${workout}?user=1`,w,owner,'PATCH')).status,400);
 assert.equal((await remove(workout,undefined)).status,400);assert.equal((await patchWorkout({...w,notes:'x'.repeat(5000)})).status,413);
});
test('видалення тренування очищає вправи/підходи й календар, але зберігає шаблон',async()=>{
 await complete();const t=await request('/workout-templates',{sourceWorkoutId:workout,name:'Збережений',clientRequestId:randomUUID()},owner,'POST');assert.equal(t.status,201);
 const w=(await get()).workout;assert.equal((await remove(workout,w.revision)).status,204);assert.equal((await remove(workout,w.revision)).status,204);assert.equal((await request('/workouts/'+workout)).status,404);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM workout_exercises WHERE workout_id=$1',[workout])).rows[0].n,0);
 assert.equal((await request('/profile?year=2026&today=2026-10-23')).data.activity.totalWorkouts,0);assert.equal((await request('/workout-templates/'+t.data.template.id)).status,200);
});
test('застаріле видалення тренування не видаляє нову вправу',async()=>{
 const w=(await get()).workout;
 const r=await request(`/workouts/${workout}/exercises`,{name:'Тяга',notes:'',sets:[{reps:8,weightKg:20}],clientRequestId:randomUUID()},owner,'POST');assert.equal(r.status,201);
 assert.equal((await remove(workout,w.revision)).status,409);assert.equal((await get()).exercises.length,2);
});
test('видалення останньої вправи скасовує завершення без видалення тренування',async()=>{
 await complete();const e=(await get()).exercises[0];assert.equal((await removeExercise(e)).status,204);
 const detail=await get();assert.equal(detail.exercises.length,0);assert.equal(detail.workout.completedAt,null);assert.equal((await complete()).status,409);
 assert.equal((await removeExercise(e)).status,204);
});
test('після видалення середньої вправи порядок ущільнюється й можна додавати нову',async()=>{
 async function append(name){const r=await request(`/workouts/${workout}/exercises`,{name,notes:'',sets:[{reps:8,weightKg:null}],clientRequestId:randomUUID()},owner,'POST');assert.equal(r.status,201);return r.data.exercise;}
 const middle=await append('Друга'),last=await append('Третя');assert.equal((await removeExercise(middle)).status,204);
 let detail=await get();assert.deepEqual(detail.exercises.map(e=>e.position),[1,2]);assert.equal(detail.exercises[1].id,last.id);assert.equal(detail.exercises[1].revision,1);
 assert.equal((await editExercise(last.id,exerciseBody(last,{name:'Застаріла форма'}))).status,409);
 assert.equal((await append('Нова')).position,3);
});
test('застаріле видалення вправи не прибирає нові підходи; snapshot шаблону не змінюється',async()=>{
 const e=(await get()).exercises[0];const t=await request('/workout-templates',{sourceWorkoutId:workout,name:'Початкова',clientRequestId:randomUUID()},owner,'POST');
 assert.equal((await editExercise(e.id,exerciseBody(e,{sets:[{reps:5,weightKg:100}]}))).status,200);assert.equal((await removeExercise(e)).status,409);
 assert.equal((await request('/workout-templates/'+t.data.template.id)).data.template.exercises[0].sets[0].weightKg,40);
});
test('видалений акаунт із чинним JWT не може редагувати чи видаляти',async()=>{
 await db.query('DELETE FROM users WHERE id=$1',[owner]);assert.equal((await remove(workout,0)).status,401);assert.equal((await patchWorkout({title:'Test',date:'2026-10-23',notes:'',expectedRevision:0,today:'2026-10-23'})).status,401);
});
