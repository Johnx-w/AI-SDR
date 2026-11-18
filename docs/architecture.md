# 架构与运行

当前口径：2026-11-11。React／TypeScript 网页通过同源 Node.js HTTP 接口操作后端，业务执行不依赖开发用 MCP 或 Codex OAuth。阿里云服务器持久库采用 Node.js 内置 SQLite，修改先写数据库，再由后台每分钟同步飞书，包含 T2 当前评级和 T12 当前评估；当前为单用户、单进程版本。

业务行为分别见 [获客](acquisition.md)、[客户与产品数据](customer-data.md)、[评分](assessment.md)、[邮件沟通](outreach-first-touch.md)。[AI 业务员设计](ai-sales-agent-design.md) 区分已实现的首封追信与待实现的来信自动接待。

2026-11-10 已完成本地实现：删除采购需求及重复沟通记录的手工界面，任务页只读；后台复用邮件证据和关联，接通 T1 自动整理与首封未回复追信。云端以实际部署为准。详见 [ADR-0025](adr/0025-automatic-business-records-with-read-only-followups.md)。

## 模块职责

| 范围            | 现有模块与职责                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 与获客入口 | server/app.mjs 校验参数、来源和请求幂等；createAcquisitionProvider 封装直连获客服务                                                      |
| 获客调度        | batch-jobs 负责预算、进度、暂停与恢复；search-plan 负责查询；引擎负责单企业处理                                                          |
| 检索与研究      | 检索、官网采集、结构化研究、身份／引文核验和程序评分分工，沿用共享业务函数                                                               |
| 客户档案及评估  | lead-library 保存 SQLite 客户主档案；customer-archive 管理后台飞书同步与编号关联；AssessmentStore 保留最新快照                           |
| 客户业务与产品  | CustomerBusiness 维护会话、需求、消息、任务和人工归属；产品资料管理审核版本                                                              |
| 首封开发        | outreach-service 管理计划、邮箱匹配、企业占用和发送队列；outreach-content 生成与检查                                                     |
| 自动需求与追信  | automatic-demands 从已匹配来信提取 T1；outreach-follow-ups 持久化两次追信、核验发送条件并投影只读任务                                    |
| 邮件收发        | mail-conversations 保存原文和同步游标；mailbox-reader 只读 IMAP；mail-replies 管理草稿与幂等回信；outreach-mailboxes 管理加密账号和 SMTP |
| 邮件业务桥接    | outreach-business、mail-conversation-business 只登记实际往来，不以记录失败触发再次发送                                                   |
| 网页状态        | WorkspaceProvider 只负责界面通知，真实业务读取后端；已退役演示仓储不再加载                                                               |

四品类提示词由共享 Markdown 与品类配置生成。将来自动接待在现有模块之上增加接待配置、来信触发、授权核验和处理台账；复用客户历史及发送能力，不另外维护一套客户数据库。

## 现有接口

网页 HTML、JavaScript、CSS 和 SVG 在浏览器接受 gzip 时压缩传输，减少完整刷新时的静态资源下载量；保留原内容类型、HEAD 读取及未接受压缩的兼容响应。业务 API 和二进制文件保持原有传输方式。

获客列表 `GET /api/v1/acquisition/jobs?summary=1` 与 `GET /api/v1/acquisition/schedules?summary=1` 返回首屏摘要；任务带 `summary: true`、空 `rows`，不含搜索明细和研究队列。网页仅在展开任务时通过 `GET /api/v1/acquisition/jobs/:id` 读取完整详情，并按 `updatedAt` 刷新；不带摘要参数的原接口保持兼容。响应 JSON 或列表结构无效时显示读取错误，不将其当作空列表或传给页面渲染。

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
| 客户业务   | GET /api/v1/business 及 schema、conversations、messages、demands、tasks；POST /sync；旧手工写入、任务 preflight/action 返回 405     |
| 邮件       | /api/v1/outreach 下的邮箱、计划、会话和发送记录；会话提供 sync、read、draft 和 reply                                                |

