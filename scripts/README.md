# JobsDeviceInfo 部署与联调工具

![Jobs出品，必属精品](https://picsum.photos/1500/400)

<!-- jobs-toc:start -->
<!-- jobs-toc:source {"v":2,"token":"[toc]"} -->
<details>
<summary>📚 目录（点击展开 / 收起）</summary>

- [前言](#%E5%89%8D%E8%A8%80)
- [一、实际入口](#jobs-toc-heading-2)
- [二、验证与风险](#jobs-toc-heading-3)

</details>
<!-- jobs-toc:end -->

---

## <span id="前言">前言</span>

这里保存 [**Node.js**](https://nodejs.org/) 配置处理与本地联调工具。面向普通使用的双击入口位于父目录，完整范围见[根说明](../README.md)。配置处理与联调不读取 [**Cloudflare**](https://developers.cloudflare.com/) OAuth 凭据；独立域名绑定工具仅把既有 Wrangler 授权捕获在进程内存，通过标准输入送往官方 API，不输出或保存凭据。

## <span id="jobs-toc-heading-2" data-jobs-toc="v2">一、实际入口 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

| 文件 | 职责与输入输出 |
| --- | --- |
| `deploy-config.mjs` | 读取父目录 `deploy.settings.json`、`wrangler.json` 与已安装包版本；验证资源名称，生成 `.deploy/wrangler.json`，核对账户列表，提取专属数据库 ID 与部署 URL，选定线路检查成功后合并保存 `.deployment.json` 及独立的验证范围。 |
| `verify-local.mjs` | 对已经运行的本地 Worker 发起苹果 CMS、Android / 鸿蒙浏览器回传、权限隔离与电脑同步联调；仅允许回环地址，使用明确的本地测试数据与临时自签名 CMS，不代表三端真机验收。 |
| `build-assets.mjs` | 使用已锁定的 esbuild 与 node-qrcode 依赖生成 `../public/qr-code.js` 和 `../public/vendor-licenses.txt`；部署与预览入口会自动调用。 |
| `qr-entry.mjs` | 二维码构建入口，只导出浏览器所需的本地二维码绘制功能，不含网络上传或远程二维码服务。 |
| `domain-binding.mjs` | 仅为配置的独立域名生成 Cloudflare 变更预览并绑定；遇到现有 DNS、其它 Worker 或移除行为即停止，最终 API 覆盖开关保持关闭。 |
| `build-pages.mjs` | 从 `pages/worker.js` 和受控静态文件（包括三端识别模块 `../public/device-capabilities.js`）生成专用 `.pages-build`；全路径通过内部绑定访问现有 Worker，不复制业务或数据库；存在未知文件时停止。 |

配置工具是两个 `.command` 的内部业务辅助，通常无需手工调用。`check`、`check-deps`、`settings`、`accounts`、`assert-account`、`database-id`、`url`、`owns-worker` 只读取其输入；`config` 写 `.deploy/wrangler.json`；`upload-config` 写无自动域名覆盖的 `.deploy/worker-upload.json`；`mark-pending` 写同账户、同 Worker、同绝对项目目录的待完成记录；`bind-domain` 执行上述安全绑定；`save-deployment` 写 `.deployment.json` 和仅含线上根站 URL 的 `public/public-site.json`。不存在执行字符串或 `eval` 配置的路径。

`save-deployment <HTTPS根站URL> [direct|system-proxy|unknown] [true|false|unknown]` 的后两项分别表示选定检查线路、本机不注入显式代理的结果。未提供时记录 `checkedVia: "unknown"` 与 `directWithoutExplicitProxy: null`；每次保存均记录当前 `checkedAt` 并将独立手机验收标为 `mobileVerified: false`，保留旧记录的其它有效字段。仅在部署入口选定线路的健康 JSON 检查通过后调用；代理成功后还会额外进行 3 秒连接 / 6 秒总超时的无显式代理检查，其失败只影响记录与警告，不撤销已经完成的发布或改变退出码 0 的含义。

## <span id="jobs-toc-heading-3" data-jobs-toc="v2">二、验证与风险 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

在父目录启动本地预览后，打开另一个终端：

```shell
node ./scripts/verify-local.mjs
```

联调会写入本地测试会话，默认请求 `http://127.0.0.1:8787`；不会把测试设备号发到公开网站。仅需配置检查时，可使用两个双击入口的 `--check` 参数，不会启动服务、建库或发布。

联调覆盖苹果 CMS 回传、浏览器白名单及同意校验、配对角色、重复提交、双端结果一致和会话清除；测试数量以实际运行输出为准。用户已确认苹果 UDID、IMEI 回传和电脑返显；三端新版真机流程及系统安装终态仍须单独验收。线上入口和网络边界见 [Pages 说明](../pages/README.md)。

`.deploy/` 是本机诊断目录，不属于公开网页。打包交付和公开源码时排除其中的诊断状态、`.wrangler/`、凭据、Cookie 与证书私钥。下发描述文件和回传 CMS 的签名边界见根说明。

<a id="🔚" href="#前言" style="font-size:17px; color:green; font-weight:bold;">我是有底线的➤点我回到首页</a>
