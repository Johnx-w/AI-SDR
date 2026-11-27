import test from 'node:test';
import assert from 'node:assert/strict';
import { customerEligibility } from '../server/customer-eligibility.mjs';
import {
  companyResearchSchema,
  parseCompanyResearch,
  researchFields,
} from '../server/company-research.mjs';
import { assessCompany } from '../server/customer-assessment.mjs';
import { selectOutreachCandidates, outreachProductScope } from '../server/outreach-content.mjs';

const business = {
  entity_type: 'business',
  production_model: 'no_own_factory',
  operating_model: 'beyond_local',
};

test('企业面向 B、C 或 BC 不影响全局准入，个人消费者始终淘汰', () => {
  for (const audience of ['B', 'C', 'BC']) {
    const target = { product: 'outdoor zip screens' };
    assert.equal(customerEligibility({ ...business, audience }, target).status, 'eligible');
    assert.equal(
      customerEligibility({ ...business, audience, entity_type: 'individual' }, target).code,
      'individual_consumer',
    );
  }
});

test('工厂和本地经营角色不做全局淘汰，具体供货机会另行判断', () => {
  const factory = {
    ...business,
    production_model: 'own_factory',
    manufactured_products: ['outdoor zip screens'],
  };
  assert.equal(customerEligibility(factory, { product: 'outdoor zip screens' }).status, 'eligible');
  assert.equal(
    customerEligibility(factory, { product: 'outdoor blinds awnings components and parts' }).status,
    'eligible',
  );
  assert.equal(customerEligibility(factory, { product: 'Roman blinds' }).status, 'eligible');
  assert.equal(
    customerEligibility({ ...factory, manufactured_products: [] }, { product: 'zip screens' })
      .status,
    'eligible',
  );
  assert.equal(
    customerEligibility({ ...business, operating_model: 'local_only' }).status,
    'eligible',
  );
});

