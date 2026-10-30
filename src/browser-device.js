/* JobsDeviceInfo · Created by Jobs. */
import { RequestError } from './profile.js';

const PLATFORMS = new Set(['ios', 'android', 'harmonyos', 'unknown']);
const PLATFORM_NAMES = { ios: 'iOS / iPadOS', android: 'Android', harmonyos: '鸿蒙 HarmonyOS', unknown: '未识别系统' };
const BROWSER_KEYS = new Set(['userAgent', 'clientHints', 'language', 'screen']);
const HINT_KEYS = new Set(['platform', 'platformVersion', 'model', 'architecture', 'bitness', 'mobile']);
const NON_MODEL = /^(?:K|Unknown(?: Device| Model)?|Generic|Android|Mobile|Unavailable|null|undefined|N\/A|未知|未返回)$/i;

function invalid() {
  throw new RequestError(400, 'invalid_browser_device', '浏览器设备信息格式不正确，请刷新后重试。');
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key))) invalid();
}

function text(value, maximum, optional = true) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value.trim();
}

export function detectBrowserPlatform(userAgent, hints = {}) {
  if (/HarmonyOS|OpenHarmony|\bOHOS\b/i.test(userAgent) || /HarmonyOS|OpenHarmony|\bOHOS\b/i.test(hints.platform || '')) return 'harmonyos';
  if (/iPhone|iPad|iPod/i.test(userAgent) || /^(?:iOS|iPadOS)$/i.test(hints.platform || '')) return 'ios';
  if (/Android/i.test(userAgent) || /^Android$/i.test(hints.platform || '')) return 'android';
  return 'unknown';
}

function browserName(ua) {
  for (const [pattern, name] of [
    [/MicroMessenger/i, '微信内置浏览器'], [/HUAWEIBrowser|HuaweiBrowser|HBPC/i, '华为浏览器'],
    [/Edg(?:e|A|iOS)?\//i, 'Microsoft Edge'], [/Firefox\/|FxiOS\//i, 'Firefox'],
    [/SamsungBrowser\//i, 'Samsung Internet'], [/OPR\/|OPiOS\//i, 'Opera'],
    [/Chrome\/|CriOS\//i, 'Chrome'], [/Safari\//i, 'Safari']
  ]) {
    if (pattern.test(ua)) return name;
  }
  return null;
}

function uaVersion(ua, platform) {
  if (platform === 'android' && /Android 10;\s*K(?:[\s;)]|$)/i.test(ua)) return null;
  const match = platform === 'harmonyos' ? ua.match(/(?:HarmonyOS|OpenHarmony|\bOHOS)[\/\s]+(\d+(?:[._]\d+){0,3})/i)
    : platform === 'ios' ? ua.match(/(?:CPU(?: iPhone)? OS|iPhone OS)[\s]+(\d+(?:[._]\d+){0,3})/i)
      : platform === 'android' ? ua.match(/Android[\s/]+(\d+(?:[._]\d+){0,3})/i) : null;
  return match ? match[1].replaceAll('_', '.') : null;
}

function uaModel(ua, platform) {
  if (!['android', 'harmonyos'].includes(platform)) return null;
  const section = ua.match(/\(([^)]+)\)/)?.[1] || '';
  const part = section.split(';').find((entry) => /\sBuild\//i.test(entry));
  const model = part?.split(/\sBuild\//i)[0].trim();
  // Chromium 的缩减 UA 用 K 代替真实型号，不能作为采集到的机型。
  return model && !NON_MODEL.test(model) && !/^(?:Android.*|Linux.*|wv)$/i.test(model) && model.length <= 80 ? model : null;
}

export function validateBrowserDevice(body) {
  object(body, new Set(['consent', 'platform', 'platformSource', 'browser']));
  if (body.consent !== true) throw new RequestError(400, 'consent_required', '请先确认设备信息采集说明。');
  if (!PLATFORMS.has(body.platform) || !['detected', 'selected'].includes(body.platformSource)) invalid();
  object(body.browser, BROWSER_KEYS);
  const userAgent = text(body.browser.userAgent, 1024, false);
  if (!userAgent) invalid();
  const browser = { userAgent };
  if (body.browser.clientHints !== undefined) {
    object(body.browser.clientHints, HINT_KEYS);
    const hints = {};
    for (const key of ['platform', 'platformVersion', 'model', 'architecture', 'bitness']) {
      if (body.browser.clientHints[key] !== undefined) hints[key] = text(body.browser.clientHints[key], key === 'model' ? 80 : 40);
    }
    if (body.browser.clientHints.mobile !== undefined) {
      if (typeof body.browser.clientHints.mobile !== 'boolean') invalid();
      hints.mobile = body.browser.clientHints.mobile;
    }
    browser.clientHints = hints;
  }
  if (body.browser.language !== undefined) {
    const language = text(body.browser.language, 40);
    if (language && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)) invalid();
    browser.language = language;
  }
  if (body.browser.screen !== undefined) {
    const screen = body.browser.screen;
    object(screen, new Set(['width', 'height', 'pixelRatio']));
    if (![screen.width, screen.height].every((value) => Number.isInteger(value) && value > 0 && value <= 16384)
      || !Number.isFinite(screen.pixelRatio) || screen.pixelRatio < 0.1 || screen.pixelRatio > 16) invalid();
    browser.screen = { width: screen.width, height: screen.height, pixelRatio: screen.pixelRatio };
  }
  const hints = browser.clientHints || {};
  const detected = detectBrowserPlatform(userAgent, hints);
  // iPad 的桌面模式只暴露 Macintosh；客户端通过触控能力识别后仍标为浏览器推导。
  const desktopIpad = body.platform === 'ios' && /Macintosh/.test(userAgent);
  const platform = body.platformSource === 'selected' ? body.platform : desktopIpad ? 'ios' : detected;
  const fieldSources = { platformName: body.platformSource === 'selected' ? 'selected' : 'browser' };
  const device = {
    platform, platformName: PLATFORM_NAMES[platform], platformSource: body.platformSource,
    collectionMethod: 'browser', browser, fieldSources,
    browserName: browserName(userAgent), language: browser.language || null,
    screenSize: browser.screen ? `${browser.screen.width} × ${browser.screen.height} CSS px · ${browser.screen.pixelRatio}×` : null,
    modelName: uaModel(userAgent, platform), osVersion: uaVersion(userAgent, platform),
    imeiStatus: 'browser_restricted', iccidStatus: 'browser_restricted'
  };
  for (const key of ['browserName', 'language', 'screenSize', 'modelName', 'osVersion']) {
    if (device[key]) fieldSources[key] = 'browser';
  }
  // UA-CH 只覆盖其实际声明的系统，Android 兼容层版本不能冒充鸿蒙版本。
  const hintPlatform = detectBrowserPlatform('', hints);
  if (hintPlatform === platform && platform !== 'unknown') {
    if (/^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(hints.platformVersion || '')) {
      device.osVersion = hints.platformVersion;
      fieldSources.osVersion = 'browser-hint';
    }
  }
  if (hints.model && !NON_MODEL.test(hints.model) && ['android', 'harmonyos'].includes(platform)) {
    device.modelName = hints.model;
    fieldSources.modelName = 'browser-hint';
  }
  return device;
}
