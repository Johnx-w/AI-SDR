import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMER_FIELD_ALIASES,
  BUSINESS_SCHEMA_VERSION,
  fieldValue,
  canonicalCustomerFields,
  resolveCustomerField,
  customerWebsite,
  assessmentSummaryFields,
} from '../server/customer-fields.mjs';

test('T2新旧字段统一读取，新名优先且保留飞书富文本值', () => {
  assert.equal(BUSINESS_SCHEMA_VERSION, 't2-t5-v1');
  for (const [oldName, currentName] of Object.entries(CUSTOMER_FIELD_ALIASES)) {
    const current = [{ text: '当前已核实值' }];
    assert.equal(fieldValue({ [oldName]: '旧值', [currentName]: current }, oldName), current);
    assert.equal(fieldValue({ [oldName]: '旧值', [currentName]: current }, currentName), current);
    assert.equal(fieldValue({ [oldName]: '旧值', [currentName]: [] }, oldName), '旧值');
    assert.equal(fieldValue({ [currentName]: current }, oldName), current);
  }
  assert.equal(fieldValue({ 最近研究时间: 0 }, '最近研究时间'), 0);
  assert.equal(fieldValue({}, '不存在的字段'), undefined);
});

test('T2内部字段转换不修改原始记录，并保留业务状态与新增摘要', () => {
  const fields = {
    用户评级: 'B',
    初评结果: 'A',
    企业经营产品: [{ text: 'roller blinds' }],
    开发状态: '人工跟进中',
    邮箱: 'buyer@example.org',
    企业官网: { text: 'Example', link: 'https://example.org/' },
    主要供货机会: '成品 · roller blinds（潜在供货机会）',
  };
  const before = structuredClone(fields);
  assert.deepEqual(canonicalCustomerFields(fields), {
    用户评级: 'A',
    相关产品: fields.企业经营产品,
    开发状态: fields.开发状态,
    邮箱: fields.邮箱,
    企业官网: fields.企业官网,
    主要供货机会: fields.主要供货机会,
  });
  assert.deepEqual(fields, before);
  assert.deepEqual(canonicalCustomerFields({}), {});
});

test('T2字段写入按实际表定义选择新名或旧名，缺失时不生成字段', () => {
  for (const [oldName, currentName] of Object.entries(CUSTOMER_FIELD_ALIASES)) {
    assert.equal(resolveCustomerField([{ field_name: oldName }], oldName), oldName);
    assert.equal(resolveCustomerField([{ field_name: currentName }], oldName), currentName);
    assert.equal(
      resolveCustomerField([{ field_name: oldName }, { field_name: currentName }], currentName),
      currentName,
    );
    assert.equal(resolveCustomerField([], oldName), undefined);
  }
});

test('T2企业官网独立于发现来源，兼容旧记录和飞书URL类型', () => {
  const fields = {
    企业官网: [{ text: 'https://supplier.example.org/' }],
    来源链接: 'https://trade.example.net/buyer/42',
  };
  assert.equal(customerWebsite(fields), 'https://supplier.example.org/');
  assert.equal(customerWebsite({ fields }), 'https://supplier.example.org/');
  assert.equal(
    customerWebsite({ 企业官网: { text: '公司官网', link: 'https://supplier.example.org/' } }),
    'https://supplier.example.org/',
  );
  assert.equal(
    customerWebsite({ 来源链接: { link: 'https://legacy.example.org/' } }),
    'https://legacy.example.org/',
  );
  assert.equal(
    customerWebsite({ 企业官网: '', 来源链接: 'https://legacy.example.org/' }),
    'https://legacy.example.org/',
  );
  assert.equal(customerWebsite(), '');
});

test('T2机会摘要分别保留供货方向，材料潜在关联不写成公开采购需求', () => {
  const summary = assessmentSummaryFields({
    direction: 'finished',
    product: 'roller blinds',
    opportunities: [
      { direction: 'finished', product: 'roller blinds', grade: 'A' },
      { direction: 'finished', product: 'ROLLER BLINDS', grade: 'A' },
      { direction: 'materials', product: 'aluminum profiles', status: '待核实' },
      { direction: 'samples', product: 'sample books', status: '暂不开发' },
    ],
    missing: ['经营年限待核实', '经营年限待核实'],
    incompleteReason: '官网部分页面未取得',
    supplyOpportunity: {
      kind: 'potential_input',
      targetProduct: 'roller blind fabrics',
      procurementStatus: 'unconfirmed',
      note: '材料采购方式待沟通',
    },
  });
  assert.equal(summary.主要供货机会.split('\n').length, 3);
  assert.match(summary.主要供货机会, /成品 · roller blinds（潜在供货机会）/);
  assert.match(summary.主要供货机会, /材料配件 · aluminum profiles（适配待核实/);
  assert.match(summary.主要供货机会, /roller blind fabrics.*采购需求未确认/);
  assert.doesNotMatch(summary.主要供货机会, /sample books/);
  assert.equal(
    summary.待确认事项,
    '经营年限待核实；研究限制：官网部分页面未取得；材料采购方式待沟通',
  );
  assert.deepEqual(Object.keys(summary), ['主要供货机会', '待确认事项']);
});

test('T2未知内容不补造机会，已完成研究可清除旧缺项摘要', () => {
  assert.deepEqual(assessmentSummaryFields(null), {});
  assert.deepEqual(assessmentSummaryFields({ target: { product: 'not verified' } }), {
    主要供货机会: '',
    待确认事项: '',
  });
  assert.deepEqual(assessmentSummaryFields({ direction: 'finished', product: 'roller blinds' }), {
    主要供货机会: '成品 · roller blinds（潜在供货机会）',
    待确认事项: '',
  });
});
