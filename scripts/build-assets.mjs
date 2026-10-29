import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  entryPoints: [path.join(root, 'scripts/qr-entry.mjs')],
  outfile: path.join(root, 'public/qr-code.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'inline',
  banner: { js: '/*! Generated from node-qrcode (MIT). See /vendor-licenses.txt. */' },
});
const packages = [
  ['node-qrcode', 'node_modules/qrcode/license'],
  ['dijkstrajs', 'node_modules/dijkstrajs/LICENSE.md'],
];
let licenseText = '二维码编码在浏览器本地执行，不调用第三方二维码服务。\n\n';
for (const [name, file] of packages) {
  licenseText += `${name}\n${await readFile(path.join(root, file), 'utf8')}\n\n`;
}
await writeFile(path.join(root, 'public/vendor-licenses.txt'), licenseText);
console.log('✔ 已生成本地二维码模块与许可说明。');
