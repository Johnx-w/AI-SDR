import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers/modules.mjs';

const { CustomerProfile } = loadModule(
  new URL('../src/components/CustomerProfile.tsx', import.meta.url),
);
const { AssessmentPanel } = loadModule(
  new URL('../src/components/AssessmentPanel.tsx', import.meta.url),
);
const sourceAt = '2026-10-22T06:05:36.566Z';
const evaluatedAt = '2026-10-24T10:42:50.234Z';
const rawReason = [
  '[自动评估 ev_fixture_123]',
  '规则版本：acquisition-v3.2',
  `评估时间：${evaluatedAt}`,
  '经营证据方向：成品 · Zip screens',
  '评级口径：A/B/C表示初始开发优先级',
  '主营产品：户外防风帘',
  '原文：We supply made-to-measure zip screens.',
  '来源：https://buyer.example.org/products',
  '其他方向（不与主方向拼分）：',
  '材料 · Roller fabric：B，已支持60分',
].join('\n');
const assessment = {
  id: 'ev_fixture_123',
  grade: 'A',
  score: 85,
  complete: false,
  ruleVersion: 'acquisition-v3.2',
  evaluatedAt,
  evidenceReason: [
    `研究限制：本次仅按新规则重算，沿用 ${sourceAt} 的官网研究证据，未重新抓取官网。；仅用已保存事实按 v3.2 复算。`,
    '主营产品：户外防风帘',
    '原文：We supply made-to-measure zip screens.',
    '来源：https://buyer.example.org/products',
  ].join('\n'),
  missing: ['未确认企业是否接受海外供货'],
  dimensions: { P: { score: 40, maximum: 40 }, D: { score: null, maximum: 20 } },
};
const lead = {
  name: 'Acme Screens',
  grade: 'A',
  score: 85,
  type: 'retailer',
  product: '防风帘\n卷帘\n遮阳篷\n百叶窗\n纱窗\n布艺帘\n天窗帘',
  status: '未记录',
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
  pendingQuestions: `未确认企业是否接受海外供货；研究限制：沿用 ${sourceAt}，本次没有重新抓取官网。`,
  serviceAreas: 'Sydney Region',
  source: 'https://buyer.example.org/products',
  updatedAt: sourceAt,
  assessment,
  ratingReason: rawReason,
};

const renderProfile = (overrides = {}) =>
  renderToStaticMarkup(
    React.createElement(CustomerProfile, {
      lead: { ...lead, ...overrides },
      typeLabel: '零售商、安装服务商',
      onAssessment() {},
    }),
  );
const renderAssessment = (props = {}) =>
  renderToStaticMarkup(
    React.createElement(AssessmentPanel, {
      assessment,
      ratingReason: rawReason,
      researchAt: sourceAt,
      ...props,
    }),
  );
// Closed disclosures are omitted from the initial view while their summaries remain readable.
const initialView = (html) =>
  html.replace(/<details\b([^>]*)>([\s\S]*?)<\/details>/g, (all, attributes, content) =>
    /\bopen(?:=|\s|$)/.test(attributes)
      ? all
      : content.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0] || '',
  );
const technicalDisclosure = (html) =>
  html.match(/<details\b[^>]*>\s*<summary>技术信息<\/summary>[\s\S]*?<\/details>/)?.[0];

test('客户画像首次展示简洁概览和评级入口，自动评估报告不重复出现在画像中', () => {
  const html = renderProfile();
  const visible = initialView(html);
  assert.match(visible, /经营户外防风帘与室内窗饰/);
  assert.match(visible, /已支持 85\/100/);
  assert.match(visible, /查看完整评估/);
  assert.match(visible, /零售商、安装服务商/);
  assert.doesNotMatch(html, /ev_fixture_123|acquisition-v3\.2|评级口径|We supply made-to-measure/);
});

test('潜在供货机会不冒充已确认采购需求，重要未知项保持可见且不被研究日志淹没', () => {
  const visible = initialView(renderProfile());
  assert.match(visible, /潜在供货机会/);
  assert.match(visible, /成品 · 防风帘/);
  assert.match(visible, /未确认企业是否接受海外供货/);
  assert.equal((visible.match(/未确认企业是否接受海外供货/g) || []).length, 1);
  assert.match(visible, /具体采购需求待确认/);
  assert.match(visible, /经营法人名称待核实/);
  assert.doesNotMatch(visible, /公开采购需求|本次没有重新抓取|研究限制：/);
});

