// Created by Jobs. Deployment metadata only; never reads Cloudflare credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2];
const settingsFile = path.join(projectDir, 'deploy.settings.json');
const placeholder = '00000000-0000-0000-0000-000000000000';

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function settings() {
  const value = readJSON(settingsFile);
  if (value.account_id && !/^[a-f0-9]{32}$/i.test(value.account_id)) throw new Error('account_id 必须是 32 位十六进制 ID。');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.worker_name ?? '')) throw new Error('worker_name 只能包含小写字母、数字和连字符，最长 63 位。');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value.database_name ?? '')) throw new Error('database_name 格式不正确。');
  if (value.custom_domain) {
    if (typeof value.custom_domain !== 'string' || value.custom_domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value.custom_domain)) throw new Error('custom_domain 只能是无协议、路径、端口或通配符的完整域名。');
    value.custom_domain = value.custom_domain.toLowerCase();
  }
  return value;
}

function readStdinJSON() {
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

function makeConfig(databaseID, accountID) {
  const input = settings();
  const config = readJSON(path.join(projectDir, 'wrangler.json'));
  const directory = path.join(projectDir, '.deploy');
  const selectedAccount = accountID || input.account_id;
  if (!/^[a-f0-9]{32}$/i.test(selectedAccount ?? '')) throw new Error('尚未选择有效 Cloudflare 账户。');
  if (!/^[a-f0-9-]{36}$/i.test(databaseID ?? '')) throw new Error('D1 database_id 格式不正确。');
  config.account_id = selectedAccount;
  config.name = input.worker_name;
  config.$schema = '../node_modules/wrangler/config-schema.json';
  config.main = '../src/index.js';
  config.assets.directory = '../public';
  delete config.route;
  config.routes = input.custom_domain ? [{ pattern: input.custom_domain, custom_domain: true }] : [];
  config.d1_databases = [{ binding: 'DB', database_name: input.database_name, database_id: databaseID, migrations_dir: '../migrations' }];
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

try {
  switch (action) {
    case 'settings': {
      const value = settings();
      console.log([value.account_id || '', value.worker_name, value.database_name].join('\t'));
      break;
    }
    case 'check': {
      const value = settings();
      const config = readJSON(path.join(projectDir, 'wrangler.json'));
      if (config.assets?.binding !== 'ASSETS' || config.d1_databases?.[0]?.binding !== 'DB') throw new Error('wrangler.json 必须声明 ASSETS 和 DB。');
      for (const file of ['package.json', 'package-lock.json', 'scripts/deploy-config.mjs']) {
        if (!fs.existsSync(path.join(projectDir, file))) throw new Error(`缺少 ${file}`);
      }
      console.log(`Worker: ${value.worker_name}\n数据库: ${value.database_name}\n账户: ${value.account_id || '部署时选择'}\n独立域名: ${value.custom_domain || '未配置，使用 workers.dev'}`);
      break;
    }
    case 'check-deps': {
      const pkg = readJSON(path.join(projectDir, 'package.json'));
      for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const installed = readJSON(path.join(projectDir, 'node_modules', name, 'package.json'));
        if (installed.version !== version) throw new Error(`${name} 版本不一致，需要 npm ci。`);
      }
      break;
    }
    case 'accounts': {
      const data = readStdinJSON();
      for (const entry of data.accounts ?? data.user?.accounts ?? []) {
        if (/^[a-f0-9]{32}$/i.test(entry.id ?? '')) console.log(`${entry.id}\t${String(entry.name ?? entry.id).replace(/[\r\n\t]/g, ' ')}`);
      }
      break;
    }
    case 'assert-account': {
      const target = process.argv[3];
      const data = readStdinJSON();
      const accounts = data.accounts ?? data.user?.accounts ?? [];
      if (!accounts.some((entry) => entry.id === target)) throw new Error('当前登录账户无权访问 deploy.settings.json 指定的 account_id。');
      break;
    }
    case 'config':
      makeConfig(process.argv[3] || placeholder, process.argv[4]);
      break;
    case 'upload-config': {
      const config = readJSON(path.join(projectDir, '.deploy', 'wrangler.json'));
      delete config.route;
      config.routes = [];
      fs.writeFileSync(path.join(projectDir, '.deploy', 'worker-upload.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      break;
    }
    case 'bind-domain': {
      const value = settings();
      if (value.custom_domain) {
        const { bindCustomDomain } = await import('./domain-binding.mjs');
        await bindCustomDomain(projectDir, value, process.argv[3] || '');
      }
      break;
    }
    case 'mark-pending': {
      const value = settings();
      const config = readJSON(path.join(projectDir, '.deploy', 'wrangler.json'));
      fs.writeFileSync(path.join(projectDir, '.deploy', 'pending-deployment.json'), `${JSON.stringify({ worker: value.worker_name, account_id: config.account_id, project_dir: fs.realpathSync(projectDir), status: 'pending', created_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
      break;
    }
    case 'database-id': {
      const input = readStdinJSON();
      const rows = Array.isArray(input) ? input : input.result ?? [];
      const found = rows.filter((entry) => entry.name === settings().database_name);
      if (found.length > 1) throw new Error('找到多个同名数据库，请在 Cloudflare 控制台核对。');
      const value = found[0]?.uuid ?? found[0]?.id ?? '';
      if (value && !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('数据库返回的 ID 无效。');
      console.log(value);
      break;
    }
    case 'url': {
      const text = fs.readFileSync(0, 'utf8');
      const input = settings();
      const worker = input.worker_name;
      if (input.custom_domain) {
        const candidate = `https://${input.custom_domain}`;
        const urls = text.match(/https:\/\/[a-zA-Z0-9.-]+\b/g) ?? [];
        if (!urls.includes(candidate)) throw new Error('部署输出没有已绑定的目标自定义域名，停止健康检查。');
        console.log(candidate);
        break;
      }
      const urls = text.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev\b/g) ?? [];
      const value = urls.find((entry) => new URL(entry).hostname.startsWith(`${worker}.`));
      if (!value) throw new Error('部署输出没有预期 Worker 的 workers.dev URL。');
      console.log(value);
      break;
    }
    case 'save-deployment': {
      const url = process.argv[3];
      const checkedVia = process.argv[4] || 'unknown';
      const directResult = process.argv[5] || 'unknown';
      if (!['unknown', 'direct', 'system-proxy'].includes(checkedVia) || !['unknown', 'true', 'false'].includes(directResult)) throw new Error('部署验证方式或直连结果不正确。');
      const parsed = new URL(url);
      const input = settings();
      const validHost = parsed.hostname === input.custom_domain || (parsed.hostname.startsWith(`${input.worker_name}.`) && parsed.hostname.endsWith('.workers.dev'));
      if (parsed.protocol !== 'https:' || !validHost || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('部署地址必须是匹配目标 Worker 或精确自定义域名、无参数的 HTTPS 根站地址。');
      const config = readJSON(path.join(projectDir, '.deploy', 'wrangler.json'));
      const recordFile = path.join(projectDir, '.deployment.json');
      const previous = fs.existsSync(recordFile) ? readJSON(recordFile) : {};
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('已有部署记录格式不正确，停止保存，保留原文件。');
      const checkedAt = new Date().toISOString();
      const validation = {
        ...(previous.validation && typeof previous.validation === 'object' && !Array.isArray(previous.validation) ? previous.validation : {}),
        checkedVia,
        directWithoutExplicitProxy: directResult === 'unknown' ? null : directResult === 'true',
        mobileVerified: false,
        checkedAt,
      };
      fs.writeFileSync(recordFile, `${JSON.stringify({ ...previous, url: parsed.origin, worker: config.name, account_id: config.account_id, database_id: config.d1_databases[0].database_id, project_dir: fs.realpathSync(projectDir), custom_domain: input.custom_domain || null, deployed_at: checkedAt, validation }, null, 2)}\n`, { mode: 0o600 });
      fs.writeFileSync(path.join(projectDir, 'public', 'public-site.json'), `${JSON.stringify({ url: parsed.origin }, null, 2)}\n`, { mode: 0o644 });
      break;
    }
    case 'owns-worker': {
      const value = settings();
      const configured = readJSON(path.join(projectDir, '.deploy', 'wrangler.json'));
      const matches = (record) => record.worker === value.worker_name && record.account_id === configured.account_id;
      let valid = false;
      try { valid = matches(readJSON(path.join(projectDir, '.deployment.json'))); } catch {}
      if (!valid) {
        try {
          const pending = readJSON(path.join(projectDir, '.deploy', 'pending-deployment.json'));
          valid = matches(pending) && pending.status === 'pending' && pending.project_dir === fs.realpathSync(projectDir);
        } catch {}
      }
      if (!valid) throw new Error('本地部署记录与当前目标或项目目录不一致。');
      break;
    }
    default:
      throw new Error('未知部署配置命令。');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
