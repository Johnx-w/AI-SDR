# 地区选择数据

本地 server/data/geography.json 是 [Countries States Cities Database](https://github.com/dr5hn/countries-states-cities-database) 的派生子集，仅保留美国 50 州及华盛顿特区、澳大利亚 8 个州和领地，以及其中的去重城市 / 城镇名称。数据用于搜索范围选择，不能保证包含每个新设定居点。

来源版本：d345fcf530996528b598f17c827f15c5c246cd25。下载日期：2026-10-19。仅提取名称和代码、排除美国海外区域及军事邮政区、按英文排序。

该数据集按 [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) 提供，本派生数据也按 ODbL 1.0 开放。许可全文保存于 server/data/GEOGRAPHY-LICENSE.txt。应用代码的许可不因该独立数据文件而改变。

数据在服务端读取，只把所选国家的州名称及所选州的城市列表返回浏览器，无需外部地理 API 密钥。
