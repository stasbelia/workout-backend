# Workout Tracker API

Node.js API for accounts, JWT authentication, workouts, and private avatar storage in Amazon S3.

[Українська](#українська)

## Requirements

- Node.js 24 or later.
- PostgreSQL with the existing `users` table: `id`, unique `email`, `password` (bcrypt hash), and `created_at`.
- A private S3 bucket and a named AWS credentials profile available to the service user.

## Configuration

Create a private `.env` using `.env.example` as a reference. Set the PostgreSQL connection, `JWT_SECRET`, `AWS_PROFILE`, `AWS_REGION`, and `S3_AVATAR_BUCKET`.

Use a randomly generated JWT secret of at least 32 bytes. Store AWS credentials outside the repository. Grant the service only `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` for the bucket's `avatars/*` prefix.

## Run

```sh
npm ci
npm test
```

Back up the database before applying the additive migrations, in order:

```sh
npm run migrate:avatar
npm run migrate:workouts
npm run migrate:exercises
npm run migrate:templates
npm run migrate:profile
npm run migrate:completion
npm run migrate:editing
npm start
```

The migrations extend the existing account schema and add workout, exercise, template and revision tables or columns. They do not create the initial `users` table.

The server listens on `127.0.0.1:3000` by default. Expose it through an HTTPS reverse proxy. Express trusts loopback proxies only; the proxy must overwrite `X-Forwarded-For` or append the actual client address. `APP_BIND_HOST` and `PORT` override the listener settings.

## API

| Method | Endpoint | Authentication | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | None | Create an account |
| POST | `/api/auth/login` | None | Issue a JWT |
| GET | `/api/auth/me` | Bearer JWT | Read the current account |
| POST | `/api/avatar/upload` | Bearer JWT | Issue a scoped S3 upload form |
| POST | `/api/avatar/complete` | Bearer JWT | Validate and save an uploaded avatar |
| GET | `/api/avatar` | Bearer JWT | Read the current avatar's temporary URL |
| POST | `/api/workouts` | Bearer JWT | Save a workout for the current account |
| GET | `/api/workouts` | Bearer JWT | List the current account's workouts |
| GET | `/api/workouts/:workoutId` | Bearer JWT | Read a workout with exercises and sets |
| PATCH/DELETE | `/api/workouts/:workoutId` | Bearer JWT | Edit or delete an owned workout with its expected revision |
| PATCH/DELETE | `/api/workouts/:workoutId/exercises/:exerciseId` | Bearer JWT | Edit or delete an owned exercise and sets |
| PATCH | `/api/workouts/:workoutId/completion` | Bearer JWT | Complete or reopen an owned workout |
| POST | `/api/workouts/:workoutId/exercises` | Bearer JWT | Save an exercise and all its sets |
| GET/POST | `/api/exercise-templates` | Bearer JWT | List or save reusable exercise templates |
| DELETE | `/api/exercise-templates/:templateId` | Bearer JWT | Delete an owned template without changing workouts |
| GET/PATCH | `/api/profile` | Bearer JWT | Account details, nickname and activity calendar |
| GET/POST | `/api/workout-templates` | Bearer JWT | List or save whole-workout templates |
| GET/DELETE | `/api/workout-templates/:templateId` | Bearer JWT | Read or delete an owned workout template |
| POST | `/api/workout-templates/:templateId/workouts` | Bearer JWT | Create a full independent workout from a template |

The current suite contains 154 tests covering authentication, image validation, account isolation, workouts, exercises and sets, templates, completion, transactions, safe retries and revision conflicts. Tests use mock storage, synthetic credentials, and an in-memory PostgreSQL engine (PGlite). They do not require a live database or AWS account.

See [avatar storage](AVATAR_UPLOAD.md) for the upload contract and migration details, and [security](SECURITY.md) for deployment requirements and limitations.

The [workout API](WORKOUTS.md) describes dates, pagination, validation and safe submission retries.

See [exercises and sets](EXERCISES.md) for repetition/weight validation and atomic submission.

See [exercise templates](EXERCISE_TEMPLATES.md) for reusable defaults and retry semantics.

## Українська

API на Node.js для реєстрації, авторизації через JWT, збереження тренувань та приватних аватарів в Amazon S3.

### Вимоги та налаштування

Потрібні Node.js 24+, PostgreSQL із наявною таблицею `users` (`id`, унікальна `email`, bcrypt-хеш у `password`, `created_at`) та приватний S3 bucket.

Створіть приватний `.env` за прикладом `.env.example`: налаштуйте з'єднання з PostgreSQL, `JWT_SECRET`, `AWS_PROFILE`, `AWS_REGION` і `S3_AVATAR_BUCKET`. Секрет JWT має бути випадковим, довжиною щонайменше 32 байти.

Ключі AWS зберігайте поза репозиторієм у профілі, доступному користувачу сервісу. Дозволи IAM обмежте операціями `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` для `avatars/*` потрібного bucket.

### Запуск і тести

```sh
npm ci
npm test
```

Після резервної копії БД послідовно застосуйте міграції та запустіть сервер:

```sh
npm run migrate:avatar
npm run migrate:workouts
npm run migrate:exercises
npm run migrate:templates
npm run migrate:profile
npm run migrate:completion
npm run migrate:editing
npm start
```

Міграції доповнюють наявну схему акаунтів і додають таблиці або поля тренувань, вправ, шаблонів і версій записів. Початкову таблицю `users` потрібно створити окремо. 154 тести охоплюють авторизацію, перевірку фото, розділення доступу між акаунтами, тренування, вправи й підходи, шаблони, завершення, транзакції, повторні запити та конфлікти версій. Використовуються підставне сховище, вигадані ключі та PostgreSQL у пам'яті (PGlite); робочі AWS і БД не потрібні.

За замовчуванням сервер слухає `127.0.0.1:3000`. Зовнішній доступ налаштовується через HTTPS-проксі. Express довіряє лише локальному проксі, який має перезаписувати `X-Forwarded-For` або додавати справжню адресу клієнта. Параметри прослуховування змінюються через `APP_BIND_HOST` і `PORT`.

Маршрути наведено в таблиці API вище. Контракт завантаження описано в [AVATAR_UPLOAD.md](AVATAR_UPLOAD.md), вимоги й обмеження захисту — у [SECURITY.md](SECURITY.md).

Формат дат, сторінки списку та захист від повторного створення описані в [WORKOUTS.md](WORKOUTS.md).

Вправи, повторення, вага та збереження підходів однією транзакцією описані в [EXERCISES.md](EXERCISES.md).

Власні шаблони вправ: [EXERCISE_TEMPLATES.md](EXERCISE_TEMPLATES.md).

Profile, activity calendar and whole-workout templates: [PROFILE_PLANS.md](PROFILE_PLANS.md).

Профіль, календар і шаблони цілого тренування: [PROFILE_PLANS.md](PROFILE_PLANS.md).

Workout completion and completed-only statistics / Завершення тренувань і статистика: [WORKOUT_COMPLETION.md](WORKOUT_COMPLETION.md).

Editing, deletion and revision conflicts / Редагування, видалення та конфлікти версій: [WORKOUT_EDITING.md](WORKOUT_EDITING.md).
