import geography from './data/geography.json' with { type: 'json' };
import { markets, groupedMarkets, canadaRegions } from './markets.mjs';

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
export function locationOptions(country, region = '') {
  if (!markets.some((m) => m.value === country)) throw invalid('请选择支持的国家 / 市场');
  const regions = country === 'Canada' ? canadaRegions : geography[country] || [];
  const selected = regions.find((item) => item.name === region);
  if (region && !selected) throw invalid('请选择该国家有效的州 / 地区');
  return {
    country,
    region,
    regions: regions.map(({ name, code, label }) => ({ name, code, ...(label ? { label } : {}) })),
    markets,
    countries: groupedMarkets[country] || [country],
  };
}

export function validateTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid('请提交有效的搜索参数');
  const result = {};
  for (const key of ['country', 'product', 'region']) {
    const value = input[key] ?? (key === 'region' ? '' : undefined);
    if (typeof value !== 'string' || value.length > 500)
      throw invalid(`参数 ${key} 必须是字符串且不能超过 500 字符`);
    result[key] = value.trim();
    if (['country', 'product'].includes(key) && !result[key]) throw invalid(`参数 ${key} 不能为空`);
  }
  locationOptions(result.country, result.region);
  // Legacy customer_types are deliberately ignored: classify the company after discovery.
  const channel = input.acquisition_channel ?? 'tavily_web';
  if (channel !== 'tavily_web') throw invalid('该获客渠道尚未接入，当前仅支持 Tavily 网页搜索');
  result.acquisition_channel = channel;
  const audience = input.audience ?? 'BC';
  if (!['B', 'C', 'BC'].includes(audience)) throw invalid('客群选项必须是 B、C 或 BC');
  result.audience = audience;
  result.market_countries = groupedMarkets[result.country] || [result.country];
  return result;
}
