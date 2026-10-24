const fieldAliases = {
  customer_types: 'customer_type',
  core_product: 'products',
  secondary_product: 'products',
  legal_name: 'legal_company_name',
};
const own = (values, key) => (Object.hasOwn(values, key) ? values[key] : undefined);
const categories = {
  company_name: '企业名称',
  legal_company_name: '经营法人',
  trading_names: '经营名称',
  entity_type: '主体类型',
  production_model: '生产模式',
  operating_model: '经营范围',
  manufactured_products: '制造产品',
  actual_country: '经营国家',
  customer_type: '客户类型',
  preference_evidence: '补充要求相关证据',
  audience: '服务客群',
  main_product_preference: '主营产品概况',
  industry_profile: '企业概况',
  demand_products: '公开采购需求',
  profile_tags: '业务特征',
  address: '企业地址',
  products: '经营产品',
  service_areas: '服务范围',
  adjacent_product: '邻近品类',
  unrelated_product: '不匹配依据',
  specialist_supply: '专业供货角色',
  general_supply: '综合供货角色',
  installation_only: '安装服务角色',
  no_supply_role: '供货角色限制',
  current_supply_process: '供货流程',
  custom_made: '定制特征',
  motorized_system: '电动与自动化',
  commercial_specification: '工程应用',
  company_since: '经营起始',
  company_years: '持续经营',
  operating_outlet: '经营网点',
  active_dealer: '经销网络',
  completed_project: '已交付项目',
  completed_commercial_project: '已交付商业项目',
  identity_conflict: '主体待核实',
  mandatory_requirement: '强制条件',
};
const originalFieldLabels = {
  core_product: '主营产品',
  secondary_product: '明确经营品类',
};
export function websiteEvidenceFieldLabel(field) {
  return (
    own(originalFieldLabels, field) ||
    own(categories, own(fieldAliases, field) || field) ||
    '其他官网事实'
  );
}
const enums = {
  entity_type: { business: '企业经营主体', individual: '个人主体', unknown: '主体类型待核实' },
  production_model: {
    own_factory: '自有工厂',
    no_own_factory: '无自有工厂',
    mixed: '自产与合作供货并存',
    unknown: '生产模式待核实',
  },
  operating_model: {
    local_only: '主要服务本地市场',
    beyond_local: '业务覆盖本地以外地区',
    unknown: '经营范围待核实',
  },
  customer_type: {
    supplier: '供应商',
    importer: '进口商',
    trader: '贸易商',
    brand: '品牌商',
    installer: '安装服务商',
    distributor: '批发／经销商',
    wholesaler: '批发商',
    retailer: '零售商',
    contractor: '工程承包商',
    manufacturer: '制造商',
    service_provider: '服务商',
    other: '其他经营角色',
    unknown: '客户类型待核实',
  },
  audience: {
    b: '企业客户',
    c: '个人客户',
    bc: '企业与个人客户',
    'b+c': '企业与个人客户',
    unknown: '服务客群待核实',
  },
  profile_tags: {
    service: '提供服务',
    trade: '具有贸易经营特征',
    manufacturing: '具有制造业务特征',
    project: '具有工程项目业务特征',
  },
  actual_country: {
    australia: '澳大利亚',
    'united states': '美国',
    usa: '美国',
    us: '美国',
    'united kingdom': '英国',
    uk: '英国',
    'hong kong': '中国香港',
    canada: '加拿大',
    'united arab emirates': '阿联酋',
    china: '中国',
    germany: '德国',
    france: '法国',
    netherlands: '荷兰',
    'new zealand': '新西兰',
    italy: '意大利',
    singapore: '新加坡',
  },
};
const productTranslations = [
  [/^e zip blinds$/i, 'E ZIP 户外防风卷帘'],
  [/^e zip blinds\s*\/\s*zip[- ]track blinds$/i, 'E ZIP／Zip Track 户外防风卷帘'],
  [/^zip[- ]?track blinds?$/i, 'Zip Track 防风卷帘'],
  [/^zip[- ]?track screens?$/i, 'Zip Track 纱网系统'],
  [/^(?:outdoor )?zip screens?(?: outdoor blinds)?$/i, '户外防风帘'],
  [/^(?:roller blinds?|roller shades?)$/i, '卷帘'],
  [/^outdoor awnings?$/i, '户外遮阳篷'],
  [/^folding arm awnings?$/i, '曲臂遮阳篷'],
  [/^plantation shutters?$/i, '种植园百叶窗'],
  [/^roller shutters?$/i, '卷式百叶窗'],
  [/^venetian blinds?$/i, '威尼斯百叶帘'],
  [/^roman (?:blinds?|shades?)$/i, '罗马帘'],
  [/^(?:cellular|honeycomb) (?:blinds?|shades?)$/i, '蜂巢帘'],
  [/^vertical (?:blinds?|shades?)$/i, '垂直帘'],
  [/^zebra (?:blinds?|shades?)$/i, '斑马帘'],
  [/^(?:duo|tri) sheer shades?$/i, '柔纱帘'],
  [/^bamboo woven shades?$/i, '竹编／编织帘'],
  [/^motori[sz]ed (?:blinds?|shades?)$/i, '电动窗帘'],
  [/^motori[sz]ed retractable patio screens?$/i, '电动伸缩庭院纱窗系统'],
  [/^retractable sunroof$/i, '伸缩天窗遮阳系统'],
  [/^security screen doors?$/i, '防盗纱门'],
  [/^wire guide screens?$/i, '钢丝导轨纱网系统'],
  [/^vinyl patio screens?$/i, '乙烯基露台纱网系统'],
  [/^curtains?$/i, '布艺帘'],
  [/^shutters?$/i, '百叶窗'],
  [/^awnings?$/i, '遮阳篷'],
  [/^patios?$/i, '露台产品'],
  [/^shade systems?$/i, '遮阳系统'],
];
const areaTranslations = {
  'sydney region': '悉尼地区',
  'greater melbourne and suburbs': '大墨尔本及周边地区',
  'dallas–fort worth': '达拉斯—沃思堡地区',
  'dallas-fort worth': '达拉斯—沃思堡地区',
  'nationwide shipping': '提供全国配送',
};
const chinese = /[\u3400-\u9fff]/;
const normalize = (value) =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
function originalValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  return value;
}
function propositionValue(field, value) {
  if (value && typeof value === 'object') return JSON.stringify(stableValue(value));
  let text = normalize(originalValue(value));
  if (field === 'products')
    text = text
      .replace(/[-‐‑–—]/g, ' ')
      .replace(/\s*(?:产品线|product line)$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  return text;
}
function stableId(text) {
  let hash = 14695981039346656037n;
  for (const character of text)
    hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 1099511628211n);
  return 'website-evidence-' + hash.toString(36);
}
function brief(value, limit = 100) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}
function translatedProduct(value) {
  const text = value.trim().replace(/\s*(?:产品线|product line)$/i, '');
  return productTranslations.find(([pattern]) => pattern.test(text))?.[1] || text;
}
function summary(field, value, category) {
  const text = originalValue(value).trim();
  const key = normalize(text);
  const enumValues = own(enums, field);
  if (Array.isArray(value) && enumValues) {
    const translated = value
      .map((item) => own(enumValues, normalize(originalValue(item))))
      .filter(Boolean);
    if (translated.length === value.length && translated.length)
      return brief(category + '：' + translated.join('、'));
  }
  const translatedEnum = enumValues && own(enumValues, key);
  if (translatedEnum) return brief(category + '：' + translatedEnum);
  if (field === 'company_name' || field === 'legal_company_name' || field === 'trading_names')
    return text ? brief(category + '：' + text) : category + '资料待核对';
  if (field === 'company_years' && /^\d+(?:\.\d+)?$/.test(text))
    return brief(`官网自述持续经营 ${text} 年`);
  if (field === 'company_since' && /^\d{4}(?:-\d{2}-\d{2})?$/.test(text))
    return brief(`官网自述自 ${text} 起持续经营`);
  if (field === 'products' || field === 'manufactured_products') {
    const translated = translatedProduct(text);
    if (
      translated &&
      (chinese.test(translated) || (translated.length <= 65 && translated.split(/\s+/).length <= 8))
    )
      return brief(category + '：' + translated);
  }
  if (field === 'service_areas' && own(areaTranslations, key))
    return brief(category + '：' + own(areaTranslations, key));
  if (chinese.test(text)) {
    const first =
      text
        .split(/\r?\n/)
        .find((line) => line.trim() && !/^(?:原文|来源|依据)[:：]/.test(line.trim())) || text;
    return brief(first.startsWith(category) ? first : category + '：' + first);
  }
  return `已记录${category}资料，展开查看原文`;
}

