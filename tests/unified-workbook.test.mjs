import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { MaterialLibrary } from '../server/materials.mjs';
import { workbookPage, knowledgePage } from '../server/product-workbooks.mjs';
import { sheetLayout, workbookHeader } from '../src/domain/workbook-layout.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';

const bytes = readFileSync(new URL('./fixtures/unified-workbook.xlsx', import.meta.url));
test('不同列名与顺序识别报价和规则，多种价格保留原表待核对', () => {
  assert.equal(sheetLayout(['Unit', 'Price (USD)', 'Model No.']).kind, 'quote');
  assert.equal(sheetLayout(['填写内容', '来源', '关键词']).kind, 'knowledge');
  assert.equal(sheetLayout(['型号', '单价', 'Cost']).kind, 'table');
  assert.equal(sheetLayout(['型号', '单价', '单价']).kind, 'table');
  assert.equal(workbookHeader([['供应商报价'], [], ['Unit', 'Price', 'SKU']]), 2);
});

test('同一Excel入口按工作表呈现、改名复用，原位改价审核后进入草稿依据', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const box = { website: 'https://honeybadgerblinds.com' };
  const lib = new MaterialLibrary(k, [box]);
  const upload = (name, extra = {}) => lib.upload({ name, bytes, key: randomUUID(), ...extra });
  const first = await upload('陌生供应商.xlsx');
  assert.equal(first.warning, '');
  const doc = lib.detail(first.id).documents[0];
  assert.deepEqual(
    doc.extraction.sheets.map((s) => s.kind),
    ['quote', 'knowledge', 'table'],
  );
  assert.equal((await upload('新名字.xlsx')).documentId, first.documentId);
  const row = workbookPage(k.db, first.id, first.documentId, { sheet: '供应报价', material: true })
    .rows[0];
  assert.equal(row.cells[0].value, 'UP-001');
  assert.equal(row.photos.length, 1);
  const price = row.cells.find((c) => c.field === '参考价格');
  assert.equal(price.ref, 'A3');
  const updated = lib.edit(first.id, {
    version: lib.get(first.id).version,
    cellEdits: [
      { documentId: first.documentId, sheet: '供应报价', ref: price.ref, value: '17.25' },
    ],
  });
  assert.equal(
    answerMailQuestion(k, { ...box, knowledgeProductIds: [first.id] }, 'UP-001 price').sources
      .length,
    0,
  );
  lib.edit(first.id, { version: updated.version, status: 'approved', approvedBy: 'QA' });
  const answer = answerMailQuestion(
    k,
    { ...box, knowledgeProductIds: [first.id] },
    'What is the price of UP-001?',
  );
  assert.equal(answer.sources.find((s) => s.field === '参考价格').value, '17.25');
  const rules = knowledgePage(k.db, doc, '公司条款', lib.get(first.id), 1, '付款');
  assert.equal(rules.total, 1);
  assert.deepEqual(rules.groups[0].topics, ['付款', 'payment']);
  assert.equal(rules.groups[0].answer, '50% deposit');
  const corrected = lib.edit(first.id, {
    version: lib.get(first.id).version,
    cellEdits: [
      ...lib.get(first.id).cellEdits,
      { documentId: first.documentId, sheet: '公司条款', ref: 'A2', value: '40% deposit' },
    ],
  });
  assert.equal(
    knowledgePage(k.db, doc, '公司条款', corrected, 1, '40%').groups[0].answer,
    '40% deposit',
  );
  assert.throws(() => knowledgePage(k.db, doc, '公司条款', corrected, 0), /检索条件/);
});
