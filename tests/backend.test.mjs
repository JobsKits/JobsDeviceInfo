import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../src/index.js';
import { cleanup, sha256 } from '../src/storage.js';
import {
  buildProfile, parseDevicePlist, validateDevice, decodeSignedDeviceResponse, readLimitedBody, callbackDiagnostic,
  normalizeDetailValue
} from '../src/profile.js';

const TEST_UDID = '00008120-0011223344556677';
const TEST_IMEI = '490154203237518';
const BASE = 'https://device.example.test';
let fixtureDir;

test('跨平台版本允许单段和四段，苹果纯数字构建号不冒充系统版本', () => {
  for (const version of ['12', '3.0.0.300', '18.2.1']) {
    assert.equal(normalizeDetailValue('osVersion', version), version);
  }
  for (const version of ['3.0.0.300.1', 'Android 12', '1234', '3..0']) {
    assert.equal(normalizeDetailValue('osVersion', version), null);
  }
  assert.equal(validateDevice({ UDID: TEST_UDID, VERSION: '123' }).osVersion, null);
});

before(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'jobs-device-fixtures-'));
  execFileSync('openssl', [
    'req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(fixtureDir, 'key.pem'), '-out', join(fixtureDir, 'cert.pem'),
    '-subj', '/CN=JobsDeviceInfo-TestFixture', '-days', '1'
  ], { stdio: 'ignore' });
});

