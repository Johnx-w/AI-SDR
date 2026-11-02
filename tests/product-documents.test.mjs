import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { createApp } from '../server/app.mjs';
import { ApiConnections } from '../server/api-connections.mjs';
import { MAX_PRODUCT_DOCUMENT_BYTES } from '../server/product-documents.mjs';

const png = {
  name: '规格原图.png',
  contentType: 'image/png',
  contentBase64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=',
};
const pdf = {
  name: '规格.pdf',
  contentType: 'application/pdf',
  contentBase64: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64'),
};
const env = {
  DOCUMENT_MODEL_BASE_URL: 'https://vision.example.org/v1',
  DOCUMENT_MODEL_API_KEY: 'private-document-key',
  DOCUMENT_MODEL_MODEL: 'vision-model',
};
const facts = {
  facts: [
    { text: '型号 A，叶片宽度 50 mm，公差 ±0.2 mm。', page: 1, location: '正视图，叶片上方尺寸线' },
  ],
  warnings: ['右侧标注模糊，未提取。'],
};
const completed = (value = facts) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const product = { name: '型号 A 百叶窗', category: 'shutters', direction: 'finished' };

test('原文件与候选跨重启保存；去重、审核隔离、产品归属及新版本重新审核', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-documents-'));
  const path = join(folder, 'knowledge.sqlite');
  let store = new ProductKnowledge(path);
  try {
    let current = store.save(product);
    const document = store.documents.upload(current.id, png);
    assert.equal(
      store.documents.upload(current.id, { ...png, name: '再次上传.png' }).id,
      document.id,
    );
    assert.equal(store.documents.list(current.id).length, 1);
    let calls = 0;
    const extract = () =>
      store.documents.extract(current.id, document.id, {
        env,
        fetchImpl: async (url, options) => {
          calls++;
          assert.equal(url, env.DOCUMENT_MODEL_BASE_URL + '/responses');
          const request = JSON.parse(options.body);
          assert.equal(request.store, false);
          assert.equal(request.input[0].content[1].type, 'input_image');
          assert.match(request.input[0].content[1].image_url, /^data:image\/png;base64,/);
          assert.match(request.instructions, /单位、公差/);
          return Response.json(completed());
        },
      });
    const [first, second] = await Promise.all([extract(), extract()]);
    assert.deepEqual(first, second);
    assert.equal(calls, 1);
    assert.deepEqual(store.get(current.id), current, 'AI 提取不能写入产品事实');
    assert.equal(store.list({ usableOnly: true }).length, 0);
    assert.equal(first.extraction.facts[0].page, 1);
    assert.equal(first.extraction.model, env.DOCUMENT_MODEL_MODEL);
    const other = store.save({ ...product, name: '其他产品' });
    assert.throws(() => store.save({ ...other, documentIds: [document.id] }), /必须属于当前产品/);
    assert.throws(
      () => store.save({ ...current, documentIds: ['pd_' + 'f'.repeat(64)] }),
      /必须属于当前产品/,
    );
    assert.throws(
      () => store.save({ ...current, documentIds: [document.id], status: 'approved' }),
      /审核人/,
    );
    current = store.save({
      ...current,
      specifications: facts.facts[0].text,
      documentIds: [document.id],
    });
    assert.equal(store.list({ usableOnly: true }).length, 0);
    current = store.save({ ...current, status: 'approved', approvedBy: '核对人' });
    assert.equal(store.list({ usableOnly: true })[0].id, current.id);
    const revision = store.documents.upload(current.id, pdf);
    current = store.save({ ...current, documentIds: [revision.id] });
    assert.equal(current.status, 'draft');
    assert.equal(current.approvedAt, '');
    assert.equal(store.list({ usableOnly: true }).length, 0);
    store.close();
    store = new ProductKnowledge(path);
    assert.deepEqual(store.get(current.id), current);
    assert.equal(store.documents.list(current.id).length, 2);
    const original = store.documents.get(current.id, document.id);
    assert.equal(original.bytes.toString('base64'), png.contentBase64);
    assert.equal(original.extraction.facts[0].text, facts.facts[0].text);
    assert.equal((await extract()).id, document.id);
    assert.equal(calls, 1, '已成功提取的文件不能重复扣费');
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('上传拒绝伪造类型、危险文件名、无效及超大内容，错误结果不污染产品', async () => {
  const store = new ProductKnowledge();
  try {
    const current = store.save(product);
    for (const file of [
      { ...png, name: '../图.png' },
      { ...png, name: '图\r\n.png' },
      { ...png, contentType: 'text/html' },
      { ...png, name: '图.pdf' },
      { ...png, contentBase64: 'AAAA!!!!' },
      { ...png, contentBase64: '' },
      { ...png, contentBase64: Buffer.from('<html>unsafe</html>').toString('base64') },
    ])
      assert.throws(
        () => store.documents.upload(current.id, file),
        (error) => error.status === 400,
      );
    assert.throws(
      () =>
        store.documents.upload(current.id, {
          ...png,
          contentBase64: 'a'.repeat(Math.ceil(MAX_PRODUCT_DOCUMENT_BYTES / 3) * 4 + 4),
        }),
      (error) => error.status === 413,
    );
    assert.equal(store.documents.list(current.id).length, 0);
    const document = store.documents.upload(current.id, png);
    await assert.rejects(
      () => store.documents.extract(current.id, document.id, { env: {} }),
      (error) => error.status === 503,
    );
    for (const result of [
      { ...completed(), status: 'incomplete' },
      completed({ ...facts, status: 'approved' }),
      completed({ ...facts, facts: [{ ...facts.facts[0], page: 2 }] }),
      completed({ ...facts, facts: [{ ...facts.facts[0], location: '' }] }),
      {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
      },
    ]) {
      await assert.rejects(
        () =>
          store.documents.extract(current.id, document.id, {
            env,
            fetchImpl: async () => Response.json(result),
          }),
        (error) => error.status === 502,
      );
      assert.equal(store.documents.get(current.id, document.id).extraction, null);
      assert.deepEqual(store.get(current.id), current);
      assert.equal(store.documents.running.size, 0);
    }
    await assert.rejects(
      () =>
        store.documents.extract(current.id, document.id, {
          env,
          fetchImpl: async () => {
            throw new Error(env.DOCUMENT_MODEL_API_KEY);
          },
        }),
      (error) => !error.message.includes(env.DOCUMENT_MODEL_API_KEY),
    );
    assert.equal(
      store.documents.get(current.id, document.id).bytes.toString('base64'),
      png.contentBase64,
    );
  } finally {
    store.close();
  }
});

test('资料模型独立配置、脱敏保存且不改变获客必填条件', () => {
  const connections = new ApiConnections({ env: {} });
  const before = connections.view().missing;
  const view = connections.update({ values: env });
  assert.deepEqual(view.missing, before);
  const key = view.fields.find((field) => field.key === 'DOCUMENT_MODEL_API_KEY');
  assert.equal(key.secret, true);
  assert.equal(key.value, '');
  assert(!JSON.stringify(view).includes(env.DOCUMENT_MODEL_API_KEY));
  assert.equal(connections.environment().DOCUMENT_MODEL_MODEL, env.DOCUMENT_MODEL_MODEL);
  assert.throws(
    () => connections.update({ values: { DOCUMENT_MODEL_BASE_URL: 'http://example.org' } }),
    /HTTPS/,
  );
  assert.throws(
    () => connections.update({ values: { DOCUMENT_MODEL_MODEL: 'invalid model' } }),
    /名称格式/,
  );
});

test('API 支持 PDF 文件输入、下载和重试；跨站、错配产品及归档写入被拒绝', async () => {
  let modelCalls = 0;
  const app = createApp({
    env,
    fetchImpl: async (url, options) => {
      modelCalls++;
      const body = JSON.parse(options.body);
      assert.equal(body.input[0].content[1].type, 'input_file');
      assert.equal(body.input[0].content[1].filename, pdf.name);
      assert.equal(
        body.input[0].content[1].file_data,
        'data:application/pdf;base64,' + pdf.contentBase64,
      );
      return Response.json(completed());
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}/api/v1/products/knowledge`;
  const call = (url, method = 'GET', body, headers = {}) =>
    fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    let current = (
      await (await call(base, 'POST', product, { 'Idempotency-Key': 'document-api-001' })).json()
    ).product;
    const path = `${base}/${current.id}/documents`;
    assert.equal(
      (await call(path, 'POST', pdf, { Origin: 'https://untrusted.example.org' })).status,
      403,
    );
    const uploaded = await call(path, 'POST', pdf);
    assert.equal(uploaded.status, 201);
    const { document } = await uploaded.json();
    assert.equal(modelCalls, 0, '上传不自动发送到模型');
    assert.equal((await (await call(path)).json()).documents.length, 1);
    const file = await call(`${path}/${document.id}/file`);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.match(file.headers.get('content-disposition'), /^attachment;/);
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), pdf.contentBase64);
    for (let index = 0; index < 2; index++) {
      const extracted = await call(`${path}/${document.id}/extract`, 'POST');
      assert.equal(extracted.status, 200);
      assert.equal((await extracted.json()).document.extraction.facts.length, 1);
    }
    assert.equal(modelCalls, 1);
    assert.equal((await (await call(base)).json()).products[0].specifications, '');
    const other = (
      await (
        await call(
          base,
          'POST',
          { ...product, name: 'B' },
          { 'Idempotency-Key': 'document-api-002' },
        )
      ).json()
    ).product;
    assert.equal((await call(`${base}/${other.id}/documents/${document.id}/file`)).status, 404);
    current = (await (await call(base, 'PUT', { ...current, status: 'archived' })).json()).product;
    assert.equal((await call(path, 'POST', png)).status, 409);
    assert.equal((await call(`${path}/${document.id}/extract`, 'POST')).status, 409);
    assert.equal((await call(`${path}/${document.id}/file`)).status, 200);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
