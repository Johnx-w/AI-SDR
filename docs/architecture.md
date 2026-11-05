# 架构与运行

当前口径：2026-10-28。React／TypeScript 网页通过同源 Node.js HTTP 接口操作后端，业务执行不依赖开发用 MCP 或 Codex OAuth。本机持久库采用 Node.js 内置 SQLite，客户与协作资料同步飞书；当前为单用户、单进程版本。

业务行为分别见 [获客](acquisition.md)、[客户与产品数据](customer-data.md)、[评分](assessment.md)、[邮件沟通](outreach-first-touch.md)。[AI 业务员设计](ai-sales-agent-design.md) 明确待实现部分，不属于当前接口能力。

## 模块职责

| 范围            | 现有模块与职责                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 与获客入口 | server/app.mjs 校验参数、来源和请求幂等；createAcquisitionProvider 封装直连获客服务                                                      |
| 获客调度        | batch-jobs 负责预算、进度、暂停与恢复；search-plan 负责查询；引擎负责单企业处理                                                          |
| 检索与研究      | 检索、官网采集、结构化研究、身份／引文核验和程序评分分工，沿用共享业务函数                                                               |
| 客户档案及评估  | lead-library 保存 SQLite 客户主档案；customer-archive 管理后台飞书同步与编号关联；AssessmentStore 保留最新快照                           |
| 客户业务与产品  | CustomerBusiness 维护会话、需求、消息、任务和人工归属；产品资料管理审核版本                                                              |
| 首封开发        | outreach-service 管理计划、邮箱匹配、企业占用和发送队列；outreach-content 生成与检查                                                     |
| 邮件收发        | mail-conversations 保存原文和同步游标；mailbox-reader 只读 IMAP；mail-replies 管理草稿与幂等回信；outreach-mailboxes 管理加密账号和 SMTP |
| 邮件业务桥接    | outreach-business、mail-conversation-business 只登记实际往来，不以记录失败触发再次发送                                                   |
| 网页状态        | WorkspaceProvider 只负责界面通知，真实业务读取后端；已退役演示仓储不再加载                                                               |

四品类提示词由共享 Markdown 与品类配置生成。将来自动接待在现有模块之上增加接待配置、来信触发、授权核验和处理台账；复用客户历史及发送能力，不另外维护一套客户数据库。

## 现有接口

以下列出接口入口和关键约束，字段以对应 server 路由及现有测试为准。

| 范围       | 入口与用途                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 健康与连接 | GET /api/health；GET／PUT /api/v1/connections                                                                                       |
| 获客       | /api/v1/acquisition 下的 status、locations、products、search-preview、jobs、schedules、runs、executions                             |
| 批量任务   | GET／POST /jobs，GET /jobs/:id，POST /jobs/:id/stop、resume                                                                         |
| 定时计划   | GET／POST /schedules，POST /schedules/:id/pause、resume、close                                                                      |
| 客户读取   | GET /api/v1/leads/real/list、/:id、/metrics；POST /api/v1/leads/real/refresh；GET /api/v1/leads/real 用于完整快照／导出兼容         |
| 评估与补充 | GET /api/v1/assessments/rules；GET／POST /api/v1/leads/real/:id/assessments、supplements                                            |
| 产品资料   | GET／POST／PUT /api/v1/products/knowledge；POST /api/v1/products/knowledge/:id/sync                                                 |
| 产品原文件 | GET／POST /api/v1/products/knowledge/:id/documents；GET /:documentId/file；POST /:documentId/extract（后两项接在 documents 路径下） |
| 客户业务   | /api/v1/business 下的 schema、conversations、messages、demands、tasks、sync；任务提供 preflight 与 action                           |
| 邮件       | /api/v1/outreach 下的邮箱、计划、会话和发送记录；会话提供 sync、read、draft 和 reply                                                |

新增业务操作使用持久幂等编号；编辑核对当前版本。旧评估历史重试返回 410；旧固定邮箱试点 /api/v1/mail/\*、已移除搜索词生成接口返回 404。邮件读取／同步不自动回复，也不修改原邮箱已读；人工回信由 reply 入口单独发送。

配置状态只说明所需配置是否齐备，不能当作远端健康或业务成功。常见状态为 400 参数错误、403 来源拒绝、409 冲突／待核对、413 过大、415 格式不支持、429 并发限制、502 上游失败、503 未配置、504 远端结果不明。不会降级为虚构成功。

### 上传图纸与产品规格

先在产品资料库保存产品草稿，再在「查看 / 编辑」上传 PDF、PNG/JPG，单文件最多 10 MB，每个产品最多保留 20 份原文件。同一产品上传相同内容会返回已有文件；不同内容作为独立文件保留，SHA-256、文件名和上传时间可供核对，不覆盖旧原文件。

