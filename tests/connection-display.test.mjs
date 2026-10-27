import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiConnections, maskConnectionSecret } from '../server/api-connections.mjs';
import { withApp } from './helpers/http.mjs';

const env = {
  ACQUISITION_PROVIDER: 'native',
  TAVILY_API_KEY: 'tvly-original-private-value-1234',
  DEEPSEEK_API_KEY: 'model-original-private-value-5678',
  DEEPSEEK_MODEL: 'selected-model',
  FEISHU_APP_ID: 'application-id',
  FEISHU_APP_SECRET: 'app-original-private-value-9012',
  FEISHU_APP_TOKEN: 'table-original-private-value-3456',
  FEISHU_TABLE_ID: 'table-id',
};
const field = (view, key) => view.fields.find((item) => item.key === key);

test('密钥摘要显示首尾但隐藏中间，短密钥完全遮挡且不暴露真实长度', () => {
  assert.equal(maskConnectionSecret(''), '');
  assert.equal(maskConnectionSecret('tiny'), '********');
  assert.equal(maskConnectionSecret('12345678'), '********');
  assert.equal(maskConnectionSecret('123456789'), '12********89');
  assert.equal(maskConnectionSecret('abcd-private-1234'), 'abcd********1234');
  assert.equal(maskConnectionSecret('  abcd-private-1234  '), 'abcd********1234');
});

test('已保存字段与实际使用的默认地址、兼容模型可查看，完整密钥不回传', () => {
  const connections = new ApiConnections({ env });
  const view = connections.view();
  assert.equal(field(view, 'TAVILY_API_KEY').value, '');
  assert.equal(field(view, 'TAVILY_API_KEY').maskedValue, 'tvly********1234');
  for (const key of [
    'TAVILY_API_KEY',
    'DEEPSEEK_API_KEY',
    'FEISHU_APP_SECRET',
    'FEISHU_APP_TOKEN',
  ]) {
    assert.equal(JSON.stringify(view).includes(env[key]), false);
    assert.ok(field(view, key).maskedValue.includes('********'));
  }
  assert.equal(field(view, 'FEISHU_APP_ID').value, env.FEISHU_APP_ID);
  assert.equal(field(view, 'WEB_SEARCH_BASE_URL').value, '');
  assert.equal(field(view, 'WEB_SEARCH_BASE_URL').effectiveValue, 'https://api.tavily.com');
  assert.equal(field(view, 'RESEARCH_MODEL_BASE_URL').effectiveValue, 'https://api.deepseek.com');
  assert.equal(field(view, 'RESEARCH_MODEL_MODEL').effectiveValue, 'selected-model');
  assert.equal(
    field(view, 'CUSTOMS_BASE_URL').effectiveValue,
    'https://tradedata.billofladingdata.com',
  );
  assert.equal(field(view, 'CUSTOMS_API_KEY').maskedValue, '');
  assert.equal(field(view, 'CUSTOMS_BASE_URL').maskedValue, undefined);
});

