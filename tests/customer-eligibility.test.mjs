import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { customerEligibility } from '../server/customer-eligibility.mjs';
import { companyResearchSchema } from '../server/company-research.mjs';
import { researchPolicyCode } from '../scripts/research-policy-code.mjs';

const business = {
  entity_type: 'business',
  production_model: 'no_own_factory',
  operating_model: 'beyond_local',
};

test('企业面向 B、C 或 BC 不影响全局准入，个人消费者始终淘汰', () => {
  for (const audience of ['B', 'C', 'BC']) {
    const target = { product: 'outdoor zip screens', audience };
    assert.equal(customerEligibility(business, target).status, 'eligible');
    assert.equal(
      customerEligibility({ ...business, entity_type: 'individual' }, target).code,
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

test('兼容 n8n 的独立 Code 节点执行相同的企业主体准入规则', () => {
  const run = (subject, target) =>
    vm.runInNewContext(researchPolicyCode + '\ncustomerEligibility(subject,target)', {
      subject,
      target,
    });
  const target = { product: 'outdoor zip screens' };
  assert.equal(run(business, target).status, 'eligible');
  assert.equal(run({ ...business, entity_type: 'individual' }, target).code, 'individual_consumer');
  assert.equal(
    run(
      { ...business, production_model: 'own_factory', manufactured_products: ['Ziptrak'] },
      target,
    ).status,
    'eligible',
  );
});
