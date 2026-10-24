const { parseBody: parseWorkout, isDate } = require('./workoutInput');
const { parseBody: parseExercise } = require('./exerciseInput');
const validId = id => typeof id === 'string' && /^[1-9]\d{0,9}$/.test(id) && Number(id) <= 2147483647;
const revision = n => Number.isInteger(n) && n >= 0 && n <= 2147483646;
const object = body => body && typeof body === 'object' && !Array.isArray(body);
const UUID = '00000000-0000-4000-8000-000000000001';
const conflict = { error: 'Запис уже змінився. Перечитайте його перед редагуванням або видаленням.' };
const sameSets = (a, b) => JSON.stringify(a.map(s => ({ reps: s.reps, weightKg: s.weightKg }))) === JSON.stringify(b);

// Mounted after JWT, the workout limit, JSON parsing and account checks.
module.exports = function installWorkoutEditing(router, { pool, WORKOUT_COLUMNS, EXERCISE_COLUMNS, SET_COLUMNS }) {
  function handler(kind, remove) {
    return async (req, res, next) => {
      const body = req.body;
      const allowed = remove ? ['expectedRevision'] : kind === 'workout' ? ['expectedRevision', 'title', 'date', 'notes', 'today'] : ['expectedRevision', 'name', 'notes', 'sets'];
      if (Object.keys(req.query).length || !object(body) || !revision(body.expectedRevision) ||
          Object.keys(body).some(k => !allowed.includes(k)) || (remove && Object.keys(body).length !== 1) ||
          (kind === 'exercise' && !validId(req.params.exerciseId))) return res.status(400).json({ error: 'Некоректний запит редагування.' });
      let draft;
      if (!remove) {
        const { expectedRevision, today, ...fields } = body;
        draft = kind === 'workout' ? parseWorkout({ ...fields, clientRequestId: UUID }) : parseExercise({ ...fields, clientRequestId: UUID });
        if (!draft || (kind === 'workout' && !isDate(today))) return res.status(400).json({ error: 'Перевірте назву, дату, нотатку та підходи.' });
      }
      let client, transaction = false;
      try {
        client = await pool.connect(); await client.query('BEGIN'); transaction = true;
        const workout = (await client.query(`SELECT ${WORKOUT_COLUMNS} FROM workouts WHERE id=$1 AND user_id=$2 FOR UPDATE`, [Number(req.params.workoutId), req.user.id])).rows[0];
        if (!workout) {
          await client.query('ROLLBACK'); transaction = false;
          return remove ? res.status(204).end() : res.status(404).json({ error: 'Тренування не знайдено.' });
        }
        let target = workout;
        if (kind === 'exercise') {
          target = (await client.query(`SELECT ${EXERCISE_COLUMNS} FROM workout_exercises WHERE id=$1 AND workout_id=$2 FOR UPDATE`, [Number(req.params.exerciseId), workout.id])).rows[0];
          if (!target) {
            await client.query('ROLLBACK'); transaction = false;
            return remove ? res.status(204).end() : res.status(404).json({ error: 'Вправу не знайдено.' });
          }
        }
        // An exact desired value is already saved: a lost reply can be retried
        // without replacing sets or advancing revisions a second time.
        let sets = [];
        if (!remove && kind === 'exercise') sets = (await client.query(`SELECT ${SET_COLUMNS} FROM exercise_sets WHERE exercise_id=$1 ORDER BY position`, [target.id])).rows;
        const identical = !remove && (kind === 'workout'
          ? target.title === draft.title && target.date === draft.date && target.notes === draft.notes
          : target.name === draft.name && target.notes === draft.notes && sameSets(sets, draft.sets));
        if (identical) {
          await client.query('COMMIT'); transaction = false;
          return res.json(kind === 'workout' ? { workout: target } : { exercise: { ...target, sets } });
        }
        if (target.revision !== body.expectedRevision) {
          await client.query('ROLLBACK'); transaction = false; return res.status(409).json(conflict);
        }
        if (remove) {
          if (kind === 'workout') {
            await client.query('DELETE FROM workouts WHERE id=$1 AND user_id=$2', [workout.id, req.user.id]);
          } else {
            await client.query('DELETE FROM workout_exercises WHERE id=$1 AND workout_id=$2', [target.id, workout.id]);
            // Move each survivor into the preceding free slot in ascending
            // order, avoiding unique-position collisions and the 100-slot cap.
            const remaining = (await client.query('SELECT id,position FROM workout_exercises WHERE workout_id=$1 ORDER BY position', [workout.id])).rows;
            for (const [index, exercise] of remaining.entries()) {
              if (exercise.position !== index + 1) await client.query('UPDATE workout_exercises SET position=$2,revision=revision+1 WHERE id=$1', [exercise.id,index+1]);
            }
            const hasSets = (await client.query('SELECT 1 FROM workout_exercises e JOIN exercise_sets s ON s.exercise_id=e.id WHERE e.workout_id=$1 LIMIT 1', [workout.id])).rows.length > 0;
            await client.query('UPDATE workouts SET revision=revision+1,completed_at=CASE WHEN $2::boolean THEN completed_at ELSE NULL END WHERE id=$1', [workout.id, hasSets]);
          }
          await client.query('COMMIT'); transaction = false; return res.status(204).end();
        }
        if (kind === 'workout') {
          if (workout.completedAt && draft.date > body.today) {
            await client.query('ROLLBACK'); transaction = false;
            return res.status(409).json({ error: 'Спочатку скасуйте завершення, щоб перенести тренування на майбутню дату.' });
          }
          const saved = (await client.query(`UPDATE workouts SET title=$3,workout_date=$4::date,notes=$5,revision=revision+1 WHERE id=$1 AND user_id=$2 RETURNING ${WORKOUT_COLUMNS}`, [workout.id, req.user.id, draft.title, draft.date, draft.notes])).rows[0];
          await client.query('COMMIT'); transaction = false; return res.json({ workout: saved });
        }
        const saved = (await client.query(`UPDATE workout_exercises SET name=$3,notes=$4,revision=revision+1 WHERE id=$1 AND workout_id=$2 RETURNING ${EXERCISE_COLUMNS}`, [target.id, workout.id, draft.name, draft.notes])).rows[0];
        await client.query('DELETE FROM exercise_sets WHERE exercise_id=$1', [target.id]);
        const updatedSets = (await client.query(`INSERT INTO exercise_sets(exercise_id,position,reps,weight_kg)
          SELECT $1,ord::int,(item->>'reps')::int,(item->>'weightKg')::numeric FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY entries(item,ord)
          RETURNING ${SET_COLUMNS}`, [target.id, JSON.stringify(draft.sets)])).rows.sort((a,b) => a.position-b.position);
        await client.query('UPDATE workouts SET revision=revision+1 WHERE id=$1', [workout.id]);
        await client.query('COMMIT'); transaction = false; return res.json({ exercise: { ...saved, sets: updatedSets } });
      } catch (error) {
        if (client && transaction) await client.query('ROLLBACK').catch(() => {});
        return next(error);
      } finally { client?.release(); }
    };
  }
  router.patch('/', handler('workout', false));
  router.delete('/', handler('workout', true));
  router.patch('/exercises/:exerciseId', handler('exercise', false));
  router.delete('/exercises/:exerciseId', handler('exercise', true));
};
