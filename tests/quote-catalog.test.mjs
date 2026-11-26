import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { MaterialLibrary } from '../server/materials.mjs';
import { workbookPage } from '../server/product-workbooks.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';

const mode = 'quote_catalog',
  box = { website: 'https://honeybadgerblinds.com', brandName: 'Honey Badger Blinds' };
function setup(t) {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k, [box]);
  const upload = (name, bytes, extra = {}) =>
    lib.upload({ name, bytes, mode, site: 'honeybadgerblinds.com', key: randomUUID(), ...extra });
  return { k, lib, upload };
}
test('单图可仅登记名字、品类与关键词，全程不调用模型', async (t) => {
  const { lib, upload } = setup(t);
  const bytes = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  let requests = 0;
  const { id, warning } = await upload('公司展示.png', bytes, {
    mode: 'asset_only',
    fetchImpl: () => {
      requests++;
      throw Error('unexpected');
    },
  });
  assert.equal(warning, '');
  const material = lib.edit(id, {
    version: lib.get(id).version,
    name: '公司介绍图片',
    category: '公司资料',
    keywords: ['公司介绍'],
  });
  assert.equal(lib.detail(id).documents[0].extraction.model, 'manual');
  assert.deepEqual(material.keywords, ['公司介绍']);
  assert.equal(requests, 0);
});
for (const ext of ['pdf', 'docx', 'xlsx'])
  test(ext + ' 通过素材库保留报价原值与同行嵌图', async (t) => {
    const { k, lib, upload } = setup(t);
    const name = 'quote-table.' + ext;
    const result = await upload(name, readFileSync(new URL('./fixtures/' + name, import.meta.url)));
    assert.equal(result.warning, '');
    const extraction = lib.detail(result.id).documents[0].extraction;
    assert.equal(extraction.rowCount, 1);
    if (ext === 'pdf') assert.match(extraction.warnings.join(' '), /p\.2.*扫描/u);
    const page = workbookPage(k.db, result.id, result.documentId, {
      sheet: extraction.sheets[0].name,
    });
    const row = page.rows[0];
    if (ext === 'xlsx') {
      assert.equal(row.cells.find((c) => c.field === '参考价格').ref, 'E3');
      assert.equal(row.cells[0].ref, 'C3');
    }
    assert.deepEqual(Object.fromEntries(row.cells.slice(0, 4).map((c) => [c.field, c.value])), {
      型号或品名: 'QF-019',
      参考价格: '2.750',
      单位: 'PC',
      币种: 'USD',
    });
    assert.equal(row.photos.length, 1);
    const bytes = k.documents.photos.image(result.id, result.documentId, row.photos[0].id);
    assert.equal((await sharp(bytes).metadata()).format, 'jpeg');
  });

test('Markdown 清单保存多图、原位改价、版本校对及历史，重复型号与外链保留人工确认', async (t) => {
  const { k, lib, upload } = setup(t);
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'navy' } })
    .png()
    .toBuffer();
  const img = '![样品](data:image/png;base64,' + bytes.toString('base64') + ')';
  const head = '| 型号 | 图片 | 单价 | 单位 | 币种 |\n|---|---|---|---|---|\n';
  const table = (price, prefix = '') =>
    Buffer.from(
      prefix + head + '| QF-019 | ' + img + ' ' + img + ' | ' + price + ' | PC | USD |\n',
    );
  const first = await upload('supplier.md', table('2.750'));
  const { id, documentId } = first;
  const sheet = '表 1',
    row = workbookPage(k.db, id, documentId, { sheet }).rows[0],
    cell = row.cells.find((c) => c.field === '参考价格');
  assert.equal(row.photos.length, 2);
  const corrected = lib.edit(id, {
    version: lib.get(id).version,
    cellEdits: [{ documentId, sheet, ref: cell.ref, value: '3.125' }],
  });
  const approved = lib.edit(id, {
    version: corrected.version,
    status: 'approved',
    approvedBy: 'QA',
  });
  const ask = (ids) =>
    answerMailQuestion(k, { ...box, knowledgeProductIds: ids }, 'What is the price of QF-019?');
  assert.equal(ask([id]).sources.find((s) => s.field === '参考价格').value, '3.125');
  assert.equal(ask([]).sources.length, 0);
  const next = await upload('supplier-v2.md', table('2.750', '\n'), {
    id,
    version: approved.version,
  });
  assert.equal(next.warning, '');
  const replacement = lib.get(id);
  assert.equal(replacement.status, 'draft');
  assert.equal(replacement.cellEdits[0].value, '3.125');
  assert.equal(replacement.cellEdits[0].documentId, next.documentId);
  assert.notEqual(replacement.cellEdits[0].ref, cell.ref);
  const changed = await upload('supplier-v3.md', table('4.000'), {
    id,
    version: replacement.version,
  });
  assert.match(changed.warning, /重新确认/u);
  assert.equal((lib.get(id).cellEdits || []).length, 0);
  assert.equal(lib.detail(id, approved.version).product.cellEdits[0].value, '3.125');
  const unclear = await upload(
    'ambiguous.md',
    Buffer.from(
      head +
        '| AA-02 | ' +
        img +
        ' | 2 | PC | EUR |\n| AA-02 | ![x](https://example.invalid/x.jpg) | 1 | PC | EUR |',
    ),
  );
  const x = lib.detail(unclear.id).documents[0].extraction;
  assert.match(x.warnings.join(' '), /型号重复/u);
  assert.match(x.warnings.join(' '), /图片未内嵌/u);
  assert.equal(
    workbookPage(k.db, unclear.id, unclear.documentId, { sheet }).rows[0].photos.length,
    0,
  );
});

test('文件级报价条件保留复核，逐型号引用仅使用本行明确条件', async (t) => {
  const { k, lib, upload } = setup(t);
  const table = (model, condition) =>
    '| Model | Unit Price | Unit | Currency | 适用条件 |\n' +
    '|---|---|---|---|---|\n' +
    `| ${model} | 2.75 | PC | USD | ${condition} |\n`;
  const terms = ['XA 系列单独条款：定金 30%。', 'XB 系列单独条款：定金 50%。'];
  const { id, documentId } = await upload(
    'separate-terms.md',
    Buffer.from(
      table('XA-01', 'XA 原行：最低 100 件') +
        '\n> 报价条件 · ' +
        terms[0] +
        '\n\n' +
        table('XB-01', 'XB 原行：最低 200 件') +
        '\n> 报价条件 · ' +
        terms[1],
    ),
  );
  const extraction = lib.detail(id).documents[0].extraction;
  assert.deepEqual(extraction.terms, terms);
  assert.match(extraction.warnings.join(' '), /适用型号尚未确认/u);
  lib.edit(id, { version: lib.get(id).version, status: 'approved', approvedBy: 'QA' });
  for (const [model, condition, sheet] of [
    ['XA-01', 'XA 原行：最低 100 件', '表 1'],
    ['XB-01', 'XB 原行：最低 200 件', '表 2'],
  ]) {
    const row = workbookPage(k.db, id, documentId, { sheet }).rows[0];
    assert.equal(row.cells.find((cell) => cell.field === '适用条件').value, condition);
    const answer = answerMailQuestion(
      k,
      { ...box, knowledgeProductIds: [id] },
      `请报 ${model} 的价格`,
    );
    assert.equal(answer.sources.find((source) => source.field === '适用条件').value, condition);
    assert.ok(!answer.sources.some((source) => /定金|30%|50%/u.test(source.value)));
  }
});
