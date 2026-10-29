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
      `I noticed your website lists ${scope.name} among the window furnishings you offer to customers.`,
      `At ${brand.name}, we manufacture and supply ${scope.name} from China for window furnishing businesses. I am reaching out to introduce another supply option for this part of your range.`,
      `Would a short product introduction be useful to your team?`,
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
      inspect(request);
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify(draft) },
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
    assert.equal(sender.origin_country, 'China');
    assert.match(result.bodyText, /we manufacture and supply/);
    assert.equal(result.bodyText.startsWith('Hi Example Dealer team,\n\n'), true);
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
    assert.equal(calls, 2);
  }
});

test('合格首封仅调用一次撰写模型，通过程序检查后直接返回', async () => {
  const { input, draft } = fixture();
  let calls = 0;
  const result = await generate(input, draft, () => calls++);
  assert.equal(calls, 1);
  assert.equal(result.subject, draft.subject);
  assert.equal(result.bodyText, `Hi Example Dealer team,\n\n${draft.body_text}`);
  assert.deepEqual(result.sourceIds, draft.source_ids);
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
        assert.equal(sender.origin_country, null);
        assert.deepEqual(sender.confirmed_product_types, []);
        assert.equal(sender.facts.length, 1);
      }),
      { code: 'outreach_unsupported_claim' },
    );
    const supplierDraft = {
      ...draft,
      body_text: draft.body_text
        .replace('manufacture and supply', 'supply')
        .replace(' from China', ''),
    };
    // Keep the fallback test about identity, rather than introducing another known brand.
    supplierDraft.body_text = supplierDraft.body_text.replace(
      policy.brands[0].name,
      input.mailbox.brandName,
    );
    assert.ok((await generate(input, supplierDraft)).bodyText.includes('we supply'));
  }
});

test('身份不匹配时不能仅把制造商改成供应商就保留从中国供货表述', async () => {
  const { input, draft } = fixture();
  input.mailbox.email = 'sales@another.example';
  draft.body_text = draft.body_text.replace('manufacture and supply', 'supply');
  await assert.rejects(generate(input, draft), { code: 'outreach_unsupported_claim' });
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
