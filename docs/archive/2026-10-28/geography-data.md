# 地区选择数据

> 历史归档：保留原日期与当时结论，不作为当前实施步骤。现行说明见 [文档导航](../../README.md)。

本地 server/data/geography.json 是 [Countries States Cities Database](https://github.com/dr5hn/countries-states-cities-database) 的派生子集，仅保留美国 50 州及华盛顿特区、澳大利亚 8 个州和领地，以及其中的去重城市 / 城镇名称。数据用于搜索范围选择，不能保证包含每个新设定居点。

来源版本：d345fcf530996528b598f17c827f15c5c246cd25。下载日期：2026-10-19。仅提取名称和代码、排除美国海外区域及军事邮政区、按英文排序。

该数据集按 [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 提供，本派生数据也按 ODbL 1.0 开放。许可全文保存于 server/data/GEOGRAPHY-LICENSE.txt。应用代码的许可不因该独立数据文件而改变。

数据在服务端读取。2026-10-20 起接口只返回所选国家的州 / 地区名称，不再返回城市列表；原始参考数据中的城市不再参与获客范围筛选，无需外部地理 API 密钥。

2026-10-22 起，[server/market-regions.mjs](../../../server/market-regions.mjs) 为选择器补充独立的市场地区资料：美国仍为原 50 州及华盛顿特区，澳大利亚仍为原 8 个州和领地，只增加中文 `label`；原英文 `name`、代码和排序保持不变。加拿大沿用已有的 13 个省／地区及中文显示名。界面展示“中文名 · 英文名”，请求、搜索词和已有计划继续使用英文值。

英国新增 12 个一级市场地区，依据 [ONS 2025 年 1 月 ITL 1 名称与代码](https://geoportal.statistics.gov.uk/datasets/a1c258da2f404f93ad43b98d04a3c726_0/explore)：英格兰 9 大区，加上苏格兰、威尔士和北爱尔兰，代码为 TLC 至 TLN。该分组用于市场搜索范围，采用统计地域层级；不代表英国各构成国具有相同的行政层级。为避免范围重叠，不把“英格兰整体”作为并列选项，也没有继续下钻到郡或城市。[ONS 国际地域说明](https://www.ons.gov.uk/methodology/geography/ukgeographies/eurostat)确认该 12 项构成及其与行政地域的关系。英国英文名称使用该 ONS 数据表原名，中文标签为应用的常用译名。核对日期为 2026-10-22，英国主来源按 [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)提供。
