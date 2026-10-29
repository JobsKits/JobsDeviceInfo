import * as asn1js from 'asn1js';
import { ContentInfo, SignedData, CryptoEngine, setEngine } from 'pkijs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const MAX_BODY_BYTES = 512 * 1024;
export const UDID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{16})$/i;
export const DEVICE_DETAIL_FIELDS = Object.freeze([
  'imei', 'imei2', 'iccid', 'meid', 'osVersion', 'modelName', 'serial', 'modelNumber', 'seid'
]);
const OPTIONAL_DETAIL_ATTRIBUTES = new Set(['IMEI2', 'ICCID', 'MEID', 'OS_VERSION', 'MODEL_NAME', 'MODEL', 'SEID']);

export class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CALLBACK_ERROR_CODES = new Set([
  'empty_body', 'body_too_large', 'invalid_cms', 'invalid_plist', 'invalid_challenge',
  'challenge_mismatch', 'invalid_udid', 'invalid_imei', 'invalid_device_field'
]);
const CALLBACK_STAGES = new Set(['body', 'decode', 'envelope', 'schema', 'signature', 'text', 'plist', 'challenge', 'device']);
const CALLBACK_ALGORITHM_OIDS = new Set([
  '1.3.14.3.2.26',
  '2.16.840.1.101.3.4.2.1', '2.16.840.1.101.3.4.2.2', '2.16.840.1.101.3.4.2.3', '2.16.840.1.101.3.4.2.4',
  '1.2.840.113549.1.1.1', '1.2.840.113549.1.1.5', '1.2.840.113549.1.1.10',
  '1.2.840.113549.1.1.11', '1.2.840.113549.1.1.12', '1.2.840.113549.1.1.13',
  '1.2.840.10045.4.1', '1.2.840.10045.4.3.1', '1.2.840.10045.4.3.2', '1.2.840.10045.4.3.3', '1.2.840.10045.4.3.4',
  '1.3.101.112', '1.3.101.113'
]);
const CALLBACK_ERROR_TYPES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'DataError', 'NotSupportedError', 'OperationError', 'InvalidAccessError',
  'SignedDataVerifyError', 'AsnError', 'ArgumentError', 'ParameterError'
]);

// 诊断只允许固定分类及常见算法标识，不接收异常原文或设备字段。
export function callbackDiagnostic(error, fallbackStage = 'decode') {
  const source = error?.diagnostic || {};
  const result = {
    code: CALLBACK_ERROR_CODES.has(error?.code) ? error.code : 'callback_rejected',
    stage: CALLBACK_STAGES.has(source.stage) ? source.stage : CALLBACK_STAGES.has(fallbackStage) ? fallbackStage : 'decode'
  };
  for (const key of ['digestAlgorithmOID', 'signatureAlgorithmOID']) {
    if (typeof source[key] === 'string') result[key] = CALLBACK_ALGORITHM_OIDS.has(source[key]) ? source[key] : 'unsupported';
  }
  if (CALLBACK_ERROR_TYPES.has(source.errorType)) result.errorType = source.errorType;
  if (Number.isInteger(source.verificationCode) && source.verificationCode >= 0 && source.verificationCode <= 99) {
    result.verificationCode = source.verificationCode;
  }
  return result;
}

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[char]);
}

