import test from 'node:test';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { materialService } from './fixtures/deepseek-material-service.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { extractText } from '../server/material-formats.mjs';
import { MaterialLibrary } from '../server/materials.mjs';
import { createApp } from '../server/app.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';
import { workbookType } from '../server/product-workbooks.mjs';
import { normalizeAttachments } from '../server/mail-content.mjs';
import { checkMaterialSize } from '../src/domain/material-upload.mjs';
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
  env: { MATERIAL_DEEPSEEK_API_KEY: 'fixture' },
  fetchImpl: materialService,
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
  assert.equal(lib.list().items[0].extractionStatus, 'ready');
  assert.equal(lib.list().items[0].extractionCount, 2);
  const extracted = d.documents[0].extraction;
  k.documents.saveExtractionFailure(documentId, '测试失败');
  assert.equal(lib.list().items[0].extractionStatus, 'failed');
  k.documents.saveExtraction(documentId, { extraction: extracted });
  assert.equal(lib.list().items[0].extractionStatus, 'ready');
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
test('长段落跨分块仍保留型号末尾和 Markdown 标题位置', async () => {
  const text = 'Check the complete catalogue. '.repeat(155) + 'Item ZX-427 is 1.25 mm thick.';
  const result = await extractText({
    contentType: 'text/markdown',
    bytes: Buffer.from('# Products\n## Tracks\n' + text),
  });
  const chunks = result.facts.filter((fact) => fact.location.startsWith('第 3 段'));
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((fact) => fact.text).join(' '), text);
  assert.match(chunks.at(-1).location, /分块 \d+ · Products \/ Tracks/u);
  assert.deepEqual(result.warnings, []);
});

test('独立图片按附件保存，重复读取不改版，损坏换版保留原图', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k, boxes);
  const bytes = readFileSync(new URL('./fixtures/material-spec.webp', import.meta.url));
  const input = data('spec.webp', bytes);
  const { id, documentId, warning } = await lib.upload(input);
  assert.equal(warning, '');
  const before = lib.detail(id);
  const result = before.documents[0].extraction;
  assert.equal(result.model, 'manual');
  assert.deepEqual(result.facts, []);
  assert.equal((await lib.upload(input)).reused, true);
  await assert.rejects(
    lib.upload({ ...data('bad.webp', bytes.subarray(0, 16)), id, version: 1 }),
    /无法读取图片/,
  );
  assert.deepEqual(lib.detail(id), before);
  assert.equal(lib.detail(id).documents[0].id, documentId);
});

test('素材自动识别 PDF 文字、图内中英参数和扫描页，回读后可按页引用', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'material-pdf-'));
  const path = join(dir, 'knowledge.sqlite');
  let k = new ProductKnowledge(path);
  t.after(() => {
    k.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let lib = new MaterialLibrary(k, boxes);
  const bytes = readFileSync(new URL('./fixtures/material-mixed-catalog.pdf', import.meta.url));
  const input = data('选型资料.pdf', bytes, honey);
  const { id, documentId, warning } = await lib.upload(input);
  assert.equal(warning, '');
  k.close();
  k = new ProductKnowledge(path);
  lib = new MaterialLibrary(k, boxes);
  const doc = lib.detail(id).documents[0];
  assert.equal(doc.extraction?.pageCount, 3);
  const facts = doc.extraction.facts;
  assert.ok(facts.some((f) => f.page === 1 && f.text.includes('R-80')));
  const spec = facts.find((f) => f.page === 2 && /73\s*mm/iu.test(f.text));
  assert.match(spec?.text || '', /MX42/);
  assert.match(spec.text, /行程\s*125\s*毫米/u);
  assert.ok(facts.some((f) => f.page === 3 && f.text.includes('ZX905')));
  const box = { ...boxes[0], knowledgeProductIds: [id] };
  const ask = () =>
    answerMailQuestion(k, box, 'How wide is the MX42 track?', Date.now(), { forDraft: true });
  assert.equal(ask().sources.length, 0);
  const ref = '第 2 页 · ' + spec.location;
  const approved = lib.edit(id, {
    version: 1,
    status: 'approved',
    approvedBy: '测试审核',
    sourceFacts: [{ documentId, location: ref, text: spec.text }],
  });
  assert.ok(ask().draftSources.some((s) => s.ref === ref && s.value.includes('73')));
  await assert.rejects(
    lib.upload({ ...data('损坏新版.pdf', '%PDF-1.7\ninvalid'), id, version: approved.version }),
    /DeepSeek|PDF/,
  );
  assert.equal(lib.detail(id).product.version, approved.version);
  assert.equal(lib.detail(id).documents[0].id, documentId);
  assert.deepEqual(k.documents.get(id, documentId).bytes, bytes);
});

