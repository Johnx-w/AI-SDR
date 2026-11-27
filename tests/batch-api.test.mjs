import { feishuEnv, withFeishuAuth } from './helpers/feishu.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { createApp } from '../server/app.mjs';
const env = { ...feishuEnv, TAVILY_API_KEY: 'test', DEEPSEEK_API_KEY: 'test' };
const input = {
  country: 'United States',
  region: '',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
  search_query: 'outdoor zip screens United States',
  target_count: 1,
};
test('批量接口持久、幂等且活跃任务保护共享连接，允许独立资料识别配置', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let calls = 0;
  let closes = 0;
  const app = createApp({
    env,
    fetchImpl: withFeishuAuth(async () =>
      Response.json({ code: 0, data: { items: [], has_more: false } }),
    ),
    nativeImpl: {
      async discover() {
        calls++;
        await gate;
        return { candidates: [] };
      },
      decorateLeads: (data) => data,
      close() {
        closes++;
      },
    },
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${app.address().port}/api/v1/acquisition`;
  const post = (path, body, key = 'batch-api-idem') =>
    fetch(root + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    });
  try {
    for (const acquisition_channel of ['customs', 'dual']) {
      const retired = { ...input, acquisition_channel };
      for (const path of ['/jobs', '/search-preview'])
        assert.equal((await post(path, retired)).status, 400);
      assert.equal(
        (
          await post('/schedules', {
            name: 'retired channel',
            input: retired,
            timing: { repeat: 'once', startDate: '2030-01-01', times: ['09:00'] },
          })
        ).status,
        400,
      );
    }
    for (const target_count of [0, Number.MAX_SAFE_INTEGER + 1, 1.2, '5'])
      assert.equal((await post('/jobs', { ...input, target_count })).status, 400);
    const response = await post('/jobs', input);
    assert.equal(response.status, 202);
    const job = await response.json();
    assert.equal(job.status, 'running');
    const duplicate = await post('/jobs', input);
    assert.equal((await duplicate.json()).id, job.id);
    assert.equal((await post('/jobs', { ...input, target_count: 5 })).status, 409);
    assert.equal(
      (
        await fetch(new URL('/api/v1/connections', root), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: {} }),
        })
      ).status,
      409,
    );
    const connectionUrl = new URL('/api/v1/connections', root);
    const update = (payload) =>
      fetch(connectionUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    const saved = await update({
      values: {
        DOCUMENT_MODEL_BASE_URL: 'https://api.deepseek.com',
        DOCUMENT_MODEL_MODEL: 'deepseek-flash',
        DOCUMENT_MODEL_API_KEY: 'test-document-secret',
      },
    });
    assert.equal(saved.status, 200, '单独保存资料识别配置应允许获客继续执行');
    assert.equal(closes, 0, '资料识别配置不应重建获客服务');
    const view = await (await fetch(connectionUrl)).json();
    assert.equal(view.fields.find((f) => f.key === 'DOCUMENT_MODEL_MODEL').value, 'deepseek-flash');
    assert.equal(view.fields.find((f) => f.key === 'DOCUMENT_MODEL_API_KEY').configured, true);
    assert.ok(!JSON.stringify(view).includes('test-document-secret'));
    assert.equal((await update({ values: {}, clear: ['DOCUMENT_MODEL_API_KEY'] })).status, 200);
    const materialKey = 'MATERIAL_DEEPSEEK_API_KEY';
    const materialSecret = 'sample-material-secret';
    const materialSave = await update({ values: { [materialKey]: materialSecret } });
    assert.equal(materialSave.status, 200, '正在获客时可以保存素材库密钥');
    for (const result of [await materialSave.json(), await (await fetch(connectionUrl)).json()]) {
      const field = result.fields.find((f) => f.key === materialKey);
      assert.equal(field.value, '');
      assert.equal(field.maskedValue, 'samp********cret');
      assert.equal(field.configured, true);
      assert.ok(!JSON.stringify(result).includes(materialSecret));
    }
    for (const shared of ['WEB_SEARCH_API_KEY', 'FEISHU_APP_SECRET', 'RESEARCH_MODEL_API_KEY']) {
      assert.equal(
        (await update({ values: { [shared]: 'sample-new-value' }, clear: [materialKey] })).status,
        409,
      );
      assert.equal(
        (await update({ values: { [materialKey]: 'sample-new-value' }, clear: [shared] })).status,
        409,
      );
    }
    const afterMixed = await (await fetch(connectionUrl)).json();
    assert.equal(
      afterMixed.fields.find((f) => f.key === materialKey).maskedValue,
      'samp********cret',
    );
    assert.equal((await update({ values: {}, clear: [materialKey] })).status, 200);
    const afterClear = await (await fetch(connectionUrl)).json();
    assert.equal(afterClear.fields.find((f) => f.key === materialKey).configured, false);
    assert.equal(closes, 0);
    for (const payload of [
      { values: { DOCUMENT_MODEL_MODEL: 'new-model', DEEPSEEK_MODEL: 'new-model' } },
      { values: { DOCUMENT_MODEL_MODEL: 'new-model' }, clear: ['DEEPSEEK_API_KEY'] },
    ])
      assert.equal((await update(payload)).status, 409, '混合修改其他配置仍需原有任务保护');
    assert.equal(
      (await update({ values: { DOCUMENT_MODEL_BASE_URL: 'http://unsafe.invalid' } })).status,
      400,
    );
    const list = await (await fetch(root + '/jobs')).json();
    assert.equal(list.jobs[0].id, job.id);
    assert.equal('seen' in list.jobs[0], false);
    const stopped = await post(`/jobs/${job.id}/stop`, {});
    assert.equal((await stopped.json()).status, 'stopping');
    release();
    let final;
    for (let n = 0; n < 20; n++) {
      final = await (await fetch(root + '/jobs/' + job.id)).json();
      if (final.status === 'partial') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(final.reason, 'stopped');
    assert.equal(final.inserted, 0);
    assert.equal(calls, 1);
    assert.equal((await post(`/jobs/${job.id}/resume`, {})).status, 409);
    assert.equal((await fetch(root + '/jobs/not-found')).status, 404);
  } finally {
    release();
    await new Promise((r) => app.close(r));
  }
});

test('立即与到期计划按本国两地补搜并读回新增企业，仅返回已有官网时为零', async (t) => {
  t.mock.timers.enable({
    apis: ['Date', 'setInterval'],
    now: Date.parse('2030-01-01T08:59:50+08:00'),
  });
  // Captured company websites, keyed by the actual public searches that returned them.
  const samples = [
    ['Malaysia', 'Johor', 'curtains', 'supplier', 'HS Curtains', 'https://www.jbcurtains.com.my/'],
    ['Malaysia', 'Kedah', 'curtains', 'dealer', 'Amanjaya Decor', 'https://www.amanjayadecor.com/'],
    [
      'New Zealand',
      'Auckland',
      'roller blinds',
      'supplier',
      'mr blinds',
      'https://mrblinds.co.nz/about-us/auckland-blinds',
    ],
    [
      'New Zealand',
      'Bay of Plenty',
      'roller blinds',
      'dealer',
      'Spencers Blinds',
      'https://spencersblindsbop.co.nz/',
    ],
  ];
  const known = 'https://known-curtains.com/';
  const sites = new Map(
    samples.map(([country, region, product, , name, url]) => [
      url,
      {
        name,
        country,
        identity: `${name} operates in ${region}, ${country}.`,
        products: [product],
      },
    ]),
  );
  sites.set(known, {
    name: 'Known',
    identity: 'Known is a window coverings supplier.',
    products: ['curtains', 'roller blinds'],
  });
  for (const data of sites.values())
    data.supply = `We supply ${data.products.join(' and ')} for residential windows and commercial buildings.`;
  const native = new NativeAcquisition({
    env,
    readPage: async ({ href }) => {
      const data = sites.get(href);
      return { html: data ? `<p>${data.identity}</p><p>${data.supply}</p>` : '' };
    },
    readScraplingPage: async () => ({ status: 'unavailable' }),
  });
  native.providers.web.search = async ({ query }) => {
    const match = samples.find(
      ([country, region, product, role]) =>
        query === '"' + product + '" ' + role + ' ' + country + ' ' + region,
    );
    return { results: [{ url: known }, ...(match ? [{ url: match[5] }] : [])] };
  };
  native.providers.web.extract = async () => ({ results: [] });
  native.providers.model.research = async ({ messages }) => {
    const { pages, sources } = JSON.parse(messages[1].content);
    let response;
    if (sources) {
      response = { result: 'relevant', sources: sources.map(({ i }) => i), reason: '核实官网主营' };
    } else {
      const source_url = pages.find((page) => sites.has(page.source_url)).source_url;
      const data = sites.get(source_url);
      const evidence = (value, quote) => ({ value, quote, source_url });
      response = {
        company_name: evidence(data.name, data.identity),
        actual_country: data.country ? evidence(data.country, data.identity) : null,
        entity_type: evidence('business', data.identity),
        admission_facts: [evidence('complete_supply', data.supply)],
        products: data.products.map((product) => ({
          ...evidence(product, data.supply),
          window_use: 'window_covering',
        })),
      };
    }
    return {
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(response) }] }],
    };
  };
  const app = createApp({
    env,
    nativeImpl: native,
    fetchImpl: async () => {
      throw Error('unexpected external request');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    await native.feishu.write('insert', { 客户名称: 'Known', 来源链接: known }, null, 'seed');
    const base = 'http://127.0.0.1:' + app.address().port + '/api/v1/acquisition';
    async function api(path, body, key) {
      const res = await fetch(
        base + path,
        body
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
              body: JSON.stringify(body),
            }
          : undefined,
      );
      const data = await res.json();
      assert.ok(res.ok, JSON.stringify(data));
      return data;
    }
    for (const [country, product, scheduled] of [
      ['Malaysia', 'curtains', false],
      ['New Zealand', 'roller blinds', true],
      ['Singapore', 'curtains', false],
    ]) {
      const target = { ...input, country, product, query_mode: 'auto', target_count: 2 };
      let jobId;
      if (scheduled) {
        const plan = await api(
          '/schedules',
          {
            name: country,
            input: target,
            timing: { repeat: 'once', startDate: '2030-01-01', times: ['09:00'] },
          },
          'region-scheduled',
        );
        t.mock.timers.tick(15000);
        const triggered = (await api('/schedules')).schedules.find((row) => row.id === plan.id);
        assert.equal(triggered.runs, 1);
        jobId = triggered.lastJobId;
      } else {
        jobId = (await api('/jobs', target, 'region-now-' + country)).id;
      }
      let job;
      for (let i = 0; i < 150; i++) {
        job = await api('/jobs/' + jobId);
        if (job.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const expected = samples.filter((sample) => sample[0] === country);
      assert.equal(job.status, expected.length ? 'completed' : 'partial', job.reason);
      assert.equal(job.inserted, expected.length);
      assert.equal(job.searches, expected.length ? 4 : 24);
      if (!expected.length) {
        assert.equal(job.reason, 'exhausted');
        assert.equal(job.batch.previousBoundary, 'search_limit');
      }
      const regional = job.searchStats.filter((stat) => stat.searchRegion);
      if (expected.length)
        assert.deepEqual(
          regional.map((stat) => stat.searchRegion),
          expected.map((sample) => sample[1]),
        );
      else
        assert.ok(
          regional.some((stat) => stat.searchRegion === 'Central Singapore' && stat.duplicates > 0),
        );
      assert.ok(job.searchStats.every((stat) => stat.country === country));
      assert.deepEqual(
        job.rows.filter((r) => r.inserted_new).map((r) => r.name),
        expected.map((sample) => sample[4]),
      );
      const records = await native.feishu.records();
      assert.deepEqual(
        records
          .filter((r) => r.fields.国家 === country)
          .map((r) => r.fields.来源链接)
          .sort(),
        expected.map((sample) => sample[5]).sort(),
      );
    }
    assert.equal((await native.feishu.records()).length, 5);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
