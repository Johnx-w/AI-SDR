import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';

const basePath = '/api/v1/products/knowledge';
const draft = {
  name: '卷帘资料',
  englishName: 'Roller blinds',
  category: 'indoor',
  direction: 'finished',
};

async function serve(folder, externalCalls) {
  const env = {
    ACQUISITION_PROVIDER: 'native',
    CONNECTIONS_PATH: join(folder, 'connections.json'),
    BATCH_DB_PATH: join(folder, 'products.sqlite'),
    PRODUCT_KNOWLEDGE_DB_PATH: join(folder, 'products.sqlite'),
    PRODUCT_DB_PATH: join(folder, 'products.sqlite'),
    MAIL_DB_PATH: ':memory:',
    SCHEDULE_DB_PATH: ':memory:',
  };
  const app = createApp({
    env,
    fetchImpl: async (...args) => {
      externalCalls.push(args);
      throw new Error('Product API tests must not access external services');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  return {
    async call(path = basePath, { method = 'GET', body, key } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key === undefined ? {} : { 'Idempotency-Key': key }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise((resolve) => app.close(resolve)),
  };
}

test('T5 API 空库不预置供货事实，新增操作幂等且重启后不重复创建', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-knowledge-api-create-'));
  const externalCalls = [];
  let server;
  try {
    server = await serve(folder, externalCalls);
    const empty = await server.call();
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.products, []);
    assert.equal(empty.body.source, 'local');
    assert.equal(empty.body.feishu.status, 'not_configured');
    for (const key of [undefined, '', 'short', 'invalid key']) {
      const invalid = await server.call(basePath, { method: 'POST', body: draft, key });
      assert.equal(invalid.status, 400);
    }
    assert.deepEqual((await server.call()).body.products, []);
    const first = await server.call(basePath, {
      method: 'POST',
      body: draft,
      key: 't5-api-create-001',
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.product.status, 'draft');
    assert.equal(first.body.product.version, 1);
    assert.equal(first.body.product.moq, '');
    assert.equal(first.body.product.specifications, '');
    assert.equal(first.body.feishu.status, 'not_configured');
    const duplicate = await server.call(basePath, {
      method: 'POST',
      body: { ...draft },
      key: 't5-api-create-001',
    });
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.body.product.id, first.body.product.id);
    assert.equal(duplicate.body.product.version, 1);
    const conflict = await server.call(basePath, {
      method: 'POST',
      body: { ...draft, name: '不同产品' },
      key: 't5-api-create-001',
    });
    assert.equal(conflict.status, 409);
    assert.equal((await server.call()).body.products.length, 1);
    await server.close();
    server = await serve(folder, externalCalls);
    const replay = await server.call(basePath, {
      method: 'POST',
      body: draft,
      key: 't5-api-create-001',
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.product.id, first.body.product.id);
    assert.equal(replay.body.product.createdAt, first.body.product.createdAt);
    assert.equal((await server.call()).body.products.length, 1);
    const searchVocabulary = await server.call('/api/v1/acquisition/products');
    assert.equal(searchVocabulary.status, 200);
    assert(searchVocabulary.body.products.length > 10);
    assert(searchVocabulary.body.products.some((item) => item.direction === 'materials'));
    assert.equal(externalCalls.length, 0);
  } finally {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('T5 API 修改需校验版本，审核依据不足不通过，事实修改后重新审核且归档可持久查看', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-knowledge-api-review-'));
  const externalCalls = [];
  let server;
  try {
    server = await serve(folder, externalCalls);
    let current = (
      await server.call(basePath, { method: 'POST', body: draft, key: 't5-api-review-001' })
    ).body.product;
    const missingVersion = { ...current };
    delete missingVersion.version;
    assert.equal(
      (await server.call(basePath, { method: 'PUT', body: missingVersion })).status,
      409,
    );
    assert.equal(
      (await server.call(basePath, { method: 'PUT', body: { ...current, expectedVersion: 99 } }))
        .status,
      409,
    );
    for (const changes of [
      { status: 'approved' },
      { status: 'approved', approvedBy: '审核人' },
      { status: 'approved', sourceUrl: 'https://example.com/catalog' },
      { status: 'approved', approvedBy: '审核人', sourceUrl: 'javascript:alert(1)' },
    ]) {
      assert.equal(
        (
          await server.call(basePath, {
            method: 'PUT',
            body: { ...current, ...changes, expectedVersion: current.version },
          })
        ).status,
        400,
      );
      assert.equal((await server.call()).body.products[0].version, current.version);
    }
    const approved = await server.call(basePath, {
      method: 'PUT',
      body: {
        ...current,
        expectedVersion: 1,
        status: 'approved',
        approvedBy: '业务审核人',
        sourceUrl: 'https://example.com/catalog',
      },
    });
    assert.equal(approved.status, 200);
    current = approved.body.product;
    assert.equal(current.status, 'approved');
    assert.equal(current.version, 2);
    assert(current.approvedAt);
    const edited = await server.call(basePath, {
      method: 'PUT',
      body: { ...current, expectedVersion: 2, specifications: '更新的产品参数' },
    });
    assert.equal(edited.status, 200);
    current = edited.body.product;
    assert.equal(current.status, 'draft');
    assert.equal(current.approvedBy, '');
    assert.equal(current.approvedAt, '');
    assert.equal(current.version, 3);
    const creationReplay = await server.call(basePath, {
      method: 'POST',
      body: draft,
      key: 't5-api-review-001',
    });
    assert.equal(creationReplay.body.product.id, current.id);
    assert.equal(creationReplay.body.product.version, 3);
    assert.equal(creationReplay.body.product.specifications, '更新的产品参数');
    const archived = await server.call(basePath, {
      method: 'PUT',
      body: { ...current, expectedVersion: 3, status: 'archived' },
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.product.version, 4);
    await server.close();
    server = await serve(folder, externalCalls);
    const restored = await server.call();
    assert.equal(restored.body.products.length, 1);
    assert.equal(restored.body.products[0].status, 'archived');
    assert.equal(restored.body.products[0].specifications, '更新的产品参数');
    assert.equal(restored.body.products[0].version, 4);
    assert.equal(externalCalls.length, 0);
  } finally {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('T5 API 手动同步未知产品返回404，未配置飞书时保留本地版本并明确返回状态', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-knowledge-api-sync-'));
  const externalCalls = [];
  let server;
  try {
    server = await serve(folder, externalCalls);
    const absent = await server.call(basePath + '/pk_' + '0'.repeat(32) + '/sync', {
      method: 'POST',
    });
    assert.equal(absent.status, 404);
    const saved = (
      await server.call(basePath, { method: 'POST', body: draft, key: 't5-api-sync-001' })
    ).body.product;
    const result = await server.call(basePath + '/' + saved.id + '/sync', { method: 'POST' });
    assert.equal(result.status, 200);
    assert.equal(result.body.product.id, saved.id);
    assert.equal(result.body.feishu.status, 'not_configured');
    assert.equal(result.body.product.version, 1);
    assert.equal(result.body.product.updatedAt, saved.updatedAt);
    assert.equal((await server.call()).body.products[0].version, 1);
    assert.equal(externalCalls.length, 0);
  } finally {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
