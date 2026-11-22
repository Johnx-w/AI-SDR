# 历史来信与只读同步

在跟进任务中选择「邮箱来信跟进」，或打开 `/business?view=replies`。列表从当前服务使用的 SQLite 读取，单页 25 封，点击主题在收件箱打开同一账号的同一线程。原自动追信任务可以按客户查看来信，按发送计划查看执行记录。

## 查看依据

- 「客户回信」要求 IMAP 收到入站邮件、有有效 In-Reply-To 或 References，且排除了已识别的通知、退信、退订、投诉和内部往来。列表显示邮箱实际收到的来信，不验证发件人的法律身份。没有本地原发件时，保留真实回复头并显示“未找到本地原发件”。无回复头的来信可从单独筛选查看。
- 客户名称仅来自已知客户地址的唯一匹配。无匹配或多个同地址客户时显示原发件地址。绑定账号之间的邮件归入内部往来，其中带内部 QA 标记的邮件归入内部测试。
- 查看本邮箱发给该对方的后续邮件时，核对其 In-Reply-To 或最后一个 References 是否指向这封来信的 Message-ID。已有人工/自动提交记录时显示具体处理方式；只有原邮箱发件证据时显示“邮箱已回复”。没有可核对的后续邮件时，客户回信显示“待跟进”。一次新建邮件、改主题另起线程或遗漏已发件历史都可能缺少可核对的关联。
- 分类基于已识别的邮件头、发件地址及通知特征。此列表不会创建 CRM 客户、发送计划或发件任务。历史未回复列表和自动追信任务分别保留自己的业务含义。

## 本机独立同步

使用本机加密邮箱注册文件所在的隔离数据目录。目录需要独立的 `mailboxes.json` 和 `outreach.sqlite`，新建数据库时只初始化会话和来信索引。若使用已有库，先按 SQLite 一致备份方式准备快照，保持邮箱 ID 和注册信息一致。Windows DPAPI 凭据应由可解密它的同一用户在本机运行。显式指定目录后，工具只加载该目录的邮箱注册文件。

```powershell
node scripts/sync-mail-readonly.mjs --data-dir D:\mail-review\outreach
node scripts/sync-mail-readonly.mjs --data-dir D:\mail-review\outreach --mailbox <邮箱ID> --since 2026-01-01 --rescan --max-pages 40
```

每次每个文件夹最多处理 50 封；每邮箱最多读取 `--max-pages` 批。默认尝试完成至多 40 批。首次默认最近 30 天，有游标时从原位置继续。指定更早的起点会扩展范围，`--rescan` 从指定起点重新读取以补存回信头。没有提供新的起点时，回扫使用原起点。达到批次上限仍有更多内容时，不带 `--rescan` 重跑即可继续。输出中的 `imported` 仅统计新增本地消息，已存邮件的头部补录不计为新增。

工具使用阿里企业邮箱 IMAPS 和正式版读取器，以只读方式选择 INBOX 与可识别的已发件文件夹，通过 PEEK 读取邮件。只读同步不会更新邮箱的已读标记，不启动发件调度或接待，也不调用 SMTP、模型、CRM 或飞书。业务页需指向同一隔离库（`OUTREACH_DB_PATH`）和同一邮箱注册目录（`OUTREACH_DATA_DIR`）。用临时快照同步只影响该快照，访问正式服务的运行环境需要另行部署验证。

## 验证

`node --test tests/mail-reply-history.test.mjs tests/mailbox-reader.test.mjs tests/mail-conversations.test.mjs` 覆盖真实回复头、无首封历史、跨账号/收件人误关联、内部与机器邮件、分类分页、只读 IMAP、游标重试和并发。测试的性能用例用 1,203 封合成邮件（其中 1,202 封包含 16 KiB 正文）测量首屏、通知筛选和深页，输出重复读取耗时和 JSON 字节数，并核对 SQLite 查询计划；运行测试不接触真实账号。

读取接口为 `GET /api/v1/outreach/reply-history?mailboxId=all&kind=reply&page=1`。来信类型支持 `reply`、`inquiry`、`notification`、`bounce`、`unsubscribe`、`complaint`、`internal`、`test`、`all`；响应只含列表需要的元数据，原文和附件在收件箱详情中查看。
