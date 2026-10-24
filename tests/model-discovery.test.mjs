import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverResearchModels } from '../server/model-discovery.mjs';

const key = 'fixture-private-model-discovery-key';
const env = {
  RESEARCH_MODEL_PROVIDER: 'openai_compatible',
  RESEARCH_MODEL_BASE_URL: 'https://models.example.org/v1/',
  RESEARCH_MODEL_API_KEY: key,
};
const good = () => Response.json({ data: [{ id: 'vendor/custom-model' }] });

function safeError(statusCode) {
  return (error) => {
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.status, statusCode);
    assert.equal(error.message.includes(key), false);
    assert.equal(error.message.includes('private-upstream-response'), false);
    return true;
  };
}

test('模型目录保留 /v1 路径，仅 GET 和 Bearer 认证；尚未选择模型不阻塞目录', async () => {
  let calls = 0;
  const result = await discoverResearchModels({
    env,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://models.example.org/v1/models');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer ' + key);
      assert.equal(options.headers.Accept, 'application/json');
      assert.equal(options.body, undefined);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return good();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'available');
  assert.equal(result.provider, 'openai_compatible');
  assert.deepEqual(result.models, [{ id: 'vendor/custom-model' }]);
  assert.match(result.message, /不代表.*兼容/);
});

test('DeepSeek 沿用默认 API 基础地址和旧密钥别名，不硬编码模型选项', async () => {
  const result = await discoverResearchModels({
    env: { DEEPSEEK_API_KEY: key },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.deepseek.com/models');
      assert.equal(options.headers.Authorization, 'Bearer ' + key);
      return Response.json({ data: [{ id: 'future-provider-model' }, { id: 'another-model' }] });
    },
  });
  assert.equal(result.provider, 'deepseek');
  assert.deepEqual(result.models, [{ id: 'future-provider-model' }, { id: 'another-model' }]);
});

test('通用模型密钥优先于旧密钥，目录不需要其他服务或已填写模型名', async () => {
  const result = await discoverResearchModels({
    env: {
      ...env,
      RESEARCH_MODEL_PROVIDER: 'deepseek',
      DEEPSEEK_API_KEY: 'obsolete-secret',
      RESEARCH_MODEL_MODEL: '',
    },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer ' + key);
      return good();
    },
  });
  assert.equal(result.status, 'available');
  const unrelated = await discoverResearchModels({
    env: {
      ...env,
      WEB_SEARCH_PROVIDER: 'invalid',
      WEB_SEARCH_BASE_URL: 'invalid',
      CUSTOMS_PROVIDER: 'invalid',
    },
    fetchImpl: async () => good(),
  });
  assert.equal(unrelated.status, 'available');
});

test('模型项只保留允许字段、去重并保留有效可选元数据', async () => {
  const result = await discoverResearchModels({
    env,
    fetchImpl: async () =>
      Response.json({
        data: [
          {
            id: 'custom/a',
            object: 'model',
            name: 'First name',
            context_window: 128000,
            unrelated: 'not-returned',
          },
          { id: 'custom/a', name: 'Other name', owned_by: 'provider', context_window: 64000 },
          { id: 'custom/b', context_length: 8192, owned_by: 'second-provider' },
          { id: 'custom/c', context_window: -1, name: 3, owned_by: {} },
          { id: ' ' },
          null,
          { id: 'bad\nname' },
          { id: 'model with spaces' },
        ],
      }),
  });
  assert.deepEqual(result.models, [
    { id: 'custom/a', name: 'First name', ownedBy: 'provider', contextWindow: 128000 },
    { id: 'custom/b', ownedBy: 'second-provider', contextWindow: 8192 },
    { id: 'custom/c' },
  ]);
});

test('空目录有效，超过上限仅列前 500 个唯一模型并明确截断', async () => {
  const empty = await discoverResearchModels({
    env,
    fetchImpl: async () => Response.json({ data: [] }),
  });
  assert.deepEqual(empty.models, []);
  assert.equal(empty.status, 'available');
  assert.match(empty.message, /手动填写/);
  const large = await discoverResearchModels({
    env,
    fetchImpl: async () =>
      Response.json({
        data: Array.from({ length: 700 }, (_, i) => ({ id: 'model-' + i })),
      }),
  });
  assert.equal(large.models.length, 500);
  assert.equal(large.models.at(-1).id, 'model-499');
  assert.match(large.message, /500/);
});

