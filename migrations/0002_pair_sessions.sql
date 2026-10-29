ALTER TABLE sessions ADD COLUMN phone_hash TEXT;
ALTER TABLE sessions ADD COLUMN pair_hash TEXT;
ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'direct';
CREATE UNIQUE INDEX IF NOT EXISTS sessions_phone_hash ON sessions(phone_hash);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_pair_hash ON sessions(pair_hash);