export function buildProfile({ callbackUrl, challenge }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><dict>
<key>URL</key><string>${escapeXml(callbackUrl)}</string>
<key>DeviceAttributes</key><array><string>UDID</string><string>IMEI</string><string>ICCID</string><string>MEID</string><string>PRODUCT</string><string>VERSION</string><string>SERIAL</string></array>
<key>Challenge</key><string>${escapeXml(challenge)}</string>
</dict>
<key>PayloadDescription</key><string>经你确认后，将本机 UDID、可用的 IMEI、ICCID、MEID、设备型号、系统版本或构建号及序列号发送到此网站。系统未回传的字段保持空白，可另行手动补录。结果 15 分钟后失效。此流程不注册 MDM，不配置 VPN、代理或根证书。</string>
<key>PayloadDisplayName</key><string>Jobs 设备信息采集</string>
<key>PayloadIdentifier</key><string>com.jobs.deviceinfo.profile-service</string>
<key>PayloadOrganization</key><string>JobsDeviceInfo</string>
<key>PayloadType</key><string>Profile Service</string>
<key>PayloadUUID</key><string>${crypto.randomUUID()}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>`;
}

export async function readLimitedBody(request, maximum = MAX_BODY_BYTES) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    throw new RequestError(413, 'body_too_large', '回传内容超过允许大小。');
  }
  if (!request.body) {
    throw new RequestError(400, 'empty_body', '请求内容为空。');
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new RequestError(413, 'body_too_large', '回传内容超过允许大小。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// 仅接受平面设备属性，避免 XML 实体、重复键或嵌套容器改变字段含义。
export function parseDevicePlist(xml) {
  if (typeof xml !== 'string' || new TextEncoder().encode(xml).length > MAX_BODY_BYTES) {
    throw new RequestError(400, 'invalid_plist', '设备信息格式不正确。');
  }
  if (/<!ENTITY/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) {
    throw new RequestError(400, 'invalid_plist', '设备信息不支持 XML 实体。');
  }
  const withoutDoctype = xml.replace(/<!DOCTYPE\s+plist\s+PUBLIC\s+"[^"<>]*"\s+"https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd"\s*>/i, '');
  if (/<!DOCTYPE/i.test(withoutDoctype) || XMLValidator.validate(withoutDoctype) !== true) {
    throw new RequestError(400, 'invalid_plist', '设备信息 XML 无法解析。');
  }
  const nodes = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: true,
    ignoreDeclaration: true,
    commentPropName: false
  }).parse(withoutDoctype);
  const roots = nodes.filter((node) => Object.keys(node).some((name) => !name.startsWith('?') && name !== '#text'));
  if (roots.length !== 1 || !Array.isArray(roots[0].plist)) {
    throw new RequestError(400, 'invalid_plist', '缺少 plist 根节点。');
  }
  const containers = roots[0].plist.filter((node) => !('#text' in node));
  if (containers.length !== 1 || !Array.isArray(containers[0].dict)) {
    throw new RequestError(400, 'invalid_plist', '设备信息必须是单个字典。');
  }
  const entries = containers[0].dict.filter((node) => !('#text' in node));
  if (entries.length > 80 || entries.length % 2 !== 0) {
    throw new RequestError(400, 'invalid_plist', '设备信息字段数量不正确。');
  }
  const values = Object.create(null);
  const scalar = (node, tag) => {
    if (!Array.isArray(node[tag])) throw new RequestError(400, 'invalid_plist', '设备信息含不支持的字段类型。');
    if (node[tag].some((part) => Object.keys(part).some((key) => key !== '#text'))) {
      throw new RequestError(400, 'invalid_plist', '设备信息含嵌套字段。');
    }
    const result = node[tag].map((part) => part['#text'] ?? '').join('');
    if (result.length > 4096) throw new RequestError(400, 'invalid_plist', '设备信息字段过长。');
    return result;
  };
  for (let index = 0; index < entries.length; index += 2) {
    const key = scalar(entries[index], 'key');
    if (!/^[A-Z0-9_]{1,64}$/.test(key) || Object.hasOwn(values, key)) {
      throw new RequestError(400, 'invalid_plist', '设备信息含重复或无效字段。');
    }
    const valueNode = entries[index + 1];
    if ('string' in valueNode) {
      values[key] = scalar(valueNode, 'string');
    } else if ('data' in valueNode && key === 'CHALLENGE') {
      const encoded = scalar(valueNode, 'data').replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > 512) {
        throw new RequestError(400, 'invalid_challenge', '设备确认值格式不正确。');
      }
      try {
        values[key] = atob(encoded);
      } catch {
        throw new RequestError(400, 'invalid_challenge', '设备确认值无法解码。');
      }
    } else if (OPTIONAL_DETAIL_ATTRIBUTES.has(key)) {
      // 新增可选属性的未知类型不影响有效 UDID，也不保存其原始内容。
      values[key] = key === 'ICCID' ? null : '';
    } else {
      throw new RequestError(400, 'invalid_plist', '设备信息含不支持的字段类型。');
    }
  }
  return values;
}

// 只归一化明确的标识格式；未知字段值保持未取得，不把占位文字当编号。
export function normalizeDetailValue(key, value, { allowGrouping = true } = {}) {
  if (typeof value !== 'string' || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const text = value.trim();
  if (!text) return null;
  const grouped = /^[0-9A-Fa-f]+(?: +[0-9A-Fa-f]+|-[0-9A-Fa-f]+)*$/.test(text);
  const compact = allowGrouping && grouped ? text.replace(/[ -]/g, '') : text;
  switch (key) {
    case 'imei':
    case 'imei2':
      return /^\d{15}$/.test(compact) ? compact : null;
    case 'iccid':
      return /^\d{18,22}$/.test(compact) ? compact : null;
    case 'meid':
      return /^(?:[0-9A-Fa-f]{14}|\d{18})$/.test(compact) ? compact.toUpperCase() : null;
    case 'seid':
      return /^[0-9A-Fa-f]{16,128}$/.test(compact) && compact.length % 2 === 0 ? compact.toUpperCase() : null;
    case 'osVersion':
      return /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(text) ? text : null;
    case 'modelName':
      return text.length <= 80 ? text : null;
    case 'modelNumber':
      return /^[A-Za-z0-9][A-Za-z0-9/_ .-]{0,79}$/.test(text) ? text : null;
    case 'serial':
      return /^[A-Za-z0-9]{6,32}$/.test(text) ? text : null;
    default:
      return null;
  }
}

export function validateDevice(values) {
  const udid = (values.UDID || '').trim();
  if (!UDID_PATTERN.test(udid)) {
    throw new RequestError(400, 'invalid_udid', '设备回传的 UDID 格式不正确。');
  }
  const rawImei = typeof values.IMEI === 'string' ? values.IMEI : '';
  const textImei = rawImei.replace(/^ +| +$/g, '');
  const imei = normalizeDetailValue('imei', rawImei);
  const imeiStatus = imei ? 'provided' : textImei ? 'unrecognized_format' : 'not_returned';
  const field = (key) => {
    const text = (values[key] || '').trim();
    if (text.length > 160 || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new RequestError(400, 'invalid_device_field', '设备回传字段不正确。');
    }
    return text || null;
  };
  const version = field('VERSION');
  const device = {
    udid,
    imei,
    imeiSource: imei ? 'profile' : null,
    imeiStatus,
    product: field('PRODUCT'),
    version,
    serial: field('SERIAL'),
    imei2: normalizeDetailValue('imei2', values.IMEI2),
    iccid: normalizeDetailValue('iccid', values.ICCID),
    meid: normalizeDetailValue('meid', values.MEID),
    osVersion: normalizeDetailValue('osVersion', values.OS_VERSION) || normalizeDetailValue('osVersion', version),
    modelName: normalizeDetailValue('modelName', values.MODEL_NAME),
    modelNumber: normalizeDetailValue('modelNumber', values.MODEL),
    seid: normalizeDetailValue('seid', values.SEID)
  };
  device.fieldAvailability = {
    iccid: !Object.hasOwn(values, 'ICCID') ? 'not_returned'
      : typeof values.ICCID !== 'string' ? 'unsupported_type'
        : !values.ICCID.trim() ? 'empty'
          : device.iccid ? 'provided' : 'unrecognized_format'
  };
  device.fieldSources = Object.fromEntries(['udid', 'product', 'version', ...DEVICE_DETAIL_FIELDS]
    .filter((key) => device[key]).map((key) => [key, 'profile']));
  return device;
}

export async function decodeSignedDeviceResponse(bytes) {
  let stage = 'envelope';
  const algorithms = {};
  try {
    let der = bytes;
    const beginning = new TextDecoder().decode(bytes.subarray(0, 100));
    if (beginning.trimStart().startsWith('-----BEGIN')) {
      const pem = new TextDecoder().decode(bytes).trim();
      const match = pem.match(/^-----BEGIN (?:PKCS7|CMS)-----\s+([A-Za-z0-9+/=\s]+)-----END (?:PKCS7|CMS)-----$/);
      if (!match) throw new RequestError(400, 'invalid_cms', '设备签名封装不正确。');
      try {
        der = Uint8Array.from(atob(match[1].replace(/\s/g, '')), (char) => char.charCodeAt(0));
      } catch {
        throw new RequestError(400, 'invalid_cms', '设备签名封装无法解码。');
      }
    }
    stage = 'schema';
    setEngine('webcrypto', new CryptoEngine({ name: 'webcrypto', crypto, subtle: crypto.subtle }));
    const parsed = asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength));
    if (parsed.offset !== der.byteLength) throw new Error('Invalid BER');
    const content = new ContentInfo({ schema: parsed.result });
    if (content.contentType !== '1.2.840.113549.1.7.2') throw new Error('Expected signedData');
    const signed = new SignedData({ schema: content.content });
    if (signed.signerInfos.length !== 1 || signed.encapContentInfo.eContentType !== '1.2.840.113549.1.7.1') {
      throw new Error('Unsupported SignedData');
    }
    const embedded = signed.encapContentInfo.eContent;
    if (!embedded) throw new Error('Detached content is not accepted');
    algorithms.digestAlgorithmOID = signed.signerInfos[0].digestAlgorithm.algorithmId;
    algorithms.signatureAlgorithmOID = signed.signerInfos[0].signatureAlgorithm.algorithmId;
    stage = 'signature';
    const verified = await signed.verify({ signer: 0, checkChain: false });
    if (verified !== true) throw new Error('Invalid signature');
    stage = 'text';
    const payload = embedded.getValue();
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    stage = 'plist';
    return parseDevicePlist(xml);
  } catch (error) {
    const rejected = error instanceof RequestError ? error : new RequestError(400, 'invalid_cms', '回传必须包含有效的 CMS 内容签名；无法处理此设备回传。');
    rejected.diagnostic = callbackDiagnostic({
      code: rejected.code,
      diagnostic: { stage, ...algorithms, errorType: error?.name, verificationCode: error?.code }
    }, stage);
    throw rejected;
  }
}
