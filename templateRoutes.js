const express = require('express');
const { rateLimit } = require('express-rate-limit');
const authMiddleware = require('./authMiddleware');
const { parseBody } = require('./exerciseInput');
const COLUMNS = 'id, name, notes, sets, created_at AS "createdAt"';
const same = (row, body) => row.notes === body.notes && row.sets.length === body.sets.length &&
  row.sets.every((set, index) => set.reps === body.sets[index].reps && set.weightKg === body.sets[index].weightKg);

module.exports = function createTemplateRouter({ pool }) {
  const router = express.Router();
  router.use(authMiddleware);
  router.use(rateLimit({ windowMs: 60_000, limit: 60, keyGenerator: (req) => String(req.user.id),
    standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Забагато запитів до шаблонів. Спробуйте через хвилину.' } }));
  router.use(express.json({ limit: '4kb' }));
  router.use(async (req, res, next) => {
    if (Object.keys(req.query).length) return res.status(400).json({ error: 'Некоректний запит шаблонів.' });
    try {
      const user = await pool.query('SELECT id FROM users WHERE id=$1', [req.user.id]);
      if (!user.rows.length) return res.status(401).json({ error: 'Увійдіть повторно.' });
      return next();
    } catch (error) { return next(error); }
  });
  router.get('/', async (req, res, next) => {
    try {
      const result = await pool.query(`SELECT ${COLUMNS} FROM exercise_templates WHERE user_id=$1 ORDER BY id DESC LIMIT 100`, [req.user.id]);
      return res.json({ templates: result.rows });
    } catch (error) { return next(error); }
  });
  router.post('/', async (req, res, next) => {
    const body = parseBody(req.body);
    if (!body) return res.status(400).json({ error: 'Перевірте назву, нотатку та підходи шаблону.' });
    let client, transaction = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN'); transaction = true;
      // Serialize saves for one owner: retries, name uniqueness and the quota
      // must also hold when requests arrive on different DB connections.
      const user = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
      if (!user.rows.length) {
        await client.query('ROLLBACK'); transaction = false;
        return res.status(401).json({ error: 'Увійдіть повторно.' });
      }
      const byRequest = await client.query(`SELECT ${COLUMNS} FROM exercise_templates WHERE user_id=$1 AND client_request_id=$2::uuid`, [req.user.id, body.clientRequestId]);
      const existing = byRequest.rows[0] ?? (await client.query(`SELECT ${COLUMNS} FROM exercise_templates WHERE user_id=$1 AND lower(name)=lower($2)`, [req.user.id, body.name])).rows[0];
      if (existing) {
        await client.query('COMMIT'); transaction = false;
        if (existing.name.toLowerCase() !== body.name.toLowerCase() || !same(existing, body)) {
          return res.status(409).json({ error: 'Шаблон із такою назвою вже є з іншими даними. Вкажіть іншу назву або видаліть старий у «Моїх шаблонах».' });
        }
        return res.json({ template: existing });
      }
      const count = await client.query('SELECT count(*)::int AS n FROM exercise_templates WHERE user_id=$1', [req.user.id]);
      if (count.rows[0].n >= 100) {
        await client.query('ROLLBACK'); transaction = false;
        return res.status(409).json({ error: 'У вас уже є 100 шаблонів. Видаліть непотрібний у «Моїх шаблонах».' });
      }
      const result = await client.query(`INSERT INTO exercise_templates(user_id,client_request_id,name,notes,sets)
        VALUES($1,$2::uuid,$3,$4,$5::jsonb) RETURNING ${COLUMNS}`, [req.user.id, body.clientRequestId, body.name, body.notes, JSON.stringify(body.sets)]);
      await client.query('COMMIT'); transaction = false;
      return res.status(201).json({ template: result.rows[0] });
    } catch (error) {
      if (client && transaction) await client.query('ROLLBACK').catch(() => {});
      return next(error);
    } finally { client?.release(); }
  });
  router.delete('/:templateId', async (req, res, next) => {
    const id = req.params.templateId;
    if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647) return res.status(400).json({ error: 'Некоректний номер шаблону.' });
    try {
      // Idempotent, and deliberately identical for absent and foreign IDs.
      await pool.query('DELETE FROM exercise_templates WHERE id=$1 AND user_id=$2', [Number(id), req.user.id]);
      return res.status(204).end();
    } catch (error) { return next(error); }
  });
  return router;
};
