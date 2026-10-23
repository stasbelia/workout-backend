# Avatar storage

[Українська](#українська)

## Upload contract

All endpoints require `Authorization: Bearer <JWT>` over HTTPS.

1. Send `POST /api/avatar/upload` with `{"contentType":"image/jpeg","fileSize":1234}`. Accepted types are `image/jpeg` and `image/png`; size must be an integer from 1 to 5,242,880 bytes.
2. The response contains `upload.url`, `fields`, `key`, `expiresIn`, and `maxFileSize`. The signed form is valid for 300 seconds and permits only the exact pending key, MIME type, and byte range.
3. POST multipart form data to `upload.url`. Include every returned field unchanged and append the image as the final `file` field. Do not forward the application's JWT to S3 or set the multipart boundary manually.
4. After S3 accepts the upload, send `POST /api/avatar/complete` with `{"key":"avatars/pending/<userId>/<UUID>.jpg"}`. The server verifies ownership and content before updating the account.
5. Read the saved avatar with `GET /api/avatar`. The response is `{"avatar":null}` or `{"avatar":{"url":"...","expiresAt":"..."}}`. Completion returns the same avatar object. Read URLs expire after 15 minutes.

`fileSize` is an early check of the client's claim. S3 separately enforces the actual byte limit. MIME type alone does not establish that a file is a valid image.

## Validation and persistence

The server reads at most 5 MiB, verifies JPEG/PNG signatures, and decodes the image with `sharp`. Maximum dimensions are 4096 × 4096; multi-frame input is rejected. The result is a JPEG of at most 512 × 512 pixels without source EXIF/GPS metadata.

Verified images receive a new key under `avatars/verified/<userId>/`. The upload form cannot overwrite this object. Only the verified key and the last confirmed pending key are stored in PostgreSQL; signed URLs are generated on demand.

Completion locks the user's row within a transaction. Updating the avatar and enqueueing obsolete objects happen in the same commit. Retrying the last confirmed upload returns the saved avatar. A durable cleanup entry is created before writing a new verified object, so failed finalization can be recovered after a process restart.

## Migration and cleanup

Back up PostgreSQL before running `npm run migrate:avatar`. The repeatable migration adds `users.avatar_key`, `users.avatar_upload_key`, and `avatar_cleanup_jobs` to the existing schema.

The cleanup worker runs once per minute and processes up to 20 eligible jobs. It skips objects referenced by a current avatar and retries failed work. New verified objects remain eligible for failure recovery after a one-hour delay unless their transaction commits.

Uploads that never reach completion require an S3 Lifecycle rule. `s3-pending-lifecycle.json` expires objects under `avatars/pending/` after one day and aborts incomplete multipart uploads after one day. Apply it separately with an administrative identity; the application must not manage bucket lifecycle policies. Never scope this rule to `avatars/verified/`. Lifecycle deletion is asynchronous.

## Responses

| Status | Meaning |
| --- | --- |
| `400` | Invalid input, image, or object key |
| `401` | Missing/invalid session or deleted account |
| `413` | JSON request exceeds the body limit |
| `429` | Rate limit exceeded |
| `500` | Database check failed |
| `503` | Storage or finalization temporarily unavailable |

## Українська

### Завантаження

Усі маршрути потребують JWT у заголовку `Authorization: Bearer <JWT>` та HTTPS.

1. Надішліть `POST /api/avatar/upload` із `contentType` (`image/jpeg` або `image/png`) і цілим `fileSize` від 1 до 5 242 880 байтів.
2. Отримайте підписану форму: `upload.url`, `fields`, `key`, `expiresIn`, `maxFileSize`. Вона діє 300 секунд і обмежує точний pending-ключ, MIME та фактичний розмір.
3. Надішліть multipart POST до S3: усі отримані поля без змін, останнім — `file`. JWT застосунку до S3 не передається; boundary формує HTTP-клієнт.
4. Підтвердьте завантаження через `POST /api/avatar/complete` із полем `key`. Сервер перевірить належність файла та вміст перед записом у БД.
5. Отримайте поточний аватар через `GET /api/avatar`: `avatar: null` або об'єкт із `url` та `expiresAt`. Посилання діє 15 хвилин; підтвердження повертає такий самий об'єкт.

### Перевірка та збереження

Сервер контролює фактичні байти (до 5 МіБ), сигнатуру JPEG/PNG та декодування через `sharp`. Допустимий розмір — до 4096 × 4096; багатокадрові зображення відхиляються. Результат повторно кодується в JPEG до 512 × 512 без EXIF/GPS.

Перевірена копія отримує новий ключ `avatars/verified/<userId>/`. Початкова S3-форма не дозволяє його перезаписати. У PostgreSQL зберігаються ключ аватара та останній підтверджений pending-ключ; тимчасові URL створюються під час читання.

Підтвердження блокує рядок користувача в транзакції. Новий ключ і завдання прибирання попередніх файлів фіксуються одним комітом. Повтор останнього підтвердження повертає збережений аватар. До запису нової копії створюється надійне завдання прибирання для відновлення після збою процесу чи транзакції.

### Міграція та прибирання

Перед `npm run migrate:avatar` зробіть резервну копію БД. Повторювана міграція додає `users.avatar_key`, `users.avatar_upload_key` та `avatar_cleanup_jobs` до наявної схеми.

Раз на хвилину сервер обробляє до 20 доступних завдань. Файли поточних аватарів не видаляються; невдалі операції повторюються. Для нової перевіреної копії прибирання після збою відкладається на годину, а успішна транзакція скасовує це завдання.

Покинуті завантаження потребують окремого правила S3 Lifecycle. Приклад `s3-pending-lifecycle.json` задає видалення `avatars/pending/` і скасування незавершених multipart-завантажень через день. Правило застосовує адміністратор, не застосунок; його не можна поширювати на `avatars/verified/`. Видалення виконується асинхронно. Значення HTTP-статусів наведено в таблиці вище.
