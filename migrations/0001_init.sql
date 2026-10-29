CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    callback_hash TEXT NOT NULL UNIQUE,
    challenge_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    received_at INTEGER,
    device_json TEXT,
    manual_imei TEXT
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS rate_salts (
    bucket INTEGER PRIMARY KEY,
    salt TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
    bucket INTEGER NOT NULL,
    ip_hash TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (bucket, ip_hash)
);
CREATE INDEX IF NOT EXISTS rate_limits_expires ON rate_limits(expires_at);
