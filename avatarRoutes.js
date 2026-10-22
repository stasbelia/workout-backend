const express = require('express');
const { rateLimit } = require('express-rate-limit');
const authMiddleware = require('./authMiddleware');
const { MAX_AVATAR_BYTES, IMAGE_EXTENSIONS } = require('./avatarStorage');
const createAvatarService = require('./avatarService');
const AvatarError = require('./avatarErrors');

function createAvatarRouter({ pool, storage }) {
  const router = express.Router();
  const service = createAvatarService({ pool, storage });
  const createLimiter = () => rateLimit({
    windowMs: 60_000,
    limit: 5,
    // Middleware авторизації виконується раніше; IP та userId з тіла не потрібні.
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Забагато спроб завантаження. Спробуйте через хвилину.' },
  });

  router.get('/', authMiddleware, async (req, res, next) => {
    try {
      res.json({ avatar: await service.get(req.user.id) });
    } catch (error) { next(error); }
  });

  router.post('/complete', authMiddleware, createLimiter(), express.json({ limit: '2kb' }), async (req, res, next) => {
    if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.key !== 'string') {
      return res.status(400).json({ error: 'Вкажіть ключ завантаженого фото.' });
    }
    try {
      res.json({ avatar: await service.complete(req.user.id, req.body.key) });
    } catch (error) { next(error); }
  });

  router.post('/upload', authMiddleware, createLimiter(), express.json({ limit: '2kb' }), async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some((key) => !['contentType', 'fileSize'].includes(key)) ||
        !IMAGE_EXTENSIONS.has(body.contentType) ||
        !Number.isSafeInteger(body.fileSize) || body.fileSize < 1 || body.fileSize > MAX_AVATAR_BYTES) {
      return res.status(400).json({ error: 'Потрібне фото JPEG або PNG розміром від 1 байта до 5 МіБ.' });
    }

    // Чинний JWT не гарантує, що обліковий запис досі існує.
    let result;
    try {
      result = await pool.query('SELECT id FROM users WHERE id = $1', [req.user.id]);
    } catch {
      return res.status(500).json({ error: 'Не вдалося перевірити користувача.' });
    }
    if (!result.rows[0]) {
      return res.status(401).json({ error: 'Користувача не знайдено. Увійдіть повторно.' });
    }

    try {
      const upload = await storage.createUpload({ userId: req.user.id, contentType: body.contentType });
      return res.json({ upload });
    } catch {
      // Не віддаємо клієнту й не записуємо в журнал дані AWS або підписану форму.
      return res.status(503).json({ error: 'Завантаження фото тимчасово недоступне. Спробуйте пізніше.' });
    }
  });

  router.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Завеликий запит. Надсилайте лише параметри фото.' });
    }
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Некоректний JSON.' });
    }
    if (error instanceof AvatarError) return res.status(error.status).json({ error: error.message });
    return res.status(503).json({ error: 'Не вдалося зберегти або отримати аватар. Спробуйте пізніше.' });
  });

  return router;
}

module.exports = createAvatarRouter;
