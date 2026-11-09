// Keep the transport's field values intact. This module deliberately does not
// import Feishu mapping or assessment code: both use it for customer identity.
import { groupCustomerProducts } from './product-format.mjs';
export const BUSINESS_SCHEMA_VERSION = 't2-t5-v1';

export const CUSTOMER_FIELD_ALIASES = Object.freeze({
  用户评级: '初评结果',
  相关产品: '企业经营产品',
  主营产品偏好: '主营产品概况',
  需求产品: '公开采购需求',
  服务客群: '企业服务客群',
});

export const CUSTOMER_TABLE_FIELD_ALIASES = Object.freeze({
  国家: ['国家/地区'],
  '州 / 城市': ['城市/区域'],
  企业官网: ['官网链接'],
  初评结果: ['最新客户评级'],
  客户行业画像: ['客户画像摘要'],
});

const semanticName = (name) =>
  CUSTOMER_FIELD_ALIASES[name] ||
  Object.keys(CUSTOMER_TABLE_FIELD_ALIASES).find((key) =>
    CUSTOMER_TABLE_FIELD_ALIASES[key].includes(name),
  ) ||
  name;

const legacyName = (name) => {
  const current = semanticName(name);
  return (
    Object.keys(CUSTOMER_FIELD_ALIASES).find((key) => CUSTOMER_FIELD_ALIASES[key] === current) ||
    current
  );
};

const customerFieldNames = (name) => {
  const oldName = legacyName(name);
  const currentName = CUSTOMER_FIELD_ALIASES[oldName] || oldName;
  return [...new Set([currentName, oldName, ...(CUSTOMER_TABLE_FIELD_ALIASES[currentName] || [])])];
};

const legacyTextValue = (value) =>
  value == null ||
  typeof value === 'string' ||
  (Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item.text === 'string' &&
        !['record_id', 'record_ids', 'link_record_ids', 'table_id'].some((key) => key in item),
    ));

const customerFieldValue = (fields, name) =>
  name === '主营产品偏好' && !legacyTextValue(fields[name]) ? undefined : fields[name];

const text = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (typeof value === 'object') return value.text || value.link || value.name || '';
  return String(value);
};

const populated = (value) => text(value).trim() !== '';

export function fieldValue(fields = {}, name) {
  const oldName = legacyName(name);
  const preferred = customerFieldNames(name).find((key) =>
    populated(customerFieldValue(fields, key)),
  );
  return preferred ? customerFieldValue(fields, preferred) : customerFieldValue(fields, oldName);
}

// Existing research/merge routines use the established internal keys. Translate
// at this seam instead of teaching each routine every historical field name.
export function canonicalCustomerFields(fields = {}) {
  const result = { ...fields };
  for (const [oldName, currentName] of Object.entries(CUSTOMER_FIELD_ALIASES)) {
    if (oldName === '主营产品偏好' && !legacyTextValue(fields[oldName])) continue;
    if (Object.hasOwn(fields, oldName) || Object.hasOwn(fields, currentName))
      result[oldName] = fieldValue(fields, oldName);
    delete result[currentName];
  }
  for (const [currentName, alternatives] of Object.entries(CUSTOMER_TABLE_FIELD_ALIASES)) {
    if (!alternatives.some((name) => Object.hasOwn(fields, name))) continue;
    result[legacyName(currentName)] = fieldValue(fields, currentName);
    for (const name of alternatives) delete result[name];
  }
  return result;
}

export function resolveCustomerField(definitions = [], name) {
  return customerFieldNames(name).find((key) =>
    definitions.some(
      (field) => field.field_name === key && !(key === '主营产品偏好' && field.type === 18),
    ),
  );
}

export function customerProfileSummary(value) {
  const summaries = text(value)
    .split(/(?:^|\r?\n)\s*来源[：:][^\r\n]*(?:\r?\n|$)/u)
    .map((block) => block.split(/(?:^|\r?\n)\s*依据[：:]/u)[0].trim())
    .filter(Boolean);
  return (summaries.at(-1) || '')
    .replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/gu, '$1')
    .replace(/https?:\/\/[^\s<>）)]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export const customerOpportunitySummary = (value) => text(value).replace(/（潜在供货机会）/gu, '');

