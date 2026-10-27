# 架构与 API 契约

2026-10-21：获客链路新增 Node.js 直连引擎，原 n8n 接口保留兼容。最新配置、数据持久化、写入恢复与回退见 [迁移说明](native-migration.md)。下方 Webhook 契约描述 n8n 模式；统一业务入口为 /api/v1/acquisition。

## 业务数据

网页通过各自的真实服务端接口读写业务数据；`useWorkspace()` 仅负责界面通知，不再加载或保存浏览器演示工作区。客户库读取 `/api/v1/leads/real`，CSV 导出使用独立工具。旧演示收件箱、触达计划、报表及未启用的整库 HTTP 仓储已移除；`/campaigns` 跳转沟通中心计划，`/reports` 跳转真实总览。

沟通中心读取本机 `/api/v1/outreach/*` 与 SQLite 触达库。首封依据客户经营证据、具体产品及有效官网覆盖分配邮箱；邮件会话通过手动只读 IMAP 同步并按账号持久化。打开页面仅读缓存，人工回复由用户逐封发送并保存独立草稿及幂等台账；首封开发仍沿用独立批准和队列。旧固定双邮箱试点接口和后台轮询已退役，详见 [沟通中心](outreach-first-touch.md)。

## 已实现的 n8n 服务端接口

| 方法 | 路径                                  | 行为                                                       |
| ---- | ------------------------------------- | ---------------------------------------------------------- |
| GET  | `/api/health`                         | 本机服务健康检查                                           |
| GET  | `/api/v1/integrations/n8n/status`     | 只返回配置是否齐备，不调用远程、不返回密钥、不宣称真实健康 |
| POST | `/api/v1/integrations/n8n/runs`       | 校验业务参数，调用已认证的真实 Webhook，返回原始结果       |
| GET  | `/api/v1/integrations/n8n/executions` | 可选 Public API 历史，仅返回 ID、状态和时间字段            |

统一入口 `/api/v1/acquisition` 由当前执行引擎处理，并额外提供：

- `GET/POST /products`：读取常用产品目录或保存一个自定义产品。
- `POST /search-preview`：只生成自动搜索词预览，不调用付费搜索。
- `GET/POST /jobs` 与 `GET/POST /jobs/:id/:action`：创建、查询、停止或恢复持久化批量任务。
- `GET/POST /schedules` 与 `POST /schedules/:id/:action`：创建、查询、暂停、恢复或关闭定时计划。
- `GET /locations`：返回国家与地区联动选项。

旧版 `runs` body 为六个 WorkflowInput 字段。新版 `jobs` 和 `schedules` 还接收结构化产品快照、多选客户类型、优先条件与必需条件；请求体上限为32KB。浏览器传入 `Idempotency-Key`；服务端转发 `request_id` 和 `X-Request-ID`。旧版单次运行成功返回：

```json
{
  "requestId": "UUID",
  "status": "completed",
  "result": { "由真实n8n返回": "业务字段" },
  "completedAt": "ISO 8601"
}
```

`completed` 仅指成功收到 JSON，不能单凭此字段推断业务入库成功。错误状态：400 无效输入、403 不允许的来源、409 幂等冲突或结果不确定、413 请求体过大、415 内容类型错误、429 并发限制、502 上游错误、503 未配置、504 未确认远端结果。对错误不自动降级成 mock。

## 邮箱与邮件会话接口

沟通中心可直接访问，所有 `/api/v1/outreach/*` 请求保留本机来源校验。邮箱凭证加密保存于后端，不写入浏览器存储。

| 方法           | 路径                                       | 行为                                            |
| -------------- | ------------------------------------------ | ----------------------------------------------- |
| GET            | `/api/v1/outreach/conversations`           | 读取本地会话，支持 `mailboxId`、`q`、`unread=1` |
| GET            | `/api/v1/outreach/conversations/:id`       | 查看原始收发人、HTML/纯文本正文、草稿与实际状态 |
| POST           | `/api/v1/outreach/conversations/sync`      | 按 `mailboxId` 手动只读同步最近邮件及后续增量   |
| POST           | `/api/v1/outreach/conversations/:id/read`  | `unread:false` 仅修改本工作台已读标记           |
| GET/PUT/DELETE | `/api/v1/outreach/conversations/:id/draft` | 读取、按版本保存或丢弃服务器回复草稿            |
| POST           | `/api/v1/outreach/conversations/:id/reply` | 按已保存草稿及幂等操作编号发送单人回复          |