test('404/405/501 明确返回不支持目录和手填提示，不读取或回显错误正文', async () => {
  for (const status of [404, 405, 501]) {
    const result = await discoverResearchModels({
      env,
      fetchImpl: async () => new Response('private-upstream-response ' + key, { status }),
    });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.provider, 'openai_compatible');
    assert.deepEqual(result.models, []);
    assert.match(result.message, /手动填写/);
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(JSON.stringify(result).includes('private-upstream-response'), false);
  }
});

test('认证、限流及其他 HTTP 错误有安全状态码且不泄露响应或密钥', async () => {
  for (const [upstream, expected] of [
    [401, 401],
    [403, 403],
    [429, 429],
    [500, 502],
    [302, 502],
  ]) {
    await assert.rejects(
      discoverResearchModels({
        env,
        fetchImpl: async () =>
          new Response('private-upstream-response ' + key, {
            status: upstream,
            headers: { Location: 'https://elsewhere.example.org' },
          }),
      }),
      safeError(expected),
    );
  }
});

test('网络、非 JSON、无效 UTF-8 和不合约定的目录格式都返回安全错误', async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error('private-upstream-response ' + key);
    },
    async () => new Response('private-upstream-response ' + key),
    async () => new Response(new Uint8Array([255])),
    ...[null, [], {}, { data: {} }, { data: [null, {}, { id: ' ' }] }].map(
      (body) => async () => Response.json(body),
    ),
  ])
    await assert.rejects(discoverResearchModels({ env, fetchImpl }), safeError(502));
});

test('配置缺失或不安全的基础地址在外部请求前失败；不要求研究模型名', async () => {
  for (const badEnv of [
    {},
    { ...env, RESEARCH_MODEL_API_KEY: '' },
    { ...env, RESEARCH_MODEL_BASE_URL: '' },
    { ...env, RESEARCH_MODEL_PROVIDER: 'unsupported' },
    { ...env, RESEARCH_MODEL_BASE_URL: 'http://models.example.org' },
    { ...env, RESEARCH_MODEL_BASE_URL: 'https://user:password@models.example.org' },
    { ...env, RESEARCH_MODEL_BASE_URL: 'https://models.example.org?key=' + key },
  ]) {
    let called = false;
    await assert.rejects(
      discoverResearchModels({
        env: badEnv,
        fetchImpl: async () => {
          called = true;
          return good();
        },
      }),
      safeError(503),
    );
    assert.equal(called, false);
  }
});

test('响应体按实际字节和 Content-Length 双重限量，不解析超限目录', async () => {
  for (const response of [
    new Response('small', { headers: { 'Content-Length': String(1024 * 1024 + 1) } }),
    new Response('x'.repeat(1024 * 1024 + 1)),
  ])
    await assert.rejects(
      discoverResearchModels({ env, fetchImpl: async () => response }),
      (error) => {
        safeError(502)(error);
        assert.match(error.message, /过大/);
        return true;
      },
    );
});

test('调用者可取消请求与缓慢响应读取，已取消时不会发起外部请求', async () => {
  const aborted = new AbortController();
  aborted.abort();
  let called = false;
  await assert.rejects(
    discoverResearchModels({
      env,
      signal: aborted.signal,
      fetchImpl: async () => {
        called = true;
        return good();
      },
    }),
    safeError(502),
  );
  assert.equal(called, false);
  const pending = new AbortController();
  const request = discoverResearchModels({
    env,
    signal: pending.signal,
    fetchImpl: () => new Promise(() => {}),
  });
  pending.abort();
  await assert.rejects(request, safeError(502));
  const controller = new AbortController();
  let requestSignal;
  await assert.rejects(
    discoverResearchModels({
      env,
      signal: controller.signal,
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        setImmediate(() => controller.abort());
        return new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"data":'));
            },
          }),
        );
      },
    }),
    safeError(502),
  );
  assert.equal(requestSignal.aborted, true);
});
