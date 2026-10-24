const express=require('express');
const {randomUUID}=require('node:crypto');
const {rateLimit}=require('express-rate-limit');
const authMiddleware=require('./authMiddleware');
const {parseBody:parseWorkout}=require('./workoutInput');
const {parseBody:parseExercise}=require('./exerciseInput');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validId=value=>typeof value==='number'&&Number.isInteger(value)&&value>0&&value<=2147483647;
const pathId=value=>typeof value==='string'&&/^[1-9]\d{0,9}$/.test(value)&&validId(Number(value));
const COLUMNS='id,name,notes,exercises,created_at AS "createdAt"';
const WORKOUT_COLUMNS='id,title,workout_date::text AS date,notes,created_at AS "createdAt",completed_at AS "completedAt", revision';
const summary=row=>({id:row.id,name:row.name,notes:row.notes,createdAt:row.createdAt,exerciseCount:row.exercises.length,setCount:row.exercises.reduce((n,e)=>n+e.sets.length,0)});
const equal=(a,b)=>a.name.toLowerCase()===b.name.toLowerCase()&&a.notes===b.notes&&JSON.stringify(a.exercises)===JSON.stringify(b.exercises);
// Validate stored snapshots before copying, even though the original source
// exercise route already checks these fields. Never accept snapshots from a client.
function snapshot(rows,sets){
 return rows.map(row=>{
  const parsed=parseExercise({name:row.name,notes:row.notes,sets:sets.filter(s=>s.exerciseId===row.id).map(({reps,weightKg})=>({reps,weightKg})),clientRequestId:randomUUID()});
  if(!parsed)throw new Error('Invalid stored exercise');
  return {name:parsed.name,notes:parsed.notes,sets:parsed.sets};
 });
}
module.exports=function createWorkoutTemplateRouter({pool}){
 const router=express.Router();
 router.use(authMiddleware);
 router.use(rateLimit({windowMs:60_000,limit:60,keyGenerator:req=>String(req.user.id),standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Забагато запитів до шаблонів тренувань. Спробуйте через хвилину.'}}));
 router.use(express.json({limit:'4kb'}));
 router.use(async(req,res,next)=>{
  if(Object.keys(req.query).length)return res.status(400).json({error:'Некоректний запит шаблонів тренувань.'});
  try{if(!(await pool.query('SELECT id FROM users WHERE id=$1',[req.user.id])).rows.length)return res.status(401).json({error:'Увійдіть повторно.'});return next();}catch(error){return next(error);}
 });
 router.get('/',async(req,res,next)=>{
  try{
   // SQL returns only summaries: a list never transfers 50 full snapshots.
   const result=await pool.query(`SELECT id,name,notes,created_at AS "createdAt",jsonb_array_length(exercises) AS "exerciseCount",
    (SELECT sum(jsonb_array_length(e->'sets'))::int FROM jsonb_array_elements(exercises) e) AS "setCount"
    FROM workout_templates WHERE user_id=$1 ORDER BY id DESC LIMIT 50`,[req.user.id]);
   return res.json({templates:result.rows});
  }catch(error){return next(error);}
 });
 router.get('/:templateId',async(req,res,next)=>{
  if(!pathId(req.params.templateId))return res.status(400).json({error:'Некоректний номер шаблону.'});
  try{
   const result=await pool.query(`SELECT ${COLUMNS} FROM workout_templates WHERE id=$1 AND user_id=$2`,[Number(req.params.templateId),req.user.id]);
   if(!result.rows.length)return res.status(404).json({error:'Шаблон не знайдено.'});
   return res.json({template:result.rows[0]});
  }catch(error){return next(error);}
 });
 router.post('/',async(req,res,next)=>{
  const body=req.body;
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).some(k=>!['sourceWorkoutId','name','clientRequestId'].includes(k))||
    !validId(body.sourceWorkoutId)||typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>100||/\p{Cc}/u.test(body.name)||typeof body.clientRequestId!=='string'||!UUID.test(body.clientRequestId))return res.status(400).json({error:'Перевірте назву шаблону та номер тренування.'});
  let client,transaction=false;
  try{
   client=await pool.connect();await client.query('BEGIN');transaction=true;
   const owner=await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   if(!owner.rows.length){await client.query('ROLLBACK');transaction=false;return res.status(401).json({error:'Увійдіть повторно.'});}
   const byRequest=(await client.query(`SELECT ${COLUMNS},source_workout_id FROM workout_templates WHERE user_id=$1 AND client_request_id=$2::uuid`,[req.user.id,body.clientRequestId])).rows[0];
   if(byRequest){
    await client.query('COMMIT');transaction=false;
    if(byRequest.source_workout_id!==body.sourceWorkoutId||byRequest.name!==body.name.trim())return res.status(409).json({error:'Цей запит уже зберіг інший шаблон.'});
    return res.json({template:summary(byRequest)});
   }
   // Exercise appends lock this same workout; the snapshot is consistent.
   const source=(await client.query('SELECT id,notes FROM workouts WHERE id=$1 AND user_id=$2 FOR UPDATE',[body.sourceWorkoutId,req.user.id])).rows[0];
   if(!source){await client.query('ROLLBACK');transaction=false;return res.status(404).json({error:'Тренування не знайдено.'});}
   const rows=(await client.query('SELECT id,name,notes FROM workout_exercises WHERE workout_id=$1 ORDER BY position LIMIT 100',[source.id])).rows;
   if(!rows.length){await client.query('ROLLBACK');transaction=false;return res.status(400).json({error:'Спочатку додайте до тренування хоча б одну вправу.'});}
   const sets=(await client.query(`SELECT s.exercise_id AS "exerciseId",s.reps,s.weight_kg::float8 AS "weightKg" FROM exercise_sets s
    JOIN workout_exercises e ON e.id=s.exercise_id WHERE e.workout_id=$1 ORDER BY e.position,s.position LIMIT 3000`,[source.id])).rows;
   const draft={name:body.name.trim(),notes:source.notes,exercises:snapshot(rows,sets)};
   const existing=(await client.query(`SELECT ${COLUMNS} FROM workout_templates WHERE user_id=$1 AND lower(name)=lower($2)`,[req.user.id,draft.name])).rows[0];
   if(existing){
    await client.query('COMMIT');transaction=false;
    // JSONB object key ordering is canonical in PostgreSQL; compare values explicitly.
    const old={...existing,exercises:existing.exercises.map(e=>({name:e.name,notes:e.notes,sets:e.sets.map(s=>({reps:s.reps,weightKg:s.weightKg}))}))};
    if(!equal(old,draft))return res.status(409).json({error:'Шаблон із такою назвою вже має інший вміст. Вкажіть іншу назву або видаліть старий шаблон.'});
    return res.json({template:summary(existing)});
   }
   const count=(await client.query('SELECT count(*)::int AS n FROM workout_templates WHERE user_id=$1',[req.user.id])).rows[0].n;
   if(count>=50){await client.query('ROLLBACK');transaction=false;return res.status(409).json({error:'У вас уже є 50 шаблонів тренувань. Видаліть непотрібний.'});}
   const inserted=await client.query(`INSERT INTO workout_templates(user_id,client_request_id,name,notes,exercises,source_workout_id) VALUES($1,$2::uuid,$3,$4,$5::jsonb,$6) RETURNING ${COLUMNS}`,[req.user.id,body.clientRequestId,draft.name,draft.notes,JSON.stringify(draft.exercises),source.id]);
   await client.query('COMMIT');transaction=false;return res.status(201).json({template:summary(inserted.rows[0])});
  }catch(error){if(client&&transaction)await client.query('ROLLBACK').catch(()=>{});return next(error);}finally{client?.release();}
 });
 router.post('/:templateId/workouts',async(req,res,next)=>{
  if(!pathId(req.params.templateId))return res.status(400).json({error:'Некоректний номер шаблону.'});
  const body=parseWorkout(req.body);
  if(!body)return res.status(400).json({error:'Перевірте назву, дату та нотатку нового тренування.'});
  const templateId=Number(req.params.templateId);let client,transaction=false;
  try{
   client=await pool.connect();await client.query('BEGIN');transaction=true;
   const owner=await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
   if(!owner.rows.length){await client.query('ROLLBACK');transaction=false;return res.status(401).json({error:'Увійдіть повторно.'});}
   const existing=(await client.query(`SELECT ${WORKOUT_COLUMNS},template_source_id FROM workouts WHERE user_id=$1 AND client_request_id=$2::uuid`,[req.user.id,body.clientRequestId])).rows[0];
   if(existing){
    await client.query('COMMIT');transaction=false;
    if(existing.template_source_id!==templateId||existing.title!==body.title||existing.date!==body.date||existing.notes!==body.notes)return res.status(409).json({error:'Цей запит уже створив інше тренування. Перевірте список.'});
    const {template_source_id,...workout}=existing;return res.json({workout});
   }
   const template=(await client.query(`SELECT ${COLUMNS} FROM workout_templates WHERE id=$1 AND user_id=$2`,[templateId,req.user.id])).rows[0];
   if(!template){await client.query('ROLLBACK');transaction=false;return res.status(404).json({error:'Шаблон не знайдено.'});}
   const exercises=template.exercises.map(e=>{
    const parsed=parseExercise({...e,clientRequestId:randomUUID()});if(!parsed)throw new Error('Invalid stored snapshot');return parsed;
   });
   if(exercises.length<1||exercises.length>100)throw new Error('Invalid snapshot size');
   const workout=(await client.query(`INSERT INTO workouts(user_id,client_request_id,title,workout_date,notes,template_source_id)
    VALUES($1,$2::uuid,$3,$4::date,$5,$6) RETURNING ${WORKOUT_COLUMNS}`,[req.user.id,body.clientRequestId,body.title,body.date,body.notes,templateId])).rows[0];
   const inserted=(await client.query(`INSERT INTO workout_exercises(workout_id,client_request_id,name,notes,position)
    SELECT $1,(item->>'clientRequestId')::uuid,item->>'name',item->>'notes',ord::int FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY entries(item,ord)
    RETURNING id,position`,[workout.id,JSON.stringify(exercises)])).rows;
   const sets=inserted.flatMap(e=>exercises[e.position-1].sets.map((s,i)=>({exerciseId:e.id,position:i+1,...s})));
   await client.query(`INSERT INTO exercise_sets(exercise_id,position,reps,weight_kg)
    SELECT (s->>'exerciseId')::int,(s->>'position')::int,(s->>'reps')::int,(s->>'weightKg')::numeric FROM jsonb_array_elements($1::jsonb) s`,[JSON.stringify(sets)]);
   await client.query('COMMIT');transaction=false;return res.status(201).json({workout});
  }catch(error){if(client&&transaction)await client.query('ROLLBACK').catch(()=>{});return next(error);}finally{client?.release();}
 });
 router.delete('/:templateId',async(req,res,next)=>{
  if(!pathId(req.params.templateId))return res.status(400).json({error:'Некоректний номер шаблону.'});
  try{await pool.query('DELETE FROM workout_templates WHERE id=$1 AND user_id=$2',[Number(req.params.templateId),req.user.id]);return res.status(204).end();}catch(error){return next(error);}
 });
 return router;
};
