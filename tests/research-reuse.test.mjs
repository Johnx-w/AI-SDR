import { test } from 'node:test';
import assert from 'node:assert/strict';
import { researchCacheKey } from '../server/research-reuse.mjs';
import { createResearchProviders } from '../server/research-providers.mjs';

const secret = 'fixture-private-api-key';
const modelEnv = {
  RESEARCH_MODEL_PROVIDER: 'openai_compatible',
  RESEARCH_MODEL_BASE_URL: 'https://models.example.org/v1/',
  RESEARCH_MODEL_API_KEY: secret,
  RESEARCH_MODEL_MODEL: 'provider/research-model',
};
const fixture = () => ({
  identity: createResearchProviders({ env: modelEnv }).model.cacheIdentity,
  messages: [
    { role: 'system', content: 'Use only supplied official website evidence.' },
    {
      role: 'user',
      content: JSON.stringify({
        target: { country: 'Canada', product: 'sunscreen fabric' },
        pages: [{ source_url: 'https://buyer.example.org/', text: 'Distinct private page text' }],
      }),
    },
  ],
  schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
});

test('精确研究请求产生稳定摘要，递归对象键顺序不同仍可复用', () => {
  const input = fixture();
  const key = researchCacheKey(input);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(researchCacheKey(structuredClone(input)), key);
  const reorder = (value) =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([name, child]) => [name, reorder(child)]),
          )
        : value;
  assert.equal(researchCacheKey(reorder(input)), key);
});

test('页面、目标、系统提示、Schema和数组顺序变化均导致缓存失效', () => {
  const original = fixture(),
    key = researchCacheKey(original);
  const changed = (mutate) => {
    const input = structuredClone(original);
    mutate(input);
    return input;
  };
  for (const next of [
    changed((input) => {
      const user = JSON.parse(input.messages[1].content);
      user.pages[0].text += ' updated';
      input.messages[1].content = JSON.stringify(user);
    }),
    changed((input) => {
      const user = JSON.parse(input.messages[1].content);
      user.pages[0].source_url += 'contact';
      input.messages[1].content = JSON.stringify(user);
    }),
    changed((input) => {
      const user = JSON.parse(input.messages[1].content);
      user.target.product = 'blackout fabric';
      input.messages[1].content = JSON.stringify(user);
    }),
    changed((input) => {
      input.messages[0].content += ' New policy.';
    }),
    changed((input) => {
      input.messages[1].content += ' ';
    }),
    changed((input) => {
      input.schema.properties.name.maxLength = 200;
    }),
    changed((input) => {
      input.messages.reverse();
    }),
    changed((input) => {
      input.schema.required.push('address');
    }),
  ])
    assert.notEqual(researchCacheKey(next), key);
});

test('模型、提供方、API基础路径、传输协议、请求参数和版本变化均失效', () => {
  const original = fixture(),
    key = researchCacheKey(original);
  for (const change of [
    { model: 'provider/other-model' },
    { provider: 'other-provider' },
    { baseUrl: 'https://other-models.example.org/v1' },
    { baseUrl: 'https://models.example.org/v2' },
    { protocol: 'responses' },
    { version: 'company-research-request-v2' },
    { requestParameters: { ...original.identity.requestParameters, temperature: 0.5 } },
    { requestParameters: { ...original.identity.requestParameters, max_tokens: 8000 } },
    {
      requestParameters: { ...original.identity.requestParameters, reasoning: { effort: 'high' } },
    },
  ])
    assert.notEqual(
      researchCacheKey({ ...original, identity: { ...original.identity, ...change } }),
      key,
    );
});

test('未声明身份、空身份、非JSON载荷禁用缓存，不猜测注入适配器身份', () => {
  const input = fixture();
  for (const identity of [undefined, null, '', 'opaque-string', {}, [], false, 0])
    assert.equal(researchCacheKey({ ...input, identity }), null);
  const circular = {};
  circular.self = circular;
  for (const identity of [circular, { fn() {} }, { number: Infinity }, { value: 1n }, new Date()])
    assert.equal(researchCacheKey({ ...input, identity }), null);
  assert.equal(researchCacheKey(), null);
  assert.equal(researchCacheKey({ ...input, messages: undefined }), null);
  assert.equal(researchCacheKey({ ...input, schema: undefined }), null);
  assert.equal(researchCacheKey({ ...input, messages: [{ content: undefined }] }), null);
  assert.equal(researchCacheKey({ ...input, messages: Array(1) }), null);
  assert.equal(researchCacheKey({ ...input, identity: { nested: Symbol('identity') } }), null);
  const shared = { type: 'string' };
  assert.equal(
    researchCacheKey({ ...input, schema: { a: shared, b: shared } }),
    researchCacheKey({ ...input, schema: { a: { type: 'string' }, b: { type: 'string' } } }),
  );
});

test('缓存摘要不暴露原文或秘密，提供方身份不含密钥且轮换密钥不改变身份', () => {
  const input = fixture(),
    key = researchCacheKey(input);
  assert.equal(key.includes('Distinct private page text'), false);
  assert.equal(key.includes('sunscreen'), false);
  assert.equal(key.includes(secret), false);
  const serializedIdentity = JSON.stringify(input.identity);
  assert.equal(serializedIdentity.includes(secret), false);
  assert.equal(/api.?key|authorization|password/i.test(serializedIdentity), false);
  const rotated = createResearchProviders({
    env: { ...modelEnv, RESEARCH_MODEL_API_KEY: 'rotated-private-key' },
  }).model.cacheIdentity;
  assert.deepEqual(rotated, input.identity);
  assert.equal(researchCacheKey({ ...input, identity: rotated }), key);
});

test('两种协议身份准确覆盖真实请求的非秘密参数，不改变请求体', async () => {
  for (const provider of ['deepseek', 'openai_compatible']) {
    let body, endpoint;
    const { model } = createResearchProviders({
      env: { ...modelEnv, RESEARCH_MODEL_PROVIDER: provider },
      fetchImpl: async (url, options) => {
        endpoint = url;
        body = JSON.parse(options.body);
        return Response.json({ status: 'completed', output: [] });
      },
    });
    const { messages, schema } = fixture();
    await model.research({ messages, schema });
    assert.equal(model.cacheIdentity.provider, provider);
    assert.equal(model.cacheIdentity.model, body.model);
    assert.equal(model.cacheIdentity.baseUrl, 'https://models.example.org/v1');
    assert.equal(
      endpoint,
      model.cacheIdentity.baseUrl + (provider === 'deepseek' ? '/responses' : '/chat/completions'),
    );
    const parameters = structuredClone(body);
    delete parameters.model;
    if (provider === 'deepseek') {
      delete parameters.input;
      delete parameters.text.format.schema;
      assert.equal(model.cacheIdentity.protocol, 'responses');
    } else {
      delete parameters.messages;
      delete parameters.response_format.json_schema.schema;
      assert.equal(model.cacheIdentity.protocol, 'chat_completions');
    }
    assert.deepEqual(model.cacheIdentity.requestParameters, parameters);
  }
});
