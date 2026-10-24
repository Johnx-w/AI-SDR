# T2、T5 实施与手动重启

本期落实用户在 2026-10-24 确认的方案，业务含义见 [ADR-0009](adr/0009-business-tables-with-web-managed-configuration.md)。

本阶段实施已完成：T2 为 26 列、T5 为 21 列；16 家客户原有资料与 15 份当前评估完整，T12 已删除。T5 初始无产品事实，等待录入真实资料。本阶段 450 项自动测试、生产构建和正式页面读取核验均通过；草稿保存使用独立内存预览验证，未向真实 T5 写入测试产品。后续 T1/T3/T4 联动见[客户业务表实施说明](customer-business-tables.md)。

## T2 企业档案

原来的 23 列保留记录和字段编号，其中五列原位改名：

| 原名称       | 新名称       |
| ------------ | ------------ |
| 用户评级     | 初评结果     |
| 相关产品     | 企业经营产品 |
| 主营产品偏好 | 主营产品概况 |
| 需求产品     | 公开采购需求 |
| 服务客群     | 企业服务客群 |

增加企业官网（链接）、主要供货机会（文本）、待确认事项（文本），合计 26 列。仅依据现有当前评估回填，原始来源及人工开发字段保留；第三方贸易平台来源的隔离记录不补猜官网或恢复自动评级。

新增研究及网页展示兼容五列的新旧名称。企业官网用于身份与域名去重，来源链接用于保留原始出处。主要供货机会不表示客户已经提出采购需求；未知项和研究限制保存在待确认事项中。

## T5 产品资料

网页「资料中心」提供真实产品资料的录入、编辑、审核和归档。当前资料持久化到 SQLite，并同步到同一飞书多维表格中的「T5 产品资料库」。获客搜索词库继续用于搜索，不自动填充公司产品事实。

21 列包括产品编号、名称与英文名、品类、供货方向、采购形态、别名、已核实参数、MOQ、常规交期、适用品牌、适用市场、来源、附件、审核状态、资料版本、生效日期、审核人、审核时间、最近更新时间及备注。首次建立不预置未经确认的产品数据。

未知事实留空；审核通过需要来源或附件和审核人。已审核内容实质变更后退回待审核，明确再次审核后才成为可用资料。归档内容保留查询。网页保存与飞书同步分别报告结果，远端异常时可按原产品编号重新核对同步，不重复新建。此阶段不自动开放真实开发信或自动回信。

接口：

- `GET /api/v1/products/knowledge`：读取当前资料及飞书镜像配置。
- `POST /api/v1/products/knowledge`：新增，要求 `Idempotency-Key`，同一操作跨重启不会重复新增。
- `PUT /api/v1/products/knowledge`：修改或归档，要求 `id` 与 `expectedVersion`，防止覆盖较新的修改。
- `POST /api/v1/products/knowledge/:id/sync`：按当前产品编号核对并同步，不改变本地资料版本。

## 手动重启与收尾

在项目目录执行 `npm run schema:prepare`，会先备份，再新增 T2 三列并建立 T5，暂时保留旧列名和 T12。

如果原服务终端仍在，按 `Ctrl+C`，然后执行：

```powershell
Set-Location -LiteralPath 'D:\CodeX\ai获客'
npm start
```

若提示 `EADDRINUSE`，另开 PowerShell 查看 4311 端口的进程：

```powershell
$acquisitionPid = (Get-NetTCPConnection -LocalPort 4311 -State Listen | Select-Object -First 1).OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=$acquisitionPid" | Select-Object ProcessId, CommandLine
```

确认显示的是本项目的 `node ... server/index.mjs` 后，执行 `Stop-Process -Id $acquisitionPid`，再回到项目目录运行 `npm start`。保持服务终端开启。

可以在另一个终端核验：

```powershell
Invoke-RestMethod 'http://127.0.0.1:4311/api/v1/assessments/rules'
```

新版应同时返回 `assessmentStorage: latest_only` 和 `businessSchemaVersion: t2-t5-v1`。两个标识都存在后，执行 `npm run schema:finalize`，或在聊天中告知已重启，由助手执行。

收尾会再次备份并检查任务空闲，原位改名五列，确认 16 家客户的原有资料及 15 份最新评估不变后删除已备份的 T12 实表。若服务版本、字段、客户或评估已发生未预期变化，会停止并说明原因。私有备份与核验结果保存在 `.data/backups/t2-t5-20261024/`，不随项目代码发布。