test('旧 PDF 空提取从素材接口后台补齐，同一原件重试保留审核片段', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'material-existing-pdf-'));
  const path = join(dir, 'knowledge.sqlite'),
    k = new ProductKnowledge(path);
  let product = k.save({ name: '已有图册', direction: 'materials', sourceUrl: 'https://' + honey });
  const doc = k.documents.store(product.id, {
    name: '旧图册.pdf',
    contentType: 'application/pdf',
    bytes: readFileSync(new URL('./fixtures/material-mixed-catalog.pdf', import.meta.url)),
  });
  const sourceFacts = [
    { documentId: doc.id, location: '原人工核对', text: 'Keep this reference.' },
  ];
  product = k.save({
    ...product,
    status: 'approved',
    approvedBy: '测试审核',
    documentIds: [doc.id],
    sourceFacts,
  });
  k.db
    .prepare('UPDATE product_documents SET extraction=? WHERE id=?')
    .run(JSON.stringify({ facts: [], warnings: ['未提取'], model: 'previous' }), doc.id);
  k.close();
  const app = createApp({
    env: { PRODUCT_KNOWLEDGE_DB_PATH: path, MATERIAL_DEEPSEEK_API_KEY: 'fixture' },
    outreachServiceFactory: () => ({ mailboxes: { list: () => boxes }, close() {} }),
    fetchImpl: materialService,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1/materials';
  const extract = base + '/' + product.id + '/extract/' + doc.id;
  const begin = await fetch(extract, { method: 'POST', headers: { Prefer: 'respond-async' } });
  assert.equal(begin.status, 202);
  const { processingId } = await begin.json();
  let status;
  for (let attempt = 0; attempt < 400; attempt++) {
    const poll = await fetch(base + '/processing/' + processingId);
    status = poll.status;
    await poll.json();
    if (status !== 202) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status, 200);
  const detail = () => fetch(base + '/' + product.id).then((r) => r.json());
  const after = await detail();
  assert.equal(after.documents[0].extraction.pageCount, 3);
  assert.ok(
    after.documents[0].extraction.facts.some((f) => f.page === 2 && f.text.includes('73 mm')),
  );
  assert.deepEqual(after.product.sourceFacts, sourceFacts);
  assert.equal(after.product.version, product.version);
  assert.equal(after.product.status, 'approved');
  assert.equal((await fetch(extract, { method: 'POST' })).status, 200);
  assert.deepEqual(await detail(), after);
});

