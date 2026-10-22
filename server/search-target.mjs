import { markets, groupedMarkets } from './markets.mjs';
import { marketRegions } from './market-regions.mjs';
import acquisition from '../src/data/acquisition.json' with { type: 'json' };
import {
  MAX_SELECTED_PRODUCTS,
  MAX_SELECTED_PRODUCT_CHARACTERS,
  ALL_PRODUCTS_VALUE,
  environmentPreferenceLabels,
  isAllProductScope,
  validateProduct,
} from '../src/domain/acquisition-products.mjs';

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
export function locationOptions(country, region = '') {
  if (!markets.some((m) => m.value === country)) throw invalid('请选择支持的国家 / 市场');
  const regions = marketRegions[country] || [];
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
  if (input.product_scope !== undefined && !['all', 'specific'].includes(input.product_scope))
    throw invalid('请选择全部窗饰业务或指定产品');
  if (
    input.environment_preference !== undefined &&
    !Object.hasOwn(environmentPreferenceLabels, input.environment_preference)
  )
    throw invalid('室内室外偏好必须是均可、优先室内或优先室外');
  if (input.products !== undefined && !Array.isArray(input.products))
    throw invalid('产品必须为有效的产品列表');
  // A legacy empty product is still an invalid specific task, rather than an
  // instruction to silently broaden a previously configured search.
  if (
    input.product_scope === undefined &&
    input.product !== undefined &&
    (typeof input.product !== 'string' || !input.product.trim()) &&
    !input.products?.length
  )
    throw invalid('参数 product 不能为空且必须是字符串');
  const allProducts = isAllProductScope(input);
  if (allProducts) {
    if (input.products?.length)
      throw invalid('全部窗饰业务无需选择具体产品，请清空产品或切换为指定产品');
    result.product_scope = 'all';
    result.products = [];
  } else if (input.product_scope !== undefined) result.product_scope = 'specific';
  if (allProducts || input.environment_preference !== undefined)
    result.environment_preference = input.environment_preference ?? 'all';
  for (const key of ['country', 'product', 'region']) {
    const value =
      key === 'product' && allProducts
        ? ALL_PRODUCTS_VALUE
        : key === 'product' && Array.isArray(input.products) && input.products.length
          ? input.products.map((p) => p?.value).join(', ')
          : (input[key] ?? (key === 'region' ? '' : undefined));
    const maximum = key === 'product' ? MAX_SELECTED_PRODUCT_CHARACTERS : 500;
    if (typeof value !== 'string' || value.length > maximum)
      throw invalid(`参数 ${key} 必须是字符串且不能超过 ${maximum} 字符`);
    result[key] = value.trim();
    if (['country', 'product'].includes(key) && !result[key]) throw invalid(`参数 ${key} 不能为空`);
  }
  locationOptions(result.country, result.region);
  if (input.products !== undefined && !allProducts) {
    if (
      !Array.isArray(input.products) ||
      input.products.length < 1 ||
      input.products.length > MAX_SELECTED_PRODUCTS
    )
      throw invalid(`每次请选择1–${MAX_SELECTED_PRODUCTS}个产品`);
    result.products = input.products.map(validateProduct);
    if (new Set(result.products.map((p) => p.value.toLowerCase())).size !== result.products.length)
      throw invalid('同一任务不能重复选择相同产品名称');
  }
  const customerType = input.customer_type ?? '';
  if (
    typeof customerType !== 'string' ||
    (customerType && !acquisition.customerTypes.some((t) => t.value === customerType))
  )
    throw invalid('请选择有效的客户类型');
  const profile = input.customer_profile ?? 'all';
  if (!acquisition.profiles.some((p) => p.value === profile)) throw invalid('请选择有效的客户画像');
  result.customer_type = customerType;
  result.customer_profile = profile;
  if (input.customer_types !== undefined) {
    if (
      !Array.isArray(input.customer_types) ||
      input.customer_types.length > acquisition.customerTypes.length ||
      input.customer_types.some(
        (value) => !acquisition.customerTypes.some((type) => type.value === value),
      )
    )
      throw invalid('请选择有效的客户类型');
    result.customer_types = [...new Set(input.customer_types)];
    // The plural field is authoritative; legacy singular/profile filters must not narrow the new form.
    result.customer_type = '';
    result.customer_profile = 'all';
  }
  if (input.preferred_requirements !== undefined) {
    if (
      typeof input.preferred_requirements !== 'string' ||
      input.preferred_requirements.length > 600
    )
      throw invalid('补充要求不能超过600字');
    result.preferred_requirements = input.preferred_requirements.trim();
  }
  if (input.required_requirements !== undefined) {
    if (
      !Array.isArray(input.required_requirements) ||
      input.required_requirements.length > 6 ||
      input.required_requirements.some((s) => typeof s !== 'string' || !s.trim() || s.length > 160)
    )
      throw invalid('必需条件最多6条，每条不超过160字');
    result.required_requirements = [...new Set(input.required_requirements.map((s) => s.trim()))];
  }
  if (input.query_mode !== undefined) {
    if (input.query_mode !== 'auto') throw invalid('新任务仅支持自动生成搜索词');
    result.query_mode = 'auto';
  } else if (allProducts) result.query_mode = 'auto';
  const channel = input.acquisition_channel ?? 'tavily_web';
  if (channel !== 'tavily_web') throw invalid('该获客渠道尚未接入，当前仅支持网页搜索');
  result.acquisition_channel = channel;
  const audience = input.audience ?? 'BC';
  if (!['B', 'C', 'BC'].includes(audience)) throw invalid('客群选项必须是 B、C 或 BC');
  result.audience = audience;
  result.market_countries = groupedMarkets[result.country] || [result.country];
  return result;
}
