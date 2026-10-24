import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
import { ApiConnections, maskConnectionSecret } from '../server/api-connections.mjs';

const legacyKey = 'saved-deepseek-private-key-1234';
const draftKey = 'unsaved-compatible-private-key-5678';
const env = {
  ACQUISITION_PROVIDER: 'native',
  TAVILY_API_KEY: 'test-web-search-key',
  DEEPSEEK_API_KEY: legacyKey,
  DEEPSEEK_MODEL: 'saved-model',
  FEISHU_APP_ID: 'test-app',
  FEISHU_APP_SECRET: 'test-app-secret',
  FEISHU_APP_TOKEN: 'test-table-token',
  FEISHU_TABLE_ID: 'test-table',
};

async function serve({ environment = env, fetchImpl, nativeImpl } = {}) {
  const app = createApp({ env: environment, fetchImpl, nativeImpl });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  return {
    app,
    async list(body = { values: {}, clear: [] }) {
      const response = await fetch(base + '/api/v1/connections/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      return { status: response.status, raw, body: JSON.parse(raw) };
    },
    async view() {
      return (await fetch(base + '/api/v1/connections')).json();
    },
    async post(path, body) {
      return fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
    close: () => new Promise((resolve) => app.close(resolve)),
  };
}

test('目录使用服务端已保存的 legacy key，仅 GET /models，返回可选择模型而非凭证', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connection-models-'));
  const path = join(dir, 'connections.json');
  const persistedEnv = { ...env, DEEPSEEK_API_KEY: '' };
  new ApiConnections({ env: persistedEnv, path }).update({
    values: { DEEPSEEK_API_KEY: legacyKey },
  });
  const calls = [];
  const server = await serve({
    environment: { ...persistedEnv, CONNECTIONS_PATH: path },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(url, 'https://api.deepseek.com/models');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer ' + legacyKey);
      assert.equal(options.body, undefined, '目录请求不发生成参数或客户资料');
      return Response.json({
        data: [{ id: 'deepseek-chat', owned_by: 'deepseek' }, { id: 'deepseek-reasoner' }],
        debug: legacyKey,
      });
    },
  });
  const before = readFileSync(path, 'utf8');
  try {
    const result = await server.list();
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'available');
    assert.equal(result.body.provider, 'deepseek');
    assert.deepEqual(result.body.models.map((model) => model.id).sort(), [
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    assert.equal(result.raw.includes(legacyKey), false);
    assert.equal(result.body.debug, undefined);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未保存提供方、URL 和 key 可读取目录，不要求先填模型，也不写文件或覆盖当前配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'connection-models-draft-'));
  const path = join(dir, 'connections.json');
  new ApiConnections({ env, path }).update({ values: { DEEPSEEK_MODEL: 'persisted-model' } });
  const before = readFileSync(path, 'utf8');
  const server = await serve({
    environment: { ...env, CONNECTIONS_PATH: path },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://models.example.org/v1/models');
      assert.equal(options.headers.Authorization, 'Bearer ' + draftKey);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      return Response.json({
        data: [{ id: 'vendor/new-model', owned_by: 'vendor', unexpected_private_field: draftKey }],
        provider_raw_secret: draftKey,
      });
    },
  });
  try {
    const result = await server.list({
      values: {
        RESEARCH_MODEL_PROVIDER: 'openai_compatible',
        RESEARCH_MODEL_BASE_URL: 'https://models.example.org/v1/',
        RESEARCH_MODEL_API_KEY: draftKey,
      },
      clear: ['RESEARCH_MODEL_MODEL'],
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.provider, 'openai_compatible');
    assert.equal(result.body.models[0].id, 'vendor/new-model');
    assert.equal(result.raw.includes(draftKey), false);
    assert.equal(result.body.models[0].unexpected_private_field, undefined);
    assert.equal(readFileSync(path, 'utf8'), before);
    const view = await server.view();
    assert.equal(view.researchModelProvider, 'deepseek');
    assert.equal(
      view.fields.find((field) => field.key === 'DEEPSEEK_MODEL').value,
      'persisted-model',
    );
    assert.equal(
      view.fields.find((field) => field.key === 'RESEARCH_MODEL_API_KEY').configured,
      false,
    );
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('目录草稿只允许研究模型字段；unknown、网页、海关和飞书字段在发网前拒绝', async () => {
  let calls = 0;
  const server = await serve({
    fetchImpl: async () => {
      calls++;
      throw new Error('must not fetch');
    },
  });
  try {
    for (const key of [
      'UNKNOWN_KEY',
      'WEB_SEARCH_PROVIDER',
      'TAVILY_API_KEY',
      'CUSTOMS_API_KEY',
      'FEISHU_APP_SECRET',
      'ACQUISITION_PROVIDER',
    ]) {
      const result = await server.list({ values: { [key]: 'untrusted-value' } });
      assert.equal(result.status, 400, key);
    }
    for (const key of ['UNKNOWN_KEY', 'WEB_SEARCH_API_KEY', 'CUSTOMS_API_KEY', 'FEISHU_APP_SECRET'])
      assert.equal((await server.list({ values: {}, clear: [key] })).status, 400, key);
    for (const body of [
      null,
      [],
      { values: [] },
      { values: 'bad' },
      { values: {}, clear: 'bad' },
      { values: { RESEARCH_MODEL_API_KEY: 123 } },
      { values: { RESEARCH_MODEL_API_KEY: 'bad\nkey' } },
    ])
      assert.equal((await server.list(body)).status, 400, JSON.stringify(body));
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('脱敏摘要不当作目录密钥，包括原已保存密钥的相同摘要', async () => {
  let calls = 0;
  const server = await serve({
    fetchImpl: async () => {
      calls++;
      throw new Error('must not fetch');
    },
  });
  try {
    for (const preview of [maskConnectionSecret(legacyKey), '********', 'abcd********wxyz']) {
      const result = await server.list({ values: { DEEPSEEK_API_KEY: preview } });
      assert.equal(result.status, 400, preview);
      assert.equal(result.raw.includes(legacyKey), false);
    }
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('草稿明确 clear 唯一可用 key 时返回未配置，不发网、不清除已保存值', async () => {
  let calls = 0;
  const server = await serve({
    fetchImpl: async () => {
      calls++;
      throw new Error('must not fetch');
    },
  });
  try {
    const result = await server.list({ values: {}, clear: ['DEEPSEEK_API_KEY'] });
    assert.equal(result.status, 503);
    assert.equal(calls, 0);
    assert.equal(
      (await server.view()).fields.find((field) => field.key === 'DEEPSEEK_API_KEY').configured,
      true,
    );
  } finally {
    await server.close();
  }
});

test('只有有效 HTTPS 基础地址可接目录；含账号、查询、片段、非 HTTPS 和非法提供方拒绝', async () => {
  let calls = 0;
  const server = await serve({
    fetchImpl: async () => {
      calls++;
      throw new Error('must not fetch');
    },
  });
  try {
    for (const value of [
      'http://models.example.org/v1',
      'https://user:pass@models.example.org/v1',
      'https://models.example.org/v1?key=secret',
      'https://models.example.org/v1#private',
      'file:///etc/private',
      'not-a-url',
    ]) {
      const result = await server.list({ values: { RESEARCH_MODEL_BASE_URL: value } });
      assert.equal(result.status, 400, value);
    }
    assert.equal(
      (await server.list({ values: { RESEARCH_MODEL_PROVIDER: 'unsupported-vendor' } })).status,
      400,
    );
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('目录未实现的上游状态返回 unsupported 而不回显原响应', async () => {
  for (const upstream of [404, 405, 501]) {
    const server = await serve({
      fetchImpl: async () =>
        new Response('private-upstream-body-' + legacyKey, { status: upstream }),
    });
    try {
      const result = await server.list();
      assert.equal(result.status, 200, String(upstream));
      assert.equal(result.body.status, 'unsupported');
      assert.equal(result.body.provider, 'deepseek');
      assert.deepEqual(result.body.models, []);
      assert.equal(result.raw.includes('private-upstream-body'), false);
      assert.equal(result.raw.includes(legacyKey), false);
    } finally {
      await server.close();
    }
  }
});

test('认证、限流错误保留状态，其余上游错误为 502，不泄露密钥或供应商响应正文', async () => {
  for (const upstream of [401, 403, 429, 500, 302]) {
    const server = await serve({
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, 'error');
        return new Response('private-upstream-body-' + legacyKey, {
          status: upstream,
          headers: upstream === 302 ? { Location: 'https://unexpected.example.org/models' } : {},
        });
      },
    });
    try {
      const result = await server.list();
      assert.equal(
        result.status,
        [401, 403, 429].includes(upstream) ? upstream : 502,
        String(upstream),
      );
      assert.equal(result.raw.includes('private-upstream-body'), false);
      assert.equal(result.raw.includes(legacyKey), false);
    } finally {
      await server.close();
    }
  }
});

test('目录网络异常与畸形上游响应不会把错误正文或 key 回传', async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error('upstream-url-key=' + legacyKey);
    },
    async () => new Response('non-json-private-body-' + legacyKey, { status: 200 }),
    async () => Response.json({ private_error: legacyKey }),
  ]) {
    const server = await serve({ fetchImpl });
    try {
      const result = await server.list();
      assert.equal(result.status, 502);
      assert.equal(result.raw.includes(legacyKey), false);
      assert.equal(result.raw.includes('non-json-private-body'), false);
      assert.equal(result.raw.includes('upstream-url-key'), false);
    } finally {
      await server.close();
    }
  }
});

test('读取模型目录不更换既有执行引擎，也不受待核对任务的保存锁限制', async () => {
  let closes = 0;
  const server = await serve({
    nativeImpl: {
      run: async () => {
        throw Object.assign(new Error('结果待核对'), { status: 409 });
      },
      close: () => {
        closes++;
      },
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/models');
      assert.equal(options.method, 'GET');
      return Response.json({ data: [{ id: 'deepseek-chat' }] });
    },
  });
  try {
    const pending = await server.post('/api/v1/acquisition/runs', {
      country: 'United States',
      region: 'Florida',
      product: 'roller blinds',
      acquisition_channel: 'tavily_web',
      search_query: 'roller blinds Florida United States',
      target_count: 1,
    });
    assert.equal(pending.status, 409);
    const result = await server.list({ values: { DEEPSEEK_MODEL: 'preview-only-model' } });
    assert.equal(result.status, 200);
    assert.equal(result.body.models[0].id, 'deepseek-chat');
    assert.equal(closes, 0, '目录预览不能关闭或替换执行中的 provider');
    assert.equal(
      (await server.view()).fields.find((field) => field.key === 'DEEPSEEK_MODEL').value,
      'saved-model',
    );
  } finally {
    await server.close();
  }
});
