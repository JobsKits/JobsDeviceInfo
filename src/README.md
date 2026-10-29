# JobsDeviceInfo 服务端

[toc]

## 前言

服务运行于 [**Cloudflare Workers**](https://developers.cloudflare.com/workers/)，以独立 [**D1**](https://developers.cloudflare.com/d1/) 数据库保存当前采集会话。`index.js` 负责接口与静态文件路由，`profile.js` 负责描述文件和设备回传解析，数据库结构位于 `../migrations/`。

## 一、接口与状态 <a href="#前言">🔼</a> <a href="#文末">🔽</a>

| 接口 | 当前行为 |
| --- | --- |
| `GET /api/health` | 检查服务与会话表是否可用。 |
| `POST /api/pair` | 接受 `{}`，建立电脑等待会话并返回仅此次可见的 `pairToken`；二维码使用根页面 Fragment `#pair=<token>`，不将令牌放进查询字符串。 |
| `POST /api/pair/claim` | 接受 `{ "token": "64位配对令牌", "consent": true }`，手机同意后一次性认领，设置手机自己的 Cookie，与电脑共享同一采集结果。 |
| `POST /api/session` | 接受 `{ "consent": true }`，建立 15 分钟会话并设置 HttpOnly Cookie；替换当前旧会话。 |
| `GET /api/session` | 仅凭当前 Cookie 返回自己的会话；无会话返回 `session: null`。 |
| `GET /profile.mobileconfig` | 生成当前会话专属的 Profile Service 描述文件，须由手机用户在系统设置内确认。 |
| `POST /api/profile/<token>` | 校验CMS、Challenge、有效期和字段后保存，301返回绝对同源首页；不携带设备编号。 |
| `POST /api/session/imei` | 接受 `{ "imei": "15位数字" }`，补录当前会话的 IMEI，来源标记为 `manual`。 |
| `POST /api/session/details` | `{ "fields": { "imei2": "…" } }`；同源、Cookie、有效期与白名单校验，JSON补丁原子合并。 |
| `DELETE /api/session` | 删除自己的会话并清除 Cookie。 |

会话字段：`state` 为 `waiting` 或 `received`；`expiresAt`、`receivedAt` 为 ISO 时间；`device` 包含 `udid`、`imei`、`imeiSource`、`product`、`version`、`serial`。设备未返回的字段为 `null`。`version` 可能是系统构建号，不能始终按公开 iOS 版本号解释。

新增`imei2`、`iccid`、`meid`、`osVersion`、`modelName`、`modelNumber`、`seid`；有值时`fieldSources`为`profile`、`manual`或`derived`。系统版本不冒充构建号，型号名称映射见[本地资料](../data/README.md)，未知留空。

九项补录白名单为`imei`、`imei2`、`iccid`、`meid`、`osVersion`、`modelName`、`serial`、`modelNumber`、`seid`。系统值拒绝覆盖，映射可更正；手工数据随原会话到期或删除，IMEI继续共用原`manual_imei`列。

系统版本缺失时，依据`data/apple-os-versions.json`中的Apple公开构建号及支持产品精确匹配，标记`derived`，不按UA或构建号规律猜测；系统原生值优先，手动值可覆盖推导值。

`fieldAvailability.iccid`只保存`not_returned`、`empty`、`unsupported_type`、`unrecognized_format`、`provided`五类状态，以区分系统未回传与格式被过滤，不保存ICCID原文。

有效会话的回传被拒绝时，`callbackError` 仅向持有该会话 Cookie 的浏览器返回固定 `code`、`stage` 和 `at`；页面展示错误码供排查。数据库只附加固定分类、白名单算法标识与错误类别，不保存原始回传、证书、异常原文或硬件字段；诊断随会话到期或删除，成功回传后清空。记录诊断不会降低签名、Challenge、有效期或字段校验。

配对字段：`paired` 表示电脑与手机配对流程；`role` 为 `desktop` 或 `phone`，`canDownload` 表示当前浏览器是否可以下载采集描述文件。配对会话只有手机端可下载，电脑只等待结果；直接在手机建立的普通会话保持可下载。两端均可查看、补录 IMEI 或清除同一会话。配对令牌只在创建响应中返回，刷新电脑页面后不能从后端恢复，应重新生成二维码；重新生成会作废当前旧配对。手机确认描述文件后，系统自动回传并由网页轮询返显，不需要手动上传。

## 二、校验与保存边界 <a href="#前言">🔼</a> <a href="#文末">🔽</a>

1、拒绝未签名的普通 XML；仅接受嵌入内容且 CMS 签名校验成功的回传，包含单个签名者。`verification: "signature-only"` 仅表示内容签名一致，**没有验证签名者的 Apple 证书信任链，不构成设备真实性或身份认证证明**。

2、D1 只保存会话 Cookie、回调 Token 和 Challenge 的散列，不保存原始值。回调 Token、Challenge 可由 Cookie 分别派生，任何一个回调地址都不能反推出 Cookie。一次成功回传后拒绝重放；慢请求完成时再校验有效期。

电脑与手机分别使用独立 Cookie，数据库只存其散列。二维码配对令牌也是仅保存散列的随机一次性能力令牌；手机同意认领时原子检查有效期和未使用状态，成功后将回调密钥绑定手机 Cookie。消费后的配对令牌散列保留到会话结束，仅用于同一手机携带其已认领 Cookie 和同一令牌时的幂等重试；重试不旋转 Cookie、不延长有效期、不给其它浏览器新增权限。没有正确手机 Cookie 的重复认领仍然拒绝。手机打开配对页时不应立即认领，只有明确同意后才向后端提交令牌。持有未使用二维码的人可先行认领，应只向本次采集的手机展示二维码。

3、回传最多 512 KiB；拒绝 XML 自定义实体、内部 DTD、重复键、嵌套值、异常 UDID 和设备字段控制字符。可选 IMEI 只接受合法 15 位数字或可明确归一化的分组格式，其它值标记未取得且不保存原值，不阻断有效 UDID；16 位 IMEISV 不冒充 IMEI。只保存展示所需白名单字段，不保存原始 CMS、证书或 XML。手填 IMEI 仍要求 15 位数字，来源与系统回传分开；若系统返回合法 IMEI，展示时优先使用系统值。

4、每个 IP 每 15 分钟最多创建 12 个会话；仅保存加入短期随机盐后的 IP 散列，原始 IP 不入库。JSON 写接口校验同源信息；读取结果只认 HttpOnly Cookie。硬件编号不进入查询字符串、日志或公开列表。

5、15 分钟后接口立即拒绝读取；相关接口访问会回收过期记录，另由每 15 分钟一次的 Cron 回收。无访问时物理清理最迟在有效期后约 15 分钟触发，实际执行时间取决于平台调度。删除数据库记录**不等于清除 Cloudflare D1 的备份、Time Travel 或平台保留记录**；平台保留策略由 Cloudflare 决定。

6、下发的描述文件未做站点证书 CMS 签名，系统可能显示“未签名”；这不影响回传本身要求 CMS 内容签名。采集描述文件不包含 MDM、VPN、代理或根证书负载。不要关闭 HTTPS 校验或绕过浏览器证书告警。

<a id="文末" href="#前言">返回前言</a>
