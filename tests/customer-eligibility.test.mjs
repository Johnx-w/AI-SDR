import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { customerEligibility } from '../server/customer-eligibility.mjs';
import { companyResearchSchema, parseCompanyResearch } from '../server/company-research.mjs';
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

test('制造商按自产实际品类比较，同品类淘汰，不误杀采购配件的成品工厂', () => {
  const factory = {
    ...business,
    production_model: 'own_factory',
    manufactured_products: ['outdoor zip screens'],
  };
  assert.equal(
    customerEligibility(factory, { product: 'outdoor zip screens' }).code,
    'same_category_factory',
  );
  assert.equal(
    customerEligibility(factory, { product: 'outdoor blinds awnings components and parts' }).status,
    'eligible',
  );
  assert.equal(customerEligibility(factory, { product: 'Roman blinds' }).status, 'eligible');
  assert.equal(
    customerEligibility({ ...factory, manufactured_products: [] }, { product: 'zip screens' })
      .status,
    'insufficient_evidence',
  );
  assert.equal(
    customerEligibility(
      { ...factory, manufactured_products: ['awnings'] },
      { product: 'full cassette folding arm awnings' },
    ).code,
    'same_category_factory',
  );
});

test('Schema 中准入字段必填但允许无证据返回 null，数组独立引证', () => {
  for (const key of ['entity_type', 'production_model', 'operating_model', 'manufactured_products'])
    assert.ok(companyResearchSchema.required.includes(key), key);
  for (const key of ['entity_type', 'production_model', 'operating_model'])
    assert.equal(companyResearchSchema.properties[key].anyOf[1].type, 'null');
  assert.equal(
    companyResearchSchema.properties.manufactured_products.items.required.includes('quote'),
    true,
  );
});

test('兼容 n8n 的独立 Code 节点包含准入与品类依赖，可执行相同规则', () => {
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
    ).code,
    'same_category_factory',
  );
  const parsed = vm.runInNewContext(
    researchPolicyCode +
      '\n' +
      parseCompanyResearch.toString() +
      '\nparseCompanyResearch({choices:[{finish_reason:"stop",message:{content:"{}"}}]}, {source_url:"https://example.org/",page_text:""},target)',
    { target },
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.eligibility.status, 'insufficient_evidence');
});
