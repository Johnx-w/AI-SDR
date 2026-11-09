# 架构与运行

当前口径：2026-11-05。React／TypeScript 网页通过同源 Node.js HTTP 接口操作后端，业务执行不依赖开发用 MCP 或 Codex OAuth。阿里云服务器持久库采用 Node.js 内置 SQLite，修改先写数据库，再由后台每分钟同步飞书；当前为单用户、单进程版本。

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
| 获客       | /api/v1/acquisition 下的 status、locations、products、search-preview、jobs、schedules                                               |
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

## 标准交付流程（Codex执行入口）

用户可直接说“按标准流程发布这个功能”；指定分支或工作树时，以该范围为准。普通功能开发只完成本地修改和验证，本地回退提交遵循根目录 AGENTS.md。“提交并上传 GitHub”止于推送与 CI；“合并到本地 main”止于本地合并与验证；“按标准流程发布”执行以下全流程，包含必要的受控业务服务重启。明确的范围限制优先，不因有发布脚本而扩大操作范围。

### 从功能改动到云端版本

1. **确定本次改动。** 查看 `git status`、`git diff`、当前分支、`git worktree list` 和提交记录，锁定功能所在工作树及目标提交。只暂存本次文件或代码块，保留其他任务的修改；数据库、密钥和环境配置不入库。已有对应提交则复用。完成条件：提交范围可说明，未混入其他工作。
2. **同步并合并 main。** `git fetch origin` 后比较功能分支、本地 main 与 `origin/main`。先保留本地已有提交，再合并本次功能；可快进时快进，有分叉时普通合并，提交说明采用英文类型前缀加中文说明。处理冲突时核对两侧业务行为，不能整批选择一侧覆盖；业务取舍不明确才询问用户。main 所在工作树有其他未提交改动时，在独立干净工作树准备集成结果，保留原工作树；需要更新被占用的 main 时先协调，不能强改引用、强制检出或清理他人改动。完成条件：目标 main 包含最新远端 main 及本次功能，冲突消除。
3. **验证最终合并结果。** 在干净的集成版本运行项目要求的格式、测试和构建；按改动补充必要验证。文档变更只核对格式、链接与指令准确性，不执行生产操作。全流程发布可复用下文 `npm run release` 的隔离安装、格式、完整测试与构建，避免对同一提交无意义重复。完成条件：验证对应最终合并提交，而非合并前的功能分支。
4. **推送并跟进 CI。** 只用普通推送更新 `origin/main`；远端前进导致拒绝时，重新 fetch、集成及验证，不强推。仅上传任务用 `git push origin main` 后，通过 `gh run list --commit <完整SHA> --event push` 找到运行并跟进到结束；发布任务交由下文 `npm run release` 执行推送与 CI 门禁。CI 失败先查日志，修复代码后用新提交重新验证；只有确认是偶发环境故障才重跑原提交。完成条件：同一 SHA 的必需作业全部成功，具体规则见下文。
5. **检查云端并部署。** 全流程发布从干净的 main 执行 `npm run release:check` 与 `npm run release`；发布脚本支持任意分支，操作者必须额外确认本次来自 main。部署前及实际切换前检查获客任务、启用的定时计划、发信计划和正在发送的邮件；另行只读核对人工回复台账，脚本的任务检查未覆盖人工回复，也不锁住新的网页请求。任务未结束或计划仍启用时报告具体阻塞，等待结束或由用户安排暂停，不取消任务、不把状态改成完成。维护期间协调停止新的手动操作。保留云端原数据及配置，不执行迁移；需要不兼容迁移的功能应停在已验证提交，另定方案。完成条件：发布脚本完成备份、版本切换和健康验收。
6. **验收并报告。** 核对本地 main、远端 main、云端 current 及实际进程目录对应同一目标 SHA；读取健康接口、网页、相关只读业务接口和本次启动日志。核对原数据目录、配置及备份路径，变化应能解释；不通过试发客户邮件或写入业务记录来验收。失败按下文回退流程处理，不能用数据回滚掩盖发布问题。报告提交短哈希、CI 链接、云端版本、备份位置、验收结果及未完成项。仅上传任务报告 Git／CI 状态即可，不宣称云端已更新。

`npm run release` 已包含检查、推送、CI 等待和部署；它不会自动合并 main。以上步骤是执行顺序和完成标准，不要求把脚本内部流程手工再做一遍。发布期间发现目标分支或云端版本被其他任务更新，重新核对目标后再继续，避免覆盖另一份发布。

### 运维分支

- **代码回退：** 用户要求回退时，核对上一版本与当前数据兼容性及任务空闲状态，使用下文 `release:rollback`。备份恢复是另一项操作，不能把旧数据库直接覆盖生产库。
- **备份或告警检查：** 按下文“在线备份与运维邮件”读取定时器、最新备份、监控状态和日志。云端恢复只在隔离目录进行；完成标准是从云端取回的归档通过校验，不能用本机归档冒充。
- **运维脚本更新：** `/srv/shadeflow/ops/` 的脚本与 systemd 定时任务独立安装，普通应用发布不更新它们。仅在本次包含运维安装要求时，核对源文件与服务器文件哈希、更新对应脚本或 unit，并验证相应任务；不因此重启业务服务。

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

## 在线备份与运维邮件

云端使用 `scripts/ops-backup.mjs` 和 `scripts/ops-monitor.mjs`，独立安装到 `/srv/shadeflow/ops/`，不随应用发布自动更新。对应 systemd service/timer 源文件在 `scripts/systemd/`。运维脚本更新后重新复制；更改 unit 才执行 `systemctl daemon-reload`，无需重启 `shadeflow.service`。`/srv/shadeflow/ops/node` 链接到服务器实际 Node.js 可执行文件，Node 升级时核对该链接。

