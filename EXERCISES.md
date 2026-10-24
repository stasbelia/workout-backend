# Exercises and sets

Workouts now contain ordered exercises. Each exercise has a name, an optional note, and 1–30 sets. Each set records integer repetitions and an optional weight in kilograms.

## Migration

After a private database backup, run `npm run migrate:exercises`. Migration `004-workout-exercises.sql` requires the existing `workouts` table and adds `workout_exercises` and `exercise_sets`. It does not change existing workouts, accounts or avatars. Re-running the migration preserves records.

Foreign keys cascade when a parent workout or account is deleted by an administrator. This release does not add API routes to edit or delete saved exercises or sets.

## API

Both routes use the existing workout router's Bearer JWT authentication, 4 KiB JSON parser and shared 60 requests per minute per user limit.

`GET /api/workouts/:workoutId` returns `{ workout, exercises }`. Exercises are ordered by `position`; sets also have server-assigned positions starting at one. The response is bounded by 100 exercises and 30 sets per exercise. Existing workouts return an empty exercise list until an exercise is saved.

`POST /api/workouts/:workoutId/exercises` accepts:

```json
{
  "name": "Squat",
  "notes": "Controlled tempo",
  "clientRequestId": "00000000-0000-4000-8000-000000000001",
  "sets": [
    { "reps": 10, "weightKg": 40 },
    { "reps": 8, "weightKg": 42.5 },
    { "reps": 8, "weightKg": null }
  ]
}
```

- Names: trimmed non-empty strings, up to 100 UTF-16 code units; no control characters.
- Notes: optional strings, trimmed, up to 500 UTF-16 code units; line feeds and tabs allowed.
- Sets: 1–30 objects, each with integer `reps` from 1 through 1000. `weightKg` can be omitted or null, or a number from 0 through 1000 with at most two decimal places. Null means unrecorded weight; zero is an explicitly recorded zero.
- `clientRequestId`: lowercase UUID v4 for this submission. User IDs, parent workout IDs and positions are not accepted in the JSON body. The workout ID belongs in the URL; its owner is verified against the JWT.

A PostgreSQL transaction locks the owned workout, checks the scoped retry key and exercise limit, inserts the exercise and all sets, then commits. A new record returns `201` and `{ exercise }`. An identical retry returns `200` with the original record and sets. A conflicting payload with the same key returns `409`. Failed set insertion rolls back the exercise as well.

Foreign and missing workouts both return `404`. Invalid IDs/payloads return `400`, missing or deleted users `401`, full workouts `409`. Unexpected errors use the generic server handler; notes, weights and tokens are not logged.

## Verification and limits

Local tests cover ownership, malformed fields and IDs, numeric boundaries, scoped retries, parallel requests, order, rollback and a lost commit reply. PGlite tests serialize transactions because it has one connection; a separate HTTPS smoke check verifies concurrent appends on the real PostgreSQL instance with temporary accounts.

The form's retry key survives retries only while that form remains mounted. After leaving the form or restarting the app, check the workout before manually creating another copy of an uncertain submission. Rate limits are in memory; storage quotas and distributed DDoS protection are outside this feature.

## Українська

Тренування містить впорядковані вправи, а кожна вправа — назву, необов’язкову нотатку та від 1 до 30 підходів. Для підходу потрібні цілі повторення 1–1000; вага необов’язкова, 0–1000 кг, до двох знаків після коми. Телефон приймає і кому, і крапку; API отримує число. Порожня вага зберігається як `null`, явно введений нуль — як `0`.

Після приватної резервної копії запускається `npm run migrate:exercises`. Нова міграція створює дві таблиці, не змінюючи вже збережених тренувань, користувачів або аватарів.

Власник визначається з JWT. Номер тренування в URL не надає доступу сам собою: чуже і відсутнє тренування повертають однаковий `404`. Сервер призначає позиції вправ і підходів. У тренуванні може бути до 100 вправ.

Вправа та її підходи записуються однією транзакцією. Помилка підходів відкочує всю вправу. Блокування рядка тренування узгоджує одночасні запити. Повтор із тим самим UUID та незмінними даними повертає попередній запис; змінений вміст — `409`.

Збережені вправи та підходи поки не редагуються і не видаляються через API. Підходи можна додати або прибрати в мобільній формі до її збереження. Ключ повтору зберігається лише протягом поточної відкритої форми, а ліміти запитів — у пам’яті процесу. Після непідтвердженого збереження та виходу з форми потрібно спочатку перевірити список вправ.
