# 北美三品类真实获客小批验收

日期：2026-10-24，Asia/Shanghai。报告建立于北京时间 11:26；本版已纳入第三阶段首任务的重大质量失败，归档/隔离与最终账户终值待补。

**首轮未达到目标：三类各研究 3 家，共 0 新增、0 更新、7 待核实、2 国家不符排除。实际海关消耗 60 credits。** 下面保留失败路径，不把候选、更新或待核实计为新增，也不根据预期补写成功。真实执行由主任务负责，报告整理未自行调用付费 API、修改配置或发送邮件。

第二阶段受控在线复验新增 **Signature Window Coverings LLC 1 家**，已完成 T2/T12 及记录读回；这不是三个标准批任务全部通过。该企业初评为 75 分/待补全，贸易关联仍为 name_only，详见第 6 节。

**第三阶段标准 API-v2 把 ImportKey 第三方贸易页误当企业官网并写入飞书。该系统“inserted=1”不算合格新增；已停止扩量，当前全自动验收明确不通过。** 误写记录的归档/隔离及修复证据另列第 7 节，不因系统达到数量目标而淡化质量失败。

## 1. 范围与通过口径

初始计划为加拿大面料、美国组件/叶片、美国 plantation shutters 各新增 1 家，每任务最多 20 条货运记录、3 次企业研究尝试。随后用户明确授权本次验收**累计海关额度上限 500 credits**；这是硬上限，不是消费目标，不追溯改写首轮结果。未授权采购额度、替换账户或触达客户。[授权记录](D:/CodeX/ai获客/.data/live-acquisition-pilot-20261024/authorization.json)

仅把运行前基线之外、通过既有官网/主体/准入流程、取得飞书新增记录编号且按编号与官网域名读回一致的企业计为“新增”。同一家企业跨品类不计多家；更新、重复、待核实及不确定写入均不算新增。[系统计数与读回](D:/CodeX/ai获客/server/batch-jobs.mjs:211)

初评分是业务匹配，不是采购意向；海关证据独立保留，不增加 P/R/D/V 初评分。商品行、供应商记录 ID、非空 B/L 和真实订单不是同一口径，不把返回行数写成采购次数。[评分边界](D:/CodeX/ai获客/server/customer-assessment.mjs:133)

## 2. 运行前基线

| 核查项          | 实测                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------ |
| 执行引擎/提供方 | native / direct；网页 Tavily、研究 DeepSeek、海关 BillOfLadingData                         |
| 模型            | deepseek-flash 实际可用；当前代码 reasoning.effort=none                                    |
| 原有客户        | 飞书原始 10 条、映射 10 家，已保存记录编号与官网快照                                       |
| 本机任务/缓存   | 无 running/stopping/paused 任务；6 个历史任务已结束；本轮配置的 customs_pages/cursors 为空 |
| 海关账户        | API Sandbox 总 1,000、已用 0、剩余 1,000；shipping views 0、company profile views 0        |
| Tavily          | account usage 320/1,000，search 192、extract 128                                           |
| DeepSeek        | CNY 可用余额 10.13                                                                         |

基线时间北京时间 **11:28:14.710**；见 [baseline.json](D:/CodeX/ai获客/.data/live-acquisition-pilot-20261024/baseline.json)。海关基线来自已登录官方 Current Plan 页面只读观察，见 [customs-baseline.json](D:/CodeX/ai获客/.data/live-acquisition-pilot-20261024/customs-baseline.json)。这是本轮已配置账户的实测起点，不把早期调研账户余额套到这里；本机无并行任务也不能排除账户的其他客户端消耗。

## 3. 首轮执行台账

所有请求为美国披露源、观察窗口 **2025-10-24—2026-10-24**，每类读取 page 1 / size 20；不以来源市场代替买家实际经营国。商品词取并集，没有强制叠加 HS。

| 类别/任务                                           | 北京时间          | 实际产品词包                                                                                                | 返回及过滤                            | 最终状态                 |
| --------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------ |
| 加拿大面料；903f1bfe-3c02-43c8-8447-7b40c40cb6c3    | 11:28:45–11:29:54 | sunscreen / roller blind / blackout blind / zebra blind / honeycomb blind fabric                            | 20 条；无关描述 4、物流 8             | partial / research_limit |
| 美国组件；7f87fa16-63ae-4d35-8393-3e4cc1e4f5d4      | 11:30:21–11:31:52 | blind components；roller blind/shade clutch；basswood slat；fauxwood blinds components；venetian blind slat | 20 条；无关描述 0、物流 2、匿名买方 1 | partial / research_limit |
| 美国 shutters；60cb7505-8350-4d83-afc1-9bce47494af8 | 11:32:07–11:33:08 | plantation shutter；wood shutter；PVC shutter；basswood shutter                                             | 20 条；无关描述 5、物流 3             | partial / research_limit |

