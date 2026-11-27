import { outreachProductScope, selectOutreachCandidates } from '../server/outreach-content.mjs';
import { generateFollowUp } from '../server/outreach-follow-ups.mjs';
import { renderMailboxSignature } from '../src/domain/mail-signature.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { handleOutreach } from '../server/outreach-api.mjs';
import { categoryPreviewFixture } from './fixtures/category-preview.mjs';
function api(h, path, method = 'GET', body) {
  return handleOutreach({
    request: { method },
    url: new URL('/api/v1/outreach' + path, 'http://localhost'),
    service: h.service,
    readJson: async () => body,
  });
}
test('固定首封与跟进预览不调用模型，AI 步骤只生成当前邮件', async (t) => {
  const h = categoryPreviewFixture(0);
  t.after(h.close);
  const fixedFirst = { subject: 'Introduction | {{company}}', body: 'We supply {{product}}.' };
  const fixedFollow = { subject: '', body: 'Following up on {{product}} from {{brand}}.' };
  const aiFirst = { subject: '{{ai_subject}}', body: '{{ai_body}}' };
  const aiFollow = { subject: '', body: '{{ai_body}}' };
  for (const [box, category] of [
    [h.boxes[0], 'manufacturer'],
    [h.boxes[1], 'distributor'],
  ]) {
    const scope = { mailboxId: box.id, category };
    const sample = await api(h, '/sequence-policy/sample?' + new URLSearchParams(scope));
    const original = h.leads.find((lead) => lead.id === sample.id);
    const product = h.products.find((item) => item.id === sample.productId);
    const preview = (params) =>
      api(h, '/sequence-policy/preview', 'POST', {
        ...scope,
        sampleId: sample.id,
        instruction: '',
        ...params,
      });
    const before = h.requests.length;
    const first = await preview({ step: 0, day: 0, template: fixedFirst });
    assert.equal(first.subject, 'Introduction | ' + original.name);
    assert.equal(
      first.body,
      [
        'Hi ' + original.name + ' team,',
        'We supply ' + product.englishName + '.',
        box.signature,
      ].join('\n\n'),
    );
    const second = await preview({
      step: 1,
      day: 3,
      template: fixedFollow,
      firstTemplate: fixedFirst,
      priorSteps: [],
    });
    assert.equal(second.subject, 'Re: Introduction | ' + original.name);
    assert.equal(
      second.body,
      [
        'Hi ' + original.name + ' team,',
        'Following up on ' + product.englishName + ' from ' + box.brandName + '.',
        box.signature,
      ].join('\n\n'),
    );
    const third = await preview({
      step: 2,
      day: 7,
      template: fixedFollow,
      firstTemplate: aiFirst,
      priorSteps: [{ day: 3, template: aiFollow, instruction: 'Follow up.' }],
    });
    assert.equal(third.subject, '沿用首封主题');
    assert.equal(third.body, second.body);
    assert.equal(h.requests.length, before);
    const aiStep = await preview({
      step: 2,
      day: 7,
      template: aiFollow,
      instruction: 'Follow up.',
      firstTemplate: aiFirst,
      priorSteps: [{ day: 3, template: aiFollow, instruction: 'Follow up.' }],
    });
    assert.match(aiStep.body, /Would a brief product overview help/);
    assert.equal(h.requests.length, before + 1);
    assert.equal(h.requests.at(-1).day, 7);
    const firstAi = await preview({ step: 0, day: 0, template: aiFirst });
    const inherited = await preview({
      step: 1,
      day: 3,
      template: fixedFollow,
      firstTemplate: aiFirst,
      priorSteps: [],
      firstPreview: {
        sampleId: sample.id,
        mailboxId: box.id,
        productId: product.id,
        subject: firstAi.subject,
      },
    });
    assert.equal(inherited.subject, 'Re: ' + firstAi.subject);
    assert.equal(h.requests.length, before + 2);
  }
  const before = h.requests.length;
  await assert.rejects(
    api(h, '/sequence-policy/sample?mailboxId=box-0&category=contractor'),
    /没有合格样本/,
  );
  assert.equal(h.requests.length, before);
  assert.equal(h.sends, 0);
});
test('完整类别取样覆盖三个邮箱、两类客户及无数据对照，预览完整三步且无业务写入', async (t) => {
  const h = categoryPreviewFixture();
  t.after(h.close);
  const options = await api(h, '/sequence-policy/preview-options');
  assert.equal(options.mailboxes.length, 3);
  assert.equal(options.categories.length, 12);
  assert.equal(JSON.stringify(options).includes('QA '), false);
  const initial = h.service.db.prepare('SELECT total_changes() n').get().n;
  const timings = [];
  for (const box of h.boxes)
    for (const category of ['manufacturer', 'distributor']) {
      const scope = { mailboxId: box.id, category };
      const query = new URLSearchParams(scope);
      const start = performance.now();
      const sample = await api(h, '/sequence-policy/sample?' + query);
      timings.push(performance.now() - start);
      const original = h.leads.find((l) => l.id === sample.id);
      assert.ok(original.facts.some((f) => f.value === category));
      assert.equal(sample.brand, box.brandName);
      assert.equal(sample.from, box.email);
      assert.equal(sample.product, h.products.find((p) => p.id === sample.productId).name);
      assert.ok(sample.id.startsWith('z'));
      assert.ok(sample.roleEvidence.every((e) => e.sourceUrl.startsWith(original.website)));
      const next = await api(
        h,
        '/sequence-policy/sample?' + new URLSearchParams({ ...scope, after: sample.id }),
      );
      assert.notEqual(next.id, sample.id);
      for (const [step, day] of [
        [0, 0],
        [1, 3],
        [2, 7],
      ]) {
        const preview = await api(h, '/sequence-policy/preview', 'POST', {
          ...scope,
          sampleId: sample.id,
          step,
          day,
          instruction: step ? 'Ask one easy question.' : '',
          template: { subject: step ? '' : '{{product}} for {{company}}', body: '{{ai_body}}' },
          firstTemplate: { subject: '{{product}} for {{company}}', body: '{{ai_body}}' },
          priorSteps: [
            {
              day: 3,
              instruction: '',
              template: { subject: '', body: 'Earlier note about {{product}}.' },
            },
          ],
        });
        assert.ok(preview.body.startsWith('Hi ' + original.name + ' team,'));
        assert.ok(preview.body.endsWith(box.signature));
        assert.ok(!preview.body.includes('{{'));
        assert.ok(!preview.subject.includes('{{'));
        assert.ok(preview.subject.includes(sample.product));
        assert.equal(preview.sample.id, sample.id);
        assert.equal(preview.rules.step, step);
        for (const other of h.boxes.filter((b) => b.id !== box.id))
          assert.ok(!preview.body.includes(other.brandName));
        if (step === 2)
          assert.equal(
            h.requests.at(-1).history[0].body,
            'Earlier note about ' + sample.product + '.',
          );
      }
      await assert.rejects(
        api(
          h,
          '/sequence-policy/sample?' + new URLSearchParams({ ...scope, category: 'contractor' }),
        ),
        /没有合格样本/,
      );
      const other = h.products.find((p) => !box.productIds.includes(p.id));
      await assert.rejects(
        api(h, '/sequence-policy/sample?' + new URLSearchParams({ ...scope, productId: other.id })),
        /没有合格样本/,
      );
    }
  assert.equal(h.sends, 0);
  assert.equal(h.service.db.prepare('SELECT total_changes() n').get().n, initial);
  assert.equal(h.service.db.prepare('SELECT count(*) n FROM outreach_campaigns').get().n, 0);
  console.log(
    JSON.stringify({
      dossiers: h.leads.length,
      sampleMs: timings,
      response: 'one sample per request',
    }),
  );
});

