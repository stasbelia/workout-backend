const express = require('express');
const { rateLimit } = require('express-rate-limit');
const authMiddleware = require('./authMiddleware');
const createExerciseRouter = require('./exerciseRoutes');

const PAGE_SIZE = 20;
const { parseBody } = require('./workoutInput');
const { isDate } = require('./workoutInput');
const COLUMNS = 'id, title, workout_date::text AS date, notes, created_at AS "createdAt", completed_at AS "completedAt", revision';

module.exports = function createWorkoutRouter({ pool }) {
  const router = express.Router();
  router.use(authMiddleware);
  router.use(rateLimit({
    windowMs: 60_000, limit: 60, keyGenerator: (req) => String(req.user.id),
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Забагато запитів до тренувань. Спробуйте через хвилину.' },
  }));
  router.use(express.json({ limit: '4kb' }));

  router.get('/', async (req, res, next) => {
    const cursor = req.query.cursor;
    if (Object.keys(req.query).some((key) => key !== 'cursor') ||
        (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{4}-\d{2}-\d{2}:[1-9]\d{0,9}$/.test(cursor)))) {
      return res.status(400).json({ error: 'Некоректна сторінка списку.' });
    }
    const [date, id] = cursor ? cursor.split(':') : [];
    if (cursor && (!isDate(date) || Number(id) > 2147483647)) {
      return res.status(400).json({ error: 'Некоректна сторінка списку.' });
    }
    try {
      const user = await pool.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
      if (!user.rows.length) return res.status(401).json({ error: 'Увійдіть повторно.' });
      const result = await pool.query(
        `SELECT ${COLUMNS} FROM workouts WHERE user_id = $1 ${cursor ? 'AND (workout_date, id) < ($2::date, $3::integer)' : ''}
         ORDER BY workout_date DESC, id DESC LIMIT ${PAGE_SIZE + 1}`,
        cursor ? [req.user.id, date, Number(id)] : [req.user.id]
      );
      const workouts = result.rows.slice(0, PAGE_SIZE);
      const last = workouts.at(-1);
      return res.json({ workouts, nextCursor: result.rows.length > PAGE_SIZE ? `${last.date}:${last.id}` : null });
    } catch (error) { return next(error); }
  });

  router.post('/', async (req, res, next) => {
    const body = parseBody(req.body);
    if (!body) return res.status(400).json({ error: 'Перевірте назву (до 100 символів), дату та нотатку (до 500 символів).' });
    try {
      const inserted = await pool.query(
        `INSERT INTO workouts(user_id, client_request_id, title, workout_date, notes)
         SELECT id, $2::uuid, $3, $4::date, $5 FROM users WHERE id = $1
         ON CONFLICT (user_id, client_request_id) DO NOTHING RETURNING ${COLUMNS}`,
        [req.user.id, body.clientRequestId, body.title, body.date, body.notes]
      );
      if (inserted.rows.length) return res.status(201).json({ workout: inserted.rows[0] });
      // Повтор після втрати відповіді повертає вже збережене тренування.
      const existing = await pool.query(
        `SELECT ${COLUMNS} FROM workouts WHERE user_id = $1 AND client_request_id = $2::uuid`,
        [req.user.id, body.clientRequestId]
      );
      const workout = existing.rows[0];
      if (!workout) return res.status(401).json({ error: 'Увійдіть повторно.' });
      if (workout.title !== body.title || workout.date !== body.date || workout.notes !== body.notes) {
        return res.status(409).json({ error: 'Цей запит уже зберіг інше тренування. Оновіть список перед наступним збереженням.' });
      }
      return res.json({ workout });
    } catch (error) {
      if (error.code === '23503') return res.status(401).json({ error: 'Увійдіть повторно.' });
      return next(error);
    }
  });
  router.use('/:workoutId', createExerciseRouter({ pool }));
  return router;
};
