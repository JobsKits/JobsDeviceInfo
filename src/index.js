import {
  RequestError, buildProfile, readLimitedBody, decodeSignedDeviceResponse, validateDevice, callbackDiagnostic,
  DEVICE_DETAIL_FIELDS, normalizeDetailValue
} from './profile.js';
import { sha256, cleanup } from './storage.js';
import modelNames from '../data/apple-device-models.json' with { type: 'json' };
import osVersions from '../data/apple-os-versions.json' with { type: 'json' };

const COOKIE_NAME = 'jobs_device_session';
const SESSION_SECONDS = 15 * 60;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function cookieValue(request) {
  const cookies = request.headers.get('cookie') || '';
  const matches = cookies.split(';').map((item) => item.trim()).filter((item) => item.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function cookieHeader(request, token, maxAge = SESSION_SECONDS) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
  const secure = !local || new URL(request.url).protocol === 'https:';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireSameOrigin(request) {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin && origin !== new URL(request.url).origin) || (site && !['same-origin', 'none'].includes(site))) {
    throw new RequestError(403, 'cross_origin_denied', '请在此网站内完成操作。');
  }
}

async function readJson(request) {
  requireSameOrigin(request);
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new RequestError(415, 'json_required', '请使用 JSON 请求。');
  }
  try {
    const bytes = await readLimitedBody(request, 4096);
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected object');
    return body;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'invalid_json', '请求内容无法解析。');
  }
}

async function limitSessionCreation(request, db, now) {
  const bucket = Math.floor(now / SESSION_SECONDS);
  const expires = (bucket + 2) * SESSION_SECONDS;
  await db.prepare('INSERT INTO rate_salts (bucket, salt, expires_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO NOTHING')
    .bind(bucket, randomToken(), expires).run();
  const row = await db.prepare('SELECT salt FROM rate_salts WHERE bucket = ?').bind(bucket).first();
  const address = request.headers.get('cf-connecting-ip') || 'local';
  const ipHash = await sha256(`rate:${row.salt}:${address}`);
  const counter = await db.prepare(`INSERT INTO rate_limits (bucket, ip_hash, requests, expires_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(bucket, ip_hash) DO UPDATE SET requests = requests + 1 RETURNING requests`)
    .bind(bucket, ipHash, expires).first();
  if (counter.requests > 12) {
    throw new RequestError(429, 'rate_limited', '创建过于频繁，请稍后重试。');
  }
}

function sessionDevice(row) {
  const profile = row.device_json ? JSON.parse(row.device_json) : null;
  let manual = {};
  try {
    const value = JSON.parse(row.manual_details_json || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) manual = value;
  } catch {}
  if (!profile && !row.manual_imei && !Object.keys(manual).length) return null;
  const keys = ['udid', 'product', 'version', ...DEVICE_DETAIL_FIELDS];
  const device = { ...Object.fromEntries(keys.map((key) => [key, null])), ...profile, fieldSources: {} };
  for (const key of keys) {
    if (device[key]) device.fieldSources[key] = profile?.fieldSources?.[key] === 'derived' ? 'derived' : 'profile';
  }
  // 构建号和产品必须同时命中 Apple 公开版本目录，避免把浏览器版本当系统版本。
  if (!device.osVersion && Object.hasOwn(osVersions, device.version)) {
    const software = osVersions[device.version];
    const version = normalizeDetailValue('osVersion', software?.version);
    if (version && Array.isArray(software.products) && software.products.includes(device.product)) {
      device.osVersion = version;
      device.fieldSources.osVersion = 'derived';
    }
  }
  // 型号名称来自本地有来源的产品标识映射，用户补录可覆盖推导值。
  if (!device.modelName && Object.hasOwn(modelNames, device.product) && typeof modelNames[device.product] === 'string' && modelNames[device.product]) {
    device.modelName = modelNames[device.product];
    device.fieldSources.modelName = 'derived';
  }
  for (const key of DEVICE_DETAIL_FIELDS) {
    const value = key === 'imei' ? row.manual_imei : normalizeDetailValue(key, manual[key], { allowGrouping: false });
    if (value && (!device[key] || device.fieldSources[key] === 'derived')) {
      device[key] = value;
      device.fieldSources[key] = 'manual';
    }
  }
  device.imeiSource = device.imei ? device.fieldSources.imei : null;
  device.imeiStatus = device.imei ? 'provided' : profile?.imeiStatus || 'not_returned';
  return device;
}

