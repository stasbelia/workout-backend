BEGIN;
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
COMMIT;