新增业务操作使用持久幂等编号；编辑核对当前版本。旧评估历史重试返回 410；旧固定邮箱试点 /api/v1/mail/\*、已移除搜索词生成接口返回 404。邮件读取／同步不自动回复，也不修改原邮箱已读；人工回信由 reply 入口单独发送。

`POST /api/v1/outreach/campaigns/:id/follow-ups` 接受 enable、disable、pause、resume，在所属计划控制追信。独立 `outreach_followups` 表与首封共用 SQLite 和邮箱限额；首封成功入账与创建两次安排在同一事务完成，已完成首封计划仍可继续追信。每分钟后台收信，发送前再次完整核对，记录失败只补记录；旧人工任务不进入执行器。

T1/T3 与独立 T4 目标分别同步，共享同一份去重日志，避免多个实例覆盖映射；单独配置或同步 T4 失败不跳过 T1/T3。自动需求提取先本地保存，不以飞书可用为前提。

配置状态只说明所需配置是否齐备，不能当作远端健康或业务成功。常见状态为 400 参数错误、403 来源拒绝、409 冲突／待核对、413 过大、415 格式不支持、429 并发限制、502 上游失败、503 未配置、504 远端结果不明。不会降级为虚构成功。

### 查询性能与验收

发送记录、邮件会话和客户业务概览直接读取运行服务器的 SQLite，客户业务概览同时读取本地保存的镜像状态。后台以 SQLite 中的业务记录、获客任务、发送记录和当前评估为源同步飞书。查询飞书目标表用于核对结构、定位关联、去重和验证写入。历史客户导入及飞书结构检查走独立流程。

新增或修改读取路径时，按以下规则验收。

1. **读取路径。** 新增或修改网页读取接口时，首屏、筛选、分页和日常刷新从运行服务器的 SQLite 返回。飞书、IMAP 等外部同步在后台或显式触发的独立流程中运行。用外部连接不可用的测试验证已有 SQLite 数据仍可读取，并断言网页读取接口未调用外部服务。
2. **查询范围。** 随业务增长的列表在数据库侧先筛选和排序，再分页，结果和总数使用同一筛选条件。列表只取显示所需字段，正文、附件及完整证据走详情。关联查询先缩小范围或一次提取匹配字段，避免逐条反复扫描或解析整表 JSON。用跨页测试核对结果和总数，数据量大的关联查询额外核对 `EXPLAIN QUERY PLAN`，确认大表访问方式符合预期。
3. **请求轮询。** 同一筛选条件的后台刷新复用在途请求或等请求结束后再发，不让通用状态刷新中止列表请求。用超过一个刷新周期的响应复测加载、筛选切换和迟到结果，确认旧请求不会覆盖当前页面。
4. **耗时验收。** 使用与线上体量和大字段分布相近的脱敏数据，用实际页面入口或 API 重复测量首屏、最慢筛选和后续页。记录数据规模、耗时中位数、最慢一次及响应大小，分别观察冷启动和正常运行。改动前后使用同一数据及条件，确认结果正确且查询没有可复现的耗时退化。发布后再用同一提交抽查线上只读接口，同时核对返回结果、状态码和耗时。

四个常用页面可用 `npm run build`、`node scripts/benchmark-page-opens.mjs` 复测。脚本在独立临时库生成 1,111 家客户、1,203 条业务消息、41 个计划及 1,203 条含大字段的发送记录，不使用真实账号。设置 `PLAYWRIGHT_MODULE` 为已安装 Playwright（或 playwright-core）的入口文件并备有 Chromium 时，同一脚本还会以 40 ms 网络延迟、10 Mbps 下行测硬加载和站内点击，到真实数据行／指定档案绘制为止，超出 700 ms 即失败。接口计时不等于浏览器耗时；云端达标需在部署后独立验证。

客户库、客户档案、当前触达计划与发送记录的同源直接导航，使用同一套页面组件和本地 SQLite 数据生成首屏 HTML，再由浏览器接管交互。首屏含客户数据，不允许缓存；跨站、嵌入和维护期间只提供静态外壳。浏览器端继续按原接口更新。后台计划准备按客户查历史发送；额度和镜像统计只读发送状态、账号及时间，不反复载入历史邮件正文。