function sessionResult(row) {
  const device = sessionDevice(row);
  let callbackError = null;
  if (!row.received_at && row.callback_error_json && Number.isInteger(row.callback_error_at)) {
    try {
      const saved = JSON.parse(row.callback_error_json);
      const diagnostic = callbackDiagnostic({ code: saved.code, diagnostic: saved });
      callbackError = { code: diagnostic.code, stage: diagnostic.stage, at: new Date(row.callback_error_at * 1000).toISOString() };
    } catch {}
  }
  return {
    state: row.received_at ? 'received' : 'waiting',
    expiresAt: new Date(row.expires_at * 1000).toISOString(),
    receivedAt: row.received_at ? new Date(row.received_at * 1000).toISOString() : null,
    device,
    verification: row.received_at ? 'signature-only' : null,
    callbackError,
    profileUrl: '/profile.mobileconfig',
    paired: row.source === 'pair',
    role: row.viewer_role || (row.source === 'pair' ? 'desktop' : 'phone'),
    canDownload: !row.received_at && (row.viewer_role === 'phone' || row.source !== 'pair')
  };
}

async function getSession(request, db, now) {
  const cookie = cookieValue(request);
  if (!cookie) return null;
  const id = await sha256(`session:${cookie}`);
  const row = await db.prepare('SELECT * FROM sessions WHERE (id = ? OR phone_hash = ?) AND expires_at > ?')
    .bind(id, id, now).first();
  return row ? { ...row, viewer_role: row.source === 'pair' && row.id === id ? 'desktop' : 'phone' } : null;
}

