# n8n 工作流作为业务 API

## 当前核对的真实流程

工作流 ID：`EycE9OmaPkRFUDSq`；2026-10-19 在用户已登录编辑器中核对。

入口为 `Manual Trigger / ShadeFlow API Webhook → 配置搜索目标`，后接 Tavily Search / Extract、Dify Workflow、飞书域名预处理、按身份键查询、写入分流、新增/更新与入库汇总。业务输入字段：

```json
{
  "country": "United States",
  "region": "Florida",
  "city": "Miami",
  "product": "outdoor zip screens",
  "customer_types": ["installer", "distributor"],
  "search_query": "outdoor zip screens Miami Florida USA"
}
```

## 建议的最小修改

1. 在原流程增加 `Webhook` 入口并接到“配置搜索目标”，保留原 Manual Trigger。
2. HTTP Method 选 POST，使用唯一 path；Authentication 选择 Header Auth。凭证头名称为 `X-Shadeflow-Key`，值使用自己生成的长随机密钥。
3. Respond 选择 **When Last Node Finishes**，Response Data 选择 **All Entries**。这样网页会等待流程结果；不要选择 Immediately，否则只能收到“已启动”，不能拿到业务结果。
4. 将“配置搜索目标”的 JSON 从固定值切到 Expression，用以下表达式让 API 请求生效，同时兼容手动默认值：

```text
{{ JSON.stringify({
  country: $json.body?.country ?? "United States",
  region: $json.body?.region ?? "Florida",
  city: $json.body?.city ?? "Miami",
  product: $json.body?.product ?? "outdoor zip screens",
  customer_types: $json.body?.customer_types ?? ["installer", "distributor"],
  search_query: $json.body?.search_query ?? "outdoor zip screens Miami Florida USA",
  request_id: $json.body?.request_id ?? "manual"
}) }}
```

5. 核查所有分支都会输出有意义的状态。建议在失败或“不可入库”分支输出 `{status:"skipped", reason:"..."}`，而不是静默无输出；在入库汇总输出 `{status:"completed", ...}`。如果工作流有多分支及循环，需要核实最后完成的节点是否始终为所需的业务汇总；必要时增加统一汇总与 Respond to Webhook 节点。不能只看到 HTTP 200 就认定飞书写入成功。
6. 发布工作流，复制 **Production URL**；Test URL 只在手动监听期间有效。
7. 本地复制 `.env.example` 为 `.env`，设置下面三项，然后重启 `npm run dev`：

```dotenv
N8N_WEBHOOK_URL=https://vynox.app.n8n.cloud/webhook/你的路径
N8N_WEBHOOK_SECRET=与HeaderAuth一致的密钥
N8N_WEBHOOK_ENABLED=true
```

`N8N_WEBHOOK_ENABLED` 在完成凭证配置与发布前保持 false，前端运行按钮会保持禁用。`N8N_API_KEY` 可选，仅用于读取执行历史，不是运行工作流的必要条件。创建入口是 n8n 的 **Settings → n8n API → Create an API key**。n8n 官方说明免费试用期不提供 Public API，试用时可以先留空；付费开通后再配置历史读取。不要把 Codex OAuth token 复制到项目中。

## 接口链路

```text
浏览器 POST /api/v1/integrations/n8n/runs
  → Node 服务校验六个字段与客户类型
  → 服务端附加 X-Shadeflow-Key 和 X-Request-ID
  → n8n Production Webhook
  → 现有业务节点
  → JSON 结果原样封装返回网页
```

本机服务只允许同源调用，密钥不进入浏览器。参数只会传入 `.env` 中同一 n8n 实例的 HTTPS 生产 Webhook，不跟随重定向。服务端不自动重试，单进程最多一个并发真实任务，相同幂等键不会重复执行。

## 验证与限制

- 第一次真实提交前核对搜索条件，原流程会产生外部 API 请求并按原逻辑写入飞书。
- 本地同步调用等待上限 110 秒。超时或网络失败不能判断远端是否已完成，应先到 n8n Executions 核对。
- 当前封装中的 `status: completed` 表示 Webhook 成功返回 JSON，不替代对 `result` 中业务状态和飞书写入结果的核对。
- 本地幂等记录仅保留到进程重启，最多 500 条；生产需持久化运行记录，n8n 侧也应基于 `request_id` 去重。
- 长任务建议升级为 202 + 持久化任务 ID + 状态查询／签名回调，避免长期占用 HTTP 连接。
- 已经在原流程新增 `ShadeFlow API Webhook` 并连接到“配置搜索目标”。后者已经按上述表达式读取请求体，原 Manual Trigger 保留。
- 2026-10-19，用户亲自填写并保存了 Header Auth 凭证；随后发布了 `ShadeFlow Webhook API v1`。n8n 显示 Workflow published，生产 URL 为 `https://vynox.app.n8n.cloud/webhook/shadeflow-leads-api`。
- 已使用不带认证头的 POST 请求验证生产入口返回 HTTP 403，证明入口存在且拒绝未认证请求；此检查不会进入业务节点。尚未进行带正确凭证的真实获客执行，因此不宣称 Tavily / Dify / 飞书全链路通过。
- 可运行 `node scripts/prepare-n8n-env.mjs` 生成未跟踪的本地 `.env` 与 32 字节随机密钥，脚本不会覆盖已有文件或在日志中显示密钥。

官方依据：[Webhook API 与响应模式](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)、[Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/)。

API key 与试用限制：[n8n Public API authentication](https://docs.n8n.io/connect/n8n-api/authentication/)。
