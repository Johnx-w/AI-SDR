# Scrapling 对当前获客项目的适用性评估

评估日：2026-10-26，Asia/Shanghai。以当前工作区为基准，包括尚未提交的官网代理和完整 HTML 读取改动。
结论来自本项目源码、已有调查记录及 Scrapling 官方发布、文档和源码；本轮没有安装 Scrapling、运行真实抓取 A/B、调用付费研究、写入飞书或修改生产代码。

## 结论

**值得作为难读官网的可选抓取后备；当前没有证据支持全面替换现有方案。**
对于 JavaScript 才加载的联系信息、部分浏览器指纹拦截或 Cloudflare 挑战，Scrapling 增加了当前 Node HTTP 直读缺少的能力，有机会提高证据取得率。
对于普通静态官网、主体识别、国家核实、评分、搜索获客和飞书入库，它不会自动带来提升；全面替换会增加 Python 与浏览器维护成本。
这是基于能力与架构的判断，尚无本项目同样本实测支持具体成功率、提速倍数或新增企业增幅。
Scrapling 浏览器能力强于本地 HTTP 直读，但当前完整基线是“Node + Tavily 托管提取”；不能据此认定它优于整条现有链路。
网络出口不可达与目标网站反爬属于不同失败原因，浏览器指纹伪装不能代替正确配置代理或解决链路不可达。

**优先顺序：先识别“HTTP 成功但正文无效”，再小范围接抓取后备，最后依据样本结果决定是否长期保留。**
如果没有正文质量检测，新增后备可能根本不会被调用。

## 当前方案已经具备什么

| 环节         | 当前工作区行为                                                                         | 与本次选型的关系                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行时       | Node.js >=24.5；项目依赖没有 Python 或浏览器运行时                                     | Scrapling 需要新增独立运行时或服务。[package.json](../../package.json)                                                                                                        |
| 官网抓取     | `readPublicHtml` 直读原始 HTML，检查公网 URL/DNS；同站 HTTPS 跳转由研究调用方约束      | 不是“只能拿搜索摘要”的实现。[branding.mjs](../../server/branding.mjs)、[native-acquisition.mjs](../../server/native-acquisition.mjs)                                          |
| 网络代理     | 支持 `WEBSITE_HTTPS_PROXY`，Windows 未显式配置时读取启用的系统 HTTPS/统一代理          | Horizons 的历史直连超时已有针对性修复，不能将该收益只归于新爬虫。[website-proxy.mjs](../../server/website-proxy.mjs)、[官网补全文档](../website-enrichment.md)                |
| 完整性       | 完整 HTML 上限 4MiB，超限明确失败；元数据与模型正文预算分别处理                        | 原 512KB 截断及 Markdown 省略页尾链接的问题已有改动。[branding.mjs](../../server/branding.mjs)、[官网补全文档](../website-enrichment.md)                                      |
| 研究边界     | 每家规划最多 5 个官网页面；直读失败后 Tavily basic/Markdown 补抓，最多两批             | 现有边界应保留，不为引入框架扩大为整站爬取。[native-acquisition.mjs](../../server/native-acquisition.mjs)                                                                     |
| 结构化事实   | 合并完整 HTML 中的社媒链接、JSON-LD、表单等；模型正文最多 5页×16000字符，总计80000字符 | 必须保留 HTML；只接新工具的 Markdown 输出会再次损失联系证据。[website-metadata.mjs](../../server/website-metadata.mjs)、[research-input.mjs](../../server/research-input.mjs) |
| 搜索服务契约 | 自定义 HTTP 研究网关同时提供 `/search` 和 `/extract`                                   | Scrapling 不能直接填作完整的现有搜索提供方。[research-providers.mjs](../../server/research-providers.mjs)                                                                     |

当前源码仍存在一个明确缺口：直读仅以 `!content || !researchPageText(content)` 判定无效。
非空的“Checking your browser”挑战页、只有 Home/Contact 的 JS 壳可能被当作成功，因而不进入后备提取。
本轮用内存 mock 已复现这两类页面被接收且 `extractCalls=0`；这是路由缺口的复现，不能推导它在线上的发生比例。[native-acquisition.mjs](../../server/native-acquisition.mjs)

历史样本也要分清原因：

