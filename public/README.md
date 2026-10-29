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
| `index.html` | 采集步骤、同意项、结果空态、设备字段、手动 IMEI 补录及复制入口 |
| `styles.css` | 手机与电脑布局、系统深浅色、键盘焦点与减少动态效果设置 |
| `app.js` | 同源 API 请求、3 秒超时、会话轮询、到期处理、复制和本地演示回退 |

## <span id="jobs-toc-heading-3" data-jobs-toc="v2">二、真实采集与本地演示 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

1、页面进入时请求 `GET /api/session`。服务器成功响应会自动覆盖页面中的本地演示状态，不需要手工切换。

2、真实采集需要在 **[Safari](https://www.apple.com/safari/)** 的 iPhone / iPad 环境中勾选同意项。前端收到 `POST /api/session` 的有效响应后，才打开同源 `/profile.mobileconfig`。电脑和其他浏览器给出手机访问说明。

3、确认文件下载后，由用户在系统设置中检查并手动安装；等待回传时，页面每 4 秒请求一次会话。页面进入后台时暂停，回到页面后立即刷新。

4、连接失败、超时或响应无法解析时，显示明确的“本地演示”横幅。示例 UDID 是中文演示文字，不是有效设备编号；复制、手工补录及清空在当前页面内可操作。演示操作不会生成描述文件，不会伪装成真实设备采集，也不会在网络恢复时自动上传。

5、演示状态每 10 秒尝试恢复连接；正常非等待状态每 15 秒刷新。API 超时在 `index.html` 的 `api-timeout-ms` 元数据中配置，最少 1000 毫秒。

6、十二项信息均可点击名称或数值复制，成功与失败均弹真正对话框，支持Esc、关闭按钮及焦点恢复；无值不复制占位文字。复制全部包括字段名与来源。

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
| `DELETE /api/session` | 删除应用中的当前会话及设备信息 |

响应采用 `{ "ok": true, "session": ... }`。会话包括 `state`、`expiresAt`、`receivedAt`、`device`、`verification`；`device` 的展示字段为 `udid`、`imei`、`product`、`version`、`serial`、`imeiSource`。`VERSION` 显示为“系统版本 / 构建号”，不强行解释为用户可读的 iOS 版本号。

## <span id="jobs-toc-heading-5" data-jobs-toc="v2">四、电脑二维码与双端同步 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

1、电脑点击“生成扫码二维码”后，服务器创建本次共享会话并设置电脑 Cookie。生成入口不采集手机硬件信息，不替代手机上的同意与系统安装操作。

2、二维码由本地打包的 `qr-code.js` 编码，留出 4 个模块的静区，不请求第三方二维码服务。链接形如 `https://站点域名/#pair=随机配对码`，不包含 UDID、IMEI 等硬件信息，也不将配对码放进 URL 查询参数。

3、手机扫码后，页面立即清除地址栏中的配对片段，将随机码仅留在当前页面内存。手机勾选同意并点击下载时才请求认领接口；同意文案明确结果也会显示在发起配对的电脑页面。非 Safari 手机浏览器可显式复制本次配对链接到 Safari。

4、手机认领后会获得自己的 Cookie。两端 Cookie 分别访问同一个短期会话，手机确认描述文件并回传后，电脑原页面通过轮询自动显示同次结果；两端的手工补录与清除也作用于该共享会话。配对会话中的描述文件只允许手机端下载。

5、配对码只在创建响应中返回，刷新网页后不能重新取出旧码。可重新生成二维码，但会替换本次旧会话；已完成的二维码不重复使用。持有配对链接者可加入本次会话并查看结果，因此复制链接时会明确提醒只交给本次采集设备。

6、本地预览从 `/public-site.json` 的 `url` 读取真实部署地址。尚未部署时不生成指向 `localhost` 或 `127.0.0.1` 的手机二维码；部署地址可用时，按钮会先在同一个电脑标签页跳转线上站点，再生成配对码。这样手机与电脑的会话始终同源，不把本地数据库会话误编码成线上二维码。`#start-pair` 只是这一按钮发起的生成意图，不包含任何秘密。

<a id="🔚" href="#前言" style="font-size:17px; color:green; font-weight:bold;">我是有底线的➤点我回到首页</a>
