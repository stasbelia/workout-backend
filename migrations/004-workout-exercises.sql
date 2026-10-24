BEGIN;

CREATE TABLE IF NOT EXISTS workout_exercises (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workout_id integer NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workout_id, client_request_id),
  UNIQUE (workout_id, position)
);

CREATE TABLE IF NOT EXISTS exercise_sets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exercise_id integer NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 30),
  reps integer NOT NULL CHECK (reps BETWEEN 1 AND 1000),
  weight_kg numeric(6, 2) CHECK (weight_kg BETWEEN 0 AND 1000),
  UNIQUE (exercise_id, position)
);

COMMIT;
