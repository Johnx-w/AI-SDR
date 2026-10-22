import acquisition from '../data/acquisition.json' with { type: 'json' };

export const directionLabels = { finished: '成品', materials: '材料配件', samples: '样本展示' };
export const MAX_SELECTED_PRODUCTS = 40;
export const MAX_SELECTED_PRODUCT_CHARACTERS = 1000;
export const ALL_PRODUCTS_LABEL = '全部窗饰业务';
export const ALL_PRODUCTS_VALUE = 'window coverings';
export const environmentPreferenceLabels = {
  all: '室内室外均可',
  indoor: '优先室内',
  outdoor: '优先室外',
};
export const builtinProducts = acquisition.productGroups.flatMap((group) =>
  group.products.map(([value, label]) => ({
    id: value,
    value,
    label,
    direction: group.direction,
    group: group.name,
    selectAll: group.selectAll,
    aliases: [],
  })),
);

// Existing plans with concrete products retain their original scope. New callers
// may omit products entirely to use the broad company-wide acquisition default.
export function isAllProductScope(target = {}) {
  if (target.product_scope === 'all') return true;
  if (target.product_scope === 'specific') return false;
  return !target.products?.length && !String(target.product || '').trim();
}

// Snapshot plain product names, never complete search expressions. Plans keep their own copy.
export function validateProduct(value) {
  const invalid = (message) => Object.assign(new Error(message), { status: 400 });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid('请填写有效的产品资料');
  const text = (key, maximum, required = true) => {
    const result = value[key];
    if (
      typeof result !== 'string' ||
      result.trim().length > maximum ||
      (required && !result.trim())
    )
      throw invalid('产品名称、英文名或分类不完整或过长');
    return result.trim();
  };
  const name = text('value', 100);
  if (!/[a-z]{2}/i.test(name) || /[,\n\r"{}\[\]|]/.test(name))
    throw invalid('产品英文名请填写品类名称，不含逗号、引号或查询表达式');
  if (!Object.hasOwn(directionLabels, value.direction)) throw invalid('请选择产品供货方向');
  const aliases = value.aliases ?? [];
  if (
    !Array.isArray(aliases) ||
    aliases.length > 5 ||
    aliases.some(
      (s) => typeof s !== 'string' || !s.trim() || s.length > 100 || /[,\n\r"{}\[\]|]/.test(s),
    )
  )
    throw invalid('产品别名最多5个，每个不超过100字，不含查询表达式');
  return {
    value: name,
    label: text('label', 80),
    direction: value.direction,
    group: text('group', 60),
    aliases: [...new Set(aliases.map((s) => s.trim()))],
  };
}

export function productTerms(target) {
  if (isAllProductScope(target))
    return [
      'window coverings',
      'window furnishings',
      'curtain fabrics',
      'blind components',
      'semi finished blinds',
      ...builtinProducts
        .filter((product) => product.direction !== 'samples')
        .map((product) => product.value),
    ];
  if (target.products?.length)
    return [...new Set(target.products.flatMap((p) => [p.value, ...(p.aliases || [])]))];
  return String(target.product || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
