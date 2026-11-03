import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers/modules.mjs';

const { CustomerProfile } = loadModule(
  new URL('../src/components/CustomerProfile.tsx', import.meta.url),
);
const sourceAt = '2026-10-22T06:05:36.566Z';
const evaluatedAt = '2026-10-24T10:42:50.234Z';
const productFact = {
  kind: 'core_product',
  value: '防风帘属于稳定主营产品线',
  quote: 'We supply made-to-measure zip screens.',
  source_url: 'https://buyer.example.org/products',
};
const roleFact = {
  kind: 'specialist_supply',
  value: '向贸易客户供货的专业窗饰供应商',
  quote: 'We supply zip screens to trade customers.',
  source_url: 'https://buyer.example.org/trade',
};
const materialFact = {
  kind: 'core_product',
  value: '卷帘生产使用遮阳面料',
  quote: 'Our roller blinds use sunscreen fabrics.',
  source_url: 'https://buyer.example.org/fabrics',
};
const primary = {
  direction: 'finished',
  product: 'Zip screens',
  grade: '高优先',
  status: '高优先',
  matchLevel: '明确匹配',
  relationship: 'direct_supply',
  prioritySignals: [
    { ...productFact, label: '主营产品' },
    { ...roleFact, label: '专业供货角色' },
  ],
  facts: [productFact, roleFact],
  dimensions: {
    P: { score: 40, maximum: 40, facts: [productFact] },
    R: { score: 30, maximum: 30, facts: [roleFact] },
    D: { score: null, maximum: 20, missing: '企业持续经营年限尚未核实', facts: [] },
    V: { score: null, maximum: 10, missing: '定制资料不足', facts: [] },
  },
  missing: [],
};
const materials = {
  direction: 'finished',
  product: 'Roller blinds',
  targetProduct: 'Roller fabric',
  basisProduct: 'Roller blinds',
  grade: '常规开发',
  status: '常规开发',
  matchLevel: '潜在匹配',
  relationship: 'potential_input',
  prioritySignals: [],
  facts: [materialFact],
  dimensions: {
    P: { score: 20, maximum: 40, facts: [materialFact] },
    R: { score: null, maximum: 30, facts: [] },
  },
  missing: ['材料或配件采购方式、规格、数量与负责人待沟通'],
};
const rawReason = [
  '[自动评估 ev_fixture_123]',
  '规则版本：acquisition-v4.0',
  `评估时间：${evaluatedAt}`,
  '经营证据方向：成品 · Zip screens',
  '主营产品：户外防风帘',
  '原文：We supply made-to-measure zip screens.',
  '来源：https://buyer.example.org/products',
].join('\n');
const assessment = {
  ...primary,
  id: 'ev_fixture_123',
  score: 70,
  complete: true,
  ruleVersion: 'acquisition-v4.0',
  evaluatedAt,
  evidenceReason: rawReason,
  opportunities: [primary, materials],
};
const lead = {
  name: 'Acme Screens',
  grade: '高优先',
  score: 70,
  type: 'retailer',
  product: '防风帘\n卷帘\n遮阳篷\n百叶窗\n纱窗\n布艺帘\n天窗帘',
  status: '已联系',
  companyIdentity: {
    legal_name: null,
    website_name: 'Acme Screens',
    aliases: ['acme screens', 'Acme Screens'],
  },
  mainProductPreference: '经营户外防风帘与室内窗饰，提供量尺和安装服务。',
  industryProfile: '完整行业画像保留供进一步核对。',
  evidence: '经营户外防风帘与室内窗饰，提供量尺和安装服务。',
  supplyOpportunity: '成品 · 防风帘（潜在供货机会）',
  demandProducts: '',
  pendingQuestions: '',
  serviceAreas: 'Sydney Region',
  address: '10 Example Street, Sydney',
  audience: 'BC',
  source: 'https://buyer.example.org/products',
  updatedAt: sourceAt,
  assessment,
  ratingReason: rawReason,
};

