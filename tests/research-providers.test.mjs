import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResearchProviders } from '../server/research-providers.mjs';
import { acquisitionConfig, nativeRequirements } from '../server/acquisition-config.mjs';
import { ApiConnections } from '../server/api-connections.mjs';
import { parseCompanyResearch } from '../server/company-research.mjs';

const legacyEnv = Object.fromEntries(nativeRequirements.map((key) => [key, 'fixture-' + key]));
const genericEnv = {
  WEB_SEARCH_PROVIDER: 'http',
  WEB_SEARCH_BASE_URL: 'https://search.example.org/api/',
  WEB_SEARCH_API_KEY: 'fixture-generic-search',
  RESEARCH_MODEL_PROVIDER: 'openai_compatible',
  RESEARCH_MODEL_BASE_URL: 'https://models.example.org/v1/',
  RESEARCH_MODEL_API_KEY: 'fixture-generic-model',
  RESEARCH_MODEL_MODEL: 'vendor/research-model:latest',
  ...Object.fromEntries(Object.entries(legacyEnv).filter(([key]) => key.startsWith('FEISHU_'))),
};
const messages = [{ role: 'user', content: 'Research only supplied official website evidence.' }];
const schema = { type: 'object', properties: {}, additionalProperties: false };

test('保存选中的模型后，实际请求的 model 字段使用该 ID 而不是旧模型', async () => {
  for (const provider of ['deepseek', 'openai_compatible']) {
    const connections = new ApiConnections({ env: { ...genericEnv, DEEPSEEK_MODEL: 'old-model' } });
    connections.update({
      values: {
        RESEARCH_MODEL_PROVIDER: provider,
        RESEARCH_MODEL_MODEL: 'selected-model',
      },
    });
    let request;
    const providers = createResearchProviders({
      env: connections.environment(),
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body), auth: options.headers.Authorization };
        return Response.json({});
      },
    });
    await providers.model.research({ messages, schema });
    assert.equal(request.body.model, 'selected-model');
    assert.equal(request.auth, 'Bearer fixture-generic-model');
    assert.ok(request.url.endsWith(provider === 'deepseek' ? '/responses' : '/chat/completions'));
  }
});

test('现有网页提供方原样传递 basic 与 advanced 提取层级，不隐式重复请求', async () => {
  for (const env of [legacyEnv, genericEnv]) {
    const calls = [];
    const providers = createResearchProviders({
      env,
      fetchImpl: async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return Response.json({ results: [] });
      },
    });
    for (const extract_depth of ['basic', 'advanced'])
      await providers.web.extract({
        urls: ['https://buyer.example.org/'],
        extract_depth,
        format: 'markdown',
      });
    assert.deepEqual(
      calls.map((call) => call.extract_depth),
      ['basic', 'advanced'],
    );
    assert.ok(
      calls.every(
        (call) => call.urls[0] === 'https://buyer.example.org/' && call.format === 'markdown',
      ),
    );
  }
});

test('研究推理强度可显式选择且参与响应复用身份，非法设置在请求前拒绝', async () => {
  let request;
  const high = createResearchProviders({
    env: { ...legacyEnv, RESEARCH_MODEL_REASONING_EFFORT: 'high' },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return Response.json({ status: 'completed', output: [] });
    },
  });
  await high.model.research({ messages, schema });
  assert.deepEqual(request.reasoning, { effort: 'high' });
  assert.equal(request.max_output_tokens, 48000);
  assert.equal(high.model.cacheIdentity.requestParameters.max_output_tokens, 48000);
  assert.deepEqual(high.model.cacheIdentity.requestParameters.reasoning, { effort: 'high' });
  assert.notDeepEqual(
    high.model.cacheIdentity,
    createResearchProviders({ env: legacyEnv }).model.cacheIdentity,
  );
  assert.throws(
    () =>
      createResearchProviders({
        env: { ...legacyEnv, RESEARCH_MODEL_REASONING_EFFORT: 'invalid' },
      }),
    /推理强度/,
  );
  assert.throws(
    () => createResearchProviders({ env: { ...legacyEnv, RESEARCH_MODEL_MAX_OUTPUT_TOKENS: '0' } }),
    /输出上限/,
  );
});

