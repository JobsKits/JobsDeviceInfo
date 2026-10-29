# JobsDeviceInfo 部署与联调工具

![Jobs出品，必属精品](https://picsum.photos/1500/400)

[toc]

## <span id="前言">前言</span>

这里保存 [**Node.js**](https://nodejs.org/) 配置处理与本地联调工具。面向普通使用的双击入口位于父目录，完整范围见[根说明](../README.md)。配置处理与联调不读取 [**Cloudflare**](https://developers.cloudflare.com/) OAuth 凭据；独立域名绑定工具仅把既有 Wrangler 授权捕获在进程内存，通过标准输入送往官方 API，不输出或保存凭据。

## 一、实际入口 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a>

| 文件 | 职责与输入输出 |
| --- | --- |
| `deploy-config.mjs` | 读取父目录 `deploy.settings.json`、`wrangler.json` 与已安装包版本；验证资源名称，生成 `.deploy/wrangler.json`，核对账户列表，提取专属数据库 ID 与部署 URL，选定线路检查成功后合并保存 `.deployment.json` 及独立的验证范围。 |
| `verify-local.mjs` | 对已经运行的本地 Worker 发起协议与会话联调；仅允许回环地址，使用明确的本地测试数据与临时自签名 CMS，不代表 Apple 真机验收。 |
| `build-assets.mjs` | 使用已锁定的 esbuild 与 node-qrcode 依赖生成 `../public/qr-code.js` 和 `../public/vendor-licenses.txt`；部署与预览入口会自动调用。 |
| `qr-entry.mjs` | 二维码构建入口，只导出浏览器所需的本地二维码绘制功能，不含网络上传或远程二维码服务。 |
| `domain-binding.mjs` | 仅为配置的独立域名生成 Cloudflare 变更预览并绑定；遇到现有 DNS、其它 Worker 或移除行为即停止，最终 API 覆盖开关保持关闭。 |
| `build-pages.mjs` | 从 `pages/worker.js` 和受控静态文件生成专用 `.pages-build`；全路径通过内部绑定访问现有 Worker，不复制业务或数据库；存在未知文件时停止。 |

配置工具是两个 `.command` 的内部业务辅助，通常无需手工调用。`check`、`check-deps`、`settings`、`accounts`、`assert-account`、`database-id`、`url`、`owns-worker` 只读取其输入；`config` 写 `.deploy/wrangler.json`；`upload-config` 写无自动域名覆盖的 `.deploy/worker-upload.json`；`mark-pending` 写同账户、同 Worker、同绝对项目目录的待完成记录；`bind-domain` 执行上述安全绑定；`save-deployment` 写 `.deployment.json` 和仅含线上根站 URL 的 `public/public-site.json`。不存在执行字符串或 `eval` 配置的路径。

`save-deployment <HTTPS根站URL> [direct|system-proxy|unknown] [true|false|unknown]` 的后两项分别表示选定检查线路、本机不注入显式代理的结果。未提供时记录 `checkedVia: "unknown"` 与 `directWithoutExplicitProxy: null`；每次保存均记录当前 `checkedAt` 并将独立手机验收标为 `mobileVerified: false`，保留旧记录的其它有效字段。仅在部署入口选定线路的健康 JSON 检查通过后调用；代理成功后还会额外进行 3 秒连接 / 6 秒总超时的无显式代理检查，其失败只影响记录与警告，不撤销已经完成的发布或改变退出码 0 的含义。

## 二、验证与风险 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a>

在父目录启动本地预览后，打开另一个终端：

```shell
node ./scripts/verify-local.mjs
```

联调会写入本地测试会话，默认请求 `http://127.0.0.1:8787`；不会把测试设备号发到公开网站。仅需配置检查时，可使用两个双击入口的 `--check` 参数，不会启动服务、建库或发布。

当前22项自动测试、75项本地HTTP/D1/CMS联调及21项线上API联调通过；用户确认UDID、IMEI回传和电脑返显。复制弹窗与390像素布局使用明确测试夹具验收，不读取真实硬件值。旧ccwu入口网络问题与系统端安装终态独立记录，Pages范围见[说明](../pages/README.md)。

`.deploy/` 是本机诊断目录，不属于公开网页。打包交付和公开源码时排除其中的诊断状态、`.wrangler/`、凭据、Cookie 与证书私钥。下发描述文件和回传 CMS 的签名边界见根说明。

<a id="🔚" href="#前言" style="font-size:17px; color:green; font-weight:bold;">我是有底线的➤点我回到首页</a>
