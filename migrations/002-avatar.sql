BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_upload_key text;
CREATE TABLE IF NOT EXISTS avatar_cleanup_jobs (
  object_key text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE avatar_cleanup_jobs ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
COMMIT;
