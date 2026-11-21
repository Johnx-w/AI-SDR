import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { workbookType } from '../server/product-workbooks.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';

test('邮箱试问只引用本站现行的已选审核资料，核对、撤回及切换即时生效', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  let p = k.save({ name: '轨道', direction: 'materials', brands: ['Honey Badger Blinds'] });
  const file = k.documents.upload(p.id, {
    name: 'spec.xlsx',
    contentType: workbookType,
    contentBase64: readFileSync(new URL('./fixtures/mail-specimen.xlsx', import.meta.url)).toString(
      'base64',
    ),
  });
  await k.documents.extract(p.id, file.id, { env: {} });
  p = k.save({ ...p, documentIds: [file.id], status: 'approved', approvedBy: 'QA' });
  const box = { website: 'https://honeybadgerblinds.com', knowledgeProductIds: [p.id] };
  const ask = (m = box, q = 'What material is ZX-01 made of?') => answerMailQuestion(k, m, q);
  assert.equal(ask().automatic, true);
  assert.equal(ask().sources.at(-1).ref, 'B2');
  assert.match(ask().body, /Aluminium/);
  for (const other of ['shuangshengshutter.com', 'shutterblindssolutions.com'])
    assert.deepEqual(ask({ ...box, website: 'https://' + other }).sources, []);
  assert.equal(ask({ ...box, knowledgeProductIds: [] }).sources.length, 0);
  assert.equal(ask(box, 'What material is ZX-01333?').sources.length, 0);
  p = k.save({
    ...p,
    cellEdits: [{ documentId: file.id, sheet: '规格', ref: 'B2', value: 'Aluminum alloy' }],
  });
  assert.equal(ask().sources.length, 0);
  p = k.save({ ...p, status: 'approved', approvedBy: 'QA' });
  assert.equal(ask().sources.at(-1).value, 'Aluminum alloy');
  assert.equal(ask().sources.at(-1).original, 'Aluminium');
  k.save({ ...p, status: 'archived' });
  assert.equal(ask().sources.length, 0);
});