test('更多产品和企业资料默认折叠，同时保留完整内容供展开核对', () => {
  const html = renderProfile({
    companyIdentity: { ...lead.companyIdentity, aliases: ['Acme Screens', 'Acme Trading'] },
  });
  const visible = initialView(html);
  assert.match(visible, /其余 1 项产品/);
  assert.doesNotMatch(visible, /天窗帘|Acme Trading|完整行业画像保留/);
  assert.match(html, /天窗帘/);
  assert.match(html, /Acme Trading/);
  assert.match(html, /完整行业画像保留/);
  assert.ok(
    [...html.matchAll(/<details\b[^>]*>/g)].every(([tag]) => !/\sopen(?:=|[\s>])/.test(tag)),
  );
});

test('已记录的公开采购需求独立呈现，官网取证时间与评估更新时间均显示北京时间', () => {
  const visible = initialView(
    renderProfile({
      demandProducts: '公开寻找定制卷帘面料供应商\n依据：We are seeking roller fabric suppliers.',
    }),
  );
  assert.match(visible, /公开采购需求/);
  assert.match(visible, /公开寻找定制卷帘面料供应商/);
  assert.doesNotMatch(visible, /具体采购需求待确认/);
  assert.match(visible, /官网取证：2026年10月22日 14:05（北京时间）/);
  assert.match(visible, /评估更新：2026年10月24日 18:42（北京时间）/);
  assert.doesNotMatch(visible, /2026-10-\d{2}T|\.234Z|\.566Z/);
});

test('最新评估首次展示判断摘要，完整原文来源和其他方向默认折叠', () => {
  const html = renderAssessment();
  const visible = initialView(html);
  assert.match(visible, /完整评级记录/);
  assert.doesNotMatch(visible, /We supply made-to-measure zip screens\./);
  assert.doesNotMatch(visible, /https:\/\/buyer\.example\.org\/products/);
  assert.doesNotMatch(visible, /材料 · Roller fabric：B，已支持60分/);
  assert.match(html, /We supply made-to-measure zip screens\./);
  assert.match(html, /https:\/\/buyer\.example\.org\/products/);
  assert.match(html, /材料 · Roller fabric：B，已支持60分/);
  assert.match(visible, /未确认企业是否接受海外供货/);
  assert.doesNotMatch(visible, /ev_fixture_123|acquisition-v3\.2/);
  const technical = technicalDisclosure(html);
  assert.ok(technical, '技术信息可供展开核对');
  assert.doesNotMatch(technical.match(/^<details\b[^>]*>/)[0], /\sopen(?:=|[\s>])/);
  assert.match(technical, /ev_fixture_123/);
  assert.match(technical, /acquisition-v3\.2/);
  assert.doesNotMatch(html, /2026-10-\d{2}T|\.234Z|\.566Z/);
});

test('缺少结构化自动评估时完整记录仍可展开，不能伪造逐维度结论', () => {
  const html = renderAssessment({ assessment: null });
  const visible = initialView(html);
  assert.match(visible, /完整评级记录/);
  assert.doesNotMatch(
    visible,
    /主营产品：户外防风帘|We supply made-to-measure zip screens\.|材料 · Roller fabric/,
  );
  assert.match(html, /主营产品：户外防风帘/);
  assert.match(html, /We supply made-to-measure zip screens\./);
  assert.match(html, /材料 · Roller fabric：B，已支持60分/);
  assert.doesNotMatch(html, /class="assessment-dimension-card/);
  assert.match(visible, /2026年10月24日 18:42（北京时间）/);
  assert.doesNotMatch(visible, /ev_fixture_123|acquisition-v3\.2|尚无当前规则的自动评估/);
  assert.match(technicalDisclosure(html), /ev_fixture_123/);
});

test('结构化评估存在时，额外人工评级依据仍保留在业务内容中', () => {
  const supplement = '人工补充依据：客户官网公布了供应商申请入口，尚未确认具体采购量。';
  const html = renderAssessment({ ratingReason: rawReason + '\n' + supplement });
  const businessContent = html.replace(technicalDisclosure(html), '');
  assert.match(businessContent, /人工补充依据：客户官网公布了供应商申请入口，尚未确认具体采购量。/);
  assert.doesNotMatch(initialView(html), /人工补充依据：客户官网公布了供应商申请入口/);
  assert.doesNotMatch(businessContent, /ev_fixture_123|acquisition-v3\.2|2026-10-\d{2}T/);
});

const dimensionAssessment = {
  ...assessment,
  grade: null,
  score: 45,
  dimensions: {
    P: {
      score: 40,
      maximum: 40,
      facts: [
        {
          kind: 'core_product',
          value: '防风帘属于稳定主营产品线',
          quote: 'The full original product quotation is preserved for source review.',
          source_url: 'https://buyer.example.org/zip-screens',
        },
      ],
    },
    R: {
      score: 0,
      maximum: 30,
      facts: [
        {
          kind: 'no_supply_role',
          value: '现有业务只提供安装服务',
          quote: 'We install customer supplied products and do not purchase them.',
          source_url: 'https://buyer.example.org/services',
        },
      ],
    },
    D: { score: null, maximum: 20, missing: '企业持续经营年限尚未核实', facts: [] },
    V: {
      score: 5,
      maximum: 10,
      facts: [
        {
          kind: 'custom_made',
          value: '支持按尺寸定制',
          quote: 'The full original customization quotation must not crowd the initial view.',
          source_url: 'javascript:alert(1)',
        },
      ],
    },
  },
};
const contentText = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const dimensionCards = (html) =>
  [
    ...html.matchAll(
      /<article\b[^>]*class="assessment-dimension-card[^"]*"[^>]*>[\s\S]*?<\/article>/g,
    ),
  ].map(([card]) => card);

