import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { WorkbookPhotos, declinesPhotos, scopedPhotoDocs } from '../server/workbook-photos.mjs';
import { normalizeAttachments } from '../server/mail-content.mjs';

test('工作簿图片的迁移、型号匹配、草稿回读、换版沿用和撤回', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const db = k.db;
  const p = 'pk_test',
    doc = 'original',
    next = 'revision2';
  function product(d, status = 'approved') {
    db.prepare('INSERT OR REPLACE INTO product_knowledge VALUES(?,?)').run(
      p,
      JSON.stringify({ id: p, documentIds: [d], version: d === doc ? 1 : 2, status }),
    );
  }
  product(doc);
  for (const id of [doc, next])
    db.prepare("INSERT INTO product_documents VALUES(?,?, '{}',x'00',null)").run(id, p);
  const row = (d, s, n, item) =>
    db.prepare('INSERT INTO product_workbook_rows VALUES(?,?,?,?,?)').run(
      d,
      s,
      n,
      item,
      JSON.stringify([
        { field: '型号', value: item },
        { field: '品类', value: s },
      ]),
    );
  for (const d of [doc, next]) {
    row(d, '卷帘', 2, 'A211');
    row(d, '斑马帘', 2, 'A211');
    row(d, '斑马帘', 3, 'AB15');
  }
  row(doc, '卷帘', 3, '旧名');
  row(next, '卷帘', 3, '新名');
  row(next, '斑马帘', 4, 'AB15');
  for (let i = 0; i < 25; i++) row(doc, '其他', i + 2, 'SKU' + i);
  const bytes = await sharp({ create: { width: 6, height: 6, channels: 3, background: 'red' } })
      .jpeg()
      .toBuffer(),
    contentBase64 = bytes.toString('base64');
  db.exec('DROP TABLE workbook_image_assets');
  db.prepare('INSERT INTO product_workbook_photos VALUES(?,?,?,?,?)').run(
    doc,
    '卷帘',
    'A211',
    'B4',
    bytes,
  );
  const photos = new WorkbookPhotos(db),
    box = { knowledgeProductIds: [p], website: 'https://honeybadgerblinds.com' };
  const scope = () => scopedPhotoDocs(k, box, Date.now());
  const opts = (q) => photos.options(scope(), q);
  const main = photos.automatically(opts('卷帘 A211'), '卷帘 A211')[0];
  assert.equal(main.name, 'A211.jpg');
  assert.deepEqual(photos.automatically(opts('A211'), 'A211'), []);
  assert.match(photos.automaticMatch(opts('A211'), 'A211').photoNote, /核对品类/);
  assert.equal(photos.options([], 'A211').length, 0);
  assert.equal(opts('卷帘 A211-H').length, 0);
  assert.equal(photos.automatically(opts('斑马帘 A211'), '斑马帘 A211').length, 0);
  for (const q of ['A211 卷帘，不要图片', 'A211 no product photos', 'A211 text only']) {
    assert.ok(declinesPhotos(q));
    assert.deepEqual(photos.automatically(opts(q), q), []);
  }
  const put = (sheet, item, slot, expectedId = null) =>
    photos.change(p, doc, { sheet, item, slot, expectedId, contentBase64 });
  const extra = await put('卷帘', 'A211', '色卡');
  assert.deepEqual(
    photos.automatically(opts('卷帘 A211'), '卷帘 A211').map((a) => a.id),
    [main.id],
  );
  const draft = JSON.parse(
    JSON.stringify({ attachments: normalizeAttachments([main, photos.attachment(extra.id)]) }),
  );
  assert.equal(draft.attachments[1].name, 'A211-色卡.jpg');
  photos.guard(scope(), draft);
  const base = photos.list(p, doc, { sheet: '卷帘', q: '211' });
  assert.equal(base.rows[0].photos[0].origin, '卷帘!B4');
  assert.equal(photos.list(p, doc, { sheet: '其他', missing: '1', page: 2 }).rows.length, 5);
  assert.equal(photos.list(p, doc, { sheet: '卷帘', missing: '1' }).total, 1);
  const legacy = {
    attachments: [
      {
        ...main,
        id:
          'attachment_' +
          createHash('sha256').update(main.name).update(bytes).digest('hex').slice(0, 24),
      },
    ],
    provenance: { sources: [] },
  };
  photos.guard(scope(), legacy);
  await put('卷帘', 'A211', '主图', main.id);
  for (const saved of [draft, legacy]) assert.throws(() => photos.guard(scope(), saved), /已更换/);
  assert.equal(draft.attachments[0].contentBase64, contentBase64);
  await assert.rejects(put('卷帘', 'A211', '主图', main.id), /已变化/);
  await photos.change(p, doc, {
    sheet: '卷帘',
    item: 'A211',
    slot: '色卡',
    expectedId: extra.id,
    remove: true,
  });
  assert.throws(() => photos.attachment(extra.id), /已变化/);
  await put('卷帘', '旧名', '主图');
  await put('斑马帘', 'AB15', '主图');
  db.prepare('INSERT INTO material_versions VALUES(?,?,?)').run(
    p,
    1,
    JSON.stringify({ documentIds: [doc] }),
  );
  product(next, 'draft');
  assert.deepEqual(scope(), []);
  const suggestions = photos.suggestions(p, next),
    match = suggestions.find((s) => !s.reason);
  assert.match(suggestions.find((s) => s.item === '旧名').reason, /更名/);
  assert.match(suggestions.find((s) => s.item === 'AB15').reason, /重复/);
  assert.equal(photos.list(p, next, { q: 'A211' }).rows.flatMap((r) => r.photos).length, 0);
  assert.throws(() => photos.carry(p, next, [match.id, 'invalid']), /已变化/);
  assert.equal(photos.list(p, next, { q: 'A211' }).rows.flatMap((r) => r.photos).length, 0);
  assert.deepEqual(photos.carry(p, next, [match.id]), { count: 1 });
  assert.throws(() => photos.carry(p, next, [match.id]), /已变化/);
  product(next);
  const current = photos.automatically(opts('卷帘 A211'), '卷帘 A211');
  photos.guard(scope(), { attachments: current });
  assert.equal(current.length, 1);
  product(next, 'archived');
  assert.throws(() => photos.guard(scope(), { attachments: current }), /引用范围/);
  await assert.rejects(
    photos.change(p, next, {
      sheet: '卷帘',
      item: 'A211',
      slot: '主图',
      expectedId: current[0].id,
      remove: true,
    }),
    /已变化/,
  );
});
