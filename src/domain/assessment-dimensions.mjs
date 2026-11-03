const definitions = {
  P: {
    name: '产品契合',
  },
  R: {
    name: '经营角色',
  },
  D: {
    name: '持续经营',
  },
  V: {
    name: '定制与系统特征',
  },
};
const labels = {
  core_product: '主营产品',
  secondary_product: '明确经营品类',
  adjacent_product: '邻近品类',
  unrelated_product: '不匹配依据',
  specialist_supply: '专业供货角色',
  general_supply: '综合供货角色',
  installation_only: '仅安装服务',
  no_supply_role: '无适用采购角色',
  current_supply_process: '当前供货流程',
  company_since: '企业经营起始',
  company_years: '企业持续经营',
  operating_outlet: '现营网点',
  active_dealer: '实际经销商',
  completed_project: '已交付项目',
  completed_commercial_project: '已交付商业项目',
  custom_made: '定制特征',
  motorized_system: '电动系统特征',
  commercial_specification: '工程规格特征',
};
const valueText = (value) => {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join('、');
  if (typeof value === 'object')
    return Object.values(value).map(valueText).filter(Boolean).join('、');
  return String(value);
};
const normalizeFacts = (facts) => {
  const result = new Map();
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact !== 'object') continue;
    const next = {
      kind: typeof fact.kind === 'string' ? fact.kind : '',
      value: valueText(fact.value),
      quote: typeof fact.quote === 'string' ? fact.quote : '',
      source_url: typeof fact.source_url === 'string' ? fact.source_url : '',
      ...(fact.origin === 'manual'
        ? {
            origin: 'manual',
            confirmationId: fact.confirmationId,
            confirmedBy: fact.confirmedBy,
            confirmedAt: fact.confirmedAt,
          }
        : {}),
    };
    if (!next.value && !next.quote && !next.source_url) continue;
    result.set(JSON.stringify(next), next);
  }
  return [...result.values()];
};

function conclusion(key, dimension, facts) {
  const name = definitions[key].name;
  if (dimension.conflict) return '该维度事实存在冲突，需核实';
  if (dimension.score === null || dimension.score === undefined) return name + '尚无公开依据';
  const has = (...kinds) => facts.some((fact) => kinds.includes(fact.kind));
  if (key === 'P') {
    if (has('unrelated_product')) return '现有证据显示产品不匹配';
    if (has('core_product')) return '主营产品与目标品类对口';
    if (has('secondary_product')) return '明确经营相关产品，属于业务副线';
    if (has('adjacent_product')) return '经营邻近品类，产品关联较弱';
  }
  if (key === 'R') {
    if (has('no_supply_role')) return '现有证据显示无适用供货角色';
    if (has('installation_only')) return '现有证据仅支持安装服务角色';
    if (has('specialist_supply')) return '具备相关产品的专业供货角色';
    if (has('general_supply')) return '具备相关产品的综合供货角色';
  }
  if (key === 'D') {
    if (has('operating_outlet', 'active_dealer')) return '有经营网点或经销网络依据';
    if (has('completed_project', 'completed_commercial_project'))
      return '有已交付项目及承接能力依据';
    if (has('company_since', 'company_years')) return '有企业持续经营依据';
    if (has('current_supply_process')) return '已核实当前供货流程';
  }
  if (key === 'V') {
    const custom = has('custom_made'),
      motor = has('motorized_system'),
      commercial = has('commercial_specification');
    if (custom && motor && commercial) return '具备定制、电动与工程配套特征';
    if (custom && motor) return '具备定制与电动系统特征';
    if (custom && commercial) return '具备定制与工程配套特征';
    if (motor && commercial) return '具备电动系统与工程配套特征';
    if (custom) return '具备定制特征';
    if (motor) return '存在电动或自动化系统特征';
    if (commercial) return '存在工程配套特征';
  }
  return '已记录' + name + '评分';
}

export function buildAssessmentDimensions(assessment) {
  if (!assessment?.dimensions || typeof assessment.dimensions !== 'object') return [];
  return Object.entries(definitions).flatMap(([key, definition]) => {
    const dimension = assessment.dimensions[key];
    if (!dimension || typeof dimension !== 'object') return [];
    const facts = normalizeFacts(dimension.facts);
    const missing =
      dimension.conflict && typeof dimension.missing === 'string' ? dimension.missing : '';
    const basis = [
      ...new Set(
        facts
          .filter((fact) => fact.value)
          .map((fact) => `${labels[fact.kind] || '业务事实'}：${fact.value}`),
      ),
    ];
    if (missing && dimension.conflict) basis.push('需核实：' + missing);
    return [
      {
        key,
        name: definition.name,
        score: dimension.score ?? null,
        maximum: dimension.maximum,
        conclusion: conclusion(key, dimension, facts),
        basis,
        facts,
        missing,
        ...(dimension.conflict ? { conflict: true } : {}),
      },
    ];
  });
}