async function createSession(request, db, now) {
  const body = await readJson(request);
  if (body.consent !== true) {
    throw new RequestError(400, 'consent_required', '请先确认设备信息采集说明。');
  }
  await limitSessionCreation(request, db, now);
  const cookie = randomToken();
  const id = await sha256(`session:${cookie}`);
  const callbackToken = await sha256(`callback:${cookie}`);
  const challenge = await sha256(`challenge:${cookie}`);
  const expires = now + SESSION_SECONDS;
  const previous = cookieValue(request);
  const statements = [];
  if (previous) {
    const previousHash = await sha256(`session:${previous}`);
    statements.push(db.prepare('DELETE FROM sessions WHERE id = ? OR phone_hash = ?').bind(previousHash, previousHash));
  }
  statements.push(db.prepare('INSERT INTO sessions (id, callback_hash, challenge_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, await sha256(callbackToken), await sha256(challenge), now, expires));
  await db.batch(statements);
  return json({ ok: true, session: sessionResult({ expires_at: expires }) }, 201, { 'Set-Cookie': cookieHeader(request, cookie) });
}

async function createPair(request, db, now) {
  await readJson(request);
  await limitSessionCreation(request, db, now);
  const cookie = randomToken();
  const id = await sha256(`session:${cookie}`);
  const pairToken = await sha256(`pair:${randomToken()}`);
  const callbackToken = await sha256(`callback:${cookie}`);
  const challenge = await sha256(`challenge:${cookie}`);
  const expires = now + SESSION_SECONDS;
  const statements = [];
  const previous = cookieValue(request);
  if (previous) {
    const previousHash = await sha256(`session:${previous}`);
    statements.push(db.prepare('DELETE FROM sessions WHERE id = ? OR phone_hash = ?').bind(previousHash, previousHash));
  }
  statements.push(db.prepare(`INSERT INTO sessions
    (id, callback_hash, challenge_hash, created_at, expires_at, pair_hash, source)
    VALUES (?, ?, ?, ?, ?, ?, 'pair')`)
    .bind(id, await sha256(callbackToken), await sha256(challenge), now, expires, await sha256(pairToken)));
  await db.batch(statements);
  return json({
    ok: true,
    session: sessionResult({ expires_at: expires, source: 'pair', viewer_role: 'desktop' }),
    pairToken
  }, 201, { 'Set-Cookie': cookieHeader(request, cookie) });
}

async function claimPair(request, db, now) {
  const body = await readJson(request);
  if (body.consent !== true) throw new RequestError(400, 'consent_required', '请先确认设备信息采集说明。');
  if (typeof body.token !== 'string' || !/^[0-9a-f]{64}$/.test(body.token)) {
    throw new RequestError(400, 'invalid_pair_token', '配对链接不正确，请在电脑端重新生成二维码。');
  }
  const pairHash = await sha256(body.token);
  const row = await db.prepare("SELECT * FROM sessions WHERE pair_hash = ? AND source = 'pair' AND expires_at > ?")
    .bind(pairHash, now).first();
  if (!row) throw new RequestError(410, 'pair_expired_or_used', '二维码已使用或过期，请在电脑端重新生成。');
  if (row.phone_hash) {
    const existingCookie = cookieValue(request);
    const retryAt = Math.floor(Date.now() / 1000);
    const samePhone = existingCookie && await sha256(`session:${existingCookie}`) === row.phone_hash;
    if (!samePhone || row.expires_at <= retryAt) {
      throw new RequestError(410, 'pair_expired_or_used', '二维码已使用或过期，请在电脑端重新生成。');
    }
    return json({
      ok: true,
      session: sessionResult({ ...row, viewer_role: 'phone' })
    }, 200, { 'Set-Cookie': cookieHeader(request, existingCookie, row.expires_at - retryAt) });
  }
  if (row.received_at) throw new RequestError(410, 'pair_expired_or_used', '二维码已使用或过期，请在电脑端重新生成。');
  const cookie = randomToken();
  const phoneHash = await sha256(`session:${cookie}`);
  const callbackToken = await sha256(`callback:${cookie}`);
  const challenge = await sha256(`challenge:${cookie}`);
  const claimedAt = Math.floor(Date.now() / 1000);
  const updated = await db.prepare(`UPDATE sessions SET phone_hash = ?, callback_hash = ?, challenge_hash = ?
    WHERE id = ? AND pair_hash = ? AND phone_hash IS NULL AND received_at IS NULL AND expires_at > ?`)
    .bind(phoneHash, await sha256(callbackToken), await sha256(challenge), row.id, pairHash, claimedAt).run();
  if (Number(updated.meta?.changes) !== 1) {
    throw new RequestError(409, 'pair_already_claimed', '二维码已经使用或过期，请重新生成。');
  }
  const remaining = Math.max(0, row.expires_at - claimedAt);
  return json({
    ok: true,
    session: sessionResult({ ...row, phone_hash: phoneHash, viewer_role: 'phone' })
  }, 200, { 'Set-Cookie': cookieHeader(request, cookie, remaining) });
}

async function sendProfile(request, db, now) {
  const session = await getSession(request, db, now);
  if (!session) throw new RequestError(401, 'session_required', '请先返回网站创建采集会话。');
  if (session.source === 'pair' && session.viewer_role !== 'phone') {
    throw new RequestError(403, 'phone_required', '请用手机扫描电脑二维码，确认后在手机端下载描述文件。');
  }
  if (session.received_at) throw new RequestError(409, 'already_received', '本次采集已完成；如需重试，请在网站创建新会话。');
  const cookie = cookieValue(request);
  const token = await sha256(`callback:${cookie}`);
  const challenge = await sha256(`challenge:${cookie}`);
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new RequestError(400, 'https_required', '真机采集必须通过 HTTPS 网站进行。');
  }
  const callbackUrl = new URL(`/api/profile/${token}`, url.origin).href;
  return new Response(buildProfile({ callbackUrl, challenge }), {
    headers: {
      'Content-Type': 'application/x-apple-aspen-config',
      'Content-Disposition': 'attachment; filename="JobsDeviceInfo.mobileconfig"'
    }
  });
}

async function receiveProfile(request, db, now, token) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new RequestError(404, 'not_found', '采集地址不存在。');
  const row = await db.prepare('SELECT * FROM sessions WHERE callback_hash = ? AND expires_at > ?')
    .bind(await sha256(token), now).first();
  if (!row) throw new RequestError(410, 'session_expired', '采集会话已失效，请回到网站重新开始。');
  if (row.source === 'pair' && !row.phone_hash) {
    throw new RequestError(403, 'phone_consent_required', '请先在手机确认设备信息采集说明并完成配对。');
  }
  if (row.received_at) throw new RequestError(409, 'already_received', '此采集会话已完成，不接受重复回传。');
  let stage = 'body';
  let device;
  try {
    const bytes = await readLimitedBody(request);
    stage = 'decode';
    const values = await decodeSignedDeviceResponse(bytes);
    stage = 'challenge';
    if (!values.CHALLENGE || await sha256(values.CHALLENGE) !== row.challenge_hash) {
      throw new RequestError(403, 'challenge_mismatch', '设备确认值不匹配，请重新开始。');
    }
    stage = 'device';
    device = validateDevice(values);
  } catch (error) {
    if (error instanceof RequestError) {
      const diagnostic = callbackDiagnostic(error, stage);
      const failedAt = Math.floor(Date.now() / 1000);
      try {
        await db.prepare('UPDATE sessions SET callback_error_json = ?, callback_error_at = ? WHERE id = ? AND received_at IS NULL AND expires_at > ?')
          .bind(JSON.stringify(diagnostic), failedAt, row.id, failedAt).run();
      } catch {
        // 诊断写入失败也必须保留原拒绝结果，不暴露异常或回传原文。
      }
    }
    throw error;
  }
  // 时间和一次性状态必须在 UPDATE 时再检查，避免并发回传或慢解析越过有效期。
  const received = Math.floor(Date.now() / 1000);
  const updated = await db.prepare('UPDATE sessions SET device_json = ?, received_at = ?, callback_error_json = NULL, callback_error_at = NULL WHERE id = ? AND received_at IS NULL AND expires_at > ?')
    .bind(JSON.stringify(device), received, row.id, received).run();
  if (Number(updated.meta?.changes) !== 1) {
    throw new RequestError(409, 'session_used_or_expired', '采集会话已经使用或失效，请重新开始。');
  }
  // Profile Service 用 301 交回浏览器，避免设置页将网页误作后续描述文件解析。
  return new Response(null, { status: 301, headers: { Location: new URL('/?collected=1', request.url).href } });
}