test('评估按维度显示简短结论与依据，已知零分和未知分保持区别', () => {
  const html = renderAssessment({ assessment: dimensionAssessment });
  const visible = initialView(html);
  const cards = dimensionCards(html).map((card) => contentText(initialView(card)));
  assert.equal(cards.length, 4);
  const product = cards.find((card) => card.includes('产品契合'));
  assert.match(product, /40\s*\/\s*40/);
  assert.match(product, /主营产品与目标品类对口/);
  assert.match(product, /防风帘属于稳定主营产品线/);
  const role = cards.find((card) => card.includes('经营角色'));
  assert.match(role, /0\s*\/\s*30/);
  assert.match(role, /现有证据显示无适用供货角色/);
  const sustained = cards.find((card) => card.includes('持续经营'));
  assert.match(sustained, /未知\s*\/\s*20/);
  assert.match(sustained, /持续经营依据待补充/);
  assert.match(sustained, /企业持续经营年限尚未核实/);
  const customization = cards.find((card) => card.includes('定制与系统特征'));
  assert.match(customization, /5\s*\/\s*10/);
  assert.match(customization, /具备定制特征/);
  assert.match(customization, /支持按尺寸定制/);
  assert.match(contentText(visible), /已支持 45\s*\/\s*100/);
  assert.doesNotMatch(
    visible,
    /The full original|We install customer supplied products|https:\/\/buyer\.example\.org\/zip-screens/,
  );
});

test('逐维度原文和来源默认折叠，安全来源可导航，脚本来源只能作为文本保留', () => {
  const html = renderAssessment({ assessment: dimensionAssessment });
  const disclosures = [
    ...html.matchAll(
      /<details\b[^>]*class="assessment-dimension-sources[^"]*"[^>]*>[\s\S]*?<\/details>/g,
    ),
  ].map(([detail]) => detail);
  assert.equal(disclosures.length, 3);
  for (const detail of disclosures) {
    assert.doesNotMatch(detail.match(/^<details\b[^>]*>/)[0], /\sopen(?:=|[\s>])/);
    assert.match(detail, /原文与来源/);
  }
  assert.match(html, /The full original product quotation is preserved for source review\./);
  assert.match(html, /The full original customization quotation must not crowd the initial view\./);
  assert.match(html, /href="https:\/\/buyer\.example\.org\/zip-screens"/);
  assert.match(html, /javascript:alert\(1\)/);
  assert.doesNotMatch(html, /href="javascript:/);
  const fullRecord = html.match(
    /<details\b[^>]*class="assessment-full-evidence[^"]*"[^>]*>[\s\S]*?<\/details>/,
  )?.[0];
  assert.ok(fullRecord);
  assert.doesNotMatch(fullRecord.match(/^<details\b[^>]*>/)[0], /\sopen(?:=|[\s>])/);
});

test('人工调整标记和北京时间在精简后的评估首屏仍然保留', () => {
  const visible = initialView(
    renderAssessment({ assessment: { ...dimensionAssessment, grade: 'B', manualOverride: true } }),
  );
  assert.match(visible, /主表评级已人工修改/);
  assert.match(visible, /分数来自最新自动评估，客户评级已人工调整/);
  assert.match(visible, /评估更新：2026年10月24日 18:42（北京时间）/);
  assert.match(visible, /官网取证：2026年10月22日 14:05（北京时间）/);
});