// This is presentation grouping only. No input record, scoring fact or source is rewritten.
export function groupWebsiteEvidence(facts, identityEvidence = []) {
  const groups = new Map();
  const input = [
    ...(Array.isArray(identityEvidence) ? identityEvidence : []),
    ...(Array.isArray(facts) ? facts : []),
  ];
  for (const fact of input) {
    if (!fact || typeof fact !== 'object') continue;
    const field =
      typeof fact.field === 'string' && fact.field
        ? fact.field
        : typeof fact.kind === 'string'
          ? fact.kind
          : '';
    const canonical = own(fieldAliases, field) || field;
    const record = {
      field,
      value: originalValue(fact.value),
      quote: typeof fact.quote === 'string' ? fact.quote : '',
      source_url: typeof fact.source_url === 'string' ? fact.source_url : '',
    };
    if (!record.value && !record.quote && !record.source_url) continue;
    const category =
      own(categories, canonical) || (chinese.test(field) ? brief(field, 24) : '其他官网事实');
    // With no value, unrelated quoted claims must not collapse into an empty proposition.
    const proposition = record.value.trim()
      ? propositionValue(canonical, fact.value)
      : normalize(record.quote) + '\u0000' + record.source_url;
    const key = JSON.stringify([canonical, proposition]);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: stableId(key),
        category,
        summary: summary(canonical, fact.value, category),
        records: [],
      };
      groups.set(key, group);
    }
    if (
      !group.records.some(
        (saved) =>
          saved.field === record.field &&
          saved.value === record.value &&
          saved.quote === record.quote &&
          saved.source_url === record.source_url,
      )
    )
      group.records.push(record);
  }
  return [...groups.values()];
}