async function manualImei(request, db, now) {
  const body = await readJson(request);
  const row = await getSession(request, db, now);
  if (!row) throw new RequestError(401, 'session_required', '采集会话已失效，请重新开始。');
  if (typeof body.imei !== 'string' || !/^\d{15}$/.test(body.imei)) {
    throw new RequestError(400, 'invalid_imei', '请输入 15 位数字 IMEI。');
  }
  await db.prepare('UPDATE sessions SET manual_imei = ? WHERE id = ? AND expires_at > ?')
    .bind(body.imei, row.id, now).run();
  const current = await db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').bind(row.id, now).first();
  if (!current) throw new RequestError(410, 'session_expired', '采集会话已失效。');
  return json({ ok: true, session: sessionResult({ ...current, viewer_role: row.viewer_role }) });
}

async function manualDetails(request, db, now) {
  const body = await readJson(request);
  const row = await getSession(request, db, now);
  if (!row) throw new RequestError(401, 'session_required', '采集会话已失效，请重新开始。');
  const fields = body.fields;
  if (Object.keys(body).length !== 1 || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new RequestError(400, 'invalid_details', '请提供要补录的设备字段。');
  }
  const entries = Object.entries(fields);
  if (!entries.length || entries.length > DEVICE_DETAIL_FIELDS.length || entries.some(([key]) => !DEVICE_DETAIL_FIELDS.includes(key))) {
    throw new RequestError(400, 'invalid_details', '补录包含不支持的设备字段。');
  }
  const device = sessionDevice(row);
  const patch = {};
  let hasImei = 0;
  let manualImeiValue = null;
  for (const [key, raw] of entries) {
    if (typeof raw !== 'string' || raw.length > 160 || /[\u0000-\u001f\u007f]/.test(raw)) {
      throw new RequestError(400, 'invalid_detail_value', '补录字段内容或长度不正确。');
    }
    const value = raw.trim() ? normalizeDetailValue(key, raw, { allowGrouping: false }) : null;
    if (raw.trim() && !value) throw new RequestError(400, 'invalid_detail_value', '请按字段要求填写有效值。');
    if (device?.[key] && device.fieldSources[key] === 'profile') {
      throw new RequestError(409, 'profile_value_read_only', '系统已回传的字段不能用手工内容覆盖。');
    }
    if (key === 'imei') {
      hasImei = 1;
      manualImeiValue = value;
    } else {
      patch[key] = value;
    }
  }
  const writtenAt = Math.floor(Date.now() / 1000);
  // JSON 补丁原子合并不同端的补录；空字符串仅清除手工值，不影响系统值。
  const updated = await db.prepare(`UPDATE sessions
    SET manual_details_json = json_patch(COALESCE(manual_details_json, '{}'), ?),
        manual_imei = CASE WHEN ? = 1 THEN ? ELSE manual_imei END
    WHERE id = ? AND expires_at > ?`)
    .bind(JSON.stringify(patch), hasImei, manualImeiValue, row.id, writtenAt).run();
  if (Number(updated.meta?.changes) !== 1) throw new RequestError(410, 'session_expired', '采集会话已失效，请重新开始。');
  const current = await db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?')
    .bind(row.id, Math.floor(Date.now() / 1000)).first();
  if (!current) throw new RequestError(410, 'session_expired', '采集会话已失效，请重新开始。');
  return json({ ok: true, session: sessionResult({ ...current, viewer_role: row.viewer_role }) });
}

