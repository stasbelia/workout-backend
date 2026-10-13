require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Сервер Workout Tracker працює!');
});

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Пошта та пароль обов\'язкові!' });
  }

  try {
    // Хешуємо пароль перед збереженням
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, created_at',
      [email, hashedPassword]
    );

    const newUser = result.rows[0];
    console.log(`[СЕРВЕР] Користувач збережений з хешем. ID: ${newUser.id}, Email: ${newUser.email}`);

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
      console.warn(`[СЕРВЕР] Спроба повторної реєстрації пошти: ${email}`);
      return res.status(400).json({ error: 'Користувач з такою поштою вже існує!' });
    }

    console.error('[СЕРВЕР] Помилка бази даних:', error);
    res.status(500).json({ error: 'Помилка сервера під час збереження даних' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущено. Слухаю порт ${PORT}...`);
});
