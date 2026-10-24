# 架构与 API 契约

2026-10-21：获客链路新增 Node.js 直连引擎，原 n8n 接口保留兼容。最新配置、数据持久化、写入恢复与回退见 [迁移说明](native-migration.md)。下方 Webhook 契约描述 n8n 模式；统一业务入口为 /api/v1/acquisition。

## 业务数据

演示工作台通过 `useWorkspace()` 访问状态，由 `WorkspaceRepository` 承担读写。默认 `MockWorkspaceRepository` 使用 `shadeflow:workspace:v3` 浏览器存储键。客户库只使用 `/api/v1/leads/real` 的真实数据，不回退演示客户。业务模型统一放在 `src/domain/types.ts`，样本与页面分离。

沟通中心不经过 `WorkspaceRepository`，而是直接读取本机 `/api/v1/mail/*` 服务和独立 SQLite 邮件试点库。当前服务端硬性限定发件地址 `SL01@shutterblindssolutions.com` 与测试收件地址 `SL01@honeybadgerblinds.com`，只处理接通后带测试标记的新线程；它不是通用客户收件箱，也不导入历史邮件。

`HttpWorkspaceRepository` 已预留以下契约，但业务后端尚未实现，当前不启用：

- `GET /api/v1/workspace` → `Workspace`
- `PUT /api/v1/workspace`，body 为完整 `Workspace` → 2xx

正式接入建议拆成 customers / contacts / evidence / campaigns / messages / tasks 的资源接口，数据库做唯一性、权限和版本控制，而不是长期整库 PUT。替换仓储与状态管理后不必重写页面布局。

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

## 已实现的受控邮箱试点接口

所有 `/api/v1/mail/*` 请求均须在 `X-Mail-Operator-Token` 提供本机沟通中心操作者口令；服务端要求该口令至少 32 字符。网页只把口令保存在当前浏览器会话，它与邮箱客户端安全密码分离。

| 方法 | 路径                                   | 行为                                                                 |
| ---- | -------------------------------------- | -------------------------------------------------------------------- |
| GET  | `/api/v1/mail/status`                  | 返回仅测试模式、固定邮箱配置、IMAP/SMTP 与 Agent 暂停状态            |
| GET  | `/api/v1/mail/conversations`           | 列出本机已收录的固定测试线程，不返回历史或真实客户收件箱             |
| GET  | `/api/v1/mail/conversations/:id`       | 读取测试线程、消息和待审草稿                                         |
| PUT  | `/api/v1/mail/conversations/:id/draft` | 按修订号保存人工回复草稿，不发送                                     |
| POST | `/api/v1/mail/test-send`               | 经明确确认和幂等键向固定公司测试地址发送一次固定非营销技术测试信     |
| POST | `/api/v1/mail/sync`                    | 经明确确认后同步基线之后、地址和测试线程标记均匹配的新邮件           |
| POST | `/api/v1/mail/conversations/:id/reply` | 经明确确认、草稿修订核对和幂等键后，仅向固定测试地址执行真实测试回信 |

当前代码具备上述本机固定双公司地址测试能力，但尚未取得并配置新生成的本机邮箱客户端安全密码与操作者口令，因此尚未完成真实邮箱联通。真实产品资料仍缺失，主动开发规则会输出 `suppress`；真实潜客发信、自动回信与自动追信均保持关闭。邮箱连接成功只证明技术收发能力，不构成发信授权。

## 后续开发顺序

1. 完成 n8n Webhook 与结果汇总的真实联调，确定稳定输出 schema。
2. 服务端加入数据库、认证与持久化任务模型，将同步请求改为可恢复的异步任务。
3. 独立实现真实客户 repository，给每个字段保留来源证据；真实结果转换时进行去重及人工复核。
4. 在现有固定双公司地址邮件试点之外，另行审核产品资料、触达计划、发件身份与抑制状态后，再实现真实客户邮箱适配和授权范围；发送前审核、退订与停止跟进规则必须由服务端执行。WhatsApp 仍需独立实现服务端适配器。
5. 部署前配置 HTTPS、身份认证、权限、配额、速率限制、审计日志和数据备份；本机版本不直接绑定公网。

## 实现取舍

### 获客模块边界

- `server/app.mjs` 负责 HTTP 参数校验、来源限制、单次请求幂等与任务接口；通过 `createAcquisitionProvider()` 选择执行引擎。
- `server/acquisition-provider.mjs` 提供统一的 `info`、`readLeads`、`discover`、`research`、`status`、`run`、`recoverRun`、`history`、`close` 契约。n8n 的 Webhook、历史查询和状态恢复协议在适配器内处理；native 适配器延迟创建 `NativeAcquisition`，只查看配置不会打开操作数据库。
- `status` 核对批量任务的企业操作；`recoverRun` 核对结果不明的单次运行。n8n 旧单次协议不支持恢复查询，因此返回未确认，不能套用批量协议或重放原请求。
- `server/batch-jobs.mjs` 只负责批量任务调度、预算、持久化和读回计数，通过注入的引擎方法执行工作。`search-plan.mjs` 负责搜索计划，`website-identity.mjs` 负责域名身份；单次引擎和飞书客户端不依赖批量调度器。
- 客户研究、准入、字段合并和联系方式规则仍是 n8n 与 native 共用的业务函数。n8n 沙箱通过生成代码加载这些函数，不能直接套用 Node.js 模块导入方式。
- `server/mail-service.mjs` 负责固定测试会话、草稿修订、幂等发送状态和本机 SQLite 持久化；`server/mail-transport.mjs` 负责阿里企业邮箱的 IMAP/SMTP 传输，并在传输层再次限制固定地址和测试线程。HTTP 层还要求独立本机操作者口令，任何一层都不能把技术连接解释为真实潜客发信授权。

本次检查的取舍与后续维护建议见 [可维护性检查](maintenance-review.md)。

MCP 是开发协助通道，业务运行使用服务端 HTTP。native 模式由 Node.js 直接调用 Tavily、DeepSeek 和飞书；原 n8n 仍可作为回退引擎。平台凭证仅保存于服务端环境，不进入前端或 Git。任务队列、定时计划、产品目录、操作日志与评估快照已持久化到本机 SQLite；云端身份认证、正式数据库备份和多来源采集仍需在部署阶段建设。
