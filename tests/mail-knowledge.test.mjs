import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { workbookType } from '../server/product-workbooks.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';
import { siteAllowsProduct } from '../src/domain/mail-site.mjs';

test('三个正式站点的开发范围需要官网或品牌依据，外站无品牌记录不能纳入', () => {
  const own = { website: 'https://honeybadgerblinds.com', email: 'sales@honeybadgerblinds.com' };
  assert.equal(siteAllowsProduct({}, own), false);
  assert.equal(siteAllowsProduct({ sourceUrl: 'https://unrelated.test/track' }, own), false);
  assert.equal(
    siteAllowsProduct(
      { sourceUrl: 'https://shuangshengshutter.com', brands: ['Honey Badger Blinds'] },
      own,
    ),
    false,
  );
  assert.equal(siteAllowsProduct({ sourceUrl: 'https://honeybadgerblinds.com/track' }, own), true);
  assert.equal(siteAllowsProduct({ brands: ['Honey Badger Blinds'] }, own), true);
});

test('邮箱试问只引用现行的已选审核资料，核对、撤回及切换即时生效', async (t) => {
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
  const sample = ask().sources[0];
  const jpeg = await (
    await import('sharp')
  )
    .default({ create: { width: 4, height: 4, channels: 3, background: 'blue' } })
    .jpeg()
    .toBuffer();
  await k.documents.photos.change(p.id, file.id, {
    sheet: sample.sheet,
    item: 'ZX-01',
    slot: '主图',
    expectedId: null,
    contentBase64: jpeg.toString('base64'),
  });
  assert.equal(k.documents.draftPhotos(ask().sources, 'Please quote ZX-01')[0].name, 'ZX-01.jpg');
  assert.equal(k.documents.draftPhotos(ask().sources, 'Please quote ZX-01-H').length, 0);
  assert.equal(k.documents.draftPhotos([], 'Please quote ZX-01').length, 0);
  const subjectOnly = answerMailQuestion(k, box, 'What material is it made of?', Date.now(), {
    subject: 'ZX-01',
    forDraft: true,
  });
  assert.equal(subjectOnly.sources.at(-1).ref, 'B2');
  assert.equal(subjectOnly.draftSources.find((s) => s.ref === 'B2').value, 'Aluminium');
  assert.equal(
    answerMailQuestion(k, box, 'What material is it made of?', Date.now(), {
      subject: 'Shuangsheng ZX-01',
      forDraft: true,
    }).draftSources,
    undefined,
  );
  assert.equal(ask().sources.at(-1).ref, 'B2');
  assert.match(ask().body, /Aluminium/);
  for (const other of ['shuangshengshutter.com', 'shutterblindssolutions.com'])
    assert.equal(ask({ ...box, website: 'https://' + other }).sources.at(-1).ref, 'B2');
  assert.equal(
    ask(
      { ...box, website: 'https://shuangshengshutter.com' },
      'What material is Honey Badger Blinds ZX-01 made of?',
    ).sources.at(-1).ref,
    'B2',
  );
  assert.equal(ask({ ...box, knowledgeProductIds: [] }).sources.length, 0);
  assert.equal(ask(box, 'What material is ZX-01333?').sources.length, 0);
  for (const q of ['What material is Shuangsheng ZX-01 made of?', 'SBS 的 ZX-01 材质是什么？'])
    assert.deepEqual(ask(box, q).sources, []);
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