test('Tavily读取真实单请求用量，保留检索深度与DeepSeek原有请求格式', async () => {
  const searchBody = {
    query: 'roller blind fabric',
    search_depth: 'basic',
    max_results: 20,
    include_answer: false,
    include_raw_content: false,
    auto_parameters: false,
    exclude_domains: [],
  };
  const extractBody = {
    urls: ['https://buyer.example.org/'],
    extract_depth: 'basic',
    format: 'markdown',
  };
  const calls = [];
  const providers = createResearchProviders({
    env: legacyEnv,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), options });
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (url.includes('tavily')) {
        assert.equal(options.headers.Authorization, 'Bearer ' + legacyEnv.TAVILY_API_KEY);
        return Response.json({ results: [], usage: { credits: 1 }, request_id: 'trace-search' });
      }
      assert.equal(options.headers.Authorization, 'Bearer ' + legacyEnv.DEEPSEEK_API_KEY);
      return Response.json({ status: 'completed', output: [] });
    },
  });
  assert.equal(providers.web.provider, 'tavily');
  assert.equal(providers.model.provider, 'deepseek');
  assert.deepEqual(await providers.web.search(searchBody), {
    results: [],
    usage: { credits: 1 },
    request_id: 'trace-search',
  });
  await providers.web.extract(extractBody);
  await providers.model.research({ messages, schema });
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      'https://api.tavily.com/search',
      'https://api.tavily.com/extract',
      'https://api.deepseek.com/responses',
    ],
  );
  assert.deepEqual(calls[0].body, { ...searchBody, include_usage: true });
  assert.deepEqual(calls[1].body, { ...extractBody, include_usage: true });
  assert.deepEqual(calls[2].body, {
    model: 'deepseek-flash',
    input: messages,
    max_output_tokens: 16000,
    reasoning: { effort: 'none' },
    temperature: 0,
    store: false,
    text: { format: { type: 'json_schema', name: 'company_research', strict: true, schema } },
  });
});

test('HTTP 网页适配器提供 search/extract、过滤无效官网地址并统一保留正文和用量', async () => {
  const calls = [];
  const providers = createResearchProviders({
    env: genericEnv,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      assert.equal(options.headers.Authorization, 'Bearer fixture-generic-search');
      return Response.json({
        results: [
          {
            url: 'https://buyer.example.org',
            title: 'Buyer',
            content: 'Window fabric',
            raw_content: 'Official website',
          },
          { url: 'http://not-https.example.org', title: 'Not a supported website' },
          { url: 'https://user:secret@buyer.example.org', title: 'Credentials' },
          { url: null },
        ],
        usage: { credits: 2 },
        unexpected_provider_field: 'not-part-of-contract',
      });
    },
  });
  assert.equal(providers.web.provider, 'http');
  const body = { query: 'fabric importer', max_results: 5 };
  assert.deepEqual(await providers.web.search(body), {
    results: [
      {
        url: 'https://buyer.example.org/',
        title: 'Buyer',
        content: 'Window fabric',
        raw_content: 'Official website',
      },
    ],
    usage: { credits: 2 },
  });
  const extractBody = { urls: ['https://buyer.example.org/'], extract_depth: 'basic' };
  await providers.web.extract(extractBody);
  assert.deepEqual(calls, [
    { url: 'https://search.example.org/api/search', body },
    { url: 'https://search.example.org/api/extract', body: extractBody },
  ]);
});