const renderProfile = (overrides = {}, props = {}) =>
  renderToStaticMarkup(
    React.createElement(CustomerProfile, {
      lead: { ...lead, ...overrides },
      typeLabel: '零售商、安装服务商',
      ...props,
    }),
  );
// Model native details visibility, including nested closed disclosures.
const initialView = (html) => {
  const details = [];
  let visible = '';
  for (const [token] of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (/^<details\b/.test(token)) {
      details.push({ open: /\sopen(?:=|[\s>])/.test(token), summary: false });
    } else if (/^<summary\b/.test(token)) {
      if (details.length) details.at(-1).summary = true;
    } else if (/^<\/summary>/.test(token)) {
      if (details.length) details.at(-1).summary = false;
    } else if (/^<\/details>/.test(token)) {
      details.pop();
    } else if (!token.startsWith('<') && details.every((detail) => detail.open || detail.summary)) {
      visible += token + ' ';
    }
  }
  return visible.replace(/\s+/g, ' ');
};
const labeledElement = (html, label) => {
  const opening = [...html.matchAll(/<([a-z]+)\b[^>]*>/g)].find(([tag]) =>
    tag.includes(`aria-label="${label}"`),
  );
  assert.ok(opening, `缺少 ${label} 区域`);
  const [tag, name] = opening;
  const start = opening.index;
  let depth = 1;
  for (const match of html
    .slice(start + tag.length)
    .matchAll(new RegExp(`<(/?)${name}\\b[^>]*>`, 'g'))) {
    depth += match[1] ? -1 : 1;
    if (!depth) return html.slice(start, start + tag.length + match.index + match[0].length);
  }
  throw new Error(`区域 ${label} 没有结束标签`);
};

test('画像集中展示具体开发理由与供货分析，主方向展开，其他方向保留摘要', () => {
  const html = renderProfile();
  const visible = initialView(html);
  assert.match(visible, /经营户外防风帘与室内窗饰/);
  assert.match(visible, /零售商、安装服务商|企业与个人客户/);
  assert.match(visible, /Zip screens/);
  assert.match(visible, /常规开发 · 潜在匹配/);
  assert.match(visible, /防风帘属于稳定主营产品线/);
  assert.match(visible, /向贸易客户供货的专业窗饰供应商/);
  assert.match(visible, /供货分析/);
  assert.match(visible, /Roller fabric/);
  assert.doesNotMatch(visible, /卷帘生产使用遮阳面料/);
  assert.doesNotMatch(visible, /查看完整评估|\/100|主营产品、专业供货角色/);
});

test('各方向经营事实保持独立，材料机会分析不冒充已确认的采购需求', () => {
  const html = renderProfile();
  const finished = labeledElement(html, '供货机会：成品 · Zip screens');
  const material = labeledElement(html, '供货机会：材料配件 · Roller fabric');
  assert.match(finished, /防风帘属于稳定主营产品线/);
  assert.doesNotMatch(finished, /卷帘生产使用遮阳面料/);
  assert.match(material, /卷帘生产使用遮阳面料/);
  assert.doesNotMatch(material, /向贸易客户供货的专业窗饰供应商/);
  assert.match(initialView(html), /常规开发 · 潜在匹配/);
  assert.match(material, /面料|材料/);
  assert.match(initialView(material), /客户已经营Roller blinds.*询问是否需要Roller fabric/);
  assert.doesNotMatch(initialView(material), /已确认采购需求|已确认采购|确定采购/);
  assert.doesNotMatch(initialView(html), /材料或配件采购方式、规格、数量与负责人待沟通|补档任务/);
});

