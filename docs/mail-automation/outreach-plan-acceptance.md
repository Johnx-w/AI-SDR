# 触达计划范围、删除与来源恢复验收

规格 [#85](https://github.com/Johnx-w/AI-SDR/issues/85)，任务 #86—#91，交付 [PR #92](https://github.com/Johnx-w/AI-SDR/pull/92)。2026-11-27 在 `integration/spec85` 功能提交 `4500496` 上完成以下检查；后续文档提交不改变业务代码。生产尚未发布，main 合并及生产发布等待用户另行确认。

## 需求适用范围与实际验证范围

需求适用于正式手动计划、获客自动首发安排、关联单次及定时来源、负责产品配置、未提交邮件及待追信。已经提交的结果与未知核实属于历史事实，删除后仍需保留；公司试发沿用既有独立控制。

实际验证环境为 Windows、Node 24.22.2、SQLite、构建后的 React 页面和无头 Edge，独立临时数据库，模型、SMTP、IMAP及获客研究使用测试替身。正常 UI、公开 HTTP/服务接口与持久化回读共同核对。预期集合来自原始夹具及规格，不以被测筛选结果构造预期。未连接生产客户发送邮件，未修改生产数据。

- 产品对象：Honey Badger 的布艺帘成品、轨道、配件，与 SBS 的室内帘、横百叶分别核对，Shuangsheng 透气窗补充；无邮箱覆盖的户外记录、同名素材文件和空覆盖邮箱为反例。另有合法其他及缺失品类产品。
- 来源对象：独立来源 A、B，以及无来源手动计划；删除 A 后验证 B 与手动计划未受影响。覆盖运行中企业保存、旧定时轮次、已结束来源及不存在来源。
- 客户历史：north、south 各四条历史，其中两封已发；quiet 无历史对照。逐项核对 ID、正文、人工核实证据、归属及已删除计划跳转。
- 旧计划：有品类限制、范围内全部、交集为空、缺失快照四类，跨重启重复迁移。旧摘要队列用两个可区分样本、新摘要对照及真实身份变化反例复验。
- 此次没有对生产全部客户、排队邮件或旧计划做行为验收。此前正式配置只读核对为版本 `93144d8`、北京时间 2026-11-27 16:04 的全部 7 条供货产品及 3 个邮箱，其中 6 条有覆盖、1 条无覆盖；该配置调查不等于本次行为验收。

## 六项交付及依赖

| 任务   | 可独立验收结果                             | 前置依赖 |
| ------ | ------------------------------------------ | -------- |
| T1 #86 | 计划显式产品、失效提示、保守旧计划迁移     | 无       |
| T2 #87 | 邮箱负责产品维护、影响预览、修订冲突与回读 | 无       |
| T3 #88 | 来源安全暂停、保留进度、关闭两处自动首发   | 无       |
| T4 #89 | 各状态删除、提交边界、未知核实与已删除查询 | 无       |
| T5 #90 | 直接恢复只获客；重新勾选保存才新建唯一安排 | T3、T4   |
| T6 #91 | 正常删除入口联动来源、故障补偿与重启恢复   | T5       |

各项均包含页面、接口、持久化及测试；依赖以 Issue 正文和 GitHub 关系为准。

## AC01—AC22

以下均在隔离环境通过。“服务测试”同时包含数据库回读与可控外部替身；浏览器只声明对应行列出的正常入口覆盖。

| AC   | 实际核对结果                                                                                                    | 可复现证据                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| AC01 | HB、SBS、三个邮箱并集各自产品、负责人、形态、计数准确                                                           | `verify-outreach-plan-controls.mjs`；`campaign-product-selection-ui.test.mjs`                                                         |
| AC02 | 无覆盖户外产品不可选，直接提交也被拒绝                                                                          | 同上；`outreach-service.test.mjs` 显式产品校验                                                                                        |
| AC03 | 取消最后产品页面不能保存；API 空集合失败，原授权未扩大                                                          | 同上，空集合与保存回读断言                                                                                                            |
| AC04 | 换到 SBS 保留失效轨道及原因，分组切换不丢选择；修正后才能保存                                                   | 同上，跨邮箱与跨分组浏览器步骤                                                                                                        |
| AC05 | 跨组保存、刷新及重开，编号集合和邮箱与输入相等                                                                  | 同上，持久化回读                                                                                                                      |
| AC06 | 合法其他/缺失分类产品可见，同名素材未混入，零产品分组不显示                                                     | 同上；UI 分组回归                                                                                                                     |
| AC07 | 新目录和覆盖不扩手动授权，编辑确认后才纳入；自动来源持续授权按原规则更新                                        | `outreach-service.test.mjs`；`acquisition-outreach.test.mjs` 同轮新增产品与邮箱                                                       |
| AC08 | 撤审、未生效、覆盖撤销、品牌不符拒绝启动或提交，原发件身份仍被锁定                                              | `outreach-service.test.mjs`；`outreach-mailboxes.test.mjs`；`acquisition-outreach.test.mjs`                                           |
| AC09 | 两个邮箱及空覆盖对照，增减影响正确；旧修订 409，刷新和落库相等                                                  | `verify-mailbox-coverage-browser.mjs`；`outreach-mailboxes.test.mjs`；`outreach-api.test.mjs`                                         |
| AC10 | 四类旧计划逐项迁移，空交集/缺快照等待确认，重启不扩大，历史可读                                                 | `outreach-service.test.mjs` 旧计划迁移；已删除快照保护回归                                                                            |
| AC11 | 五种正式状态 UI 删除，API 另含 preparing/ready；结束未发及待追信，已完成也生效                                  | `verify-outreach-plan-controls.mjs`；`outreach-deletion.test.mjs`；`outreach-cancellation-ui.test.mjs`                                |
| AC12 | 服务商提交前阻塞时先删除再放行，旧邮件新增提交为零；未提交占用按规则释放                                        | `outreach-service.test.mjs` 删除阻止服务商提交前的旧邮件                                                                              |
| AC13 | 已进入提交后成功/失败/未知各至多一次；真实结果保留，无新追信，未知占用保留                                      | `outreach-service.test.mjs` 删除保留提交后成功失败未知                                                                                |
| AC14 | 自动原邮箱核实与人工证据核实保留结果，缺证据继续未知，不重发不追信                                              | `outreach-reconciliation.test.mjs`；`outreach-service.test.mjs`；客户历史浏览器                                                       |
| AC15 | 删除 A 只暂停 A 并关闭自动首发、保留队列/原因/链接，B 与无来源计划不变                                          | `verify-outreach-source-controls.mjs`；`outreach-source-deletion.test.mjs`；`acquisition-source-controls.test.mjs`                    |
| AC16 | 定时当前企业完成保存后暂停，清除未来时点，两处关闭刷新仍未勾选                                                  | 来源浏览器；`acquisition-source-controls.test.mjs`；`connections-and-schedules.test.mjs`                                              |
| AC17 | 分别用 SQLite trigger 制造任务/定时安排写入失败；删除处理中持续阻止提交，重试/重启后补齐且幂等                  | `outreach-source-deletion.test.mjs`；`acquisition-outreach.test.mjs`                                                                  |
| AC18 | 自动恢复、轮询、重启及旧检查点均不能解除人工暂停、重新开关或复活旧计划                                          | `acquisition-source-controls.test.mjs`；`outreach-source-deletion.test.mjs`；`batch-jobs.test.mjs`                                    |
| AC19 | 直接恢复新安排/提交均零；重新勾选保存唯一 g1，暂停来源仍等待；旧终态及未知/勿联系/已有联系继续排除              | 来源浏览器；`acquisition-outreach.test.mjs` 两路径、同轮重授权；`outreach-business.test.mjs`                                          |
| AC20 | 定时恢复仅未来轮次，单次重跑使用新任务；关闭状态继承。显式开启才建新安排，删除来源后保留历史                    | 来源浏览器；`acquisition-source-controls.test.mjs`；`connections-and-schedules.test.mjs`；`outreach-source-deletion.test.mjs`         |
| AC21 | 重复恢复不建安排；有效重新授权唯一，旧页面恢复/开关保存返回 409；两库失败或重启不发布未完成授权，也不丢收尾进度 | `acquisition-outreach.test.mjs` 旧页面恢复、授权写入失败、跨重启恢复；`scheduled-acquisition-ui.test.mjs`                             |
| AC22 | 已删除 25 项分页 20/5、暂停筛选 13，无漏项重复；两客户历史完整、无数据对照为空，来源/核实/追信关联可读          | `verify-outreach-plan-controls.mjs`；`verify-customer-history.mjs`；`outreach-deletion.test.mjs`；`outreach-source-deletion.test.mjs` |

脚本路径均为根目录 `scripts/`，测试路径均为 `tests/`。

## 自动检查与正常入口

功能提交 `4500496`：`npm run format:check`、`npm run build` 通过；`npm test` 共 1,333 项，1,329 通过、0 失败、4 跳过。四项为 Linux 发布切换/备份/启动/验收故障场景，Windows 按既有平台条件跳过；PR 的 Linux `release` 作业负责执行。

```powershell
# 使用已配置且安装了 Docling 的 Python；本机示例
$env:DOCLING_PYTHON='C:/Users/w/Desktop/PJ/AI-SDR-docling/.venv/Scripts/python.exe'
npm run format:check
npm test
npm run build
node scripts/verify-outreach-plan-controls.mjs
node scripts/verify-mailbox-coverage-browser.mjs
node scripts/verify-outreach-source-controls.mjs
node scripts/verify-customer-history.mjs
node scripts/verify-mail-browser.mjs
node scripts/verify-communication-tabs.mjs
node scripts/verify-category-preview.mjs
node scripts/benchmark-page-opens.mjs
```

以上七个浏览器脚本均在最终集成代码运行通过。计划/客户历史脚本输出步骤 JSON 和截图；默认在 `.codex-tmp`，也可分别通过 `OUTREACH_QA_OUTPUT`、`HISTORY_QA_OUTPUT` 指定目录。来源脚本验证旧/新安排标识、其他来源不变以及 SMTP 提交零；旧邮件脚本 13 段 PASS，沟通栏目在 1600×900、1397×773、541×773 通过，分类预览无 UI 异常。模拟“提交已开始”的自动测试会故意调用 SMTP 替身，不涉及真实邮件。

原始本机日志位于 `C:/Users/w/AppData/Local/Temp/ai-sdr-spec85/final-*.log`，产品及历史截图位于其中 `final-plans`、`final-history`。该临时目录不随仓库发布；GitHub 评审可使用上述命令重建，CI 日志以 PR 检查为准。

## 查询及性能

同夹具、相同请求，改动前 `4b3c8a7` 与最终功能 `4500496` 顺序运行 `benchmark-page-opens.mjs`，41 个计划、1,203 条大字段发送记录。毫秒为单机首个请求/后续中位/最大，不作为生产 SLA。

| HTTP 读取      | 改前 ms       | 改后 ms       | 响应字节（前后相同） |
| -------------- | ------------- | ------------- | -------------------- |
| 当前计划       | 5 / 2 / 5     | 4 / 3 / 5     | 7,234                |
| 历史计划后续页 | 2 / 1 / 3     | 3 / 2 / 3     | 2,038                |
| 邮箱管理       | 1 / 1 / 2     | 1 / 1 / 2     | 734                  |
| 客户库对照     | 102 / 2 / 102 | 128 / 2 / 128 | 5,386                |

计划页面没有可重复的明显退化；1 ms 左右差异受整数计时与本机并行负载影响。客户冷读波动列作对照，未据此声称生产性能。T4 同库服务侧补测当前计划 4.176→2.068 ms、热读均 1.312 ms；历史后续页 1.072→1.005 ms。

新增读取单独验收：

- 25 项已删除、两页：服务侧首屏冷 1.329 / 热中位 1.143 ms，10,271 字节；名称+状态筛选第 2 页冷 1.309 / 热 1.453 / 最大 1.674 ms，5,329 字节，独立预期无漏项。
- 邮箱影响预览：41 计划、1,203×64 KB 发送记录，命中 21 项；最终浏览器同夹具冷 21.26 / 热 2.91 ms，2,605 字节。查询扫描计划摘要及产品数组，不扫描发送正文。
- 来源当前/历史/已删除查询：同量数据冷 1.74 / 0.73 / 1.62 ms、热 0.75 / 0.68 / 1.25 ms；待删除恢复只读部分索引 `outreach_pending_deletions` 中的待处理 ID。
- 同轮终态排除扩大到 400 计划、8,000×10 KB 记录，预期和实际均 20、漏项零，冷 0.135 / 热 0.053 ms，使用 `outreach_acquisition_round` 和 `outreach_sequence_contacts` 索引。

查询计划确认统计走 `outreach_counts` 覆盖索引，SQLite 侧筛选/计数/分页，列表不带批量正文；各读取在外部服务不可用的夹具中完成。前后样本与新视图分开记录，不能用删除后样本量下降证明原查询更快。

## 两路代码评审与缺陷修复

固定基线为 `93144d8`，首次评审 tip `94e3797`。单独评审规范和规格，再由独立工作树修复，集成到 `4500496`；两路限定复核均无剩余可行动问题。

### Standards

原发现两项：P1 旧自动来源排队草稿摘要变化导致正常发送受阻；P2 两条原浏览器脚本仍用空产品调用旧保存语义。前者旧实现两个旧摘要样本均 blocked；修后两个旧样本和新摘要各提交一次，真实身份变化反例提交零。只在旧公式精确匹配当前身份及覆盖时迁移，身份变化保护保留。后者修前分别在弹窗保存超时和 API 400；补正常显式产品及合法夹具后两脚本全程通过，保留原业务断言。复核独立重跑摘要四例 4/4 通过。

### Spec

原发现两项 P2：定时重新授权只成功写入一库时会提前发布新安排；旧页面人工恢复没有修订号，可覆盖较新删除暂停。修前故障分别出现 job=true/g1 而定时安排=false，以及旧恢复没有拒绝。修后持久化授权恢复记录，全部保存和清记录完成才通知触达；失败、重启及补偿失败继续保留安全状态，只回滚控制字段，保留当前企业收尾进度和较新决定。UI/HTTP/服务传页面 `sourceControlRevision`，旧值 409，同次成功恢复重试幂等。复核相关 63 项通过，额外重放两库故障、补偿再失败、进度保留及旧页面交错均通过。

集成专项另有 203 项通过、0 失败/跳过，最终全量结果见上。范围限定为本次差异及相连调用；未声称审计整个仓库或全部生产旧数据。