- Horizons：旧读取未使用 Windows 代理，超时后 Tavily Markdown 缺少页尾社媒 href；当前工作区已增加代理和完整读取。[官网补全文档](../website-enrichment.md)
- Shadeotech：历史问题包含 HTML 截断与降级文本省略社媒/城市；完整 HTML、头尾正文和独立元数据处理已有修复。[官网补全文档](../website-enrichment.md)、[回归用例](../../tests/shadeotech-enrichment.test.mjs)
- 历史获客首轮低产出还包含物流企业、官网错配及国家/品牌法人判断问题；这些不是通用抓取库能单独解决的，也不能认定旧问题在今天仍原样存在。[历史试点记录](live-acquisition-pilot-20261024.md)

## Scrapling 核实到的能力与版本边界

截至评估日，GitHub 最新正式发布为 **v0.5**，发布时间 `2026-10-17T21:43:59Z`，即上海时间 2026-10-18。
本报告以下外部技术结论固定到 v0.5，避免把主干文档与旧版 API 混用。[GitHub Release](https://github.com/D4Vinci/Scrapling/releases/tag/v0.5)

| 能力                | 官方证据                                                                                               | 对当前项目的实际意义                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP 浏览器指纹     | `Fetcher` 使用 `curl_cffi`，可模拟浏览器 TLS/headers，支持会话和代理                                   | 部分拒绝 Node HTTP 的官网可能可读；不执行 JavaScript，不能解决 JS 才出现的联系信息。[HTTP 文档](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/fetching/static.md)、[源码](https://github.com/D4Vinci/Scrapling/blob/v0.5/scrapling/engines/static.py)                                |
| 浏览器与 JavaScript | `StealthyFetcher` 使用 Patchright 后端和 Playwright 风格 API，支持 Chromium/Chrome、等待元素、页面动作 | 能补当前原生直读缺少的渲染能力；需配置等待条件，DOM loaded 不保证业务内容已全部加载。[浏览器文档](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/fetching/stealthy.md)、[迁移说明](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/migrating-to-v0.5.md)                          |
| Cloudflare 处理     | 提供 `solve_cloudflare=True`，默认关闭；v0.5 发布专门修复挑战识别/等待问题                             | 是可测试的额外能力；官方“绕过所有类型”的措辞不等于本项目目标站的成功保证，更不能扩展为任意 CAPTCHA/WAF。[浏览器文档](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/fetching/stealthy.md)、[发布说明](https://github.com/D4Vinci/Scrapling/releases/tag/v0.5)                         |
| HTML 与网络证据     | Response 有原始 body；浏览器会话可记录 API 网络响应，支持 open Shadow DOM 提取                         | 可回传 HTML/DOM 给现有解析；公开 API 数据可另行提供证据，但需要明确归属与出处，不宜默认开启大量网络记录。[Response 文档](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/fetching/choosing.md)、[浏览器文档](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/fetching/stealthy.md) |
| 自适应提取          | 先保存某域名元素特征，选择器失效后按相似度重定位；默认关闭，默认 SQLite 存储                           | 更适合重复抓取同站固定字段。当前面对不同企业官网，没有历史模板时收益有限；不负责判断谁是采购人、企业国家或采购意向。[自适应文档](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/parsing/adaptive.md)                                                                                  |
| 爬虫框架            | 会话复用、并发、节流、断点、导出和可选 robots 配置                                                     | 本项目已有任务、缓存、限额和持久化；整套 Spider 接入会产生重复状态，不是本轮推荐范围。[官方 README](https://github.com/D4Vinci/Scrapling/blob/v0.5/README.md)                                                                                                                              |
| MCP                 | 提供 HTTP、浏览器、会话、动作、截图及网络检查工具，HTTP 模式有认证配置                                 | 适合人工辅助排障或交互研究；不是自动接入现有 Node 业务链，仍需适配。不为此让模型每页自主选择任意浏览器动作。[MCP 文档](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/ai/mcp-server.md)                                                                                               |

v0.5 已移除 `DynamicFetcher`/`DynamicSession`，统一使用 stealthy 类；旧示例不可直接套用。
网络捕获和 MCP 工具名也有破坏性变更，应固定版本并独立验证升级。[v0.5 迁移说明](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/migrating-to-v0.5.md)

### 安装与维护成本

- Python 要求 >=3.10；包元数据仍标注 Beta。仅 `pip install scrapling` 只有解析器，抓取需要 `[fetchers]` 额外依赖。[v0.5 pyproject](https://github.com/D4Vinci/Scrapling/blob/v0.5/pyproject.toml)
- HTTP 抓取不需要浏览器安装；浏览器路径还要 `scrapling install` 下载浏览器及相关依赖。相关依赖包括 `curl_cffi`、Playwright、Patchright、browserforge 和指纹数据。[安装说明](https://github.com/D4Vinci/Scrapling/blob/v0.5/README.md#installation)、[依赖声明](https://github.com/D4Vinci/Scrapling/blob/v0.5/pyproject.toml)
- 官方 Docker 镜像提供另一种部署方式，但镜像 `latest` 由主干构建；实际集成需固定可复现版本/镜像摘要，不能视为自动跟随稳定发布。[Docker 说明](https://github.com/D4Vinci/Scrapling/blob/v0.5/README.md#docker)
- 项目采用 BSD-3-Clause，许可证本身不按页收费；服务器、浏览器 CPU/内存、代理流量、更新和排障仍是总成本。外部搜索、模型、海关费用仍另计。[许可证](https://github.com/D4Vinci/Scrapling/blob/v0.5/LICENSE)

现有总投入口径以稳定产出和维护时间为先，搜索/模型单价不是唯一优化目标；增加自托管服务应证明质量或维护收益。[现有开源方案评估](oss-acquisition-options-20261024.md)

### 官方“快很多”能证明什么

官方 benchmark 是解析器测试：5000 层嵌套元素的文本提取，以及元素相似度/文本查找，平均 100 次计时。
源码计时器使用 `time.process_time`；这些不是网页网络延迟、浏览器启动、反爬成功率、模型用量或最终入库产率测试。
对照对象也不是本项目当前的 Node 直读与解析链，因此不能把 README 的倍数写成“本项目获客将快几百倍”。[官方 benchmark](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/benchmarks.md)、[测试源码](https://github.com/D4Vinci/Scrapling/blob/v0.5/benchmarks.py)

## 是否会比现在更好

下表“可能”均为技术推断，尚未在本项目用 Scrapling 实测。

| 场景/目标                      | 当前方案                                   | 加入 Scrapling 后备                            | 判断                                       |
| ------------------------------ | ------------------------------------------ | ---------------------------------------------- | ------------------------------------------ |
| 可正常直读的静态官网           | 已能读取完整 HTML，提取页尾与结构化证据    | 同样取得 HTML，但增加跨运行时调用              | 通常没有足够收益理由替换                   |
| JS 才生成的产品/联系信息       | 原生 HTTP 不渲染，依赖后备提取是否取得内容 | 浏览器渲染后交给现有规则                       | 最有价值的候选场景                         |
| 浏览器指纹拦截                 | Node HTTP 可能被拒                         | `Fetcher` 模拟 TLS/headers 可能改善            | 可先试轻量 HTTP 后备                       |
| 部分 Cloudflare 挑战           | 可能得到拒绝或非空挑战页                   | stealthy/挑战处理有额外机会                    | 有价值，但先修质量检测和失败路由           |
| 页尾社媒、JSON-LD、表单完整性  | 当前完整 HTML 已支持                       | 保留完整 HTML/渲染 DOM 才有价值                | 不因换工具自动改善；只回 Markdown 可能退步 |
| 搜索发现更多相关企业           | Tavily/海关等提供候选来源                  | Scrapling 没有同等搜索索引或海关数据库         | 不替代；抓取搜索结果也不等同搜索服务       |
| 企业身份、国家、供货方向、评分 | 现有领域规则、证据核验和模型分析           | 更完整页面可能间接支持事实，业务判断仍需原流程 | 无直接替代关系                             |
| 最终新增企业数量               | 还受来源、去重、准入、证据和写入约束       | 仅改善其中“取得网页”一步                       | 暂无依据承诺新增明显增加                   |
| 延迟与维护成本                 | 一个 Node 主链，失败时调用已有后备         | 新增 Python/浏览器、等待、代理与升级维护       | 只对问题页按需启用更合理                   |

## 推荐接入位置与边界

建议只在 `NativeAcquisition` 的 `collect/readPage` 附近增加“读取官网”的适配能力。
保留搜索发现、页面规划、模型 Schema、事实引文核验、去重、评分、海关及飞书同步；不将 Scrapling MCP 或 Spider 改成业务编排主系统。[native-acquisition.mjs](../../server/native-acquisition.mjs)、[research-providers.mjs](../../server/research-providers.mjs)

建议的按需读取流程如下；具体顺序在试点后确定，不应对每个页面把所有后备都跑一遍：

1. 现有 Node 直读，沿用当前代理、缓存、URL 限制和 HTML 上限。
2. 检查正文是否可用于研究：识别挑战/验证码、JS 壳、错误页和明显无关内容；记录失败类别，不能只看 HTTP200 或非空。
3. 对疑似 TLS/headers 拦截，试一次 Scrapling `Fetcher`；对 JS 壳或明确需要渲染的页面，直接试 `StealthyFetcher`。
4. 仍失败时沿用 Tavily 提取或记录资料缺项；低频失败页若托管后备更省维护，可继续只用现有后备。
5. 保持每家最多 5 页的研究预算，设置整家企业/整次任务总时限，避免多层重试乘积拖长运行。

接入时需要具体做到：

- 返回与现有读取适配兼容的 `{html}` / `{redirect}`，另外保留最终 URL、HTTP 状态、读取方式、耗时与明确失败原因。
- 浏览器返回的内容标明“渲染 DOM”，HTTP body 标明原始 HTML；来源 URL 和采集时间必须可追溯。
- 完整证据提取先于正文裁剪，继续使用现有 `combineWebsiteEvidence`；保持社媒 href、表单和 JSON-LD 的回归保障。
- 当前公网 URL、DNS、同站跳转约束不可在 Python 服务处绕开；浏览器还要控制子请求、iframe、重定向与 DNS 解析，不能只检查初始 URL。
- 默认只读取公开官网；复用短期会话以减少浏览器启动，不开启长期登录、任意交互或第二套爬虫调度。
- 显式覆盖后备的重试/超时默认值：Scrapling HTTP 默认最多 3 次尝试，每次默认 30 秒；浏览器操作默认 30 秒，叠加等待可能超过当前预算。[HTTP 参数](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/fetching/static.md)、[浏览器参数](https://github.com/D4Vinci/Scrapling/blob/v0.5/docs/fetching/stealthy.md)

这些是适配设计建议，尚未实现或验证；特别是浏览器网络边界不能用“已有起始 URL 校验”替代。
本建议继续遵守有限页面公开研究的现行决策。[ADR-0008](../adr/0008-broad-company-capture-and-initial-priority.md)

## 建议如何验证，再决定是否采用

建议选 **20–30 家企业**，包含正常静态官网、确需 JS 的官网及历史读取困难官网，三类各有样本。
Horizons 和 Shadeotech 可作完整性回归样本，但不能将已经修复的问题算作 Scrapling 的新增收益。
记录样本清单并固定同一时间窗、官网 URL、每家页数、网络代理与研究预算，避免挑选成功站点改变分母。

| 比较项         | 记录方式                                                               | 建议试点门槛，非实测结果                                                            |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 有效证据取得率 | 人工确认正确官网中取得可核实产品/身份/联系证据的企业数；挑战页不算成功 | 问题站点提高至少 20 个百分点，或 10 家问题样本净救回至少 2 家；小样本只用于试点决策 |
| 字段准确与完整 | 对照原页核对邮箱、电话、社媒、表单、国家和主体；区分“缺失”和“错误”     | 正常静态样本无回归，新增字段都有真实出处；不允许把平台运营方/错误企业资料归给潜客   |
| 等待和资源     | 每页/每家 P50、P95，浏览器峰值内存、重试次数和超时                     | 只对失败页付额外等待；建议先用每家额外不超过 60 秒的试点预算，再按产出权衡          |
| 总投入         | 后备调用、代理流量、机器、维护工时和人工纠错时间                       | 同等证据质量下，新增运行/维护投入能由有效救回企业的价值解释                         |
| 最终业务产出   | 同样候选、去重、准入规则下可收录企业和资料缺项变化                     | 将取得网页与新增收录分别报告，不能用页数/邮箱数代替企业数                           |

先以只读结果/待写入计划比较，不为测试重复写飞书或触发触达；模型相关对比应复用缓存与相同模型规则。
上述阈值是建议的工程验收条件，不能当作供应商 SLA、收益预测或统计显著性结论。
少量问题页达不到门槛时，继续当前 Node + Tavily 路径，比长期维护第二套运行时更合适。

## 本轮已验证与未验证

- 已核对当前代码，并由只读内存 mock 复现非空挑战/JS 壳绕过后备的情况。
- 已运行现有四组离线回归：`website-proxy`、`horizons-contact-enrichment`、`shadeotech-enrichment`、`native-cost-control`，15/15 通过；覆盖代理、私网拒绝、页尾社媒、HTML 上限、模型正文预算与研究缓存。
- 这些测试使用 fixture/mock，证明的是当前代码的受测行为，不能作为 live 网络成功率或 Scrapling 性能证据。
- 未安装 Scrapling、下载浏览器、跑同样本 A/B 或验证目标站的挑战通过率；未进行付费调用、飞书写入、生产改造、提交或推送。

**当前决策建议：保留现有主链；将“正文质量检测 + Scrapling 按需后备”列为可验证的小范围改进。只有问题站点实测收益覆盖新增维护投入后，再正式接入。**
