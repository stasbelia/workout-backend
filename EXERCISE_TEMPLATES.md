# Exercise templates / Шаблони вправ

Reusable account-owned snapshots of an exercise name, notes and 1–30 sets. Applying a template fills a client-side form; saving the workout exercise remains a separate request. Deleting a template never deletes recorded exercises or sets.

After a private database backup, run `npm run migrate:templates`. Migration `005-exercise-templates.sql` adds `exercise_templates` without changing existing workout tables. Apply migrations 002–004 first for a fresh installation of the existing account schema.

| Method | Endpoint | Result |
| --- | --- | --- |
| GET | `/api/exercise-templates` | `{ templates: [...] }`, newest first, at most 100 |
| POST | `/api/exercise-templates` | `{ template: {...} }`, 201 on creation, 200 on identical retry |
| DELETE | `/api/exercise-templates/:templateId` | 204, including absent or foreign IDs |

All endpoints require Bearer JWT. Ownership is taken only from the verified token. POST accepts only `name`, optional `notes`, `sets`, and UUID v4 `clientRequestId`; each set contains `reps` and optional nullable `weightKg`. Responses contain `id`, `name`, `notes`, `sets`, and `createdAt`, without owner IDs or submission keys.

The exercise validator is shared with workout exercise creation: trimmed names 1–100 characters, notes up to 500, 1–30 sets, integer repetitions 1–1000, nullable weight 0–1000 kg with at most two decimals. Unknown fields and query parameters are rejected. Requests have a separate limit of 60/minute per account and a 4 KiB JSON limit.

There may be up to 100 templates per account. Names are unique within an account, ignoring case. Identical submissions with the same name and defaults return the existing template even with a new request UUID; changed defaults under an existing name return 409. Use another name for a variant, or delete the previous template before saving its replacement. The owner row is locked while saving, so concurrent submissions cannot bypass uniqueness or the quota. A UUID reused with different content also returns 409.

Names, notes and sets are snapshots; templates have no foreign key to a recorded exercise. Templates are deleted with their account. No AWS permissions, S3 configuration or new dependencies are required.

## Українська

Шаблон зберігає назву, нотатку та підходи у власному акаунті. Його вибір заповнює форму; щоб додати вправу в тренування, потрібно окремо натиснути збереження вправи. Видалення шаблону не змінює вже записані тренування.

Після приватної резервної копії БД виконайте `npm run migrate:templates`. Додається лише таблиця `exercise_templates`. Маршрути наведені вище; власник визначається з JWT, а не з даних телефона.

До 100 шаблонів на акаунт, назви унікальні без урахування регістру. Повтор з однаковою назвою та даними повертає наявний запис без дублювання. Інші підходи під тією самою назвою дають 409: для варіанта потрібно вказати іншу назву або спочатку видалити попередній шаблон. Видалення повторюване й не відкриває існування чужого запису.

Ліміти чисел і текстів спільні зі звичайними вправами; JSON до 4 КіБ, до 60 запитів на хвилину на користувача. Вони не замінюють спільне сховище лімітів при запуску кількох процесів.
