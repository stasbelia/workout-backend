# Profile, activity and workout templates

## Migration and data model

Back up the database, then run `npm run migrate:profile` after migrations 002–005. Migration 006 adds nullable `users.nickname`, an internal nullable `workouts.template_source_id`, and the account-owned `workout_templates` table. Existing accounts, workouts, exercise templates, exercises, sets and avatar settings are preserved.

A nickname is a display name, not a login identifier, and is not unique. It can be cleared. Email is read-only through the profile API. Historical source IDs in snapshots deliberately have no foreign key: deleting a source workout or a template must not invalidate saved snapshots, created workouts, or submission retries.

## Profile API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/profile?year=2026&today=2026-10-23` | Current account and its activity calendar |
| PATCH | `/api/profile` | Update only `{ "nickname": "Stas" }` |

All endpoints require Bearer JWT; ownership comes from the verified token. Profile responses contain only `id`, `email`, nullable `nickname`, and `createdAt` for the current account. Nicknames require at least two Unicode code points and at most 32 UTF-16 code units after trimming; letters, combining marks, numbers, spaces, dots, hyphens and underscores are accepted. An empty string clears the nickname. Unknown fields are rejected.

After migration 007, the calendar counts only completed workout records by their assigned calendar date, not their creation or completion timestamp. See [WORKOUT_COMPLETION.md](WORKOUT_COMPLETION.md). Dates later than the client's local `today` are excluded. Response activity fields: `year`, `today`, `totalWorkouts` through that date, `yearWorkouts`, `activeDays`, and sorted unique `days: [{ date, count }]` within the selected year. Calendar years and dates are bounded to 1900–2100; at most 366 daily aggregates are returned. Counts come from the whole database, not the first page of workouts. Totals and daily aggregates are read in one SQL statement, so concurrent submissions cannot produce inconsistent counts.

Profile requests have a 2 KiB JSON limit and a separate limit of 60/minute per account.

## Whole-workout templates

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/workout-templates` | Up to 50 owned summaries, newest first |
| POST | `/api/workout-templates` | Snapshot an owned workout |
| GET | `/api/workout-templates/:id` | Read the owned full snapshot |
| DELETE | `/api/workout-templates/:id` | Delete only the owned template, 204 |
| POST | `/api/workout-templates/:id/workouts` | Create an independent workout on a new date |

Save request: `{ sourceWorkoutId, name, clientRequestId }`. The client never supplies snapshot exercises. The server locks the owned workout and copies its notes, exercise names/notes, order and all sets. Empty workouts are rejected. Names are 1–100 characters; source exercise validation is shared with normal exercise creation. At most 100 exercises and 30 sets per exercise are stored.

Summary fields: `id`, `name`, `notes`, `createdAt`, `exerciseCount`, `setCount`. A full snapshot instead includes `exercises: [{ name, notes, sets: [{ reps, weightKg }] }]`. Owner and submission keys are not exposed. Names are unique within the account ignoring case; the same name and identical snapshot returns the existing template. Changed contents under an existing name return 409. Use a new name or delete the old template. A repeated submission UUID with the original source ID and exact name returns the original snapshot even if the source later changes or is deleted.

Instantiation accepts `{ title, date, notes, clientRequestId }`, with the same validation as normal workouts. One transaction inserts the workout, new exercise IDs and all sets. Failure rolls everything back. The new workout is independent from its template and source. Reusing a request UUID with identical metadata and the same template returns the saved workout, even after the template is deleted; changed metadata or template returns 409. The internal historical template ID makes this distinction possible.

Template writes lock the account row so concurrent saves cannot bypass the 50-template quota or create duplicates. Requests have a 4 KiB JSON limit and a separate 60/minute account limit. Bulk-copy payloads are generated on the server from bounded snapshots; large snapshots are never accepted from the client. Lists transfer summaries only.

Deleting a template never deletes workouts, exercises or sets. Absent and foreign IDs produce the same delete response; reading or instantiating foreign and absent templates produces the same 404. Rate limits are process-local, as with other routes. These controls do not provide distributed DDoS protection.

## Українська

Профіль показує email поточного акаунта, дозволяє зберегти нікнейм і повертає календар записаних тренувань за обраний рік. Власник визначається лише з JWT. Нікнейм — відображуване ім’я, не логін; він не мусить бути унікальним. Email через цей API не редагується.

Після міграції 007 календар рахує лише виконані тренування за вказаною в них датою, без майбутніх планів. Подробиці — [WORKOUT_COMPLETION.md](WORKOUT_COMPLETION.md). `today` — локальна календарна дата телефона; SQL працює з `date`, без зсуву через часові пояси.

Шаблон цілого тренування зберігає всі вправи, їхній порядок, нотатки, повторення й вагу. Він створюється з власного тренування, що вже містить вправи. Після вибору шаблону клієнт задає назву, нову дату й нотатку; сервер однією транзакцією створює незалежні записи. Втрата відповіді й повтор із тим самим UUID не дублюють тренування. Видалення джерела чи шаблону не видаляє створені копії.

На акаунт — до 50 шаблонів цілого тренування. Назви унікальні без урахування регістру; інший вміст під тією самою назвою потребує іншої назви або видалення попереднього шаблону. Шаблони окремих вправ із попереднього кроку залишаються окремою можливістю.

Нові API й міграція не змінюють ключі AWS, `.env`, аватари або попередні записи. Тема інтерфейсу зберігається тільки на телефоні та не потребує серверних секретів.
