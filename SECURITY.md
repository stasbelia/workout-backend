# Security

[Українська](#українська)

## Deployment requirements

- Terminate TLS at a trusted reverse proxy. Keep the Node listener private; only loopback proxies are trusted by default.
- Store database credentials, `JWT_SECRET`, and AWS credentials outside version control. Use a random JWT secret of at least 32 bytes.
- Keep the S3 bucket private with public access blocked and ACLs disabled. Restrict the application's IAM permissions to avatar objects.
- Do not log authorization headers, passwords, signed upload forms, or signed download URLs. Rotate exposed credentials; removing a file from Git does not revoke them.

## Implemented controls

- HS256 JWT verification, expiry checks, and positive integer user IDs. SQL queries use bound parameters.
- Login: 20 requests per IP per 15 minutes. Registration: 5 requests per IP per hour. Avatar upload and completion: separate limits of 5 requests per user per minute.
- Authentication and avatar JSON bodies are limited to 2 KiB. Credential fields are type-checked; bcrypt passwords are limited to 72 UTF-8 bytes. New passwords require a minimum length of 8.
- Workout routes use JWT ownership, bound SQL, a 4 KiB JSON limit and 60 requests per minute per user. Submission UUIDs prevent duplicate records for retries within the same user; lists are paginated. See [WORKOUTS.md](WORKOUTS.md).
- Exercise routes verify the parent workout owner. Exercise and set creation is transactional; locking the owned workout serializes appends. Payloads are bounded to 30 sets and workouts to 100 exercises. Repetition counts and weights are validated before insertion. See [EXERCISES.md](EXERCISES.md).
- Exercise templates are scoped to the verified account, with shared exercise validation, a 4 KiB body limit and a separate 60/minute user limit. Owner locking and unique name/request keys prevent duplicate saves and enforce the 100-template quota; deletes include the owner in SQL and never affect recorded workouts. See [EXERCISE_TEMPLATES.md](EXERCISE_TEMPLATES.md).
- Uploaded images are limited to 5 MiB and 4096 × 4096 pixels, decoded, and re-encoded as JPEG without EXIF/GPS metadata. Verified objects use server-generated keys separate from pending uploads.
- Responses use `Cache-Control: no-store`. Error responses omit stack traces and database or AWS details.

## Limitations

- Rate limits are stored in process memory and reset on restart. Multiple instances require a shared limiter store. These limits do not provide distributed DDoS protection or storage quotas.
- JWTs expire after 30 days. There is no token revocation list; signing-key rotation invalidates existing sessions.
- S3 upload forms can be reused for their exact pending key until they expire after 5 minutes. Read URLs expire after 15 minutes. Treat both as temporary credentials.
- Cleanup jobs handle replaced avatars and failed finalization. Abandoned uploads require a separate S3 Lifecycle rule scoped to `avatars/pending/`. The supplied rule is an example and is not applied by the application.
- Existing passwords longer than bcrypt's 72-byte limit require a separate account recovery path. This change does not migrate password hashes.

Automated tests and dependency scans cover specific failure modes; they do not replace an infrastructure review or penetration test. Do not include credentials or personal data in public issue reports.

## Українська

### Вимоги до розгортання

- Використовуйте HTTPS через довірений проксі. Node має бути недоступним напряму з Інтернету; за замовчуванням довіряє лише локальним проксі.
- Зберігайте доступ до БД, `JWT_SECRET` і ключі AWS поза Git. Використовуйте випадковий секрет JWT довжиною щонайменше 32 байти.
- Залишайте S3 bucket приватним із блокуванням публічного доступу та вимкненими ACL. Обмежуйте IAM-дозволи застосунку об'єктами аватарів.
- Не записуйте в журнали паролі, заголовки авторизації, підписані форми чи URL. У разі витоку відкличте й замініть ключі: видалення файла з Git не робить їх недійсними.

### Реалізовані обмеження

JWT перевіряється за HS256, строком дії та додатним числовим ID. SQL використовує параметри. Вхід обмежено 20 запитами за 15 хвилин на IP, реєстрацію — 5 за годину на IP. Видача дозволу на аватар і підтвердження мають окремі ліміти: по 5 запитів за хвилину на користувача.

JSON обмежений 2 КіБ; перевіряються типи полів і максимальна довжина пароля — 72 байти UTF-8. Мінімальна довжина нового пароля — 8. Зображення обмежене 5 МіБ та 4096 × 4096 пікселів і повторно кодується в JPEG без EXIF/GPS. Перевірені файли отримують окремі ключі, створені сервером. Відповіді не кешуються й не містять стеку або деталей БД/AWS.

Для маршрутів тренувань JSON обмежений 4 КіБ, частота — 60 запитів за хвилину на користувача. Власник визначається з JWT, SQL використовує параметри, список має сторінки. UUID запиту запобігає дублюванню при повторі. Деталі — у [WORKOUTS.md](WORKOUTS.md).

Для вправ перевіряється власник батьківського тренування. Вправа та підходи створюються транзакційно; рядок тренування блокується на час додавання. Ліміти — 100 вправ у тренуванні та 30 підходів у вправі; типи й межі повторень і ваги перевіряються. Деталі — у [EXERCISES.md](EXERCISES.md).

### Обмеження поточної реалізації

Ліміти зберігаються в пам'яті процесу та скидаються після перезапуску. Для кількох процесів потрібне спільне сховище лімітів; захист від розподіленого DDoS і квоти сховища налаштовуються окремо.

JWT діє 30 днів; списку відкликання токенів немає. Заміна ключа підпису робить наявні сесії недійсними. S3 POST-форма повторно придатна для свого pending-ключа протягом 5 хвилин; посилання для читання діє 15 хвилин. Обидва надають тимчасовий доступ.

Черга прибирання обробляє замінені аватари та збої підтвердження. Для покинутих завантажень потрібне окреме S3 Lifecycle-правило лише на `avatars/pending/`; приклад у репозиторії не застосовується автоматично. Для старих паролів понад 72 байти потрібне окреме відновлення доступу; міграції хешів немає.

Тести й перевірка залежностей охоплюють визначені сценарії, але не замінюють аудит інфраструктури. Не додавайте ключі чи особисті дані до публічних повідомлень про помилки.

Шаблони доступні лише власнику з JWT: до 100 на акаунт, JSON 4 КіБ, окремий ліміт 60/хв. Повтори, унікальність назв і квота перевіряються під блокуванням рядка власника. Видалення не зачіпає записані вправи. Див. [EXERCISE_TEMPLATES.md](EXERCISE_TEMPLATES.md).

## Profile and workout templates / Профіль і шаблони тренувань

Profile queries and nickname updates use only the verified account ID and bound SQL. Email cannot be updated through the profile route. Calendar output is bounded to one selected year and never includes another account's workouts.

Whole-workout templates are snapshots of an owned workout, with account/workout locking, a 50-template account quota and transactional instantiation. Request UUIDs distinguish ordinary workouts and template copies, and remain usable after source/template deletion. New copies use fresh exercise IDs. A client cannot submit arbitrary snapshot contents. Full snapshots are bounded to 100 exercises and 3000 sets; lists return summaries only. Profile and template routes each have separate account rate limits. See [PROFILE_PLANS.md](PROFILE_PLANS.md).

Профіль та календар обмежені власником з JWT; нікнейм перевіряється, email не змінюється. Шаблони тренувань не приймають довільні вправи від клієнта: сервер копіює лише власне джерело. Створення всіх записів атомарне; повтори не дублюють копії, видалення шаблону не стирає тренування. Ліміти й межі описано в [PROFILE_PLANS.md](PROFILE_PLANS.md).