test('多角色分别归类，角色缺证、跨域证据、恶意类别及样本错归明确拒绝', async (t) => {
  const h = categoryPreviewFixture(0);
  t.after(h.close);
  for (const category of ['manufacturer', 'distributor']) {
    const sample = await api(
      h,
      '/sequence-policy/sample?' +
        new URLSearchParams({ mailboxId: 'box-0', category, sampleId: 'z-multi' }),
    );
    assert.equal(sample.id, 'z-multi');
  }
  for (const sampleId of ['a-foreign', 'a-missing', 'z0-distributor-0'])
    await assert.rejects(
      api(
        h,
        '/sequence-policy/sample?' +
          new URLSearchParams({ mailboxId: 'box-0', category: 'manufacturer', sampleId }),
      ),
      /没有合格样本|不符合/,
    );
  await assert.rejects(
    api(
      h,
      '/sequence-policy/sample?' +
        new URLSearchParams({ mailboxId: 'box-0', category: 'invented' }),
    ),
    { status: 400 },
  );
});
import { previewSample } from '../server/outreach-template-preview.mjs';
test('固定发件邮箱不跨品牌，角色取样不越过作用域，单样本更换不冒充新样本', async (t) => {
  const h = categoryPreviewFixture(0);
  t.after(h.close);
  h.service.customerMailState = () => ({ context: { fixedEmail: h.boxes[1].email } });
  await assert.rejects(
    previewSample(h.service, { category: 'distributor', mailboxId: 'box-0' }),
    /固定归属其他发件邮箱/,
  );
  h.service.customerMailState = () => ({ context: {} });
  h.library.scope = 'empty-scope';
  await assert.rejects(
    previewSample(h.service, { category: 'manufacturer', mailboxId: 'box-0' }),
    /没有合格样本/,
  );
  h.library.scope = 'preview-qa';
  const only = 'z0-distributor-0';
  h.library.db.prepare('DELETE FROM lead_library_customers WHERE record_id!=?').run(only);
  assert.equal(
    (await previewSample(h.service, { category: 'distributor', mailboxId: 'box-0' })).id,
    only,
  );
  await assert.rejects(
    previewSample(h.service, { category: 'distributor', mailboxId: 'box-0', after: only }),
    /其他合格样本/,
  );
});

