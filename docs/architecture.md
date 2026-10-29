# 架构与运行

当前口径：2026-10-28。React／TypeScript 网页通过同源 Node.js HTTP 接口操作后端，业务执行不依赖开发用 MCP 或 Codex OAuth。本机持久库采用 Node.js 内置 SQLite，客户与协作资料同步飞书；当前为单用户、单进程版本。

业务行为分别见 [获客](acquisition.md)、[客户与产品数据](customer-data.md)、[评分与海关](assessment-and-customs.md)、[邮件沟通](outreach-first-touch.md)。[AI 业务员设计](ai-sales-agent-design.md) 明确待实现部分，不属于当前接口能力。

## 模块职责

| 范围            | 现有模块与职责                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 与引擎选择 | server/app.mjs 校验参数、来源和请求幂等；createAcquisitionProvider 选择 native／n8n                                                      |
| 获客调度        | batch-jobs 负责预算、进度、暂停与恢复；search-plan 负责查询；引擎负责单企业处理                                                          |
| 检索与研究      | 检索、官网采集、结构化研究、身份／引文核验和程序评分分工，沿用共享业务函数                                                               |
| 客户副本及评估  | lead-library 维护飞书读取副本；AssessmentStore 保留最新快照；补充资料独立留痕                                                            |
| 客户业务与产品  | CustomerBusiness 维护会话、需求、消息、任务和人工归属；产品资料管理审核版本                                                              |
| 首封开发        | outreach-service 管理计划、邮箱匹配、企业占用和发送队列；outreach-content 生成与检查                                                     |
| 邮件收发        | mail-conversations 保存原文和同步游标；mailbox-reader 只读 IMAP；mail-replies 管理草稿与幂等回信；outreach-mailboxes 管理加密账号和 SMTP |
| 邮件业务桥接    | outreach-business、mail-conversation-business 只登记实际往来，不以记录失败触发再次发送                                                   |
| 网页状态        | WorkspaceProvider 只负责界面通知，真实业务读取后端；已退役演示仓储不再加载                                                               |

四品类提示词由共享 Markdown 与品类配置生成。将来自动接待在现有模块之上增加接待配置、来信触发、授权核验和处理台账；复用客户历史及发送能力，不另外维护一套客户数据库。

## 现有接口

以下列出接口入口和关键约束，字段以对应 server 路由及现有测试为准。

| 范围       | 入口与用途                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| 健康与连接 | GET /api/health；GET／PUT /api/v1/connections；POST /api/v1/connections/models                                              |
| 获客       | /api/v1/acquisition 下的 status、locations、products、search-preview、jobs、schedules、runs、executions                     |
| 批量任务   | GET／POST /jobs，GET /jobs/:id，POST /jobs/:id/stop、resume                                                                 |
| 定时计划   | GET／POST /schedules，POST /schedules/:id/pause、resume、close                                                              |
| 客户读取   | GET /api/v1/leads/real/list、/:id、/metrics；POST /api/v1/leads/real/refresh；GET /api/v1/leads/real 用于完整快照／导出兼容 |
| 评估与补充 | GET /api/v1/assessments/rules；GET／POST /api/v1/leads/real/:id/assessments、supplements                                    |
| 产品资料   | GET／POST／PUT /api/v1/products/knowledge；POST /api/v1/products/knowledge/:id/sync                                         |
| 客户业务   | /api/v1/business 下的 schema、conversations、messages、demands、tasks、sync；任务提供 preflight 与 action                   |
| 邮件       | /api/v1/outreach 下的邮箱、计划、会话和发送记录；会话提供 sync、read、draft 和 reply                                        |

新增业务操作使用持久幂等编号；编辑核对当前版本。旧评估历史重试返回 410；旧固定邮箱试点 /api/v1/mail/\*、已移除搜索词生成接口返回 404。邮件读取／同步不自动回复，也不修改原邮箱已读；人工回信由 reply 入口单独发送。

配置状态只说明所需配置是否齐备，不能当作远端健康或业务成功。常见状态为 400 参数错误、403 来源拒绝、409 冲突／待核对、413 过大、415 格式不支持、429 并发限制、502 上游失败、503 未配置、504 远端结果不明。不会降级为虚构成功。

