const express = require('express');
const { rateLimit } = require('express-rate-limit');
const authMiddleware = require('./authMiddleware');
const { isDate } = require('./workoutInput');
const COLUMNS = 'id, email, nickname, created_at AS "createdAt"';
module.exports = function createProfileRouter({ pool }) {
  const router = express.Router();
  router.use(authMiddleware);
  router.use(rateLimit({ windowMs: 60_000, limit: 60, keyGenerator: req => String(req.user.id),
    standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Забагато запитів до профілю. Спробуйте через хвилину.' } }));
  router.use(express.json({ limit: '2kb' }));
  router.get('/', async (req, res, next) => {
    const { year, today } = req.query;
    if (Object.keys(req.query).some(k => !['year','today'].includes(k)) || typeof year !== 'string' || !/^\d{4}$/.test(year) ||
        Number(year)<1900 || Number(year)>2100 || !isDate(today)) return res.status(400).json({ error: 'Некоректний рік або дата календаря.' });
    try {
      const user = (await pool.query(`SELECT ${COLUMNS} FROM users WHERE id=$1`,[req.user.id])).rows[0];
      if (!user) return res.status(401).json({ error: 'Увійдіть повторно.' });
      // One SQL statement gives totals and daily counts the same MVCC snapshot,
      // even while another device is saving a workout.
      const stats = (await pool.query(`SELECT
        (SELECT count(*)::int FROM workouts WHERE user_id=$1 AND completed_at IS NOT NULL AND workout_date<=$2::date) AS total,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('date',d.date,'count',d.count) ORDER BY d.date)
          FROM (SELECT workout_date::text AS date,count(*)::int AS count FROM workouts
            WHERE user_id=$1 AND completed_at IS NOT NULL AND workout_date BETWEEN $3::date AND $4::date AND workout_date<=$2::date
            GROUP BY workout_date) d),'[]'::jsonb) AS days`,[req.user.id,today,`${year}-01-01`,`${year}-12-31`])).rows[0];
      return res.json({ user, activity: { year:Number(year), today, totalWorkouts:stats.total,
        yearWorkouts:stats.days.reduce((n,d)=>n+d.count,0), activeDays:stats.days.length, days:stats.days } });
    } catch (error) { return next(error); }
  });
  router.patch('/', async (req,res,next) => {
    const body=req.body;
    if(Object.keys(req.query).length || !body || Array.isArray(body) || typeof body!=='object' || Object.keys(body).length!==1 ||
       typeof body.nickname!=='string' || (body.nickname.trim()!=='' && (!/^[\p{L}\p{M}\p{N} ._-]+$/u.test(body.nickname.trim()) || Array.from(body.nickname.trim()).length<2 || body.nickname.trim().length>32))) {
      return res.status(400).json({error:'Нікнейм: 2–32 символи — літери, цифри, пробіли, крапка, дефіс або _. Порожнє поле прибирає нікнейм.'});
    }
    try {
      const result=await pool.query(`UPDATE users SET nickname=$2 WHERE id=$1 RETURNING ${COLUMNS}`,[req.user.id,body.nickname.trim()||null]);
      if(!result.rows.length)return res.status(401).json({error:'Увійдіть повторно.'});
      return res.json({user:result.rows[0]});
    } catch(error){return next(error);}
  });
  return router;
};
