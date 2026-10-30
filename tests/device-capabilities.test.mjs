import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/device-capabilities.js';

const { detect, collect } = globalThis.JobsDeviceBrowser;

test('三端识别覆盖 iPad 桌面 UA、鸿蒙标识和内置浏览器', () => {
  assert.deepEqual(detect({ userAgent: 'iPhone OS 18_0 AppleWebKit Safari/604.1' }), { platform: 'ios', mobile: true, safari: true });
  assert.deepEqual(detect({ userAgent: 'Macintosh Safari/604.1', maxTouchPoints: 5 }), { platform: 'ios', mobile: true, safari: true });
  assert.equal(detect({ userAgent: 'iPhone Safari/604.1 MicroMessenger/8' }).safari, false);
  assert.equal(detect({ userAgent: '(Linux; Android 12; TEST Build/TEST) Chrome/120 Mobile' }).platform, 'android');
  assert.equal(detect({ userAgent: '(Linux; Android 12; TEST) HuaweiBrowser/14' }).platform, 'android');
  for (const userAgent of ['(HarmonyOS 3.0.0) HuaweiBrowser/14', '(Phone; OpenHarmony 6.0) ArkWeb/5 Mobile', 'OHOS/5.0']) {
    assert.equal(detect({ userAgent }).platform, 'harmonyos');
  }
  assert.deepEqual(detect({ userAgent: 'Macintosh Safari/604.1', maxTouchPoints: 0 }), { platform: 'unknown', mobile: false, safari: false });
  assert.equal(detect({ userAgent: 'Desktop', userAgentData: { platform: 'Android' } }).mobile, true);
});

test('不支持或拒绝 UA-CH 时保留基础信息，白名单不包含硬件编号', async () => {
  const result = await collect({ userAgent: 'TEST Android', language: 'zh-CN' }, { width: 390, height: 844 }, 3);
  assert.deepEqual(result, { userAgent: 'TEST Android', language: 'zh-CN', screen: { width: 390, height: 844, pixelRatio: 3 } });
  const rejected = await collect({ userAgent: 'TEST', userAgentData: { platform: 'Android', mobile: true, getHighEntropyValues: async () => { throw new Error('denied'); } } }, {});
  assert.deepEqual(rejected.clientHints, { platform: 'Android', mobile: true });
});

test('只提交允许的 UA-CH 字段，截断长度与服务端契约一致', async () => {
  const result = await collect({
    userAgent: 'TEST', userAgentData: { platform: 'Android', mobile: true, getHighEntropyValues: async () => ({
      platformVersion: '15.0.0', model: 'M'.repeat(100), architecture: 'arm', bitness: '64', serial: 'MUST NOT SUBMIT'
    }) }
  }, {});
  assert.equal(result.clientHints.model.length, 80);
  assert.equal(result.clientHints.platformVersion, '15.0.0');
  assert.equal(Object.hasOwn(result.clientHints, 'serial'), false);
});

test('UA-CH 卡住时限时回退，扫码不会无限等待', async () => {
  const before = Date.now();
  const result = await collect({ userAgent: 'TEST', userAgentData: { platform: 'Android', mobile: true, getHighEntropyValues: () => new Promise(() => {}) } }, {});
  assert.deepEqual(result.clientHints, { platform: 'Android', mobile: true });
  assert.ok(Date.now() - before < 3000);
});
