# Node.js 获客迁移

2026-10-21：第一阶段将现有网页获客链路迁移到 Node.js。前端通过统一接口访问执行引擎，旧 n8n 接口保留为兼容路径。飞书仍是业务客户表；当前任务库仍使用 SQLite。

## 已迁移

- Tavily 搜索、候选官网筛选、已有域名排重。
- 公网 HTTPS 官网采集，最多五个同域页面；从完整 HTML 发现联系、关于和服务范围页。失败页面可由 Tavily 补充，补充范围仍限于计划内页面。
- DeepSeek Responses API、严格结构化研究请求，以及原文引证校验。
- 飞书应用认证、完整分页读取、字段类型检查、身份匹配、定向更新和写后读回。
- 已有批量任务的停止、继续、预算及进度持久化；新任务记录执行引擎，防止迁移后误恢复旧引擎任务。
- 操作日志保存在 acquisition_operations 表，包含研究证据、写入意图、记录 ID 与最终输出。密钥只从服务端环境变量读取。

## 配置与预检

在本机 .env 或服务器环境中配置：

    ACQUISITION_PROVIDER=native
    TAVILY_API_KEY=填写现有 Key
    DEEPSEEK_API_KEY=填写现有 Key
    DEEPSEEK_MODEL=deepseek-flash
    FEISHU_APP_ID=填写原飞书自建应用 ID
    FEISHU_APP_SECRET=填写原应用 Secret
    FEISHU_APP_TOKEN=填写现有多维表格 app token
    FEISHU_TABLE_ID=填写原数据表 ID
    BATCH_DB_PATH=.data/acquisition.sqlite

运行 npm run preflight:native：核对配置、飞书表格可读性与 DeepSeek 模型，不调用搜索或写入。

npm run verify:native:live 使用真实 Tavily / DeepSeek 额度，以一个已有客户验证官网采集与研究；飞书写入被替换为内存模拟，网络层也禁止所有多维表格写请求。结果保存到 .data/native-verification.json，原记录应保持不变。

正式进程使用 server/index.mjs 为任务和操作日志提供持久化路径。直接使用 createApp 或 NativeAcquisition 时必须显式提供数据库路径；省略路径用于隔离测试的内存库。修改 .env 后需要重启 API 子进程。服务只绑定 127.0.0.1。

## 接口

统一路径为 /api/v1/acquisition，包含 status、locations、search-query、jobs、jobs/:id、jobs/:id/stop、jobs/:id/resume、runs、executions。旧 /api/v1/integrations/n8n 路径映射到同一选定引擎，不会根据请求路径绕过配置。

native 模式下 /api/v1/leads/real 直接读取飞书，无需 n8n 只读 Webhook。status 仅表示配置是否齐备，不伪造平台连接验证。executions 只返回操作编号、状态和时间，不返回密钥或完整证据。

## 写入与恢复

研究已增加全局客户准入：同品类自有工厂、纯本地安装/零售、目标产品不匹配及个人消费者均不写入；经营主体、生产方式或经营范围证据不足也不写入。C 端企业可正常通过。规则与证据要求详见 `customer-fields.md`。仅保留美国、澳大利亚、加拿大、英国和欧洲（不含英国）获客市场；旧任务恢复时重新校验。

仅采集字段可更新，负责人、开发状态、备注、客户等级及首次发现时间不会被复核覆盖。新增前重新读取身份；同域名多行、指定记录 ID 不匹配均停止写入。搜索已收录域名时直接跳过，显式指定 target_record_id 才允许复核原记录。

远端写入前持久化写入意图，新增请求附 UUID client_token；发生不确定结果不会自动重发写请求。若记录编号已返回而读回失败，重启后仅通过原编号核对字段。若写响应丢失且没有记录编号，维持暂停，不能仅凭相同域名出现就宣称该操作成功；需要人工核对，不能重新提交来掩盖不确定状态。

第一阶段按现有单实例、单活跃任务运行。不要同时启动多个指向同一数据库的工作进程；不要从 n8n 和 native 同时对同一范围执行获客。切换配置前先完成或核对所有未结束任务。

## 回退

将 ACQUISITION_PROVIDER 改回 n8n 并重启 API，原 Webhook 和只读入口配置继续生效。历史客户和任务不删除。旧任务没有 provider 字段时按 n8n 处理；暂停任务必须由创建它的引擎恢复，不会跨引擎自动执行。

迁移前线上工作流快照保存在本机忽略目录 artifacts/native-migration-workflow-before.json；本轮未修改或停用线上 n8n 工作流。

## 后续阶段

云端部署、身份认证、PostgreSQL、定时计划、国家/州推进、协会与展会目录适配器及社媒接入尚未实现。它们将基于这条直连链路继续建设，不能将第一阶段理解为已经上线云端全自动采集。
