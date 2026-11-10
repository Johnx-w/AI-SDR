# 项目文档

2026-11-10 逐篇对照当前工作区代码整理。设计新功能先按主题读取下表，再按需读取有效 ADR。实现说明描述仓库代码；待实现设计保留已确认的目标，不能当作功能已经接通。云端实际版本、连接和业务数量须从运行环境核验。

## 当前业务与运行入口

| 需要了解的内容                       | 文档                                                    | 范围与状态                                                       |
| ------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------- |
| 定位、开发启动与检查                 | [项目 README](../README.md)                             | 本机开发、云端发布入口及运行限制                                 |
| 获客、搜索、预算、定时计划与自动首发 | [获客](acquisition.md)                                  | 官网唯一自动获客来源；SQLite 主库先保存、飞书后台同步            |
| 客户、产品、自动需求及只读追信任务   | [客户与产品数据](customer-data.md)                      | T1/T3/T4 自动记录；正式原 T5 不再接收网页产品镜像                |
| 当前评级与客户档案                   | [客户评级](assessment.md)                               | `acquisition-v5.0`；A/B/C 按方向取证，普通缺项不作为人工补档门槛 |
| 首封、收信、阅读、人工回复及发送事实 | [邮件沟通](outreach-first-touch.md)                     | 后台收信及 72／168 小时追信已实现；正式自动回信待接入            |
| AI 业务员与自动接待                  | [当前实现与待实现设计](ai-sales-agent-design.md)        | 四品类正式配置、授权与自动回信待实现                             |
| 模块、接口、存储、部署、备份与恢复   | [架构与运行](architecture.md)                           | 标准交付流程入口；文档整理不执行发布或真实业务                   |
| 飞书字段与数据归属                   | [飞书镜像填写规范](new-feishu-bitable-filling-spec.md)  | 正式 Base 与测试环境分开；前三条模板仍为运行代码读取源，保持停用 |
| 自动首发检查范围                     | [测试用例与验收](acquisition-auto-first-touch-tests.md) | 当前业务预期和离线复跑入口；历史执行次数已归档                   |

## 术语、开发约定与规则资产

| 内容                   | 入口                                                         | 用法                                         |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| 业务术语               | [GLOSSARY](../GLOSSARY.md)                                   | 领域含义；不承担功能已实现的证明             |
| 开发约定与文档读取范围 | [AGENTS](../AGENTS.md)                                       | 提交、发布、正式数据目标及归档排除规则       |
| 领域文档读取           | [Domain docs](agents/domain.md)                              | 本仓库使用根词汇表和当前 ADR                 |
| Issue 与规格维护       | [Issue tracker](agents/issue-tracker.md)                     | GitHub Issues 与 `gh` CLI                    |
| 首封写作               | [First-touch writer](../agents/first-touch-writer/system.md) | 现行首封运行模块读取的写作规则               |
| 四品类规则与协议       | [四品类业务员](../agents/export-sales/README.md)             | 来信规则、图纸和知识准备资产；正式接待待接入 |

四品类的 `shared-system.md` 与 `category-profiles.json` 生成四份来信提示词；`conversation-contract.md`、`mailbox-routing.md`、`knowledge-checklist.md` 和 `drawing-protocol.md` 分别维护协议、品牌路由、资料准备和图纸规则。现有 Schema 为 1.3，正式接待的 1.4 为待实现设计，不能提前声称已升级。

## 有效 ADR

仅按本次功能涉及的主题读取。文件中的状态区分已实现规则和待实现设计；已撤销的 ADR-0015、ADR-0021 已移出本目录。

| 决定                                                                        | 主题与当前边界                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------- |
| [ADR-0001](adr/0001-separate-company-and-supply-opportunities.md)           | 企业与供货方向分别判断，最新评估不设 T12       |
| [ADR-0002](adr/0002-web-primary-operational-interface.md)                   | 网页操作、服务器主库和飞书协作镜像             |
| [ADR-0003](adr/0003-category-demands-with-shared-conversations.md)          | 四品类与统一回信，正式接待待实现               |
| [ADR-0004](adr/0004-reviewed-drawing-facts-and-versioned-assets.md)         | 候选准备已有；参数级批准及自动附图待实现       |
| [ADR-0005](adr/0005-one-mailbox-per-customer-with-shared-catalog.md)        | 固定邮箱已有；回信总目录协作待接入             |
| [ADR-0008](adr/0008-broad-company-capture-and-initial-priority.md)          | 宽泛收录与主库新增口径                         |
| [ADR-0009](adr/0009-business-tables-with-web-managed-configuration.md)      | 业务表、只读镜像与配置归属                     |
| [ADR-0010](adr/0010-message-evidence-and-scoped-follow-up-tasks.md)         | 真实沟通证据，已移除手工默认流程               |
| [ADR-0012](adr/0012-route-first-outreach-by-approved-brand-products.md)     | 品牌具体产品覆盖决定首封邮箱                   |
| [ADR-0014](adr/0014-original-mail-format-and-manual-replies.md)             | 原格式阅读与人工回复                           |
| [ADR-0017](adr/0017-automatic-sending-with-confirmed-information.md)        | 基础首封免逐封审核；标准商务自动回信待实现     |
| [ADR-0018](adr/0018-simple-llm-outreach-with-fixed-signatures.md)           | 独立首封写作；旧专业模式及审批链已移除         |
| [ADR-0019](adr/0019-ai-sales-agents-with-controlled-mail-reception.md)      | 正式接待独立授权；配置及运行链路待实现         |
| [ADR-0020](adr/0020-website-only-acquisition.md)                            | 官网为唯一自动获客来源                         |
| [ADR-0022](adr/0022-unified-abc-customer-grades.md)                         | 当前统一 A/B/C，实际回填另行核验               |
| [ADR-0023](adr/0023-acquisition-scoped-automatic-first-touch.md)            | 获客范围内逐家自动首发及计划控制               |
| [ADR-0024](adr/0024-align-feishu-business-mirrors.md)                       | 当前评级与真实沟通镜像，正式原 T5 停止产品镜像 |
| [ADR-0025](adr/0025-automatic-business-records-with-read-only-followups.md) | 自动需求、真实往来与只读追信任务               |

## 维护与归档

- 改业务行为时同步所属主题及必要 ADR；保留有效决定的理由，移除正文中已被替代的操作规则。
- 已撤销文档移入归档，同步修复引用和导航。历史验收次数、业务数量、迁移和一次性执行记录不作为当前事实。
- 待实现设计明确标注状态；代码已增加局部能力时，说明已覆盖范围及尚未接通部分，不将整份设计标成已完成。
- 提示词从共享源生成；运行 `node agents/export-sales/build-prompts.mjs --check` 核对。协议升级同步 Schema、示例和校验。
- 日常搜索与读取按 [AGENTS](../AGENTS.md#新功能设计的文档依据) 排除 `docs/archive/**`，不自动跟随历史链接。只有用户明确要求查历史或比对旧版本时才进入 [归档目录](archive/README.md)。