## 存储与备份

| 数据                       | 默认位置或配置                                                           |
| -------------------------- | ------------------------------------------------------------------------ |
| 获客任务、操作及相关业务   | .data/acquisition.sqlite；ACQUISITION_DB_PATH／BATCH_DB_PATH             |
| 定时计划                   | .data/acquisition-schedules.sqlite                                       |
| 客户读取副本               | .data/lead-library.sqlite；LEAD_LIBRARY_DB_PATH                          |
| 海关页、预算和游标         | 默认复用获客库，可指定 CUSTOMS_DB_PATH                                   |
| 最新评估、客户业务         | 默认复用获客库，可分别指定 ASSESSMENT_DB_PATH、CUSTOMER_BUSINESS_DB_PATH |
| 触达、会话、草稿和发送台账 | .data/outreach/outreach.sqlite；OUTREACH_DB_PATH                         |
| 连接及邮箱配置             | .data/api-connections.json；OUTREACH_DATA_DIR 下加密邮箱文件             |
| 其他本机材料               | Logo 缓存、原始证据、镜像核对日志及私有备份，按既有路径隔离              |

数据库、WAL、凭证和原始业务证据不入 Git。备份先停服务或使用一致性 SQLite 备份，不能只复制运行中的主数据库文件；同时保留配置、资产及核对日志。Windows 邮箱凭证绑定当前机器／用户，迁移后重新录入。不要多个工作进程同时操作同一运行库。

正式入口为 server/index.mjs，提供持久化路径；测试中省略路径可使用隔离内存库，不代表正式运行可以省略存储。创建和恢复都核对作用域及版本，较旧操作不能覆盖较新事实。

## 运行与恢复

开发使用 `npm run dev`，生产先 `npm run build`，再 `npm start`。生产后端不自动重载；变更前先核对活跃任务，在原服务终端停止后重启，使用原端口检查配置及关键读取接口。不要把旧日期的迁移命令加入常规启动。

关闭网页保留后端任务；服务中断后，获客任务按原操作核对，发送结果不明先检查渠道记录。定时计划错过时点与人工暂停的恢复规则不同，见获客说明；自动发信、人工回复和未来自动接待分别检查授权。

当前仅监听 127.0.0.1，邮件接口保留本机来源限制；没有团队登录、角色权限和公网生产部署。部署到公网需先完成身份认证、权限、HTTPS、备份及运行审计，不能仅改监听地址。服务端凭证不返回浏览器，前端连接覆盖与进程环境的优先级见获客说明。

## 兼容 n8n 引擎

ACQUISITION_PROVIDER 选择执行引擎；旧 /api/v1/integrations/n8n 路径映射到所选引擎，不绕开配置。回退时先核对未结束任务，再修改配置并重启；若连接页有覆盖值，需同时修改，历史任务仍由创建它的引擎恢复。

n8n 使用已发布 Production Webhook 和服务端 Header Auth；测试地址只适合手动监听。N8N_WEBHOOK_URL、N8N_WEBHOOK_SECRET、N8N_WEBHOOK_ENABLED 由服务端配置；执行历史 Public API 可选，客户只读入口为独立配置。开发工具 OAuth 不提供给业务网页。

批量 discover／research／status 协议与旧单次 runs 区别处理。HTTP 200 或 completed 只说明拿到结果，实际写入仍需记录 ID 和读回；批量不确定操作按原编号查询，旧单次缺少恢复能力时保持待核对，不重放。

工作流生成脚本依赖相应快照与共享函数，尤其历史建列／删列脚本不能作为幂等部署反复执行。修改线上流程前先读取当前版本、比较差异；原节点教程和历史 workflow ID 查 [归档](archive/2026-10-28/n8n-integration.md)，当前默认运行不需要重建旧工作流。

## 检查范围

代码修改按涉及模块运行现有测试，前端变更再构建。提示词文案修改运行生成命令、--check 及 agent-policy 测试。真实搜索、模型、海关、飞书写入或发信验收与离线测试分别记录；归档的通过次数、客户数量和费用只表示当时情况。

文档整理只检查结构、链接、生成一致性及相关现有规则测试，不因整理文档触发真实业务任务。历史方案保留在 [归档目录](archive/README.md)。
