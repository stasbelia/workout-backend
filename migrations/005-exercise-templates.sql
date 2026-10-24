BEGIN;
CREATE TABLE IF NOT EXISTS exercise_templates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  sets jsonb NOT NULL CHECK (jsonb_typeof(sets) = 'array' AND jsonb_array_length(sets) BETWEEN 1 AND 30),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS exercise_templates_owner_name ON exercise_templates(user_id, lower(name));
CREATE INDEX IF NOT EXISTS exercise_templates_owner_order ON exercise_templates(user_id, id DESC);
COMMIT;
