const assert=require('node:assert/strict');
const {test,before,beforeEach,after}=require('node:test');
const {readFile}=require('node:fs/promises');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const jwt=require('jsonwebtoken');
process.env.JWT_SECRET='profile-plan-tests-only-not-a-production-secret';
const pool=require('../db'),app=require('../server');
let db,server,base,owner=3000,source,foreign,queries,failSets,failProfile,loseCommit,queue=Promise.resolve();
async function query(sql,values){queries.push(sql);if(failSets&&sql.includes('INSERT INTO exercise_sets'))throw new Error('private-marker');if(failProfile&&sql.includes('SELECT id, email, nickname'))throw new Error('private-marker');const result=await db.query(sql,values);if(loseCommit&&sql==='COMMIT'){loseCommit=false;throw new Error('lost reply');}return result;}
pool.query=query;
pool.connect=async()=>{const previous=queue;let release;queue=new Promise(resolve=>{release=resolve;});await previous;return{query,release};};
before(async()=>{
 db=new PGlite();await db.exec('CREATE TABLE users(id integer PRIMARY KEY,email text,password text,created_at timestamptz DEFAULT now())');
 for(const file of ['003-workouts.sql','004-workout-exercises.sql','005-exercise-templates.sql','006-profile-workout-templates.sql', '007-workout-completion.sql','008-workout-editing.sql']){const sql=await readFile(require('node:path').join(__dirname,'../migrations',file),'utf8');await db.exec(sql);await db.exec(sql);}
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base=`http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async()=>{
 owner+=2;queries=[];failSets=failProfile=loseCommit=false;await db.exec('TRUNCATE users CASCADE');
 await db.query("INSERT INTO users(id,email,password) VALUES($1,'owner@example.test','fake-hash'),($2,'other@example.test','fake-hash')",[owner,owner+1]);
 async function make(user){return(await db.query("INSERT INTO workouts(user_id,client_request_id,title,workout_date,notes) VALUES($1,$2,'Верх тіла','2026-02-20','План') RETURNING id",[user,randomUUID()])).rows[0].id;}
 source=await make(owner);foreign=await make(owner+1);
 for(const [position,name,sets]of [[1,'Жим',[[10,40],[8,42.5]]],[2,'Підтягування',[[5,null],[6,0]]]]){
  const id=(await db.query('INSERT INTO workout_exercises(workout_id,client_request_id,name,notes,position) VALUES($1,$2,$3,$4,$5) RETURNING id',[source,randomUUID(),name,'Нотатка '+position,position])).rows[0].id;
  for(const[index,[reps,weight]]of sets.entries())await db.query('INSERT INTO exercise_sets(exercise_id,position,reps,weight_kg) VALUES($1,$2,$3,$4)',[id,index+1,reps,weight]);
 }
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(db)await db.close();await pool.end();});
const draft=changes=>({sourceWorkoutId:source,name:'Мій верх',clientRequestId:randomUUID(),...changes});
const workoutDraft=changes=>({title:'Верх — новий день',date:'2026-10-23',notes:'Інша нотатка',clientRequestId:randomUUID(),...changes});
async function request(path,body,user=owner,method=body===undefined?'GET':'POST'){
 const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${jwt.sign({userId:user},process.env.JWT_SECRET,{expiresIn:'1h'})}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:r.status===204?null:await r.json()};
}
async function saved(){const r=await request('/workout-templates',draft());assert.equal(r.status,201);return r.data.template;}
async function counts(){return(await db.query('SELECT (SELECT count(*)::int FROM workouts WHERE user_id=$1) AS workouts,(SELECT count(*)::int FROM workout_exercises e JOIN workouts w ON w.id=e.workout_id WHERE w.user_id=$1) AS exercises,(SELECT count(*)::int FROM exercise_sets s JOIN workout_exercises e ON e.id=s.exercise_id JOIN workouts w ON w.id=e.workout_id WHERE w.user_id=$1) AS sets',[owner])).rows[0];}

test('профіль, календар і шаблони перевіряють JWT до SQL',async()=>{
 for(const[method,path]of [['GET','/profile?year=2026&today=2026-10-23'],['PATCH','/profile'],['GET','/workout-templates'],['POST','/workout-templates'],['POST','/workout-templates/1/workouts'],['DELETE','/workout-templates/1']])assert.equal((await fetch(base+path,{method})).status,401);
 assert.equal(queries.length,0);
});
test('профіль повертає email і нікнейм лише власника, без пароля',async()=>{
 const r=await request('/profile?year=2026&today=2026-10-23');assert.equal(r.status,200);assert.equal(r.data.user.email,'owner@example.test');assert.equal(r.data.user.nickname,null);
 assert.deepEqual(Object.keys(r.data.user).sort(),['createdAt','email','id','nickname']);
 assert.equal((await request('/profile?year=2026&today=2026-10-23&userId=1')).status,400);
});
test('календар групує календарні дати, відокремлює роки і не рахує майбутні плани чи чужі записи',async()=>{
 for(const date of ['2026-02-28','2026-02-28','2024-02-29','2026-03-02'])await db.query("INSERT INTO workouts(user_id,client_request_id,title,workout_date) VALUES($1,$2,'Запис',$3)",[owner,randomUUID(),date]);
 await db.query('UPDATE workouts SET completed_at=now() WHERE user_id=$1',[owner]);
 const activity=(await request('/profile?year=2026&today=2026-03-01')).data.activity;
 assert.deepEqual(activity,{year:2026,today:'2026-03-01',totalWorkouts:4,yearWorkouts:3,activeDays:2,days:[{date:'2026-02-20',count:1},{date:'2026-02-28',count:2}]});
 assert.equal((await request('/profile?year=2024&today=2026-03-01')).data.activity.yearWorkouts,1);
 for(const path of ['year=2026&today=2026-02-29','year=abc&today=2026-03-01','year=1899&today=2026-03-01','year=2026&today[]=2026-03-01'])assert.equal((await request('/profile?'+path)).status,400);
});
test('нікнейм редагується, повторюється і прибирається; email та власника підмінити не можна',async()=>{
 const r=await request('/profile',{nickname:'  Стас_1  '},owner,'PATCH');assert.equal(r.status,200);assert.equal(r.data.user.nickname,'Стас_1');
 assert.equal((await request('/profile',{nickname:'Стас_1'},owner,'PATCH')).data.user.nickname,'Стас_1');
 assert.equal((await request('/profile',{nickname:'Стас_1'},owner+1,'PATCH')).status,200);
 for(const body of [{nickname:'a'},{nickname:'𐐀'},{nickname:'x'.repeat(33)},{nickname:'bad\nname'},{nickname:'<script>'},{nickname:null},{nickname:'Okay',email:'fake@example.test'},{nickname:'Okay',userId:owner+1}])assert.equal((await request('/profile',body,owner,'PATCH')).status,400);
 assert.equal((await request('/profile',{nickname:''},owner,'PATCH')).data.user.nickname,null);
 assert.equal((await request('/profile',{nickname:'x'.repeat(3000)},owner,'PATCH')).status,413);
});
test('видалений користувач та збій профілю не розкривають дані',async()=>{
 failProfile=true;const result=await request('/profile?year=2026&today=2026-10-23');assert.equal(result.status,500);assert.doesNotMatch(JSON.stringify(result.data),/private-marker/);failProfile=false;
 await db.query('DELETE FROM users WHERE id=$1',[owner]);assert.equal((await request('/profile?year=2026&today=2026-10-23')).status,401);assert.equal((await request('/profile',{nickname:'User'},owner,'PATCH')).status,401);
});
test('шаблон містить усі вправи, нотатки, порядок і різні підходи, а список лише зведення',async()=>{
 const t=await saved();assert.equal(t.exerciseCount,2);assert.equal(t.setCount,4);assert.equal(t.notes,'План');assert.equal('exercises'in t,false);
 const detail=(await request('/workout-templates/'+t.id)).data.template;
 assert.deepEqual(detail.exercises,[{name:'Жим',notes:'Нотатка 1',sets:[{reps:10,weightKg:40},{reps:8,weightKg:42.5}]},{name:'Підтягування',notes:'Нотатка 2',sets:[{reps:5,weightKg:null},{reps:6,weightKg:0}]}]);
 assert.deepEqual((await request('/workout-templates')).data.templates,[t]);
 assert.equal('source_workout_id'in detail,false);assert.equal('user_id'in detail,false);
});
test('чужий шаблон і джерело недоступні; JSON не приймає довільного вмісту',async()=>{
 const t=await saved();assert.deepEqual((await request('/workout-templates',undefined,owner+1)).data.templates,[]);
 assert.equal((await request('/workout-templates/'+t.id,undefined,owner+1)).status,404);
 assert.equal((await request('/workout-templates',draft({sourceWorkoutId:foreign}))).status,404);
 assert.equal((await request(`/workout-templates/${t.id}/workouts`,workoutDraft(),owner+1)).status,404);
 for(const change of [{userId:owner+1},{exercises:[]},{sourceWorkoutId:'1'},{sourceWorkoutId:0},{name:''},{name:'x'.repeat(101)},{clientRequestId:'invalid'}])assert.equal((await request('/workout-templates',draft(change))).status,400);
 assert.equal((await request('/workout-templates/'+t.id,undefined,owner+1,'DELETE')).status,204);assert.equal((await request('/workout-templates')).data.templates.length,1);
});
test('порожнє тренування не зберігається як шаблон',async()=>{
 assert.equal((await request('/workout-templates',draft({sourceWorkoutId:foreign}),owner+1)).status,400);
});
test('повтори і паралельні збереження не дублюють шаблон; UUID зберігає початковий snapshot',async()=>{
 const body=draft();const results=await Promise.all([request('/workout-templates',body),request('/workout-templates',body)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
 assert.equal((await request('/workout-templates',{...body,clientRequestId:randomUUID()})).status,200);
 await db.query("UPDATE workout_exercises SET notes='Змінено' WHERE workout_id=$1",[source]);
 assert.equal((await request('/workout-templates',body)).status,200);
 assert.equal((await request('/workout-templates',{...body,clientRequestId:randomUUID()})).status,409);
 assert.equal((await request('/workout-templates',{...body,name:'Інше'})).status,409);
});
test('нове тренування копіює всі вправи атомарно на іншу дату і має незалежні ID',async()=>{
 const t=await saved();const r=await request(`/workout-templates/${t.id}/workouts`,workoutDraft());assert.equal(r.status,201);assert.notEqual(r.data.workout.id,source);assert.equal(r.data.workout.date,'2026-10-23');assert.equal(r.data.workout.notes,'Інша нотатка');
 const detail=(await request('/workouts/'+r.data.workout.id)).data;assert.equal(detail.exercises.length,2);assert.deepEqual(detail.exercises.map(e=>e.position),[1,2]);assert.deepEqual(detail.exercises[1].sets.map(s=>s.weightKg),[null,0]);
 assert.deepEqual(await counts(),{workouts:2,exercises:4,sets:8});
 const ids=(await db.query('SELECT id FROM workout_exercises WHERE workout_id=$1',[source])).rows.map(r=>r.id);assert.ok(detail.exercises.every(e=>!ids.includes(e.id)));
 assert.deepEqual(Object.keys(r.data.workout).sort(),['completedAt','createdAt','date','id','notes','revision','title']);
});
test('збій запису підходів відкочує нове тренування та вправи цілком',async()=>{
 const t=await saved();failSets=true;const r=await request(`/workout-templates/${t.id}/workouts`,workoutDraft());assert.equal(r.status,500);assert.doesNotMatch(JSON.stringify(r.data),/private-marker/);assert.deepEqual(await counts(),{workouts:1,exercises:2,sets:4});
});
test('повтори створення, втрата COMMIT і повтор після видалення шаблону не дублюють тренування',async()=>{
 const t=await saved(),body=workoutDraft();loseCommit=true;
 assert.equal((await request(`/workout-templates/${t.id}/workouts`,body)).status,500);
 const retry=await request(`/workout-templates/${t.id}/workouts`,body);assert.equal(retry.status,200);
 assert.equal((await request(`/workout-templates/${t.id}/workouts`,{...body,date:'2026-10-24'})).status,409);
 await request('/workout-templates/'+t.id,undefined,owner,'DELETE');
 assert.equal((await request(`/workout-templates/${t.id}/workouts`,body)).data.workout.id,retry.data.workout.id);
 assert.deepEqual(await counts(),{workouts:2,exercises:4,sets:8});
});
test('два одночасні однакові запити створюють одне тренування, різні — незалежні копії',async()=>{
 const t=await saved(),body=workoutDraft();const results=await Promise.all([request(`/workout-templates/${t.id}/workouts`,body),request(`/workout-templates/${t.id}/workouts`,body)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);
 const different=await Promise.all([request(`/workout-templates/${t.id}/workouts`,workoutDraft()),request(`/workout-templates/${t.id}/workouts`,workoutDraft())]);assert.deepEqual(different.map(r=>r.status),[201,201]);assert.deepEqual(await counts(),{workouts:4,exercises:8,sets:16});
});
test('видалення джерела й шаблону не змінює створену копію',async()=>{
 const t=await saved();await db.query('DELETE FROM workouts WHERE id=$1',[source]);
 const r=await request(`/workout-templates/${t.id}/workouts`,workoutDraft());assert.equal(r.status,201);
 await request('/workout-templates/'+t.id,undefined,owner,'DELETE');assert.equal((await request('/workouts/'+r.data.workout.id)).data.exercises.length,2);
});
test('максимальні 100 вправ і 3000 підходів копіюються без скорочення',async()=>{
 await db.query(`INSERT INTO workout_exercises(workout_id,client_request_id,name,position) SELECT $1,md5(n::text)::uuid,'Вправа '||n,n FROM generate_series(3,100)n`,[source]);
 await db.query(`INSERT INTO exercise_sets(exercise_id,position,reps,weight_kg) SELECT e.id,n,10,40 FROM workout_exercises e CROSS JOIN generate_series(1,30)n WHERE e.workout_id=$1 AND (e.position>2 OR n>2)`,[source]);
 const t=await saved();assert.equal(t.exerciseCount,100);assert.equal(t.setCount,3000);
 const r=await request(`/workout-templates/${t.id}/workouts`,workoutDraft());assert.equal(r.status,201);const detail=(await request('/workouts/'+r.data.workout.id)).data;assert.equal(detail.exercises.length,100);assert.equal(detail.exercises.reduce((n,e)=>n+e.sets.length,0),3000);
});
test('квота 50 шаблонів, повтор на ліміті, місце після видалення',async()=>{
 const t=await saved();const json=(await request('/workout-templates/'+t.id)).data.template.exercises;
 await db.query(`INSERT INTO workout_templates(user_id,client_request_id,source_workout_id,name,exercises) SELECT $1,md5(n::text)::uuid,$2,'Шаблон '||n,$3::jsonb FROM generate_series(1,49)n`,[owner,source,JSON.stringify(json)]);
 assert.equal((await request('/workout-templates',draft({name:'Новий'}))).status,409);assert.equal((await request('/workout-templates',draft())).status,200);
 await request('/workout-templates/'+t.id,undefined,owner,'DELETE');assert.equal((await request('/workout-templates',draft({name:'Новий'}))).status,201);
});
test('дати, параметри, неправильні ID і підміна полів нового тренування відхиляються',async()=>{
 const t=await saved();for(const change of [{date:'2026-02-29'},{userId:owner+1},{templateId:t.id},{exercises:[]}])assert.equal((await request(`/workout-templates/${t.id}/workouts`,workoutDraft(change))).status,400);
 for(const value of ['0','01','1.5','2147483648',"1'OR'1"])assert.equal((await request('/workout-templates/'+value)).status,400);
 assert.equal((await request('/workout-templates?userId=1')).status,400);
});
