# 架构与 API 契约

2026-10-21：获客链路新增 Node.js 直连引擎，原 n8n 接口保留兼容。最新配置、数据持久化、写入恢复与回退见 [迁移说明](native-migration.md)。下方 Webhook 契约描述 n8n 模式；统一业务入口为 /api/v1/acquisition。

## 业务数据

UI 通过 `useWorkspace()` 访问状态，由 `WorkspaceRepository` 承担读写。默认 `MockWorkspaceRepository` 使用 `shadeflow:workspace:v1` 浏览器存储键。业务模型统一放在 `src/domain/types.ts`，样本与页面分离。

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

MCP 是开发协助通道，业务运行使用服务端 HTTP。native 模式由 Node.js 直接调用 Tavily、DeepSeek 和飞书；原 n8n 仍可作为回退引擎。平台凭证仅保存于服务端环境，不进入前端或 Git。任务队列与操作日志已持久化到本机 SQLite，云端认证、定时计划、PostgreSQL 和多来源采集将在后续阶段建设。
