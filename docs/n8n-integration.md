# n8n 工作流作为业务 API

2026-10-21 的客户类型、画像筛选、产品分组、欧洲范围及飞书新字段，以[客户筛选与飞书字段](customer-fields.md)为准。下文保留早期接入记录；线上企业研究现已使用 DeepSeek。

## 当前核对的真实流程

工作流 ID：`EycE9OmaPkRFUDSq`；2026-10-19 在用户已登录编辑器中核对。

入口为 `Manual Trigger / ShadeFlow API Webhook → 配置搜索目标`，后接 Tavily Search / Extract、Dify Workflow、飞书域名预处理、按身份键查询、写入分流、新增/更新与入库汇总。业务输入字段：

```json
{
  "country": "United States",
  "region": "Florida",
  "product": "outdoor zip screens",
  "acquisition_channel": "tavily_web",
  "search_query": "outdoor zip screens Florida USA"
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
  region: $json.body?.region ?? "",
  product: $json.body?.product ?? "outdoor zip screens",
  acquisition_channel: "tavily_web",
  customer_types: [],
  search_query: $json.body?.search_query ?? [
    $json.body?.product ?? "outdoor zip screens",
    $json.body?.region ?? "",
    $json.body?.country ?? "United States"
  ].filter(Boolean).join(" "),
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

### 地区范围与规则搜索词

工作流表单提供“国家 → 州 / 地区 → 城市”联动选择。城市为空时搜索整个选中州；州和城市均为空时搜索整个国家。切换国家会清空州和城市，切换州会清空城市，同时刷新基础搜索词，避免保留旧城市的查询限制。API 同样允许空地区，校验城市必须属于所选州。

搜索词现按产品、客户类型、画像和地区自动生成，用户可手动编辑。AI 搜索词生成按钮和接口已移除；多产品用 OR 分组，短语加引号。此操作不调用模型、搜索服务或写入飞书。企业研究仍使用现有模型，见[客户联系方式与页面精简](customer-contact-cleanup.md)。

### 获客渠道与客户类型

2026-10-20 核对现有 n8n：使用 Tavily Search / Extract，未直连 Google 搜索、Google 地图、LinkedIn、Facebook、Instagram 或各国本地黄页。页面显示当前可用的 Tavily 渠道，以及六个置灰的待接入渠道；两个 POST 接口均拒绝未接入渠道，不会静默改用 Tavily。当前 acquisition_channel 为 tavily_web，旧客户端缺省该字段时兼容此渠道。

客户类型仅在研究后识别，并继续通过既有 customer_type → 飞书“客户类型”写入。配置搜索目标清空 customer_types 默认条件，Dify target_json 明确传 customer_type_filter: false 和归档说明，避免按客户类型筛选。安装商、经销商、制造商等仍使用现有 Dify 分类规则与飞书字段映射，本次不新增客户类型枚举。可部署表达式在 server/n8n-search-target.mjs。

上述两处节点参数已发布为版本 `273e8c3f-c3c1-4456-8cd5-6139dca314cb`，核对 activeVersionId 与草稿版本一致；节点连接及其他 25 个节点配置保持原样。本次未执行真实搜索或飞书写入。

服务端配置：

```dotenv
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_MODEL=deepseek-flash
```

密钥保存在被忽略的 `.env`，不使用 `VITE_` 前缀，也不返回给浏览器。配置后重启 Node 服务。地区选项来自本地派生数据，通过只读 `/api/v1/integrations/n8n/locations` 返回，来源和许可见 [地理数据说明](geography-data.md)。

API 依据：[DeepSeek 接入说明](https://api-docs.deepseek.com/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。

n8n“调用Dify Workflow”也已补传 `target_json.city`，未选中的 region / city 转为真正的 JSON null。原“配置搜索目标”使用空字符串默认值及 `??`，能保留网页传入的空范围；Tavily 使用网页最终确认的 search_query。此项只修改 Dify 请求体并发布为版本 `cc23c987-e3c4-42f6-81f1-6061a298b4a7`，原抓取容错、去重、联系方式提取及飞书写入连接保留。

```text
浏览器 POST /api/v1/integrations/n8n/runs
  → Node 服务校验地理范围、产品、搜索词和已接入渠道
  → 服务端附加 X-Shadeflow-Key 和 X-Request-ID
  → n8n Production Webhook
  → 现有业务节点
  → JSON 结果原样封装返回网页