后台收信每轮按邮箱构建客户邮件地址映射，不逐会话重读客户档案或导入历史发送；重复消息通过账号与原始邮件编号核对，仍拒绝冲突归属。逐会话处理之间让出事件循环，使前台读取不必等待整批同步结束。

首次打开内嵌样式；浏览器实际载入带指纹的样式文件后，后续首屏复用静态缓存，不重复传输整份样式。标记只含公开的样式文件名，客户数据仍不落浏览器磁盘缓存。接管交互时复用同一次首屏查询结果，筛选、手动刷新、恢复可见及定时读取继续按原接口运行。历史导入只为新增编号匹配研究证据；已有客户继续核对顺序、修复旧摘要，保留本地档案修改。

在同一标签页内返回触达计划或发送记录时，先显示内存中最近读取且与当前筛选、页码一致的一页，同时向服务器核对更新。进入 API 连接设置后清除这两页，重新打开标签页也会重新读取。总览、客户库或沟通中心首次可见后，后台预读尚未打开的默认第一页，范围限于 8 个客户摘要、20 个计划和 20 条发送记录。鼠标移入或键盘聚焦客户行时按编号预读该客户本地档案，点击沿用同一请求。浏览器支持 Brotli 时，较大的列表与档案 JSON 压缩传输。

客户列表后台预读可在分页查询中指定 `include=dossiers`。SQLite 用相同筛选、排序和分页读取当前最多 8 份完整档案。页面只保留当前页匹配编号和版本的预读结果，普通列表、轮询和首屏 HTML 仍只带摘要；单条读取与后台预读采用相同的资料修正及开发状态。四个页面的公网打开目标为 1.5 秒，同时记录首次打开和已读后的返回耗时。

前端静态 JS 和 CSS 在 Vite 写出最终文件后生成 Brotli 副本。构建回归测试覆盖首页懒加载及其样式，并逐字节比对解压内容。修复前的入口曾使用长期缓存，修复版使用新的带指纹入口地址，用户正常打开首页即可获取。

### 上传图纸与产品规格

先在产品资料库保存产品草稿，再在「查看 / 编辑」上传 PDF、PNG/JPG，单文件最多 10 MB，每个产品最多保留 20 份原文件。同一产品上传相同内容会返回已有文件；不同内容作为独立文件保留，SHA-256、文件名和上传时间可供核对，不覆盖旧原文件。