在 API 连接的「产品资料 · 图纸与规格识别」填写 `DOCUMENT_MODEL_BASE_URL`、`DOCUMENT_MODEL_API_KEY`、`DOCUMENT_MODEL_MODEL`。服务须支持 Responses API、图片/PDF 输入及 JSON Schema 输出；基础地址包括服务商所需的 `/v1`（例如 `https://api.openai.com/v1`）。本功能不自动借用企业研究模型。文件输入协议参见 [OpenAI File inputs](https://developers.openai.com/api/docs/guides/file-inputs) 和 [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)。

上传只写入本地库；用户点击 AI 提取才将原文件发送到已配置的模型服务。AI 结果单独保存为候选，保留页序号、位置、模型和提取时间。模糊标注及不确定归属列为提示；价格、MOQ、交期等需人工另行填写并沿用其适用条件和有效期规则。超过 60 条参数的文件应拆分，不能视为完整提取。网络失败、截断或无效输出不改动产品资料，原文件保留，可重试；成功结果重试直接复用。

用户下载原文件核对，编辑候选后点「加入待审核参数」，再保存草稿或审核。仅纳入产品记录的参数参与原有审核与版本流程；上传及提取本身不产生产品事实或发送权限。已审核内容或所关联原文件改变后退回待审核，需再次审核。产品的 `documentIds` 只能引用本产品的文件；原文件不会自动成为邮件附件。此功能只打通资料准备，自动回信运行链路仍按 ADR-0019 待实现。后续接待只能读取已审核、生效的产品资料，不能读取候选结果作为供货事实。

原文件二进制和候选结果存放在产品资料 SQLite 的 `product_documents` 表，与产品资料一起备份；飞书仅镜像原文件编号，不上传私有图纸。首版不解析 CAD，也不建立向量库。

## 存储与备份

| 数据                       | 默认位置或配置                                                           |
| -------------------------- | ------------------------------------------------------------------------ |
| 获客任务、操作及相关业务   | .data/acquisition.sqlite；ACQUISITION_DB_PATH／BATCH_DB_PATH             |
| 定时计划                   | .data/acquisition-schedules.sqlite                                       |
| 客户档案及待同步操作       | .data/lead-library.sqlite；LEAD_LIBRARY_DB_PATH                          |
| 企业 Logo 及网站图标       | .data/branding/branding.sqlite；BRANDING_CACHE_PATH 可调整所在目录       |
| 最新评估、客户业务         | 默认复用获客库，可分别指定 ASSESSMENT_DB_PATH、CUSTOMER_BUSINESS_DB_PATH |
| 触达、会话、草稿和发送台账 | .data/outreach/outreach.sqlite；OUTREACH_DB_PATH                         |
| 连接及邮箱配置             | .data/api-connections.json；OUTREACH_DATA_DIR 下加密邮箱文件             |
| 其他本机材料               | 原始证据、镜像核对日志及私有备份，按既有路径隔离                         |

数据库、WAL、凭证和原始业务证据不入 Git。备份先停服务或使用一致性 SQLite 备份，不能只复制运行中的主数据库文件；同时保留配置、资产及核对日志。Windows 邮箱凭证绑定当前机器／用户，迁移后重新录入。不要多个工作进程同时操作同一运行库。

企业品牌图片按官网域名保存，图片内容与官网对应关系一起持久化到 SQLite。成功获取的 Logo 不设过期时间，重启或官网不可用时直接读取数据库；仅有网站图标时保留旧图并重试升级，抓取失败只短暂缓存。首次读取自动导入原 `.data/branding`（或 `BRANDING_CACHE_PATH`）下有效的 JSON／图片文件，保留原文件，旧空结果不迁移。备份时须包含品牌图片数据库，浏览器会话缓存只用于加速显示。

正式入口为 server/index.mjs，提供持久化路径；测试中省略路径可使用隔离内存库，不代表正式运行可以省略存储。创建和恢复都核对作用域及版本，较旧操作不能覆盖较新事实。

## 运行与恢复

开发使用 `npm run dev`，生产先 `npm run build`，再 `npm start`。生产后端不自动重载；变更前先核对活跃任务，在原服务终端停止后重启，使用原端口检查配置及关键读取接口。不要把旧日期的迁移命令加入常规启动。

关闭网页保留后端任务；服务中断后，获客任务按原操作核对，发送结果不明先检查渠道记录。定时计划错过时点与人工暂停的恢复规则不同，见获客说明；自动发信、人工回复和未来自动接待分别检查授权。

当前仅监听 127.0.0.1，邮件接口保留本机来源限制；没有团队登录、角色权限和公网生产部署。部署到公网需先完成身份认证、权限、HTTPS、备份及运行审计，不能仅改监听地址。服务端凭证不返回浏览器，前端连接覆盖与进程环境的优先级见获客说明。

## 一键发布与回退

当前发布目标为 SSH 别名 `ai-sdr` 对应的 Linux 服务器，由 `shadeflow.service` 以 `shadeflow` 用户运行，内部端口为 14311。发布电脑需有 Node.js 24.5+、Git、OpenSSH、tar、已登录的 GitHub CLI（`gh auth login`），以及 GitHub 推送和 Actions 读取权限；SSH 别名需指定发布密钥和已核对的服务器主机密钥。

提交本次改动后，在项目目录运行：

```powershell
npm run release:check
npm run release
# 需要恢复上一代码版本时：
npm run release:rollback
```

发布只处理当前分支的已提交版本，工作区有未提交文件时会停止。检查、安装依赖和构建均在临时目录进行，本机正在运行的开发服务及其 `node_modules`、`.data` 不变。格式检查、测试、构建全部成功后，推送当前分支对应提交，不自动合并 main、不强推。

所有分支的推送都会触发 `.github/workflows/ci.yml`。发布脚本只认可 `Johnx-w/AI-SDR` 中同一完整提交号最新一次 `push` 运行：整体成功，且该次运行当前尝试的 `checks`（Windows 格式、测试、构建）和 `release`（Linux 发布测试）两个作业都完成并成功后，才上传和部署该提交。PR 检查、其他提交或更早的成功运行不能代替；缺少或跳过必需作业、失败、取消、查询错误都停止发布。CI 尚未创建或未完成时每 10 秒查询一次，最多等待 20 分钟；等待期间本地 HEAD 变化也会停止。CI 或服务器发布失败时，已经推送的提交仍保留在 GitHub，命令以失败退出，可排除问题后重试。

门禁覆盖 `npm run release` 的新版本部署；`release:check` 保持只读，`release:rollback` 保留恢复上一代码版本的行为，不重新等待 CI。

服务器在 `/srv/shadeflow/releases/<完整提交号>` 安装 Linux 生产依赖，准备成功后才停止旧服务。发布前须暂停自动获客和发信计划，等待进行中的任务结束，并在维护期间停止手动业务操作；脚本会检查已有任务状态，发现活跃任务或启用的计划就停止发布。不要同时启动两个服务操作同一数据库。

每次切换先停止服务，备份 `.data`、存在的 `.env`／`.env.local` 以及 systemd 配置到 `/srv/shadeflow/backups/`。原 `/srv/shadeflow/app` 保留作为首次部署前的代码版本及数据存储位置；各新版本的 `.data` 和环境文件链接到这里。首次发布仅新增 systemd 的 `release.conf`，将工作目录指向 `/srv/shadeflow/current`，保留原启动命令、运行用户、端口等设置。

启动后检查实际进程目录、健康接口和网页。失败时切回原代码并重新启动；成功版本与上一版本记录在 `/srv/shadeflow/release-state.json`。`release:rollback` 也先备份并检查启动结果，始终保留当前业务数据。代码回退不能撤销已发出的邮件、飞书写入或数据库迁移；涉及不兼容数据库结构变更时，必须另行制定迁移与恢复步骤，不能依赖代码回退。数据备份不自动覆盖运行库，以免丢失发布后新增记录。

备份和旧版本不自动删除，按磁盘使用情况人工保留或清理。若断电或进程被强制结束导致 `.release-lock` 遗留，先核对其中 PID 已不再运行，再移除锁并检查服务／版本状态，不能在另一次发布仍运行时解锁。依赖安装失败会清理临时版本，可重新执行发布；已准备完成的同一提交可复用，正在运行的同一提交通过健康检查后直接完成，不重复重启服务。

## 执行与核对

获客只使用后端直连引擎与 /api/v1/acquisition 接口。配置页只维护检索、模型和飞书连接，不再提供执行引擎切换或外部工作流配置。客户读取使用 SQLite 主档案，飞书通过官方 API 导入历史记录和同步协作镜像。

HTTP 200 或 completed 只表示操作已返回，实际收录仍需本地保存与读回；飞书镜像需独立核对同步状态。不确定操作按原持久编号查询，不自动重复研究或新建记录。已退役引擎的历史任务保留查询，但不能交给直连引擎继续执行。

## 检查范围

代码修改按涉及模块运行现有测试，前端变更再构建。提示词文案修改运行生成命令、--check 及 agent-policy 测试。真实搜索、模型、飞书写入或发信验收与离线测试分别记录；归档的通过次数、客户数量和费用只表示当时情况。

文档整理只检查结构、链接、生成一致性及相关现有规则测试，不因整理文档触发真实业务任务。历史方案保留在 [归档目录](archive/README.md)。
