import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { validateBrowserDevice, detectBrowserPlatform } from '../src/browser-device.js';

const BASE = 'https://device.example.test';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const HUAWEI_UA = 'Mozilla/5.0 (Linux; Android 12; HUAWEI LIO-AL00 Build/HUAWEILIO-AL00) AppleWebKit/537.36 (KHTML, like Gecko) HuaweiBrowser/13.0.0.300 Mobile Safari/537.36';
const payload = (overrides = {}) => ({
  consent: true, platform: 'android', platformSource: 'detected',
  browser: { userAgent: ANDROID_UA, language: 'zh-CN', screen: { width: 390, height: 844, pixelRatio: 3 } },
  ...overrides
});

function database() {
  const sqlite = new DatabaseSync(':memory:');
  let batchQueue = Promise.resolve();
  for (const file of ['0001_init.sql', '0002_pair_sessions.sql', '0003_callback_diagnostics.sql', '0004_manual_details.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const wrap = (query, values = []) => ({
    bind(...args) { return wrap(query, args); },
    async first() { return sqlite.prepare(query).get(...values) || null; },
    async run() { return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } }; }
  });
  return {
    sqlite, prepare: query => wrap(query),
    batch(statements) {
      const pending = batchQueue.then(async () => {
        sqlite.exec('BEGIN');
        try {
          const result = [];
          for (const statement of statements) result.push(await statement.run());
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      });
      batchQueue = pending.catch(() => {});
      return pending;
    }
  };
}

