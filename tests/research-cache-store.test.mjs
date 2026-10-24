import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcquisitionStore } from '../server/acquisition-store.mjs';

const key = (index = 1) => index.toString(16).padStart(64, '0');
const ttl = 7 * 24 * 60 * 60 * 1000;
const response = (value = 'model result') => ({
  status: 'completed',
  output: [{ content: [{ type: 'output_text', text: value }] }],
});

test('模型响应持久化读回；同一 key 命中不持有调用方可变对象', () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-model-cache-'));
  const path = join(dir, 'acquisition.sqlite');
  const original = response();
  const first = new AcquisitionStore(path, 'scope-a');
  try {
    first.saveModelResponse(key(), original, { now: 1000 });
    original.output[0].content[0].text = 'caller mutation';
    assert.equal(
      first.modelResponse(key(), { now: 2000 }).output[0].content[0].text,
      'model result',
    );
  } finally {
    first.close();
  }
  const reopened = new AcquisitionStore(path, 'scope-a');
  try {
    const hit = reopened.modelResponse(key(), { now: 2000 });
    assert.deepEqual(hit, response());
    hit.output[0].content[0].text = 'reader mutation';
    assert.deepEqual(reopened.modelResponse(key(), { now: 2000 }), response());
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('模型缓存按飞书 scope 隔离，相同 key 可以有独立内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'research-model-scope-'));
  const path = join(dir, 'acquisition.sqlite');
  const a = new AcquisitionStore(path, 'scope-a');
  const b = new AcquisitionStore(path, 'scope-b');
  try {
    a.saveModelResponse(key(), response('a'), { now: 1000 });
    assert.equal(b.modelResponse(key(), { now: 1000 }), null);
    b.saveModelResponse(key(), response('b'), { now: 1000 });
    assert.deepEqual(a.modelResponse(key(), { now: 1000 }), response('a'));
    assert.deepEqual(b.modelResponse(key(), { now: 1000 }), response('b'));
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TTL 为保存起 7 天，读取不延长寿命，到期返回 null 并清理', () => {
  const store = new AcquisitionStore();
  try {
    store.saveModelResponse(key(), response(), { now: 1000 });
    assert.deepEqual(store.modelResponse(key(), { now: 1000 + ttl - 1 }), response());
    assert.equal(store.modelResponse(key(), { now: 1000 + ttl }), null);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM research_model_responses').get().count,
      0,
    );
  } finally {
    store.close();
  }
});

test('upsert 更新内容并从最近保存重新计算 TTL；摘要大小写归一', () => {
  const store = new AcquisitionStore();
  const upper = 'A'.repeat(64);
  try {
    store.saveModelResponse(upper, response('old'), { now: 1000 });
    store.saveModelResponse(upper.toLowerCase(), response('new'), { now: 2000 });
    assert.deepEqual(store.modelResponse(upper, { now: 1000 + ttl }), response('new'));
    assert.equal(store.modelResponse(upper, { now: 2000 + ttl }), null);
  } finally {
    store.close();
  }
});

test('每 scope 最多保留 200 项，按保存时间淘汰最旧，读取不改变淘汰顺序', () => {
  const store = new AcquisitionStore(':memory:', 'scope-a');
  try {
    for (let i = 1; i <= 200; i++)
      store.saveModelResponse(key(i), response(String(i)), { now: 1000 + i });
    assert.notEqual(store.modelResponse(key(1), { now: 1200 }), null);
    store.saveModelResponse(key(201), response('201'), { now: 1201 });
    assert.equal(store.modelResponse(key(1), { now: 1201 }), null);
    assert.notEqual(store.modelResponse(key(2), { now: 1201 }), null);
    assert.equal(
      store.db
        .prepare('SELECT COUNT(*) AS count FROM research_model_responses WHERE scope=?')
        .get('scope-a').count,
      200,
    );
    store.saveModelResponse(key(2), response('refreshed'), { now: 1300 });
    store.saveModelResponse(key(202), response('202'), { now: 1301 });
    assert.deepEqual(store.modelResponse(key(2), { now: 1301 }), response('refreshed'));
    assert.equal(store.modelResponse(key(3), { now: 1301 }), null);
  } finally {
    store.close();
  }
});

test('保存时仅清理所属 scope 过期项，不影响其他 scope 的缓存', () => {
  const store = new AcquisitionStore(':memory:', 'scope-a');
  try {
    store.saveModelResponse(key(), response('old'), { now: 0 });
    store.db
      .prepare('INSERT INTO research_model_responses VALUES(?,?,?,?)')
      .run('scope-b', key(), 0, JSON.stringify(response('b')));
    store.saveModelResponse(key(2), response('fresh'), { now: ttl });
    assert.equal(store.modelResponse(key(), { now: ttl }), null);
    assert.notEqual(store.modelResponse(key(2), { now: ttl }), null);
    assert.equal(
      store.db
        .prepare('SELECT COUNT(*) AS count FROM research_model_responses WHERE scope=?')
        .get('scope-b').count,
      1,
    );
  } finally {
    store.close();
  }
});

test('同毫秒多次保存时保留最近写入的响应，包括已存在 key 的刷新', () => {
  const store = new AcquisitionStore();
  try {
    for (let i = 1; i <= 200; i++)
      store.saveModelResponse(key(i), response(String(i)), { now: 1000 });
    store.saveModelResponse(key(1), response('refreshed'), { now: 1000 });
    store.saveModelResponse(key(201), response('new'), { now: 1000 });
    assert.deepEqual(store.modelResponse(key(1), { now: 1000 }), response('refreshed'));
    assert.equal(store.modelResponse(key(2), { now: 1000 }), null);
  } finally {
    store.close();
  }
});

test('非法摘要在读写前拒绝，不允许原文 URL、配置或密钥作为 cache key', () => {
  const store = new AcquisitionStore();
  try {
    for (const value of [
      '',
      'not-a-hash',
      'https://company.example/',
      'x'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      null,
      undefined,
      123,
    ]) {
      assert.throws(() => store.modelResponse(value), { status: 400 });
      assert.throws(() => store.saveModelResponse(value, response()), { status: 400 });
    }
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM research_model_responses').get().count,
      0,
    );
  } finally {
    store.close();
  }
});

