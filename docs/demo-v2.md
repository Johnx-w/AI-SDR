# 历史演示页面迁移说明

2026-10-27 已移除旧 V2 演示页面、虚构企业与会话样本、历史样本趋势图及浏览器演示仓储。网页不再读取或保存 `shadeflow:workspace:v3`，也不删除用户浏览器中已有的缓存或本机业务数据。

当前业务入口：

- `/`：真实运营总览。
- `/automation`：新建获客任务；`?tab=schedules` 管理定时计划，`?tab=runs` 查看执行记录。
- `/leads`：真实客户库及企业档案，支持导出 CSV。
- `/business`：客户需求、实际沟通记录与跟进任务。
- `/inbox`：沟通中心，管理邮件会话、发件邮箱、触达计划及发送记录。
- `/materials`：产品资料录入、审核和归档。
- `/settings`：API 连接配置。

旧 `/campaigns` 地址兼容跳转到 `/inbox?tab=campaigns`，旧 `/reports` 跳转到运营总览。`/tasks` 跳转到 `/business?tab=tasks`，表示客户跟进任务；定时获客位于获客任务页内。

邮件同步、测试与实际发送范围以[多邮箱首封开发](outreach-first-touch.md)为准。当前运行与验证步骤见 [README](../README.md)，业务记录说明见[客户业务表](customer-business-tables.md)。
