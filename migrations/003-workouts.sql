BEGIN;

CREATE TABLE IF NOT EXISTS workouts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  workout_date date NOT NULL CHECK (workout_date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS workouts_user_date_id_idx ON workouts(user_id, workout_date DESC, id DESC);

COMMIT;