每日北京时间 04:30 运行在线备份，先于现有云备份的 05:15。逐个使用 SQLite 在线备份 API 获取包含已提交 WAL 数据的副本，通过完整性和外键检查后，与 `.data` 中的其他文件、存在的 `.env`／`.env.local`、systemd 配置和发布状态一起打包。数据包括邮箱加密文件及 `.credential-key`；备份目录仅 root 可访问。源数据库只读，临时副本校验后才发布到 `/var/backups/shadeflow/backup-*.tar.gz`，`latest.json` 只指向已完成的副本。失败不覆盖上次成功结果。

每个数据库各自一致，多个数据库不是同一时刻的全局事务快照。恢复后须核对跨库业务关系与发送结果，不能直接重跑结果不明的邮件。所有本机副本仍在同一块云盘；只有云备份成功收录并通过隔离恢复后，才算已验证的离机备份。副本暂不自动删除，磁盘到阈值会告警，清理前先确认云端已有可恢复版本。

阿里云文件备份基础版默认排除 `/srv/`，因此原 `/srv/shadeflow/backups` 中的发布备份不在当前云备份覆盖范围。新副本放在未被排除的 `/var/backups/shadeflow`。查看“全部目录备份成功”不能代替浏览实际备份文件；每次更换计划或排除规则，应再次核实目录并隔离恢复。依据：[云备份默认排除规则](https://help.aliyun.com/zh/cloud-backup/user-guide/back-up-files-from-an-ecs-instance)。

监控每 5 分钟检查应用 systemd 状态及健康接口、磁盘可用空间与 inode、在线备份任务结果与 30 小时新鲜度、HBR 客户端及最近成功备份日志、云端隔离恢复验收记录。空间不足 15% 或 inode 不足 10% 报警。相同异常每天提醒一次，异常集合变化及恢复立即通知；SMTP 失败不记为已通知，下次重试。告警不包含业务记录、配置值或密钥。

配置存放在 `/srv/shadeflow/ops/monitor.json`，权限 0600，格式为：

```json
{
  "recipient": "alerts@example.com",
  "mailboxId": "已配置邮箱的ID",
  "mailboxEmail": "对应发件邮箱地址",
  "backupLog": "/opt/alibabacloud/hbrclient/logs/backup_实际计划ID.log"
}
```

发件复用现有已验证邮箱，不更改业务邮箱配置或调用获客／客户发信任务；使用 `expectedAccount` 检查邮箱身份。共享凭证读取器会设置密钥文件权限，因此监控在 systemd 私有临时目录使用配置副本，发信后删除。生产目录在两个运维 service 中都为只读。监控状态放在 `/var/lib/shadeflow-monitor`，与业务库分开。更改发件邮箱、停用账号或撤销 SMTP 凭证后，必须重新发送测试邮件；邮件服务器接受不等于收件箱已投递。

```sh
systemctl list-timers shadeflow-backup.timer shadeflow-monitor.timer
systemctl start shadeflow-backup.service
/srv/shadeflow/ops/node /srv/shadeflow/ops/ops-monitor.mjs --check
# 只向 monitor.json 中的运维收件人发送一封明确标记的测试邮件
/srv/shadeflow/ops/node /srv/shadeflow/ops/ops-monitor.mjs --test-email
journalctl -u shadeflow-backup.service -u shadeflow-monitor.service
```

云端恢复验收应从最新云备份点仅选择 `/var/backups/shadeflow` 的已完成归档，恢复到提前创建的隔离目录，禁止选择原路径或覆盖同名文件。对恢复归档核对 SHA-256、解包清单、每个数据库的完整性和外键、配置哈希及凭证解密；不启动应用、不连接 SMTP 或执行迁移。成功后在 `/var/lib/shadeflow-monitor/cloud-restore-verified.json` 留下 `ok: true`、`sha256`、`verifiedAt` 与云端备份点记录，再观察恢复通知。仅本机副本恢复成功时不能创建这份云端验收记录。

基础版当天已有备份任务执行时，修改备份时间只能影响次日，不能靠调时间触发当日第二次备份。新增覆盖目录后应等下一轮完成再验收，见 [基础版配置限制](https://help.aliyun.com/zh/ecs/user-guide/configure-automatic-file-backup-and-restoration-for-ecs-instances)。

当前监控运行于同一台主机，不能在整机宕机、整机断网或发件通道失效时可靠发送邮件；这些情况仍需要云平台或外部探测。当前也不监测获客任务的业务质量、单封邮件状态及飞书逐条同步错误。HBR 检查基于已观察到的绝对路径日志格式，格式变化或缺少配对日志时按“覆盖未知”告警，不能替代定期云端恢复演练。

## 执行与核对

获客只使用后端直连引擎与 /api/v1/acquisition 接口。配置页只维护检索、模型和飞书连接，不再提供执行引擎切换或外部工作流配置。客户读取使用 SQLite 主档案，飞书通过官方 API 导入历史记录和同步协作镜像。

HTTP 200 或 completed 只表示操作已返回，实际收录仍需本地保存与读回；飞书镜像需独立核对同步状态。不确定操作按原持久编号查询，不自动重复研究或新建记录。已退役引擎的历史任务保留查询，但不能交给直连引擎继续执行。

## 检查范围

代码修改按涉及模块运行现有测试，前端变更再构建。提示词文案修改运行生成命令、--check 及 agent-policy 测试。真实搜索、模型、飞书写入或发信验收与离线测试分别记录；归档的通过次数、客户数量和费用只表示当时情况。

文档整理只检查结构、链接、生成一致性及相关现有规则测试，不因整理文档触发真实业务任务。历史方案保留在 [归档目录](archive/README.md)。