收件箱与可识别已发件箱的游标和消息在同一事务提交，失败保留原位置。消息编号和引用仅在同一邮箱内归并会话；同主题不直接合并，账号身份变化后隔离旧缓存。系统发送记录中的服务商接受与邮箱中的实际邮件状态分开显示。此入口不回信、不生成采购需求，也不修改原邮箱标记。旧 `/api/v1/mail/*` 返回 404；公司内部试发继续由多邮箱触达服务承担。

## 后续开发顺序

1. 完成 n8n Webhook 与结果汇总的真实联调，确定稳定输出 schema。
2. 服务端加入数据库、认证与持久化任务模型，将同步请求改为可恢复的异步任务。
3. 独立实现真实客户 repository，给每个字段保留来源证据；真实结果转换时进行去重及人工复核。
4. 在首封触达服务上继续补齐真实客户的公开联系来源和产品资料；回复、追信与 WhatsApp 适配分别建设。现有服务端发送前复核、停止联系和企业去重规则继续生效。
5. 部署前配置 HTTPS、身份认证、权限、配额、速率限制、审计日志和数据备份；本机版本不直接绑定公网。

## 实现取舍

### 获客模块边界

- `server/app.mjs` 负责 HTTP 参数校验、来源限制、单次请求幂等与任务接口；通过 `createAcquisitionProvider()` 选择执行引擎。
- `server/acquisition-provider.mjs` 提供统一的 `info`、`readLeads`、`discover`、`research`、`status`、`run`、`recoverRun`、`history`、`close` 契约。n8n 的 Webhook、历史查询和状态恢复协议在适配器内处理；native 适配器延迟创建 `NativeAcquisition`，只查看配置不会打开操作数据库。
- `status` 核对批量任务的企业操作；`recoverRun` 核对结果不明的单次运行。n8n 旧单次协议不支持恢复查询，因此返回未确认，不能套用批量协议或重放原请求。
- `server/batch-jobs.mjs` 只负责批量任务调度、预算、持久化和读回计数，通过注入的引擎方法执行工作。`search-plan.mjs` 负责搜索计划，`website-identity.mjs` 负责域名身份；单次引擎和飞书客户端不依赖批量调度器。
- 客户研究、准入、字段合并和联系方式规则仍是 n8n 与 native 共用的业务函数。n8n 沙箱通过生成代码加载这些函数，不能直接套用 Node.js 模块导入方式。
- `server/mail-conversations.mjs` 管理会话、原文、HTML、已读状态与账号同步位置；`server/mailbox-reader.mjs` 负责只读 IMAP、有界正文及 CID 图片读取。`server/mail-replies.mjs` 管理版本化草稿与独立幂等发送台账，`server/mail-content.mjs` 规范富文本和附件，`server/mail-conversation-business.mjs` 登记明确匹配的客户沟通事实。收件与发送使用同一加密账号配置，副本归档失败不能触发 SMTP 重发。人工回复不套用开发日额度、营销时段或首封审批，账号暂停和连接校验仍适用。
- `server/outreach-service.mjs` 管理首封计划、适用邮箱分配、企业占用和队列；`outreach-content.mjs` 按客户证据匹配具体产品及有效官网覆盖并生成草稿；`outreach-mailboxes.mjs` 保护凭证并固定实际发件地址；`outreach-business.mjs` 仅将 SMTP 已接受的真实首封记录到客户业务库。SMTP 已接受与实际送达分别记录。

本次检查的取舍与后续维护建议见 [可维护性检查](maintenance-review.md)。

MCP 是开发协助通道，业务运行使用服务端 HTTP。native 模式由 Node.js 直接调用 Tavily、DeepSeek 和飞书；原 n8n 仍可作为回退引擎。平台凭证仅保存于服务端环境，不进入前端或 Git。任务队列、定时计划、产品目录、操作日志与评估快照已持久化到本机 SQLite；云端身份认证、正式数据库备份和多来源采集仍需在部署阶段建设。
