import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { companyResearchRequest, parseCompanyResearch } from '../server/company-research.mjs';
import { verifiedAssessmentOpportunities } from '../server/assessment-evidence.mjs';
import { researchPolicyCode } from '../scripts/research-policy-code.mjs';
import { compactResearchText, RESEARCH_GAP } from '../server/research-text.mjs';
import { boundedResearchPages } from '../server/research-input.mjs';
import { thirdPartyCompanySource } from '../server/website-identity.mjs';

const source = 'https://blinds.example.org/';
const identity =
  'Example Blinds Ltd supplies parts for roller blinds and trades as Example Shades.';
const target = { product_scope: 'all', product: 'window coverings', country: 'United States' };
const evidence = (value, quote, source_url = source) => ({ value, quote, source_url });
const response = (raw) => ({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }],
});

async function collect(html, source_url = source) {
  const store = new AcquisitionStore(':memory:', 'compaction');
  let reads = 0;
  const service = new NativeAcquisition({
    env: {},
    store,
    providers: { web: { extract: async () => assert.fail('Unexpected paid extract') } },
    readPage: async () => {
      reads++;
      return { html };
    },
    fetchImpl: async () => assert.fail('Unexpected network request'),
  });
  try {
    return { ...(await service.collect(source_url)), reads };
  } finally {
    service.close();
  }
}

test('重复导航页脚先精简，中部身份及配件用途进入实际模型正文，完整联系证据保留', async () => {
  const result = await collect(
    '<nav>' +
      '<p>Home Products About Contact</p>'.repeat(500) +
      '</nav><main><p>' +
      identity +
      '</p></main><footer>' +
      '<p>Cookie settings and website policy information.</p>'.repeat(450) +
      '<a href="mailto:public@blinds.example.org">Email</a></footer>',
  );
  assert.ok(result.research_pages[0].text.includes(identity));
  assert.ok(result.input_stats.inputChars < 1500);
  assert.ok(result.input_stats.originalChars > 30000);
  assert.ok(result.input_stats.compactedChars > 30000);
  assert.equal(result.reads, 1);
  assert.ok(result.website_metadata.contacts.some((c) => c.value === 'public@blinds.example.org'));
  assert.deepEqual(
    JSON.parse(companyResearchRequest(result, target).messages[1].content).pages,
    result.research_pages,
  );
  const research = parseCompanyResearch(
    response({
      company_name: evidence('Example Blinds Ltd', identity),
      entity_type: evidence('business', identity),
      products: [evidence('parts for roller blinds', identity)],
    }),
    result,
    target,
  );
  assert.equal(research.company_name, 'Example Blinds Ltd');
  assert.equal(research.product_match, 'matched');
});

test('法律页压缩模板但保留中部法人、地址、商号、用途及否定', async () => {
  const legal = source + 'privacy-policy';
  const company = 'Example Blinds Ltd operates this website and trades as Example Shades.';
  const address = 'Our registered office is 123 Main Street, Dallas, TX 75001, United States.';
  const negative = 'We do not sell outdoor blinds; we supply replacement parts for roller blinds.';
  const boilerplate = Array.from(
    { length: 100 },
    (_, i) =>
      `<p>We use cookies and personal data to understand browser activity for ${i} days.</p>`,
  ).join('');
  const result = await collect(
    '<h1>Privacy Policy</h1>' +
      boilerplate +
      [company, address, negative].map((line) => '<p>' + line + '</p>').join('') +
      boilerplate,
    legal,
  );
  const text = result.research_pages[0].text;
  for (const quote of [company, address, negative]) assert.ok(text.includes(quote), quote);
  assert.ok(text.length < 2000);
  assert.ok(result.input_stats.compactedChars > 10000);
});

test('短页、非模板正文、产品目录及第三方归属标题保持原文', async () => {
  for (const text of [
    'We supply roller blind motors.',
    '窗帘配件\n我们供应百叶帘调节机构和卷帘拉绳。\n我们不供应汽车电机。',
    'Our Partners\nWe supply parts for roller blinds.\n' + identity,
    'Products\nCord, String & Loops\nTilt Mechanisms\n' + identity,
    'Unfamiliar legal language that cannot be reliably classified should remain intact.',
  ]) {
    const result = await collect(text);
    assert.equal(result.research_pages[0].text, text);
    assert.equal(result.input_stats.compactedChars, 0);
  }
});

test('跨正文重复的短菜单仅保留一份，不删除完整目录、第三方归属或新产品描述', async () => {
  const menu = 'Home\nProducts\nCord, String & Loops\nTilt Mechanisms\nContact';
  const company = 'Example Blinds Ltd supplies roller blinds.';
  const partner = 'Our Partners\nWe supply parts for roller blinds.';
  const result = await collect(menu + '\n' + company + '\n' + menu + '\n' + partner);
  const text = result.research_pages[0].text;
  assert.equal(text.split('Cord, String & Loops').length, 2);
  assert.ok(text.includes(company));
  assert.ok(text.includes(partner));
  const research = parseCompanyResearch(
    response({
      company_name: evidence('Example Blinds Ltd', company),
      products: [evidence('parts', 'We supply parts for roller blinds.')],
    }),
    result,
    target,
  );
  assert.equal(research.product_match, 'unknown');
  assert.ok(!research.products.includes('parts for roller blinds'));
  assert.equal(compactResearchText(text, source), text);
});

