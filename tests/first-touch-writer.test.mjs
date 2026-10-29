import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createOutreachGenerator,
  eligibleOutreachFacts,
  outreachMaterialVersion,
  outreachProductScope,
  selectOutreachCandidates,
} from '../server/outreach-content.mjs';

const policy = JSON.parse(
  readFileSync(
    new URL('../agents/first-touch-writer/confirmed-supply.json', import.meta.url),
    'utf8',
  ),
);
const env = {
  RESEARCH_MODEL_PROVIDER: 'openai_compatible',
  RESEARCH_MODEL_BASE_URL: 'https://model.example/v1',
  RESEARCH_MODEL_API_KEY: 'test-key',
  RESEARCH_MODEL_MODEL: 'test-model',
};
const readyReview = { decision: 'ready', summary: '合格', strengths: [], issues: [] };
const isReview = (request) => request.messages[0].content.includes('independent reviewer');

function fixture(brand = policy.brands[0], scope = brand.products[1] || brand.products[0]) {
  const product = {
    id: 'product',
    version: 1,
    status: 'approved',
    name: scope.name,
    englishName: scope.name,
    brands: [brand.name],
    direction: scope.direction,
    category: brand.name === 'Shuangsheng Shutter' ? 'ventilation' : 'indoor',
  };
  const mailbox = {
    id: 'sender',
    brandName: brand.name,
    website: `https://${brand.domain}`,
    email: `sales@${brand.domain}`,
    productIds: [product.id],
    signature: `Best regards,\nSender Name\n${brand.name}`,
  };
  const campaign = { generationMode: 'simple', productScopes: [outreachProductScope(product)] };
  const candidate = {
    customerId: 'customer',
    companyName: 'Example Dealer',
    mailboxId: mailbox.id,
    productId: product.id,
    productVersion: product.version,
    evidence: [
      {
        id: 'source',
        value: scope.name,
        quote: `We sell ${scope.name}.`,
        sourceUrl: 'https://buyer.example/products',
      },
    ],
  };
  const draft = {
    subject: `${scope.name} Supply Cooperation`,
    body_text: [
      `I noticed that your website includes ${scope.name} in your product range. This provides a relevant starting point for introducing our business and exploring a possible supply relationship with your team.`,
      `We are ${brand.name}, and we manufacture and supply ${scope.name}. I am writing to introduce our business as a potential supplier for this category. Any further discussion would be based on your requirements, so both teams can assess whether there is a suitable fit before considering next steps.`,
      `Would your team be open to considering an additional supplier for ${scope.name}?`,
    ].join('\n\n'),
    source_ids: ['source'],
  };
  return { input: { candidate, product, mailbox, campaign }, draft };
}

async function generate(input, draft, inspect = () => {}) {
  const generator = createOutreachGenerator({
    env,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (!isReview(request)) inspect(request);
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify(isReview(request) ? readyReview : draft) },
          },
        ],
      });
    },
  });
  return generator.generate(input);
}

test('三个品牌在已确认的产品范围内使用制造商事实，记录依据且不传入凭证或未经确认参数', async () => {
  for (const brand of policy.brands) {
    const { input, draft } = fixture(brand);
    input.mailbox.clientPassword = 'private-mail-secret';
    input.product.moq = 'private-unconfirmed-moq';
    input.product.aliases = ['private-unconfirmed-alias'];
    let sender;
    const result = await generate(input, draft, (request) => {
      assert.ok(!JSON.stringify(request).includes('private-'));
      sender = JSON.parse(request.messages[1].content).sender;
    });
    assert.equal(sender.manufacturing_confirmed, true);
    assert.match(result.bodyText, /we manufacture and supply/);
    assert.equal(result.bodyText.startsWith('Hello Example Dealer Team,\n\n'), true);
    assert.equal(result.bodyText.includes('Sender Name'), false);
    assert.equal(result.bodyText.includes('Best regards,'), false);
    assert.equal(result.factIds.length, 2);
    const savedFacts = eligibleOutreachFacts(input.product, input.campaign);
    assert.ok(savedFacts.some((f) => f.id === result.factIds[1] && f.text.includes(brand.name)));
    assert.equal(result.materialVersion, outreachMaterialVersion(input.product, input.campaign));
    assert.ok(
      sender.facts.every((f) => !policy.brands.some((b) => b !== brand && f.text.includes(b.name))),
    );
  }
});

test('室内大类只提供业务已确认的细分产品，计划产品范围撤回后不调用模型', async () => {
  const { input, draft } = fixture();
  input.candidate.evidence[0].value = 'Cellular Shades';
  input.candidate.evidence[0].quote = 'We sell cellular shades and roller shades.';
  await generate(input, draft, (request) => {
    const context = JSON.parse(request.messages[1].content);
    assert.equal(context.sender.focus_product, 'cellular shades');
    assert.ok(context.sender.confirmed_product_types.includes('roller shades'));
    assert.ok(!context.sender.confirmed_product_types.includes('motorized roller shades'));
    assert.deepEqual(context.customer.evidence, input.candidate.evidence);
  });
  input.candidate.evidence[0].value = 'Cellular shades and roller shades';
  await generate(input, draft, (request) => {
    assert.equal(
      JSON.parse(request.messages[1].content).sender.focus_product,
      input.product.englishName,
    );
  });
  input.campaign.productScopes = [];
  let calls = 0;
  await assert.rejects(
    generate(input, draft, () => calls++),
    { code: 'outreach_snapshot_stale' },
  );
  assert.equal(calls, 0);
});

