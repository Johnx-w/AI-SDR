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
    cities: selected?.cities || [],
  };
}

export function validateTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid('请提交有效的搜索参数');
  const result = {};
  for (const key of ['country', 'product', 'region', 'city']) {
    const value = input[key] ?? (['region', 'city'].includes(key) ? '' : undefined);
    if (typeof value !== 'string' || value.length > 500)
      throw invalid(`参数 ${key} 必须是字符串且不能超过 500 字符`);
    result[key] = value.trim();
    if (['country', 'product'].includes(key) && !result[key]) throw invalid(`参数 ${key} 不能为空`);
  }
  const locations = locationOptions(result.country, result.region);
  if (result.city && !result.region) throw invalid('选择城市前请先选择州 / 地区');
  if (result.city && !locations.cities.includes(result.city))
    throw invalid('请选择该州 / 地区的有效城市');
  if (
    !Array.isArray(input.customer_types) ||
    input.customer_types.length < 1 ||
    input.customer_types.length > 5 ||
    !input.customer_types.every((value) =>
      ['installer', 'distributor', 'retailer', 'contractor'].includes(value),
    )
  )
    throw invalid('请选择有效客户类型');
  result.customer_types = [...new Set(input.customer_types)];
  return result;
}
