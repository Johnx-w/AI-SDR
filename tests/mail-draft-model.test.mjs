import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiConnections } from '../server/api-connections.mjs';
import { mailDraftModel } from '../server/mail-draft-model.mjs';

const messages = [{ role: 'user', content: '测试草稿' }];

test('兼容网关明确拒绝可选字段后用支持的格式起草，普通请求错误不重试', async () => {
  const config = {
    RESEARCH_MODEL_PROVIDER: 'openai_compatible',
    RESEARCH_MODEL_MODEL: 'chat',
    RESEARCH_MODEL_API_KEY: 'fixture',
    RESEARCH_MODEL_BASE_URL: 'https://example.test/v1',
  };
  const calls = [];
  const model = mailDraftModel(config, async (_, init) => {
    const p = JSON.parse(init.body);
    calls.push(p);
    const param = p.response_format ? 'response_format' : p.max_tokens ? 'max_tokens' : '';
    return param
      ? Response.json({ error: { code: 'unsupported_parameter', param } }, { status: 400 })
      : Response.json({
          choices: [{ finish_reason: 'stop', message: { content: '{"supported":true}' } }],
        });
  });
  assert.equal(JSON.parse(await model.generate(messages)).supported, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].max_completion_tokens, 1200);
  let failed = 0;
  await assert.rejects(
    mailDraftModel(config, async () => {
      failed++;
      return Response.json(
        { error: { code: 'invalid_request', param: 'messages' } },
        { status: 400 },
      );
    }).generate(messages),
    { status: 502 },
  );
  assert.equal(failed, 1);
});

test('主动起草跟随服务端 API 连接切换模型，每次仅使用对应端点与密钥', async () => {
  const connections = new ApiConnections({ env: { DEEPSEEK_API_KEY: 'test-only-native' } });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      ...JSON.parse(init.body),
      authorization: init.headers.Authorization,
      redirect: init.redirect,
    });
    return Response.json({
      choices: [
        { finish_reason: 'stop', message: { content: '{"body":"Thank you","sourceIndexes":[]}' } },
      ],
    });
  };
  const generate = async () => {
    const model = mailDraftModel(connections.environment(), fetchImpl);
    assert.ok(model?.name);
    assert.equal(JSON.parse(await model.generate(messages)).body, 'Thank you');
    return calls.at(-1);
  };
  const native = await generate();
  assert.equal(native.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(native.model, 'deepseek-flash');
  assert.equal(native.authorization, 'Bearer test-only-native');
  assert.deepEqual(native.thinking, { type: 'disabled' });
  connections.update({
    values: {
      RESEARCH_MODEL_PROVIDER: 'openai_compatible',
      RESEARCH_MODEL_BASE_URL: 'https://models.example.test/api/v1/',
      RESEARCH_MODEL_MODEL: 'sales-assistant',
      RESEARCH_MODEL_API_KEY: 'test-only-compat',
    },
  });
  const compatible = await generate();
  assert.equal(compatible.url, 'https://models.example.test/api/v1/chat/completions');
  assert.equal(compatible.model, 'sales-assistant');
  assert.equal(compatible.authorization, 'Bearer test-only-compat');
  assert.equal('thinking' in compatible, false);
  for (const call of calls) {
    assert.deepEqual(call.messages, messages);
    assert.deepEqual(call.response_format, { type: 'json_object' });
    assert.equal(call.redirect, 'error');
  }
  connections.update({
    values: { RESEARCH_MODEL_PROVIDER: 'deepseek', RESEARCH_MODEL_MODEL: 'deepseek-v4-pro' },
    clear: ['RESEARCH_MODEL_BASE_URL', 'RESEARCH_MODEL_API_KEY'],
  });
  const switchedBack = await generate();
  assert.equal(switchedBack.url, native.url);
  assert.equal(switchedBack.authorization, native.authorization);
  assert.equal(switchedBack.model, 'deepseek-v4-pro');
});

test('兼容或非官方网关缺少专属密钥时不借用已有 DeepSeek 密钥，缺少模型时不建立连接', () => {
  const incomplete = {
    DEEPSEEK_API_KEY: 'test-only-native',
    RESEARCH_MODEL_BASE_URL: 'https://models.example.test/v1',
  };
  for (const config of [
    {},
    incomplete,
    { ...incomplete, RESEARCH_MODEL_PROVIDER: 'openai_compatible', RESEARCH_MODEL_MODEL: 'custom' },
    {
      ...incomplete,
      RESEARCH_MODEL_PROVIDER: 'openai_compatible',
      RESEARCH_MODEL_API_KEY: 'other',
    },
    {
      ...incomplete,
      RESEARCH_MODEL_BASE_URL: 'http://models.example.test',
      RESEARCH_MODEL_API_KEY: 'other',
    },
  ])
    assert.equal(mailDraftModel(config, assert.fail), null);
});

test('鉴权、频率限制和不完整输出明确报错，不回显凭据或上游正文', async () => {
  for (const [response, status] of [
    [new Response('sensitive upstream response', { status: 401 }), 503],
    [new Response(null, { status: 429 }), 429],
    [Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), 502],
  ]) {
    const model = mailDraftModel({ DEEPSEEK_API_KEY: 'test-only' }, async () => response);
    await assert.rejects(
      model.generate(messages),
      (err) => err.status === status && !/sensitive|test-only/.test(err.message),
    );
  }
});
