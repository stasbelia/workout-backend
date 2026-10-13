require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Сервер Workout Tracker працює!');
});

// Реєстрація нового користувача
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Пошта та пароль обов\'язкові!' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, created_at',
      [email, hashedPassword]
    );

    const newUser = result.rows[0];
    console.log(`[СЕРВЕР] Новий користувач: ID ${newUser.id}, Email: ${newUser.email}`);

    res.status(201).json({
      message: 'Користувача успішно створено!',
      user: {
        id: newUser.id,
        email: newUser.email,
        createdAt: newUser.created_at,
      },
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Користувач з такою поштою вже існує!' });
    }
    console.error('[СЕРВЕР] Помилка реєстрації:', error);
    res.status(500).json({ error: 'Помилка сервера під час збереження' });
  }
});

// Вхід (Логін)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Вкажіть пошту та пароль!' });
  }

  try {
    const userQuery = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userQuery.rows.length === 0) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    const user = userQuery.rows[0];

    // Перевірка відповідності хешу пароля
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }

    // Створення JWT токена на 30 днів
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    console.log(`[СЕРВЕР] Успішний вхід: ID ${user.id}, Email: ${user.email}`);

    res.json({
      message: 'Успішний вхід!',
      token,
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error) {
    console.error('[СЕРВЕР] Помилка входу:', error);
    res.status(500).json({ error: 'Помилка сервера під час авторизації' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущено. Слухаю порт ${PORT}...`);
});
