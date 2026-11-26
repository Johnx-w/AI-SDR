import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx/xlsx.mjs';
import sharp from 'sharp';
import { MaterialLibrary } from '../server/materials.mjs';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';

test('Docling 离线读取原生 PPTX 表格与幻灯片位置', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k);
  const r = await lib.upload({
    name: '规格.pptx',
    bytes: readFileSync(new URL('./fixtures/model-parameters.pptx', import.meta.url)),
    key: randomUUID(),
    mode: 'rich_layout_recognition',
    fetchImpl: () => assert.fail('原生表格不需要远程服务'),
  });
  assert.equal(r.warning, '');
  const doc = lib.detail(r.id).documents[0];
  assert.equal(doc.extraction.model, 'Docling');
  assert.ok(
    doc.extraction.facts.some(
      (f) => f.text.includes('0128') && f.text.includes('152 mm') && f.location.includes('幻灯片'),
    ),
  );
});
test('上传有标题和非首列编码的目录，两个产品、空对照和横排参数按原件取值', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['产品目录'],
      [],
      ['名称', '宽度', '产品编码'],
      ['白色导轨', '37 mm', 'QA-01'],
      ['黑色导轨', '52 mm', 'QA-02'],
    ]),
    '图册',
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['型号', 'QA-01', 'QA-02'],
      ['厚度', '2 mm', '4 mm'],
    ]),
    '横向',
  );
  const catalog = book.Sheets['图册'];
  catalog.D3 = { t: 's', v: '出厂价格' };
  catalog.D4 = { t: 'n', v: 1.25, z: '0.000' };
  catalog.D5 = { t: 'n', v: 6000, z: '#,##0' };
  catalog['!ref'] = 'A1:D5';
  const r = await lib.upload({
    name: '目录.xlsx',
    bytes: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
    key: randomUUID(),
  });
  assert.equal(r.warning, '');
  const d = lib.detail(r.id);
  assert.deepEqual(
    d.documents[0].extraction.facts.map((f) => [f.location, f.text]),
    [
      ['横向!B2', 'QA-01 · 厚度 · 2 mm'],
      ['横向!C2', 'QA-02 · 厚度 · 4 mm'],
    ],
  );
  lib.edit(r.id, { version: d.currentVersion, status: 'approved', approvedBy: 'QA' });
  const ask = (item) =>
    answerMailQuestion(
      k,
      { website: 'https://example.test', knowledgeProductIds: [r.id] },
      'How wide is ' + item + '?',
    ).sources;
  for (const [item, ref, val] of [
    ['QA-01', 'B4', '37 mm'],
    ['QA-02', 'B5', '52 mm'],
  ])
    assert.deepEqual(
      ask(item)
        .filter((s) => s.field === '宽度')
        .map((s) => [s.item, s.ref, s.value]),
      [[item, ref, val]],
    );
  for (const [item, value] of [
    ['QA-01', '1.250'],
    ['QA-02', '6,000'],
  ]) {
    const row = k.db
      .prepare('SELECT data FROM product_workbook_rows WHERE document_id=? AND label=?')
      .get(r.documentId, item);
    assert.equal(JSON.parse(row.data).find((c) => c.field === '出厂价格').value, value);
  }
  assert.deepEqual(ask('QA-03'), []);
});
test('产品行内嵌图片经过上传、重试和审核后，两种回复入口按产品取图', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k);
  const pics = await Promise.all(
    ['red', 'blue'].map((background) =>
      sharp({ create: { width: 36, height: 26, channels: 3, background } })
        .png()
        .toBuffer(),
    ),
  );
  const table = [
    '| 产品编码 | 图片 | 规格 |',
    '|---|---|---|',
    ...pics.map(
      (b, i) =>
        '| QX-0' +
        (i + 1) +
        ' | ![图](data:image/png;base64,' +
        b.toString('base64') +
        ') | ' +
        (20 + i) +
        ' mm |',
    ),
  ].join('\n');
  const input = { name: '配件.md', bytes: Buffer.from(table), key: randomUUID() };
  const r = await lib.upload(input);
  await lib.upload(input);
  const d = lib.detail(r.id);
  assert.equal(d.documents[0].extraction.photoCount, 2);
  assert.ok(!JSON.stringify(d.documents[0].extraction.facts).includes('base64'));
  lib.edit(r.id, { version: d.currentVersion, status: 'approved', approvedBy: 'QA' });
  for (const [i, item] of ['QX-01', 'QX-02', 'QX-03'].entries()) {
    const docs = [r.documentId];
    const stored = k.documents.photos;
    const reply = stored.automaticMatch(stored.options(docs, item), item).attachments;
    const draft = k.documents.draftPhotos([], item, docs);
    assert.deepEqual(reply, draft);
    if (i === 2) {
      assert.deepEqual(reply, []);
      continue;
    }
    assert.deepEqual(
      reply.map((a) => a.name),
      [item + '.jpg'],
    );
    const rgb = await sharp(Buffer.from(reply[0].contentBase64, 'base64')).raw().toBuffer();
    assert.ok(i === 0 ? rgb[0] > 240 && rgb[2] < 10 : rgb[2] > 240 && rgb[0] < 10);
  }
});
