BEGIN;
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS completed_at timestamptz;
CREATE INDEX IF NOT EXISTS workouts_completed_activity_idx
  ON workouts(user_id, workout_date) WHERE completed_at IS NOT NULL;
COMMIT;
