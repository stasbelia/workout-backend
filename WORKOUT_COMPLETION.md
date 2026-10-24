# Workout completion / Завершення тренувань

## English

After backing up PostgreSQL, run `npm run migrate:completion` after migration 006. Migration 007 adds nullable `workouts.completed_at` and a partial activity index. Existing records stay unfinished; no existing workout, exercise, set or template is deleted.

`PATCH /api/workouts/:workoutId/completion` accepts exactly `{ "completed": true, "today": "2026-10-23" }`. `completed: false` reopens the workout without deleting its contents. JWT, the existing per-account workout limit and 4 KiB JSON limit apply. The account must still exist and the workout must belong to it; missing and foreign records both return 404. Invalid bodies, query parameters and IDs return 400.

The transaction locks the owned workout, also serializing with exercise appends and template snapshots. New completions require an exercise with at least one set and an assigned date no later than the client's local `today`; violations return 409. The client date expresses the user's calendar day, not a trusted proof of physical activity. PostgreSQL generates the completion timestamp. Repeating the same completed state preserves that timestamp, including after a lost COMMIT response; repeating the unfinished state leaves it null. Concurrent different states are serialized and the last committed request wins.

All workout responses now include `completedAt: ISO timestamp | null`: list, detail, creation, template copies and retries. New workouts and copies always start unfinished. Templates copy exercises and sets, never completion state.

The profile counts only records with non-null completion timestamps, grouped by their **assigned workout date**, not the completion timestamp. Future assigned dates remain excluded using the existing local `today` boundary. Totals and daily counts use one SQL snapshot. Reopening removes the record from these counts; it does not remove data.

## Українська

Після приватної резервної копії БД виконайте `npm run migrate:completion` після кроку 006. Додається час завершення й індекс; попередні записи залишаються незавершеними, без видалення даних.

Маршрут `PATCH /api/workouts/:workoutId/completion` приймає лише `completed` (boolean) і `today` (локальну календарну дату). `true` завершує власне тренування, `false` скасовує позначку. Час задає PostgreSQL; повтор не змінює вже збережений час. Порожній або майбутній план завершити не можна. Завершення не блокує подальше додавання вправ.

Календар і лічильники профілю рахують тільки виконані тренування за вказаними в них датами. Старі записи потрібно позначити вручну. Створення з шаблону переносить усі вправи та підходи, але завжди починає новий незавершений запис. Після скасування завершення тренування зникає зі статистики, залишаючись у списку з усім вмістом.

У мобільному застосунку стан змінюється лише після відповіді сервера. Після невизначеного результату повтор надсилає той самий бажаний стан. Відхід з екрана перериває очікування; після повернення стан перечитується з сервера.

## Validation

Completion tests cover JWT before SQL, ownership, deleted accounts, malformed input, empty/future plans, repeat requests, concurrent requests, rollback, a lost COMMIT response, calendar years/leap days, reopening and unfinished template copies. Tests use synthetic users and PGlite; real PostgreSQL locking is additionally checked by a separate deployment smoke test. No real credentials or production user records belong in test fixtures.

After migration 008, real completion-state changes also advance the workout revision. Deleting its last exercise clears the completed state; see [WORKOUT_EDITING.md](WORKOUT_EDITING.md).

Після міграції 008 зміна завершення також змінює версію тренування. Видалення останньої вправи прибирає позначку виконання.