test('Schema 中准入字段必填但允许无证据返回 null，数组独立引证', () => {
  for (const key of ['entity_type', 'production_model', 'operating_model', 'manufactured_products'])
    assert.ok(companyResearchSchema.required.includes(key), key);
  for (const key of ['entity_type', 'production_model', 'operating_model'])
    assert.ok(companyResearchSchema.properties[key].anyOf.some((branch) => branch.type === 'null'));
  assert.equal(
    companyResearchSchema.properties.manufactured_products.items.required.includes('quote'),
    true,
  );
});
test('新版官网准入按经营主体和供货方式逐类判定', () => {
  // Expected outcomes follow the signed admission table; inputs represent verified website facts.
  for (const [description, facts, status, code] of [
    ['专营家用成品零售', ['complete_supply'], 'eligible', 'complete_supply'],
    [
      '本地加工并销售整帘',
      ['complete_supply', 'component_manufacture_only'],
      'eligible',
      'complete_supply',
    ],
    ['自产且经销专用配件', ['component_resale'], 'eligible', 'component_resale'],
    ['纯自产专用配件', ['component_manufacture_only'], 'rejected', 'component_manufacture_only'],
    ['过时的生产目录', [], 'insufficient_evidence', 'operating_evidence_missing'],
    [
      '展会主办方且有自营遮阳商品',
      ['complete_supply', 'trade_show_operator'],
      'rejected',
      'trade_show_operator',
    ],
    [
      '交易平台且有自营商品',
      ['marketplace_operator', 'component_resale'],
      'rejected',
      'marketplace_operator',
    ],
    ['仅能访到参展介绍', ['third_party_profile'], 'insufficient_evidence', 'official_site_missing'],
    ['客户自备，仅提供安装', ['installation_only'], 'rejected', 'installation_only'],
    ['安装资料未确定供货方', [], 'insufficient_evidence', 'operating_evidence_missing'],
    [
      '综合家居商只做家用定制',
      ['complete_supply', 'general_retailer', 'home_only_retail'],
      'rejected',
      'home_only_retail',
    ],
    [
      '综合家居商已有商业窗饰定制',
      ['general_retailer', 'commercial_custom_supply'],
      'eligible',
      'commercial_custom_supply',
    ],
    [
      '综合家居商供货用途未核实',
      ['general_retailer', 'complete_supply'],
      'insufficient_evidence',
      'commercial_supply_missing',
    ],
    ['专营遮阳伞', ['complete_supply'], 'eligible', 'complete_supply'],
    ['仅经营挡烟帘等相邻用途', ['excluded_use_only'], 'rejected', 'excluded_use_only'],
    ['另有合格主营成品', ['complete_supply', 'excluded_use_only'], 'eligible', 'complete_supply'],
    ['集团本体或无关业务', ['unrelated_operator'], 'rejected', 'unrelated_operator'],
  ]) {
    const result = customerEligibility({ ...business, admission_facts: facts });
    assert.deepEqual([result.status, result.code], [status, code], description);
  }
});
test('采购证据统一传给需求字段、评级依据和首发选材', () => {
  const pageUrl = 'https://north-shades.example.org/';
  const supply = 'North Shades sells and installs made-to-measure roller blinds.';
  const positive = 'We are purchasing curtain fabric for finished curtains.';
  const negative = 'We are not purchasing curtain fabric this year.';
  const office = 'We are purchasing office stationery.';
  const evidence = (value, quote) => ({ value, quote, source_url: pageUrl });
  const target = { product_scope: 'all', product: 'window coverings' };
  const products = [
    { id: 'finished', name: 'roller blinds', englishName: 'roller blinds', direction: 'finished' },
    { id: 'fabric', name: 'curtain fabric', englishName: 'curtain fabric', direction: 'materials' },
  ].map((product) => ({ ...product, status: 'approved', version: 1 }));
  const mailboxes = [
    {
      id: 'sales',
      email: 'sales@maker.example.org',
      website: 'https://maker.example.org',
      configured: true,
      dailyLimit: 20,
      smtpStatus: 'connected',
      displayName: 'Maker',
      signature: 'Maker',
      productIds: products.map((product) => product.id),
    },
  ];
  for (const [quote, demand, expected] of [
    [positive, 'curtain fabric', ['curtain fabric']],
    [negative, 'curtain fabric', []],
    [office, 'office stationery', []],
  ]) {
    const response = {
      company_name: evidence('North Shades', supply),
      entity_type: evidence('business', supply),
      products: [{ ...evidence('roller blinds', supply), window_use: 'window_covering' }],
      admission_facts: [evidence('complete_supply', supply)],
      demand_products: [{ ...evidence(demand, quote), window_use: 'window_covering' }],
    };
    const result = parseCompanyResearch(
      { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] },
      {
        source_url: pageUrl,
        page_text: supply + '\n' + quote,
        admission_version: 'website-admission-v1',
      },
      target,
    );
    assert.equal(result.eligibility.code, 'complete_supply');
    assert.deepEqual(result.demand_products, expected);
    assert.deepEqual(
      result.facts.filter((fact) => fact.field === 'demand_products').map((fact) => fact.value),
      expected,
    );
    const fields = researchFields(result, {});
    const assessment = assessCompany({ research: result, target, id: 'test-assessment' });
    const outreach = selectOutreachCandidates({
      products,
      mailboxes,
      campaign: { productScopes: products.map(outreachProductScope) },
      leads: [
        {
          id: 'north-shades',
          name: 'North Shades',
          website: pageUrl,
          status: '待开发',
          grade: assessment.grade,
          email: 'sales@north-shades.example.org',
          facts: assessment.facts,
        },
      ],
    });
    assert.equal(assessment.grade, 'B');
    assert.equal(Boolean(fields['需求产品']?.includes(quote)), expected.length > 0);
    assert.equal(assessment.reason.includes(quote), expected.length > 0);
    assert.deepEqual(
      outreach.eligible.map((candidate) => candidate.productId),
      [expected.length ? 'fabric' : 'finished'],
    );
  }
});

test('全窗饰范围允许庭院遮阳伞和窗用硬质外卷帘，排除仅防火挡烟帘', () => {
  for (const [product, quote, code, productMatch] of [
    [
      'patio umbrellas',
      'Sunline Shades supplies patio umbrellas for garden shade.',
      'complete_supply',
      'matched',
    ],
    [
      'external roller shutters',
      'Sunline Shades supplies external roller shutters for windows.',
      'complete_supply',
      'matched',
    ],
    [
      'fire curtains',
      'Sunline Shades supplies only fire curtains for smoke containment.',
      'excluded_use_only',
      'not_matched',
    ],
  ]) {
    const url = 'https://sunline-shades.example.org/';
    const fact = (value) => ({ value, quote, source_url: url });
    const research = parseCompanyResearch(
      {
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: {
                  company_name: fact('Sunline Shades'),
                  entity_type: fact('business'),
                  products: [
                    {
                      ...fact(product),
                      window_use: code === 'complete_supply' ? 'window_covering' : 'other',
                    },
                  ],
                  admission_facts: [fact(code)],
                },
              },
            ],
          },
        ],
      },
      { source_url: url, page_text: quote, admission_version: 'website-admission-v1' },
      { product_scope: 'all', product: 'window coverings' },
    );
    assert.deepEqual(
      [research.eligibility.code, research.product_match],
      [code, productMatch],
      product,
    );
  }
});