test('写作格式只修订一次，修订结果继续通过同样的事实检查', async () => {
  for (const mode of ['repaired', 'still-invalid', 'unsupported']) {
    const { input, draft } = fixture();
    let calls = 0;
    const generator = createOutreachGenerator({
      env,
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        if (isReview(request))
          return Response.json({
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(readyReview) } }],
          });
        calls++;
        if (calls === 2) {
          assert.equal(request.messages.at(-2).role, 'assistant');
          assert.match(request.messages.at(-1).content, /exactly three paragraphs/);
        }
        const result =
          calls === 1 || mode === 'still-invalid'
            ? { ...draft, body_text: draft.body_text.replaceAll('\n\n', ' ') }
            : mode === 'unsupported'
              ? { ...draft, body_text: 'We have certified products. ' + draft.body_text }
              : draft;
        return Response.json({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
        });
      },
    });
    if (mode === 'repaired') assert.ok((await generator.generate(input)).bodyText.includes('\n\n'));
    else
      await assert.rejects(generator.generate(input), {
        code: mode === 'unsupported' ? 'outreach_unsupported_claim' : 'outreach_generation_invalid',
      });
    assert.equal(calls, mode === 'still-invalid' ? 3 : 2);
  }
});

test('批量生成先评审，只有评审通过的草稿才能返回排队', async () => {
  const { input, draft } = fixture();
  input.mailbox.clientPassword = 'never-send-secret';
  let writerCalls = 0,
    reviewCalls = 0;
  const revised = {
    ...draft,
    body_text: draft.body_text.replace(
      'This provides a relevant starting point for introducing our business',
      'This is the product that prompted our introduction',
    ),
  };
  const generator = createOutreachGenerator({
    env,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const reviewer = isReview(request);
      let content;
      if (reviewer) {
        reviewCalls++;
        const context = JSON.parse(request.messages[1].content);
        assert.equal(context.customer.name, 'Example Dealer');
        assert.equal(context.draft.greeting, 'Hello Example Dealer Team,');
        assert.ok(!JSON.stringify(context).includes('never-send-secret'));
        assert.ok(!JSON.stringify(context).includes('Sender Name'));
        assert.deepEqual(
          context.customer.evidence.map((entry) => entry.id),
          ['source'],
        );
        assert.equal(context.sender.approved_facts.length, 2);
        content =
          reviewCalls === 1
            ? {
                decision: 'revise',
                summary: '删去重复',
                strengths: [],
                issues: [
                  {
                    severity: 'improve',
                    quote: 'This provides a relevant starting point',
                    reason: '表述空泛',
                    recommendation: '改成直接说明切入点',
                  },
                ],
              }
            : readyReview;
      } else {
        writerCalls++;
        if (writerCalls === 2) {
          assert.equal(request.messages.at(-2).role, 'assistant');
          assert.match(request.messages.at(-1).content, /表述空泛/);
        }
        content = writerCalls === 1 ? draft : revised;
      }
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
      });
    },
  });
  const result = await generator.generate(input);
  assert.equal(writerCalls, 2);
  assert.equal(reviewCalls, 2);
  assert.ok(result.bodyText.includes('This is the product that prompted our introduction'));
  assert.equal(result.bodyText.includes('Sender Name'), false);
});

test('评审阻断、资料不足或结果无效时不返回可发送正文', async () => {
  for (const mode of ['block', 'insufficient_evidence', 'invalid', 'empty_revision']) {
    const { input, draft } = fixture();
    let writerCalls = 0,
      reviewCalls = 0;
    const generator = createOutreachGenerator({
      env,
      fetchImpl: async (_url, options) => {
        const reviewer = isReview(JSON.parse(options.body));
        let content = draft;
        if (reviewer) {
          reviewCalls++;
          content =
            mode === 'block'
              ? {
                  decision: 'block',
                  summary: '事实不足',
                  strengths: [],
                  issues: [
                    {
                      severity: 'blocking',
                      quote: `We are ${input.mailbox.brandName}`,
                      reason: '身份未确认',
                      recommendation: '删除',
                    },
                  ],
                }
              : mode === 'insufficient_evidence'
                ? {
                    decision: 'insufficient_evidence',
                    summary: '来源不足',
                    strengths: [],
                    issues: [],
                  }
                : mode === 'empty_revision'
                  ? { decision: 'revise', summary: '需要修改', strengths: [], issues: [] }
                  : {
                    decision: 'ready',
                    summary: '通过',
                    strengths: [],
                    issues: [
                      {
                        severity: 'improve',
                        quote: 'invented quote',
                        reason: '无依据',
                        recommendation: '删除',
                      },
                    ],
                  };
        } else writerCalls++;
        return Response.json({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
        });
      },
    });
    await assert.rejects(generator.generate(input), {
      code:
        mode === 'invalid' || mode === 'empty_revision'
          ? 'outreach_review_invalid'
          : 'outreach_review_not_ready',
    });
    assert.equal(writerCalls, mode === 'block' ? 3 : 1);
    assert.equal(reviewCalls, mode === 'block' ? 3 : 1);
  }
});

