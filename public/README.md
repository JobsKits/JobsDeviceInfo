# JobsDeviceInfo 前端

![Jobs出品，必属精品](https://picsum.photos/1500/400)

<!-- jobs-toc:start -->
<!-- jobs-toc:source {"v":2,"token":"[toc]"} -->
<details>
<summary>📚 目录（点击展开 / 收起）</summary>

- [🔥 前言](#%E5%89%8D%E8%A8%80)
- [一、文件职责](#jobs-toc-heading-2)
- [二、真实采集与本地演示](#jobs-toc-heading-3)
- [三、接口约定](#jobs-toc-heading-4)
- [四、电脑二维码与双端同步](#jobs-toc-heading-5)

</details>
<!-- jobs-toc:end -->

---

## 🔥 <span id="前言">前言</span>

本目录是 **[Cloudflare Workers](https://developers.cloudflare.com/workers/)** 托管的静态界面，使用原生 HTML、CSS 与 JavaScript，无运行时外链、远程图片、远程字体或前端构建步骤。

## <span id="jobs-toc-heading-2" data-jobs-toc="v2">一、文件职责 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

| 文件 | 职责 |
| --- | --- |
| `index.html` | 三端采集步骤、系统选择、同意项、结果空态、设备字段、白名单补录及复制入口 |
| `styles.css` | 手机与电脑布局、系统深浅色、键盘焦点与减少动态效果设置 |
| `app.js` | 同源 API 请求、3 秒超时、会话轮询、逐项缺值原因、到期处理、复制和本地演示回退 |
| `device-capabilities.js` | 三端系统线索与浏览器信息采集；UA-CH 缺失、失败或超时后继续使用可用的浏览器信息 |

## <span id="jobs-toc-heading-3" data-jobs-toc="v2">二、真实采集与本地演示 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

1、页面进入时请求 `GET /api/session`。服务器成功响应会自动覆盖页面中的本地演示状态，不需要手工切换。

2、支持 iPhone / iPad、[**Android**](https://developer.android.com/) 与 [**HarmonyOS（鸿蒙，含 3）**](https://developer.huawei.com/consumer/cn/harmonyos/)；先根据浏览器线索识别，用户可纠正系统。苹果设备在 **[Safari](https://www.apple.com/safari/)** 勾选同意后创建或认领会话，再打开同源 `/profile.mobileconfig`；Android、鸿蒙勾选同意后回传浏览器基础信息，无需安装苹果描述文件。华为 Android 兼容 UA 不直接证明鸿蒙及其版本。

苹果 Safari 可在“采集方式”中选择系统确认或浏览器基础信息；非 Safari 也可采集浏览器信息，需要 UDID 时复制入口到 Safari。电脑默认展示二维码，也可点击“在本机采集浏览器信息”查看当前浏览器基础信息；这不会获得手机硬件编号。

3、苹果确认文件下载后，由用户在系统设置中检查并手动安装；Android、鸿蒙由网页提交白名单浏览器数据。等待回传时，页面每 4 秒请求一次会话。页面进入后台时暂停，回到页面后立即刷新。

4、连接失败、超时或响应无法解析时，显示明确的“本地演示”横幅。示例 UDID 是中文演示文字，不是有效设备编号；复制、手工补录及清空在当前页面内可操作。演示操作不会生成描述文件，不会伪装成真实设备采集，也不会在网络恢复时自动上传。

5、演示状态每 10 秒尝试恢复连接；正常非等待状态每 15 秒刷新。API 超时在 `index.html` 的 `api-timeout-ms` 元数据中配置，最少 1000 毫秒。

6、有值字段均可点击名称或数值复制，成功与失败均弹真正对话框，支持 Esc、关闭按钮及焦点恢复；无值不复制占位文字。复制全部包括字段名与来源；缺值原因区分系统未提供、浏览器未开放与平台不适用。

7、真实硬件标识不写入 `localStorage` 或 `sessionStorage`。清除失败时会先隐藏本页硬件信息，并在本页连接恢复后优先重试服务端删除。关闭页面后无法保证继续重试，应重新打开页面核对结果；Cloudflare 平台备份不由前端控制。

## <span id="jobs-toc-heading-4" data-jobs-toc="v2">三、接口约定 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

| 接口 | 用途 |
| --- | --- |
| `GET /api/session` | 获取当前 Cookie 对应会话；没有会话时 `session` 为 `null` |
| `POST /api/session` | 发送 `{ "consent": true }` 并创建短期会话 |
| `POST /api/pair` | 创建电脑与手机共享的空白会话，返回一次显示的随机配对码 |
| `POST /api/pair/claim` | 手机发送 `{ "token": "配对码", "consent": true }` 后认领本次会话 |
| `GET /profile.mobileconfig` | 下载本次会话的设备确认描述文件 |
| `POST /api/session/imei` | 保存 15 位 IMEI，标注为手动填写 |
| `POST /api/session/details` | 只提交九项中非空且改动的可编辑字段，body为`{ "fields": { "imei2": "…" } }`；系统值只读，映射可更正。 |
| `POST /api/session/browser` | 同意后回传系统选择及浏览器公开数据；配对模式只允许已认领手机提交，成功结果由两端共享。 |
| `DELETE /api/session` | 删除应用中的当前会话及设备信息 |

响应采用 `{ "ok": true, "session": ... }`。会话包括 `state`、`expiresAt`、`receivedAt`、`device`、`verification`。苹果系统版本与原始 `version` 构建号分开展示，精确命中本地产品 / 版本表的推导值标明映射来源。浏览器回传标记 `browser-reported`，浏览器线索和用户选择分别标明，不能冒充系统硬件回传。

普通网页不能读取 Android / 鸿蒙的 IMEI、IMEI2、ICCID、序列号和 SEID；苹果 UDID 对其它平台不适用。浏览器未公开型号或实际系统版本时保持缺值，不从屏幕尺寸猜型号，也不把 Android 兼容版本显示成鸿蒙版本。补录入口是可选人工操作，不等同于自动采集。

## <span id="jobs-toc-heading-5" data-jobs-toc="v2">四、电脑二维码与双端同步 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

1、电脑点击“生成扫码二维码”后，服务器创建本次共享会话并设置电脑 Cookie。iPhone、Android、鸿蒙均可扫码打开。生成入口不采集手机信息，不替代手机上的同意与对应确认操作。

2、二维码由本地打包的 `qr-code.js` 编码，留出 4 个模块的静区，不请求第三方二维码服务。链接形如 `https://站点域名/#pair=随机配对码`，不包含 UDID、IMEI 等硬件信息，也不将配对码放进 URL 查询参数。

3、手机扫码后，页面立即清除地址栏中的配对片段，将随机码仅留在当前页面内存。手机勾选同意并点击开始时才请求认领接口；同意文案明确结果也会显示在发起配对的电脑页面。苹果非 Safari 浏览器提供复制本次配对链接到 Safari 的入口。

4、手机认领后会获得自己的 Cookie。两端 Cookie 分别访问同一个短期会话，手机完成苹果系统回传或 Android / 鸿蒙浏览器回传后，电脑原页面通过轮询自动显示同次结果；两端的手工补录与清除也作用于该共享会话。配对会话中的描述文件下载与浏览器采集提交都只允许手机角色操作。

5、配对码只在创建响应中返回，刷新网页后不能重新取出旧码。可重新生成二维码，但会替换本次旧会话；已完成的二维码不重复使用。持有配对链接者可加入本次会话并查看结果，因此复制链接时会明确提醒只交给本次采集设备。

6、本地预览从 `/public-site.json` 的 `url` 读取真实部署地址。尚未部署时不生成指向 `localhost` 或 `127.0.0.1` 的手机二维码；部署地址可用时，按钮会先在同一个电脑标签页跳转线上站点，再生成配对码。这样手机与电脑的会话始终同源，不把本地数据库会话误编码成线上二维码。`#start-pair` 只是这一按钮发起的生成意图，不包含任何秘密。

<a id="🔚" href="#前言" style="font-size:17px; color:green; font-weight:bold;">我是有底线的➤点我回到首页</a>