test('客户画像待确认与缺失评分维度都显示补充资料入口', () => {
  const profile = renderToStaticMarkup(
    React.createElement(CustomerProfile, {
      lead: { ...lead, assessment: dimensionAssessment, pendingQuestions: '' },
      typeLabel: '零售商',
      onAssessment() {},
      onSupplement() {},
    }),
  );
  assert.match(profile, /aria-label="补充资料：企业持续经营年限尚未核实"/);
  assert.match(profile, /aria-label="补充资料：经营法人名称待核实"/);
  assert.match(profile, /aria-label="补充资料：具体采购需求待确认"/);
  const assessed = renderAssessment({ assessment: dimensionAssessment, onSupplement() {} });
  const cards = dimensionCards(assessed);
  assert.match(
    cards.find((card) => card.includes('持续经营评分')),
    /aria-label="补充资料：持续经营"/,
  );
  assert.doesNotMatch(
    cards.find((card) => card.includes('经营角色评分')),
    /补充资料/,
  );
});

test('确认记录默认折叠，已确认名称和采购需求解除待确认但记录不能遮蔽评分缺项', () => {
  const confirmation = {
    id: 'manual-1',
    category: 'profile',
    pendingItem: '企业持续经营年限尚未核实',
    content: '确认过的企业资料',
    evidence: '人工电话核对原文',
    confirmedBy: '李明',
    confirmedAt: evaluatedAt,
    direction: 'finished',
    product: '防风帘',
  };
  const html = renderProfile({
    assessment: { ...dimensionAssessment, missing: ['企业持续经营年限尚未核实'] },
    pendingQuestions: '经营法人名称待核实；具体采购需求待确认',
    companyIdentity: {
      legal_name: 'Acme Trading Ltd',
      website_name: 'Acme',
      aliases: [],
      status: 'legal_name_manual_confirmed',
    },
    manualPurchaseNeed: '采购防风帘样品两套',
    confirmations: [confirmation],
  });
  const visible = initialView(html);
  assert.match(visible, /企业持续经营年限尚未核实/);
  assert.doesNotMatch(visible, /经营法人名称待核实|具体采购需求待确认/);
  assert.match(visible, /已确认采购需求|采购防风帘样品两套/);
  assert.doesNotMatch(visible, /人工电话核对原文|李明/);
  assert.match(html, /人工电话核对原文|李明/);
  assert.match(html, /2026年10月24日 18:42（北京时间）/);
  assert.match(html, /Acme Trading Ltd（人工确认）/);
});

test('人工评分依据保留确认人和北京时间，来源默认折叠', () => {
  const html = renderAssessment({
    assessment: {
      ...dimensionAssessment,
      dimensions: {
        R: {
          score: 30,
          maximum: 30,
          facts: [
            {
              kind: 'specialist_supply',
              value: '专业供货',
              quote: '客户实际答复内容',
              source_url: '',
              origin: 'manual',
              confirmationId: 'manual-2',
              confirmedBy: '李明',
              confirmedAt: evaluatedAt,
            },
          ],
        },
      },
    },
  });
  assert.match(html, /人工确认 · 李明 · 2026年10月24日 18:42（北京时间）/);
  assert.match(html, /客户实际答复内容/);
  assert.doesNotMatch(initialView(html), /客户实际答复内容|李明/);
  assert.match(html, /依据由确认人补充/);
});

test('关联成品对应的材料采购缺项进入采购需求并预选目标材料，不能默认使用成品产品', () => {
  const note = '材料或配件采购方式、规格、数量与负责人待沟通';
  const scopedAssessment = {
    ...assessment,
    direction: 'finished',
    product: 'Roller blinds',
    dimensions: {},
    missing: [note],
    supplyOpportunity: { targetProduct: 'Roller fabric', note, procurementStatus: 'unconfirmed' },
  };
  const contexts = [];
  function pendingButton(element) {
    if (!React.isValidElement(element)) return undefined;
    if (element.type === 'button' && element.props['aria-label'] === '补充资料：' + note)
      return element;
    return React.Children.toArray(element.props.children).map(pendingButton).find(Boolean);
  }
  const profile = CustomerProfile({
    lead: { ...lead, assessment: scopedAssessment, pendingQuestions: note },
    typeLabel: '零售商',
    onAssessment() {},
    onSupplement(context) {
      contexts.push(context);
    },
  });
  pendingButton(profile).props.onClick();
  const latest = AssessmentPanel({
    assessment: scopedAssessment,
    onSupplement(context) {
      contexts.push(context);
    },
  });
  pendingButton(latest).props.onClick();
  assert.deepEqual(contexts, [
    {
      category: 'purchase_need',
      pendingItem: note,
      product: 'Roller fabric',
      direction: 'materials',
    },
    {
      category: 'purchase_need',
      pendingItem: note,
      product: 'Roller fabric',
      direction: 'materials',
    },
  ]);
});
