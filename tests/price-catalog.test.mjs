import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { MaterialLibrary } from '../server/materials.mjs';
import { importPriceCatalog } from '../scripts/import-price-catalog.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';
test('价格清单可在空库导入、重新校价、换图和重复导入', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const imported = await importPriceCatalog(k),
    id = imported.materials[0];
  assert.equal(imported.added, 96);
  const library = new MaterialLibrary(k, []),
    { product, documents } = library.detail(id),
    doc = documents[0].id;
  const patch = {
    sheet: '卷帘',
    documentId: doc,
    ref: 'C2',
    value: '拉珠/拉绳 (chain/rope) 10.25 USD/m²',
  };
  library.edit(id, { version: product.version, cellEdits: [patch] });
  assert.deepEqual(library.detail(id).product.cellEdits, [patch]);
  let current = library.detail(id).product;
  library.edit(id, { version: current.version, status: 'approved', approvedBy: 'QA' });
  const answer = answerMailQuestion(
    k,
    { website: 'https://honeybadgerblinds.com', knowledgeProductIds: [id] },
    '请给我 A211 卷帘拉珠款的参考价',
    Date.now(),
    { forDraft: true },
  );
  assert.ok((answer.draftSources || answer.sources).some((s) => s.value.includes('10.25')));
  const photos = k.documents.photos,
    first = photos.list(id, doc, { q: 'A211' }).rows[0].photos[0];
  const replacement = await photos.change(id, doc, {
    sheet: '卷帘',
    item: 'A211',
    slot: '主图',
    expectedId: first.id,
    contentBase64: photos.image(id, doc, first.id).toString('base64'),
  });
  assert.equal((await importPriceCatalog(k)).added, 0);
  assert.equal(photos.list(id, doc, { q: 'A211' }).rows[0].photos[0].id, replacement.id);
  assert.equal(library.detail(id).product.cellEdits[0].value, patch.value);
});