test(
  '上传完成时取素材库密钥，在途图文解析沿用同一密钥，失败重试和清除后重读',
  { timeout: 15000 },
  async (t) => {
    const gates = [0, 1].map(() => ({
      entered: Promise.withResolvers(),
      resume: Promise.withResolvers(),
    }));
    const calls = [];
    let attempt = 0;
    const app = createApp({
      env: { MATERIAL_DEEPSEEK_API_KEY: 'before-upload', DEEPSEEK_API_KEY: 'fallback' },
      outreachServiceFactory: () => ({ mailboxes: { list: () => [] }, close() {} }),
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/ocr')) attempt++;
        calls.push([path, init.headers.Authorization]);
        const gate = path.endsWith('/ocr') && gates[attempt - 1];
        if (gate) {
          gate.entered.resolve();
          await gate.resume.promise;
        }
        if (attempt === 1 && path === '/chat/completions')
          return Response.json({ error: { code: 'expired' } }, { status: 401 });
        return materialService(url, init);
      },
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const gate of gates) gate.resume.resolve();
      app.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
    });
    const root = 'http://127.0.0.1:' + app.address().port + '/api/v1';
    const field = 'MATERIAL_DEEPSEEK_API_KEY';
    async function setKey(value) {
      const result = await fetch(root + '/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          value ? { values: { [field]: value } } : { values: {}, clear: [field] },
        ),
      });
      assert.equal(result.status, 200);
    }
    const bytes = readFileSync(new URL('./fixtures/material-slats.docx', import.meta.url));
    const accepting = once(app, 'request');
    const stream = new PassThrough();
    const upload = fetch(root + '/materials?name=rotation.docx', {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID(), 'Content-Length': String(bytes.length) },
      body: stream,
      duplex: 'half',
    });
    stream.write(bytes.subarray(0, 4));
    await accepting;
    await setKey('first');
    stream.end(bytes.subarray(4));
    await gates[0].entered.promise;
    await setKey('second');
    gates[0].resume.resolve();
    const saved = await (await upload).json();
    assert.match(saved.warning, /密钥无效/);
    const extract = root + '/materials/' + saved.id + '/extract/' + saved.documentId;
    const retry = fetch(extract, { method: 'POST' });
    await gates[1].entered.promise;
    await setKey('');
    gates[1].resume.resolve();
    assert.equal((await retry).status, 200);
    assert.equal((await fetch(extract + '?reparse=1', { method: 'POST' })).status, 200);
    assert.deepEqual(
      calls,
      ['first', 'second', 'fallback'].flatMap((key) =>
        [
          '/v1/tools/ocr',
          '/files',
          '/chat/completions',
          ...(key === 'first' ? [] : ['/chat/completions']),
          '/files/file-api-synthetic',
        ].map((path) => [path, 'Bearer ' + key]),
      ),
    );
    const detail = await (await fetch(root + '/materials/' + saved.id)).json();
    assert.equal(detail.documents.length, 1);
    assert.equal(detail.documents[0].id, saved.documentId);
    assert.equal(detail.documents[0].extraction.pageCount, 2);
  },
);

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