test('跟进预览与正式发送共用产品范围校验，模板不得混入邮箱未获准的产品', async (t) => {
  const h = categoryPreviewFixture(0);
  t.after(h.close);
  await assert.rejects(
    api(h, '/sequence-policy/preview', 'POST', {
      mailboxId: 'box-0',
      category: 'distributor',
      step: 1,
      day: 3,
      instruction: 'Ask one question.',
      template: { subject: '', body: 'We also supply PVC shutters. Would a brief overview help?' },
    }),
    /产品|品牌/,
  );
});

test('首封预览拒绝模板中的范围外产品', async (t) => {
  const h = categoryPreviewFixture(0);
  t.after(h.close);
  await assert.rejects(
    api(h, '/sequence-policy/preview', 'POST', {
      mailboxId: 'box-0',
      category: 'distributor',
      step: 0,
      instruction: '',
      template: {
        subject: 'Product overview',
        body: 'We also supply PVC shutters. Would a brief overview help?',
      },
    }),
    /产品|品牌/,
  );
});

test('客户名称包含其他产品词时仍可生成首封，但额外供货声明仍被拦截', async (t) => {
  const h = categoryPreviewFixture(0);
  t.after(h.close);
  const id = 'z0-distributor-0';
  const row = h.library.previewLeads('distributor', '', id)[0];
  row.lead.name = 'PVC Shutters Pty Ltd';
  h.library.db
    .prepare('UPDATE lead_library_customers SET detail=? WHERE record_id=?')
    .run(JSON.stringify(row.lead), id);
  const input = {
    mailboxId: 'box-0',
    category: 'distributor',
    sampleId: id,
    step: 0,
    instruction: '',
    template: { subject: '{{product}} for {{company}}', body: '{{ai_body}}' },
  };
  const p = await api(h, '/sequence-policy/preview', 'POST', input);
  assert.match(p.body, /Hi PVC Shutters Pty Ltd team,/);
  assert.match(p.subject, /PVC Shutters Pty Ltd/);
  await assert.rejects(
    api(h, '/sequence-policy/preview', 'POST', {
      ...input,
      template: {
        ...input.template,
        body: 'We also supply PVC shutters. Would a brief overview help?',
      },
    }),
    /产品|品牌/,
  );
});

