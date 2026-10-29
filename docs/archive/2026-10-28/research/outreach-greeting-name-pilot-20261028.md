# 开发信称呼：7 个客户官网抽样

> 历史归档：保留原日期与当时结论，不作为当前实施步骤。现行说明见 [文档导航](../../../README.md)。

核查日期：2026-10-28（北京时间）。结论：本次未能为现有收件邮箱可靠确定一名负责人（0/7）；另有 1/7 官网可以通过按州查询找到具名销售代表及个人邮箱。因此，现阶段统一使用公司名，例如 `Hello Hestia Blinds Team,`，不在每次自动发送前增加找人流程。

这不是“所有官网都没有联系人”的结论。姓名能否找到、姓名是否对应本次收件人，是两个不同问题；下文分别计数。

## 抽样和判定方法

- 客户库快照共 45 条记录，按官网去重并排除非企业官网后有 44 个；其中 A 评级 4 个、B 评级 7 个、C 评级 30 个、待核实 3 个。
- 优先 A 评级：4 个 A 全部纳入，再从 B 评级中随机、无放回抽取 3 个。7 个样本的库内 `contact` 字段均为空。固定抽样记录保存于 `.codex-tmp/greeting-research-sample-2026-10-28.json`。
- 每站检查官网主页及联系、关于我们、相关代表入口等通常 3–5 个页面。先用限域检索找入口，再读取原文；不把搜索摘要本身、第三方人物资料或邮箱前缀猜测作为证据。
- **成功类型 1**：官网明确把某个人与库内实际收件邮箱绑定。**成功类型 2**：官网明确列出相关销售、采购等业务联系人及其个人邮箱，可以作为另外一个具名收件对象；它不自动绑定原通用邮箱。
- 仅出现 Owner、CEO、创始人、公司历史、评价中的姓名，不足以证明其负责本次收件邮箱。未查看的动态结果、旧链接失效或检索不到，也不等同于网站绝无联系人。

## 逐站结果

