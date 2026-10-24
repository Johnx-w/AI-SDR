const definitions = {
  P: {
    name: '产品契合',
    kinds: ['core_product', 'secondary_product', 'adjacent_product', 'unrelated_product'],
  },
  R: {
    name: '经营角色',
    kinds: ['specialist_supply', 'general_supply', 'installation_only', 'no_supply_role'],
  },
  D: {
    name: '持续经营',
    kinds: [
      'current_supply_process',
      'company_since',
      'company_years',
      'operating_outlet',
      'active_dealer',
      'completed_project',
      'completed_commercial_project',
    ],
  },
  V: {
    name: '定制与系统特征',
    kinds: ['custom_made', 'motorized_system', 'commercial_specification'],
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
const legacyLabels = new Map([
  ...Object.entries(labels).map(([kind, label]) => [label, kind]),
  ['定制能力需求', 'custom_made'],
  ['电动系统需求', 'motorized_system'],
  ['工程规格需求', 'commercial_specification'],
]);
const directions = {
  finished: 'finished',
  成品: 'finished',
  materials: 'materials',
  材料: 'materials',
  材料配件: 'materials',
  samples: 'samples',
  样本: 'samples',
  样本展示: 'samples',
};
const identity = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/（/g, '(')
    .replace(/）/g, ')');
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

function scopedLegacyLines(assessment, text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]
      .trim()
      .match(
        /^(?:经营证据方向[:：]\s*)?(成品|材料配件|材料|样本展示|样本|finished|materials|samples)\s*[·・]\s*(.+)$/,
      );
    if (match)
      sections.push({ index, direction: directions[match[1]], product: identity(match[2]) });
  }
  const otherIndex = lines.findIndex((line) => /^其他方向/.test(line.trim()));
  if (!sections.length) return otherIndex < 0 ? lines : lines.slice(0, otherIndex);
  const product = identity(assessment.product);
  const direction = directions[assessment.direction];
  const matching = sections.filter(
    (section) =>
      (!product || section.product === product) && (!direction || section.direction === direction),
  );
  // A missing or ambiguous product must never join facts from other opportunities.
  if (matching.length !== 1) return [];
  const section = matching[0];
  const nextIndex =
    sections.find((candidate) => candidate.index > section.index)?.index ?? lines.length;
  return lines.slice(
    section.index + 1,
    otherIndex >= 0 ? Math.min(nextIndex, otherIndex) : nextIndex,
  );
}

function parseLegacyFacts(assessment, text) {
  const facts = [];
  let current;
  let part;
  const flush = () => {
    if (current) facts.push(current);
    current = undefined;
    part = undefined;
  };
  for (const rawLine of scopedLegacyLines(assessment, text)) {
    const line = rawLine.trim();
    const field = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (field && legacyLabels.has(field[1])) {
      flush();
      current = { kind: legacyLabels.get(field[1]), value: field[2], quote: '', source_url: '' };
      part = 'value';
    } else if (current && field && field[1] === '原文') {
      current.quote = field[2];
      part = 'quote';
    } else if (current && field && field[1] === '来源') {
      current.source_url = field[2];
      part = 'source_url';
    } else if (
      /^(?:待补充|本轮|研究限制|规则版本|评估时间|评级口径|用户评级|已支持分数|其他方向)/.test(line)
    ) {
      flush();
    } else if (current && part === 'quote') {
      current.quote += '\n' + rawLine;
    } else if (
      current &&
      part === 'source_url' &&
      !current.source_url &&
      /^https?:\/\//.test(line)
    ) {
      current.source_url = line;
    }
  }
  flush();
  return normalizeFacts(facts);
}

function conclusion(key, dimension, facts) {
  const name = definitions[key].name;
  if (dimension.conflict) return '该维度事实存在冲突，需核实';
  if (dimension.score === null || dimension.score === undefined) return name + '依据待补充';
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

export function buildAssessmentDimensions(assessment, ratingReason = '') {
  if (!assessment?.dimensions || typeof assessment.dimensions !== 'object') return [];
  const legacy = parseLegacyFacts(assessment, assessment.evidenceReason || ratingReason);
  return Object.entries(definitions).flatMap(([key, definition]) => {
    const dimension = assessment.dimensions[key];
    if (!dimension || typeof dimension !== 'object') return [];
    const facts = Object.hasOwn(dimension, 'facts')
      ? normalizeFacts(dimension.facts)
      : legacy.filter((fact) => definition.kinds.includes(fact.kind));
    const missing = typeof dimension.missing === 'string' ? dimension.missing : '';
    const basis = [
      ...new Set(
        facts
          .filter((fact) => fact.value)
          .map((fact) => `${labels[fact.kind] || '业务事实'}：${fact.value}`),
      ),
    ];
    if (missing) basis.push('待补充：' + missing);
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