在 API 连接的「产品资料 · 图纸与规格识别」填写 `DOCUMENT_MODEL_BASE_URL`、`DOCUMENT_MODEL_API_KEY`、`DOCUMENT_MODEL_MODEL`。服务须支持 Responses API、图片/PDF 输入及 JSON Schema 输出；基础地址包括服务商所需的 `/v1`（例如 `https://api.openai.com/v1`）。本功能不自动借用企业研究模型。文件输入协议参见 [OpenAI File inputs](https://developers.openai.com/api/docs/guides/file-inputs) 和 [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)。

上传只写入本地库；用户点击 AI 提取才将原文件发送到已配置的模型服务。AI 结果单独保存为候选，保留页序号、位置、模型和提取时间。模糊标注及不确定归属列为提示；价格、MOQ、交期等需人工另行填写并沿用其适用条件和有效期规则。超过 60 条参数的文件应拆分，不能视为完整提取。网络失败、截断或无效输出不改动产品资料，原文件保留，可重试；成功结果重试直接复用。

用户下载原文件核对，编辑候选后点「加入待审核参数」，再保存草稿或审核。仅纳入产品记录的参数参与原有审核与版本流程；上传及提取本身不产生产品事实或发送权限。已审核内容或所关联原文件改变后退回待审核，需再次审核。产品的 `documentIds` 只能引用本产品的文件；原文件不会自动成为邮件附件。此功能只打通资料准备，自动回信运行链路仍按 ADR-0019 待实现。后续接待只能读取已审核、生效的产品资料，不能读取候选结果作为供货事实。

原文件二进制和候选结果存放在产品资料 SQLite 的 `product_documents` 表，与产品资料一起备份；适用的通用飞书镜像仅保存原文件编号，不上传私有图纸。领导原 T5 已停止接收网页产品资料镜像，见 [产品数据边界](customer-data.md#业务表和数据归属)。首版不解析 CAD，也不建立向量库。

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

Node.js 后端仅监听 127.0.0.1，API 保留本机来源及跨站请求限制；云端发布由 `shadeflow.service` 管理，内部端口 14311。应用尚无团队登录与角色权限，公网入口的鉴权及 HTTPS 由下述网关提供，不能仅改监听地址。服务端凭证不返回浏览器，连接配置与进程环境的优先级见获客说明。仓库实现说明不代替对云端实际版本及入口配置的核验。

### 公网受控入口

公网入口使用 `https://47.76.84.114:8443/`。Nginx 配置源为 `scripts/shadeflow-public.nginx.conf`，在 8443 为**所有路径**（包括 `/api/`、首页和静态资源）验证浏览器原生用户名／密码，再代理到回环地址 14311；转发时清除 Basic `Authorization`，不把入口密码交给应用，失败认证响应延迟一秒。密码文件 `/etc/nginx/shadeflow.htpasswd` 只存哈希，不入仓库；入口用户名 `root` 仅是网页认证账号，与系统 root 无关。在已配置 `ai-sdr` SSH 别名的 Windows 本机运行 `scripts/set-public-password.ps1`，交互输入两次 6–72 位密码即可创建或更换哈希，不在命令行或仓库传递明文。单一共享账号不提供逐人权限或审计。

80 端口只提供 `/.well-known/acme-challenge/` 的证书验证文件，其余请求返回 404；443 保留给自动 CD 的专用 SSH，22 仍只允许管理 IP，14311 不对公网开放。应用环境文件配置精确的 `PUBLIC_ORIGIN=https://47.76.84.114:8443`，只允许这个 HTTPS 来源调用 API，原有跨站阻断仍生效。此入口与本机 SSH 隧道互不依赖，启用状态以服务器实际监听和安全组为准。

公网 IP 证书由 Certbot 5.4+ 通过 HTTP-01 申请，使用约六天有效的 shortlived 证书；自动续期成功后必须重载 Nginx。核对 `certbot renew --dry-run`、证书到期时间、续期定时器及站点证书链。验收时从公网确认未认证的首页和 API 均为 401，正确密码可读取页面与 API，浏览器同源写请求不因 Origin 被拒绝，且公网无法直连 14311。依据：[Let's Encrypt IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)、[HTTP-01 验证端口](https://letsencrypt.org/docs/challenge-types/)、[Nginx HTTP Basic Auth](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html)。

## 标准交付流程（Codex执行入口）

用户可直接说“按标准流程发布这个功能”；指定分支或工作树时，以该范围为准。普通功能开发只完成本地修改和验证，本地回退提交遵循根目录 AGENTS.md。“提交并上传 GitHub”使用功能分支，止于推送与 CI；“合并到本地 main”止于本地合并与验证。自动 CD 启用后，推送远端 main 表示正式上线决定；“按标准流程发布”执行以下全流程，包含必要的受控业务服务重启。明确的范围限制优先。

功能及其文档按 [AGENTS：文档维护流程](../AGENTS.md#文档维护流程) 一起交付：确定范围时列出相关主题说明，提交前完成状态、撤销归档、导航和引用核对；验证最终提交时一并检查文档准确性及发布包归档排除。缺少必要文档更新时，功能交付尚未完成。

### 从功能改动到云端版本

1. **确定本次改动。** 查看 `git status`、`git diff`、当前分支、`git worktree list` 和提交记录，锁定功能所在工作树及目标提交。只暂存本次文件或代码块，保留其他任务的修改；数据库、密钥和环境配置不入库。已有对应提交则复用。完成条件：提交范围可说明，未混入其他工作。
2. **同步并合并 main。** `git fetch origin` 后比较功能分支、本地 main 与 `origin/main`。先保留本地已有提交，再合并本次功能；可快进时快进，有分叉时普通合并，提交说明采用英文类型前缀加中文说明。处理冲突时核对两侧业务行为，不能整批选择一侧覆盖；业务取舍不明确才询问用户。main 所在工作树有其他未提交改动时，在独立干净工作树准备集成结果，保留原工作树；需要更新被占用的 main 时先协调，不能强改引用、强制检出或清理他人改动。完成条件：目标 main 包含最新远端 main 及本次功能，冲突消除。
3. **验证最终合并结果。** 在干净的集成版本运行项目要求的格式、测试和构建；按改动补充必要验证。文档变更只核对格式、链接与指令准确性，不执行生产操作。全流程发布可复用下文 `npm run release` 的隔离安装、格式、完整测试与构建，避免对同一提交无意义重复。完成条件：验证对应最终合并提交，而非合并前的功能分支。
4. **推送并跟进 CI。** 发布任务普通推送更新 `origin/main`，仅上传任务普通推送功能分支。远端前进导致拒绝时，重新 fetch、集成及验证，不强推。通过 `gh run list --commit <完整SHA> --event push` 找到运行并跟进到结束。CI 失败先查日志，修复后用新提交重新验证；只有确认是偶发环境故障才重跑原提交。完成条件：同一 SHA 的必需作业全部成功，具体规则见下文。
5. **检查云端并部署。** main 的同一提交通过 CI 后，由下文自动 CD 执行维护、等待在途任务、备份、部署及健康验收。通过 `gh run list --workflow cd.yml` 找到本次 CI 触发的 CD 并跟进；CD 跳过或失败不算已发布。手工 `npm run release` 是停用自动 CD 后的备用入口，避免两条流程竞争。保留原数据及配置，不执行不兼容迁移；这类变更先单独确定迁移与恢复方案，再合并 main。完成条件：目标提交部署成功，维护已解除。
6. **验收并报告。** 核对本地 main、远端 main、云端 current 及实际进程目录对应同一目标 SHA；读取健康接口、网页、相关只读业务接口和本次启动日志。核对原数据目录、配置及备份路径，变化应能解释；不通过试发客户邮件或写入业务记录来验收。失败按下文回退流程处理，不能用数据回滚掩盖发布问题。报告提交短哈希、CI 链接、云端版本、备份位置、验收结果及未完成项。仅上传任务报告 Git／CI 状态即可，不宣称云端已更新。

自动 CD 不负责合并 main。备用的 `npm run release` 包含检查、推送、CI 等待和部署；使用前停用自动 CD，避免重复发布。发布期间发现目标分支或云端版本被其他任务更新，重新核对目标后再继续。

### 运维分支

- **仅同步文档：** 仅在用户要求时，按 [文档维护流程](../AGENTS.md#文档维护流程) 从已提交的兼容版本更新当前运行目录中的非归档文档，并逐文件核对；不执行应用发布、不切换版本、不重启，业务代码、数据、备份及历史版本目录保持不变。清理云端旧归档是独立操作，须有明确要求。
- **代码回退：** 用户要求回退时，核对上一版本与当前数据兼容性及任务空闲状态，使用下文 `release:rollback`。备份恢复是另一项操作，不能把旧数据库直接覆盖生产库。
- **备份或告警检查：** 按下文“在线备份与运维邮件”读取定时器、最新备份、监控状态和日志。云端恢复只在隔离目录进行；完成标准是从云端取回的归档通过校验，不能用本机归档冒充。
- **运维脚本更新：** `/srv/shadeflow/ops/` 的脚本与 systemd 定时任务独立安装，普通应用发布不更新它们。仅在本次包含运维安装要求时，核对源文件与服务器文件哈希、更新对应脚本或 unit，并验证相应任务；不因此重启业务服务。

## 一键发布与回退

### 自动 CD

入口为 `.github/workflows/cd.yml`、`scripts/release-cd.mjs` 和服务器固定安装的 `scripts/cd-gateway.mjs`／`scripts/release-server.mjs`。实际启用状态须核对 GitHub 仓库变量 `CD_ENABLED=true`、三个 Actions secrets、服务器固定入口及运行版本，不能从文件存在推断已上线。

main push 的 CI 完成后触发 CD：要求同一完整 SHA 最新一次 push CI 整体成功，当前 attempt 的 Windows `checks` 和 Linux `release` 都成功。CD 按该 SHA 检出并构建，使用 `git archive` 打包，排除历史归档、数据和环境配置。PR、功能分支、失败或缺失作业均不能部署。工作流串行执行，不取消进行中的发布；客户端打包前、服务器进入维护前及实际切换前核对最新 main，过时提交跳过，已经开始切换的发布继续完成。

服务器先准备独立版本，再创建共享的 `.data/release-maintenance.json`。维护期间业务 API 返回带 `Retry-After` 的 503，健康及维护状态可读，静态网页继续提供。暂缓调度、业务镜像、客户刷新和新邮件提交，原计划状态保持。`GET /api/v1/ops/maintenance` 汇总已接收请求、获客、草稿准备、发送、人工回复、收信、文档和后台写入，在途工作完成前不停止服务；新进程在标记解除前也不启动调度。

最多等 10 分钟；超时保留旧代码、解除维护，本次 CD 失败，之后手动重跑或由下一次提交触发，不周期重试。长批次可能导致超时。维护期间错过的定时获客沿用“不补跑”规则，邮件和追信的原队列、时点与额度保持。成功验收或成功回退后解除维护；新旧版本均无法恢复时保留维护并报错。业务数据不自动回滚；不兼容迁移另行安排。

GitHub 使用 `production` environment，全天发布不配置人工审批。仓库 secrets：`CD_SSH_KEY` 为独立 Ed25519 私钥，`CD_SSH_HOST` 为服务器，`CD_KNOWN_HOSTS` 从已核对主机记录配置。root 的 `authorized_keys` 对该公钥设置 `restrict,command="/srv/shadeflow/ops/node /srv/shadeflow/ops/cd-gateway.mjs"`，只允许 `deploy <40位SHA> <64位SHA256>` 与标准输入发布包，不开放 shell、转发或 SCP。固定入口和发布脚本由 root 安装到 `/srv/shadeflow/ops/`，不从上传包执行 root 脚本，依赖安装与应用使用 `shadeflow` 用户。固定入口变更按运维安装流程单独核对哈希。

现有 22 端口只允许家庭／办公白名单，GitHub 托管 runner 无法直连。CD 使用独立的 `shadeflow-cd-ssh.service` 监听 IPv4 443，原 22 监听及云安全组规则保持。独立配置为 `/etc/ssh/shadeflow-cd-ssh.conf`，仅从 `/etc/ssh/shadeflow_cd_authorized_keys` 读取 CD 公钥，关闭密码、交互终端及全部转发，并强制固定部署命令。沿用服务器已有 Ed25519 主机密钥；`CD_KNOWN_HOSTS` 按 `[服务器]:443` 保存已核对记录。源配置和 unit 位于 `scripts/systemd/`，与固定入口一并独立安装及核对哈希。443 当前用于该专用 SSH 入口，将来在本机提供公网 HTTPS 前须先迁移此入口。

首次启用：保持 `CD_ENABLED` 未启用，验证并推送 main，等待同 SHA CI 成功；按旧流程完成一次受控首发安装维护能力；安装固定入口、独立公钥、443 专用 SSH 服务及 GitHub secrets，核验有效 SSH 配置、密码及交互命令拒绝、22 入口保留和业务恢复后，设置 `CD_ENABLED=true`。随后重跑该 main CI，跟进 CD 和云端验收；同 SHA 已运行时只验收，不重复重启。旧版尚不识别维护标记，首发须协调停止新操作、暂停计划并确认没有在途任务，完成后恢复原先启用的计划；不能暂停并中断正在跑的获客批次。

发布结果及回退日志在 GitHub Actions 查看，原云端运维告警继续。只上传不上线使用功能分支；暂停自动上线时将 `CD_ENABLED` 设为 `false`。在线备份及运维定时器保持现行配置。

### 手工备用入口

当前发布目标为 SSH 别名 `ai-sdr` 对应的 Linux 服务器，由 `shadeflow.service` 以 `shadeflow` 用户运行，内部端口为 14311。发布电脑需有 Node.js 24.5+、Git、OpenSSH、tar、已登录的 GitHub CLI（`gh auth login`），以及 GitHub 推送和 Actions 读取权限；SSH 别名需指定发布密钥和已核对的服务器主机密钥。

提交本次改动后，在项目目录运行：

```powershell
npm run release:check
npm run release
# 需要恢复上一代码版本时：
npm run release:rollback
```

发布只处理当前分支的已提交版本，工作区有未提交文件时会停止。检查、安装依赖和构建均在临时目录进行，本机正在运行的开发服务及其 `node_modules`、`.data` 不变。格式检查、测试、构建全部成功后，推送当前分支对应提交，不自动合并 main、不强推。

历史文档保留在 GitHub，不进入云端应用发布包。发布脚本使用 `git archive`，根 `.gitattributes` 通过 `export-ignore` 排除 `docs/archive/**`；现行文档和运行代码读取的模板继续保留。不删除服务器既有版本、归档或备份；仅推送功能分支时不会更改云端文件。

所有分支的推送都会触发 `.github/workflows/ci.yml`。发布脚本只认可 `Johnx-w/AI-SDR` 中同一完整提交号最新一次 `push` 运行：整体成功，且该次运行当前尝试的 `checks`（Windows 格式、测试、构建）和 `release`（Linux 发布测试）两个作业都完成并成功后，才上传和部署该提交。PR 检查、其他提交或更早的成功运行不能代替；缺少或跳过必需作业、失败、取消、查询错误都停止发布。CI 尚未创建或未完成时每 10 秒查询一次，最多等待 20 分钟；等待期间本地 HEAD 变化也会停止。CI 或服务器发布失败时，已经推送的提交仍保留在 GitHub，命令以失败退出，可排除问题后重试。

门禁覆盖 `npm run release` 的新版本部署；`release:check` 保持只读，`release:rollback` 保留恢复上一代码版本的行为，不重新等待 CI。

服务器在 `/srv/shadeflow/releases/<完整提交号>` 安装 Linux 生产依赖，准备完成后进入维护并等待在途任务结束，再停止旧服务。启用中的计划保持原状态，人工回复和后台写入一并等待。不要同时启动两个服务操作同一数据库。无维护能力的旧版只按上述首次受控安装流程发布。

每次切换先停止服务，备份 `.data`、存在的 `.env`／`.env.local` 以及 systemd 配置到 `/srv/shadeflow/backups/`。原 `/srv/shadeflow/app` 保留作为首次部署前的代码版本及数据存储位置；各新版本的 `.data` 和环境文件链接到这里。首次发布仅新增 systemd 的 `release.conf`，将工作目录指向 `/srv/shadeflow/current`，保留原启动命令、运行用户、端口等设置。

启动后检查实际进程目录、健康接口和网页。失败时切回原代码并重新启动；成功版本与上一版本记录在 `/srv/shadeflow/release-state.json`。`release:rollback` 也先备份并检查启动结果，始终保留当前业务数据。代码回退不能撤销已发出的邮件、飞书写入或数据库迁移；涉及不兼容数据库结构变更时，必须另行制定迁移与恢复步骤，不能依赖代码回退。数据备份不自动覆盖运行库，以免丢失发布后新增记录。

备份和旧版本不自动删除，按磁盘使用情况人工保留或清理。若断电或进程被强制结束导致 `.release-lock` 遗留，先核对其中 PID 已不再运行，再移除锁并检查服务／版本状态，不能在另一次发布仍运行时解锁。依赖安装失败会清理临时版本，可重新执行发布；已准备完成的同一提交可复用，正在运行的同一提交通过健康检查后直接完成，不重复重启服务。

## 在线备份与运维邮件

云端使用 `scripts/ops-backup.mjs` 和 `scripts/ops-monitor.mjs`，独立安装到 `/srv/shadeflow/ops/`，不随应用发布自动更新。对应 systemd service/timer 源文件在 `scripts/systemd/`。运维脚本更新后重新复制；更改 unit 才执行 `systemctl daemon-reload`，无需重启 `shadeflow.service`。`/srv/shadeflow/ops/node` 链接到服务器实际 Node.js 可执行文件，Node 升级时核对该链接。

每日北京时间 04:30 运行在线备份，先于现有云备份的 05:15。逐个使用 SQLite 在线备份 API 获取包含已提交 WAL 数据的副本，通过完整性和外键检查后，与 `.data` 中的其他文件、存在的 `.env`／`.env.local`、systemd 配置和发布状态一起打包。清单记录 `.data` 文件及存在的环境配置、systemd 配置和发布状态的 SHA-256。数据包括邮箱加密文件及 `.credential-key`；备份目录仅 root 可访问。源数据库只读，临时副本校验后才发布到 `/var/backups/shadeflow/backup-*.tar.gz`，`latest.json` 只指向已完成的副本。失败不覆盖上次成功结果。

每个数据库各自一致，多个数据库不是同一时刻的全局事务快照。恢复后须核对跨库业务关系与发送结果，不能直接重跑结果不明的邮件。所有本机副本仍在同一块云盘；只有云备份成功收录并通过隔离恢复后，才算已验证的离机备份。副本暂不自动删除，磁盘到阈值会告警，清理前先确认云端已有可恢复版本。

阿里云文件备份基础版默认排除 `/srv/`，因此原 `/srv/shadeflow/backups` 中的发布备份不在当前云备份覆盖范围。新副本放在未被排除的 `/var/backups/shadeflow`。查看“全部目录备份成功”不能代替浏览实际备份文件；每次更换计划或排除规则，应再次核实目录并隔离恢复。依据：[云备份默认排除规则](https://help.aliyun.com/zh/cloud-backup/user-guide/back-up-files-from-an-ecs-instance)。

监控每 5 分钟检查应用 systemd 状态及健康接口、磁盘可用空间与 inode、在线备份任务结果与 30 小时新鲜度、HBR 客户端及最近成功备份日志、云端隔离恢复验收记录。服务探测首次失败时立即重试一次；连续两轮检查均失败才发送服务告警，恢复立即通知。新归档完成时间不早于成功云备份任务的首条 lock 日志时，视为尚未确认入云；当天正常等待窗口宽限至北京时间 08:00，之后人工生成的新归档立即提示。任务起始日志缺失、目录覆盖未知或超过 30 小时无成功记录仍立即告警。空间不足 15% 或 inode 不足 10% 报警。相同异常每天提醒一次，其他异常集合变化立即通知；SMTP 失败不记为已通知，下次重试。告警不包含业务记录、配置值或密钥。

配置存放在 `/srv/shadeflow/ops/monitor.json`，权限 0600，格式为：

```json
{
  "recipient": "alerts@example.com",
  "mailboxId": "已配置邮箱的ID",
  "mailboxEmail": "对应发件邮箱地址",
  "backupLog": "/opt/alibabacloud/hbrclient/logs/backup_实际计划ID.log"
}
```

发件复用现有已验证邮箱，不更改业务邮箱配置或调用获客／客户发信任务；使用 `expectedAccount` 检查邮箱身份。共享凭证读取器会设置密钥文件权限，因此监控在 systemd 私有临时目录使用配置副本，发信后删除。监控 service 对生产目录只读；备份 service 对整个 `.data` 目录开放写权限，以供 SQLite 建立 WAL 旁文件，数据库连接仍为只读。监控状态放在 `/var/lib/shadeflow-monitor`，与业务库分开。更改发件邮箱、停用账号或撤销 SMTP 凭证后，必须重新发送测试邮件；邮件服务器接受不等于收件箱已投递。

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
