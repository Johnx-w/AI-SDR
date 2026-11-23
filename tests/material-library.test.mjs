import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { MaterialLibrary } from '../server/materials.mjs';
import { createApp } from '../server/app.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';
import { workbookType } from '../server/product-workbooks.mjs';
const honey = 'honeybadgerblinds.com',
  other = 'shuangshengshutter.com';
const boxes = [
  { website: 'https://' + honey, brandName: 'Honey Badger Blinds' },
  { website: 'https://' + other, brandName: 'Shuangsheng Shutter' },
];
const data = (name, body, site = '') => ({
  name,
  bytes: Buffer.from(body),
  site,
  key: randomUUID(),
});
test('素材直接上传、重试幂等、站点隔离、换版撤回及跨重启回读', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'materials-')),
    path = join(dir, 'content.sqlite');
  let k = new ProductKnowledge(path);
  t.after(() => {
    k.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let lib = new MaterialLibrary(k, boxes);
  const input = data('型号说明.txt', 'Motor R71 is 71 mm wide.\nMotor R72 is 72 mm wide.');
  const { id, documentId } = await lib.upload(input);
  assert.equal((await lib.upload(input)).reused, true);
  await assert.rejects(
    lib.upload({ ...input, bytes: Buffer.from('new payload') }),
    (e) => e.status === 409,
  );
  let d = lib.detail(id);
  assert.equal(d.product.materialOnly, true);
  assert.equal(d.product.version, 1);
  assert.deepEqual(d.sites, []);
  assert.equal(d.documents[0].extraction.facts[1].location, '第 2 段');
  assert.equal(lib.list({ site: 'unassigned' }).total, 1);
  let item = lib.edit(id, {
    version: 1,
    site: honey,
    keywords: ['遮阳'],
    category: '配件',
    sourceFacts: [{ documentId, text: 'Motor R72 is 72 mm wide.', location: '第 2 段' }],
  });
  assert.equal(lib.list({ site: honey, q: '遮阳', category: ['配件'] }).total, 1);
  item = lib.edit(id, { version: item.version, status: 'approved', approvedBy: '审核员' });
  const ask = (website) =>
    answerMailQuestion(k, { website, knowledgeProductIds: [id] }, 'How wide is Motor R72?');
  assert.equal(ask(boxes[0].website).sources[0].ref, '第 2 段');
  assert.equal(ask(boxes[1].website).sources.length, 0);
  assert.equal(
    (await lib.upload({ ...input, name: '别名.txt', key: randomUUID(), site: honey })).reused,
    true,
  );
  const replacement = await lib.upload({
    ...data('修订.txt', 'Motor R72 is 73 mm wide.'),
    id,
    version: item.version,
  });
  assert.equal(ask(boxes[0].website).sources.length, 0);
  assert.notEqual(documentId, replacement.documentId);
  assert.equal(lib.detail(id, item.version).documents[0].id, documentId);
  d = lib.detail(id);
  assert.equal(d.product.status, 'draft');
  assert.deepEqual(d.product.sourceFacts || [], []);
  assert.equal(lib.list({ site: other }).total, 0);
  assert.throws(
    () => lib.bulk({ items: [{ id, version: 1 }], changes: { status: 'archived' } }),
    (e) => e.status === 409,
  );
  lib.bulk({ items: [{ id, version: d.currentVersion }], changes: { status: 'archived' } });
  k.close();
  k = new ProductKnowledge(path);
  lib = new MaterialLibrary(k, boxes);
  assert.equal(lib.list().total, 0);
  assert.equal(lib.list({ status: 'archived' }).total, 1);
  assert.equal(lib.detail(id).documents[0].id, replacement.documentId);
});
test('升级已有工作簿不重复保存文件或变为推品；纯产品不混入素材列表与品类', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k, boxes);
  k.save({ name: '现有商品', direction: 'finished', materialCategory: '独立产品' });
  let p = k.save({
    name: '已批准型号合集',
    direction: 'materials',
    sourceUrl: boxes[0].website,
    materialCategory: '工作簿',
  });
  const bytes = readFileSync(new URL('./fixtures/mail-specimen.xlsx', import.meta.url)),
    doc = k.documents.upload(p.id, {
      name: '原始厂商文档.xlsx',
      contentType: workbookType,
      contentBase64: bytes.toString('base64'),
    });
  await k.documents.extract(p.id, doc.id, { env: {} });
  p = k.save({ ...p, documentIds: [doc.id], approvedBy: '验收', status: 'approved' });
  const rep = await lib.upload({ name: '新的文件名.xlsx', bytes, site: honey, key: randomUUID() });
  assert.equal(rep.id, p.id);
  assert.equal(rep.reused, true);
  assert.equal(k.get(p.id).version, p.version);
  assert.equal(k.documents.list(p.id).length, 1);
  assert.deepEqual(lib.list().categories, ['工作簿']);
  assert.equal(lib.list().total, 1);
  assert.equal(k.list().length, 2);
  const edit = lib.edit(p.id, { version: p.version, name: '整理后的文档', category: '样本' });
  assert.equal(edit.materialOnly, undefined);
  assert.deepEqual(edit.documentIds, [doc.id]);
  assert.equal(edit.status, 'draft');
});
test('素材解析 DOCX 和多格式预览，批量编辑原子性，筛选总数与翻页一致', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k, boxes);
  const file = await lib.upload(
    data(
      '叶片.docx',
      readFileSync(new URL('./fixtures/material-slats.docx', import.meta.url)),
      other,
    ),
  );
  assert.equal(file.warning, '');
  assert.match(lib.detail(file.id).documents[0].extraction.facts[1].text, /89 mm/);
  await assert.rejects(lib.upload(data('伪造.png', 'text')), (e) => e.status === 400);
  for (let i = 0; i < 12; i++) await lib.upload(data('手册' + i + '.md', '说明 ' + i, honey));
  const p1 = lib.list({ site: honey, pageSize: 10 }),
    p2 = lib.list({ site: honey, pageSize: 10, page: 2 });
  assert.equal(p1.total, 12);
  assert.equal(p2.total, 12);
  assert.equal(p2.items.length, 2);
  assert.ok(p1.items.every((m) => !p2.items.some((a) => a.id === m.id)));
  const [a, b] = p1.items;
  assert.throws(() =>
    lib.bulk({
      items: [
        { id: a.id, version: a.version },
        { id: b.id, version: 999 },
      ],
      changes: { category: '不应保存' },
    }),
  );
  assert.notEqual(lib.detail(a.id).product.materialCategory, '不应保存');
});
test('正式素材 API 读取和原件分段下载不依赖云端，跨站上传被拒绝', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'material-http-')),
    env = {
      BATCH_DB_PATH: join(dir, 'content.sqlite'),
      CONNECTIONS_PATH: join(dir, 'connections.json'),
      OUTREACH_DATA_DIR: join(dir, 'mailboxes'),
    };
  const outside = [];
  const app = createApp({
    env,
    outreachServiceFactory: () => ({ mailboxes: { list: () => boxes }, close() {} }),
    fetchImpl: async (...args) => {
      outside.push(args.length);
      throw Error('offline');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1/materials';
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': randomUUID() },
    body: 'abcdefgh',
  };
  assert.equal(
    (
      await fetch(base + '?name=test.txt', {
        ...init,
        headers: { ...init.headers, origin: 'https://foreign.invalid' },
      })
    ).status,
    403,
  );
  const saved = await fetch(base + '?name=test.txt&site=' + honey, init);
  assert.equal(saved.status, 201);
  const doc = await saved.json();
  const listing = await (await fetch(base)).json();
  assert.equal(listing.total, 1);
  assert.equal(listing.items[0].size, 8);
  const url = base + '/' + doc.id + '/document/' + doc.documentId;
  const piece = await fetch(url, { headers: { Range: 'bytes=2-4' } });
  assert.equal(piece.status, 206);
  assert.equal(piece.headers.get('content-range'), 'bytes 2-4/8');
  assert.equal(await piece.text(), 'cde');
  assert.equal((await fetch(url, { headers: { Range: 'bytes=999-' } })).status, 416);
  assert.equal(
    (await fetch(url + '?download=1')).headers.get('content-disposition').startsWith('attachment;'),
    true,
  );
  assert.deepEqual(outside, []);
});
