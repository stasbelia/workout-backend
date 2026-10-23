# Workout Tracker API

Node.js API for account registration, JWT authentication, and private avatar storage in Amazon S3.

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

Back up the database before applying the additive avatar migration:

```sh
npm run migrate:avatar
npm start
```

The migration extends the existing `users` table; it does not create the initial account schema.

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

Tests use mock storage, synthetic credentials, and an in-memory PostgreSQL engine (PGlite). They do not require a live database or AWS account.

See [avatar storage](AVATAR_UPLOAD.md) for the upload contract and migration details, and [security](SECURITY.md) for deployment requirements and limitations.

## Українська

API на Node.js для реєстрації, авторизації через JWT та зберігання приватних аватарів в Amazon S3.

### Вимоги та налаштування

Потрібні Node.js 24+, PostgreSQL із наявною таблицею `users` (`id`, унікальна `email`, bcrypt-хеш у `password`, `created_at`) та приватний S3 bucket.

Створіть приватний `.env` за прикладом `.env.example`: налаштуйте з'єднання з PostgreSQL, `JWT_SECRET`, `AWS_PROFILE`, `AWS_REGION` і `S3_AVATAR_BUCKET`. Секрет JWT має бути випадковим, довжиною щонайменше 32 байти.

Ключі AWS зберігайте поза репозиторієм у профілі, доступному користувачу сервісу. Дозволи IAM обмежте операціями `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` для `avatars/*` потрібного bucket.

### Запуск і тести

```sh
npm ci
npm test
```

Після резервної копії БД застосуйте міграцію та запустіть сервер:

```sh
npm run migrate:avatar
npm start
```

Міграція доповнює наявну таблицю `users`, але не створює початкову схему облікових записів. Тести використовують підставне сховище, вигадані ключі та PostgreSQL у пам'яті (PGlite); робочі AWS і БД не потрібні.

За замовчуванням сервер слухає `127.0.0.1:3000`. Зовнішній доступ налаштовується через HTTPS-проксі. Express довіряє лише локальному проксі, який має перезаписувати `X-Forwarded-For` або додавати справжню адресу клієнта. Параметри прослуховування змінюються через `APP_BIND_HOST` і `PORT`.

Маршрути наведено в таблиці API вище. Контракт завантаження описано в [AVATAR_UPLOAD.md](AVATAR_UPLOAD.md), вимоги й обмеження захисту — у [SECURITY.md](SECURITY.md).