test('未知品牌、错误域名、未确认产品与采购形态不能继承制造商身份', async () => {
  for (const alter of [
    (x) => {
      x.mailbox.brandName = 'Another Brand';
    },
    (x) => {
      x.mailbox.email = 'sales@another.example';
    },
    (x) => {
      x.mailbox.website = 'https://another.example';
    },
    (x) => {
      x.product.englishName = 'Motorized Indoor Blinds';
    },
    (x) => {
      x.product.direction = 'materials';
    },
    (x) => {
      x.product.brands = ['Another Brand'];
    },
    (x) => {
      x.product.brands.push('Another Brand');
    },
  ]) {
    const { input, draft } = fixture();
    alter(input);
    input.campaign.productScopes = [outreachProductScope(input.product)];
    await assert.rejects(
      generate(input, draft, (request) => {
        const sender = JSON.parse(request.messages[1].content).sender;
        assert.equal(sender.manufacturing_confirmed, false);
        assert.deepEqual(sender.confirmed_product_types, []);
        assert.equal(sender.facts.length, 1);
      }),
      { code: 'outreach_unsupported_claim' },
    );
    const supplierDraft = {
      ...draft,
      body_text: draft.body_text.replace('manufacture and supply', 'supply'),
    };
    // Keep the fallback test about identity, rather than introducing another known brand.
    supplierDraft.body_text = supplierDraft.body_text.replace(
      policy.brands[0].name,
      input.mailbox.brandName,
    );
    assert.ok((await generate(input, supplierDraft)).bodyText.includes('we supply'));
  }
});

test('来源缺失在调用前阻止生成，伪造或重复来源及不符合字数和提问规则的结果不进入发送', async () => {
  const { input, draft } = fixture();
  let calls = 0;
  await assert.rejects(
    generate({ ...input, candidate: { ...input.candidate, evidence: [] } }, draft, () => calls++),
    { code: 'outreach_evidence_missing' },
  );
  assert.equal(calls, 0);
  for (const changes of [
    { source_ids: [] },
    { source_ids: ['invented'] },
    { source_ids: ['source', 'source'] },
    { subject: 'Re: Supply cooperation' },
    { body_text: 'Would you consider us as a supplier?' },
    { body_text: draft.body_text + ' More words.'.repeat(30) },
    { body_text: draft.body_text.replaceAll('\n\n', ' ') },
    {
      body_text: draft.body_text.replace('manufacture and supply', 'supply our confirmed range of'),
    },
    { body_text: draft.body_text + '\n\nWho is the right contact?' },
    { body_text: draft.body_text + '\n\nBest regards, Sales' },
    { body_text: draft.body_text.replace('\n\nWould', '\nSincerely,\nSender Name\n\nWould') },
    { body_text: 'Dear Example Dealer Team,\n\n' + draft.body_text },
  ])
    await assert.rejects(generate(input, { ...draft, ...changes }), {
      code: 'outreach_generation_invalid',
    });
});

test('工厂身份不放行认证、价格、交期、其他品牌或虚构采购意愿', async () => {
  const { input, draft } = fixture();
  for (const unsupported of [
    'We have ISO certification.',
    'We offer the lowest prices.',
    'Our MOQ is 10 sets.',
    'Our delivery is guaranteed.',
    'We have stock available.',
    'We focus on Plantation Shutters.',
    'Please see the attached catalog.',
    'We also represent Honey Badger Blinds.',
    'You are looking for a new supplier.',
  ])
    await assert.rejects(
      generate(input, { ...draft, body_text: unsupported + ' ' + draft.body_text }),
      { code: 'outreach_unsupported_claim' },
    );
});

test('没有获准产品或双方产品不匹配时不产生可写作候选', () => {
  const { input } = fixture();
  const lead = {
    id: 'customer',
    name: 'Example Dealer',
    website: 'https://buyer.example',
    status: '待开发',
    email: 'info@buyer.example',
    facts: [
      {
        field: 'entity_type',
        value: 'business',
        quote: 'We are a business.',
        source_url: 'https://buyer.example/about',
      },
      {
        field: 'products',
        value: 'curtain tracks',
        quote: 'We sell curtain tracks.',
        source_url: 'https://buyer.example/products',
      },
    ],
    contactEvidence: [
      {
        kind: 'email',
        value: 'info@buyer.example',
        quote: 'Contact info@buyer.example',
        source_url: 'https://buyer.example/contact',
      },
    ],
  };
  for (const products of [[], [input.product]]) {
    const result = selectOutreachCandidates({
      leads: [lead],
      products,
      mailboxes: [input.mailbox],
      campaign: input.campaign,
    });
    assert.equal(result.eligible.length, 0);
    assert.equal(result.blocked[0].reasonCode, 'product_match_unconfirmed');
  }
});