test('换版文件可上传但无法解析时，保留已审核版本、原件与校对内容', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k);
  const { id, documentId } = await lib.upload(data('参数.txt', 'Width 72 mm'));
  const approved = lib.edit(id, {
    version: 1,
    status: 'approved',
    approvedBy: 'QA',
    sourceFacts: [{ documentId, location: '第 1 段', text: 'Width 72 mm' }],
  });
  const before = lib.detail(id);
  await assert.rejects(
    lib.upload({ ...data('空正文.txt', '   \n  '), id, version: approved.version }),
    /没有可读文字/u,
  );
  assert.deepEqual(lib.detail(id), before);
  const file = readFileSync(new URL('./fixtures/material-slats.docx', import.meta.url));
  const upload = {
    name: '误选工作簿.xlsx',
    bytes: file,
    key: randomUUID(),
    id,
    version: approved.version,
  };
  await assert.rejects(lib.upload(upload), /XLSX|工作簿/);
  assert.deepEqual(lib.detail(id), before);
  assert.equal(k.documents.list(id).length, 1);
  const replacements = await Promise.allSettled(
    ['Width 73 mm', 'Width 74 mm'].map((body) =>
      lib.upload({ ...data('新参数.txt', body), id, version: approved.version }),
    ),
  );
  assert.equal(replacements.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(replacements.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal(lib.detail(id).currentVersion, approved.version + 1);
  assert.equal(k.documents.list(id).length, 2);
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

test('素材新建与换版按实际字节接受 50 MiB，超限保留当前版本及原件', async (t) => {
  const app = createApp({
    env: {},
    outreachServiceFactory: () => ({ mailboxes: { list: () => [] }, close() {} }),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1/materials';
  const post = (path, body) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': randomUUID() },
      body,
      duplex: 'half',
    });
  const bytes = Buffer.alloc(50 * 1024 ** 2, ' ');
  const tail = '\nWidth 72 mm';
  bytes.write(tail, bytes.length - tail.length);
  const first = await post('?name=spec.txt', bytes);
  assert.equal(first.status, 201);
  const { id, documentId } = await first.json();
  const versions = '/' + id + '/versions?name=spec.txt&version=';
  bytes.write('73', bytes.length - 5);
  const revised = await post(versions + '1', bytes);
  assert.equal(revised.status, 201);
  const current = await revised.json();
  assert.notEqual(current.documentId, documentId);
  assert.equal(current.warning, '');

  const over = Buffer.concat([bytes, Buffer.from('\n')]);
  async function* chunks() {
    for (let i = 0; i < over.length; i += 65536) yield over.subarray(i, i + 65536);
  }
  for (const [url, body] of [
    ['?name=over.txt', over],
    [versions + '2', chunks()],
  ]) {
    const refused = await post(url, body);
    assert.equal(refused.status, 413);
    assert.match((await refused.json()).error, /50 MiB/);
  }
  const detail = await (await fetch(base + '/' + id)).json();
  assert.equal(detail.currentVersion, 2);
  assert.deepEqual(detail.history, [2, 1]);
  assert.equal(detail.documents[0].id, current.documentId);
  assert.equal(detail.documents[0].size, bytes.length);
  assert.equal(detail.documents[0].extraction.facts.at(-1).text, 'Width 73 mm');
  for (const [doc, expected] of [
    [documentId, '72 mm'],
    [current.documentId, '73 mm'],
  ]) {
    const raw = await fetch(base + '/' + id + '/document/' + doc, {
      headers: { Range: 'bytes=-5' },
    });
    assert.equal(raw.status, 206);
    assert.equal(await raw.text(), expected);
  }
  assert.equal((await (await fetch(base)).json()).total, 1);
});

test('素材分段按实际长度、顺序及目标校验，完整落库前可重试且不影响原件', async (t) => {
  const app = createApp({
    env: { BATCH_DB_PATH: ':memory:' },
    outreachServiceFactory: () => ({ mailboxes: { list: () => [] }, close() {} }),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1/materials';
  const part = Buffer.alloc(8 * 1024 ** 2, ' ');
  const last = Buffer.from('\nDry cloth');
  const total = part.length + last.length;
  const headers = { 'Content-Type': 'application/octet-stream', 'Idempotency-Key': randomUUID() };
  const send = (target, start, end, bytes, size = total, extra = {}) =>
    fetch(base + target, {
      method: 'POST',
      headers: { ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, ...extra },
      body: bytes,
    });
  const path = '/parts?name=care.txt';
  assert.equal((await send(path, 0, part.length - 1, part, 52428801)).status, 413);
  assert.equal((await send(path, 0, part.length - 1, last)).status, 400);
  assert.equal((await send(path, part.length, total - 1, last)).status, 409);
  assert.equal(
    (await send(path, 0, part.length - 1, part, total, { origin: 'https://foreign.invalid' }))
      .status,
    403,
  );
  for (let retry = 0; retry < 2; retry++) {
    const res = await send(path, 0, part.length - 1, part);
    assert.equal(res.status, 202);
    assert.equal((await res.json()).received, part.length);
  }
  assert.equal((await (await fetch(base)).json()).total, 0);
  assert.equal((await send('/parts?name=other.txt', part.length, total - 1, last)).status, 409);
  const saved = await send(path, part.length, total - 1, last);
  assert.equal(saved.status, 201);
  const { id, documentId } = await saved.json();
  const replace = '/' + id + '/versions/parts?name=care.txt&version=1';
  headers['Idempotency-Key'] = randomUUID();
  assert.equal((await send(replace, 0, part.length - 1, part)).status, 202);
  assert.equal((await send(replace, part.length, total - 1, Buffer.from('x'))).status, 400);
  const detail = await (await fetch(base + '/' + id)).json();
  assert.equal(detail.currentVersion, 1);
  assert.equal(detail.documents[0].id, documentId);
  assert.equal(detail.documents[0].extraction.facts.at(-1).text, 'Dry cloth');
  assert.equal(detail.documents[0].size, total);
});

test('视频额度为 80 MiB，邮件附件按 10 个、解码合计 10 MiB 校验', () => {
  for (const name of ['样片.MOV', '样片.mp4', '样片.webm']) {
    checkMaterialSize(name, 80 * 1024 ** 2);
    assert.throws(() => checkMaterialSize(name, 80 * 1024 ** 2 + 1), /80 MiB/);
  }
  const small = { name: 'extra.txt', contentBase64: 'YQ==' };
  const full = {
    name: 'mail.txt',
    contentBase64: Buffer.alloc(10 * 1024 ** 2, 'a').toString('base64'),
  };
  assert.equal(normalizeAttachments([full])[0].size, 10485760);
  assert.throws(() => normalizeAttachments([full, small]), /10 MB/);
  assert.throws(() => normalizeAttachments(Array(11).fill(small)), /10 个/);
});
