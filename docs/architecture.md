# 架构与 API 契约

2026-10-21：获客链路新增 Node.js 直连引擎，原 n8n 接口保留兼容。最新配置、数据持久化、写入恢复与回退见 [迁移说明](native-migration.md)。下方 Webhook 契约描述 n8n 模式；统一业务入口为 /api/v1/acquisition。

## 业务数据

演示工作台通过 `useWorkspace()` 访问状态，由 `WorkspaceRepository` 承担读写。默认 `MockWorkspaceRepository` 使用 `shadeflow:workspace:v3` 浏览器存储键。客户库只使用 `/api/v1/leads/real` 的真实数据，不回退演示客户。业务模型统一放在 `src/domain/types.ts`，样本与页面分离。

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

POST body 为六个 WorkflowInput 字段。浏览器传入 `Idempotency-Key`；服务端转发 `request_id` 和 `X-Request-ID`。成功返回：

```json
{
  "requestId": "UUID",
  "status": "completed",
  "result": { "由真实n8n返回": "业务字段" },
  "completedAt": "ISO 8601"
}
```

`completed` 仅指成功收到 JSON，不能单凭此字段推断业务入库成功。错误状态：400 无效输入、403 不允许的来源、409 幂等冲突或结果不确定、413 请求体过大、415 内容类型错误、429 并发限制、502 上游错误、503 未配置、504 未确认远端结果。对错误不自动降级成 mock。

## 后续开发顺序

1. 完成 n8n Webhook 与结果汇总的真实联调，确定稳定输出 schema。
2. 服务端加入数据库、认证与持久化任务模型，将同步请求改为可恢复的异步任务。
3. 独立实现真实客户 repository，给每个字段保留来源证据；真实结果转换时进行去重及人工复核。
4. 邮件、WhatsApp 与飞书分别实现服务端适配器；发送前审核、退订与停止跟进规则必须由服务端执行。
5. 部署前配置 HTTPS、身份认证、权限、配额、速率限制、审计日志和数据备份；本机版本不直接绑定公网。

## 实现取舍

### 获客模块边界

- `server/app.mjs` 负责 HTTP 参数校验、来源限制、单次请求幂等与任务接口；通过 `createAcquisitionProvider()` 选择执行引擎。
- `server/acquisition-provider.mjs` 提供统一的 `info`、`readLeads`、`discover`、`research`、`status`、`run`、`recoverRun`、`history`、`close` 契约。n8n 的 Webhook、历史查询和状态恢复协议在适配器内处理；native 适配器延迟创建 `NativeAcquisition`，只查看配置不会打开操作数据库。
- `status` 核对批量任务的企业操作；`recoverRun` 核对结果不明的单次运行。n8n 旧单次协议不支持恢复查询，因此返回未确认，不能套用批量协议或重放原请求。
- `server/batch-jobs.mjs` 只负责批量任务调度、预算、持久化和读回计数，通过注入的引擎方法执行工作。`search-plan.mjs` 负责搜索计划，`website-identity.mjs` 负责域名身份；单次引擎和飞书客户端不依赖批量调度器。
- 客户研究、准入、字段合并和联系方式规则仍是 n8n 与 native 共用的业务函数。n8n 沙箱通过生成代码加载这些函数，不能直接套用 Node.js 模块导入方式。

本次检查的取舍与后续维护建议见 [可维护性检查](maintenance-review.md)。

MCP 是开发协助通道，业务运行使用服务端 HTTP。native 模式由 Node.js 直接调用 Tavily、DeepSeek 和飞书；原 n8n 仍可作为回退引擎。平台凭证仅保存于服务端环境，不进入前端或 Git。任务队列与操作日志已持久化到本机 SQLite，云端认证、定时计划、PostgreSQL 和多来源采集将在后续阶段建设。