| 类别                | 目标新增 | 读回确认新增 | 更新 | 待核实 | 国家不符排除 | 失败 | 研究尝试/模型请求 |
| ------------------- | -------: | -----------: | ---: | -----: | -----------: | ---: | ----------------- |
| 面料                |        1 |            0 |    0 |      1 |            2 |    0 | 3 / 2             |
| 组件/叶片           |        1 |            0 |    0 |      3 |            0 |    0 | 3 / 2             |
| Plantation shutters |        1 |            0 |    0 |      3 |            0 |    0 | 3 / 2             |
| 合计                |        3 |            0 |    0 |      7 |            2 |    0 | 9 / 6             |

证据：[11:33:18 首轮完整快照](D:/CodeX/ai获客/.data/live-acquisition-pilot-20261024/observe-1792812803411-25b14987-c7c7-416f-81bf-9d231b5c5b47.json)。以上均不是“找不到买家”的总体判断：每类只研究了三个排在前面的候选，剩余候选没有被同等核实。

## 4. 真实处理路径与问题

| 类别/货运名称                      | 系统定位官网/页面     | 实际结果                                                           |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------ |
| 面料 CUSTOM BRANDS GROUP           | custombrandsgroup.com | 官网识别美国主体，与 Canada 目标不符；贸易关联仅 name_only，未写入 |
| 面料 SENBESTA                      | senbesta.com          | 美国主体，与 Canada 目标不符；未写入                               |
| 面料 HECNY TRANSPORTATION INC.     | safer.fmcsa.dot.gov   | 运输监管查询页，不是企业独立官网；预筛转待核实，未请求模型         |
| 组件 SUN TRACK EXPRESS, INC.       | freightglobal.com     | 未取得目标品类依据；预筛转待核实，未请求模型                       |
| 组件 ZMC WINDOW COVERING           | zblinds.com           | 贸易名称与官网经营者冲突；待核实、未写入                           |
| 组件 TETAKAWI BLINDS TO GO         | blindstogo.com        | 未建立贸易主体与网站经营者关系；冲突、未写入                       |
| Shutters THE GSI GROUP             | blindster.com         | 主体名称冲突；未写入                                               |
| Shutters HECNY TRANSPORTATION INC. | safer.fmcsa.dot.gov   | 再次进入运输监管页；预筛转待核实，未请求模型                       |
| Shutters BELLA LIFESTYLE LLC       | americanblinds.com    | 主体名称冲突；未写入                                               |

首轮暴露的主要问题是**物流主体漏过滤、搜索首结果被当作候选官网、品牌与法人关联不足，以及加拿大任务的候选排序**，不能一概归咎于模型。国家不符及身份冲突被后续检查挡住，未产生错误新增；但这些候选仍耗尽了小批研究上限。这些首轮任务完成前未修代码，不把后续人工定位的官网补写成当时自动成功。