| 客户及评级                                        | 主要官网检查入口                                                                                                                                                                                                                     | 发现与邮箱关系                                                                                                                                                                                                       | 可用于现有收件邮箱的人名                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Hestia Blinds · A                                 | [主页](https://hestiablinds.com/)、[About Us](https://hestiablinds.com/pages/about-us)、[Our Story](https://hestiablinds.com/pages/our-story)、[Contact Us](https://hestiablinds.com/pages/contact-us)                               | 关于页面讲产品与品牌理念；联系页面提供 `service@hestiablinds.com`、电话、地址及表单，没有在这些内容中标明个人负责人。                                                                                                | 未确认；公司名。                                 |
| Blindsgalore · A                                  | [主页](https://www.blindsgalore.com/)、[Meet Us](https://www.blindsgalore.com/meet-us)、[Contact Us](https://www.blindsgalore.com/help-center/contact-us)                                                                            | Meet Us 明确列出 Chelle Walters（Owner）与 Alissa Walters（CEO）；联系页为客服团队及 `customercare@blindsgalore.com`。没有把两位领导与该邮箱绑定，也未在本次读取内容中给出她们的个人邮箱。库内邮箱原本为空。         | 未确认；领导姓名不能当作客服邮箱负责人。         |
| Fantastic Blinds & Shutters · A                   | [主页](https://fantasticblindsshutters.com.au/)、[About Us](https://fantasticblindsshutters.com.au/about-us/)、[Contact Us](https://fantasticblindsshutters.com.au/contact/)                                                         | 联系页为 `admin@fbsmel.com.au`、电话和表单；关于页面以管理层、销售团队整体表述。评价中提及 Jessica，但只是客户对服务的评价，未给完整姓名、正式职位或与 `admin`／库内 `info` 邮箱的对应关系；评价作者也不是员工名录。 | 未确认；公司名。                                 |
| The Shutter Store · A                             | [主页](https://www.theshutterstore.com/)、[About Us](https://www.theshutterstore.com/about-us/)、[Contact Us](https://www.theshutterstore.com/information/contact-us/)                                                               | 联系页提供客服团队、电话、在线聊天及邮件链接，库内为 `help@theshutterstore.com`；没有在检查内容中提供邮箱负责人的姓名。                                                                                              | 未确认；公司名。                                 |
| Hunter Douglas Architectural Window Coverings · B | [主页](https://www.hunterdouglasarchitectural.com/)、[Roller Shades](https://www.hunterdouglasarchitectural.com/windowcoverings/rollershades/index.jsp)、[Contact Us](https://www.hunterdouglasarchitectural.com/contacts/index.jsp) | 库内邮箱为空。联系页要求按州找 Window Coverings 代表。继续检查该页面实际使用的只读官网结果接口，能取得具名代表及个人邮箱，见下节；这是成功类型 2，不是现有邮箱负责人识别成功。                                       | 对原库记录仍未确认；另可按正确地区选择具名代表。 |
| Graber · B                                        | [主页](https://www.graberblinds.com/)、[Why Graber](https://www.graberblinds.com/why-graber/)、[Contact Us](https://www.graberblinds.com/customer-support/contact-us/)                                                               | 联系页按消费者服务、现有经销商、商业项目、国际业务列出 `windowfashions@…`、`dealerquestions@…`、`architectsolutions@…`、`international@…` 等部门邮箱，与库内地址相符，但没有给各邮箱的个人负责人。                   | 未确认；公司名。                                 |
| EcoSmart Shades · B                               | [主页](https://ecosmartshades.com/)、[About](https://ecosmartshades.com/about/)、[Contact](https://ecosmartshades.com/contact/)、[官网新闻](https://ecosmartshades.com/2023/02/18/now-featured-on-earth911)                          | About 介绍创始人 Gordon Clements 与接班女儿 Kelly；官网新闻称 Kelly 为公司总裁。联系页仍为 `Service@EcoSmartShades.com`、电话及表单，没有给 Kelly 的个人邮件或证明她负责 Service 邮箱。                              | 未确认；领导姓名不能当作 Service 邮箱负责人。    |

## 能找到具名业务联系人的例外

Hunter Douglas Architectural 的联系页按州选择代表。该页加载的第一方脚本使用 `GET /contacts/reps_results.jsp` 取得结果；这里只读查询了 California 和 Florida 两个州，没有提交联系表单或发送邮件。

| 地区与产品                    | 官网返回的业务联系人 | 官网个人邮箱                         | 第一方结果来源                                                                                                   |
| ----------------------------- | -------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| California · Window Coverings | Tim Birckbichler     | `tim.birckbichler@hunterdouglas.com` | [California 代表结果](https://www.hunterdouglasarchitectural.com/contacts/reps_results.jsp?stateId=6&salesCat=1) |
| Florida · Window Coverings    | Justine Foster       | `justine.foster@hunterdouglas.com`   | [Florida 代表结果](https://www.hunterdouglasarchitectural.com/contacts/reps_results.jsp?stateId=11&salesCat=1)   |

上述两个接口均正常返回，结果同时给出公司、姓名、邮箱、州和 Window Coverings 产品类别。因此属于明确的具名业务联系人；但不能据此推断这两人接收通用客服邮件，也不能随便选一个州代替本次业务地域。未遍历其全部地区。

## 数量与实施建议

- 成功类型 1（现有实际收件邮箱 → 负责人姓名）：**0/7 网站**。
- 成功类型 2（另外发现明确业务联系人 + 个人邮箱）：**1/7 网站**，在该站两个地区查询中得到两名代表。
- 可读官网中存在领导姓名、但没有收件邮箱关系的典型情况：**2/7 网站**（Blindsgalore、EcoSmart）；评价人名或被评价的名字也没有补足对应关系。
- 7 站的主要联系/关于入口均有可读取内容。个别旧关于链接返回了无效页面，因此不用于“没有名字”的判断；Hunter 的静态页面缺姓名也未被直接算作不可发现，而是继续检查了其真实地区查询结果。

按这次有明确边界的小样本，逐站寻找姓名需要额外页面或动态地区查询，普遍无法证明名字与实际收件邮箱对应。本轮执行用户的降级方案：**当前开发信统一按公司名打招呼**，例如 `Hello The Shutter Store Team,`。不要根据 `service`、`info`、`admin` 等邮箱猜名字，也不要把 About Us 里的 CEO 或创始人填进通用邮箱称呼。

简化发信生成器已将首行交给程序固定，LLM 只写后面的正文；兼容移除模型多写的普通 `Hello,`、`Hi there,`，不增加找人或逐封人工确认步骤。验证通过 81 项内容和发送服务测试，以及 Hestia、The Shutter Store、Graber 三次真实模型仅生成检查。

本次只研究并记录证据，未修改客户库或发信；7 站抽样不能推出整个客户库的精确姓名覆盖率，官网公开关系也可能后续变化。