export function encodeCustomerFields(fields, definitions = []) {
  const byName = new Map(definitions.map((field) => [field.field_name, field]));
  const originalTable = byName.get('客户ID')?.type === 1005 && byName.has('官网链接');
  const encoded = {};
  const labels = (value) => {
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((item) => typeof item === 'string'))
      throw new Error('客户类型多选值必须为文本标签');
    return [
      ...new Set(
        values
          .flatMap((item) => item.split(/[、,，;；\r\n]+/u))
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
  };
  for (const [inputName, rawValue] of Object.entries(fields)) {
    let value = rawValue;
    const exact = byName.get(inputName);
    if (
      inputName === '主营产品偏好' &&
      exact?.type === 18 &&
      Array.isArray(value) &&
      (!value.length || !legacyTextValue(value))
    ) {
      encoded[inputName] = value;
      continue;
    }
    const name = resolveCustomerField(definitions, inputName) || inputName;
    const definition = byName.get(name);
    if (originalTable) {
      if (
        !definition &&
        ['customer_id', '来源链接', '需求产品', '公开采购需求'].includes(inputName)
      )
        continue;
      if (value != null && name === '客户画像摘要') value = customerProfileSummary(value);
      if (value != null && name === '主要供货机会') value = customerOpportunitySummary(value);
      if (value != null && name === '企业经营产品') value = groupCustomerProducts(text(value));
    }
    if (name === '主营产品偏好' && definition?.type === 18 && legacyTextValue(value))
      throw new Error('主营产品概况文本不能写入主营产品偏好关联字段');
    if (value == null) {
      encoded[name] = value;
    } else if (semanticName(name) === '客户类型' && definition?.type === 4) {
      encoded[name] = labels(value);
    } else if (value === '') {
      encoded[name] = value;
    } else if (
      semanticName(name) === '客户类型' &&
      definition?.type === 1 &&
      Array.isArray(value)
    ) {
      encoded[name] = labels(value).join('、');
    } else if (
      definition?.type === 1 &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value.link || value.url)
    ) {
      const link = value.link || value.url;
      if (typeof link !== 'string') throw new Error('客户超链接字段格式不兼容：' + name);
      encoded[name] = link;
    } else if (definition?.type === 15) {
      const link = typeof value === 'string' ? value : value.link || value.url;
      if (typeof link !== 'string') throw new Error('客户超链接字段格式不兼容：' + name);
      encoded[name] = { text: typeof value === 'string' ? value : value.text || link, link };
    } else {
      encoded[name] = value;
    }
  }
  return encoded;
}

export function customerWebsite(recordOrFields = {}) {
  const fields = recordOrFields.fields || recordOrFields;
  const websiteText = (value) =>
    value && !Array.isArray(value) && typeof value === 'object'
      ? String(value.link || value.text || '').trim()
      : text(value).trim();
  return websiteText(fieldValue(fields, '企业官网')) || websiteText(fields['来源链接']);
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
  'const CUSTOMER_TABLE_FIELD_ALIASES = ' +
  JSON.stringify(CUSTOMER_TABLE_FIELD_ALIASES) +
  ';\nconst semanticName = ' +
  semanticName.toString() +
  ';\n' +
  'const legacyName = ' +
  legacyName.toString() +
  ';\nconst customerFieldNames = ' +
  customerFieldNames.toString() +
  ';\nconst legacyTextValue = ' +
  legacyTextValue.toString() +
  ';\nconst customerFieldValue = ' +
  customerFieldValue.toString() +
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
      ? [snapshot]
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
  const pending = opportunities.flatMap((opportunity) => [
    ...Object.values(opportunity.dimensions || {})
      .filter((dimension) => dimension.conflict)
      .map((dimension) => clean(dimension.missing) || '同一供货机会的依据相互冲突'),
    ...(opportunity.requirements || [])
      .filter((fact) => ['identity_conflict', 'mandatory_requirement'].includes(fact.kind))
      .map((fact) =>
        fact.kind === 'identity_conflict' ? '经营主体依据相互冲突' : '强制供货条件需核实',
      ),
  ]);
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
  }
  return {
    主要供货机会: [...new Set(summary)].join('\n'),
    待确认事项: [...new Set(pending)].join('；'),
  };
}