独立官网复核确认 zblinds.com 自称 **Z Blinds Co.**，地址 680 P Street Suite B, Fresno, California，并非凭名称即可关联 ZMC 的同一主体；相关买家不可计为已核实 ZMC 新增。[Z Blinds 官方联系页](https://www.zblinds.com/contact/) 正确网站或品牌关系即使后来找到，仍需以原始贸易地址等第二身份依据核实，不手工替换链接后直接宣称达标。

本轮没有新增企业，所以没有可交接的新记录编号、已确认新买家的初评或采购联系人清单。保留下来的相关货运、官网研究和候选不能包装成销售成果。美国披露/港口不等于经营国，B/L 不等于订单；名称相似和集团关系也不自动构成同一采购主体。[贸易主体规则](D:/CodeX/ai获客/server/shipment-evidence.mjs:17)

## 5. 成本：账户实测、App 估算和 token 分开

| 项目                 | 运行前                             | 11:33:18 观察值    | 已确认期间变化                | 限制                                                 |
| -------------------- | ---------------------------------- | ------------------ | ----------------------------- | ---------------------------------------------------- |
| 海关 data credits    | 已用 0 / 剩余 1,000                | 已用 60 / 剩余 940 | +60，shipping_record_views=60 | 由官方 credit-usage 读回，不是美元金额               |
| App 海关估算         | 0                                  | 三任务各 20，共 60 | 与账户增量一致                | 应用按返回记录计算；各页缓存命中 0                   |
| Tavily account usage | 320/1,000；search 192、extract 128 | 仍 320；192 / 128  | 该时点未显示增量              | 不能称本轮搜索免费；计量延迟或账户对应情况需继续核对 |
| DeepSeek CNY 余额    | 10.13                              | 10.09              | 余额减少 0.04 元              | 为期间余额差，不逐任务摊账，也不由 token 反推费用    |

中间账户读回依次为已用 20 / 剩余 980、40 / 960，再到 60 / 940。没有打开付费公司档案；company profile views 仍为 0。完整最终余额待后续任务结束后再次核对。

| 类别                | 模型请求 | 缓存命中 | input / output tokens | 正文字符 | 截断/省略页 |
| ------------------- | -------: | -------: | --------------------- | -------: | ----------- |
| 面料                |        2 |        0 | 26,416 / 4,473        |   61,878 | 1 / 0       |
| 组件/叶片           |        2 |        0 | 27,236 / 4,456        |   67,921 | 1 / 0       |
| Plantation shutters |        2 |        0 | 25,777 / 2,847        |   66,871 | 2 / 0       |
| 合计                |        6 |        0 | 79,429 / 11,776       |  196,670 | 4 / 0       |

三条规则预筛没有请求模型。“研究尝试”不等于模型生成；模型请求尝试也不保证已计费；字符不等于 token。今后缓存命中不重复计入历史 token，未知 token 不补零。[调用统计实现](D:/CodeX/ai获客/server/native-acquisition.mjs:543)

## 6. 第二阶段：缓存页在线复验，非标准批任务

修复部分物流漏排和官网身份预筛后，主任务通过脚本固定读取原来已付费的三张 first-page 缓存，硬性阻止新的 `/shipping-records` 网络请求；继续真实调用官网搜索、页面读取、模型和飞书，走同一 `NativeAcquisition.discoverShipments → research`。每类研究上限为 **5 个候选，遇到 1 个真实新增即停止**。这是受控缓存页在线复验，**不是标准 API BatchJobs 的全自动验收通过**；研究上限也与首轮每类 3 次不同，不作同条件随机 A/B。

| 类别                   | 北京时间          | 实际研究/模型请求 | 新增 | 主要结果                                                                               |
| ---------------------- | ----------------- | ----------------- | ---: | -------------------------------------------------------------------------------------- |
| 面料 Canada            | 11:37:40–11:39:00 | 3 / 3             |    0 | CBG、Senbesta 仍为美国主体；MAXXMAR 被定位到经销商 Blind Infusion，其身份冲突被挡住    |
| 组件 United States     | 11:39:21–11:40:41 | 3 / 1             |    1 | Sun Track 进入 MapQuest、Flexport 进入 Trustpilot，均预筛未调模型；Signature 真正新增  |
| Shutters United States | 11:40:54–11:41:46 | 3 / 0             |    0 | Longsail→ImportInfo、Infinity→物流站、MSF International→无国界医生页面，均预筛转待核实 |

证据：[面料复验](D:/CodeX/ai获客/.data/live-acquisition-pilot-20261024/replay-fabrics-ca-d0816727-fb47-42ca-bed9-1efce79fa6b9.json)、[组件复验](D:/CodeX/ai获客/.data/live-acquisition-pilot-20261024/replay-components-us-2176959a-1d85-4a2e-a105-580b76cae688.json)、[shutters 复验](D:/CodeX/ai获客/.data/live-acquisition-pilot-20261024/replay-shutters-us-19f2bf2b-05d1-45a5-9cc3-0a3b82b7cf42.json)。修复后仍有第三方资料站、物流主体和同名异业机构进入候选，不能包装成定位质量已经达标。

### Signature 的真实新增与限制

- 官网：[Signature Window Coverings](https://www.signaturewindowcoverings.com/)；实际经营主体 Signature Window Coverings LLC，美国 Phoenix，4022 W Turney Ave., Suite #5。公司级入口为 customerservice@signaturewc.com、+1 4804281218，不称采购负责人的私人联系方式。
- 飞书新增编号 **reczz28R6Q8EgpRo**；输出确认企业研究、T2 评级与 T12 历史均已完成并读回，企业总数由 10 到 11。
- 海关候选名称 SIGNATURE WINDOW COVERINGS；缓存中 2026-10-07、B/L **OERT175720P00576**，原文为 `2" LP CORDLESS FAUXWOOD BLINDS VERTICAL BLINDS COMPONENTS HS CODE: 39253000`，本次可观察为 1 条记录/1 个非空 B/L，不称 1 次订单。
- 贸易关联为 **name_only**：名称吻合，但原票缺少买方地址等第二身份依据。已核实的是官网企业，不是已经完成逐票归属核实的进口主体。
- 初评 **已支持 75 分、grade=null、status=待补全、complete=false**。持续经营 D 维度资料不足；本次模型形成的最高评分机会是**成品 roller shades**，不能把来源为组件记录说成“组件机会已完整获得 75 分/A 类”。该企业的组件供货适配仍需补证。

另用独立研究操作再次请求同一域名，返回 `no_new_candidates`：模型 0、搜索 0、业务远端写入 0；记录数 **11→11**，全记录 fields 不变。验证了真实官网域名去重，而不是仅重复读取同一个幂等操作结果。[Signature 去重复验](D:/CodeX/ai获客/.data/live-acquisition-pilot-20261024/dedupe-signature-b112c822-55ff-4178-bb71-a1e48beece3c.json)

### 第二阶段消耗

三类海关均 `cache_hits=1 / charged_records=0 / credits=0`，官方累计仍为 **已用 60、剩余 940**，本阶段没有新增海关扣费。第二阶段共 4 次真实模型请求，input/output 为 **42,928 / 9,127 tokens**；shutters 三次均规则预筛，模型请求为 0，不把采集页截断次数当成模型生成次数。

shutters 复验开始逐请求记录 Tavily `include_usage`：8 次搜索各返回 1 credit，4 次提取合计返回 1 credit，**该段返回 usage 合计 9 credits**；账户总计量当时仍显示 320，故不能称全轮搜索免费，也不能把 9 当成本轮所有搜索的总费用。其他阶段未记录逐请求 usage 的部分继续保留未知。

随后为定位问题做了两次真实短查询，每次 Tavily basic search 返回 1 credit，共 **2 credits**，找回 Tribute、ZMC 的品牌官网。这个探测不是新增获客或模型请求，也不是免费搜索；它不新增海关消耗。上述两个已完整记录的分段共 11 credits，仍不是全轮搜索/提取总数。[短查询证据](D:/CodeX/ai获客/.data/live-acquisition-pilot-20261024/short-query-probe-52963bb7-b3be-49a7-b9c8-01beed69abf5.json)

截至该阶段 DeepSeek CNY 可用余额为 **9.97**，相对运行前 10.13 的期间净变化为 **0.16 元**；这不是最终值或按类别分摊的账单。第一、二阶段合计 10 次模型请求，已记录 input/output **122,357 / 20,903 tokens**。

## 7. 第三阶段：标准 API-v2 发生第三方来源误入库

第二次小修去掉泛行业查询词、提高独立品牌域名优先级、增加聚合资料域名过滤，并持久化真实搜索 usage 后，主任务启动标准 API-v2 Canada 面料任务 **0edce56a-1f24-4b38-9643-9894fbcd87ec**，开始于北京时间 **11:50:24**。仍为 target 1 / 海关 budget 20 / 研究上限 3；是否实际使用 page 2 留待任务 query 快照核对。

系统返回 `completed / target_reached / inserted=1`，但新记录来源为 [ImportKey 贸易资料页](https://importkey.com/i/2557697-ontario-corp-blind-and-shu)，不是企业独立官网；识别名称为 `2557697 ONTARIO CORP BLIND AND SHU`，误写飞书编号 **reczz28R6bOYYebh**。后置来源门槛未识别第三方贸易数据页面，形成**真实错误写入**，不只是待核实候选。

此条必须从合格新增成果中排除。主任务已停止后续扩量，将仅对本次自行新增的错误记录归档并隔离/作废，不能删除或改写原有 10 家与 Signature。具体归档路径、修复与最终读回尚待执行证据，本版不声称已处理完成。

该失败任务消耗仍应保留：货运返回 20 条、网页请求 10 次且返回 usage 合计 **10 credits**、模型请求 1 次（input **5,999** / output **835 tokens**）。不因客户记录作废而把请求从本轮成本中扣掉。新增海关扣费以随后官方计量为准；不能只由应用返回条数写成账户终值。

这暴露了**仅在候选选择中补少数域名黑名单不足以保证来源真实，正式研究入口也需要统一来源检查**。修复由主任务执行；修复后的离线测试与质量验收结果分开记录，不用测试通过替代真实获客通过。

## 8. 后续与最终判定

**首轮验收未通过“每类 1 家新增”的目标，但预算、真实额度计量、错误身份拦截和留痕已有实证。** 这不是全自动获客效果已经达标，也不是发现路线无效：首轮主要失败发生在候选筛选与身份定位阶段。

第二阶段验证了一家官网企业的真实新增、T2/T12 留痕和独立域名去重；仍没有实现三个类别各一家的完整验收目标，也没有把其余待核实关系升级成确定买家。独立研究找到的 Tribute、Coulisse 等候选不算新增；Signature 仅按第 6 节的真实结果及限制计数。

第三阶段首个标准任务发生错误新增后，后续组件与 shutters 标准任务不继续扩量。当前合格新增只保留第二阶段 Signature 1 家及其明确限制；ImportKey 误写不计成功。由于修复和读取数据页同时发生变化，不把各阶段差异当作同样本随机 A/B，也不单独归因为换模型。

当前全自动验收不通过；最终归档/隔离状态、统一来源 gate 回归及累计账户终值待补。未发信、不采购或换账户；本次没有回复/成交实验，不推断转化率、长期获客成本或规模稳定性。
