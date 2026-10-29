# JobsDeviceInfo Pages 入口

![Jobs出品，必属精品](https://picsum.photos/1500/400)

<!-- jobs-toc:start -->
<!-- jobs-toc:source {"v":2,"token":"[toc]"} -->
<details>
<summary>📚 目录（点击展开 / 收起）</summary>

- [🔥 前言](#%E5%89%8D%E8%A8%80)
- [一、更新与配置](#jobs-toc-heading-2)
- [二、验收与边界](#jobs-toc-heading-3)

</details>
<!-- jobs-toc:end -->

---

## 🔥 <span id="前言">前言</span>

[**Cloudflare Pages**](https://developers.cloudflare.com/pages/) 默认域入口：[设备采集站](https://jobs-device-info-pages.pages.dev/)。它通过 [Service Binding](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings) 调用本账户现有 `jobs-device-info` Worker。网页、API、描述文件下载和系统回调均使用 Pages 当前域名，手机不请求旧的 `ccwu.cc` 域名。

## <span id="jobs-toc-heading-2" data-jobs-toc="v2">一、更新与配置 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

| 文件 | 作用 |
| --- | --- |
| `worker.js` | 原样传递 Request 与 Response，保留原始地址、Cookie、状态和回传正文；内部绑定异常时返回 503。 |
| `wrangler.json` | 专属 Pages 项目、兼容日期、受控输出目录和 `DEVICE_SERVICE` 绑定；账户从根部署设置读取。 |
| `../scripts/build-pages.mjs` | 生成 `.pages-build/_worker.js` 与全路径 `_routes.json`，拒绝符号链接及未知生成文件。 |

1、业务源码或网页资源修改后，先运行根目录 Worker 部署脚本。Pages 只提供访问入口，实际资源和业务仍由原 Worker 负责，D1 和原清理任务继续使用。

2、双击根目录 `【MacOS】🌐部署Pages入口.command`，直接回车执行，输入其它字符取消。它复用健康依赖和 Wrangler 既有授权，不安装、升级、登录或创建项目。当前专属 Pages 项目已创建；发布前精确核对账户、项目存在和 `DEVICE_SERVICE` 名称。

3、`.pages-deployment.json` 必须与账户、Pages 项目、Worker 服务及项目真实目录匹配。缺失时非交互模式停止，交互模式须核对目标后输入 `YES`；脚本不会创建项目或使用强制覆盖参数。打包不包含此本机归属记录。

4、健康 JSON 验证通过后，写 Pages 独立部署记录、`public/public-site.json` 和文件夹内 `打开线上采集站.webloc`；不修改原 Worker 的 `.deployment.json` 与域名绑定。原 Worker 部署脚本可能重新写入其公开地址，因此更新后端后应再运行 Pages 入口脚本。

```shell
zsh './【MacOS】🌐部署Pages入口.command' \
  --check

JOBS_DEVICE_NO_OPEN=1 \
  JOBS_DEVICE_HEALTH_NETWORK=direct \
  zsh './【MacOS】🌐部署Pages入口.command' \
  --deploy
```

`--help` 和 `--check` 仅做本地读取，不联网或写日志。正常执行后在系统临时目录显示独立日志位置。默认健康检查显式禁用代理；选择 `JOBS_DEVICE_HEALTH_NETWORK=system-proxy` 时，只给检查用 curl 动态传入现有系统 HTTPS 代理，并额外记录短时直连结果；不固定端口或修改系统设置。

## <span id="jobs-toc-heading-3" data-jobs-toc="v2">二、验收与边界 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

新版21项线上API与配对联调通过，线上脚本IPv4/IPv6直连下载与源码一致；未向生产提交测试硬件编号。用户已确认真机UDID、IMEI回传并在电脑显示。当前系统端安装提示对应的301返回方式已调整，终态仍需新版真机复验；网络、回传和安装分别记录。

所有路径均由入口 Worker 处理，`_worker.js` 和路由配置不作为普通静态源码公开。绑定调用保留原始地址和请求体，不向手机下发原 Worker 地址，也不转向第三方反向代理。原站点同意、会话隔离、CMS 签名与 Challenge 校验保持生效，详见[服务端说明](../src/README.md)。Pages Functions 与 Worker 调用受账户现有额度约束，不承诺无上限免费。

<a id="🔚" href="#前言" style="font-size:17px; color:green; font-weight:bold;">我是有底线的➤点我回到首页</a>