test('潜在供货机会移除查看依据、原文和来源展示，保留分析与经营事实', () => {
  const unsafe = { ...roleFact, source_url: 'javascript:alert(1)' };
  const scoped = {
    ...primary,
    facts: [productFact, unsafe],
    dimensions: { ...primary.dimensions, R: { score: 30, maximum: 30, facts: [unsafe] } },
    prioritySignals: [],
  };
  const html = renderProfile({ assessment: { ...assessment, ...scoped, opportunities: [scoped] } });
  const opportunity = labeledElement(html, '潜在供货机会');
  assert.match(opportunity, /供货分析|防风帘属于稳定主营产品线/);
  assert.doesNotMatch(
    opportunity,
    /查看依据|profile-evidence|profile-source|We supply made-to-measure zip screens\.|We supply zip screens to trade customers\.|buyer\.example\.org|javascript:/,
  );
});

test('人工经营事实随对应结论保留确认人和时间，机会区不展示原文', () => {
  const manual = {
    ...roleFact,
    quote: '客户实际答复内容',
    source_url: '',
    origin: 'manual',
    confirmationId: 'manual-2',
    confirmedBy: '李明',
    confirmedAt: evaluatedAt,
  };
  const scoped = {
    ...primary,
    facts: [productFact, manual],
    dimensions: { ...primary.dimensions, R: { score: 30, maximum: 30, facts: [manual] } },
    prioritySignals: [],
  };
  const html = renderProfile({ assessment: { ...assessment, ...scoped, opportunities: [scoped] } });
  assert.match(html, /人工确认/);
  assert.match(html, /李明/);
  assert.match(html, /2026年10月24日 18:42（北京时间）/);
  assert.doesNotMatch(labeledElement(html, '潜在供货机会'), /客户实际答复内容/);
  assert.match(initialView(html), /人工确认.*李明/);
  assert.match(initialView(html), /2026年10月24日 18:42（北京时间）/);
  assert.doesNotMatch(initialView(html), /客户实际答复内容/);
});

test('真实冲突在企业概况之前显示影响和核实入口，普通未知不生成任务', () => {
  const conflict = '同产品事实冲突';
  const scoped = {
    ...primary,
    missing: [conflict],
    dimensions: {
      ...primary.dimensions,
      P: { ...primary.dimensions.P, score: null, conflict: true, missing: conflict },
    },
  };
  const html = renderProfile(
    {
      assessment: { ...assessment, ...scoped, opportunities: [scoped] },
      pendingQuestions: conflict,
    },
    { onSupplement() {} },
  );
  const visible = initialView(html);
  assert.ok(visible.indexOf(conflict) < visible.indexOf(lead.mainProductPreference));
  assert.match(visible, /自动首封.*(?:暂停|暂不可发送)|暂停.*自动首封/);
  assert.match(html, /核实依据/);
  const normal = initialView(renderProfile());
  assert.doesNotMatch(normal, /企业持续经营年限尚未核实|定制资料不足|需核实事项|补充资料/);
});

test('其他供货方向的真实冲突也保持置顶可见', () => {
  const conflict = '材料产品依据冲突';
  const scoped = {
    ...materials,
    missing: [conflict],
    dimensions: {
      ...materials.dimensions,
      P: { ...materials.dimensions.P, conflict: true, missing: conflict },
    },
  };
  const visible = initialView(
    renderProfile({ assessment: { ...assessment, opportunities: [primary, scoped] } }),
  );
  assert.match(visible, /材料产品依据冲突/);
});

test('待核实的经营关联不被描述为已经发现事实冲突', () => {
  const pending = {
    ...primary,
    grade: null,
    status: '待核实',
    matchLevel: '待核实',
    facts: [],
    prioritySignals: [],
    missing: ['经营主体尚未核实'],
    dimensions: {},
  };
  const visible = initialView(
    renderProfile({
      grade: '待核实',
      assessment: { ...assessment, ...pending, opportunities: [pending] },
    }),
  );
  assert.match(visible, /尚未核实/);
  assert.doesNotMatch(visible, /解决相关冲突|存在冲突|自动首封暂不可发送/);
});

