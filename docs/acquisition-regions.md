# 自动获客的地区目录与核对记录

立即任务和到期计划使用同一搜索执行器。国家是任务范围，地区名是补搜时追加的关键词。统计口径是每个国家目录中的唯一搜索名称；省、州、地区和统计区采用下表所列层级。全国查询仍可返回目录以外地区的公司。

## 25 国目录

2026-11-26 从获客任务的 25 个国家入口取目录，按“国家代码 + 地区英文名”与独立下载的 Unicode CLDR 49 英文 XML 比对，解码 XML 字符实体后做精确匹配。546 项中有 496 项同国同名；其余 50 项逐国与下列专项来源对照。原始 XML 的 SHA-256 为 `637705773cb923d63bf71abaf05e6246fd853ef98f143bd9796b11d2c5ac10c0`。运行时使用项目已有的地区名称、校正表和静态名录。[CLDR 49 原始数据](https://github.com/unicode-org/cldr/blob/96e54b273d2da4ec6fbad350ba19ff23fa24a588/common/subdivisions/en.xml)

| 国家     | 纳入的搜索地区                                   |    数量 | CLDR 同国同名 |
| -------- | ------------------------------------------------ | ------: | ------------: |
| 美国     | 50 州和哥伦比亚特区                              |      51 |            50 |
| 澳大利亚 | 6 州和两个本土领地                               |       8 |             8 |
| 加拿大   | 10 省和 3 地区                                   |      13 |            13 |
| 英国     | ONS ITL 1：英格兰 9 区及苏格兰、威尔士、北爱尔兰 |      12 |             4 |
| 新加坡   | 社区发展理事会五区                               |       5 |             5 |
| 马来西亚 | 13 州及 3 联邦直辖区                             |      16 |            16 |
| 新西兰   | 16 个地区及单列的查塔姆群岛                      |      17 |            15 |
| 泰国     | 76 府及曼谷                                      |      77 |            77 |
| 越南     | 重组后的 28 省及 6 个直辖市                      |      34 |             5 |
| 阿联酋   | 酋长国                                           |       7 |             7 |
| 南非     | 省                                               |       9 |             9 |
| 加纳     | 现行大区                                         |      16 |            16 |
| 菲律宾   | 行政大区，含内格罗斯岛大区及邦萨摩洛自治区       |      18 |             8 |
| 波兰     | 省                                               |      16 |            16 |
| 荷兰     | 12 省                                            |      12 |            12 |
| 德国     | 联邦州                                           |      16 |            16 |
| 意大利   | 大区                                             |      20 |            20 |
| 比利时   | 布鲁塞尔首都区、弗拉芒大区、瓦隆大区             |       3 |             3 |
| 巴西     | 26 州及联邦区                                    |      27 |            27 |
| 智利     | 大区                                             |      16 |            16 |
| 阿根廷   | 23 省及布宜诺斯艾利斯自治市                      |      24 |            24 |
| 哥伦比亚 | 32 省及首都区                                    |      33 |            33 |
| 墨西哥   | 31 州及墨西哥城                                  |      32 |            32 |
| 韩国     | 广域级地区                                       |      17 |            17 |
| 日本     | 都道府县                                         |      47 |            47 |
| **合计** | **25 国**                                        | **546** |       **496** |

- 美国沿用 Census 的 District of Columbia。英国按 ONS 的 12 项逐项核对，8 项英格兰统计区名称与 CLDR 不同。[美国 Census](https://www.census.gov/library/reference/code-lists/ansi/ansi-codes-for-states.html) · [ONS ITL 1 名录](https://geoportal.statistics.gov.uk/datasets/a1c258da2f404f93ad43b98d04a3c726_0/explore)
- 新西兰按统计局所在地区校正 Marlborough 和 Manawatū-Whanganui，补入既有双语文件中缺失的 Nelson。查塔姆群岛单列。新加坡按五个 CDC 的名称复核。[Stats NZ 地区资料](https://datainfoplus.stats.govt.nz/Item/nz.govt.stats/9a6701e3-f1d3-4480-b879-5eea7716979b/101) · [新加坡 CDC](https://www.cdc.gov.sg/about-us/five-districts/)
- 越南以政府公布的 34 个省市英文名为准，采用英文文本中的不带声调拼写；菲律宾用统计局的 18 个大区，搜索词省略罗马序号和括号简称。[越南政府 34 省市名单](https://en.baochinhphu.vn/party-secretaries-of-23-newly-merged-cities-and-provinces-111250630182358086.htm) · [菲律宾统计局 PSGC](https://psa.gov.ph/classification/psgc/regions) · [菲律宾卫生部转载的逐项代码和名称](https://fhir.doh.gov.ph/phcore/en/ValueSet-regions.html)
- 按 GeoNames 的国家前缀和一级区划数量交叉检查了加纳、泰国、荷兰、比利时和意大利。既有地址词表另含加纳旧区 Brong-Ahafo、泰国城市 Pattaya、荷兰加勒比特别市，以及比利时和意大利的下属省。这些词仍可用于历史地址识别。[GeoNames 一级区划](https://download.geonames.org/export/dump/admin1CodesASCII.txt)

## 实际执行样本

公开搜索每条取前 10 个网页结果，按查询使用的国家、地区和产品核对企业网站。下表四家进入验收样本。另一次德国关键词试搜中，`Rollos` 返回了劳斯莱斯等无关结果；地区名称正确仍需要核实企业业务。

| 任务样本                             | 首个地区及企业                                                          | 第二个地区及企业                                                               | 本地结果                      |
| ------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| 马来西亚，立即执行，窗帘             | Johor · [HS Curtains](https://www.jbcurtains.com.my/)                   | Kedah · [Amanjaya Decor](https://www.amanjayadecor.com/)                       | 4 次查询，新增 2/2            |
| 新西兰，定时到期，卷帘               | Auckland · [mr blinds](https://mrblinds.co.nz/about-us/auckland-blinds) | Bay of Plenty · [Spencers Blinds](https://spencersblindsbop.co.nz/contact-us/) | 4 次查询，新增 2/2            |
| 新加坡，立即执行，仅返回库内同一官网 | 实际触发地区补搜                                                        | 后续查询仍返回该官网                                                           | 20 次查询，新增 0/2，部分完成 |

回归通过本地 HTTP 创建立即任务及定时计划，推进测试时钟到触发点，再从任务 API 和 SQLite 客户档案读回。全国查询回放已存在的官网以稳定触发补搜，地区查询回放对应样本。搜索和模型研究使用替身，任务执行、计划触发、域名去重、客户档案写入与读回使用项目实现。初始 1 家已有企业，结束后共 5 家。四家企业的“新增”仅指独立测试库。

`node --test tests/acquisition-regions.test.mjs tests/batch-api.test.mjs tests/batch-jobs.test.mjs` 可复核目录轮换、两个入口及重复对照。正式部署后，还需依据各国的实际搜索词、重复数、通过官网核验数及新增入库数评估连续多轮的达标率。
