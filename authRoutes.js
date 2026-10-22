const express = require('express');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function createAuthRouter({ pool }) {
  const router = express.Router();
  const limiter = (windowMs, limit) => rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Забагато спроб. Спробуйте пізніше.' },
  });
  const parse = express.json({ limit: '2kb' });
  // Для невідомої пошти теж виконуємо bcrypt. Це вигаданий тестовий пароль.
  const dummyHash = bcrypt.hashSync('not-a-real-account-password', 10);

  function credentials(req, res, next) {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some((key) => !['email', 'password'].includes(key)) ||
        typeof body.email !== 'string' || body.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ||
        typeof body.password !== 'string' || !body.password.length ||
        Buffer.byteLength(body.password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Вкажіть коректну пошту й пароль до 72 байтів.' });
    }
    next();
  }

  router.post('/register', limiter(60 * 60_000, 5), parse, credentials, async (req, res) => {
    const { email, password } = req.body;
    if (password.length < 8) return res.status(400).json({ error: 'Пароль має містити щонайменше 8 символів.' });
    try {
      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, created_at', [email, hash]
      );
      const user = result.rows[0];
      return res.status(201).json({
        message: 'Користувача успішно створено!',
        user: { id: user.id, email: user.email, createdAt: user.created_at },
      });
    } catch (error) {
      if (error.code === '23505') return res.status(400).json({ error: 'Користувач з такою поштою вже існує!' });
      console.error('[СЕРВЕР] Помилка реєстрації.');
      return res.status(500).json({ error: 'Помилка сервера під час збереження' });
    }
  });

  router.post('/login', limiter(15 * 60_000, 20), parse, credentials, async (req, res) => {
    const { email, password } = req.body;
    try {
      const result = await pool.query('SELECT id, email, password FROM users WHERE email = $1', [email]);
      const user = result.rows[0];
      const matches = await bcrypt.compare(password, user?.password || dummyHash);
      if (!user || !matches) return res.status(401).json({ error: 'Невірний email або пароль' });
      const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, {
        algorithm: 'HS256', expiresIn: '30d',
      });
      return res.json({ message: 'Успішний вхід!', token, user: { id: user.id, email: user.email } });
    } catch {
      console.error('[СЕРВЕР] Помилка входу.');
      return res.status(500).json({ error: 'Помилка сервера під час авторизації' });
    }
  });
  return router;
}
module.exports = createAuthRouter;
