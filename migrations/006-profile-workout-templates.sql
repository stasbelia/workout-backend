BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname text CHECK (nickname IS NULL OR char_length(btrim(nickname)) BETWEEN 2 AND 32);
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS template_source_id integer CHECK (template_source_id > 0);
CREATE TABLE IF NOT EXISTS workout_templates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  source_workout_id integer NOT NULL CHECK (source_workout_id > 0),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  exercises jsonb NOT NULL CHECK (jsonb_typeof(exercises)='array' AND jsonb_array_length(exercises) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS workout_templates_owner_name ON workout_templates(user_id,lower(name));
CREATE INDEX IF NOT EXISTS workout_templates_owner_order ON workout_templates(user_id,id DESC);
COMMIT;
