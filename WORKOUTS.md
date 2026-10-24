# Workouts

Authenticated users can create workouts and list their own records. [Exercises and sets](EXERCISES.md) extend individual workouts; editing and deletion remain outside this version.

## Database

Back up PostgreSQL, then run `npm run migrate:workouts`. Migration `003-workouts.sql` adds a `workouts` table and an index; it does not modify account or avatar fields. It requires the existing integer `users.id`. Re-running the migration preserves existing workouts.

## API

`POST /api/workouts` accepts a JSON object with:

- `title`: trimmed non-empty string, at most 100 UTF-16 code units; no control characters.
- `date`: real calendar date in `YYYY-MM-DD`, from 1900 through 2100. Stored as PostgreSQL `date`, without a time zone.
- `notes`: optional string, trimmed, at most 500 UTF-16 code units; line feeds and tabs allowed.
- `clientRequestId`: lowercase UUID v4, reused when retrying the same submission.

The server takes `user_id` exclusively from the verified JWT. Unknown body fields are rejected. A new record returns `201` and `{ workout: { id, title, date, notes, createdAt } }`.

The unique `(user_id, client_request_id)` constraint prevents duplicate rows when a response is lost. An identical retry returns `200` with the original record. Reusing the key with different data returns `409`. The mobile form retains the key and locks edits after an uncertain result; the user can retry or check the list. This retry state is held for that open form, not persisted across application restarts.

`GET /api/workouts` returns `{ workouts, nextCursor }`: up to 20 records ordered by workout date descending, then ID descending. Pass `?cursor=<nextCursor>` to load the next page; null means the end. Both queries always filter by JWT owner. Newer records appear after refreshing the first page.

Both routes require Bearer authentication and share a limit of 60 requests per minute per user. JSON is limited to 4 KiB. Missing/deleted accounts return `401`; validation errors return `400`; unexpected failures use the server's generic error handler. Titles and notes are not logged. The rate limiter is in memory and resets with the process.

## Verification

`npm test` covers storage, user isolation, field/date validation, parameterized SQL, response-loss retries, concurrent repeats, pagination, deleted accounts, body size, error responses and rate limiting using PGlite. No live AWS or database credentials are required.

## Українська

Користувач може створити тренування з назвою, календарною датою та необов’язковою нотаткою й отримати свій список. Власник визначається лише з перевіреного JWT. [Вправи, підходи та вага](EXERCISES.md) доповнюють окремі тренування; редагування та видалення ще не реалізовані.

Перед `npm run migrate:workouts` потрібна резервна копія PostgreSQL. Міграція додає окрему таблицю та індекс; поля користувачів і аватарів не змінюються. Повторний запуск зберігає вже створені тренування.

Дата зберігається без часового поясу. Ліміти полів: назва — 100, нотатка — 500 одиниць UTF-16; emoji можуть займати дві одиниці. Телефон показує дату як `ДД.ММ.РРРР`, API приймає `YYYY-MM-DD`.

Повтор того самого запиту з тим самим UUID повертає збережений запис. Інший вміст із цим UUID відхиляється з `409`. Після непідтвердженого збереження форма зберігає текст і ключ для повтору та блокує редагування; можна повторити або перевірити список. Цей стан діє лише в поточній відкритій формі та не зберігається після перезапуску застосунку.

Список завантажується сторінками по 20 записів, спочатку новіші дати, потім більші ID. Для наступної сторінки використовується `nextCursor`; для оновлення — знову перша сторінка. Ліміт — 60 запитів за хвилину на користувача, JSON до 4 КіБ. Ліміт у пам’яті скидається після перезапуску сервера.

Тести використовують PostgreSQL у пам’яті та вигадані облікові дані. Перевіряються збереження, відокремлення користувачів, дати, повтори, сторінки, помилки та обмеження запитів.