after(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

function deviceXml(challenge = 'test-challenge') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CHALLENGE</key><string>${challenge}</string>
<key>UDID</key><string>${TEST_UDID}</string>
<key>PRODUCT</key><string>iPhone15,2</string>
<key>VERSION</key><string>20A362</string>
<key>IMEI</key><string>${TEST_IMEI}</string>
</dict></plist>`;
}

function sign(xml, format = 'DER') {
  writeFileSync(join(fixtureDir, 'payload.xml'), xml);
  execFileSync('openssl', [
    'cms', '-sign', '-binary', '-md', 'sha256', '-in', join(fixtureDir, 'payload.xml'),
    '-signer', join(fixtureDir, 'cert.pem'), '-inkey', join(fixtureDir, 'key.pem'),
    '-outform', format, '-out', join(fixtureDir, 'payload.cms'), '-nodetach'
  ], { stdio: 'ignore' });
  return new Uint8Array(readFileSync(join(fixtureDir, 'payload.cms')));
}

// 使用真实 SQLite 执行迁移与 SQL，仅适配 D1 的异步绑定接口。
function database() {
  const sqlite = new DatabaseSync(':memory:');
  let batchQueue = Promise.resolve();
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_pair_sessions.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_callback_diagnostics.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_manual_details.sql', import.meta.url), 'utf8'));
  const wrap = (query, values = []) => ({
    bind(...args) { return wrap(query, args); },
    async first() { return sqlite.prepare(query).get(...values) || null; },
    async run() {
      const result = sqlite.prepare(query).run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    }
  });
  return {
    prepare: (query) => wrap(query),
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
    },
    sqlite,
    close() { sqlite.close(); }
  };
}

function request(path, { method = 'GET', cookie, body, headers = {}, origin = BASE } = {}) {
  const outgoing = new Headers(headers);
  if (cookie) outgoing.set('Cookie', cookie);
  if (body !== undefined && !(body instanceof Uint8Array)) {
    outgoing.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }
  return new Request(origin + path, { method, headers: outgoing, body });
}

test('Profile Service 负载不包含 MDM 或敏感编号，XML URL 正确转义', () => {
  const profile = buildProfile({ callbackUrl: `${BASE}/api/profile/token?a=1&b=2`, challenge: 'random' });
  assert.match(profile, /<key>PayloadType<\/key><string>Profile Service<\/string>/);
  assert.match(profile, /a=1&amp;b=2/);
  assert.match(profile, /<key>Challenge<\/key><string>random<\/string>/);
  assert.doesNotMatch(profile, /com\.apple\.mdm|PayloadType<\/key><string>Configuration|490154203237518/);
});

test('plist 解析、字段校验与 CHALLENGE data 兼容', () => {
  const values = parseDevicePlist(deviceXml());
  assert.equal(values.CHALLENGE, 'test-challenge');
  assert.equal(validateDevice(values).udid, TEST_UDID);
  assert.equal(validateDevice(values).imeiSource, 'profile');
  const dataXml = deviceXml().replace('<string>test-challenge</string>', '<data>dGVzdC1jaGFsbGVuZ2U=</data>');
  assert.equal(parseDevicePlist(dataXml).CHALLENGE, 'test-challenge');
  assert.equal(validateDevice({ UDID: 'a'.repeat(40) }).imei, null);
});

test('拒绝重复字段、实体、嵌套内容和异常硬件字段', () => {
  assert.throws(() => parseDevicePlist(deviceXml().replace('</dict>', '<key>UDID</key><string>other</string></dict>')), /重复/);
  assert.throws(() => parseDevicePlist('<!DOCTYPE plist [<!ENTITY x "oops">]><plist><dict/></plist>'), /实体/);
  assert.throws(() => parseDevicePlist(deviceXml().replace('<string>iPhone15,2</string>', '<array><string>iPhone15,2</string></array>')), /字段类型/);
  assert.throws(() => validateDevice({ UDID: 'IDFV-is-not-UDID' }), /UDID/);
  assert.equal(validateDevice({ UDID: TEST_UDID, IMEI: '1234' }).imeiStatus, 'unrecognized_format');
  assert.throws(() => validateDevice({ UDID: TEST_UDID, PRODUCT: 'name\nwith-newline' }), /字段/);
});

test('可选 IMEI 仅归一化明确分组，未知格式和 IMEISV 不冒充有效 IMEI', () => {
  for (const value of [TEST_IMEI, '49 015420 323751 8', '49-015420-323751-8', ' 49  015420 323751 8 ']) {
    const device = validateDevice({ UDID: TEST_UDID, IMEI: value });
    assert.equal(device.imei, TEST_IMEI);
    assert.equal(device.imeiSource, 'profile');
    assert.equal(device.imeiStatus, 'provided');
  }
  for (const value of ['1234', '4901542032375181', '49x0154203237518', '49_015420_323751_8', '49--015420-323751-8', '49\t015420 323751 8', '49\u00a0015420 323751 8']) {
    const device = validateDevice({ UDID: TEST_UDID, IMEI: value });
    assert.equal(device.imei, null);
    assert.equal(device.imeiSource, null);
    assert.equal(device.imeiStatus, 'unrecognized_format');
    assert.ok(!JSON.stringify(device).includes(value));
  }
  for (const value of [undefined, '', '   ']) {
    const device = validateDevice({ UDID: TEST_UDID, IMEI: value });
    assert.equal(device.imei, null);
    assert.equal(device.imeiStatus, 'not_returned');
  }
  assert.throws(() => parseDevicePlist(deviceXml().replace(`<string>${TEST_IMEI}</string>`, '<array><string>1234</string></array>')), /字段类型/);
});

test('附加设备字段只采用实际合法回传，系统版本不以构建号或浏览器版本冒充', async () => {
  const profile = buildProfile({ callbackUrl: BASE + '/api/profile/example', challenge: 'example' });
  const attributes = profile.match(/<key>DeviceAttributes<\/key><array>(.*?)<\/array>/s)[1];
  assert.match(attributes, /<string>ICCID<\/string>/);
  assert.match(attributes, /<string>MEID<\/string>/);
  assert.doesNotMatch(attributes, /IMEI2|SEID|MODEL|OS_VERSION/);
  const extra = '<key>IMEI2</key><string>490154203237526</string>'
    + '<key>ICCID</key><string>89860012345678901234</string>'
    + '<key>MEID</key><string>a1000000000001</string>'
    + '<key>OS_VERSION</key><string>26.1.2</string>'
    + '<key>MODEL_NAME</key><string>iPhone 测试机型</string>'
    + '<key>MODEL</key><string>MTESTCH/A</string>'
    + '<key>SERIAL</key><string>TESTSERIAL123</string>'
    + '<key>SEID</key><string>0123456789abcdef0123456789abcdef0123456789abcdef</string>';
  const signed = sign(deviceXml().replace('</dict>', extra + '</dict>'));
  const device = validateDevice(await decodeSignedDeviceResponse(signed));
  assert.equal(device.imei2, '490154203237526');
  assert.equal(device.iccid, '89860012345678901234');
  assert.equal(device.meid, 'A1000000000001');
  assert.equal(device.osVersion, '26.1.2');
  assert.equal(device.version, '20A362');
  assert.equal(device.modelName, 'iPhone 测试机型');
  assert.equal(device.modelNumber, 'MTESTCH/A');
  assert.equal(device.serial, 'TESTSERIAL123');
  assert.equal(device.seid, '0123456789ABCDEF'.repeat(3));
  for (const key of ['udid', 'imei2', 'iccid', 'meid', 'osVersion', 'modelName', 'modelNumber', 'serial', 'seid']) {
    assert.equal(device.fieldSources[key], 'profile');
  }
  const missing = validateDevice({ UDID: TEST_UDID, VERSION: '20A362', PRODUCT: 'unknown-product' });
  for (const key of ['imei2', 'iccid', 'meid', 'osVersion', 'modelName', 'modelNumber', 'seid']) {
    assert.equal(missing[key], null);
    assert.equal(Object.hasOwn(missing.fieldSources, key), false);
  }
  assert.equal(validateDevice({ UDID: TEST_UDID, VERSION: '26.1' }).osVersion, '26.1');
  assert.equal(validateDevice({ UDID: TEST_UDID, VERSION: '20A362', OS_VERSION: 'Version/26.1' }).osVersion, null);
  const malformed = validateDevice({ UDID: TEST_UDID, IMEI2: '1234', ICCID: 'unavailable', MEID: 'invalid', SEID: 'unknown', MODEL: '<invalid>' });
  for (const key of ['imei2', 'iccid', 'meid', 'seid', 'modelNumber']) assert.equal(malformed[key], null);
  assert.equal(malformed.udid, TEST_UDID);
  assert.doesNotMatch(JSON.stringify(malformed), /unavailable|invalid|unknown/);
  assert.equal(normalizeDetailValue('serial', 'bad\nserial'), null);
  const unexpectedType = validateDevice(parseDevicePlist(deviceXml().replace('</dict>',
    '<key>ICCID</key><array><string>unavailable-value</string></array></dict>')));
  assert.equal(unexpectedType.udid, TEST_UDID);
  assert.equal(unexpectedType.iccid, null);
  assert.ok(!JSON.stringify(unexpectedType).includes('unavailable-value'));
});

test('ICCID可用性只记录固定形态分类，未知类型和格式均不保存原文', () => {
  const missing = validateDevice({ UDID: TEST_UDID });
  assert.deepEqual(missing.fieldAvailability, { iccid: 'not_returned' });
  for (const value of ['', '   ']) {
    const empty = validateDevice({ UDID: TEST_UDID, ICCID: value });
    assert.equal(empty.iccid, null);
    assert.deepEqual(empty.fieldAvailability, { iccid: 'empty' });
  }
  const invalid = validateDevice({ UDID: TEST_UDID, ICCID: 'not-an-ICCID-value' });
  assert.deepEqual(invalid.fieldAvailability, { iccid: 'unrecognized_format' });
  assert.ok(!JSON.stringify(invalid).includes('not-an-ICCID-value'));
  const typed = parseDevicePlist(deviceXml().replace('</dict>',
    '<key>ICCID</key><array><string>do-not-store-type-content</string></array></dict>'));
  assert.equal(typed.ICCID, null);
  const unsupported = validateDevice(typed);
  assert.deepEqual(unsupported.fieldAvailability, { iccid: 'unsupported_type' });
  assert.ok(!JSON.stringify(unsupported).includes('do-not-store-type-content'));
  const provided = validateDevice({ UDID: TEST_UDID, ICCID: '89860012345678901234' });
  assert.equal(provided.iccid, '89860012345678901234');
  assert.deepEqual(provided.fieldAvailability, { iccid: 'provided' });
  assert.deepEqual(Object.keys(provided.fieldAvailability), ['iccid']);
});

test('真实 OpenSSL CMS DER 和 PEM 可验签，但不把自签证书当 Apple 信任', async () => {
  const values = await decodeSignedDeviceResponse(sign(deviceXml()));
  assert.equal(values.UDID, TEST_UDID);
  const pemValues = await decodeSignedDeviceResponse(sign(deviceXml(), 'PEM'));
  assert.equal(pemValues.IMEI, TEST_IMEI);
});

test('拒绝普通 XML、截断 CMS 和被篡改的已签名内容', async () => {
  await assert.rejects(decodeSignedDeviceResponse(new TextEncoder().encode(deviceXml())), /CMS/);
  const cms = sign(deviceXml());
  await assert.rejects(decodeSignedDeviceResponse(cms.subarray(0, 20)), /CMS/);
  const marker = new TextEncoder().encode(TEST_UDID);
  const offset = Buffer.from(cms).indexOf(marker);
  assert.ok(offset > 0);
  const tampered = cms.slice();
  tampered[offset] = '9'.charCodeAt(0);
  await assert.rejects(decodeSignedDeviceResponse(tampered), /CMS/);
});

test('按实际流大小拒绝超限回传，不仅依赖 Content-Length', async () => {
  const small = new Request(BASE, { method: 'POST', body: 'abcd' });
  assert.equal((await readLimitedBody(small, 4)).length, 4);
  const large = new Request(BASE, { method: 'POST', body: 'abcde' });
  await assert.rejects(readLimitedBody(large, 4), (error) => error.status === 413);
  const falseLength = new Request(BASE, { method: 'POST', body: 'abc', headers: { 'Content-Length': '5000' } });
  await assert.rejects(readLimitedBody(falseLength, 4), (error) => error.status === 413);
});

test('回调诊断仅保留固定分类，不保留任意异常、算法值或设备内容', () => {
  const diagnostic = callbackDiagnostic({
    code: TEST_UDID,
    message: TEST_IMEI,
    diagnostic: {
      stage: TEST_IMEI,
      digestAlgorithmOID: TEST_UDID,
      signatureAlgorithmOID: '1.2.840.113549.1.1.11',
      errorType: TEST_UDID,
      verificationCode: 100,
      raw: deviceXml(),
      stack: TEST_UDID
    }
  }, 'signature');
  assert.deepEqual(diagnostic, {
    code: 'callback_rejected', stage: 'signature', digestAlgorithmOID: 'unsupported',
    signatureAlgorithmOID: '1.2.840.113549.1.1.11'
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(`${TEST_UDID}|${TEST_IMEI}|raw|stack|message`));
});

test('有效会话的坏回传留下私有诊断，签名与Challenge校验通过后可恢复并清空', async () => {
  const DB = database();
  const env = { DB };
  try {
    const create = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
    const cookie = create.headers.get('Set-Cookie').split(';')[0];
    const profile = await (await worker.fetch(request('/profile.mobileconfig', { cookie }), env)).text();
    const callback = new URL(profile.match(/<key>URL<\/key><string>([^<]+)<\/string>/)[1]);
    const challenge = profile.match(/<key>Challenge<\/key><string>([^<]+)<\/string>/)[1];
    const callbackHash = await sha256(callback.pathname.split('/').at(-1));
    const saved = () => DB.sqlite.prepare('SELECT callback_error_json, callback_error_at, device_json FROM sessions WHERE callback_hash = ?').get(callbackHash);

    const unsigned = await worker.fetch(request(callback.pathname, { method: 'POST', body: new TextEncoder().encode(deviceXml(challenge)) }), env);
    assert.equal(unsigned.status, 400);
    assert.equal((await unsigned.json()).error.code, 'invalid_cms');
    const failed = saved();
    assert.equal(failed.device_json, null);
    assert.equal(JSON.parse(failed.callback_error_json).stage, 'schema');
    assert.equal(JSON.parse(failed.callback_error_json).code, 'invalid_cms');
    assert.ok(Number.isInteger(failed.callback_error_at));
    assert.doesNotMatch(failed.callback_error_json, new RegExp(`${TEST_UDID}|${TEST_IMEI}|${challenge}|${cookie.split('=')[1]}|<plist|CERTIFICATE|stack|message`));

    const privateResult = (await (await worker.fetch(request('/api/session', { cookie }), env)).json()).session.callbackError;
    assert.deepEqual(Object.keys(privateResult).sort(), ['at', 'code', 'stage']);
    assert.equal(privateResult.code, 'invalid_cms');
    assert.equal((await (await worker.fetch(request('/api/session'), env)).json()).session, null);
    const other = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
    const otherCookie = other.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await (await worker.fetch(request('/api/session', { cookie: otherCookie }), env)).json()).session.callbackError, null);

    const body = sign(deviceXml(challenge));
    const offset = Buffer.from(body).indexOf(new TextEncoder().encode(TEST_UDID));
    assert.ok(offset > 0);
    const tampered = body.slice();
    tampered[offset] = '9'.charCodeAt(0);
    const modified = await worker.fetch(request(callback.pathname, { method: 'POST', body: tampered }), env);
    assert.equal(modified.status, 400);
    const signature = JSON.parse(saved().callback_error_json);
    assert.equal(signature.stage, 'signature');
    assert.equal(signature.digestAlgorithmOID, '2.16.840.1.101.3.4.2.1');
    assert.equal(signature.signatureAlgorithmOID, '1.2.840.113549.1.1.1');
    assert.equal(signature.errorType, 'SignedDataVerifyError');
    assert.equal(signature.verificationCode, 15);

    const wrong = await worker.fetch(request(callback.pathname, { method: 'POST', body: sign(deviceXml('wrong')) }), env);
    assert.equal(wrong.status, 403);
    assert.deepEqual(JSON.parse(saved().callback_error_json), { code: 'challenge_mismatch', stage: 'challenge' });
    const invalidField = await worker.fetch(request(callback.pathname, { method: 'POST', body: sign(deviceXml(challenge).replace('iPhone15,2', 'x'.repeat(161))) }), env);
    assert.equal(invalidField.status, 400);
    assert.deepEqual(JSON.parse(saved().callback_error_json), { code: 'invalid_device_field', stage: 'device' });

    const receive = await worker.fetch(request(callback.pathname, { method: 'POST', body }), env);
    assert.equal(receive.status, 301);
    assert.equal(saved().callback_error_json, null);
    assert.equal(saved().callback_error_at, null);
    assert.equal((await (await worker.fetch(request('/api/session', { cookie }), env)).json()).session.callbackError, null);
    const replay = await worker.fetch(request(callback.pathname, { method: 'POST', body }), env);
    assert.equal(replay.status, 409);
    assert.equal(saved().callback_error_json, null);
  } finally {
    DB.close();
  }
});

test('有效签名的异常可选 IMEI 不阻断 UDID，数据库仅保存识别状态与归一化值', async () => {
  const DB = database();
  const env = { DB };
  try {
    for (const [imei, expected, status] of [
      ['49 015420 323751 8', TEST_IMEI, 'provided'],
      ['49x0154203237518', null, 'unrecognized_format'],
      ['4901542032375181', null, 'unrecognized_format'],
      ['1234', null, 'unrecognized_format']
    ]) {
      const create = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
      assert.equal(create.status, 201);
      const cookie = create.headers.get('Set-Cookie').split(';')[0];
      const profile = await (await worker.fetch(request('/profile.mobileconfig', { cookie }), env)).text();
      const callback = new URL(profile.match(/<key>URL<\/key><string>([^<]+)<\/string>/)[1]);
      const challenge = profile.match(/<key>Challenge<\/key><string>([^<]+)<\/string>/)[1];
      const body = sign(deviceXml(challenge).replace(TEST_IMEI, imei));
      const response = await worker.fetch(request(callback.pathname, { method: 'POST', body }), env);
      assert.equal(response.status, 301);
      const result = (await (await worker.fetch(request('/api/session', { cookie }), env)).json()).session;
      assert.equal(result.state, 'received');
      assert.equal(result.device.udid, TEST_UDID);
      assert.equal(result.device.imei, expected);
      assert.equal(result.device.imeiSource, expected ? 'profile' : null);
      assert.equal(result.device.imeiStatus, status);
      const callbackHash = await sha256(callback.pathname.split('/').at(-1));
      const stored = DB.sqlite.prepare('SELECT device_json, callback_error_json FROM sessions WHERE callback_hash = ?').get(callbackHash);
      assert.ok(!stored.device_json.includes(imei));
      assert.equal(stored.callback_error_json, null);
    }
  } finally {
    DB.close();
  }
});

test('完整真实 SQLite + CMS 会话链：隔离、Challenge、回调、重放与清除', async () => {
  const DB = database();
  const env = { DB, ASSETS: { fetch: async () => new Response('local assets') } };
  try {
    const noConsent = await worker.fetch(request('/api/session', { method: 'POST', body: {} }), env);
    assert.equal(noConsent.status, 400);
    const create = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
    assert.equal(create.status, 201);
    const cookie = create.headers.get('Set-Cookie').split(';')[0];
    assert.match(create.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax/);
    assert.match(create.headers.get('Set-Cookie'), /Secure/);
    assert.equal((await create.json()).session.state, 'waiting');
    const hidden = await worker.fetch(request('/api/session'), env);
    assert.equal((await hidden.json()).session, null);
    const profileResponse = await worker.fetch(request('/profile.mobileconfig', { cookie }), env);
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.text();
    const callback = new URL(profile.match(/<key>URL<\/key><string>([^<]+)<\/string>/)[1]);
    const challenge = profile.match(/<key>Challenge<\/key><string>([^<]+)<\/string>/)[1];
    const wrong = await worker.fetch(request(callback.pathname, { method: 'POST', body: sign(deviceXml('wrong')) }), env);
    assert.equal(wrong.status, 403);
    const body = sign(deviceXml(challenge));
    const receive = await worker.fetch(request(callback.pathname, { method: 'POST', body }), env);
    assert.equal(receive.status, 301);
    assert.equal(receive.headers.get('Location'), `${BASE}/?collected=1`);
    assert.equal(receive.headers.get('Referrer-Policy'), 'no-referrer');
    const replay = await worker.fetch(request(callback.pathname, { method: 'POST', body }), env);
    assert.equal(replay.status, 409);
    const result = await worker.fetch(request('/api/session', { cookie }), env);
    const session = (await result.json()).session;
    assert.equal(session.device.udid, TEST_UDID);
    assert.equal(session.device.imei, TEST_IMEI);
    assert.equal(session.verification, 'signature-only');
    assert.equal(session.state, 'received');
    const stored = DB.sqlite.prepare('SELECT * FROM sessions').get();
    assert.ok(!JSON.stringify(stored).includes(cookie.split('=')[1]));
    assert.ok(!JSON.stringify(stored).includes(challenge));
    const crossOrigin = await worker.fetch(request('/api/session', { method: 'DELETE', cookie, headers: { Origin: 'https://other.example' } }), env);
    assert.equal(crossOrigin.status, 403);
    const remove = await worker.fetch(request('/api/session', { method: 'DELETE', cookie }), env);
    assert.equal(remove.status, 200);
    assert.match(remove.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS total FROM sessions').get().total, 0);
  } finally {
    DB.close();
  }
});

test('手填来源、过期会话与限流均由服务端执行', async () => {
  const DB = database();
  const env = { DB };
  try {
    let response = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
    const cookie = response.headers.get('Set-Cookie').split(';')[0];
    const groupedManual = await worker.fetch(request('/api/session/imei', { method: 'POST', cookie, body: { imei: '49 015420 323751 8' } }), env);
    assert.equal(groupedManual.status, 400);
    const imeisvManual = await worker.fetch(request('/api/session/imei', { method: 'POST', cookie, body: { imei: '4901542032375181' } }), env);
    assert.equal(imeisvManual.status, 400);
    response = await worker.fetch(request('/api/session/imei', { method: 'POST', cookie, body: { imei: TEST_IMEI } }), env);
    assert.equal((await response.json()).session.device.imeiSource, 'manual');
    DB.sqlite.prepare('UPDATE sessions SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
    response = await worker.fetch(request('/api/session', { cookie }), env);
    assert.equal((await response.json()).session, null);
    for (let index = 1; index < 12; index++) {
      const created = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
      assert.equal(created.status, 201);
    }
    const limited = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
    assert.equal(limited.status, 429);
    await cleanup(DB, Math.floor(Date.now() / 1000) + 3600);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS total FROM sessions').get().total, 0);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS total FROM rate_limits').get().total, 0);
  } finally {
    DB.close();
  }
});

test('设备补录严格限定字段和格式，仅当前Cookie可写且会话过期后删除', async () => {
  const DB = database();
  const env = { DB };
  try {
    const create = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
    const cookie = create.headers.get('Set-Cookie').split(';')[0];
    const write = (fields, options = {}) => worker.fetch(request('/api/session/details', {
      method: 'POST', cookie, body: { fields }, ...options
    }), env);
    assert.equal((await write({ imei: TEST_IMEI }, { cookie: '' })).status, 401);
    assert.equal((await write({ imei: TEST_IMEI }, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
    for (const fields of [
      { udid: TEST_UDID }, { unknown: 'value' }, {}, { imei: '49 015420 323751 8' },
      { imei2: '1234' }, { iccid: '1234' }, { meid: 'invalid' }, { seid: 'not-an-identifier' },
      { osVersion: '20A362' }, { serial: 'serial\nvalue' }, { modelName: 'x'.repeat(161) }
    ]) {
      assert.equal((await write(fields)).status, 400);
    }
    const value = {
      imei: TEST_IMEI, imei2: '490154203237526', iccid: '89860012345678901234',
      meid: 'A1000000000001', seid: '0123456789ABCDEF'.repeat(3),
      osVersion: '26.1', modelName: 'iPhone 手动测试机型', modelNumber: 'MTESTCH/A', serial: 'TESTSERIAL123'
    };
    const saved = await write(value);
    assert.equal(saved.status, 200);
    const device = (await saved.json()).session.device;
    for (const [key, expected] of Object.entries(value)) {
      assert.equal(device[key], expected);
      assert.equal(device.fieldSources[key], 'manual');
    }
    assert.equal(device.udid, null);
    assert.equal(device.imeiSource, 'manual');
    const stored = DB.sqlite.prepare('SELECT manual_imei, manual_details_json, device_json FROM sessions').get();
    assert.equal(stored.manual_imei, TEST_IMEI);
    assert.equal(Object.hasOwn(JSON.parse(stored.manual_details_json), 'imei'), false);
    assert.equal(stored.device_json, null);
    assert.equal((await (await worker.fetch(request('/api/session'), env)).json()).session, null);
    const other = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
    const otherCookie = other.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await (await worker.fetch(request('/api/session', { cookie: otherCookie }), env)).json()).session.device, null);
    const clear = await write({ imei: '', meid: '' });
    const cleared = (await clear.json()).session.device;
    assert.equal(cleared.imei, null);
    assert.equal(cleared.meid, null);
    assert.equal(cleared.imei2, value.imei2);
    const oldPath = await worker.fetch(request('/api/session/imei', { method: 'POST', cookie, body: { imei: TEST_IMEI } }), env);
    assert.equal((await oldPath.json()).session.device.imeiSource, 'manual');
    DB.sqlite.prepare('UPDATE sessions SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
    assert.equal((await write({ modelName: 'expired' })).status, 401);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  } finally {
    DB.close();
  }
});

test('配对补录两端同步，真实系统字段优先，手工机型名可覆盖有来源的推导', async () => {
  const DB = database();
  const env = { DB };
  try {
    const create = await worker.fetch(request('/api/pair', { method: 'POST', body: {} }), env);
    const desktopCookie = create.headers.get('Set-Cookie').split(';')[0];
    const pairToken = (await create.json()).pairToken;
    const claim = await worker.fetch(request('/api/pair/claim', { method: 'POST', body: { token: pairToken, consent: true } }), env);
    const phoneCookie = claim.headers.get('Set-Cookie').split(';')[0];
    const profile = await (await worker.fetch(request('/profile.mobileconfig', { cookie: phoneCookie }), env)).text();
    const callback = new URL(profile.match(/<key>URL<\/key><string>([^<]+)<\/string>/)[1]);
    const challenge = profile.match(/<key>Challenge<\/key><string>([^<]+)<\/string>/)[1];
    const receive = await worker.fetch(request(callback.pathname, { method: 'POST', body: sign(deviceXml(challenge)) }), env);
    assert.equal(receive.status, 301);
    const read = async cookie => (await (await worker.fetch(request('/api/session', { cookie }), env)).json()).session;
    const original = (await read(desktopCookie)).device;
    assert.equal(original.modelName, 'iPhone 14 Pro');
    assert.equal(original.fieldSources.modelName, 'derived');
    assert.equal(original.fieldSources.imei, 'profile');
    const write = (cookie, fields) => worker.fetch(request('/api/session/details', { method: 'POST', cookie, body: { fields } }), env);
    assert.equal((await write(desktopCookie, { imei: '490154203237526' })).status, 409);
    assert.equal((await write(desktopCookie, { modelName: '修正的手动机型名', imei2: '490154203237526' })).status, 200);
    const concurrent = await Promise.all([
      write(phoneCookie, { modelNumber: 'MPHONE/A' }),
      write(desktopCookie, { serial: 'TESTSERIAL456' })
    ]);
    assert.ok(concurrent.every(response => response.status === 200));
    const desktop = await read(desktopCookie);
    const phone = await read(phoneCookie);
    assert.deepEqual(desktop.device, phone.device);
    assert.equal(desktop.device.udid, TEST_UDID);
    assert.equal(desktop.device.imei, TEST_IMEI);
    assert.equal(desktop.device.fieldSources.imei, 'profile');
    for (const key of ['modelName', 'modelNumber', 'serial', 'imei2']) assert.equal(desktop.device.fieldSources[key], 'manual');
    assert.equal(phone.device.modelNumber, 'MPHONE/A');
    assert.equal(phone.device.serial, 'TESTSERIAL456');
    assert.equal(phone.device.modelName, '修正的手动机型名');
    assert.equal((await worker.fetch(request('/api/session', { method: 'DELETE', cookie: phoneCookie }), env)).status, 200);
    assert.equal(await read(desktopCookie), null);
  } finally {
    DB.close();
  }
});

test('实际回传的型号名称与序列号不能被补录覆盖，补录IMEI不抢占系统值', async () => {
  const DB = database();
  const env = { DB };
  try {
    const create = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
    const cookie = create.headers.get('Set-Cookie').split(';')[0];
    const profile = await (await worker.fetch(request('/profile.mobileconfig', { cookie }), env)).text();
    const callback = new URL(profile.match(/<key>URL<\/key><string>([^<]+)<\/string>/)[1]);
    const challenge = profile.match(/<key>Challenge<\/key><string>([^<]+)<\/string>/)[1];
    const body = sign(deviceXml(challenge).replace('</dict>', '<key>MODEL_NAME</key><string>系统机型名</string><key>SERIAL</key><string>PROFILE12345</string></dict>'));
    assert.equal((await worker.fetch(request(callback.pathname, { method: 'POST', body }), env)).status, 301);
    for (const fields of [{ modelName: '试图覆盖' }, { serial: 'MANUAL12345' }]) {
      const response = await worker.fetch(request('/api/session/details', { method: 'POST', cookie, body: { fields } }), env);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'profile_value_read_only');
    }
    await worker.fetch(request('/api/session/imei', { method: 'POST', cookie, body: { imei: '490154203237526' } }), env);
    const device = (await (await worker.fetch(request('/api/session', { cookie }), env)).json()).session.device;
    assert.equal(device.modelName, '系统机型名');
    assert.equal(device.serial, 'PROFILE12345');
    assert.equal(device.imei, TEST_IMEI);
    assert.equal(device.imeiSource, 'profile');
  } finally {
    DB.close();
  }
});

test('系统版本只在Apple构建号和产品精确匹配时推导，手工值可覆盖推导而不能覆盖实际回传', async () => {
  const DB = database();
  const env = { DB };
  try {
    for (const [build, product, actualVersion, expected, source] of [
      ['24A446', 'iPhone14,5', null, '27.0.1', 'derived'],
      ['24A446', 'iPhone99,99', null, null, undefined],
      ['UNKNOWN_BUILD', 'iPhone14,5', null, null, undefined],
      ['24A446', 'iPhone14,5', '27.0.3', '27.0.3', 'profile'],
      ['27.0.1', 'iPhone14,5', null, '27.0.1', 'profile']
    ]) {
      const create = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
      assert.equal(create.status, 201);
      const cookie = create.headers.get('Set-Cookie').split(';')[0];
      const profile = await (await worker.fetch(request('/profile.mobileconfig', { cookie }), env)).text();
      const callback = new URL(profile.match(/<key>URL<\/key><string>([^<]+)<\/string>/)[1]);
      const challenge = profile.match(/<key>Challenge<\/key><string>([^<]+)<\/string>/)[1];
      let xml = deviceXml(challenge).replace('20A362', build).replace('iPhone15,2', product);
      if (actualVersion) xml = xml.replace('</dict>', `<key>OS_VERSION</key><string>${actualVersion}</string></dict>`);
      const receive = await worker.fetch(request(callback.pathname, { method: 'POST', body: sign(xml) }), env);
      assert.equal(receive.status, 301);
      const data = (await (await worker.fetch(request('/api/session', { cookie }), env)).json()).session.device;
      assert.equal(data.version, build);
      assert.equal(data.osVersion, expected);
      assert.equal(data.fieldSources.osVersion, source);
      if (source === 'derived') {
        const updated = await worker.fetch(request('/api/session/details', {
          method: 'POST', cookie, body: { fields: { osVersion: '27.0.2' } }
        }), env);
        assert.equal(updated.status, 200);
        const manual = (await updated.json()).session.device;
        assert.equal(manual.osVersion, '27.0.2');
        assert.equal(manual.fieldSources.osVersion, 'manual');
      } else if (actualVersion) {
        const rejected = await worker.fetch(request('/api/session/details', {
          method: 'POST', cookie, body: { fields: { osVersion: '27.0.4' } }
        }), env);
        assert.equal(rejected.status, 409);
        assert.equal((await rejected.json()).error.code, 'profile_value_read_only');
      }
    }
  } finally {
    DB.close();
  }
});

test('系统成功回传以不可缓存的301返回绝对同源根站，跳转不携任何会话秘密', async () => {
  for (const origin of ['https://collector-one.example.test', 'https://collector-two.example.test:8443']) {
    const DB = database();
    const env = { DB };
    try {
      const create = await worker.fetch(request('/api/session', { origin, method: 'POST', body: { consent: true }, headers: { Origin: origin } }), env);
      assert.equal(create.status, 201);
      const cookie = create.headers.get('Set-Cookie').split(';')[0];
      const profile = await (await worker.fetch(request('/profile.mobileconfig', { origin, cookie }), env)).text();
      const callback = new URL(profile.match(/<key>URL<\/key><string>([^<]+)<\/string>/)[1]);
      const challenge = profile.match(/<key>Challenge<\/key><string>([^<]+)<\/string>/)[1];
      assert.equal(callback.origin, origin);
      const body = sign(deviceXml(challenge));
      const receive = await worker.fetch(request(callback.pathname + '?redirect=https%3A%2F%2Funtrusted.invalid', {
        origin, method: 'POST', body, headers: { Origin: 'https://untrusted.invalid' }
      }), env);
      assert.equal(receive.status, 301);
      const location = receive.headers.get('Location');
      assert.equal(location, `${origin}/?collected=1`);
      assert.equal(new URL(location).origin, origin);
      for (const secret of [TEST_UDID, TEST_IMEI, challenge, cookie, cookie.split('=')[1], callback.pathname.split('/').at(-1)]) {
        assert.ok(!location.includes(secret));
      }
      assert.match(receive.headers.get('Cache-Control'), /no-store/);
      assert.equal(receive.headers.get('Referrer-Policy'), 'no-referrer');
      assert.equal(receive.headers.has('Set-Cookie'), false);
      assert.equal(await receive.text(), '');
      const result = await worker.fetch(request('/api/session', { origin, cookie }), env);
      assert.equal((await result.json()).session.state, 'received');
      assert.equal((await (await worker.fetch(request('/api/session', { origin }), env)).json()).session, null);
      const replay = await worker.fetch(request(callback.pathname, { origin, method: 'POST', body }), env);
      assert.equal(replay.status, 409);
      assert.equal(replay.headers.has('Location'), false);
    } finally {
      DB.close();
    }
  }
});

test('电脑二维码配对：同意后一次认领、双端同步、手机专属描述文件与双端清除', async () => {
  const DB = database();
  const env = { DB };
  try {
    const create = await worker.fetch(request('/api/pair', { method: 'POST', body: {} }), env);
    assert.equal(create.status, 201);
    const desktopCookie = create.headers.get('Set-Cookie').split(';')[0];
    const created = await create.json();
    assert.match(created.pairToken, /^[0-9a-f]{64}$/);
    assert.equal(created.session.paired, true);
    assert.equal(created.session.role, 'desktop');
    assert.equal(created.session.canDownload, false);
    const desktopProfile = await worker.fetch(request('/profile.mobileconfig', { cookie: desktopCookie }), env);
    assert.equal(desktopProfile.status, 403);
    const noConsent = await worker.fetch(request('/api/pair/claim', { method: 'POST', body: { token: created.pairToken } }), env);
    assert.equal(noConsent.status, 400);
    const claim = await worker.fetch(request('/api/pair/claim', { method: 'POST', body: { token: created.pairToken, consent: true } }), env);
    assert.equal(claim.status, 200);
    const phoneCookie = claim.headers.get('Set-Cookie').split(';')[0];
    assert.notEqual(phoneCookie, desktopCookie);
    const claimed = await claim.json();
    assert.equal(claimed.session.role, 'phone');
    assert.equal(claimed.session.canDownload, true);
    const repeat = await worker.fetch(request('/api/pair/claim', { method: 'POST', body: { token: created.pairToken, consent: true } }), env);
    assert.equal(repeat.status, 410);
    const wrongCookieRepeat = await worker.fetch(request('/api/pair/claim', {
      method: 'POST', cookie: desktopCookie, body: { token: created.pairToken, consent: true }
    }), env);
    assert.equal(wrongCookieRepeat.status, 410);
    const validRepeat = await worker.fetch(request('/api/pair/claim', {
      method: 'POST', cookie: phoneCookie, body: { token: created.pairToken, consent: true }
    }), env);
    assert.equal(validRepeat.status, 200);
    assert.equal(validRepeat.headers.get('Set-Cookie').split(';')[0], phoneCookie);
    const repeatedSession = (await validRepeat.json()).session;
    assert.equal(repeatedSession.expiresAt, claimed.session.expiresAt);
    assert.equal(repeatedSession.role, 'phone');
    const stored = DB.sqlite.prepare('SELECT * FROM sessions').get();
    assert.match(stored.pair_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(stored).includes(created.pairToken));
    assert.ok(!JSON.stringify(stored).includes(phoneCookie.split('=')[1]));
    const profileResponse = await worker.fetch(request('/profile.mobileconfig', { cookie: phoneCookie }), env);
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.text();
    const callback = new URL(profile.match(/<key>URL<\/key><string>([^<]+)<\/string>/)[1]);
    const challenge = profile.match(/<key>Challenge<\/key><string>([^<]+)<\/string>/)[1];
    const receive = await worker.fetch(request(callback.pathname, { method: 'POST', body: sign(deviceXml(challenge)) }), env);
    assert.equal(receive.status, 301);
    const desktopResult = await worker.fetch(request('/api/session', { cookie: desktopCookie }), env);
    const phoneResult = await worker.fetch(request('/api/session', { cookie: phoneCookie }), env);
    const desktop = (await desktopResult.json()).session;
    const phone = (await phoneResult.json()).session;
    assert.equal(desktop.role, 'desktop');
    assert.equal(phone.role, 'phone');
    assert.equal(desktop.state, 'received');
    assert.deepEqual(desktop.device, phone.device);
    assert.equal(phone.device.udid, TEST_UDID);
    assert.equal(desktop.canDownload, false);
    assert.equal(phone.canDownload, false);
    const completedRepeat = await worker.fetch(request('/api/pair/claim', {
      method: 'POST', cookie: phoneCookie, body: { token: created.pairToken, consent: true }
    }), env);
    assert.equal(completedRepeat.status, 200);
    assert.equal((await completedRepeat.json()).session.state, 'received');
    const supplement = await worker.fetch(request('/api/session/imei', { method: 'POST', cookie: desktopCookie, body: { imei: TEST_IMEI } }), env);
    assert.equal((await supplement.json()).session.role, 'desktop');
    const remove = await worker.fetch(request('/api/session', { method: 'DELETE', cookie: phoneCookie }), env);
    assert.equal(remove.status, 200);
    const desktopGone = await worker.fetch(request('/api/session', { cookie: desktopCookie }), env);
    assert.equal((await desktopGone.json()).session, null);
  } finally {
    DB.close();
  }
});

test('重新生成二维码作废旧配对；二维码过期不可认领；直接手机流程保持可下载', async () => {
  const DB = database();
  const env = { DB };
  try {
    const first = await worker.fetch(request('/api/pair', { method: 'POST', body: {} }), env);
    const cookie = first.headers.get('Set-Cookie').split(';')[0];
    const oldToken = (await first.json()).pairToken;
    const second = await worker.fetch(request('/api/pair', { method: 'POST', cookie, body: {} }), env);
    const newToken = (await second.json()).pairToken;
    assert.notEqual(oldToken, newToken);
    const invalidated = await worker.fetch(request('/api/pair/claim', { method: 'POST', body: { token: oldToken, consent: true } }), env);
    assert.equal(invalidated.status, 410);
    DB.sqlite.prepare('UPDATE sessions SET expires_at = ?').run(Math.floor(Date.now() / 1000) - 1);
    const expired = await worker.fetch(request('/api/pair/claim', { method: 'POST', body: { token: newToken, consent: true } }), env);
    assert.equal(expired.status, 410);
    const direct = await worker.fetch(request('/api/session', { method: 'POST', body: { consent: true } }), env);
    const directCookie = direct.headers.get('Set-Cookie').split(';')[0];
    const directResult = (await direct.json()).session;
    assert.equal(directResult.paired, false);
    assert.equal(directResult.role, 'phone');
    assert.equal(directResult.canDownload, true);
    const directProfile = await worker.fetch(request('/profile.mobileconfig', { cookie: directCookie }), env);
    assert.equal(directProfile.status, 200);
  } finally {
    DB.close();
  }
});