test('重复的第三方标题不与其供货陈述分离，法律页来源声明及邮政地址保留', async () => {
  const supply = 'We supply replacement parts for roller blinds.';
  const company = 'Example Blinds Ltd supplies roller blinds.';
  const text = company + '\n' + 'News\n'.repeat(5) + supply;
  const result = await collect(text);
  const research = parseCompanyResearch(
    response({
      company_name: evidence('Example Blinds Ltd', company),
      products: [evidence('replacement parts for roller blinds', supply)],
    }),
    result,
    target,
  );
  assert.deepEqual(research.products, []);
  const privacy =
    'Privacy Policy\nAll the content is user posted. Personal data is collected for analytics.\n' +
    identity;
  const kept = compactResearchText(privacy, source + 'privacy-policy');
  assert.equal(thirdPartyCompanySource({ text: kept }), true);
  const address = 'For personal data requests write to 12 Bay St, Dallas, TX 75001, United States.';
  assert.ok(
    compactResearchText(
      'Privacy Policy\n' + identity + '\n' + address + '\nWe use analytics to improve browsing.',
      source + 'privacy-policy',
    ).includes(address),
  );
});

test('历史目录父子同名标签的连续引文保留，窗帘产品与初评事实不丢失', async () => {
  const company = 'Example Blinds Ltd supplies roller blinds.';
  const quote = 'CURTAINS\nCURTAINS\nView All\nBLACKOUT CURTAINS';
  const result = await collect(company + '\n' + quote + '\nOther products');
  const research = parseCompanyResearch(
    response({
      company_name: evidence('Example Blinds Ltd', company),
      products: [evidence('Curtains', quote)],
      assessment_opportunities: [
        {
          direction: 'finished',
          product: 'Curtains',
          facts: [{ kind: 'core_product', ...evidence('Curtains', quote) }],
        },
      ],
    }),
    result,
    target,
  );
  assert.deepEqual(research.products, ['Curtains']);
  assert.equal(research.assessment_opportunities[0].facts.length, 1);
});

test('预算删节和正文精简共用原文边界，不拆Unicode，删除处不能作为原文引用', () => {
  const left = 'Example Blinds Ltd supplies roller blinds.';
  const right = 'We also supply curtains.';
  const bounded = boundedResearchPages([
    { source_url: source, text: left + '\n' + '😀'.repeat(10000) + '\n' + right },
  ]);
  assert.ok(bounded.pages[0].text.includes(RESEARCH_GAP));
  assert.ok(bounded.stats.inputChars <= 16000);
  assert.ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      bounded.pages[0].text,
    ),
  );
  const forged = parseCompanyResearch(
    response({
      products: [evidence('roller blinds', bounded.pages[0].text)],
    }),
    { source_url: source, research_pages: bounded.pages },
    target,
  );
  assert.deepEqual(forged.products, []);
});

test('精简缺口不能拼接为企业、必需条件、评级或兼容工作流引文', async () => {
  const left = 'Example Blinds Ltd supplies roller blinds.';
  const right = 'We serve trade customers nationwide.';
  const result = await collect('<p>' + left + '</p><p>Accept all cookies</p><p>' + right + '</p>');
  const joined = left + '\nAccept all cookies\n' + right;
  assert.ok(!result.research_pages[0].text.includes('Accept all cookies'));
  for (const quote of [left + ' ' + right, result.research_pages[0].text, joined]) {
    const raw = {
      company_name: evidence('Example Blinds Ltd', quote),
      products: [evidence('roller blinds', quote)],
      requirement_checks: [
        { condition: '全国供货', verdict: 'matched', quote, source_url: source },
      ],
    };
    const input = { ...target, required_requirements: ['全国供货'] };
    for (const research of [
      parseCompanyResearch(response(raw), result, input),
      vm.runInNewContext(
        researchPolicyCode +
          '\n' +
          parseCompanyResearch.toString() +
          '\nparseCompanyResearch(response,page,target)',
        { response: response(raw), page: result, target: input },
      ),
    ]) {
      assert.equal(research.company_name, null);
      assert.deepEqual(Array.from(research.products), []);
      assert.equal(research.required_match, 'unknown');
    }
    const opportunities = verifiedAssessmentOpportunities(
      [
        {
          direction: 'finished',
          product: 'roller blinds',
          facts: [{ kind: 'core_product', value: 'roller blinds', quote, source_url: source }],
        },
      ],
      result.research_pages,
      target,
      ['roller blinds'],
      [{ field: 'products', ...evidence('roller blinds', left) }],
    );
    assert.ok(opportunities.every((opportunity) => opportunity.facts.length === 0));
  }
  const valid = parseCompanyResearch(
    response({
      company_name: evidence('Example Blinds Ltd', left),
      products: [evidence('roller blinds', left)],
    }),
    result,
    target,
  );
  assert.equal(valid.company_name, 'Example Blinds Ltd');
});
