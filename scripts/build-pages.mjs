// JobsDeviceInfo · Created by Jobs. Only writes the dedicated Pages output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.pages-build');
const assets = ['index.html', 'styles.css', 'app.js', 'qr-code.js', 'vendor-licenses.txt', 'public-site.json'];
const generated = new Set(['_worker.js', '_routes.json', ...assets]);

function checkFile(file) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(`拒绝读取或覆盖非独立普通文件：${file}`);
  }
}

function writeOutput(name, content) {
  const target = path.join(output, name);
  try {
    checkFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.writeFileSync(target, content, {
    flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    mode: 0o644
  });
}

try {
  const info = fs.lstatSync(output);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Pages 输出目录必须是项目内真实目录，不能是符号链接。');
  }
  if (fs.readdirSync(output).some((name) => !generated.has(name))) {
    throw new Error('Pages 输出目录存在不属于本次构建的文件，停止以免误上传。');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  fs.mkdirSync(output, { mode: 0o755 });
}

const entry = path.join(root, 'pages', 'worker.js');
checkFile(entry);
writeOutput('_worker.js', fs.readFileSync(entry));
writeOutput('_routes.json', `${JSON.stringify({ version: 1, include: ['/*'], exclude: [] }, null, 2)}\n`);
for (const name of assets) {
  const source = path.join(root, 'public', name);
  checkFile(source);
  writeOutput(name, fs.readFileSync(source));
}
console.log('✔ 已构建 Pages 入口；所有 HTTP 请求由绑定的采集 Worker 处理。');
