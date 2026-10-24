# Editing workouts and exercises / Редагування тренувань і вправ

## English

Back up PostgreSQL before `npm run migrate:editing` (after migration 007). Migration 008 adds integer `revision` columns, initially zero, to workouts and workout exercises. No existing record is deleted. Workout and exercise JSON now includes its nonnegative revision.

| Method | Endpoint | Body |
| --- | --- | --- |
| PATCH | `/api/workouts/:id` | `title`, `date`, `notes`, `today`, `expectedRevision` |
| DELETE | `/api/workouts/:id` | `expectedRevision` |
| PATCH | `/api/workouts/:id/exercises/:exerciseId` | `name`, `notes`, `sets: [{reps,weightKg}]`, `expectedRevision` |
| DELETE | `/api/workouts/:id/exercises/:exerciseId` | `expectedRevision` |

JWT, account existence, workout ownership, path IDs, body fields, existing 4 KiB JSON and workout rate limits apply. Missing or foreign records return 404 for editing, 204 for deletion. Unknown fields, invalid revisions and invalid exercise/workout input return 400.

Each mutation locks the owned workout in a transaction. Exercise changes also lock the owned exercise. A mismatched expected revision returns 409 without writing. An already matching desired value returns the saved record without a new revision, so retrying a lost response is safe. This compares the complete editable values, including sets; it is not a permanent request receipt. If another client changes values after the first request, retrying the old revision conflicts instead of overwriting them.

Workout revision advances on metadata changes, real completion-state changes, appended/edited/deleted exercises. This prevents a stale workout delete from discarding a newly added exercise. Exercise revision advances when its values or numbered position change. Different concurrent desired edits on one revision serialize; only one can replace the old values.

Exercise updates replace the complete 1–30 set list atomically. Rep/weight validation is unchanged; null and zero weight are distinct. Removing a set means omitting it from that list. Removing the final set requires deleting the exercise instead. SQL failure rolls back old values, old sets and all revision changes.

Deleting an exercise cascades its sets, compacts surviving positions in ascending free slots and advances affected exercise revisions. If the workout has no sets left, its completed state is cleared. The empty workout itself remains. Deleting a workout cascades its exercises and sets and removes its contribution to profile statistics. Existing exercise and whole-workout templates remain independent snapshots.

Moving a completed workout changes its assigned calendar day, retaining the completion timestamp. Moving it to a future day requires reopening it first. The local `today` has the same meaning and limitations as completion API. Profile aggregates still count completed records; the mobile calendar now renders a binary active/rest-day color and no intensity scale. Multiple records on one day are allowed, but have one active-day color.

## Українська

У формах можна виправити назву, дату, нотатку, вагу й повторення; у формі вправи — додати чи прибрати підхід. Одна вправа повинна мати хоча б один підхід. Для видалення всіх її підходів видаляється сама вправа.

Перед видаленням вправи або тренування телефон показує підтвердження з описом наслідків. Сам діалог не видаляє дані: запит іде лише після натискання «Видалити». Скасування не надсилає запиту. Інший користувач не може змінити чи видалити чужі записи.

`revision` — номер версії запису. Телефон зберігає прочитану версію й надсилає `expectedRevision`. Якщо запис уже змінився, сервер відмовляє з 409. Текст форми зберігається; перечитування актуальних полів виконується окремою явною кнопкою. Після невизначеної відповіді повторюється той самий запит із незмінними полями.

Зміна вправи й усіх підходів — одна транзакція: при помилці попередні значення залишаються. Видалення останньої вправи скасовує завершення порожнього тренування; шаблони не змінюються разом із джерелом.

Модель застосунку: один запис тренування містить усі вправи дня та різні групи м’язів. Календар показує активний день одним зеленим кольором, без шкали «менше/більше». Примусового обмеження одним записом на день у базі немає; наявні записи не об’єднуються автоматично.
