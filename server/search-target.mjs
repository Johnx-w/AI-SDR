import geography from './data/geography.json' with { type: 'json' };

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
export function locationOptions(country, region = '') {
  const regions = geography[country];
  if (!regions) throw invalid('当前支持美国与澳大利亚');
  const selected = regions.find((item) => item.name === region);
  if (region && !selected) throw invalid('请选择该国家有效的州 / 地区');
  return {
    country,
    region,
    regions: regions.map(({ name, code }) => ({ name, code })),
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
  return result;
}