function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const outgoing = new Headers(headers);
  if (cookie) outgoing.set('Cookie', cookie);
  if (body !== undefined) outgoing.set('Content-Type', 'application/json');
  return new Request(BASE + path, { method, headers: outgoing, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function create(env) {
  const response = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
  assert.equal(response.status, 201);
  return response.headers.get('Set-Cookie').split(';')[0];
}

const send = (env, cookie, body = payload(), headers) => worker.fetch(request('/api/session/browser', {
  method: 'POST', cookie, body, headers
}), env);
const read = async (env, cookie) => (await (await worker.fetch(request('/api/session', { cookie }), env)).json()).session;

test('Android 浏览器只声明浏览器来源，不生成硬件编号或苹果系统回传来源', () => {
  const device = validateBrowserDevice(payload());
  assert.equal(device.platform, 'android');
  assert.equal(device.osVersion, '13');
  assert.equal(device.modelName, 'Pixel 7');
  assert.equal(device.browserName, 'Chrome');
  assert.equal(device.screenSize, '390 × 844 CSS px · 3×');
  assert.equal(device.fieldSources.modelName, 'browser');
  assert.equal(device.fieldSources.osVersion, 'browser');
  for (const key of ['udid', 'imei', 'imei2', 'serial', 'iccid', 'seid', 'meid']) assert.equal(device[key], undefined);
});

test('鸿蒙识别需明确标记或用户选择，华为 Android UA 不猜鸿蒙实际版本', () => {
  assert.equal(detectBrowserPlatform(HUAWEI_UA), 'android');
  const selected = validateBrowserDevice(payload({ platform: 'harmonyos', platformSource: 'selected', browser: {
    userAgent: HUAWEI_UA, clientHints: { platform: 'Android', platformVersion: '12.0.0' }
  } }));
  assert.equal(selected.platform, 'harmonyos');
  assert.equal(selected.osVersion, null);
  assert.equal(selected.modelName, 'HUAWEI LIO-AL00');
  assert.equal(selected.browserName, '华为浏览器');
  assert.equal(selected.fieldSources.platformName, 'selected');
  const explicit = validateBrowserDevice(payload({ platform: 'harmonyos', browser: { userAgent: HUAWEI_UA.replace('Android 12', 'HarmonyOS 3.0.0') } }));
  assert.equal(explicit.platform, 'harmonyos');
  assert.equal(explicit.osVersion, '3.0.0');
  const mismatched = validateBrowserDevice(payload({ platform: 'harmonyos', browser: { userAgent: HUAWEI_UA } }));
  assert.equal(mismatched.platform, 'android');
});

test('UA-CH 提供型号版本时标为浏览器提示；缩减 UA 的 K 不作为机型', () => {
  const ua = ANDROID_UA.replace('Android 13; Pixel 7', 'Android 10; K');
  const reduced = validateBrowserDevice(payload({ browser: { userAgent: ua } }));
  assert.equal(reduced.modelName, null);
  assert.equal(reduced.osVersion, null);
  const device = validateBrowserDevice(payload({ browser: { userAgent: ua, clientHints: {
    platform: 'Android', platformVersion: '14.0.0', model: 'Pixel 8', architecture: 'arm', bitness: '64', mobile: true
  } } }));
  assert.equal(device.osVersion, '14.0.0');
  assert.equal(device.modelName, 'Pixel 8');
  assert.equal(device.fieldSources.osVersion, 'browser-hint');
  assert.equal(device.fieldSources.modelName, 'browser-hint');
  for (const model of ['K', 'Unknown', 'unknown', 'Generic', 'Unknown Model']) {
    const placeholder = validateBrowserDevice(payload({ browser: { userAgent: ua, clientHints: { model } } }));
    assert.equal(placeholder.modelName, null);
  }
});

test('iOS 浏览器可以回传可见版本；Macintosh 触控识别和未知系统不生成具体机型', () => {
  const device = validateBrowserDevice(payload({ platform: 'ios', browser: {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Version/18.2 Mobile/15E148 Safari/604.1'
  } }));
  assert.equal(device.platform, 'ios');
  assert.equal(device.osVersion, '18.2');
  assert.equal(device.modelName, null);
  assert.equal(device.fieldSources.osVersion, 'browser');
  const ipad = validateBrowserDevice(payload({ platform: 'ios', browser: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/604.1' } }));
  assert.equal(ipad.platform, 'ios');
  assert.equal(ipad.osVersion, null);
  assert.equal(validateBrowserDevice(payload({ platform: 'unknown', browser: { userAgent: 'UnknownBrowser/1.0' } })).platform, 'unknown');
});

test('浏览器回传严格限制白名单、格式、大小和明确同意', () => {
  for (const body of [
    payload({ consent: false }), payload({ platform: 'windows' }), payload({ platformSource: 'profile' }),
    payload({ imei: '490154203237518' }), payload({ browser: { userAgent: ANDROID_UA, udid: 'a'.repeat(40) } }),
    payload({ browser: { userAgent: 'x'.repeat(1025) } }), payload({ browser: { userAgent: 'UA\nsecret' } }),
    payload({ browser: { userAgent: ANDROID_UA, language: 'zh CN' } }),
    payload({ browser: { userAgent: ANDROID_UA, clientHints: { serial: 'SERIAL' } } }),
    payload({ browser: { userAgent: ANDROID_UA, clientHints: { mobile: 1 } } }),
    payload({ browser: { userAgent: ANDROID_UA, screen: { width: 0, height: 844, pixelRatio: 3 } } }),
    payload({ browser: { userAgent: ANDROID_UA, screen: { width: 390, height: 844, pixelRatio: 30 } } }),
    payload({ browser: [] })
  ]) assert.throws(() => validateBrowserDevice(body), error => error.status === 400);
});

test('浏览器采集需要有效 Cookie、同源及同意，直接会话回传成功且不可覆盖', async () => {
  const DB = database();
  const env = { DB };
  try {
    const cookie = await create(env);
    assert.equal((await send(env, '')).status, 401);
    assert.equal((await send(env, cookie, payload(), { Origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await send(env, cookie, payload({ consent: false }))).status, 400);
    assert.equal((await send(env, cookie, payload({ browser: { userAgent: ANDROID_UA, imei: '490154203237518' } }))).status, 400);
    assert.equal((await read(env, cookie)).state, 'waiting');
    const response = await send(env, cookie);
    assert.equal(response.status, 200);
    const session = (await response.json()).session;
    assert.equal(session.state, 'received');
    assert.equal(session.verification, 'browser-reported');
    assert.equal(session.canDownload, false);
    assert.equal(session.device.modelName, 'Pixel 7');
    assert.equal(session.device.fieldSources.modelName, 'browser');
    assert.equal(session.device.fieldSources.platformName, 'browser');
    assert.equal(session.device.udid, null);
    assert.equal(session.device.imei, null);
    assert.equal((await send(env, cookie)).status, 409);
    assert.deepEqual((await read(env, cookie)).device, session.device);
    assert.equal((await worker.fetch(request('/profile.mobileconfig', { cookie }), env)).status, 409);
  } finally { DB.sqlite.close(); }
});

test('扫码仅手机 Cookie 可回传，鸿蒙结果双端同步、补录保留真实来源', async () => {
  const DB = database();
  const env = { DB };
  try {
    const pair = await worker.fetch(request('/api/pair', { method: 'POST', body: {} }), env);
    const desktop = pair.headers.get('Set-Cookie').split(';')[0];
    const token = (await pair.json()).pairToken;
    assert.equal((await send(env, desktop)).status, 403);
    const claim = await worker.fetch(request('/api/pair/claim', { method: 'POST', body: { consent: true, token } }), env);
    const phone = claim.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await send(env, desktop)).status, 403);
    const response = await send(env, phone, payload({ platform: 'harmonyos', platformSource: 'selected', browser: { userAgent: HUAWEI_UA } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).session.role, 'phone');
    const result = await read(env, desktop);
    assert.equal(result.role, 'desktop');
    assert.equal(result.device.platform, 'harmonyos');
    assert.equal(result.verification, 'browser-reported');
    assert.equal(result.device.fieldSources.osVersion, undefined);
    assert.deepEqual(result.device, (await read(env, phone)).device);
    const manual = await worker.fetch(request('/api/session/details', { method: 'POST', cookie: desktop, body: { fields: {
      osVersion: '3.0.0', modelName: '用户确认的机型', imei: '490154203237518'
    } } }), env);
    assert.equal(manual.status, 200);
    const details = (await manual.json()).session.device;
    assert.equal(details.fieldSources.osVersion, 'manual');
    assert.equal(details.fieldSources.modelName, 'manual');
    assert.equal(details.fieldSources.imei, 'manual');
    assert.equal(details.fieldSources.platformName, 'selected');
    assert.equal(details.fieldSources.browserName, 'browser');
    assert.equal(details.collectionMethod, 'browser');
    assert.deepEqual(details, (await read(env, phone)).device);
    assert.equal((await worker.fetch(request('/api/session', { method: 'DELETE', cookie: phone }), env)).status, 200);
    assert.equal(await read(env, desktop), null);
  } finally { DB.sqlite.close(); }
});

test('并发浏览器回传只接受一次，过期会话不能回传', async () => {
  const DB = database();
  const env = { DB };
  try {
    const cookie = await create(env);
    const responses = await Promise.all([send(env, cookie), send(env, cookie)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    DB.sqlite.prepare('UPDATE sessions SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
    assert.equal((await send(env, cookie)).status, 401);
    assert.equal(await read(env, cookie), null);
  } finally { DB.sqlite.close(); }
});