test('异常、undefined、非 JSON 内容和循环结构不会写入或覆盖已有响应', () => {
  const store = new AcquisitionStore();
  const circular = {};
  circular.self = circular;
  try {
    store.saveModelResponse(key(), response('original'), { now: 1000 });
    for (const value of [
      undefined,
      new Error('private upstream error'),
      { error: new Error('nested') },
      { field: undefined },
      { value: NaN },
      { value: Infinity },
      { value: 1n },
      { callback: () => {} },
      Promise.resolve('not a response'),
      circular,
    ])
      assert.throws(() => store.saveModelResponse(key(), value, { now: 2000 }), { status: 400 });
    assert.deepEqual(store.modelResponse(key(), { now: 2000 }), response('original'));
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS count FROM research_model_responses').get().count,
      1,
    );
  } finally {
    store.close();
  }
});

test('模型缓存不会改变既有操作幂等、写入状态或企业身份记录', () => {
  const store = new AcquisitionStore(':memory:', 'scope-a');
  try {
    const input = { country: 'United States', product: 'roller blinds' };
    const created = store.begin('operation-1', input);
    store.saveCompanyIdentity('rec-1', 'https://company.example/', 'Company', {
      status: 'verified',
    });
    store.saveModelResponse(key(), response(), { now: 1000 });
    assert.equal(store.begin('operation-1', input).existing, true);
    assert.throws(() => store.begin('operation-1', { ...input, product: 'shutters' }), {
      status: 409,
    });
    assert.equal(store.get('operation-1').state, 'running');
    assert.equal(store.get('operation-1').clientToken, created.operation.clientToken);
    assert.equal(
      store.companyIdentity('rec-1', 'https://company.example/', 'Company').status,
      'verified',
    );
    store.complete(store.get('operation-1'), { inserted: 1 });
    assert.deepEqual(store.modelResponse(key(), { now: 2000 }), response());
    assert.equal(store.get('operation-1').state, 'completed');
  } finally {
    store.close();
  }
});

test('无效时间参数不执行缓存写入', () => {
  const store = new AcquisitionStore();
  try {
    for (const now of [-1, NaN, Infinity, 1.5, 'today']) {
      assert.throws(() => store.saveModelResponse(key(), response(), { now }), { status: 400 });
      assert.throws(() => store.modelResponse(key(), { now }), { status: 400 });
    }
  } finally {
    store.close();
  }
});
