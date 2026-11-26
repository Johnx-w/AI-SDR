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
        if (step === 2) assert.equal(h.requests.at(-1).history.length, 1);
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
    /没有合格样本/,
  );
});
