import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = new URL(process.argv[2] || 'http://127.0.0.1:8787');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  throw new Error('此测试仅允许本机服务，禁止向真实网站写入模拟设备信息。');
}
const jsonHeaders = { 'content-type': 'application/json', origin: base.origin };
let cookie = '';
const cleanupCookies = new Set();
const call = (path, init = {}) => fetch(new URL(path, base), {
  ...init,
  headers: { ...jsonHeaders, ...(cookie ? { cookie } : {}), ...init.headers },
  redirect: 'manual',
});
const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const workDir = mkdtempSync(join(tmpdir(), 'jobs-device-local-test-'));
let checks = 0;
function check(value, expected, label) {
  assert.equal(value, expected, label);
  checks += 1;
  console.log(`✔ ${label}`);
}
try {
  check((await (await call('/api/health')).json()).ok, true, '服务健康');
  const first = await call('/api/session');
  check((await first.json()).session, null, '没有会话时不泄露任何结果');
  const denied = await call('/api/session', { method: 'POST', body: JSON.stringify({ consent: false }) });
  check(denied.status >= 400, true, '没有同意时不创建采集会话');
  const forged = await call('/api/session', { method: 'POST', headers: { origin: 'https://unrelated.example' }, body: '{"consent":true}' });
  check(forged.status, 403, '跨站创建请求被拒绝');
  const created = await call('/api/session', { method: 'POST', body: '{"consent":true}' });
  check(created.status < 300, true, '同意后成功创建会话');
  cookie = created.headers.get('set-cookie')?.split(';')[0] || '';
  check(Boolean(cookie), true, '服务器发出会话Cookie');
  const createdData = await created.json();
  const profile = await call(createdData.session.profileUrl);
  check(profile.status, 200, '描述文件可以下载');
  const text = await profile.text();
  check(text.includes('<string>Profile Service</string>'), true, '描述文件为Profile Service');
  check(/com\.apple\.(mdm|vpn|security\.root)/.test(text), false, '描述文件不包含MDM、VPN或根证书载荷');
  const callback = text.match(/<key>URL<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.replaceAll('&amp;', '&');
  const challenge = text.match(/<key>Challenge<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.ok(callback && challenge, '描述文件必须携带回调及Challenge');
  const udid = '00008110-0012345678901234';
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>UDID</key><string>${udid}</string><key>CHALLENGE</key><string>${xmlEscape(challenge)}</string><key>PRODUCT</key><string>iPhoneTEST,1</string><key>VERSION</key><string>TEST_BUILD</string></dict></plist>`;
  const plain = await call(callback, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: plist });
  check(plain.status >= 400, true, '拒绝未经CMS签名的明文回传');
  writeFileSync(join(workDir, 'payload.plist'), plist);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(workDir, 'test.key'), '-out', join(workDir, 'test.crt'), '-subj', '/CN=LOCAL TEST ONLY', '-days', '1'], { stdio: 'ignore' });
  execFileSync('openssl', ['cms', '-sign', '-binary', '-nodetach', '-in', join(workDir, 'payload.plist'), '-signer', join(workDir, 'test.crt'), '-inkey', join(workDir, 'test.key'), '-outform', 'DER', '-out', join(workDir, 'signed.der')], { stdio: 'ignore' });
  const signed = readFileSync(join(workDir, 'signed.der'));
  const posted = await call(callback, { method: 'POST', headers: { 'content-type': 'application/pkcs7-signature' }, body: signed });
  if (posted.status !== 301) console.log('回调诊断:', await posted.clone().text());
  check(posted.status, 301, 'CMS设备回传写入真实本地D1并按Profile Service方式跳转');
  check(posted.headers.get('location'), new URL('/?collected=1', base).href, '跳转使用绝对同源首页且不携带设备编号');
  check(posted.headers.get('location')?.includes(udid), false, '跳转地址不泄露设备标识');
  const status = await (await call('/api/session')).json();
  check(status.session.state, 'received', '浏览器轮询得到完成状态');
  check(status.session.device.udid, udid, '浏览器读取本次会话的设备标识');
  check(status.session.verification, 'signature-only', '没有将自签名测试证书冒充苹果身份认证');
  const replay = await call(callback, { method: 'POST', headers: { 'content-type': 'application/pkcs7-signature' }, body: signed });
  check(replay.status >= 400, true, '拒绝重复使用已完成回调');
  const isolated = await fetch(new URL('/api/session', base));
  check((await isolated.json()).session, null, '另一浏览器无法查看当前设备信息');
  const invalidImei = await call('/api/session/imei', { method: 'POST', body: '{"imei":"123"}' });
  check(invalidImei.status >= 400, true, '拒绝格式错误的IMEI');
  const manual = await call('/api/session/imei', { method: 'POST', body: '{"imei":"490154203237518"}' });
  check(manual.status < 300, true, '支持有效IMEI手工补录');
  const manualData = await manual.json();
  check(manualData.session.device.imeiSource, 'manual', '手工输入明确标注来源');
  check((await call('/api/session', { method: 'DELETE' })).status < 300, true, '支持清除当前采集结果');
  check((await (await call('/api/session')).json()).session, null, '清除后无法继续读取');

  cookie = '';
  const initialPair = await call('/api/pair', { method: 'POST', body: '{}' });
  check(initialPair.status, 201, '电脑端可以建立二维码配对会话');
  const initialDesktopCookie = initialPair.headers.get('set-cookie')?.split(';')[0] || '';
  cleanupCookies.add(initialDesktopCookie);
  const initialPairData = await initialPair.json();
  check(/^[0-9a-f]{64}$/.test(initialPairData.pairToken), true, '二维码使用随机一次性配对令牌');

  cookie = initialDesktopCookie;
  const newPair = await call('/api/pair', { method: 'POST', body: '{}' });
  check(newPair.status, 201, '电脑重新生成二维码会建立新会话');
  const desktopCookie = newPair.headers.get('set-cookie')?.split(';')[0] || '';
  cleanupCookies.add(desktopCookie);
  const pairData = await newPair.json();
  const token = pairData.pairToken;
  check(pairData.session.role, 'desktop', '电脑会话明确标注desktop角色');
  check(pairData.session.paired, true, '二维码会话明确标注配对模式');
  check(pairData.session.canDownload, false, '电脑端不能下载手机采集描述文件');
  cookie = desktopCookie;
  const oldToken = await call('/api/pair/claim', { method: 'POST', headers: { cookie: '' }, body: JSON.stringify({ token: initialPairData.pairToken, consent: true }) });
  check(oldToken.status, 410, '重新生成后旧二维码不能再认领');
  const desktopProfileDenied = await call('/profile.mobileconfig');
  check(desktopProfileDenied.status, 403, '服务端拒绝电脑越权下载手机描述文件');
  const pairRead = await (await call('/api/session')).json();
  check(Object.hasOwn(pairRead.session, 'pairToken'), false, '轮询结果不会再次暴露二维码令牌');
  const notConsented = await call('/api/pair/claim', { method: 'POST', headers: { cookie: '' }, body: JSON.stringify({ token, consent: false }) });
  check(notConsented.status, 400, '手机没有同意时不认领二维码');
  const claimed = await call('/api/pair/claim', { method: 'POST', headers: { cookie: '' }, body: JSON.stringify({ token, consent: true }) });
  check(claimed.status, 200, '手机同意后成功认领二维码');
  const phoneCookie = claimed.headers.get('set-cookie')?.split(';')[0] || '';
  cleanupCookies.add(phoneCookie);
  check(Boolean(phoneCookie) && phoneCookie !== desktopCookie, true, '手机和电脑使用独立Cookie');
  const claimedData = await claimed.json();
  check(claimedData.session.role, 'phone', '手机会话明确标注phone角色');
  check(claimedData.session.canDownload, true, '配对完成后只有手机允许下载');
  const claimedAgain = await call('/api/pair/claim', { method: 'POST', headers: { cookie: '' }, body: JSON.stringify({ token, consent: true }) });
  check(claimedAgain.status, 410, '已认领二维码不能被其他浏览器重放使用');

  cookie = phoneCookie;
  const phoneProfile = await call('/profile.mobileconfig');
  check(phoneProfile.status, 200, '手机Cookie能下载配对会话的描述文件');
  const phoneText = await phoneProfile.text();
  const phoneCallback = phoneText.match(/<key>URL<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.replaceAll('&amp;', '&');
  const phoneChallenge = phoneText.match(/<key>Challenge<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.ok(phoneCallback && phoneChallenge, '手机描述文件必须携带专属回调及Challenge');
  const pairedUdid = '00008110-0098765432109876';
  const pairedPlist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>UDID</key><string>${pairedUdid}</string><key>CHALLENGE</key><string>${xmlEscape(phoneChallenge)}</string><key>PRODUCT</key><string>iPhonePAIRTEST,1</string><key>VERSION</key><string>PAIR_TEST_BUILD</string></dict></plist>`;
  writeFileSync(join(workDir, 'payload.plist'), pairedPlist);
  execFileSync('openssl', ['cms', '-sign', '-binary', '-nodetach', '-in', join(workDir, 'payload.plist'), '-signer', join(workDir, 'test.crt'), '-inkey', join(workDir, 'test.key'), '-outform', 'DER', '-out', join(workDir, 'paired.der')], { stdio: 'ignore' });
  const pairedSigned = readFileSync(join(workDir, 'paired.der'));
  const pairPosted = await call(phoneCallback, { method: 'POST', headers: { 'content-type': 'application/pkcs7-signature', cookie: '' }, body: pairedSigned });
  if (pairPosted.status !== 301) console.log('配对回调诊断:', await pairPosted.clone().text());
  check(pairPosted.status, 301, '系统签名回调不依赖浏览器Cookie即可写入配对会话');
  check(pairPosted.headers.get('location')?.includes(pairedUdid), false, '配对回调跳转不携带设备标识');
  const phoneStatus = (await (await call('/api/session')).json()).session;
  const desktopStatus = (await (await call('/api/session', { headers: { cookie: desktopCookie } })).json()).session;
  check(phoneStatus.state, 'received', '手机页面轮询自动得到完成状态');
  check(desktopStatus.state, 'received', '电脑原页面轮询自动得到同一完成状态');
  check(phoneStatus.device.udid, pairedUdid, '手机页面得到本次配对的设备标识');
  check(desktopStatus.device.udid, pairedUdid, '电脑页面同步得到手机回传的设备标识');
  check(desktopStatus.role, 'desktop', '共享结果仍保留电脑角色');
  check(phoneStatus.role, 'phone', '共享结果仍保留手机角色');
  check(JSON.stringify(phoneStatus.device), JSON.stringify(desktopStatus.device), '电脑和手机读取同一份设备结果');
  check(phoneStatus.verification, 'signature-only', '配对自签测试不冒充真实苹果设备认证');
  const pairedReplay = await call(phoneCallback, { method: 'POST', headers: { 'content-type': 'application/pkcs7-signature', cookie: '' }, body: pairedSigned });
  check(pairedReplay.status, 409, '配对系统回调不能重复上传覆盖结果');
  const pairIsolated = await call('/api/session', { headers: { cookie: '' } });
  check((await pairIsolated.json()).session, null, '第三浏览器无法查看电脑手机配对结果');
  const desktopManual = await call('/api/session/imei', { method: 'POST', headers: { cookie: desktopCookie }, body: '{"imei":"490154203237518"}' });
  check(desktopManual.status, 200, '电脑端可为共享会话补录IMEI');
  const phoneManualResult = (await (await call('/api/session')).json()).session;
  check(phoneManualResult.device.imeiSource, 'manual', '手机页面同步显示电脑补录来源');
  const detailFields = {
    imei2: '490154203237526', iccid: '89860000000000000000', meid: 'A0000000000001',
    osVersion: '26.0.1', modelName: 'Local Test Phone', serial: 'TESTSERIAL01',
    modelNumber: 'TEST001CH/A', seid: 'F'.repeat(48)
  };
  const details = await call('/api/session/details', {
    method: 'POST', headers: { cookie: desktopCookie }, body: JSON.stringify({ fields: detailFields })
  });
  check(details.status, 200, '关于本机补录通过真实HTTP写入本地D1');
  const sharedDetails = (await (await call('/api/session')).json()).session;
  for (const [key, value] of Object.entries(detailFields)) {
    check(sharedDetails.device[key], value, `${key}补录结果在手机同步`);
    check(sharedDetails.device.fieldSources[key], 'manual', `${key}明确标记手动来源`);
  }
  const forbiddenField = await call('/api/session/details', {
    method: 'POST', body: JSON.stringify({ fields: { udid: pairedUdid } })
  });
  check(forbiddenField.status, 400, '补录接口不允许修改UDID');
  const anonymousDetails = await call('/api/session/details', {
    method: 'POST', headers: { cookie: '' }, body: JSON.stringify({ fields: { modelName: 'Other Device' } })
  });
  check(anonymousDetails.status, 401, '无Cookie不能补录或查看当前结果');
  const pairRemoved = await call('/api/session', { method: 'DELETE' });
  check(pairRemoved.status, 200, '手机端可以清除整个配对会话');
  check((await (await call('/api/session')).json()).session, null, '清除后手机端不能继续读取');
  check((await (await call('/api/session', { headers: { cookie: desktopCookie } })).json()).session, null, '清除后电脑端同步失去结果');
  console.log(`\n本机端到端验证通过：${checks} 项。证书与设备标识均为测试夹具，未验证真实iPhone兼容性。`);
} finally {
  if (cookie) await call('/api/session', { method: 'DELETE' }).catch(() => {});
  for (const remainingCookie of cleanupCookies) {
    if (remainingCookie) await call('/api/session', { method: 'DELETE', headers: { cookie: remainingCookie } }).catch(() => {});
  }
  rmSync(workDir, { recursive: true, force: true });
}