test('DeepSeek 搜索与逐页获取复用模型密钥，并保留现有网页结果格式', async () => {
  const calls = [];
  const providers = createResearchProviders({
    env: {
      ...legacyEnv,
      WEB_SEARCH_PROVIDER: 'deepseek',
      RESEARCH_MODEL_API_KEY: 'shared-key',
      RESEARCH_MODEL_BASE_URL: 'https://api.deepseek.com/v1',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
      if (url.endsWith('/search'))
        return Response.json({
          results: [
            { url: 'https://buyer.example.org', title: 'Buyer', summary: 'Window fabric' },
            { url: 'http://invalid.example.org', title: 'Invalid' },
          ],
        });
      if (JSON.parse(options.body).url.endsWith('/missing'))
        return new Response('', { status: 404 });
      return Response.json({ title: 'Buyer', content: '# Buyer\nWindow fabric' });
    },
  });
  assert.deepEqual(await providers.web.search({ query: 'x'.repeat(130), max_results: 20 }), {
    results: [{ url: 'https://buyer.example.org/', title: 'Buyer', content: 'Window fabric' }],
  });
  assert.deepEqual(
    await providers.web.extract({
      urls: ['https://buyer.example.org/', 'https://buyer.example.org/missing'],
      extract_depth: 'basic',
    }),
    { results: [{ url: 'https://buyer.example.org/', raw_content: '# Buyer\nWindow fabric' }] },
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://api.deepseek.com/v1/tools/search',
      'https://api.deepseek.com/v1/tools/fetch',
      'https://api.deepseek.com/v1/tools/fetch',
    ],
  );
  assert.deepEqual(calls[0].body, { query: 'x'.repeat(128), count: 20, need_content: false });
  await providers.web.search({
    query: 'Roman blinds supplier Australia',
    max_results: 20,
    exclude_domains: ['old.example.org', 'buyer.example.org'],
  });
  assert.equal(
    calls.at(-1).body.query,
    'Roman blinds supplier Australia -site:buyer.example.org -site:old.example.org',
  );
  assert.ok(calls.every((call) => call.auth === 'Bearer shared-key'));
  assert.equal(
    acquisitionConfig({ ...legacyEnv, WEB_SEARCH_PROVIDER: 'deepseek' }).nativeReady,
    true,
  );
  assert.throws(
    () => acquisitionConfig({ ...genericEnv, WEB_SEARCH_PROVIDER: 'deepseek' }),
    /DeepSeek 网页检索需要/,
  );
});

test('OpenAI compatible 模型使用独立配置并输出现有证据解析器可读取的完成结果', async () => {
  let call;
  const providers = createResearchProviders({
    env: genericEnv,
    fetchImpl: async (url, options) => {
      call = { url, body: JSON.parse(options.body), auth: options.headers.Authorization };
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
        usage: { total_tokens: 10 },
      });
    },
  });
  const response = await providers.model.research({ messages, schema });
  assert.deepEqual(call, {
    url: 'https://models.example.org/v1/chat/completions',
    auth: 'Bearer fixture-generic-model',
    body: {
      model: 'vendor/research-model:latest',
      messages,
      max_tokens: 16000,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'company_research', strict: true, schema },
      },
    },
  });
  assert.doesNotThrow(() =>
    parseCompanyResearch(
      response,
      {
        source_url: 'https://buyer.example.org/',
        page_text: 'Buyer supplies roller blinds.',
      },
      { product: 'roller blinds' },
    ),
  );
  assert.equal(response.usage.total_tokens, 10);
});

test('动态必填项按当前提供方选择，兼容旧变量且不会误要求停用提供方凭证', () => {
  assert.equal(acquisitionConfig(legacyEnv).nativeReady, true);
  assert.deepEqual(acquisitionConfig({}).missing, nativeRequirements);
  const generic = acquisitionConfig(genericEnv);
  assert.equal(generic.nativeReady, true);
  assert.equal(generic.webSearchProvider, 'http');
  assert.equal(generic.researchModelProvider, 'openai_compatible');
  assert.equal(generic.requirements.includes('TAVILY_API_KEY'), false);
  assert.equal(generic.requirements.includes('DEEPSEEK_API_KEY'), false);
  const { RESEARCH_MODEL_MODEL, ...withoutModel } = genericEnv;
  assert.deepEqual(acquisitionConfig(withoutModel).missing, ['RESEARCH_MODEL_MODEL']);
  const aliases = acquisitionConfig({
    ...legacyEnv,
    TAVILY_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    WEB_SEARCH_API_KEY: 'replacement-web',
    RESEARCH_MODEL_API_KEY: 'replacement-model',
  });
  assert.equal(aliases.nativeReady, true);
  assert.equal(JSON.stringify(generic).includes('fixture-generic'), false);
});

