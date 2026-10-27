import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../server/app.mjs';
import { locationOptions, validateTarget } from '../server/search-target.mjs';
import { difyResearchBody, searchTargetConfig } from '../server/n8n-search-target.mjs';
import vm from 'node:vm';
import { withApp } from './helpers/http.mjs';

const target = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
};
test('n8n 传入 Dify 的目标保留国家、州和产品，忽略旧城市字段', () => {
  for (const changes of [{}, { region: '' }, { city: 'Miami', product: 'pergolas, motors' }]) {
    const selected = { ...target, ...changes };
    const page = { source_url: 'https://fixture.example/', page_text: 'Actual website content' };
    const payload = JSON.parse(
      vm.runInNewContext(difyResearchBody.slice(3, -2), {
        $json: page,
        $: () => ({ first: () => ({ json: selected }) }),
      }),
    );
    const actual = JSON.parse(payload.inputs.target_json);
    assert.equal('city' in actual, false);
    assert.equal(actual.product, selected.product);
    assert.equal(actual.region, selected.region || null);
    assert.equal(actual.country, selected.country);
    assert.deepEqual(actual.customer_types, []);
    assert.equal(actual.customer_type_filter, false);
    assert.equal(payload.inputs.page_text, page.page_text);
    assert.equal(payload.inputs.source_url, page.source_url);
    assert.equal(payload.response_mode, 'blocking');
  }
});
test('n8n 配置忽略旧客户类型，手动和 API 搜索均不追加角色限制', () => {
  for (const body of [
    undefined,
    { ...target, city: '', customer_types: ['installer', 'distributor'] },
  ]) {
    const config = JSON.parse(
      vm.runInNewContext(searchTargetConfig.slice(3, -2), { $json: { body } }),
    );
    assert.deepEqual(config.customer_types, []);
    assert.equal(config.acquisition_channel, 'tavily_web');
    assert.doesNotMatch(config.search_query, /installer|distributor|Miami/);
    assert.equal(config.region, body?.region ?? '');
    assert.equal('city' in config, false);
  }
});
test('国家与州联动，接口不再提供城市筛选选项', () => {
  const florida = locationOptions('United States', 'Florida');
  assert.equal(florida.regions.length, 51);
  assert.equal('cities' in florida, false);
  const nsw = locationOptions('Australia', 'New South Wales');
  assert.equal(nsw.regions.length, 8);
  assert.equal('cities' in nsw, false);
  assert.throws(() => locationOptions('Australia', 'Florida'), /该国家/);
  assert.equal('city' in validateTarget({ ...target, city: 'Sydney' }), false);
});
test('搜索参数允许全州、全国；旧城市参数不再限制范围', () => {
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
    assert.equal('city' in result, false);
  }
  assert.equal(validateTarget({ ...target, region: '' }).region, '');
  assert.throws(() => validateTarget({ ...target, product: '' }), /product/);
  assert.equal('city' in validateTarget({ ...target, city: 5 }), false);
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
          assert.equal('city' in forwarded, false);
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

test('多选产品通过 API、n8n 配置进入 Dify，旧城市字段不再透传', async () => {
  const product = 'pergolas, sample books, motors, Roman blinds';
  const search_query = product + ' Florida United States';
  let calls = 0;
  await withApp(
    {
      env: {
        N8N_BASE_URL: 'https://vynox.app.n8n.cloud',
        N8N_WEBHOOK_URL: 'https://vynox.app.n8n.cloud/webhook/fixture',
        N8N_WEBHOOK_SECRET: 'fixture',
        N8N_WEBHOOK_ENABLED: 'true',
      },
      fetchImpl: async (_, options) => {
        calls++;
        const body = JSON.parse(options.body);
        assert.equal(body.product, product);
        assert.equal(body.search_query, search_query);
        assert.equal('city' in body, false);
        const config = JSON.parse(
          vm.runInNewContext(searchTargetConfig.slice(3, -2), { $json: { body } }),
        );
        assert.equal(config.product, product);
        assert.equal(config.search_query, search_query);
        const dify = JSON.parse(
          vm.runInNewContext(difyResearchBody.slice(3, -2), {
            $json: { source_url: 'https://fixture.example/', page_text: 'Verified website text' },
            $: () => ({ first: () => ({ json: config }) }),
          }),
        );
        const researchTarget = JSON.parse(dify.inputs.target_json);
        assert.equal(researchTarget.product, product);
        assert.equal(researchTarget.region, 'Florida');
        assert.equal('city' in researchTarget, false);
        return Response.json({ outcome: 'no_new_candidates', reason: 'fixture' });
      },
    },
    async (base) => {
      const response = await fetch(`${base}/api/v1/integrations/n8n/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, product, search_query, city: 'Miami' }),
      });
      assert.equal(response.status, 200);
      assert.equal(calls, 1);
    },
  );
});