test('更多产品与企业资料默认折叠并保留完整内容', () => {
  const html = renderProfile({
    companyIdentity: { ...lead.companyIdentity, aliases: ['Acme Screens', 'Acme Trading'] },
  });
  const visible = initialView(html);
  assert.match(visible, /其余 1 项产品/);
  assert.doesNotMatch(
    visible,
    /天窗帘|Acme Trading|Sydney Region|10 Example Street|完整行业画像保留/,
  );
  for (const text of [
    '天窗帘',
    'Acme Trading',
    'Sydney Region',
    '10 Example Street',
    '完整行业画像保留',
  ])
    assert.ok(html.includes(text));
});

test('客户行业画像隐藏来源行，保留经营描述和依据文字', () => {
  const html = renderProfile({
    industryProfile:
      '经营窗饰制造与零售。\r\n依据：Custom window furnishings — manufacture & retail\r\n来源：https://buyer.example.org/about\r\n来源: https://buyer.example.org/company',
  });
  const industry = html.match(/<dt>客户行业画像<\/dt><dd>([\s\S]*?)<\/dd>/)?.[1];
  assert.ok(industry);
  assert.match(industry, /经营窗饰制造与零售|依据：Custom window furnishings/);
  assert.doesNotMatch(industry, /来源|https?:/);
});

test('公开与人工确认的采购需求单独显示，不由供货分析生成', () => {
  const visible = initialView(
    renderProfile({
      demandProducts: '公开寻找定制卷帘面料供应商\n依据：We are seeking roller fabric suppliers.',
      manualPurchaseNeed: '采购防风帘样品两套',
    }),
  );
  assert.match(visible, /公开采购需求/);
  assert.match(visible, /公开寻找定制卷帘面料供应商/);
  assert.match(visible, /已确认采购需求/);
  assert.match(visible, /采购防风帘样品两套/);
  assert.doesNotMatch(
    initialView(renderProfile()),
    /公开采购需求|已确认采购需求|具体采购需求待确认/,
  );
});

test('人工改级标记贴近当前客户等级，资料时间保持北京时间', () => {
  const visible = initialView(
    renderProfile({ grade: '常规开发', assessment: { ...assessment, manualOverride: true } }),
  );
  assert.match(visible, /常规开发/);
  assert.match(visible, /人工调整|人工修改/);
  assert.match(visible, /官网取证：2026年10月22日 14:05（北京时间）/);
  assert.match(visible, /评估更新：2026年10月24日 18:42（北京时间）/);
  assert.doesNotMatch(visible, /2026-10-\d{2}T|\.234Z|\.566Z/);
});

test('机会卡片移除重复评级组件，旧规则记录不展示', () => {
  const current = renderProfile({ grade: 'A' });
  assert.doesNotMatch(current, /profile-priority|匹配等级：/);
  assert.match(current, /常规开发 · 潜在匹配/);
  const old = renderProfile({
    grade: 'A',
    assessment: { ...assessment, ruleVersion: 'acquisition-v3.2' },
  });
  assert.doesNotMatch(old, /旧版评估|acquisition-v3\.2|初评记录/);
});

test('完整人工确认记录折叠保留，已核实资料不会重新变成普通补档任务', () => {
  const html = renderProfile({
    pendingQuestions: '经营法人名称待核实；具体采购需求待确认',
    companyIdentity: {
      legal_name: 'Acme Trading Ltd',
      website_name: 'Acme',
      aliases: [],
      status: 'legal_name_manual_confirmed',
    },
    manualPurchaseNeed: '采购防风帘样品两套',
    confirmations: [
      {
        id: 'manual-1',
        category: 'profile',
        pendingItem: '经营法人名称待核实',
        content: '确认过的企业资料',
        evidence: '人工电话核对原文',
        confirmedBy: '李明',
        confirmedAt: evaluatedAt,
      },
    ],
  });
  const visible = initialView(html);
  assert.doesNotMatch(visible, /经营法人名称待核实|具体采购需求待确认|人工电话核对原文/);
  assert.match(html, /Acme Trading Ltd（人工确认）/);
  assert.match(html, /人工电话核对原文/);
  assert.match(html, /李明/);
});