test('提供方和 HTTPS 基础地址在请求前验证，不接收地址中的凭证或查询参数', () => {
  for (const changes of [
    { WEB_SEARCH_PROVIDER: 'unsupported' },
    { RESEARCH_MODEL_PROVIDER: 'unsupported' },
    { WEB_SEARCH_BASE_URL: 'http://search.example.org' },
    { WEB_SEARCH_BASE_URL: 'https://user:secret@search.example.org' },
    { RESEARCH_MODEL_BASE_URL: 'https://models.example.org?key=secret' },
    { RESEARCH_MODEL_BASE_URL: 'https://models.example.org#secret' },
    { RESEARCH_MODEL_BASE_URL: 'not-a-url' },
  ])
    assert.throws(() => createResearchProviders({ env: { ...genericEnv, ...changes } }), {
      status: 503,
    });
});

test('上游非 JSON、HTTP 错误、网络异常及缺少配置不泄露凭证或错误正文', async () => {
  const sensitive = 'upstream-body-with-private-key';
  for (const fetchImpl of [
    async () => new Response(sensitive, { status: 401 }),
    async () => new Response(sensitive),
    async () => {
      throw new Error(sensitive);
    },
    async () => Response.json({ error: sensitive }),
  ]) {
    const { web } = createResearchProviders({ env: genericEnv, fetchImpl });
    await assert.rejects(web.search({ query: 'roller fabric' }), (error) => {
      assert.equal(error.status, 502);
      assert.equal(error.message.includes(sensitive), false);
      assert.equal(error.message.includes(genericEnv.WEB_SEARCH_API_KEY), false);
      return true;
    });
  }
  const { web, model } = createResearchProviders({ env: {} });
  await assert.rejects(web.search({ query: 'fabric' }), { status: 503 });
  await assert.rejects(model.research({ messages, schema }), { status: 503 });
});

test('连接设置支持可替换提供方，读取不泄露密钥且非法更新不生效', () => {
  const connections = new ApiConnections({ env: legacyEnv });
  const values = Object.fromEntries(Object.entries(genericEnv));
  const view = connections.update({ values });
  assert.equal(view.ready, true);
  assert.deepEqual(view.missing, []);
  for (const secret of ['fixture-generic-search', 'fixture-generic-model'])
    assert.equal(JSON.stringify(view).includes(secret), false);
  assert.equal(view.fields.find((field) => field.key === 'WEB_SEARCH_API_KEY').required, true);
  assert.equal(view.fields.find((field) => field.key === 'TAVILY_API_KEY').required, false);
  assert.equal(
    view.fields.find((field) => field.key === 'CUSTOMS_API_KEY'),
    undefined,
  );
  assert.deepEqual(view.fields.find((field) => field.key === 'RESEARCH_MODEL_PROVIDER').options, [
    'deepseek',
    'openai_compatible',
  ]);
  const before = connections.environment();
  for (const changes of [
    { WEB_SEARCH_PROVIDER: 'unsupported' },
    { RESEARCH_MODEL_PROVIDER: 'unsupported' },
    { CUSTOMS_PROVIDER: 'unsupported' },
    { RESEARCH_MODEL_BASE_URL: 'http://models.example.org' },
    { RESEARCH_MODEL_MODEL: 'model with spaces' },
  ]) {
    assert.throws(() => connections.update({ values: changes }), { status: 400 });
    assert.deepEqual(connections.environment(), before);
  }
  assert.equal(connections.view().ready, true);
  assert.equal(connections.update({ values: {} }).provider, 'native');
});
