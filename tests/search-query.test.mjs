import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, validateInput } from '../server/app.mjs';
import { generateSearchQuery } from '../server/deepseek.mjs';
import { locationOptions, validateTarget } from '../server/search-target.mjs';
import { difyResearchBody } from '../server/n8n-search-target.mjs';
import vm from 'node:vm';

const target = {
  country: 'United States',
  region: 'Florida',
  city: 'Miami',
  product: 'outdoor zip screens',
  customer_types: ['installer', 'distributor'],
};
const completion = (keywords = '"outdoor zip screens" OR "zip screen systems"') =>
  Response.json({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ keywords }) } }],
  });
const env = { DEEPSEEK_API_KEY: 'private-fixture-key' };
test('n8n 传入 Dify 的目标包含所选城市，空城市或空地区明确传 null', () => {
  for (const changes of [{}, { city: '' }, { city: '', region: '' }]) {
    const selected = { ...target, ...changes };
    const page = { source_url: 'https://fixture.example/', page_text: 'Actual website content' };
    const payload = JSON.parse(
      vm.runInNewContext(difyResearchBody.slice(3, -2), {
        $json: page,
        $: () => ({ first: () => ({ json: selected }) }),
      }),
    );
    const actual = JSON.parse(payload.inputs.target_json);
    assert.equal(actual.city, selected.city || null);
    assert.equal(actual.region, selected.region || null);
    assert.equal(actual.country, selected.country);
    assert.equal(payload.inputs.page_text, page.page_text);
    assert.equal(payload.inputs.source_url, page.source_url);
    assert.equal(payload.response_mode, 'blocking');
  }
});
async function withApp(options, callback) {
  const app = createApp(options);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${app.address().port}`);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}
const post = (base, body = target, headers = {}) =>
  fetch(`${base}/api/v1/integrations/n8n/search-query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('国家和州联动，不返回其他国家或其他州的城市', () => {
  const florida = locationOptions('United States', 'Florida');
  assert.equal(florida.regions.length, 51);
  assert.ok(florida.cities.includes('Miami'));
  assert.ok(!florida.cities.includes('Sydney'));
  const nsw = locationOptions('Australia', 'New South Wales');
  assert.equal(nsw.regions.length, 8);
  assert.ok(nsw.cities.includes('Sydney'));
  assert.deepEqual(locationOptions('Australia').cities, []);
  assert.throws(() => locationOptions('Australia', 'Florida'), /该国家/);
  assert.throws(() => validateTarget({ ...target, city: 'Sydney' }), /该州/);
});
test('搜索和生成接口允许全州、全国；城市不能脱离州选择', () => {
  for (const changes of [
    { city: '' },
    { city: '', region: '' },
    { city: undefined, region: undefined },
  ]) {
    const result = validateInput({
      ...target,
      ...changes,
      search_query: 'outdoor zip screens installers USA',
    });
    assert.equal(result.city, '');
  }
  assert.throws(() => validateTarget({ ...target, region: '' }), /先选择州/);
  assert.throws(() => validateTarget({ ...target, product: '' }), /product/);
  assert.throws(() => validateTarget({ ...target, city: 5 }), /city/);
});
test('DeepSeek 只在服务端调用，按选中范围追加地名，不为全州查询追加城市', async () => {
  for (const changes of [{}, { city: '' }, { city: '', region: '' }]) {
    const selected = { ...target, ...changes };
    const result = await generateSearchQuery(selected, {
      env,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.deepseek.com/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer private-fixture-key');
        assert.equal(options.redirect, 'error');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'deepseek-flash');
        assert.equal(body.thinking.type, 'disabled');
        assert.deepEqual(JSON.parse(body.messages[1].content), selected);
        return completion();
      },
    });
    assert.equal(
      result.search_query,
      [
        '("outdoor zip screens" OR "zip screen systems")',
        '(installer OR distributor)',
        selected.city,
        selected.region,
        selected.country,
      ]
        .filter(Boolean)
        .join(' '),
    );
    assert.equal(JSON.stringify(result).includes('private-fixture-key'), false);
  }
});
test('未配置、余额不足、上游错误、超时均返回明确错误，不暴露上游正文或密钥', async () => {
  await assert.rejects(generateSearchQuery(target, { env: {} }), /尚未配置/);
  for (const [status, message] of [
    [401, /密钥无效/],
    [402, /余额不足/],
    [429, /频率受限/],
    [500, /HTTP 500/],
  ]) {
    await assert.rejects(
      generateSearchQuery(target, {
        env,
        fetchImpl: async () => new Response('private-fixture-key', { status }),
      }),
      message,
    );
  }
  await assert.rejects(
    generateSearchQuery(target, {
      env,
      fetchImpl: async () => {
        throw new Error('private-fixture-key');
      },
    }),
    /超时或网络/,
  );
  for (const response of [
    Response.json({}),
    completion(''),
    completion('outdoor zip screens supplier trade'),
    Response.json({
      choices: [{ finish_reason: 'length', message: { content: '{"keywords":"partial"}' } }],
    }),
  ]) {
    await assert.rejects(
      generateSearchQuery(target, { env, fetchImpl: async () => response }),
      /未返回有效搜索词/,
    );
  }
});
test('生成搜索词只调用 DeepSeek，不运行 n8n 或写飞书；同源及参数校验仍生效', async () => {
  let calls = 0;
  await withApp(
    {
      env,
      fetchImpl: async (url) => {
        calls++;
        assert.equal(new URL(url).hostname, 'api.deepseek.com');
        return completion();
      },
    },
    async (base) => {
      const response = await post(base, { ...target, city: '' });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.provider, 'DeepSeek');
      assert.ok(!data.search_query.includes('Miami'));
      assert.equal((await post(base, target, { Origin: 'https://untrusted.example' })).status, 403);
      assert.equal((await post(base, { ...target, city: 'Sydney' })).status, 400);
      assert.equal(calls, 1);
      const options = await (
        await fetch(
          `${base}/api/v1/integrations/n8n/locations?country=Australia&region=New+South+Wales`,
        )
      ).json();
      assert.ok(options.cities.includes('Sydney'));
      assert.equal(calls, 1);
    },
  );
});
test('并发点击不会重复发出 DeepSeek 请求；失败后可重试', async () => {
  let release;
  let notifyStart;
  const started = new Promise((resolve) => {
    notifyStart = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  await withApp(
    {
      env,
      fetchImpl: async () => {
        notifyStart();
        await pending;
        return completion();
      },
    },
    async (base) => {
      const first = post(base);
      await started;
      assert.equal((await post(base)).status, 429);
      release();
      assert.equal((await first).status, 200);
      assert.equal((await post(base)).status, 200);
    },
  );
});
test('全州与全国范围原样转发给 n8n，不补写默认 Miami 或 Florida', async () => {
  for (const scope of [
    { city: '', region: 'Florida' },
    { city: '', region: '' },
  ]) {
    await withApp(
      {
        env: {
          N8N_BASE_URL: 'https://vynox.app.n8n.cloud',
          N8N_WEBHOOK_URL: 'https://vynox.app.n8n.cloud/webhook/fixture',
          N8N_WEBHOOK_SECRET: 'fixture',
          N8N_WEBHOOK_ENABLED: 'true',
        },
        fetchImpl: async (_, options) => {
          const forwarded = JSON.parse(options.body);
          assert.equal(forwarded.city, scope.city);
          assert.equal(forwarded.region, scope.region);
          return Response.json({ outcome: 'no_new_candidates', reason: 'fixture' });
        },
      },
      async (base) => {
        const response = await fetch(`${base}/api/v1/integrations/n8n/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...target,
            ...scope,
            search_query: 'outdoor zip screens installers United States',
          }),
        });
        assert.equal(response.status, 200);
      },
    );
  }
});