test('三个邮箱按各步骤要求预览短正文与签名', async (t) => {
  const a = 'One paragraph, two statements.';
  const b = 'Two paragraphs ending in one question.';
  const h = categoryPreviewFixture(0, (input, draft) => {
    const product = input.sender.product || input.product;
    const style = input.body_instruction || input.writingInstruction;
    draft.body_text =
      style === a
        ? 'Your range includes ' + product + '. We supply this product.'
        : 'We supply ' + product + '.\n\nWould an overview help?';
    if (input.step) draft.subject = product + ' update';
    return draft;
  });
  t.after(h.close);
  for (const [index, box] of h.boxes.entries()) {
    const product = h.products[index].englishName;
    const original = h.leads.find((l) => l.id === 'z' + index + '-distributor-0');
    const selectedProduct = h.products[index];
    const campaign = {
      mailboxIds: [box.id],
      filters: { products: [selectedProduct.id] },
      productScopes: [outreachProductScope(selectedProduct)],
    };
    const [candidate] = selectOutreachCandidates({
      leads: [original],
      mailboxes: [box],
      products: [selectedProduct],
      campaign,
    }).eligible;
    for (const [step, day] of [
      [0, 0],
      [1, 3],
      [2, 7],
    ]) {
      for (const style of [a, b]) {
        const before = h.requests.length;
        const preview = await api(h, '/sequence-policy/preview', 'POST', {
          mailboxId: box.id,
          category: 'distributor',
          sampleId: original.id,
          step,
          day,
          firstBodyInstruction: style,
          instruction: step ? style : '',
          priorSteps: [],
          template: {
            subject: step && style === a ? 'Day ' + day + ' | {{product}}' : '{{ai_subject}}',
            body: '{{ai_body}}',
          },
        });
        const expected =
          style === a
            ? 'Your range includes ' + product + '. We supply this product.'
            : 'We supply ' + product + '.\n\nWould an overview help?';
        const subject = step
          ? style === a
            ? 'Day ' + day + ' | ' + product
            : product + ' update'
          : product + ' supply';
        assert.equal(preview.subject, subject);
        assert.equal(
          preview.body,
          ['Hi ' + original.name + ' team,', expected, box.signature].join('\n\n'),
        );
        assert.equal(preview.warning, undefined);
        assert.equal(h.requests.length - before, 1);
        const input = {
          candidate,
          mailbox: box,
          product: selectedProduct,
          campaign,
          now: new Date(),
        };
        const first = await h.service
          .generatorClient()
          .generate({ ...input, firstBodyInstruction: style });
        const greeting = 'Hi ' + original.name + ' team,';
        const follow =
          step &&
          (await generateFollowUp({
            ...input,
            env: h.service.getEnv(),
            fetchImpl: h.service.fetchImpl,
            first: { ...first, candidate, companyName: original.name },
            step,
            day,
            instruction: style,
            template: {
              subject: style === a ? 'Day ' + day + ' | {{product}}' : '{{ai_subject}}',
              body: '{{ai_body}}',
            },
            history: [],
          }));
        assert.equal(step ? follow.subject : first.subject, subject);
        const signed = [
          step ? greeting + '\n\n' + follow.body : first.bodyText,
          renderMailboxSignature(box).text,
        ].join('\n\n');
        assert.equal(signed, preview.body);
      }
    }
  }
  assert.equal(h.sends, 0);
});
