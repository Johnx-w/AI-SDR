import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';

const source_url = 'https://fixmyblinds.com/';
const quote = 'At Fix My Blinds, we offer replacement parts and string for blinds and shades.';
const product = 'replacement parts and string for blinds and shades';
const labels = ['Cord, String &amp; Loops', 'Tilt Mechanisms', 'Mounting Brackets'];
const evidence = (value, text = quote) => ({ value, quote: text, source_url });
const target = {
  product_scope: 'all',
  product: 'window coverings',
  country: 'United States',
  market_countries: ['United States'],
  audience: 'BC',
  query_mode: 'auto',
};

test('历史配件目录恢复用途后正常入库、读回并保留待核实国家和初始 C 级', async () => {
  const records = [];
  const calls = { model: 0, write: 0, readback: 0 };
  const store = new AcquisitionStore(':memory:', 'accessory-regression');
  const service = new NativeAcquisition({
    env: {
      TAVILY_API_KEY: 'fixture-search',
      DEEPSEEK_API_KEY: 'fixture-model',
      FEISHU_APP_ID: 'fixture-app',
      FEISHU_APP_SECRET: 'fixture-secret',
      FEISHU_APP_TOKEN: 'fixture-table',
      FEISHU_TABLE_ID: 'fixture-id',
    },
    store,
    readPage: async () => ({ html: `<p>${quote}</p><p>${labels.join('</p><p>')}</p>` }),
    providers: {
      web: {
        extract: async () => assert.fail('不允许提取服务请求'),
        search: async () => assert.fail('不允许搜索服务请求'),
      },
      model: {
        research: async () => {
          calls.model++;
          return {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    company_name: evidence('Fix My Blinds'),
                    entity_type: evidence('business'),
                    products: labels.map((label) => evidence(label, label)),
                    actual_country: null,
                    demand_products: [],
                    assessment_opportunities: [],
                  }),
                },
              },
            ],
          };
        },
      },
    },
    feishu: {
      records: async () => structuredClone(records),
      fields: async () => [
        ...[
          '公司名称',
          '来源链接',
          '企业官网',
          'customer_id',
          '主体类型',
          '客户类型',
          '相关产品',
          '需求产品',
          '广告代码',
          '客户行业画像',
          '国家',
          '开发状态',
          '评级依据',
          '主要供货机会',
          '待确认事项',
        ].map((field_name) => ({ field_name, type: 1 })),
        { field_name: '首次发现时间', type: 5 },
        { field_name: '最近研究时间', type: 5 },
        { field_name: '用户评级', type: 3 },
      ],
      write: async (action, fields) => {
        assert.equal(action, 'insert');
        calls.write++;
        const record = { record_id: 'rec-accessory', fields: structuredClone(fields) };
        records.push(record);
        return structuredClone(record);
      },
      record: async (id) => {
        calls.readback++;
        return structuredClone(records.find((record) => record.record_id === id));
      },
    },
    fetchImpl: async () => assert.fail('不允许外部网络请求'),
  });
  try {
    const item = { source_url, operation_id: 'accessory-admission-regression' };
    const output = await service.research(target, item);
    assert.equal(output.outcome, 'completed', output.reason);
    assert.equal(output.新增, 1);
    assert.equal(output.更新, 0);
    assert.equal(output.research.product_match, 'matched');
    assert.ok(output.research.products.includes(product));
    assert.ok(output.research.products.includes('Tilt Mechanisms'));
    assert.deepEqual(output.research.demand_products, []);
    assert.equal(output.research.actual_country, null);
    assert.equal(output.research.country_match, 'unknown');
    assert.equal(records.length, 1);
    assert.equal(records[0].fields.国家, undefined);
    assert.equal(records[0].fields.需求产品, undefined);
    assert.ok(records[0].fields.相关产品.includes(product));
    assert.equal(mapFeishuRecord(records[0]).market, '待核实');
    assert.equal(records[0].fields.用户评级, 'C');

    const assessment = service.assessmentHistory('rec-accessory').assessment;
    assert.equal(assessment.grade, 'C');
    assert.equal(assessment.direction, 'materials');
    assert.equal(assessment.product, product);
    assert.equal(assessment.score, 55);
    assert.equal(assessment.complete, false);
    assert.equal(assessment.opportunities.length, 1);
    assert.equal(assessment.dimensions.D.score, null);
    assert.equal(assessment.dimensions.V.score, null);
    assert.equal(assessment.supplyOpportunity, null);
    assert.ok(
      !assessment.opportunities.some((opportunity) => opportunity.direction === 'finished'),
    );
    assert.deepEqual(
      assessment.facts.find((fact) => fact.field === 'products' && fact.value === product),
      { field: 'products', ...evidence(product) },
    );
    assert.ok(calls.readback > 0);
    assert.deepEqual(await service.research(target, item), output);
    assert.equal(calls.write, 1);
    assert.equal(calls.model, 1);
  } finally {
    service.close();
  }
});
