// Keep the transport's field values intact. This module deliberately does not
// import Feishu mapping or assessment code: both use it for customer identity.
export const BUSINESS_SCHEMA_VERSION = 't2-t5-v1';

export const CUSTOMER_FIELD_ALIASES = Object.freeze({
  用户评级: '初评结果',
  相关产品: '企业经营产品',
  主营产品偏好: '主营产品概况',
  需求产品: '公开采购需求',
  服务客群: '企业服务客群',
});

const legacyName = (name) =>
  Object.keys(CUSTOMER_FIELD_ALIASES).find((key) => CUSTOMER_FIELD_ALIASES[key] === name) || name;

const text = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (typeof value === 'object') return value.text || value.link || value.name || '';
  return String(value);
};

const populated = (value) => text(value).trim() !== '';

export function fieldValue(fields = {}, name) {
  const oldName = legacyName(name);
  const currentName = CUSTOMER_FIELD_ALIASES[oldName] || oldName;
  return populated(fields[currentName]) ? fields[currentName] : fields[oldName];
}

// Existing research/merge routines use the established internal keys. Translate
// at this seam instead of teaching each routine every historical field name.
export function canonicalCustomerFields(fields = {}) {
  const result = { ...fields };
  for (const [oldName, currentName] of Object.entries(CUSTOMER_FIELD_ALIASES)) {
    if (Object.hasOwn(fields, oldName) || Object.hasOwn(fields, currentName))
      result[oldName] = fieldValue(fields, oldName);
    delete result[currentName];
  }
  return result;
}

export function resolveCustomerField(definitions = [], name) {
  const oldName = legacyName(name);
  const currentName = CUSTOMER_FIELD_ALIASES[oldName] || oldName;
  const names = new Set(definitions.map((field) => field.field_name));
  if (names.has(currentName)) return currentName;
  return names.has(oldName) ? oldName : undefined;
}

export function customerWebsite(recordOrFields = {}) {
  const fields = recordOrFields.fields || recordOrFields;
  const websiteText = (value) =>
    value && !Array.isArray(value) && typeof value === 'object'
      ? String(value.link || value.text || '').trim()
      : text(value).trim();
  return websiteText(fields['企业官网']) || websiteText(fields['来源链接']);
}

export function customerSource(recordOrFields = {}) {
  const fields = recordOrFields.fields || recordOrFields;
  return customerWebsite({ 来源链接: fields['来源链接'] });
}

// Legacy workflow builders serialize their helpers into a sandbox. Keep the
// alias implementation together when those builders embed research merging.
export const customerFieldHelpers =
  'const canonicalCustomerFields = (() => {\n' +
  'const CUSTOMER_FIELD_ALIASES = ' +
  JSON.stringify(CUSTOMER_FIELD_ALIASES) +
  ';\n' +
  'const legacyName = ' +
  legacyName.toString() +
  ';\n' +
  'const text = ' +
  text.toString() +
  ';\n' +
  'const populated = ' +
  populated.toString() +
  ';\n' +
  fieldValue.toString() +
  '\nreturn ' +
  canonicalCustomerFields.toString() +
  ';\n})();';

const directionNames = { finished: '成品', materials: '材料配件', samples: '样本展示' };
const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// These are summaries of a supplied current snapshot, never a purchase request
// or a substitute for its original evidence. Callers select the current rule.
export function assessmentSummaryFields(snapshot) {
  if (!snapshot) return {};
  const supplied = Array.isArray(snapshot.opportunities) ? snapshot.opportunities : [];
  const opportunities = supplied.length
    ? supplied
    : snapshot.direction && snapshot.product
      ? [{ direction: snapshot.direction, product: snapshot.product, status: snapshot.status }]
      : [];
  const summary = [];
  const seen = new Set();
  for (const opportunity of opportunities) {
    const direction = directionNames[opportunity.direction];
    const product = clean(opportunity.product);
    if (!direction || !product || opportunity.status === '暂不开发') continue;
    const key = opportunity.direction + ':' + product.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    summary.push(
      direction +
        ' · ' +
        product +
        (opportunity.status === '待核实' ? '（适配待核实，潜在供货机会）' : '（潜在供货机会）'),
    );
  }
  const missing = (Array.isArray(snapshot.missing) ? snapshot.missing : [])
    .map(clean)
    .filter(Boolean);
  const incompleteReason = clean(snapshot.incompleteReason);
  if (incompleteReason) missing.push('研究限制：' + incompleteReason);
  const potential = snapshot.supplyOpportunity;
  if (potential?.kind === 'potential_input') {
    const product = clean(potential.targetProduct);
    if (product)
      summary.push(
        '材料配件 · ' +
          product +
          (potential.procurementStatus === 'confirmed'
            ? '（采购需求已人工确认）'
            : '（相关成品经营支持的潜在关联，采购需求未确认）'),
      );
    if (potential.procurementStatus !== 'confirmed')
      missing.push(clean(potential.note) || '材料或配件采购方式、规格、数量与负责人待沟通');
  }
  return {
    主要供货机会: [...new Set(summary)].join('\n'),
    待确认事项: [...new Set(missing)].join('；'),
  };
}