test('更换提供方、填写地址后只显示真实有效地址，不以旧供应商默认地址冒充', () => {
  const connections = new ApiConnections({
    env: {
      ...env,
      WEB_SEARCH_PROVIDER: 'http',
      WEB_SEARCH_BASE_URL: 'https://search.example.org/api',
      WEB_SEARCH_API_KEY: 'search-provider-private-key',
      RESEARCH_MODEL_PROVIDER: 'openai_compatible',
      RESEARCH_MODEL_BASE_URL: 'https://models.example.org/v1',
      RESEARCH_MODEL_MODEL: 'provider/model-name',
      CUSTOMS_PROVIDER: 'http',
      CUSTOMS_BASE_URL: 'https://customs.example.org/shipments',
    },
  });
  const view = connections.view();
  for (const [key, value] of Object.entries(connections.environment()).filter(([key]) =>
    key.endsWith('_BASE_URL'),
  ))
    assert.equal(field(view, key).effectiveValue, value);
  assert.equal(field(view, 'RESEARCH_MODEL_MODEL').effectiveValue, 'provider/model-name');
  const blank = new ApiConnections({
    env: {
      WEB_SEARCH_PROVIDER: 'http',
      RESEARCH_MODEL_PROVIDER: 'openai_compatible',
      CUSTOMS_PROVIDER: 'http',
    },
  }).view();
  assert.equal(field(blank, 'WEB_SEARCH_BASE_URL').effectiveValue, '');
  assert.equal(field(blank, 'RESEARCH_MODEL_BASE_URL').effectiveValue, '');
  assert.equal(field(blank, 'CUSTOMS_BASE_URL').effectiveValue, '');
  const switched = new ApiConnections({
    env: {
      CUSTOMS_PROVIDER: 'billofladingdata',
      CUSTOMS_API_URL: 'https://old-http.example.org/shipments',
    },
  }).view();
  assert.equal(
    field(switched, 'CUSTOMS_BASE_URL').effectiveValue,
    'https://tradedata.billofladingdata.com',
  );
});

test('保存其他配置或回传摘要不覆盖密钥，替换与明确清除分别生效', () => {
  const connections = new ApiConnections({ env });
  const preview = field(connections.view(), 'TAVILY_API_KEY').maskedValue;
  connections.update({ values: { TAVILY_API_KEY: preview, DEEPSEEK_MODEL: 'new-model' } });
  assert.equal(connections.environment().TAVILY_API_KEY, env.TAVILY_API_KEY);
  assert.equal(connections.environment().WEB_SEARCH_BASE_URL, undefined);
  assert.equal(field(connections.view(), 'RESEARCH_MODEL_MODEL').effectiveValue, 'new-model');
  connections.update({ values: { TAVILY_API_KEY: 'tvly-new-private-value-9876' } });
  assert.equal(field(connections.view(), 'TAVILY_API_KEY').maskedValue, 'tvly********9876');
  assert.throws(() => connections.update({ values: { CUSTOMS_API_KEY: 'abcd********9876' } }), {
    status: 400,
  });
  connections.update({ values: {}, clear: ['TAVILY_API_KEY'] });
  assert.equal(field(connections.view(), 'TAVILY_API_KEY').configured, false);
  assert.equal(field(connections.view(), 'TAVILY_API_KEY').maskedValue, '');
});

test('通用模型标识允许兼容服务命名空间，拒绝空白与控制字符', () => {
  const connections = new ApiConnections({ env });
  const view = connections.update({ values: { RESEARCH_MODEL_MODEL: '@cf/vendor/model:latest' } });
  assert.equal(field(view, 'RESEARCH_MODEL_MODEL').value, '@cf/vendor/model:latest');
  assert.throws(() => connections.update({ values: { RESEARCH_MODEL_MODEL: 'bad model' } }), {
    status: 400,
  });
});

test('HTTP 读取与保存均只返回脱敏值，不请求外部平台', async () => {
  let externalCalls = 0;
  await withApp(
    {
      env,
      fetchImpl: async () => {
        externalCalls++;
        throw new Error('must not call');
      },
    },
    async (base) => {
      const url = base + '/api/v1/connections';
      const response = await fetch(url);
      const view = await response.json();
      assert.equal(field(view, 'TAVILY_API_KEY').maskedValue, 'tvly********1234');
      const saved = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { DEEPSEEK_MODEL: 'second-model' } }),
      });
      assert.equal(saved.status, 200);
      const body = await saved.json();
      assert.equal(field(body, 'DEEPSEEK_MODEL').value, 'second-model');
      for (const key of [
        'TAVILY_API_KEY',
        'DEEPSEEK_API_KEY',
        'FEISHU_APP_SECRET',
        'FEISHU_APP_TOKEN',
      ])
        assert.equal(JSON.stringify(body).includes(env[key]), false);
      assert.equal(externalCalls, 0);
    },
  );
});
