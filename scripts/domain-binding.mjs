import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Reject partial, conflicting or destructive plans before any binding mutation.
export function assertSafeChangeset(changeset, hostname) {
  for (const name of ['added', 'removed', 'updated', 'conflicting']) {
    if (!Array.isArray(changeset?.[name])) throw new Error('Cloudflare 域名变更预览结构不完整，停止绑定。');
  }
  if (changeset.removed.length || changeset.conflicting.length) throw new Error('自定义域名存在 DNS 冲突或将移除既有绑定，停止操作；不会覆盖。');
  if ([...changeset.added, ...changeset.updated].some((entry) => entry.hostname !== hostname)) throw new Error('Cloudflare 变更预览包含配置之外的域名，停止绑定。');
}

function authHeaders(projectDir) {
  let credentials;
  try {
    const output = execFileSync(path.join(projectDir, 'node_modules', '.bin', 'wrangler'), ['auth', 'token', '--json', '--config', path.join(projectDir, '.deploy', 'wrangler.json')], {
      cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '/dev/null', NO_COLOR: '1' },
    });
    credentials = JSON.parse(output);
  } catch {
    throw new Error('无法在进程内读取既有 Wrangler 授权；未执行自定义域名绑定。');
  }
  if (['oauth', 'api_token'].includes(credentials.type) && typeof credentials.token === 'string' && /^[A-Za-z0-9._~-]+$/.test(credentials.token)) {
    return [`Authorization: Bearer ${credentials.token}`];
  }
  if (credentials.type === 'api_key' && /^[A-Za-z0-9_-]+$/.test(credentials.key ?? '') && /^[^\r\n"]+@[^\r\n"]+$/.test(credentials.email ?? '')) {
    return [`X-Auth-Key: ${credentials.key}`, `X-Auth-Email: ${credentials.email}`];
  }
  throw new Error('当前 Wrangler 授权格式不支持安全的独立域名绑定。');
}

function apiRequest(headers, endpoint, method, body, proxyURL) {
  const config = [...headers.map((header) => `header = ${JSON.stringify(header)}`), 'header = "Content-Type: application/json"'].join('\n');
  const network = proxyURL ? ['--proxy', proxyURL, '--noproxy', ''] : ['--proxy', '', '--noproxy', '*'];
  const args = ['--config', '-', '--silent', '--show-error', '--fail-with-body', '--connect-timeout', '10', '--max-time', '35', ...network, '--request', method, `https://api.cloudflare.com/client/v4${endpoint}`];
  if (body !== undefined) args.push('--data-binary', JSON.stringify(body));
  let response;
  try {
    response = execFileSync('/usr/bin/curl', args, { input: config, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 40000 });
  } catch (error) {
    let codes = '';
    try { codes = JSON.parse(String(error.stdout)).errors?.map((entry) => entry.code).join(',') || ''; } catch {}
    throw new Error(`Cloudflare 自定义域名 API 请求失败${codes ? `（错误码 ${codes}）` : ''}；未放开覆盖限制。`);
  }
  let result;
  try { result = JSON.parse(response); } catch { throw new Error('Cloudflare 自定义域名 API 返回无法解析，停止。'); }
  if (!result.success) throw new Error('Cloudflare 拒绝自定义域名操作；不会尝试覆盖现有记录。');
  return result.result;
}

export async function bindCustomDomain(projectDir, settings, proxyURL = '') {
  if (!settings.custom_domain) return;
  if (proxyURL && !/^http:\/\/(?:[A-Za-z0-9.-]+|\[[a-fA-F0-9:]+\]):\d{1,5}$/.test(proxyURL)) throw new Error('系统代理地址格式不正确。');
  const config = JSON.parse(fs.readFileSync(path.join(projectDir, '.deploy', 'wrangler.json'), 'utf8'));
  const endpoint = `/accounts/${config.account_id}/workers/scripts/${settings.worker_name}`;
  const headers = authHeaders(projectDir);
  const origins = [{ hostname: settings.custom_domain, enabled: true, previews_enabled: false }];
  const changeset = apiRequest(headers, `${endpoint}/domains/changeset?replace_state=false`, 'POST', origins, proxyURL);
  assertSafeChangeset(changeset, settings.custom_domain);
  for (const entry of changeset.updated) {
    if (!entry.id) throw new Error('既有域名缺少可验证的绑定 ID，停止操作。');
    const existing = apiRequest(headers, `/accounts/${config.account_id}/workers/domains/records/${encodeURIComponent(entry.id)}`, 'GET', undefined, proxyURL);
    if (existing.hostname !== settings.custom_domain || existing.service !== settings.worker_name) throw new Error('该域名已属于其它服务，停止绑定；不会接管。');
  }
  apiRequest(headers, `${endpoint}/domains/records`, 'PUT', {
    override_scope: false, override_existing_origin: false, override_existing_dns_record: false, origins,
  }, proxyURL);
  console.log(`✔ 已安全绑定独立自定义域名：https://${settings.custom_domain}`);
  console.log('Cloudflare 负责该域名的 DNS 与 TLS；未启用既有 DNS / 其它 Worker 覆盖。');
}
