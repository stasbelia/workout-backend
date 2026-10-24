require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const authMiddleware = require('./authMiddleware');
const createAvatarRouter = require('./avatarRoutes');
const { createAvatarStorage } = require('./avatarStorage');
const startAvatarCleanup = require('./avatarCleanup');
const createAuthRouter = require('./authRoutes');
const createWorkoutRouter = require('./workoutRoutes');
const createTemplateRouter = require('./templateRoutes');
const createProfileRouter = require('./profileRoutes');
const createWorkoutTemplateRouter = require('./workoutTemplateRoutes');

if (!process.env.JWT_SECRET || !process.env.JWT_SECRET.trim()) {
  throw new Error('JWT_SECRET не налаштований. Перевірте конфігурацію сервера.');
}

const app = express();
app.disable('x-powered-by');
// Перед Node працює локальний Nginx. Не довіряємо довільним проксі.
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(cors());
// Маршрут має власний обмежений JSON-парсер після перевірки авторизації.
const avatarStorage = createAvatarStorage();
app.use('/api/avatar', createAvatarRouter({ pool, storage: avatarStorage }));
app.use('/api/auth', createAuthRouter({ pool }));
app.use('/api/workouts', createWorkoutRouter({ pool }));
app.use('/api/exercise-templates', createTemplateRouter({ pool }));
app.use('/api/profile', createProfileRouter({ pool }));
app.use('/api/workout-templates', createWorkoutTemplateRouter({ pool }));

app.get('/', (req, res) => {
  res.send('Сервер Workout Tracker працює!');
});

// Дані поточного користувача доступні лише з чинним токеном.
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, created_at FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Користувача не знайдено. Увійдіть повторно.' });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    console.error('[СЕРВЕР] Не вдалося отримати користувача.');
    res.status(500).json({ error: 'Не вдалося отримати дані користувача.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Маршрут не знайдено.' }));
// Стандартна HTML-відповідь Express може розкрити стек помилки.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Завеликий запит.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректний JSON.' });
  if (error.status >= 400 && error.status < 500) return res.status(400).json({ error: 'Некоректний запит.' });
  console.error('[СЕРВЕР] Не вдалося обробити запит.');
  return res.status(500).json({ error: 'Внутрішня помилка сервера.' });
});

if (require.main === module) {
  startAvatarCleanup({ pool, storage: avatarStorage });
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, process.env.APP_BIND_HOST || '127.0.0.1', () => {
    console.log(`Сервер запущено. Слухаю порт ${PORT}...`);
  });
}

module.exports = app;