```

本机服务只允许同源调用，密钥不进入浏览器。参数只会传入 `.env` 中同一 n8n 实例的 HTTPS 生产 Webhook，不跟随重定向。服务端不自动重试，单进程最多一个并发真实任务，相同幂等键不会重复执行。

## 验证与限制

- 第一次真实提交前核对搜索条件，原流程会产生外部 API 请求并按原逻辑写入飞书。
- 本地同步调用等待上限 110 秒。超时或网络失败不能判断远端是否已完成，应先到 n8n Executions 核对。
- `status: completed` 表示 Webhook 已返回有效数据；`summary.outcome` 区分飞书写入完成、部分完成、无新候选、失败、人工查重及待核实。页面根据业务结果展示状态，空数组、空对象或 null 返回 502，并保留幂等保护。
- 本地幂等记录仅保留到进程重启，最多 500 条；生产需持久化运行记录，n8n 侧也应基于 `request_id` 去重。
- 长任务建议升级为 202 + 持久化任务 ID + 状态查询／签名回调，避免长期占用 HTTP 连接。
- 已经在原流程新增 `ShadeFlow API Webhook` 并连接到“配置搜索目标”。后者已经按上述表达式读取请求体，原 Manual Trigger 保留。
- 2026-10-19，用户亲自填写并保存了 Header Auth 凭证；随后发布了 `ShadeFlow Webhook API v1`。n8n 显示 Workflow published，生产 URL 为 `https://vynox.app.n8n.cloud/webhook/shadeflow-leads-api`。
- 已使用不带认证头的 POST 请求验证生产入口返回 HTTP 403；2026-10-19 又完成了带认证的真实全链路执行，详见下方修复记录。
- 可运行 `node scripts/prepare-n8n-env.mjs` 生成未跟踪的本地 `.env` 与 32 字节随机密钥，脚本不会覆盖已有文件或在日志中显示密钥。

官方依据：[Webhook API 与响应模式](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)、[Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/)。

## 2026-10-19：空结果与抓取容错修复

执行 #122、#124、#125 均在 Tavily Extract 读取 Mirage 的同一页面时失败。原流程只尝试一个未收录候选，“可入库?”的 false 分支没有连接汇总，导致 n8n 执行状态为 success，但网页收到空数组，飞书没有写入。

- 保留现有已收录域名排重和筛选规则；最多选三个新候选，一次 Tavily Extract 批量读取，按候选顺序选择首个有正文的网站研究。每次仍只调用一次 Dify、研究并按原规则入库一家公司。全部抓取失败时返回原因及检查过的 URL，不用搜索摘要代替正文。
- “可入库?”的 false 分支连接到原“入库汇总”。所有业务结束路径输出 `outcome`、`execution_id`、新增/更新/失败/待人工查重计数、原因、研究结果和明细。HTTP/凭证等导致节点直接报错的情况仍返回上游错误，不伪造业务汇总。
- 保留原联系方式提取、字段映射、匹配判断及飞书按域名去重写入。原规则会记录不匹配企业的研究结果，不能将写入数量理解为匹配客户数量。
- 真实执行 #128 使用 United States / Florida / Miami / outdoor zip screens / installer、distributor 条件，首个 Mirage 页面仍抓取失败，随后成功研究 `https://clearviewdoor.com/miami`，飞书新增记录 `reczz28PINSCipyo`，回读确认客户总数从 11 变为 12。ClearView 被 Dify 判定为 `not_matched`，该结论原样保留。验证请求和返回保存在本地忽略文件 `artifacts/automation-repair-live-check.json`。
- 发布版本：`040e7d7e-8ecc-4edf-8add-350bc915bcc2`。回归覆盖首个抓取失败后采用后续正文、来源对应、全部失败、没有新候选、飞书实际写入计数及空响应不误报成功。

API key 与试用限制：[n8n Public API authentication](https://docs.n8n.io/connect/n8n-api/authentication/)。

## 2026-10-20：移除城市筛选，核对产品传参

- 自动获客页仅按国家和可选州 / 地区限定范围；不选州则搜索全国。移除城市控件、城市名称映射和任务中的 city 字段。服务端不再返回城市选项，也不再转发旧客户端的 city 参数；默认搜索词和 DeepSeek 请求不包含默认 Miami。
- 原 n8n 的“配置搜索目标”“调用Dify Workflow”“构建飞书记录”同步移除城市目标字段。客户实际所在国家、网页事实、联系方式提取、去重和写入分流保留；原有 27 个节点的连接与凭证未变。
- 产品选择已接入：勾选产品以现有逗号分隔字符串写入 product；搜索词更新后经 search_query 交给 Tavily Search，Dify 的 target_json.product 接收同一组所选产品。四家官网分组是前端目录，沿用同一条获客流程。
- 已发布并回读核对版本 c55dde9b-78ea-4608-850a-96646ae46983。完成浏览器多选联动检查、节点参数校验与本地回归；本次未触发真实获客或新增飞书记录。此前记录的城市筛选行为由本节替代。
