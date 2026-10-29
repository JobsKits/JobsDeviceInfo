export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function cleanup(db, now = Math.floor(Date.now() / 1000)) {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM rate_salts WHERE expires_at <= ?').bind(now)
  ]);
}
