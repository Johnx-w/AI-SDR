# 沟通中心与产品资料开发交接

## 本机三邮箱工作区

端口 14342 读取 14326 的三邮箱独立快照，使用原邮箱配置和资料试问界面。素材库沿用 DeepSeek 文档解析版本。启动脚本支持本机 DeepSeek 与飞书只读连接。

## 2026-11-23 DeepSeek 文档解析（本地分支）

基于 `2c66873`，素材库的 PDF、DOCX、PPTX 现接 DeepSeek 官方服务。导入、重新解析和换版可选图文或纯文字。配置入口、原件保留及校对步骤见[素材库操作](README.md#素材库与业务员操作)。旧审核资料和邮箱规则继续使用。生产部署基线仍为 PR #42。

在用户要求停止测试之前，DeepSeek 官方图文 OCR 已返回一份 33 页目录的逐页结果。在第 4、13 和末页读到抽查字段。这是 OCR 接口回读。完整浏览器验收已按用户要求停止，未执行本轮回归套件。客户端与服务端生产构建通过。本地演示为 `http://127.0.0.1:14339/materials`。

## 2026-11-23 FastGPT 集合页面重写（本机）

正式页面入口为 `/materials`，搜索测试入口为 `/materials?tab=test`。

按 FastGPT 的集合表、独立集合数据页、分块卡、点击编辑和右侧信息栏设计前端。搜索测试复用邮箱自己的资料查询。点原件位置可定位 PDF 页，编辑窗口也能展开同一页原件。文件导入沿用本机的自动解析。文件上传、搜索、排序、批量启停和审核均连接本项目服务。[参考页面结构](https://github.com/labring/FastGPT/blob/84165f6da55de02fcc3fbc6f8e2c179d5462ac14/projects/app/src/pages/dataset/detail/index.tsx) · [集合列表](https://github.com/labring/FastGPT/blob/84165f6da55de02fcc3fbc6f8e2c179d5462ac14/projects/app/src/pageComponents/dataset/detail/CollectionCard/index.tsx) · [集合数据](https://github.com/labring/FastGPT/blob/84165f6da55de02fcc3fbc6f8e2c179d5462ac14/projects/app/src/pageComponents/dataset/detail/DataCard.tsx)

桌面及 390 像素手机浏览器实测，分块和编辑窗口可以打开对应原页。按邮箱搜索测试覆盖已审核片段命中和无匹配两种结果。运行 `npm run verify:mail:browser` 和 `node scripts/verify-material-import.mjs <样本目录>` 复测。

2,500 份合成文件，使用 `node scripts/benchmark-materials.mjs` 对每个查询请求 22 次。基线与本版首页、第 100 页、组合筛选耗时中位数分别为 19 / 31 / 9 ms。本版新加的按名称升序第 2 页首次 39 ms，后续中位数 38 ms，最慢 42 ms，响应 6,745 字节。桌面和 390 像素手机的浏览器验收通过。50 MiB 文件的选择、拖入、换版、超限保护、原件下载及停用后重新启用均通过。生产构建和格式检查通过，全套测试 1,192 项通过、4 项跳过。手动验收重点为桌面分块编排、手机侧栏和资料校对的操作习惯。

## 前次交付基线

2026-11-23 11:45（北京时间），GitHub 的 production 部署 `7989862463` 成功。交接时远端 `main` 和该次部署均指向 `1e0ad42`。业务邮件起草与自动回复随 PR #37 合入，PR #38 修复了 Windows 邮箱凭据冷启动超时。[业务邮件改动](https://github.com/Johnx-w/AI-SDR/pull/37) · [凭据修复](https://github.com/Johnx-w/AI-SDR/pull/38) · [Windows 与 Linux CI](https://github.com/Johnx-w/AI-SDR/actions/runs/45107256970) · [生产发布](https://github.com/Johnx-w/AI-SDR/actions/runs/45107441787)

| 业务入口                      | 已实现                                                                                                     | 验收依据                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 沟通中心 → 邮箱管理、跟进序列 | 客户固定发件邮箱，按邮箱选产品资料、签名和回复策略。未回信跟进默认按首封实际发送后第 3、7 天排期，可编辑。 | [功能边界、模拟时钟验收与回退](README.md)                                                                                                          |
| 沟通中心 → 收件箱             | AI 按邮箱身份和来信线程起草正式邮件。获准邮箱可自动回复常规业务邮件，产品事实须有该邮箱所选资料依据。      | 三个公司内部地址实测共 4 封经 SMTP 接受且由 IMAP 回读。常规业务样例在原线程回复，带签名和下一步。测试收件人为内部账号。[邮件验收与操作](README.md) |
| 素材库                        | 支持文件上传、解析预览、校对、换版与撤回，并可按邮箱选用资料。                                             | 3 份公司 Excel 已按原单元格抽查。50 MiB 扩容已在下方本机分支验收，待单独发布。[素材库操作与验证](README.md#素材库与业务员操作)                     |

## 如何更新这份交接

按 Cursor 团队公开的开发实践，把任务目标和可验证的完成条件写入 Git，用新的对话承接单一任务。接手时先核对基线，交付时将对应工作项更新为实际结果，注明验证环境、命令或页面入口、提交及剩余问题。长期项目规则集中在仓库根目录。[Cursor 团队的 Agent 开发实践](https://cursor.com/blog/agent-best-practices) · [Cursor 项目规则](https://cursor.com/docs/rules) · [本项目协作约定](../../AGENTS.md)
