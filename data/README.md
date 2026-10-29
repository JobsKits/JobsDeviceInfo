# JobsDeviceInfo 型号名称映射

![Jobs出品，必属精品](https://picsum.photos/1500/400)

<!-- jobs-toc:start -->
<!-- jobs-toc:source {"v":2,"token":"[toc]"} -->
<details>
<summary>📚 目录（点击展开 / 收起）</summary>

- [🔥 前言](#%E5%89%8D%E8%A8%80)
- [一、来源与覆盖](#jobs-toc-heading-2)
- [二、文件与使用](#jobs-toc-heading-3)
- [三、更新方法](#jobs-toc-heading-4)
- [四、系统版本映射](#jobs-toc-heading-5)
- [五、许可证](#jobs-toc-heading-6)

</details>
<!-- jobs-toc:end -->

---

## 🔥 <span id="前言">前言</span>

本目录将设备回传的 `PRODUCT` 技术标识映射为可读型号名称。**型号名称是依据本地资料推导的结果，不是系统通过 Profile Service 直接返回的名称，也不用于证明设备真实性。** 原始技术标识应单独保留展示；未回传或未命中映射时，名称返回空值，不根据 UDID、浏览器标识或相邻编号猜测。

## <span id="jobs-toc-heading-2" data-jobs-toc="v2">一、来源与覆盖 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

本次没有找到可直接下载并用于本项目的 [**Apple**](https://developer.apple.com/documentation/appleschoolmanagerapi/orgdevice/attributes-data.dictionary) 公共全量型号对照表。Apple 组织设备 API 的 `productType` 和 `deviceModel` 是组织设备资源属性，不能当作匿名公共查询表。因此采用 [**DeviceKit**](https://github.com/devicekit/DeviceKit) 作者维护的主仓资料，静态提取标识及名称，不执行上游代码，不增加运行时依赖。

| 项目 | 固定来源与结果 |
| --- | --- |
| 获取日期 | 2026-10-28 |
| 上游提交 | `19528aa07e1426626ea9fb2c4a161edf43c4f9e8` |
| 原始映射源码 | [Source/Device.generated.swift](https://github.com/devicekit/DeviceKit/blob/19528aa07e1426626ea9fb2c4a161edf43c4f9e8/Source/Device.generated.swift) |
| 原始文本 URL | [固定提交的原始 Swift 文本](https://raw.githubusercontent.com/devicekit/DeviceKit/19528aa07e1426626ea9fb2c4a161edf43c4f9e8/Source/Device.generated.swift) |
| 提取规则 | 将 `mapToDevice(identifier:)` 中的硬件标识关联至枚举项，再连接同文件 `safeDescription` 中对应枚举项的字符串名称。 |
| 覆盖 | 上述提交明确列出的 167 个 iPhone / iPad 标识，对应 95 个机型枚举项；其中 iPhone 标识 63 个、iPad 标识 104 个。 |
| 未收录 | iPod、模拟器、Apple Watch、Apple TV、Mac 等类型；不声称覆盖上游未列出的所有历史或新增硬件。 |
| 名称处理 | 保留上游 `safeDescription` 的英文可读名，不自行翻译、补充或改写代际关系。 |
| 源文本 SHA-256 | `763aeba4fc67672d49e9a918eae56f0d3e12c60712dbcc71ed25447613b16fed` |
| 当前 JSON SHA-256 | `121982f4bec55f71c3e7e8690e8ab1df7d6d810beb5121f0b7694af28ccb1d06` |

上游资料可能出现遗漏或修订。本站应将来源标记为映射推导，不能将其表述为 Apple 官方识别结果。

## <span id="jobs-toc-heading-3" data-jobs-toc="v2">二、文件与使用 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

| 文件 | 用途 |
| --- | --- |
| [apple-device-models.json](./apple-device-models.json) | 纯 `标识: 名称` 对象；仅包含匹配 `iPhone数字,数字` 或 `iPad数字,数字` 的键。 |
| [LICENSE-DeviceKit.txt](./LICENSE-DeviceKit.txt) | 原样保留上游 MIT 许可证与版权声明。 |

读取映射时先用 `Object.hasOwn(mapping, product)` 验证为自有键，再读取字符串名称；未命中一律返回 `null`。不能把对象继承属性或原始技术标识回退成已识别的型号名称。显示来源时明确说明“根据产品标识映射”。

## <span id="jobs-toc-heading-4" data-jobs-toc="v2">三、更新方法 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

1、在 DeviceKit 主仓核对目标提交，使用固定提交 URL 获取 `Source/Device.generated.swift` 和 `LICENSE` 文本；不运行下载的源码、生成器或安装脚本。

2、提取 `mapToDevice(identifier:)` 中全部 iPhone / iPad 字符串标识及其返回的枚举项，再与 `safeDescription` 中相同枚举项的字面量名称连接。一个枚举项可以对应多个标识；发现重复标识、缺失名称或上游语法变化时停止并人工核对，不用猜测补齐。

3、逐项确认每个目标标识均被提取且没有其它设备族混入，按设备族、标识主数字和次数字排序，输出纯 JSON 对象。核对新增、删除和改名内容，保留上游名称，不从用户的真实设备数据补表。

4、同步原始许可证，更新本页获取日期、提交、固定链接、统计和 SHA-256。将来源版本变化与业务代码更新分别审阅；许可证不再允许使用时停止更新。

5、核对已知 iPhone / iPad、未知标识以及 `constructor` 等非自有键的行为；运行项目现有测试及构建。映射变更后需要重新部署后端，浏览器不在运行时请求上游资料。

## <span id="jobs-toc-heading-5" data-jobs-toc="v2">四、系统版本映射 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

[apple-os-versions.json](./apple-os-versions.json)由[Apple Software Lookup Service](https://gdmf.apple.com/v2/pmv)的PublicAssetSets及AssetSets提取，仅保留iPhone/iPad公开构建号、系统版本和支持产品列表。当前包含44个无版本歧义的构建号；同构建号若出现冲突版本则不收录。Apple将该服务列为[公开更新资料源](https://developer.apple.com/documentation/devicemanagement/deploying-software-updates-using-declarative-management)。

后端仅在构建号自有键命中、PRODUCT包含在对应支持列表、版本格式合法时给出系统版本，并标记“版本映射”；实际系统值优先，手工值可更正推导值。未知构建号或产品不匹配保持空值，不根据编号猜测，不使用Safari冻结的UA版本。`24A446 + iPhone14,5`对应`27.0.1`，同时有[Apple发布记录](https://developer.apple.com/news/releases/)印证。此过程不将用户编号发送给Apple，浏览器不请求上游。

更新时重新获取公开PMV，只处理iOS/iPadOS列表，过滤合法版本/构建号及iPhone/iPad产品，按构建号合并、丢弃版本冲突，再运行现有回归与部署。原始PMV只在本机work中作审计；交付仅包含提取后的公开映射。

## <span id="jobs-toc-heading-6" data-jobs-toc="v2">五、许可证 <a href="#前言" style="font-size:17px; color:green;"><b>🔼</b></a> <a href="#🔚" style="font-size:17px; color:green;"><b>🔽</b></a></span><!-- jobs-toc:heading-end -->

资料源自 DeviceKit，采用 MIT 许可证，原始版权声明为 `Copyright (c) 2015 Dennis Weissmann`。原文：[固定提交 LICENSE](https://github.com/devicekit/DeviceKit/blob/19528aa07e1426626ea9fb2c4a161edf43c4f9e8/LICENSE)。再分发本映射时保留同目录的许可证及来源说明；本项目没有复制或修改上游 Swift 库代码。

<a id="🔚" href="#前言" style="font-size:17px; color:green; font-weight:bold;">我是有底线的➤点我回到首页</a>