async function route(request, env) {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  if (url.pathname === '/api/health' && request.method === 'GET') {
    if (!env.DB) throw new RequestError(503, 'database_not_configured', '服务尚未配置数据库。');
    await env.DB.prepare('SELECT id FROM sessions LIMIT 1').first();
    return json({ ok: true, service: 'JobsDeviceInfo', database: true });
  }
  const apiPath = url.pathname.startsWith('/api/') || url.pathname === '/profile.mobileconfig';
  if (apiPath) {
    if (!env.DB) throw new RequestError(503, 'database_not_configured', '服务尚未配置数据库。');
    await cleanup(env.DB, now);
  }
  if (url.pathname === '/api/session') {
    if (request.method === 'GET') {
      const row = await getSession(request, env.DB, now);
      return json({ ok: true, session: row ? sessionResult(row) : null });
    }
    if (request.method === 'POST') return createSession(request, env.DB, now);
    if (request.method === 'DELETE') {
      requireSameOrigin(request);
      const row = await getSession(request, env.DB, now);
      if (row) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(row.id).run();
      return json({ ok: true, session: null }, 200, { 'Set-Cookie': cookieHeader(request, '', 0) });
    }
  }
  if (url.pathname === '/api/pair' && request.method === 'POST') return createPair(request, env.DB, now);
  if (url.pathname === '/api/pair/claim' && request.method === 'POST') return claimPair(request, env.DB, now);
  if (url.pathname === '/api/session/imei' && request.method === 'POST') return manualImei(request, env.DB, now);
  if (url.pathname === '/api/session/details' && request.method === 'POST') return manualDetails(request, env.DB, now);
  if (url.pathname === '/profile.mobileconfig' && request.method === 'GET') return sendProfile(request, env.DB, now);
  if (url.pathname.startsWith('/api/profile/') && request.method === 'POST') {
    return receiveProfile(request, env.DB, now, url.pathname.slice('/api/profile/'.length));
  }
  if (apiPath) return json({ ok: false, error: { code: 'not_found', message: '接口或请求方式不存在。' } }, 404);
  if (!['GET', 'HEAD'].includes(request.method)) return json({ ok: false, error: { code: 'method_not_allowed', message: '此页面不接受该请求方式。' } }, 405);
  return env.ASSETS ? env.ASSETS.fetch(request) : new Response('静态资源尚未绑定。', { status: 503 });
}

export default {
  async fetch(request, env) {
    try {
      return secureResponse(await route(request, env));
    } catch (error) {
      if (error instanceof RequestError) {
        return secureResponse(json({ ok: false, error: { code: error.code, message: error.message } }, error.status));
      }
      // 不将原始回传、Cookie、地址或异常内容输出到日志。
      return secureResponse(json({ ok: false, error: { code: 'service_unavailable', message: '服务暂不可用，请稍后重试。' } }, 503));
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env.DB));
  }
};
