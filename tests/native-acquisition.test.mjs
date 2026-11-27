import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { NativeAcquisition, selectWebsiteCandidates } from '../server/native-acquisition.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { createApp } from '../server/app.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';
import { collectScraplingPage } from '../server/scrapling-collector.mjs';
import { createGooglePlacesDiagnosticProvider } from '../server/maps-discovery.mjs';
import { withApp } from './helpers/http.mjs';

const site = 'https://acme.example.org/';
const env = {
  TAVILY_API_KEY: 'test-tavily',
  DEEPSEEK_API_KEY: 'test-deepseek',
  DEEPSEEK_MODEL: 'deepseek-flash',
  FEISHU_APP_ID: 'test-app',
  FEISHU_APP_SECRET: 'test-secret',
  FEISHU_APP_TOKEN: 'test-base',
  FEISHU_TABLE_ID: 'test-table',
};
const input = {
  country: 'United States',
  region: '',
  product: 'zip screens',
  customer_type: '',
  customer_profile: 'all',
  search_query: 'zip screens United States',
  acquisition_channel: 'tavily_web',
};
const sourceText =
  'Acme Screens imports zip screens from independent factories. We supply dealers and installers nationwide in the United States, without our own factory.';
const definitions = [
  ...[
    '客户名称',
    '来源链接',
    'customer_id',
    '主体类型',
    '相关产品',
    '主营产品偏好',
    '需求产品',
    '客户行业画像',
    '服务客群',
    '电话',
    '邮箱',
    '国家',
    '州 / 城市',
    '详细地址',
    '服务地区',
    'Facebook',
    'Instagram',
    'LinkedIn',
  ].map((field_name) => ({ field_name, type: 1 })),
  { field_name: '首次发现时间', type: 5 },
  { field_name: '客户类型', type: 3 },
];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

for (const interruptAt of ['官网正文已保存', '已派模型应答返回'])
  test('发布中断后同一轮复用已存官网和原操作：' + interruptAt, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'acquisition-recovery-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const maintenance = join(dir, 'maintenance.json');
    const runtimeEnv = {
      TAVILY_API_KEY: 'fixture-search',
      DEEPSEEK_API_KEY: 'fixture-model',
      BATCH_DB_PATH: join(dir, 'acquisition.sqlite'),
      LEAD_LIBRARY_DB_PATH: join(dir, 'customers.sqlite'),
      RELEASE_MAINTENANCE_PATH: maintenance,
    };
    const north = 'https://north-recovery.example.org/';
    const south = 'https://south-recovery.example.org/';
    const alias = 'https://north-recovery-alias.example.org/';
    const companies = {
      [north]: ['North Recovery Limited', '07123456'],
      [south]: ['South Recovery Limited', '07987654'],
      [alias]: ['North Recovery Limited', '07123456'],
    };
    const identity = (url) => {
      const [name, number] = companies[url];
      return `This website is operated by ${name}, registered in England and Wales, company number ${number}.`;
    };
    const operating =
      'We supply made-to-measure roller blinds for residential windows and commercial buildings.';
    let found = 0;
    let interrupt = true;
    const calls = [];
    const fetchImpl = async (url, options) => {
      if (url === 'https://api.tavily.com/search') {
        found++;
        return json({
          results: Object.keys(companies).map((url) => ({ url, title: companies[url][0] })),
        });
      }
      if (url !== 'https://api.deepseek.com/responses') throw new Error('Fixture network disabled');
      const { pages, sources } = JSON.parse(JSON.parse(options.body).input[1].content);
      const response = sources
        ? { result: 'relevant', sources: sources.map(({ i }) => i), reason: '官网确认经营' }
        : (() => {
            const url = pages[0].source_url;
            calls.push(url);
            const evidence = (value, quote) => ({ value, quote, source_url: url });
            return {
              company_name: evidence(companies[url][0], identity(url)),
              legal_company_name: evidence(companies[url][0], identity(url)),
              entity_type: evidence('business', identity(url)),
              admission_facts: [evidence('complete_supply', operating)],
              products: [
                { ...evidence('roller blinds', operating), window_use: 'window_covering' },
              ],
            };
          })();
      if (interrupt && interruptAt === '已派模型应答返回' && pages?.[0].source_url === south)
        writeFileSync(maintenance, '{}');
      return json({
        status: 'completed',
        usage: { input_tokens: 511, output_tokens: 39, total_tokens: 550 },
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(response) }] }],
      });
    };
    const pageReads = [];
    const options = () => ({
      env: runtimeEnv,
      fetchImpl,
      nativeImpl: new NativeAcquisition({
        env: runtimeEnv,
        fetchImpl,
        readPage: async ({ href }) => {
          pageReads.push(href);
          if (interrupt && interruptAt === '官网正文已保存' && href === south)
            writeFileSync(maintenance, '{}');
          return { html: `<p>${identity(href)}</p><p>${operating}</p>` };
        },
      }),
    });
    const waitRead = async (url, predicate) => {
      let result;
      for (let attempt = 0; attempt < 200; attempt++) {
        result = await (await fetch(url)).json();
        if (predicate(result)) return result;
        await delay(10);
      }
      assert.fail(JSON.stringify(result));
    };
    let id;
    await withApp(options(), async (origin) => {
      const response = await fetch(origin + '/api/v1/acquisition/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'recovery-fixture' },
        body: JSON.stringify({
          ...input,
          product: 'roller blinds',
          search_query: 'roller blinds United States',
          target_count: 3,
          research_budget: 3,
        }),
      });
      assert.equal(response.status, 202);
      ({ id } = await response.json());
      await waitRead(origin + '/api/v1/ops/maintenance', ({ enabled, quiet }) => enabled && quiet);
      assert.deepEqual(
        pageReads,
        [north, south],
        'maintenance yields after saving the second page',
      );
      assert.deepEqual(calls, interruptAt === '官网正文已保存' ? [north] : [north, south]);
      rmSync(maintenance);
      const paused = await (await fetch(origin + '/api/v1/acquisition/jobs/' + id)).json();
      assert.deepEqual([paused.status, paused.reason], ['paused', 'checkpointed']);
      writeFileSync(maintenance, '{}');
    });
    interrupt = false;
    rmSync(maintenance);
    await withApp(options(), async (origin) => {
      const api = origin + '/api/v1';
      const job = await waitRead(api + '/acquisition/jobs/' + id, ({ status }) =>
        ['completed', 'partial'].includes(status),
      );
      assert.equal(job.inserted, 2, JSON.stringify({ rows: job.rows, pageReads, calls }));
      assert.equal(job.remainingTarget, 1);
      assert.equal(job.researched, 3);
      assert.equal(found, 1);
      assert.deepEqual(pageReads, [north, south, alias]);
      assert.deepEqual(calls, [north, south]);
      assert.deepEqual(
        job.rows.map(({ source_url, result }) => [source_url, result]),
        [
          [north, 'inserted'],
          [south, 'inserted'],
          [alias, 'duplicate'],
        ],
      );
      assert.equal(job.rows[1].capture.operation_id, id + '-2');
      assert.equal(job.rows[0].record_id, job.rows[2].record_id);
      assert.deepEqual(
        (await (await fetch(api + '/leads/real/list')).json()).leads.map(({ name }) => name).sort(),
        ['North Recovery Limited', 'South Recovery Limited'],
      );
    });
  });

function fixture({
  initial = [],
  loseWrite = false,
  loseReadback = false,
  lateDuplicate = false,
  corruptReadback = false,
  tavilyError = false,
  pageText = sourceText,
  modelOverrides = {},
  activityDecision,
  companyNameField = '客户名称',
  automaticAssessment = false,
} = {}) {
  const calls = [],
    records = JSON.parse(JSON.stringify(initial));
  let lists = 0,
    loseRead = loseReadback;
  const fetchImpl = async (urlValue, options = {}) => {
    const url = String(urlValue),
      method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method, body, headers: options.headers });
    if (url.includes('/auth/v3/'))
      return json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    if (url.endsWith('/fields?page_size=100'))
      return json({
        code: 0,
        data: {
          items: [
            ...definitions,
            ...(automaticAssessment
              ? [
                  { field_name: '用户评级', type: 3 },
                  { field_name: '最近研究时间', type: 5 },
                ]
              : []),
          ].map((field) =>
            field.field_name === '客户名称' ? { ...field, field_name: companyNameField } : field,
          ),
          has_more: false,
        },
      });
    if (url.includes('/records?page_size=')) {
      lists++;
      if (lateDuplicate && lists === 2)
        records.push({
          record_id: 'rec-other',
          fields: { 来源链接: site, 客户名称: 'Other' },
        });
      return json({ code: 0, data: { items: records, has_more: false } });
    }
    if (url.includes('/records?client_token=') && method === 'POST') {
      const record = { record_id: 'rec-native', fields: body.fields };
      records.push(record);
      if (loseWrite) throw new Error('upstream response lost');
      return json({ code: 0, data: { record } });
    }
    if (url.includes('/records/rec-') && method === 'PUT') {
      const record = records.find((r) => url.endsWith('/' + r.record_id));
      Object.assign(record.fields, body.fields);
      return json({ code: 0, data: { record } });
    }
    if (url.includes('/records/rec-') && method === 'GET') {
      if (loseRead) {
        loseRead = false;
        throw new Error('read unavailable');
      }
      const record = records.find((r) => url.endsWith('/' + r.record_id));
      return json({
        code: 0,
        data: {
          record: corruptReadback
            ? { ...record, fields: { ...record.fields, 客户名称: 'Wrong' } }
            : record,
        },
      });
    }
    if (url === 'https://api.tavily.com/search') {
      if (tavilyError) return json({ error: 'test-secret never expose' }, 401);
      return json({ results: [{ url: site, title: 'Acme Screens' }] });
    }
    if (url === 'https://api.tavily.com/extract') return json({ results: [] });
    if (url === 'https://api.deepseek.com/responses') {
      if (body.text?.format?.schema?.properties?.sources) {
        const { sources } = JSON.parse(body.input[1].content);
        const decision = activityDecision ?? {
          result: 'relevant',
          sources: sources.map((s) => s.i),
          reason: '官网经营证据',
        };
        return json({
          status: 'completed',
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(decision) }] }],
        });
      }
      const evidence = (value, quote) => ({ value, quote, source_url: site });
      const data = {
        company_name: evidence('Acme Screens', sourceText),
        admission_facts: [evidence('complete_supply', sourceText)],
        entity_type: evidence('business', sourceText),
        production_model: evidence('no_own_factory', sourceText),
        operating_model: evidence('beyond_local', sourceText),
        manufactured_products: [],
        actual_country: pageText.includes('United States')
          ? evidence('United States', pageText)
          : null,
        customer_type: evidence('distributor', sourceText),
        audience: evidence('B', sourceText),
        main_product_preference: evidence('主营 zip screens。', sourceText),
        industry_profile: evidence('窗饰进口经销企业', sourceText),
        products: [evidence('zip screens', sourceText)],
        demand_products: [],
        profile_tags: [evidence('trade', sourceText)],
        address: null,
        service_areas: [],
        ...modelOverrides,
      };
      return json({
        status: 'completed',
        model: 'deepseek-flash',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
        usage: { input_tokens: 20, output_tokens: 20 },
      });
    }
    throw new Error('Unexpected API endpoint: ' + url);
  };
  const readPage = async (url) => ({
    html:
      url.pathname === '/'
        ? '<p>' + pageText + '</p><a href="/contact">Contact us</a>'
        : '<p>Contact our team</p><a href="mailto:sales@acme.example.org">Email</a>',
  });
  const make = (extra = {}) =>
    new NativeAcquisition({ admissionVersion: 'legacy', env, fetchImpl, readPage, ...extra });
  return { calls, records, fetchImpl, readPage, make };
}

const policyFact = (value, quote) => ({ value, quote, source_url: site });

function mapDiscoveryFixture({
  lookup,
  googleResponse,
  mapSettings,
  webResults,
  fakeIdentity = false,
} = {}) {
  const sites = new Map([
    ['https://atlas-shades.example.org/', { name: 'Atlas Shades Limited', number: '08234567' }],
    ['https://beacon-shades.example.org/', { name: 'Beacon Shades Limited', number: '08345678' }],
    ['https://atlas-showroom.example.org/', { name: 'Atlas Shades Limited', number: '08234567' }],
    ['https://cedar-shades.example.org/', { name: 'Cedar Shades Limited', number: '08456789' }],
  ]);
  const [atlas, beacon, showroom, cedar] = sites.keys();
  const identity = ({ name, number }) =>
    `This website is operated by ${name}, registered in England and Wales, company number ${number}.`;
  const supply = 'We supply custom roller blinds for residential windows and commercial buildings.';
  const html = (url) =>
    `<p>${identity(sites.get(url))}</p>${url === cedar ? '' : `<p>${supply}</p>`}`;
  const requests = [];
  const googleRequests = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options?.body || '{}');
    if (url === 'https://api.tavily.com/search') {
      requests.push(request.query);
      const urls = webResults?.({ atlas, beacon, showroom, cedar, search: requests.length }) || [
        beacon,
      ];
      return json({
        results: urls.map((url) => ({ url, title: sites.get(url).name })),
        usage: { credits: 1 },
      });
    }
    if (url === 'https://places.googleapis.com/v1/places:searchText' && googleResponse) {
      googleRequests.push({ body: request, headers: options.headers, redirect: options.redirect });
      return googleResponse();
    }
    if (url === 'https://api.deepseek.com/responses') {
      const { pages, sources } = JSON.parse(request.input[1].content);
      const quote = pages ? identity(sites.get(pages[0].source_url)) : '';
      const evidence = (value, quote) => ({ value, quote, source_url: pages[0].source_url });
      const data = sources
        ? { result: 'relevant', sources: sources.map(({ i }) => i), reason: '官网确认经营' }
        : {
            company_name: evidence(
              sites.get(pages[0].source_url).name,
              fakeIdentity ? `${quote} Invalid model quote.` : quote,
            ),
            legal_company_name: evidence(
              sites.get(pages[0].source_url).name,
              fakeIdentity ? `${quote} Invalid model quote.` : quote,
            ),
            entity_type: evidence('business', quote),
            admission_facts: [evidence('complete_supply', supply)],
            products: [{ ...evidence('roller blinds', supply), window_use: 'window_covering' }],
          };
      return json({
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
      });
    }
    throw new Error('非隔离端点 ' + url);
  };
  const mapQueries = [];
  const fixtureEnv = { ...env, ...mapSettings };
  const nativeImpl = new NativeAcquisition({
    env: fixtureEnv,
    fetchImpl,
    readPage: async ({ href }) => ({
      html: href === atlas ? '<noscript>Enable JavaScript</noscript>' : html(href),
    }),
    readScraplingPage: async (url) => ({ final_url: url, status: 'ok', content: html(url) }),
    mapsProvider: mapSettings
      ? createGooglePlacesDiagnosticProvider({ env: fixtureEnv, fetchImpl })
      : {
          name: 'permitted_fixture',
          async search({ query, country }) {
            mapQueries.push({ query, country });
            return (
              lookup?.({ atlas, beacon, showroom, sites, attempt: mapQueries.length }) ?? {
                places: [
                  { id: 'venue-a', name: sites.get(atlas).name, website: atlas },
                  { id: 'venue-b', name: sites.get(beacon).name, website: beacon },
                  { id: 'venue-c', name: 'Cedar Shades' },
                  { id: 'venue-a2', name: sites.get(showroom).name, website: showroom },
                ],
                usage: { credits: 3 },
              }
            );
          },
        },
  });
  return {
    app: { env: fixtureEnv, fetchImpl, nativeImpl },
    atlas,
    beacon,
    showroom,
    mapQueries,
    requests,
    googleRequests,
    html,
  };
}

test('付费模型应答丢失后继续只核对原请求，取回结果后收录一次', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acquisition-paid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtimeEnv = {
    ...env,
    BATCH_DB_PATH: join(dir, 'acquisition.sqlite'),
    LEAD_LIBRARY_DB_PATH: join(dir, 'customers.sqlite'),
  };
  const fixture = mapDiscoveryFixture();
  let received;
  let sentRequestId;
  let extractionCalls = 0;
  let queryCalls = 0;
  const lookups = [];
  const fetchImpl = async (url, options) => {
    if (url === 'https://api.tavily.com/search') queryCalls++;
    if (url === 'https://api.deepseek.com/responses') {
      const { sources } = JSON.parse(JSON.parse(options.body).input[1].content);
      if (!sources) {
        extractionCalls++;
        sentRequestId = options.headers['X-Client-Request-Id'];
        received = await (await fixture.app.fetchImpl(url, options)).json();
        throw new Error('供应商已执行，但 HTTP 响应中断');
      }
    }
    return fixture.app.fetchImpl(url, options);
  };
  let remoteAvailable = false;
  const options = () => {
    const service = new NativeAcquisition({
      env: runtimeEnv,
      fetchImpl,
      readPage: fixture.app.nativeImpl.readPage,
    });
    service.providers.model.reconcile = ({ id, kind }) => {
      lookups.push([id, kind]);
      return remoteAvailable ? { status: 'completed', response: received } : { status: 'unknown' };
    };
    return { env: runtimeEnv, fetchImpl, nativeImpl: service };
  };
  const jobAt = async (url, expected) => {
    for (let attempt = 0; attempt < 175; attempt++) {
      const job = await (await fetch(url)).json();
      if (job.status !== 'running') {
        assert.equal(job.status, expected, JSON.stringify(job.rows));
        return job;
      }
      await delay(10);
    }
    assert.fail('获客任务未及时进入' + expected);
  };
  let id;
  let request;
  await withApp(options(), async (origin) => {
    const jobs = origin + '/api/v1/acquisition/jobs';
    const submit = await fetch(jobs, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'paid-recovery-fixture' },
      body: JSON.stringify({
        ...input,
        product: 'roller blinds',
        search_query: 'roller blinds United States',
        target_count: 1,
        research_budget: 1,
      }),
    });
    assert.equal(submit.status, 202);
    ({ id } = await submit.json());
    const pending = await jobAt(jobs + '/' + id, 'paused');
    assert.equal(pending.currentProgress.stage, 'research');
    assert.equal(pending.currentProgress.research_usage.model_calls, 1);
    assert.equal(pending.remainingTarget, 1);
    [request] = pending.currentProgress.requests.filter(({ status }) => status === 'unknown');
    assert.equal(request.kind, 'model_extraction');
    assert.equal(request.id, sentRequestId);
    assert.equal(pending.rows.length, 0);
    assert.equal((await fetch(jobs + '/' + id + '/resume', { method: 'POST' })).status, 409);
  });
  await withApp(options(), async (origin) => {
    const api = origin + '/api/v1';
    const url = api + '/acquisition/jobs/' + id;
    const pending = await jobAt(url, 'paused');
    assert.equal(pending.currentProgress.requests[0].id, request.id);
    assert.equal(extractionCalls, 1);
    remoteAvailable = true;
    await Promise.all([
      fetch(url + '/resume', { method: 'POST' }),
      fetch(url + '/resume', { method: 'POST' }),
    ]);
    const done = await jobAt(url, 'completed');
    assert.equal(done.inserted, 1);
    assert.equal(done.remainingTarget, 0);
    assert.equal(done.rows[0].source_url, fixture.beacon);
    assert.equal(done.researchUsage.model_calls, 2);
    assert.equal(extractionCalls, 1);
    assert.equal(queryCalls, 1);
    assert.ok(lookups.length >= 2);
    assert.ok(lookups.every(([id, kind]) => id === request.id && kind === 'model_extraction'));
    assert.deepEqual(
      (await (await fetch(api + '/leads/real/list')).json()).leads.map(({ website }) => website),
      [fixture.beacon],
    );
  });
});

test('付费搜索失去应答时恢复保持原游标，供应商核对后消费同批候选', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acquisition-search-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = mapDiscoveryFixture();
  const runtimeEnv = { ...env, BATCH_DB_PATH: join(dir, 'acquisition.sqlite') };
  let queries = 0;
  let providerResult;
  let sentRequestId;
  let responseAvailable = false;
  const checks = [];
  const fetchImpl = async (url, options) => {
    if (url === 'https://api.tavily.com/search') {
      queries++;
      sentRequestId = options.headers['X-Client-Request-Id'];
      providerResult = await (await fixture.app.fetchImpl(url, options)).json();
      throw new Error('搜索应答丢失');
    }
    return fixture.app.fetchImpl(url, options);
  };
  const options = () => {
    const nativeImpl = new NativeAcquisition({
      env: runtimeEnv,
      fetchImpl,
      readPage: fixture.app.nativeImpl.readPage,
    });
    nativeImpl.providers.web.reconcile = ({ id, kind }) => {
      checks.push([id, kind]);
      return responseAvailable ? { status: 'completed', response: providerResult } : null;
    };
    return { env: runtimeEnv, fetchImpl, nativeImpl };
  };
  const waitFor = async (url, status) => {
    for (let attempt = 0; attempt < 175; attempt++) {
      const job = await (await fetch(url)).json();
      if (job.status === status) return job;
      await delay(10);
    }
    assert.fail('获客任务未及时进入' + status);
  };
  let id;
  let requestId;
  await withApp(options(), async (origin) => {
    const jobs = origin + '/api/v1/acquisition/jobs';
    const result = await fetch(jobs, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'search-recovery-fixture' },
      body: JSON.stringify({
        ...input,
        product: 'roller blinds',
        target_count: 1,
        research_budget: 1,
      }),
    });
    assert.equal(result.status, 202);
    ({ id } = await result.json());
    const paused = await waitFor(jobs + '/' + id, 'paused');
    assert.equal(paused.searches, 1);
    assert.equal(paused.currentProgress.requests[0].kind, 'web_search');
    requestId = paused.currentProgress.requests[0].id;
    assert.equal(requestId, sentRequestId);
    assert.equal(paused.currentProgress.requests[0].status, 'unknown');
  });
  await withApp(options(), async (origin) => {
    const url = origin + '/api/v1/acquisition/jobs/' + id;
    assert.equal((await fetch(url + '/resume', { method: 'POST' })).status, 409);
    assert.equal(queries, 1);
    responseAvailable = true;
    const waited = await fetch(url + '/resume', { method: 'POST' });
    assert.equal(waited.status, 200);
    const done = await waitFor(url, 'completed');
    assert.equal(done.inserted, 1);
    assert.equal(done.rows[0].source_url, fixture.beacon);
    assert.equal(done.searches, 1);
    assert.equal(done.searchStats[0].usage.credits, 1);
    assert.equal(queries, 1);
    assert.ok(checks.every(([id, kind]) => id === requestId && kind === 'web_search'));
  });
});

for (const [browserStatus, browserReason] of [
  ['failed', 'worker_crashed'],
  ['timeout', 'page_timeout'],
  ['memory_limit', 'worker_memory_limit'],
  ['deferred', 'queue_timeout'],
])
  test('资源失败和外部提取未知只延后缺证企业，两个正常官网继续入库：' + browserReason, async () => {
    const shell = 'https://unreadable-recovery.example.org/';
    const fixture = mapDiscoveryFixture({
      webResults: ({ atlas, beacon }) => [shell, atlas, beacon],
    });
    const extractCalls = [];
    const fetchImpl = async (url, options) => {
      if (url === 'https://api.tavily.com/search') {
        return json({
          results: [shell, fixture.atlas, fixture.beacon].map((url) => ({ url, title: url })),
          usage: { credits: 1 },
        });
      }
      if (url === 'https://api.tavily.com/extract') {
        extractCalls.push(JSON.parse(options.body).urls);
        throw new Error('外部提取应答丢失');
      }
      return fixture.app.fetchImpl(url, options);
    };
    const nativeImpl = new NativeAcquisition({
      env,
      fetchImpl,
      readPage: async (url, signal) =>
        url.href === shell
          ? { html: '<noscript>Enable JavaScript</noscript>' }
          : fixture.app.nativeImpl.readPage(url, signal),
      readScraplingPage: async (url) =>
        url === shell
          ? {
              status: browserStatus,
              failure_reason: browserReason,
              ...(browserStatus === 'deferred'
                ? {
                    resource_wait: { reason: 'low_memory', wait_ms: 100, end: 'queue_timeout' },
                  }
                : {}),
            }
          : fixture.app.nativeImpl.readScraplingPage(url),
    });
    await withApp({ env, fetchImpl, nativeImpl }, async (origin) => {
      const api = origin + '/api/v1';
      const response = await fetch(api + '/acquisition/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'fallback-fixture' },
        body: JSON.stringify({
          ...input,
          product: 'roller blinds',
          target_count: 2,
          research_budget: 3,
        }),
      });
      assert.equal(response.status, 202);
      const { id } = await response.json();
      let job;
      for (let attempt = 0; attempt < 125; attempt++) {
        job = await (await fetch(api + '/acquisition/jobs/' + id)).json();
        if (job.status !== 'running') break;
        await delay(10);
      }
      assert.equal(job.status, 'completed');
      assert.deepEqual(
        job.rows.map(({ source_url, result }) => [source_url, result]),
        [
          [shell, 'review'],
          [fixture.atlas, 'inserted'],
          [fixture.beacon, 'inserted'],
        ],
      );
      assert.deepEqual(
        job.rows[0].collection_attempts.map(({ method, status, failure_reason }) => [
          method,
          status,
          failure_reason ?? null,
        ]),
        [
          ['node', 'empty', null],
          ['scrapling', browserStatus, browserReason],
          ['external', 'unknown', 'provider_request_unknown'],
        ],
      );
      const [request] = job.rows[0].paid_requests;
      assert.deepEqual([request.kind, request.status], ['web_extract', 'unknown']);
      assert.equal(job.rows[0].collection_attempts[2].paid_request_id, request.id);
      if (browserStatus === 'deferred')
        assert.equal(job.rows[0].collection_attempts[1].resource_wait.reason, 'low_memory');
      assert.deepEqual(extractCalls, [[shell]]);
      assert.deepEqual(
        (await (await fetch(api + '/leads/real/list')).json()).leads
          .map(({ website }) => website)
          .sort(),
        [fixture.atlas, fixture.beacon],
      );
    });
  });

test('服务正常停止时收回活跃浏览器，重启补抓未保存的网页并保持原候选', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acquisition-browser-shutdown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = mapDiscoveryFixture({ webResults: ({ atlas }) => [atlas] });
  const runtimeEnv = { ...env, BATCH_DB_PATH: join(dir, 'acquisition.sqlite') };
  const { fetchImpl } = fixture.app;
  let begin;
  const browserStarted = new Promise((resolve) => (begin = resolve));
  let aborted = 0;
  const browserReads = [];
  const options = (hold) => ({
    env: runtimeEnv,
    fetchImpl,
    nativeImpl: new NativeAcquisition({
      env: runtimeEnv,
      fetchImpl,
      readPage: fixture.app.nativeImpl.readPage,
      readScraplingPage: async (url, { signal }) => {
        browserReads.push(url);
        if (!hold) return fixture.app.nativeImpl.readScraplingPage(url);
        begin();
        return new Promise((resolve) =>
          signal?.addEventListener(
            'abort',
            () => {
              aborted++;
              resolve({ status: 'deferred', failure_reason: 'aborted' });
            },
            { once: true },
          ),
        );
      },
    }),
  });
  const app = createApp(options(true));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  let id;
  try {
    const jobs = 'http://127.0.0.1:' + app.address().port + '/api/v1/acquisition/jobs';
    const response = await fetch(jobs, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'shutdown-fixture' },
      body: JSON.stringify({
        ...input,
        product: 'roller blinds',
        target_count: 1,
        research_budget: 1,
      }),
    });
    assert.equal(response.status, 202);
    ({ id } = await response.json());
    await browserStarted;
    await app.shutdown();
    assert.equal(aborted, 1);
  } finally {
    if (app.listening) await new Promise((resolve) => app.close(resolve));
  }
  await withApp(options(false), async (origin) => {
    const api = origin + '/api/v1';
    let job;
    for (let attempt = 0; attempt < 125; attempt++) {
      job = await (await fetch(api + '/acquisition/jobs/' + id)).json();
      if (job.status === 'completed') break;
      await delay(10);
    }
    assert.equal(job.status, 'completed');
    assert.equal(job.researched, 1);
    assert.equal(job.rows[0].capture.operation_id, id + '-1');
    assert.deepEqual(browserReads, [fixture.atlas, fixture.atlas]);
    assert.deepEqual(
      job.rows[0].collection_attempts
        .filter(({ method }) => method === 'scrapling')
        .map(({ status }) => status),
      ['deferred', 'ok'],
    );
    assert.deepEqual(
      (await (await fetch(api + '/leads/real/list')).json()).leads.map(({ website }) => website),
      [fixture.atlas],
    );
  });
});

test('快照保留期和缓存容量只清理未引用页面，保留在途和档案原文', () => {
  const store = new AcquisitionStore(':memory:', 'retention-fixture', { snapshotCacheBytes: 550 });
  const now = Date.parse('2030-02-01T00:00:00Z');
  const snapshot = (name, date, operationId) => {
    const url = 'https://' + name + '.example.org/';
    return store.savePageSnapshot(
      {
        requested_url: url,
        final_url: url,
        acquired_at: date,
        method: 'node',
        status: 'ok',
        content: name + ' independent frozen original website evidence. '.repeat(4),
      },
      { operationId },
    );
  };
  try {
    const old = '2030-01-12T00:00:00.000Z';
    const active = store.begin('active-fixture-operation', {}).operation;
    const archived = store.begin('archived-fixture-operation', {}).operation;
    const inFlight = snapshot('active', old, active.id);
    // Reopening a pre-upgrade operation may have its references only in operation evidence.
    const history = snapshot('archive', old);
    store.complete(archived, { research: { facts: [{ snapshot_id: history.snapshot_id }] } });
    const expired = snapshot('old-unreferenced', old);
    const overflow = snapshot('overflow', '2030-01-31T22:00:00.000Z');
    const latest = snapshot('latest', '2030-01-31T23:00:00.000Z');
    store.prunePageSnapshots({ now });
    assert.equal(store.snapshotById(inFlight.snapshot_id).content, inFlight.content);
    assert.equal(store.snapshotById(history.snapshot_id).content, history.content);
    assert.equal(store.snapshotById(expired.snapshot_id), null);
    assert.equal(store.snapshotById(overflow.snapshot_id), null);
    assert.equal(store.snapshotById(latest.snapshot_id).content, latest.content);
  } finally {
    store.close();
  }
});

async function runMapDiscoveryJob(base, target = 3, key = 'maps-discovery-pair') {
  const api = base + '/api/v1';
  const response = await fetch(api + '/acquisition/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({
      ...input,
      product: 'window coverings',
      product_scope: 'all',
      target_count: target,
    }),
  });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  let job;
  for (let n = 0; n < 400; n++) {
    job = await (await fetch(api + '/acquisition/jobs/' + id)).json();
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`隔离任务 ${id} 未结束（已研究 ${job.researched} 家）`);
}

test('正常官网任务忽略 Places 环境配置，重启后可读回两个网站档案和缺证结果', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'website-only-acquisition-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { app, atlas, beacon, googleRequests, html } = mapDiscoveryFixture({
    mapSettings: { GOOGLE_PLACES_API_KEY: 'fixture-places-key', GOOGLE_PLACES_IDS_ONLY: 'true' },
    googleResponse: () => json({ places: [{ id: 'unexpected-map-diagnostic' }] }),
    webResults: ({ atlas, beacon, cedar }) => [atlas, cedar, beacon],
  });
  app.nativeImpl.close();
  const options = {
    env: {
      ...app.env,
      BATCH_DB_PATH: join(directory, 'jobs.sqlite'),
      ACQUISITION_DB_PATH: join(directory, 'acquisition.sqlite'),
    },
    fetchImpl: app.fetchImpl,
  };
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(dns, 'lookup', async () => [{ address: '23.37.80.10', family: 4 }]);
  t.mock.method(https, 'request', (url, { headers }, respond) => {
    const request = new EventEmitter();
    request.end = () => {
      const response = Readable.from([
        Buffer.from(html(new URL(url.pathname, `https://${headers.Host}`).href)),
      ]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/html; charset=utf-8' };
      respond(response);
    };
    return request;
  });
  syncBuiltinESMExports();
  let completedId;
  await withApp(options, async (base) => {
    const job = await runMapDiscoveryJob(base, 2);
    assert.deepEqual(googleRequests, []);
    assert.equal(job.status, 'completed');
    assert.equal(job.inserted, 2);
    assert.equal(job.mapComparison, undefined);
    assert.ok(job.searchStats.every(({ maps }) => maps === undefined));
    assert.deepEqual(
      job.rows.map(({ source_url, result }) => [source_url, result]),
      [
        [atlas, 'inserted'],
        ['https://cedar-shades.example.org/', 'review'],
        [beacon, 'inserted'],
      ],
    );
    completedId = job.id;
  });
  await withApp(
    { ...options, fetchImpl: async (url) => assert.fail(`档案读回发起了请求 ${url}`) },
    async (base) => {
      const api = base + '/api/v1';
      assert.equal(
        (await (await fetch(api + '/acquisition/jobs/' + completedId)).json()).inserted,
        2,
      );
      const { leads } = await (await fetch(api + '/leads/real/list')).json();
      assert.deepEqual(leads.map(({ name }) => name).sort(), [
        'Atlas Shades Limited',
        'Beacon Shades Limited',
      ]);
      for (const { id, name } of leads) {
        const { lead } = await (await fetch(api + '/leads/real/' + id)).json();
        assert.deepEqual(
          lead.acquisitionSources.map(({ source_kind, source_url }) => [source_kind, source_url]),
          [['web', name === 'Atlas Shades Limited' ? atlas : beacon]],
        );
      }
    },
  );
});

async function withWebsiteCustodyJob(candidates, pages, target, verify) {
  const researched = [];
  const fetchImpl = async (url, options) => {
    if (url === 'https://api.tavily.com/search')
      return json({
        results: [...candidates].map(([url, { name, identity }]) => ({
          url,
          title: identity || name,
        })),
      });
    if (url === 'https://api.tavily.com/extract') return json({ results: [] });
    if (url === 'https://api.deepseek.com/responses') {
      const request = JSON.parse(options.body);
      const { pages, sources } = JSON.parse(request.input[1].content);
      const source = pages?.find(({ source_url }) => candidates.has(source_url))?.source_url;
      const extraction = () => {
        researched.push(source);
        const { name, identity, supply } = candidates.get(source);
        const evidence = (value, quote) => ({ value, quote, source_url: source });
        return {
          company_name: evidence(name, identity),
          entity_type: evidence('business', supply),
          admission_facts: [evidence('complete_supply', supply)],
          products: [{ ...evidence('blinds', supply), window_use: 'window_covering' }],
        };
      };
      return json({
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(
                  sources
                    ? {
                        result: 'relevant',
                        sources: sources.map(({ i }) => i),
                        reason: '当前文案描述供应窗饰',
                      }
                    : extraction(),
                ),
              },
            ],
          },
        ],
      });
    }
    throw new Error('非隔离端点 ' + url);
  };
  const nativeImpl = new NativeAcquisition({
    env,
    fetchImpl,
    readPage: async ({ href }) => ({ html: pages.get(href) || '' }),
    readScraplingPage: async () => ({ final_url: null, status: 'unavailable' }),
  });
  await withApp({ env, fetchImpl, nativeImpl }, async (base) => {
    const job = await runMapDiscoveryJob(base, target, 'website-custody');
    const { leads } = await (await fetch(base + '/api/v1/leads/real/list')).json();
    verify(job, leads, researched);
  });
}

test('自然搜索中的承包商目录商家档案保持待核实，客户库没有官网错绑', async () => {
  const root = 'https://www.excellentcontractor.com/';
  const profile = root + '71004/window-products-awning-blind-shade-company';
  const name = 'Window Products Awning, Blind & Shade Company';
  const title = name + ' Awning, Blind & Shade Company | Custom Blinds & Awnings in Branford, CT';
  const supply =
    'Our expertise spans blinds, shades, shutters, draperies, and exterior solar solutions, serving residential and commercial clients across the state.';
  const profileHtml = `<title>${title}</title><h1>Custom Window Coverings & Awnings in Branford, CT</h1>
    <p>${supply}</p><a href="/contact?business_id=71004">Contact</a>
    <a href="https://www.windowproductsct.com" rel="nofollow">${name}</a>
    <button data-modal="/modals/review.php?business_id=71004&amp;review_id=0">Write a Review</button>
    <a data-modal="/modals/business-menu.php?business_id=71004">Update<span> Listing</span></a>
    <div>Get in touch with local recommended door and window contractors</div>`;
  const homeHtml = `<title>Compare Local Construction Contractors Near You</title>
    <h1>Compare Local Construction Contractors</h1>
    <p>Browse construction contractor profiles to see which building services are offered locally.
    Examine company details, read customer experiences and contact suitable contractors to discuss your construction project and request an estimate.</p>`;
  const candidates = new Map([[profile, { name, identity: title, supply }]]);
  const pages = new Map([
    [profile, profileHtml],
    [root, homeHtml],
  ]);
  await withWebsiteCustodyJob(candidates, pages, 1, (job, leads, researched) => {
    assert.deepEqual(
      leads.map(({ website }) => website),
      [],
    );
    assert.equal(job.inserted, 0);
    assert.deepEqual(
      job.rows.map(({ source_url, result }) => [source_url, result]),
      [[profile, 'review']],
    );
    assert.match(job.rows[0].reason, /第三方.*独立官网/);
    assert.deepEqual(researched, []);
    assert.deepEqual(
      job.rows[0].collection_attempts
        .filter(({ status }) => status === 'ok')
        .map(({ requested_url }) => requested_url),
      [profile, root],
    );
  });
});

test('经营目录及采购档案待核实，独立官网和带数字与评价的自营产品页分别入库', async () => {
  const directoryRoot = 'https://www.contractorsup.com/';
  const directory = directoryRoot + '140956/';
  const procurement = 'https://buy.nsw.gov.au/supplier/profile/12468764';
  const officialRoot = 'https://www.windowproductsct.com/';
  const official = officialRoot + 'window-products-contact/';
  const productRoot = 'https://shadeatelier.example.org/';
  const product = productRoot + '71004/roller-blind';
  const directoryName = 'Directory Fixture Shades';
  const officialName = 'Window Products, Awning, Blind & Shade Company';
  const productName = 'Shade Atelier';
  const generalSupply =
    'We supply custom roller blinds for residential windows and commercial buildings.';
  const officialSupply = `${officialName} is your source for custom blinds, shades, sheer shades, shutters, draperies, awnings, and more.`;
  const candidates = new Map([
    [directory, { name: directoryName, identity: directoryName, supply: generalSupply }],
    [procurement, { name: 'PAMIDO PTY LTD' }],
    [official, { name: officialName, identity: officialName, supply: officialSupply }],
    [product, { name: productName, identity: productName, supply: generalSupply }],
  ]);
  const pages = new Map([
    [directory, `<h1>${directoryName}</h1><p>${generalSupply}</p>`],
    [
      directoryRoot,
      `<h1>Looking for Remodeling Contractors Near You?</h1>
      <p>Explore remodeling businesses in your area offering home renovations, interior upgrades and property improvements.
      Read customer feedback, check which projects each provider handles and reach out to contractors about estimates and availability.</p>
      <a href="/signup">Add Your Business</a>`,
    ],
    [
      procurement,
      '<h1>PAMIDO PTY LTD</h1><p>This supplier has self-identified in the following products and services.</p>',
    ],
    [
      official,
      `<h1>Contact Window Products Awning Blind &amp; Shade Co Branford CT</h1>
      <p>Our new address: 3 Research Drive, Unit 9, Branford CT 06405</p><p>${officialSupply}</p>`,
    ],
    [
      product,
      `<h1>${productName}</h1><p>${generalSupply}</p>
      <button data-review="/products/review?business_id=71004">Write a Review</button>
      <p>Customer review: Explore independent contractor profiles at your local trade fair.</p>`,
    ],
    [productRoot, `<h1>${productName}</h1><p>Explore our custom roller blind profiles.</p>`],
  ]);
  await withWebsiteCustodyJob(candidates, pages, 2, (job, leads, researched) => {
    assert.deepEqual(leads.map(({ name, website }) => [name, website]).sort(), [
      [productName, product],
      [officialName, official],
    ]);
    assert.equal(job.inserted, 2);
    assert.deepEqual(researched, [official, product]);
    assert.deepEqual(
      job.rows.map(({ source_url, result }) => [source_url, result]),
      [
        [directory, 'review'],
        [procurement, 'review'],
        [official, 'inserted'],
        [product, 'inserted'],
      ],
    );
  });
});

test('地图和官网从同一任务归并主体，门店保留各自来源，无法定位官网的地点待核实', async () => {
  const { app, requests, mapQueries, showroom } = mapDiscoveryFixture();
  await withApp(app, async (base) => {
    const job = await runMapDiscoveryJob(base);
    const api = base + '/api/v1';
    assert.equal(job.inserted, 2, JSON.stringify(job.rows));
    assert.equal(Boolean(job.input.auto_first_touch), false);
    assert.equal(mapQueries[0].query, requests[0]);
    assert.equal(mapQueries[0].country, 'United States');
    const missing = job.rows.find((row) =>
      row.discovery_sources?.some(({ reference }) => reference === 'venue-c'),
    );
    assert.equal(missing?.result, 'review');
    assert.equal(missing.source_url, undefined);
    const { leads } = await (await fetch(api + '/leads/real/list')).json();
    assert.deepEqual(leads.map(({ name }) => name).sort(), [
      'Atlas Shades Limited',
      'Beacon Shades Limited',
    ]);
    for (const { id, name } of leads) {
      const { lead } = await (await fetch(api + '/leads/real/' + id)).json();
      const sources = lead.acquisitionSources.flatMap(({ discovery_sources }) => discovery_sources);
      assert.deepEqual(
        sources.map(({ kind, reference }) => reference || kind).sort(),
        name === 'Atlas Shades Limited' ? ['venue-a', 'venue-a2'] : ['venue-b', 'web'],
      );
    }
    assert.equal(job.rows.find(({ source_url }) => source_url === showroom).result, 'duplicate');
    assert.equal(
      job.rows.find(({ source_url }) => source_url === showroom).research_trace[0].stage,
      'known_subject',
    );
    assert.equal(job.searchStats[0].maps.status, 'completed');
    assert.equal(job.searchStats[0].maps.usage.credits, 3);
    assert.deepEqual(job.mapComparison.qualifiedNew, {
      websiteOnly: 0,
      mapsOnly: 1,
      both: 1,
      mapsAndScrapling: 1,
      scraplingOnly: 0,
    });
  });
});

test('地图错绑待核实并暂停地图，后续独立官网仍可收录', async () => {
  const { app, atlas, mapQueries } = mapDiscoveryFixture({
    lookup: ({ atlas, showroom, sites }) => ({
      places: [
        { id: 'wrong-binding', name: 'Wrong Company Limited', website: atlas },
        { id: 'later-binding', name: sites.get(showroom).name, website: showroom },
      ],
    }),
    webResults: ({ beacon, atlas, search }) => (search === 1 ? [beacon] : [beacon, atlas]),
  });
  await withApp(app, async (base) => {
    const job = await runMapDiscoveryJob(base, 2);
    assert.equal(job.inserted, 2);
    assert.equal(mapQueries.length, 1);
    assert.equal(job.mapComparison.pausedReason, 'binding_mismatch');
    assert.equal(job.searchStats[1].maps.status, 'paused');
    assert.deepEqual(
      job.rows.filter(({ source_url }) => source_url === atlas).map(({ result }) => result),
      ['review', 'inserted'],
    );
    assert.equal(
      job.rows.find(({ maps_binding }) => maps_binding === 'mismatch').record_id,
      undefined,
    );
    const { record_id } = job.rows.find(
      ({ source_url, result }) => source_url === atlas && result === 'inserted',
    );
    const { lead } = await (await fetch(base + '/api/v1/leads/real/' + record_id)).json();
    assert.deepEqual(
      lead.acquisitionSources.flatMap(({ discovery_sources }) =>
        discovery_sources.map(({ kind }) => kind),
      ),
      ['web'],
    );
  });
});

test('地图限流按短等待提示只重试一次，权限不足仅暂停地图', async () => {
  for (const [status, expectedAttempts, expectedMapsStatus, reason] of [
    [429, 2, 'completed', undefined],
    [403, 1, 'unavailable', 'permission_denied'],
  ]) {
    const { app, mapQueries } = mapDiscoveryFixture({
      lookup({ atlas, sites, attempt }) {
        if (attempt === 1)
          throw Object.assign(new Error('供应商敏感内容'), { status, retryAfter: '0' });
        return { places: [{ id: 'verified', name: sites.get(atlas).name, website: atlas }] };
      },
    });
    await withApp(app, async (base) => {
      const job = await runMapDiscoveryJob(base, status === 429 ? 2 : 3);
      assert.equal(job.inserted, status === 429 ? 2 : 1);
      assert.equal(mapQueries.length, expectedAttempts);
      assert.equal(job.searchStats[0].maps.status, expectedMapsStatus);
      assert.equal(job.searchStats[0].maps.attempts, expectedAttempts);
      assert.equal(job.searchStats[0].maps.reason, reason);
      assert.equal(job.rows[0].name, 'Beacon Shades Limited');
      assert.ok(!JSON.stringify(job).includes('供应商敏感内容'));
    });
  }
});

test('地图供应商超时后保留不确定状态，官网正常结束且不重放地图查询', async () => {
  const { app, mapQueries } = mapDiscoveryFixture({ lookup: () => new Promise(() => {}) });
  await withApp(app, async (base) => {
    const job = await runMapDiscoveryJob(base);
    assert.equal(job.inserted, 1);
    assert.equal(job.rows[0].name, 'Beacon Shades Limited');
    assert.equal(job.searchStats[0].maps.status, 'failed');
    assert.equal(job.mapComparison.pausedReason, 'request_unknown');
    assert.equal(mapQueries.length, 1);
  });
});

test('Google 配置只读地点编号，供应商夹带的名称、网站和原始响应不会进入候选或客户档案', async () => {
  for (const flag of [undefined, 'true']) {
    const { app, googleRequests } = mapDiscoveryFixture({
      mapSettings: { GOOGLE_PLACES_API_KEY: 'fixture-places-key', GOOGLE_PLACES_IDS_ONLY: flag },
      googleResponse: () =>
        json({
          places: [
            {
              id: 'google-identifier',
              displayName: 'unlicensed label',
              websiteUri: 'https://never-store.example.org',
            },
          ],
        }),
    });
    await withApp(app, async (base) => {
      const job = await runMapDiscoveryJob(base, 1);
      assert.equal(job.inserted, 1);
      assert.equal(job.rows[0].name, 'Beacon Shades Limited');
      assert.equal(job.searchStats[0].maps.status, flag ? 'identifiers_only' : 'unavailable');
      assert.equal(job.searchStats[0].maps.reason, 'website_mapping_unavailable');
      assert.equal(googleRequests.length, flag ? 1 : 0);
      if (flag) {
        assert.equal(googleRequests[0].headers['X-Goog-FieldMask'], 'places.id');
        assert.equal(googleRequests[0].redirect, 'error');
      }
      assert.doesNotMatch(JSON.stringify(job), /unlicensed label|never-store|fixture-places-key/);
      const { lead } = await (
        await fetch(base + '/api/v1/leads/real/' + job.rows[0].record_id)
      ).json();
      assert.equal(lead.acquisitionSources[0].source_kind, 'web');
      assert.equal(lead.acquisitionSources[0].discovery_sources, undefined);
    });
  }
});

test('地图和官网均拒绝无法从原文核对的模型身份引文', async () => {
  const { app } = mapDiscoveryFixture({ fakeIdentity: true });
  await withApp(app, async (base) => {
    const job = await runMapDiscoveryJob(base);
    assert.equal(job.inserted, 0);
    assert.deepEqual(
      job.rows.filter(({ source_url }) => source_url).map(({ result }) => result),
      ['review', 'review', 'review'],
    );
    const { leads } = await (await fetch(base + '/api/v1/leads/real/list')).json();
    assert.deepEqual(leads, []);
  });
});

test('全球目标跨过六小时和两百家批次，末位只确认一次且读回同一任务', async (t) => {
  const start = Date.parse('2030-01-03T08:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: start });
  const directory = mkdtempSync(join(tmpdir(), 'unified-batch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const isolated = {
    ...env,
    BATCH_DB_PATH: join(directory, 'jobs.sqlite'),
    ACQUISITION_DB_PATH: join(directory, 'acquisition.sqlite'),
  };
  const sites = Array.from({ length: 207 }, (_, index) => {
    const name = 'Sample Window Business ' + (index + 100);
    const url = 'https://sample-' + (index + 100) + '.example.org/';
    const retailer = index === 19;
    const country = index === 0 ? 'France' : '';
    const quote =
      index === 2
        ? name + ' is my personal blog about choosing roller blinds for the windows in my own home.'
        : name +
          (retailer
            ? ' is a window covering retailer. We sell and install '
            : ' imports and distributes ') +
          'made-to-measure roller blinds for building windows' +
          (country ? ' across France.' : '.');
    return { url, name, quote, country, retailer, individual: index === 2 };
  });
  const fixtureByUrl = new Map(sites.map((row) => [row.url, row]));
  const f = fixture();
  let offset = 0;
  const paidQueries = [];
  const modelResponse = (data, usage) =>
    json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
      usage,
    });
  const fetchImpl = async (url, options) => {
    if (url === 'https://api.tavily.com/search') {
      paidQueries.push(JSON.parse(options.body).query);
      const next = sites.slice(offset, offset + 19);
      if (offset) next.unshift(sites[0]);
      offset += 19;
      return json({ results: next.map(({ url, name }) => ({ url, title: name })) });
    }
    if (url === 'https://api.deepseek.com/responses') {
      const { pages, sources } = JSON.parse(JSON.parse(options.body).input[1].content);
      if (sources)
        return modelResponse({
          result: 'relevant',
          sources: sources.map(({ i }) => i),
          reason: 'fixture',
        });
      const source = fixtureByUrl.get(pages[0].source_url);
      const evidence = (value) => ({ value, quote: source.quote, source_url: source.url });
      if (source === sites[0]) t.mock.timers.setTime(start + 6 * 60 * 60 * 1000);
      return modelResponse(
        {
          company_name: evidence(source.name),
          entity_type: evidence(source.individual ? 'individual' : 'business'),
          actual_country: source.country ? evidence(source.country) : null,
          customer_type: evidence(source.retailer ? 'retailer' : 'distributor'),
          admission_facts: source.individual ? [] : [evidence('complete_supply')],
          products: [{ ...evidence('roller blinds'), window_use: 'window_covering' }],
        },
        {
          input_tokens: 20,
          output_tokens: 7,
          input_tokens_details: { cached_tokens: 11 },
          total_tokens: 27,
        },
      );
    }
    return f.fetchImpl(url, options);
  };
  const make = () =>
    f.make({
      env: isolated,
      fetchImpl,
      readPage: async ({ href }) => ({ html: '<p>' + fixtureByUrl.get(href)?.quote + '</p>' }),
    });
  const payload = {
    ...input,
    country: 'worldwide',
    product: 'window coverings',
    product_scope: 'all',
    customer_types: ['manufacturer'],
    target_count: 203,
  };
  let jobId;
  const firstService = make();
  let finalWrites = 0;
  await withApp({ env: isolated, nativeImpl: firstService, fetchImpl }, async (origin) => {
    const archive = firstService.feishu;
    const write = archive.write.bind(archive);
    archive.write = async (...args) => {
      const result = await write(...args);
      if (args[4]?.source_url === sites[203].url && ++finalWrites === 1)
        throw new Error('最后一家已写入，响应丢失');
      return result;
    };
    const api = origin + '/api/v1/acquisition/jobs';
    const submit = () =>
      fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'cross-batch-target' },
        body: JSON.stringify(payload),
      });
    const acknowledgments = await Promise.all([submit(), submit()]);
    assert.deepEqual(
      acknowledgments.map((response) => response.status),
      [202, 202],
    );
    const [firstId, replayId] = await Promise.all(
      acknowledgments.map(async (response) => (await response.json()).id),
    );
    assert.equal(firstId, replayId);
    jobId = firstId;
    assert.equal((await (await submit()).json()).id, jobId);
    let job;
    for (let attempt = 0; attempt < 1200; attempt++) {
      ({
        jobs: [job],
      } = await (await fetch(api + '?summary=1')).json());
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.deepEqual(
      [job.id, job.status, job.reason, job.inserted, job.pending, job.batch.number],
      [jobId, 'paused', 'write_uncertain', 202, 1, 3],
      '最后一家写入尝试次数：' + finalWrites,
    );
    assert.equal(
      (await (await fetch(origin + '/api/v1/leads/real/list')).json()).leads.length,
      203,
    );
  });
  await withApp({ env: isolated, nativeImpl: make(), fetchImpl }, async (origin) => {
    const api = origin + '/api/v1';
    const url = api + '/acquisition/jobs/' + jobId;
    const continueJob = () => fetch(url + '/resume', { method: 'POST' });
    await Promise.all([continueJob(), continueJob()]);
    let job;
    for (let attempt = 0; attempt < 200; attempt++) {
      job = await (await fetch(url)).json();
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      job.status,
      'completed',
      JSON.stringify({ reason: job.reason, inserted: job.inserted, first: job.rows.slice(0, 3) }),
    );
    assert.deepEqual(
      [job.target, job.inserted, job.remainingTarget, job.confirmedInserted, job.reason],
      [203, 203, 0, 203, 'target_reached'],
    );
    assert.equal(job.admissionVersion, 'website-admission-v1');
    assert.equal(job.identityVersion, 'registered-operator-v1');
    assert.equal(job.batch.number, 3);
    assert.deepEqual(job.coverage.languages.slice(0, 2), ['en', 'es']);
    assert.ok(job.coverage.countries.includes('France'));
    assert.match(paidQueries[0], /manufacturer/);
    assert.ok(paidQueries.some((query) => /persianas|estores/.test(query)));
    assert.equal(job.rows.filter((row) => row.result === 'rejected').length, 1);
    assert.equal(
      new Set(job.rows.filter((row) => row.capture).map((row) => row.capture.record_id)).size,
      203,
    );
    assert.equal(job.researchUsage.input_cached_tokens, 2244);
    assert.equal(job.researchUsage.total_tokens, 5508);
    assert.equal(finalWrites, 1);
    const { leads } = await (await fetch(api + '/leads/real/list')).json();
    const expected = sites.slice(0, 204).filter(({ individual }) => !individual);
    assert.deepEqual(
      leads.map(({ website }) => website).sort(),
      expected.map(({ url }) => url).sort(),
    );
    const french = leads.find(({ website }) => website === sites[0].url);
    const unknown = leads.find(({ website }) => website === sites[19].url);
    const unknownRow = job.rows.find(({ source_url }) => source_url === sites[19].url);
    assert.equal(
      job.searchStats.find(({ id }) => id === unknownRow.search_id).country,
      'United States',
    );
    assert.equal(french.market, 'France');
    assert.equal(unknown.market, '待核实');
  });
});

test('到期的全球计划收录美国和法国的窗饰商，同样输入的美国计划只收录美国企业', async (t) => {
  t.mock.timers.enable({
    apis: ['Date', 'setInterval'],
    now: Date.parse('2030-01-01T08:59:50+08:00'),
  });
  const fixtures = new Map([
    [
      'https://mesa-window.example.org/',
      {
        name: 'Mesa Window Supply',
        country: 'United States',
        quote:
          'Mesa Window Supply imports and supplies complete outdoor zip screens for building windows to dealers across the United States.',
      },
    ],
    [
      'https://lyon-window.example.org/',
      {
        name: 'Lyon Window Supply',
        country: 'France',
        quote:
          'Lyon Window Supply imports and supplies complete outdoor zip screens for building windows to dealers across France.',
      },
    ],
    [
      'https://coast-tours.example.org/',
      {
        name: 'Coast Tours',
        quote: 'Coast Tours offers guided hiking holidays and coach tours along the coast.',
      },
    ],
  ]);
  const localEnv = { TAVILY_API_KEY: 'fixture-search', DEEPSEEK_API_KEY: 'fixture-model' };
  const expectedByScope = [
    ['worldwide', 'Asia/Shanghai', ['France', 'United States'], '"zip screens" supplier'],
    [
      'United States',
      'America/New_York',
      ['United States'],
      '"zip screens" supplier United States',
    ],
  ];
  for (const [country, timezone, expected, firstQuery] of expectedByScope) {
    const utcTime = timezone === 'Asia/Shanghai' ? '01:00' : '14:00';
    t.mock.timers.setTime(Date.parse(`2030-01-01T${utcTime}:00Z`) - 10000);
    const queries = [];
    const fetchImpl = async (url, options) => {
      const request = JSON.parse(options.body);
      if (url === 'https://api.tavily.com/search') {
        queries.push(request.query);
        return json({ results: [...fixtures.keys()].map((url) => ({ url })) });
      }
      assert.equal(url, 'https://api.deepseek.com/responses');
      const payload = JSON.parse(request.input[1].content);
      let output;
      if (payload.sources) {
        output = {
          result: 'relevant',
          sources: payload.sources.map(({ i }) => i),
          reason: '窗饰供货',
        };
      } else {
        const source_url = payload.pages[0].source_url;
        const { name, country, quote } = fixtures.get(source_url);
        assert.ok(payload.pages[0].text.includes(quote));
        const fact = (value) => ({ value, quote, source_url });
        output = {
          company_name: fact(name),
          entity_type: fact('business'),
          actual_country: fact(country),
          customer_type: fact('distributor'),
          production_model: fact('no_own_factory'),
          operating_model: fact('beyond_local'),
          main_product_preference: fact('户外窗用卷帘'),
          products: country ? [{ ...fact('zip screens'), window_use: 'window_covering' }] : [],
          admission_facts: [fact(country ? 'complete_supply' : 'unrelated_operator')],
        };
      }
      return json({
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
      });
    };
    const native = new NativeAcquisition({
      env: localEnv,
      fetchImpl,
      readPage: async (url) => ({ html: `<p>${fixtures.get(url.href).quote}</p>` }),
    });
    await withApp({ env: localEnv, nativeImpl: native, fetchImpl }, async (base) => {
      const request = async (path, body) => {
        const response = await fetch(
          base + path,
          body && {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'scope-once-2030' },
            body: JSON.stringify(body),
          },
        );
        const data = await response.json();
        assert.ok(response.ok, JSON.stringify(data));
        return data;
      };
      const schedulesPath = '/api/v1/acquisition/schedules';
      const archivePath = '/api/v1/leads/real/list?page=1';
      const { leads: before } = await request(archivePath);
      assert.deepEqual(before, []);
      const saved = await request(schedulesPath, {
        name: 'Scope test',
        input: {
          country,
          product: 'zip screens',
          query_mode: 'auto',
          target_count: country === 'worldwide' ? 203 : 3,
        },
        timing: { repeat: 'once', startDate: '2030-01-01', times: ['09:00'], timezone },
      });
      const {
        schedules: [plan],
      } = await request(schedulesPath + '?summary=1');
      assert.equal(plan.id, saved.id);
      assert.equal(plan.input.country, country);
      assert.deepEqual(
        plan.input.market_countries,
        country === 'worldwide' ? [] : ['United States'],
      );
      assert.equal(plan.timing.timezone, timezone);
      assert.equal(plan.nextRunAt, `2030-01-01T${utcTime}:00.000Z`);
      assert.deepEqual(queries, []);
      t.mock.timers.tick(15000);
      const {
        schedules: [triggered],
      } = await request(schedulesPath + '?summary=1');
      assert.equal(triggered.runs, 1);
      assert.equal(triggered.status, 'completed');
      let job;
      for (let i = 0; i < 200; i++) {
        job = await request('/api/v1/acquisition/jobs/' + triggered.lastJobId);
        if (job.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(job.status, 'partial', JSON.stringify(job.rows));
      assert.equal(job.input.country, country);
      assert.equal(job.reason, 'exhausted');
      assert.equal(job.remainingTarget, country === 'worldwide' ? 201 : 2);
      assert.equal(job.admissionVersion, 'website-admission-v1');
      assert.equal(job.inserted, expected.length, JSON.stringify(job.rows));
      assert.equal(job.searchStats[0].query, firstQuery);
      assert.equal(queries[0], firstQuery);
      if (country === 'worldwide') {
        assert.doesNotMatch(queries[0], /United States|France/i);
        assert.ok(queries.some((query) => /United States|France/i.test(query)));
        assert.ok(queries.every((query) => !/worldwide|所有国家/i.test(query)));
      }
      const { leads } = await request(archivePath);
      assert.deepEqual(leads.map((lead) => lead.market).sort(), expected);
      assert.deepEqual(
        leads.map(({ name, website }) => [name, website]).sort(),
        [...fixtures]
          .filter(([, item]) => expected.includes(item.country))
          .map(([url, { name }]) => [name, url])
          .sort(),
      );
    });
  }
});

test('两个到期任务等待浏览器时，官网直读任务独立完成并保留各自新增归属', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2030-01-01T00:59:50Z') });
  const localEnv = { TAVILY_API_KEY: 'fixture-search', DEEPSEEK_API_KEY: 'fixture-model' };
  const fixtures = [
    {
      country: 'United States',
      name: 'Mesa Window Supply',
      url: 'https://mesa-browser.example.org/',
    },
    {
      country: 'Canada',
      name: 'Harbour Window Supply',
      url: 'https://harbour-browser.example.org/',
    },
    {
      country: 'Australia',
      name: 'Canyon Window Supply',
      url: 'https://canyon-direct.example.org/',
      direct: true,
    },
  ];
  const quote = ({ country, name }) =>
    name +
    ' distributes and installs complete roller blinds for building windows in ' +
    country +
    '.';
  const html = (source) => '<p>' + quote(source) + '</p>';
  const byUrl = new Map(fixtures.map((source) => [source.url, source]));
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    if (url === 'https://api.tavily.com/search') {
      const source = fixtures.find(({ country }) => request.query.includes(country));
      return json({ results: source ? [{ url: source.url, title: source.name }] : [] });
    }
    if (url === 'https://api.tavily.com/extract')
      return json({
        results: request.urls.map((url) => ({ url, raw_content: html(byUrl.get(url)) })),
      });
    assert.equal(url, 'https://api.deepseek.com/responses');
    const { pages, sources } = JSON.parse(request.input[1].content);
    let result;
    if (sources)
      result = { result: 'relevant', sources: sources.map(({ i }) => i), reason: 'fixture' };
    else {
      const source = byUrl.get(pages[0].source_url);
      const fact = (value) => ({ value, quote: quote(source), source_url: source.url });
      result = {
        company_name: fact(source.name),
        entity_type: fact('business'),
        actual_country: fact(source.country),
        admission_facts: [fact('complete_supply')],
        products: [{ ...fact('roller blinds'), window_use: 'window_covering' }],
      };
    }
    return json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
    });
  };
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let memory = 2 * 1024 ** 3;
  const browserReads = [];
  const native = new NativeAcquisition({
    env: localEnv,
    fetchImpl,
    readPage: async ({ href }) => ({
      html: byUrl.get(href).direct
        ? html(byUrl.get(href))
        : '<noscript>Enable JavaScript</noscript>',
    }),
    readScraplingPage: (url, options) =>
      collectScraplingPage(url, {
        ...options,
        python: process.execPath,
        availableMemoryImpl: () => memory,
        async readResourceImpl() {
          browserReads.push(url);
          if (browserReads.length === 1) await held;
          return { status: 503 };
        },
      }),
  });
  await withApp({ env: localEnv, nativeImpl: native, fetchImpl }, async (origin) => {
    const api = origin + '/api/v1';
    try {
      for (const { country, name } of fixtures) {
        const response = await fetch(api + '/acquisition/schedules', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'collector-' + country.replace(' ', '-'),
          },
          body: JSON.stringify({
            name,
            input: { country, product: 'roller blinds', query_mode: 'auto', target_count: 1 },
            timing: {
              repeat: 'once',
              startDate: '2030-01-01',
              times: ['09:00'],
              timezone: 'Asia/Shanghai',
            },
          }),
        });
        assert.equal(response.status, 201);
      }
      t.mock.timers.tick(15000);
      const waitJobs = async (condition) => {
        for (let attempt = 0; attempt < 160; attempt++) {
          const { jobs } = await (await fetch(api + '/acquisition/jobs')).json();
          if (condition(jobs)) return jobs;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail('未达到任务预期状态');
      };
      const whileQueued = await waitJobs(
        (jobs) =>
          jobs.some(({ collectionWait }) => collectionWait?.reason === 'browser_busy') &&
          jobs.some(({ input, status }) => input.country === 'Australia' && status === 'completed'),
      );
      const direct = whileQueued.find(({ input }) => input.country === 'Australia');
      assert.deepEqual(
        direct.rows[0].collection_attempts.map(({ method }) => method),
        ['node'],
      );
      assert.equal(browserReads.length, 1);
      memory = 0;
      release();
      const scarce = await waitJobs((jobs) =>
        jobs.some(({ collectionWait }) => collectionWait?.reason === 'low_memory'),
      );
      const delayed = scarce.find(({ collectionWait }) => collectionWait?.reason === 'low_memory');
      assert.equal(browserReads.length, 1);
      memory = 2 * 1024 ** 3;
      const finished = await waitJobs(
        (jobs) => jobs.length === 3 && jobs.every(({ status }) => status === 'completed'),
      );
      assert.equal(browserReads.length, 2);
      const recovered = finished.find(({ id }) => id === delayed.id);
      assert.equal(
        recovered.rows[0].collection_attempts.find(({ method }) => method === 'scrapling')
          .resource_wait.reason,
        'low_memory',
      );
      assert.ok(
        finished.every(({ id, rows, inserted }) => inserted === 1 && rows[0].capture.job_id === id),
      );
      assert.deepEqual(
        (await (await fetch(api + '/leads/real/list')).json()).leads.map(({ name }) => name).sort(),
        fixtures.map(({ name }) => name).sort(),
      );
    } finally {
      memory = 2 * 1024 ** 3;
      release();
    }
  });
});

for (const [name, quote, result] of [
  ['Simulation Studio', 'We sell a Roller Blinds asset pack for virtual worlds.', 'unrelated'],
  [
    'Exhibit Studio',
    'Our Pergola collection is a line of scale models for tabletop games.',
    'unrelated',
  ],
  [
    'East Shades',
    'The Guild lists East Shades among member suppliers of Roller Blinds.',
    'unrelated',
  ],
  [
    'Vista Studio',
    'A portfolio site showcases Vista Studio and its Roller Blinds work.',
    'unrelated',
  ],
  ['Catalog Studio', 'Our new collection is called Pergola.', 'uncertain'],
]) {
  test('独立模型复核阻止入库：' + name, async () => {
    const identity = name + ' is a distributor serving clients in Malaysia.';
    const f = fixture({
      pageText: identity + ' ' + quote,
      automaticAssessment: true,
      modelOverrides: {
        company_name: policyFact(name, identity),
        entity_type: policyFact('business', identity),
        products: [policyFact(quote.includes('Roller') ? 'Roller Blinds' : 'Pergola', quote)],
      },
      activityDecision: {
        result,
        sources: result === 'uncertain' ? [] : [0],
        reason: '未证实经营建筑窗饰',
      },
    });
    const svc = f.make();
    try {
      await svc.research(
        {
          ...input,
          country: 'Malaysia',
          market_countries: ['Malaysia'],
          product_scope: 'all',
          product: 'window coverings',
          query_mode: 'auto',
        },
        { source_url: site, operation_id: 'activity-proof' },
      );
      assert.equal(f.records.length, 0);
      const check = f.calls.find((c) => c.body?.text?.format?.schema?.properties?.sources);
      const { company } = JSON.parse(check.body.input[1].content);
      assert.equal(company.name, name);
      assert.equal(company.website, site);
      assert.ok(company.identity_evidence.some((e) => e.quote === identity));
      assert.ok(company.homepage.includes(quote));
    } finally {
      svc.close();
    }
  });
}

for (const [name, catalog, expected, pageContext = ''] of [
  [
    'Mumtaz Energy',
    [
      [
        'Line Blanks (Spectacle Blinds, Spades, Spacers)',
        'We offer a comprehensive range of line blanks, including Spectacle Blinds (Figure-8 Blanks), Spades and Spacers.',
      ],
    ],
    null,
  ],
  [
    'Wildlife Supply',
    [
      [
        'Observation blinds',
        'We supply observation blinds for wildlife photographers and professional ornithologists.',
      ],
    ],
    null,
  ],
  [
    'Optical Supply',
    [['Shutters', 'Our beam shutters control exposure in laboratory instruments.']],
    null,
  ],
  [
    'Caravan Awning Supplier',
    [
      [
        'Caravan and RV awnings, including rollout awnings and cassette awnings',
        'Specialising in Awnings, Annexes, and a comprehensive range of Caravan and RV components and accessories',
      ],
    ],
    null,
  ],
  [
    'Industrial Track Supplier',
    [
      [
        'Industrial curtain tracks',
        'We supply industrial curtain tracks and hardware for factory partitions.',
      ],
    ],
    null,
  ],
  [
    'Mixed Awning Supplier',
    [
      ['Cassette awnings', 'Our cassette awnings are made for caravans and motorhomes.'],
      ['Patio awnings', 'We install folding arm patio awnings for residential patios.'],
    ],
    'Patio awnings',
  ],
  ['Room Decor', [['Blinds', 'We fit made-to-measure blinds for bedroom windows.']], 'Blinds'],
  [
    'Accessory Dealer',
    [['Awning spare parts', 'Awning Spare Parts 43 Products']],
    null,
    'We specialise in equipment for caravans and motorhomes.',
  ],
  [
    'Healthcare Window Supplier',
    [
      [
        'Window treatments and window draperies',
        'We supply hospital cubicle curtains, window treatments and other textile decorative products.',
      ],
    ],
    'Window treatments and window draperies',
  ],
  [
    'Mixed Supply',
    [
      ['Spectacle Blinds', 'We supply spectacle blinds for industrial piping.'],
      ['Roman blinds', 'We install Roman blinds for residential windows.'],
    ],
    'Roman blinds',
  ],
]) {
  test('按产品用途核实获客并读回客户档案：' + name, async () => {
    const identity = name + ' is an independent distributor serving customers across Malaysia.';
    const f = fixture({
      pageText: [identity, pageContext, ...catalog.map(([, quote]) => quote)].join(' '),
      automaticAssessment: true,
      modelOverrides: {
        company_name: policyFact(name, identity),
        entity_type: policyFact('business', identity),
        products: catalog.map(([value, quote]) => policyFact(value, quote)),
      },
    });
    const svc = f.make();
    try {
      const output = await svc.research(
        {
          ...input,
          country: 'Malaysia',
          market_countries: ['Malaysia'],
          product_scope: 'all',
          product: 'window coverings',
          query_mode: 'auto',
        },
        { source_url: site, operation_id: 'verify-window-application' },
      );
      assert.equal(f.records.length, expected ? 1 : 0, output.reason);
      if (expected) {
        assert.equal(f.records[0].fields.客户名称, name);
        assert.deepEqual(
          svc
            .assessmentHistory(f.records[0].record_id)
            .assessment.opportunities.map((o) => o.product),
          [expected],
        );
      }
    } finally {
      svc.close();
    }
  });
}

test('独立企业保留，目录的根域名及子域名在研究前过滤', () => {
  const hosts = [
    'cdn.canpages.ca',
    'mobile.yp.ca',
    'loc8nearme.com',
    'ottawa.infoisinfo-ca.com',
    'go4worldbusiness.com',
    'sarabella.ca',
    'notcanpages.ca',
  ];
  const selected = selectWebsiteCandidates(hosts.map((host) => ({ url: `https://${host}/` })));
  assert.equal(selected.filtered_sources.length, 5);
  assert.deepEqual(
    selected.candidates.map((item) => item.domain),
    ['sarabella.ca', 'notcanpages.ca'],
  );
});

test('精简后的中部经营证据贯通研究、初评、模拟写入及读回，统计实际节省字符', async () => {
  const f = fixture({
    pageText:
      '<nav>' +
      '<p>Home Products About Contact</p>'.repeat(500) +
      '</nav><p>' +
      sourceText +
      '</p><footer>' +
      '<p>Cookie settings and website policy information.</p>'.repeat(450) +
      '</footer>',
    modelOverrides: { actual_country: policyFact('United States', sourceText) },
    automaticAssessment: true,
  });
  const svc = f.make();
  try {
    const result = await svc.research(input, {
      source_url: site,
      operation_id: 'compacted-insert',
    });
    assert.equal(result.新增, 1);
    assert.equal(result.research.company_name, 'Acme Screens');
    assert.equal(result.research.product_match, 'matched');
    assert.equal(result.research.actual_country, 'United States');
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].fields.邮箱, 'sales@acme.example.org');
    const op = svc.store.get('compacted-insert');
    const sent = JSON.parse(
      f.calls.find((call) => call.url.includes('deepseek')).body.input[1].content,
    ).pages;
    assert.deepEqual(sent, op.research_pages);
    assert.ok(result.research_usage.original_chars > 30000);
    assert.ok(result.research_usage.compacted_chars > 30000);
    const review = f.calls.find((call) => call.body?.text?.format?.schema?.properties?.sources);
    assert.ok(result.research_usage.input_chars - review.body.input[1].content.length < 1500);
    assert.ok(result.research_usage.input_chars < result.research_usage.original_chars / 10);
    assert.ok(result.assessment || op.assessment);
  } finally {
    svc.close();
  }
});

for (const [product_scope, country] of [
  ['all', 'United States'],
  ['specific', 'United States'],
  ['all', 'worldwide'],
]) {
  test(`${country} 的 ${product_scope} 范围内，相关企业国家未知仍入库，核实后归入实际市场`, async () => {
    const modelOverrides = { actual_country: null };
    const f = fixture({ modelOverrides, automaticAssessment: true });
    const svc = f.make();
    const target = { ...input, country, product_scope, query_mode: 'auto' };
    try {
      const output = await svc.research(target, {
        source_url: site,
        operation_id: `unknown-country-${product_scope}`,
      });
      assert.equal(output.新增, 1);
      assert.equal(output.outcome, 'completed');
      assert.equal(output.research.actual_country, null);
      assert.equal(output.research.country_match, 'unknown');
      assert.equal(f.records[0].fields.国家, undefined);
      assert.equal(mapFeishuRecord(f.records[0]).market, '待核实');

      modelOverrides.actual_country = policyFact('United States', sourceText);
      svc.readPage = async (url) => {
        const page = await f.readPage(url);
        return { ...page, html: page.html + '<p>Our operating country is United States.</p>' };
      };
      const refreshed = await svc.research(target, {
        source_url: site,
        target_record_id: 'rec-native',
        operation_id: `confirmed-country-${product_scope}`,
      });
      assert.equal(refreshed.更新, 1);
      assert.equal(refreshed.新增, 0);
      assert.equal(f.records.length, 1);
      assert.equal(mapFeishuRecord(f.records[0]).market, 'United States');
    } finally {
      svc.close();
    }
  });
}

test('两个市场同时遇到同一官网时，只有一个写入和一次新增', async () => {
  const f = fixture();
  const svc = f.make();
  try {
    const [first, second] = await Promise.all([
      svc.research(input, { source_url: site, operation_id: 'shared-company-us' }),
      svc.research(
        { ...input, country: 'Canada', query_mode: 'auto' },
        { source_url: site, operation_id: 'shared-company-ca' },
      ),
    ]);
    assert.equal(first.新增, 1);
    assert.equal(second.outcome, 'no_new_candidates');
    assert.equal(f.records.length, 1);
    assert.equal(f.calls.filter((call) => call.url.endsWith('/responses')).length, 2);
  } finally {
    svc.close();
  }
});

test('客户已入库但最新评估保存失败时可恢复，恢复不重复研究或写客户', async () => {
  const f = fixture({ automaticAssessment: true });
  const svc = f.make();
  const save = svc.assessments.save.bind(svc.assessments);
  let failOnce = true;
  svc.assessments.save = (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('storage unavailable');
    }
    return save(...args);
  };
  const item = { source_url: site, operation_id: 'current-assessment-recovery-1' };
  try {
    await assert.rejects(() => svc.research(input, item), /最新评估保存待核对/);
    const settled = await svc.status(item.operation_id);
    assert.equal(settled.settled, true);
    assert.equal(settled.output.新增, 1);
    assert.equal(svc.assessmentHistory('rec-native').assessments.length, 1);
    assert.equal(f.calls.filter((call) => call.url.endsWith('/responses')).length, 2);
    assert.equal(
      f.calls.filter((call) => call.method === 'POST' && call.url.includes('/records')).length,
      1,
    );
  } finally {
    svc.close();
  }
});

test('仅有T2也能完成自动评分和入库，评估只存后台最新值且不访问历史表', async () => {
  const f = fixture({ automaticAssessment: true });
  const svc = f.make();
  const item = { source_url: site, operation_id: 'current-assessment-only-1' };
  try {
    const result = await svc.research(input, item);
    assert.equal(result.新增, 1);
    assert.ok(f.records[0].fields.用户评级);
    const current = svc.assessmentHistory('rec-native');
    assert.equal(current.assessments.length, 1);
    assert.equal(current.assessment.id, result.assessment.id);
    assert.equal(current.assessment.sync, undefined);
    assert.equal(result.assessment.matchLevel, current.assessment.matchLevel);
    assert.deepEqual(result.assessment.prioritySignals, current.assessment.prioritySignals);
    const dossier = svc.decorateLeads({ leads: [mapFeishuRecord(f.records[0])] }).leads[0];
    assert.equal(dossier.assessment.matchLevel, current.assessment.matchLevel);
    assert.deepEqual(dossier.assessment.prioritySignals, current.assessment.prioritySignals);
    assert.equal(svc.assessmentInfo().assessmentStorage, 'latest_only');
    assert(
      f.calls
        .filter((call) => call.url.includes('/bitable/'))
        .every((call) => call.url.includes('/tables/test-table/')),
    );
    assert.equal(
      f.calls.filter((call) => call.method === 'POST' && call.url.includes('/records')).length,
      1,
    );
    const before = f.calls.length;
    assert.deepEqual(await svc.research(input, item), result);
    assert.equal(f.calls.length, before);
  } finally {
    svc.close();
  }
});

test('新名称字段贯通研究、飞书写入读回和持久身份资料', async () => {
  const f = fixture({ companyNameField: '公司名称' });
  const svc = f.make();
  try {
    const output = await svc.research(input, {
      source_url: site,
      operation_id: 'company-name-renamed-01',
    });
    assert.equal(output.新增, 1);
    assert.equal(f.records[0].fields['公司名称'], 'Acme Screens');
    assert.equal(f.records[0].fields['客户名称'], undefined);
    const identity = svc.store.companyIdentity('rec-native', site, 'Acme Screens');
    assert.equal(identity.website_name, 'Acme Screens');
    assert.equal(identity.legal_name, null);
  } finally {
    svc.close();
  }
});

for (const [scenarioIndex, scenario] of [
  {
    name: '个人装修求购账号，即使有公司名也淘汰',
    text: 'I am John Smith, a homeowner looking for zip screens for my own house. This is a personal consumer account, not a trading business.',
    fields: {
      entity_type: 'individual',
      production_model: 'unknown',
      operating_model: 'unknown',
      audience: 'C',
    },
    code: 'individual_consumer',
  },
  {
    name: '同属窗饰行业但目标品类不符',
    text: 'Acme Screens imports Roman blinds from other factories and sells them nationwide. We do not own a factory.',
    fields: {},
    products: ['Roman blinds'],
    productMismatch: true,
  },
  { name: '缺少主体证据', fields: { entity_type: null }, code: 'entity_unknown' },
].entries()) {
  test('明确硬冲突不新增飞书：' + scenario.name, async () => {
    const quote = scenario.text || sourceText;
    const facts = Object.fromEntries(
      Object.entries({
        entity_type: 'business',
        production_model: 'no_own_factory',
        operating_model: 'beyond_local',
        ...scenario.fields,
      }).map(([key, value]) => [key, value === null ? null : policyFact(value, quote)]),
    );
    const f = fixture({
      pageText: quote,
      modelOverrides: {
        ...facts,
        company_name: policyFact('Acme Screens', quote),
        products: (scenario.products || ['zip screens']).map((p) => policyFact(p, quote)),
        manufactured_products: [],
        profile_tags: ['trade'].map((p) => policyFact(p, quote)),
      },
    });
    const svc = f.make();
    try {
      const output = await svc.research(
        { ...input, ...scenario.target },
        { source_url: site, operation_id: 'policy-blocked-' + scenarioIndex },
      );
      assert.equal(output.新增, 0);
      assert.equal(output.更新, 0);
      assert.equal(output.research.ok, false);
      if (scenario.code === 'entity_unknown') {
        assert.equal(output.outcome, 'review');
        assert.equal(output.research.eligibility.code, scenario.code);
      } else {
        assert.equal(output.outcome, 'rejected');
        assert.ok(output.research.eligibility || output.research.product_match === 'not_matched');
        const stored = svc.store.get('policy-blocked-' + scenarioIndex);
        assert.equal(stored.input.item.source_url, site);
        assert.equal(stored.research_pages, undefined);
        assert.equal(stored.research_response, undefined);
      }
      assert.equal(
        f.calls.some((c) => c.url.includes('/records') && ['POST', 'PUT'].includes(c.method)),
        false,
      );
    } finally {
      svc.close();
    }
  });
}

test('工厂、本地服务和经营范围未知不再构成全局淘汰', async () => {
  for (const [index, scenario] of [
    {
      text: 'Acme Screens manufactures zip screens in our own factory and supplies dealers in the United States.',
      fields: { production_model: 'own_factory', customer_type: 'manufacturer' },
      manufactured: ['zip screens'],
    },
    {
      text: 'Acme Screens installs imported zip screens for local homeowners in Florida, United States.',
      fields: { operating_model: 'local_only', customer_type: 'service_provider', audience: 'C' },
    },
    { text: sourceText, fields: { production_model: null, operating_model: null } },
  ].entries()) {
    const facts = Object.fromEntries(
      Object.entries({
        entity_type: 'business',
        production_model: 'no_own_factory',
        operating_model: 'beyond_local',
        ...scenario.fields,
      }).map(([key, value]) => [key, value === null ? null : policyFact(value, scenario.text)]),
    );
    const f = fixture({
      pageText: scenario.text,
      modelOverrides: {
        ...facts,
        company_name: policyFact('Acme Screens', scenario.text),
        products: [policyFact('zip screens', scenario.text)],
        manufactured_products: (scenario.manufactured || []).map((p) =>
          policyFact(p, scenario.text),
        ),
      },
    });
    const svc = f.make();
    try {
      const output = await svc.research(input, {
        source_url: site,
        operation_id: 'eligible-business-' + index,
      });
      assert.equal(output.research.eligibility.status, 'eligible');
      assert.equal(output.新增, 1);
    } finally {
      svc.close();
    }
  }
});

test('C 端经营企业可以入库：全国销售、进口渠道、兼营本地安装与个人经营账号', async () => {
  for (const text of [
    'Acme Screens imports zip screens from independent factories and sells to homeowners nationwide in the United States. We do not own a factory.',
    'I operate Acme Screens, importing zip screens from other manufacturers for homeowners nationwide in the United States. I install locally too, without my own factory.',
  ]) {
    const f = fixture({
      pageText: text,
      modelOverrides: {
        company_name: policyFact('Acme Screens', text),
        entity_type: policyFact('business', text),
        production_model: policyFact('no_own_factory', text),
        operating_model: policyFact('beyond_local', text),
        audience: policyFact('C', text),
        products: [policyFact('zip screens', text)],
      },
    });
    const svc = f.make();
    try {
      const output = await svc.research(input, {
        source_url: site,
        operation_id: 'eligible-c-business',
      });
      assert.equal(output.research.eligibility.status, 'eligible');
      assert.equal(output.新增, 1);
      assert.equal(f.records[0].fields.来源链接, site);
      assert.equal(f.records[0].fields.服务客群, 'C端');
    } finally {
      svc.close();
    }
  }
});

test('自产成品但明确采购目标配件的工厂可入库，不等同于同品类配件制造同行', async () => {
  const text =
    'Acme Screens manufactures outdoor zip screens in our own factory for dealers nationwide in the United States. We are seeking suppliers of zip screen motors.';
  const f = fixture({
      pageText: text,
      modelOverrides: {
        company_name: policyFact('Acme Screens', text),
        entity_type: policyFact('business', text),
        production_model: policyFact('own_factory', text),
        operating_model: policyFact('beyond_local', text),
        customer_type: policyFact('manufacturer', text),
        products: [policyFact('outdoor zip screens', text)],
        manufactured_products: [policyFact('outdoor zip screens', text)],
        demand_products: [
          policyFact('zip screen motors', 'We are seeking suppliers of zip screen motors.'),
        ],
      },
    }),
    svc = f.make();
  try {
    const out = await svc.research(
      { ...input, product: 'outdoor blinds awnings components and parts' },
      {
        source_url: site,
        operation_id: 'eligible-component-buyer',
      },
    );
    assert.equal(out.research.product_match, 'matched');
    assert.equal(out.research.eligibility.status, 'eligible');
    assert.equal(out.新增, 1);
    assert.match(f.records[0].fields.需求产品, /zip screen motors/);
  } finally {
    svc.close();
  }
});

test('经营卷帘的企业可作为潜在面料配件客户收录，采购与自产未证实仍保留缺项', async () => {
  const text =
    'Acme Screens sells roller shades to homeowners in the United States. Our company offers window coverings for residential customers.';
  const f = fixture({
    pageText: text,
    modelOverrides: {
      company_name: policyFact('Acme Screens', text),
      entity_type: policyFact('business', text),
      products: [policyFact('roller shades', text)],
      production_model: null,
      operating_model: null,
      demand_products: [],
    },
  });
  const svc = f.make();
  try {
    const result = await svc.research(
      { ...input, product: 'blind components, roller blind fabric' },
      { source_url: site, operation_id: 'potential-input-buyer' },
    );
    assert.equal(result.新增, 1);
    assert.equal(result.research.product_relation.kind, 'potential_input');
    assert.deepEqual(result.research.demand_products, []);
    assert.equal(result.research.production_model, 'unknown');
  } finally {
    svc.close();
  }
});

test('伪造、缺失或其他 URL 的准入证据不允许放行', async () => {
  for (const badFact of [
    policyFact('business', 'invented business evidence'),
    { ...policyFact('business', sourceText), source_url: 'https://other.example.org/' },
    policyFact('business', sourceText + '\nThis invented policy fact must not be accepted.'),
  ]) {
    const f = fixture({ modelOverrides: { entity_type: badFact } }),
      svc = f.make();
    try {
      const out = await svc.research(input, {
        source_url: site,
        operation_id: 'invalid-policy-evidence',
      });
      assert.equal(out.research.eligibility.code, 'entity_unknown');
      assert.equal(out.新增, 0);
      assert.equal(
        f.calls.some((c) => c.url.includes('/records') && ['POST', 'PUT'].includes(c.method)),
        false,
      );
    } finally {
      svc.close();
    }
  }
});

test('已移除市场不能绕过 API 直接搜索、研究或使用旧搜索计划', async () => {
  const f = fixture(),
    svc = f.make();
  try {
    for (const country of ['Southeast Asia', 'Unsupported market']) {
      await assert.rejects(
        svc.discover({ ...input, country }, { country, query: 'zip screens' }),
        /支持的国家/,
      );
      await assert.rejects(
        svc.research({ ...input, country }, { source_url: site, operation_id: 'retired-market' }),
        /支持的国家/,
      );
    }
    await assert.rejects(
      svc.discover(input, { country: 'Singapore', query: 'zip screens' }),
      /市场范围/,
    );
    await assert.rejects(
      svc.research({ ...input, product: '' }, { source_url: site, operation_id: 'empty-product' }),
      /product.*不能为空/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    svc.close();
  }
});

test('直连候选排除目录、社媒、招聘、私网、已收录域名，按官网去重', () => {
  const r = selectWebsiteCandidates(
    [
      { url: 'https://facebook.com/company' },
      { url: 'https://www.etsy.com/ca/market/roller_blind_fabric' },
      { url: 'https://tracxn.com/d/companies/hanaro-one-way/profile' },
      { url: 'https://www.ctvnews.ca/health/article/fabric-roller-blinds-recalled-in-canada' },
      { url: 'https://127.0.0.1/' },
      { url: 'https://local.internal/' },
      { url: 'https://www.yellowpages.com/company' },
      { url: 'https://company.example.org/jobs/' },
      { url: site },
      { url: site + 'contact' },
      { url: 'https://old.example.org/' },
    ],
    ['old.example.org'],
  );
  assert.equal(r.candidates.length, 1);
  assert.equal(r.skipped_existing_count, 1);
});

test('Feishu 直连缓存令牌并完整遍历分页；重复游标报错', async () => {
  let auth = 0,
    page = 0;
  const urls = [];
  const client = new FeishuClient({
    env,
    fetchImpl: async (url) => {
      if (url.includes('/auth/')) {
        auth++;
        return json({ code: 0, tenant_access_token: 'token', expire: 7200 });
      }
      urls.push(url);
      page++;
      return json({
        code: 0,
        data: {
          items: [{ record_id: 'r' + page }],
          has_more: page === 1,
          page_token: page === 1 ? 'next' : '',
        },
      });
    },
  });
  assert.equal((await client.records()).length, 2);
  page = 0;
  assert.equal((await client.records(undefined, undefined, 200)).length, 2);
  assert(urls.at(-2).includes('page_size=200'));
  assert.equal(auth, 1);
  const bad = new FeishuClient({
    env,
    fetchImpl: async (url) =>
      url.includes('/auth/')
        ? json({ code: 0, tenant_access_token: 'token', expire: 7200 })
        : json({ code: 0, data: { items: [], has_more: true, page_token: 'repeat' } }),
  });
  await assert.rejects(bad.records(), /分页不完整/);
});

test('HTTP 首页失败后从 Tavily 正文发现联系页，仍限制同域与五页预算', async () => {
  const f = fixture(),
    reads = [];
  const svc = f.make({
    readPage: async (url) => {
      reads.push(url.href);
      if (url.href === site) throw new Error('blocked HTTP');
      return { html: '<p>Contact team</p><a href="mailto:public@acme.example.org">Email</a>' };
    },
    fetchImpl: async (url, options) => {
      if (url === 'https://api.tavily.com/extract')
        return json({
          results: [
            { url: site, raw_content: sourceText + '\n[Contact](' + site + 'contact)' },
            { url: 'https://other.example.org/', raw_content: 'Unrelated company evidence' },
          ],
        });
      return f.fetchImpl(url, options);
    },
  });
  try {
    const page = await svc.collect(site);
    assert.ok(reads.includes(site + 'contact'));
    assert.ok(page.website_metadata.contacts.some((c) => c.value === 'public@acme.example.org'));
    assert.ok(page.research_pages.every((p) => p.source_url.startsWith(site)));
    assert.ok(reads.length <= 5);
  } finally {
    svc.close();
  }
});

test('HTTP 200 空壳经 basic、advanced 补采后以有效正文研究，保留完整 HTML 联系证据', async () => {
  const f = fixture(),
    extractions = [];
  const svc = f.make({
    readPage: async () => ({
      html: '<div>Loading</div><a href="mailto:public@acme.example.org"></a>',
    }),
    fetchImpl: async (url, options) => {
      if (url === 'https://api.tavily.com/extract') {
        const body = JSON.parse(options.body);
        extractions.push(body.extract_depth);
        return json({
          results: [
            { url: site, raw_content: body.extract_depth === 'basic' ? 'Loading' : sourceText },
          ],
          usage: { credits: 1 },
        });
      }
      return f.fetchImpl(url, options);
    },
  });
  try {
    const out = await svc.research(input, { source_url: site, operation_id: 'shell-upgrade-e2e' });
    assert.equal(out.新增, 1, out.reason);
    assert.deepEqual(extractions, ['basic', 'advanced']);
    const operation = svc.store.get('shell-upgrade-e2e');
    const sentPages = JSON.parse(
      f.calls.find((c) => c.url.includes('deepseek')).body.input[1].content,
    ).pages;
    assert.deepEqual(sentPages, operation.research_pages);
    assert.deepEqual(sentPages, [{ source_url: site, text: sourceText }]);
    assert.deepEqual(operation.web_usage, { web_extract_calls: 2, web_extract_credits: 2 });
    assert.equal(f.records[0].fields.邮箱, 'public@acme.example.org');
  } finally {
    svc.close();
  }
});

test('补采超出正文预算的引文不能用于企业准入', async () => {
  const omittedQuote = 'Acme Screens is a separately registered business entity.';
  const f = fixture({ modelOverrides: { entity_type: policyFact('business', omittedQuote) } });
  const svc = f.make({
    readPage: async () => ({ html: '<p>Loading...</p>' }),
    fetchImpl: async (url, options) => {
      if (url === 'https://api.tavily.com/extract')
        return json({
          results: [
            {
              url: site,
              raw_content: sourceText + 'x'.repeat(12000) + omittedQuote + 'y'.repeat(12000),
            },
          ],
        });
      return f.fetchImpl(url, options);
    },
  });
  try {
    const out = await svc.research(input, {
      source_url: site,
      operation_id: 'extract-quote-budget',
    });
    const sent = JSON.parse(
      f.calls.find((c) => c.url.includes('deepseek')).body.input[1].content,
    ).pages;
    assert.ok(!sent[0].text.includes(omittedQuote));
    assert.equal(out.research.eligibility.code, 'entity_unknown');
    assert.equal(out.新增, 0);
    assert.equal(f.records.length, 0);
  } finally {
    svc.close();
  }
});

test('缺少直连凭证时禁止运行，但允许查看历史', async () => {
  let calls = 0;
  const app = createApp({
    env: {},
    fetchImpl: async () => {
      calls++;
      throw new Error('must not call');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + app.address().port + '/api/v1/acquisition';
  try {
    const status = await (await fetch(root + '/status')).json();
    assert.equal(status.configured, false);
    assert.ok(!status.missing.includes('FEISHU_APP_SECRET'));
    assert.equal((await fetch(root + '/jobs')).status, 200);
    assert.equal(
      (
        await fetch(root + '/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      503,
    );
    assert.equal(calls, 0);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('原生研究贯通官网补全、来源校验、飞书写入及读回；幂等操作不重复调用', async () => {
  const f = fixture(),
    svc = f.make();
  const item = { source_url: site, operation_id: 'native-success-01' };
  try {
    const output = await svc.research(input, item);
    assert.equal(output.新增, 1);
    assert.equal(output.明细[0].record_id, 'rec-native');
    assert.equal(f.records[0].fields.邮箱, 'sales@acme.example.org');
    assert.equal(f.records[0].fields.国家, 'United States');
    assert.equal(f.records[0].fields.客户等级, undefined);
    const count = f.calls.length;
    assert.deepEqual(await svc.research(input, item), output);
    assert.equal(f.calls.length, count);
    await assert.rejects(svc.research({ ...input, product: 'changed' }, item), /不能更换/);
    assert.ok(
      f.calls.every((c) =>
        ['open.feishu.cn', 'api.tavily.com', 'api.deepseek.com'].includes(new URL(c.url).hostname),
      ),
    );
    const modelCall = f.calls.find((c) => c.url.includes('deepseek'));
    assert.equal(modelCall.body.text.format.type, 'json_schema');
    assert.equal(modelCall.body.model, 'deepseek-flash');
    assert.ok(modelCall.body.input[1].content.includes('Contact our team'));
  } finally {
    svc.close();
  }
});

test('仅发现候选不调用 AI 或写入；平台错误不暴露响应正文', async () => {
  const f = fixture(),
    svc = f.make();
  try {
    assert.equal((await svc.discover(input, { query: input.search_query })).candidates.length, 1);
    assert.equal(
      f.calls.some((c) => c.url.includes('deepseek') || c.method === 'PUT'),
      false,
    );
  } finally {
    svc.close();
  }
  const bad = fixture({ tavilyError: true }),
    service = bad.make();
  try {
    await assert.rejects(
      service.discover(input, { query: input.search_query }),
      (e) => /HTTP 401/.test(e.message) && !e.message.includes('test-secret'),
    );
  } finally {
    service.close();
  }
});

test('已有客户与研究期间新收录的企业均跳过，重复域名转人工核对', async () => {
  for (const options of [
    { initial: [{ record_id: 'rec-old', fields: { 来源链接: site } }] },
    { lateDuplicate: true },
    { initial: ['rec-a', 'rec-b'].map((record_id) => ({ record_id, fields: { 来源链接: site } })) },
  ]) {
    const f = fixture(options),
      svc = f.make();
    try {
      const output = await svc.research(input, {
        source_url: site,
        operation_id: 'duplicate-test',
      });
      assert.equal(output.新增, 0);
      assert.ok(output.skipped_existing_count || output.待人工查重);
      assert.equal(
        f.calls.some((c) => c.url.includes('client_token=')),
        false,
      );
    } finally {
      svc.close();
    }
  }
});

test('定向复核只更新原记录的采集字段，保留人工跟进状态和首次发现时间', async () => {
  const f = fixture({
      initial: [
        {
          record_id: 'rec-old',
          fields: {
            来源链接: site,
            客户名称: 'Old',
            开发状态: '已联系',
            负责人: 'Sales',
            备注: '人工备注',
            首次发现时间: 1000,
            customer_id: 'old-customer',
          },
        },
      ],
    }),
    svc = f.make();
  try {
    const output = await svc.research(input, {
      source_url: site,
      operation_id: 'update-target-01',
      target_record_id: 'rec-old',
    });
    assert.equal(output.更新, 1);
    const write = f.calls.find((c) => c.method === 'PUT');
    for (const field of ['开发状态', '负责人', '备注', '首次发现时间', 'customer_id'])
      assert.equal(write.body.fields[field], undefined);
    assert.equal(f.records[0].fields.备注, '人工备注');
  } finally {
    svc.close();
  }
});

test('写请求响应丢失后按域名核对结果；重复请求及重启不再次新增', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'native-write-'));
  const path = join(folder, 'operations.sqlite'),
    f = fixture({ loseWrite: true });
  let svc = f.make({ store: new AcquisitionStore(path) });
  const item = { source_url: site, operation_id: 'uncertain-write-01' };
  try {
    await assert.rejects(svc.research(input, item), /待核对/);
    const recovered = await svc.status(item.operation_id);
    assert.equal(recovered.settled, true);
    assert.equal(recovered.output.新增, 1);
    svc.close();
    svc = f.make({ store: new AcquisitionStore(path) });
    const repeated = await svc.research(input, item);
    assert.equal(repeated.新增, 1);
    assert.equal(f.records.length, 1);
    assert.equal(
      f.calls.filter((c) => c.method === 'POST' && c.url.includes('client_token=')).length,
      1,
    );
  } finally {
    svc.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('已返回记录编号后读回短暂中断，由受控重试完成且不重复写入', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'native-read-'));
  const path = join(folder, 'operations.sqlite'),
    f = fixture({ loseReadback: true });
  let svc = f.make({ store: new AcquisitionStore(path) });
  try {
    const first = await svc.research(input, {
      source_url: site,
      operation_id: 'readback-recovery-01',
    });
    assert.equal(first.新增, 1);
    svc.close();
    svc = f.make({ store: new AcquisitionStore(path) });
    const result = await svc.status('readback-recovery-01');
    assert.equal(result.settled, true);
    assert.equal(result.output.新增, 1);
    assert.equal(f.records.length, 1);
  } finally {
    svc.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('本地档案多选字段读回一致时可确认写入', async () => {
  const record = {
    record_id: 'local-test',
    fields: { 官网链接: { link: site }, 客户类型: ['零售商', '工厂'] },
  };
  const service = { feishu: { localFirst: true, record: async () => record } };
  const operation = {
    recordId: record.record_id,
    source_url: site,
    fields: { 官网链接: { link: site }, 客户类型: ['零售商', '工厂'] },
  };
  assert.equal(await NativeAcquisition.prototype.verify.call(service, operation), true);
  record.fields.客户类型 = ['零售商'];
  assert.equal(await NativeAcquisition.prototype.verify.call(service, operation), false);
});

test('重启核对仅把未写入的抓取中断标为可重试', async () => {
  const f = fixture(),
    svc = f.make();
  try {
    const { operation: beforeWrite } = svc.store.begin('interrupted-before-write', {
      input,
      item: { source_url: site, operation_id: 'interrupted-before-write' },
    });
    beforeWrite.stage = 'extract';
    beforeWrite.source_url = site;
    svc.store.save(beforeWrite);
    const recovered = await svc.status(beforeWrite.id);
    assert.equal(recovered.settled, true);
    assert.equal(recovered.output.outcome, 'failed');
    assert.equal(recovered.output.retryable_before_write, true);
    assert.equal((await svc.status(beforeWrite.id)).output.retryable_before_write, true);
    const { operation: writeIntent } = svc.store.begin('interrupted-write-intent', {
      input,
      item: { source_url: site, operation_id: 'interrupted-write-intent' },
    });
    writeIntent.stage = 'persist';
    writeIntent.action = 'update';
    writeIntent.source_url = site;
    svc.store.save(writeIntent);
    const pending = await svc.status(writeIntent.id);
    assert.equal(pending.settled, false);
  } finally {
    svc.close();
  }
});

test('不存在的操作返回结构化缺失状态，不依赖中文原因判断', async () => {
  const f = fixture(),
    svc = f.make();
  try {
    const missing = await svc.status('missing-operation-status');
    assert.equal(missing.settled, false);
    assert.equal(missing.missing, true);
  } finally {
    svc.close();
  }
});

test('读回字段不一致不宣称成功；跨域跳转与缺少正文不调用模型', async () => {
  const f = fixture({ corruptReadback: true }),
    svc = f.make();
  try {
    await assert.rejects(
      svc.research(input, {
        source_url: site,
        operation_id: 'corrupt-readback-01',
      }),
      /待核对/,
    );
    assert.equal((await svc.status('corrupt-readback-01')).settled, false);
  } finally {
    svc.close();
  }
  const redirected = fixture(),
    service = redirected.make({
      readPage: async () => ({ redirect: 'https://other.example.org/' }),
    });
  try {
    const out = await service.research(input, {
      source_url: site,
      operation_id: 'redirect-test-01',
    });
    assert.equal(out.新增, 0);
    assert.equal(
      redirected.calls.some((c) => c.url.includes('deepseek')),
      false,
    );
  } finally {
    service.close();
  }
});

test('迁移后旧引擎的暂停任务无法交给新引擎继续', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'native-provider-')),
    path = join(folder, 'jobs.sqlite');
  let manager = new BatchJobs({ path, schedule: false, provider: 'retired', scope: 'table' });
  const job = manager.create({ ...input, target_count: 1 }, 'provider-switch-test');
  manager.close();
  manager = new BatchJobs({ path, schedule: false, provider: 'native', scope: 'table' });
  try {
    await assert.rejects(manager.resume(job.id), /其他执行引擎/);
  } finally {
    manager.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('统一获客接口以 native 引擎完成单家批量任务，仅使用官方接口且不泄露凭证', async () => {
  const f = fixture(),
    svc = f.make();
  const app = createApp({ env, fetchImpl: f.fetchImpl, nativeImpl: svc });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + app.address().port + '/api/v1/acquisition';
  try {
    const status = await (await fetch(root + '/status')).json();
    assert.equal(status.configured, true);
    assert.equal(status.provider, 'native');
    assert.equal(JSON.stringify(status).includes('test-secret'), false);
    const response = await fetch(root + '/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'native-batch-01' },
      body: JSON.stringify({ ...input, target_count: 1 }),
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    let final;
    for (let n = 0; n < 100; n++) {
      final = await (await fetch(root + '/jobs/' + created.id)).json();
      if (final.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(final.status, 'completed');
    assert.equal(final.inserted, 1);
    assert.equal(final.countPolicy, 'broad-business-v1');
    assert.equal(final.provider, 'native');
    assert.ok(
      f.calls.every((c) =>
        ['open.feishu.cn', 'api.tavily.com', 'api.deepseek.com'].includes(new URL(c.url).hostname),
      ),
    );
    const history = await (await fetch(root + '/jobs')).json();
    assert.equal(history.jobs.find((job) => job.id === created.id).status, 'completed');
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('本轮再度出现的既有企业优先排除，客户库超过搜索服务上限仍可补找', async () => {
  for (const [country, fresh] of [
    ['Canada', 'maple'],
    ['Australia', 'wattle'],
    ['United States', null],
  ]) {
    const initial = Array.from({ length: 160 }, (_, index) => ({
      record_id: 'rec' + index,
      fields: { 来源链接: 'https://known' + index + '.com/' },
    }));
    const svc = fixture({ initial }).make();
    const calls = [];
    svc.providers.web.search = async ({ exclude_domains }) => {
      calls.push(exclude_domains);
      const url = !exclude_domains.includes('known0.com')
        ? 'https://known0.com/'
        : fresh
          ? 'https://' + fresh + '.example.org/'
          : null;
      return { results: url ? [{ url }] : [] };
    };
    const leads = [];
    const manager = new BatchJobs({
      schedule: false,
      discover: svc.discover.bind(svc),
      readLeads: async () => leads,
      research: async (_input, item) => {
        leads.push({ id: 'rec-new', website: item.source_url });
        return {
          新增: 1,
          明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'rec-new' }],
        };
      },
    });
    try {
      const job = manager.create(
        { ...input, country, search_query: 'zip screens ' + country, target_count: 1 },
        'recent-known-test',
      );
      await manager.work(job.id);
      assert.equal(calls[1].at(-1), 'known0.com');
      assert.ok(calls.every((domains) => domains.length <= 150));
      assert.equal(manager.get(job.id).inserted, fresh ? 1 : 0);
      assert.deepEqual(
        leads.map((lead) => lead.website),
        fresh ? ['https://' + fresh + '.example.org/'] : [],
      );
    } finally {
      manager.close();
      svc.close();
    }
  }
});
test('native acquisition reuses a rendered snapshot and preserves the original attempt evidence', async () => {
  const { make } = fixture();
  const rendered = '<p>' + sourceText + '</p>';
  const svc = make({
    readPage: async () => ({
      html: '<noscript>Enable JavaScript to run the application.</noscript>',
    }),
    readScraplingPage: async (url) => ({
      requested_url: url,
      final_url: site,
      acquired_at: '2026-11-27T02:03:04.000Z',
      method: 'scrapling',
      status: 'ok',
      content: rendered,
      raw_content: '<noscript>Enable JavaScript to run the application.</noscript>',
    }),
  });
  try {
    const first = await svc.collect(site, {
      unified: true,
      now: Date.parse('2026-11-27T02:04:00Z'),
    });
    assert.match(first.page_text, /Acme Screens imports zip screens/);
    assert.deepEqual(
      first.collection_attempts.map((a) => [a.method, a.status, a.reason]),
      [
        ['node', 'empty', 'initial_read'],
        ['scrapling', 'ok', 'missing_page_body'],
      ],
    );
    assert.equal(first.collection_attempts[1].requested_url, site);
    assert.equal(first.collection_attempts[1].final_url, site);
    assert.match(first.collection_attempts[1].content_hash, /^[a-f0-9]{64}$/);
    const second = await svc.collect(site, {
      unified: true,
      now: Date.parse('2026-11-27T02:04:01Z'),
    });
    assert.equal(second.page_text, first.page_text);
    assert.deepEqual(second.collection_attempts, [
      { ...first.collection_attempts[1], reused: true },
    ]);
    assert.equal(
      svc.store.snapshotById(first.collection_attempts[1].snapshot_id).raw_content,
      '<noscript>Enable JavaScript to run the application.</noscript>',
    );
  } finally {
    svc.close();
  }
});
test('获客任务按官网证据收录两家，空壳与参展商待核实，主办方排除', async () => {
  // Minimal frozen official excerpts plus a generated exhibitor profile and empty page.
  const hillarys = 'https://www.hillarys.co.uk/terms-conditions/';
  const vision = 'https://www.visiondecor.com.au/products/';
  const organizer =
    'https://www.galabau-messe.com/en/press/press-releases/2026/09/galabau-2026-opens-its-gates';
  const exhibitor = 'https://www.fair-preview.example.org/exhibitors/oakleaf';
  const empty = 'https://empty-shades.example.org/';
  const hillarysIdentity =
    'We are Hunter Douglas UK Retail Limited a company registered in England and Wales, trading as Hillarys Blinds.';
  const hillarysSupply = 'made-to-measure blinds, curtains and shutters';
  const visionIdentity =
    'Vision Decor are innovators in providing stylish and unique interior decorating solutions in Perth';
  const visionSupply = 'Our Range of Blinds, Curtains & Shutters in Perth';
  const organizerIdentity = 'NürnbergMesse is the organiser of the event.';
  const exhibitorIdentity =
    'Oakleaf Shade is listed as an exhibitor showing outdoor roller blinds.';
  const shell = '<noscript>Enable JavaScript to run the application.</noscript>';
  const html = (...parts) => parts.map((text) => '<p>' + text + '</p>').join('');
  const cases = new Map([
    [
      hillarys,
      {
        name: 'Hunter Douglas UK Retail Limited',
        identity: hillarysIdentity,
        supply: hillarysSupply,
        fact: 'complete_supply',
        path: 'scrapling',
        product: 'blinds',
      },
    ],
    [
      vision,
      {
        name: 'Vision Decor',
        identity: visionIdentity,
        supply: visionSupply,
        fact: 'complete_supply',
        path: 'external',
        product: 'Curtains',
      },
    ],
    [empty, { name: 'Empty Shades', path: 'empty' }],
    [
      organizer,
      {
        name: 'NürnbergMesse',
        identity: organizerIdentity,
        fact: 'trade_show_operator',
        path: 'node',
      },
    ],
    [
      exhibitor,
      {
        name: 'Oakleaf Shade',
        identity: exhibitorIdentity,
        fact: 'third_party_profile',
        path: 'node',
      },
    ],
  ]);
  const f = fixture();
  const modelResponse = (data) =>
    json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
    });
  const siteFetch = async (url, options) => {
    if (url === 'https://api.tavily.com/search') {
      const { exclude_domains } = JSON.parse(options.body);
      return json({
        results: [...cases]
          .filter(
            ([href]) => !exclude_domains.includes(new URL(href).hostname.replace(/^www\./, '')),
          )
          .map(([href, data]) => ({ url: href, title: data.name })),
      });
    }
    if (url === 'https://api.tavily.com/extract') {
      const { urls } = JSON.parse(options.body);
      return json({
        results: urls.includes(vision)
          ? [{ url: vision, raw_content: html(visionIdentity, visionSupply) }]
          : [],
      });
    }
    if (url === 'https://api.deepseek.com/responses') {
      const request = JSON.parse(options.body);
      const { pages, sources } = JSON.parse(request.input[1].content);
      if (sources)
        return modelResponse({
          result: 'relevant',
          sources: sources.map((s) => s.i),
          reason: '官网确认供应窗饰',
        });
      const source = pages.find((p) => cases.has(p.source_url)).source_url;
      const data = cases.get(source);
      const evidence = (value, quote) => ({ value, quote, source_url: source });
      return modelResponse({
        company_name: evidence(data.name, data.identity),
        legal_company_name: source === hillarys ? evidence(data.name, data.identity) : null,
        entity_type: evidence('business', data.identity),
        admission_facts: [evidence(data.fact, data.supply || data.identity)],
        products: data.product
          ? [{ ...evidence(data.product, data.supply), window_use: 'window_covering' }]
          : [],
      });
    }
    return f.fetchImpl(url, options);
  };
  const svc = f.make({
    fetchImpl: siteFetch,
    readPage: async (url) => {
      const data = cases.get(url.href);
      return { html: data?.path === 'node' ? html(data.identity) : shell };
    },
    readScraplingPage: async (url) =>
      url === hillarys
        ? {
            final_url: url,
            status: 'ok',
            content: html(hillarysIdentity, hillarysSupply),
            raw_content: shell,
          }
        : { final_url: null, status: 'unavailable' },
  });
  const app = createApp({ env, fetchImpl: siteFetch, nativeImpl: svc });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1';
  try {
    const response = await fetch(base + '/acquisition/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'website-admission-regression',
      },
      body: JSON.stringify({
        ...input,
        product: 'window coverings',
        product_scope: 'all',
        target_count: 3,
      }),
    });
    assert.equal(response.status, 202);
    const created = await response.json();
    let job;
    for (let n = 0; n < 100; n++) {
      job = await (await fetch(base + '/acquisition/jobs/' + created.id)).json();
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job.admissionVersion, 'website-admission-v1');
    assert.equal(job.inserted, 2);
    assert.deepEqual(
      job.rows.map((row) => row.result),
      ['inserted', 'inserted', 'review', 'rejected', 'review'],
    );
    assert.ok(
      job.rows[0].collection_attempts.some((a) => a.method === 'scrapling' && a.status === 'ok'),
    );
    assert.ok(
      job.rows[1].collection_attempts.some((a) => a.method === 'external' && a.status === 'ok'),
    );
    assert.ok(job.rows[2].collection_attempts.every((a) => a.status !== 'ok'));
    const list = await (await fetch(base + '/leads/real/list')).json();
    assert.deepEqual(list.leads.map(({ name, website }) => [name, website]).sort(), [
      ['Hunter Douglas UK Retail Limited', hillarys],
      ['Vision Decor', vision],
    ]);
    const raw = svc.store.snapshotById(
      job.rows[0].collection_attempts.find((a) => a.method === 'scrapling').snapshot_id,
    );
    assert.match(raw.content, /Hunter Douglas UK Retail Limited/);
    assert.equal(raw.raw_content, shell);
    const organizerResult = await svc.status(job.rows[3].operation_id);
    assert.equal(organizerResult.output.research.eligibility.code, 'trade_show_operator');
    assert.equal(
      organizerResult.output.research.facts.find((f) => f.field === 'admission_facts').quote,
      organizerIdentity,
    );
    const exhibitorResult = await svc.status(job.rows[4].operation_id);
    assert.equal(exhibitorResult.output.research.eligibility.code, 'official_site_missing');
    const review = await (
      await fetch(base + '/acquisition/jobs/' + created.id + '/reviews/4')
    ).json();
    assert.equal(review.resolution, null);
    assert.deepEqual(review.evidence.collection_attempts, job.rows[4].collection_attempts);
    assert.equal(
      review.evidence.facts.find((fact) => fact.field === 'admission_facts').quote,
      exhibitorIdentity,
    );
    assert.equal(
      review.evidence.facts.find((fact) => fact.field === 'admission_facts').snapshot_id,
      job.rows[4].collection_attempts[0].snapshot_id,
    );
    assert.ok(
      review.evidence.collection_attempts.every(
        (attempt) => !Object.hasOwn(attempt, 'raw_content'),
      ),
    );
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
test('正常任务按营业登记主体区分同域企业，补证、并发核对和版本复用均只认原主库归属', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-02-01T12:00:00Z') });
  const north = 'https://shade-hub.example.org/north/';
  const south = 'https://shade-hub.example.org/south/';
  const alias = 'https://north-showroom.example.org/';
  const collision = 'https://similar-shade.example.org/';
  const corrected = 'https://central-shade.example.org/';
  const incomplete = 'https://unconfirmed-shade.example.org/';
  const automaticCorrection = 'https://west-shade.example.org/';
  const canopy = 'https://shade-hub.example.org/canopy/';
  const canopyVenue = 'https://canopy-showroom.example.org/';
  const registeredOffice = {
    country: 'New Zealand',
    region: 'Auckland',
    city: 'Auckland',
    street: '72 Sample Way',
    postal_code: '1010',
  };
  const fixtures = new Map([
    [north, { name: 'North Shade Limited', registration: '07123456' }],
    [south, { name: 'South Shade Limited', registration: '07987654', browser: true }],
    [alias, { name: 'North Shade Limited', registration: '07123456' }],
    [collision, { name: 'North Shade Limited' }],
    [corrected, { name: 'Central Shade Limited', registration: '07555555', manual: true }],
    [incomplete, { name: 'West Shade', omitActivity: true }],
    [automaticCorrection, { name: 'West Shade Limited', registration: '07666666', hidden: true }],
    [canopy, { name: 'Canopy Shade Limited', registeredOffice }],
    [canopyVenue, { name: 'Canopy Shade Limited', registeredOffice }],
  ]);
  const identity = ({ name, registration }) =>
    registration
      ? `This website is operated by ${name}, registered in England and Wales, company number ${registration}.`
      : name === 'Canopy Shade Limited'
        ? `This website is operated by ${name}.`
        : `Welcome to ${name}, your window coverings specialist.`;
  const office = ({ name, registeredOffice }) =>
    registeredOffice
      ? `Registered office of ${name}: ${registeredOffice.street}, ${registeredOffice.city} ${registeredOffice.postal_code}, ${registeredOffice.country}.`
      : '';
  const supply =
    'We supply made-to-measure roller blinds for residential windows and commercial buildings.';
  const html = (data) =>
    `<p>${identity(data)}</p><p>${data.updatedSupply || supply}</p><p>${office(data)}</p>`;
  const modelResponse = (data) =>
    json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
    });
  const fixtureService = fixture();
  const paidRequests = [];
  const siteFetch = async (url, options) => {
    if (url === 'https://api.tavily.com/search') {
      const { exclude_domains } = JSON.parse(options.body);
      return json({
        results: [...fixtures].flatMap(([href, data]) =>
          data.manual || data.hidden || exclude_domains.includes(new URL(href).hostname)
            ? []
            : [{ url: href, title: data.name }],
        ),
      });
    }
    if (url === 'https://api.tavily.com/extract') return json({ results: [] });
    if (url === 'https://api.deepseek.com/responses') {
      const request = JSON.parse(options.body);
      const { pages, sources } = JSON.parse(request.input[1].content);
      paidRequests.push(request);
      if (sources)
        return modelResponse({
          result: 'relevant',
          sources: sources.map(({ i }) => i),
          reason: '官网原文确认经营',
        });
      const source = pages[0].source_url;
      const data = fixtures.get(source);
      const evidence = (value, quote) => ({ value, quote, source_url: source });
      const currentSupply = data.updatedSupply || supply;
      return modelResponse({
        company_name: evidence(data.name, identity(data)),
        legal_company_name:
          data.registration || data.registeredOffice ? evidence(data.name, identity(data)) : null,
        address: data.registeredOffice ? evidence(data.registeredOffice, office(data)) : null,
        actual_country: data.registeredOffice
          ? evidence(data.registeredOffice.country, office(data))
          : null,
        entity_type: evidence('business', identity(data)),
        admission_facts:
          data.manual || data.omitActivity ? [] : [evidence('complete_supply', currentSupply)],
        products:
          data.manual || data.omitActivity
            ? []
            : [{ ...evidence('roller blinds', currentSupply), window_use: 'window_covering' }],
      });
    }
    throw new Error('镜像离线');
  };
  const service = fixtureService.make({
    fetchImpl: siteFetch,
    readPage: async ({ href }) => {
      const data = fixtures.get(href);
      return {
        html: data && !data.browser ? html(data) : '<noscript>Enable JavaScript</noscript>',
      };
    },
    readScraplingPage: async (url) =>
      url === south
        ? { final_url: url, status: 'ok', content: html(fixtures.get(south)) }
        : { final_url: null, status: 'unavailable' },
  });
  const app = createApp({ env, fetchImpl: siteFetch, nativeImpl: service });
  const archive = service.feishu;
  const archiveWrite = archive.write.bind(archive);
  let writes = 0;
  archive.write = async (...args) => {
    const result = await archiveWrite(...args);
    if (args[4]?.source_url === north && ++writes === 1) throw new Error('SQLite 写入应答丢失');
    return result;
  };
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1';
  const startJob = async (key) => {
    const response = await fetch(base + '/acquisition/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({
        ...input,
        country: 'worldwide',
        product: 'window coverings',
        product_scope: 'all',
        target_count: 4,
      }),
    });
    assert.equal(response.status, 202);
    return (await response.json()).id;
  };
  const readJob = async (id) => {
    const deadline = performance.now() + 30_000;
    let job;
    do {
      const response = await fetch(base + '/acquisition/jobs/' + id);
      assert.equal(response.status, 200);
      job = await response.json();
      if (['completed', 'partial', 'paused'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (performance.now() < deadline);
    assert.fail(
      `隔离任务 ${id} 在 30 秒内未结束或暂停（${job.status}，已搜索 ${job.searches} 次）`,
    );
  };
  try {
    const jobId = await startJob('subject-credit-fixture');
    const paused = await readJob(jobId);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pending, 1);
    assert.equal(paused.inserted, 0);
    const { leads: committed } = await (await fetch(base + '/leads/real/list')).json();
    assert.deepEqual(
      committed.map(({ name }) => name),
      ['North Shade Limited'],
    );
    const resume = () => fetch(base + `/acquisition/jobs/${jobId}/resume`, { method: 'POST' });
    const resumed = await Promise.all([resume(), resume()]);
    assert.ok(resumed.some(({ status }) => status === 200));
    const job = await readJob(jobId);
    assert.equal(writes, 1);
    assert.equal(
      job.inserted,
      3,
      JSON.stringify({
        status: job.status,
        reason: job.reason,
        rows: job.rows.map(({ result, reason }) => ({ result, reason })),
      }),
    );
    assert.deepEqual(
      job.rows.map(({ source_url, result }) => [source_url, result]),
      [
        [north, 'inserted'],
        [south, 'inserted'],
        [alias, 'duplicate'],
        [collision, 'review'],
        [incomplete, 'review'],
        [canopy, 'inserted'],
        [canopyVenue, 'duplicate'],
      ],
    );
    assert.equal(job.rows[0].record_id, job.rows[2].record_id);
    assert.equal(job.rows[2].research_trace[0].stage, 'known_subject');
    assert.equal(job.rows[5].record_id, job.rows[6].record_id);
    assert.notEqual(job.rows[0].record_id, job.rows[1].record_id);
    assert.ok(job.rows[1].collection_attempts.some(({ method }) => method === 'scrapling'));
    assert.deepEqual(
      job.rows[0].research_trace.map(({ stage, reused }) => [stage, reused]),
      [
        ['extraction', false],
        ['activity', false],
      ],
    );
    assert.ok(job.rows[0].capture.confirmed_at);
    const { leads } = await (await fetch(base + '/leads/real/list')).json();
    assert.deepEqual(leads.map(({ name, website }) => [name, website]).sort(), [
      ['Canopy Shade Limited', canopy],
      ['North Shade Limited', north],
      ['South Shade Limited', south],
    ]);
    const { lead } = await (await fetch(base + '/leads/real/' + job.rows[0].record_id)).json();
    assert.deepEqual(
      lead.acquisitionSources.map(({ source_url, registration }) => [source_url, registration.key]),
      [
        [north, 'gb-company:07123456'],
        [alias, 'gb-company:07123456'],
      ],
    );
    assert.equal(
      lead.acquisitionSources[0].registration.evidence.snapshot_id,
      job.rows[0].collection_attempts[0].snapshot_id,
    );
    assert.equal(
      (await (await fetch(base + '/leads/real/list?page=1')).json()).sync.pendingWrites,
      3,
    );

    const firstPaid = paidRequests.length;
    const repeated = await readJob(await startJob('subject-credit-repeat'));
    assert.equal(repeated.inserted, 0);
    assert.equal(paidRequests.length, firstPaid);
    assert.deepEqual(
      repeated.rows[1].research_trace.map(({ stage, reused }) => [stage, reused]),
      [
        ['extraction', true],
        ['activity', true],
      ],
    );
    t.mock.timers.tick(25 * 60 * 60 * 1000);
    fixtures.get(north).updatedSupply =
      'We supply made-to-measure roller blinds for commercial buildings. We also cover residential windows.';
    const changed = await readJob(await startJob('subject-credit-changed'));
    assert.equal(changed.inserted, 0);
    assert.equal(changed.rows[0].record_id, job.rows[0].record_id);
    assert.equal(paidRequests.length - firstPaid, 2);
    assert.notEqual(
      changed.rows[0].research_trace[0].request_key,
      job.rows[0].research_trace[0].request_key,
    );
    assert.equal(changed.rows[1].research_trace[0].reused, true);
    const reviewPath = base + `/acquisition/jobs/${job.id}/reviews/3`;
    const submission = {
      source_url: corrected,
      actor: '林销售',
      decision: {
        company_name: 'Central Shade Limited',
        identity_quote: identity(fixtures.get(corrected)),
        source_url: corrected,
        operating_quote: supply,
        product: 'roller blinds',
        admission_fact: 'complete_supply',
        reason: '官网条款确认法人，产品介绍确认住宅和商业建筑供货',
      },
    };
    const postReview = (body, key, path = reviewPath) =>
      fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(body),
      });
    const invalid = {
      ...submission,
      decision: { ...submission.decision, operating_quote: '不存在的官网段落' },
    };
    const unsupported = await postReview(invalid, 'manual-invalid-quote');
    assert.equal((await unsupported.json()).resolution.status, 'review');
    assert.equal((await postReview(submission, 'manual-invalid-quote')).status, 409);
    const reviewResponse = await postReview(submission, 'manual-subject-ruling');
    assert.equal(reviewResponse.status, 200);
    const { resolution } = await reviewResponse.json();
    assert.equal(resolution.status, 'inserted');
    assert.equal(resolution.actor, '林销售');
    assert.equal(resolution.decision.reason, submission.decision.reason);
    assert.ok(Date.parse(resolution.capture.confirmed_at));
    assert.deepEqual(
      (await (await postReview(submission, 'manual-subject-ruling')).json()).resolution,
      resolution,
    );
    const refreshed = await (await fetch(base + '/acquisition/jobs/' + job.id)).json();
    assert.equal(refreshed.inserted, 3);
    assert.equal(refreshed.manualInserted, 1);
    assert.equal(refreshed.confirmedInserted, 4);
    const previous = (await (await fetch(reviewPath)).json()).attempts;
    assert.deepEqual(
      previous.map(({ status }) => status),
      ['review', 'inserted'],
    );
    assert.equal(previous[1].original_source_url, collision);
    const automaticReview = await postReview(
      { source_url: automaticCorrection, actor: '周销售' },
      'automatic-url-correction',
      base + `/acquisition/jobs/${job.id}/reviews/4`,
    );
    const { resolution: verified } = await automaticReview.json();
    assert.equal(verified.status, 'inserted');
    assert.equal(verified.actor, '周销售');
    assert.equal(verified.original_source_url, incomplete);
    assert.ok(verified.decided_at);
    t.mock.timers.tick(1000);
    const overview = await (await fetch(base + '/overview?period=7d')).json();
    assert.equal(
      overview.metrics.newCompanies,
      5,
      JSON.stringify({ captures: overview.captures, range: overview.range }),
    );
    assert.deepEqual(overview.captures.map(({ name, mode, jobId }) => [name, mode, jobId]).sort(), [
      ['Canopy Shade Limited', 'automatic', job.id],
      ['Central Shade Limited', 'manual', job.id],
      ['North Shade Limited', 'automatic', job.id],
      ['South Shade Limited', 'automatic', job.id],
      ['West Shade Limited', 'manual', job.id],
    ]);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('缺少主营供货引文时补抓，保留直接取得的主体与经营原文', async () => {
  const note = 'We sell complete outdoor zip screens as a core product line.';
  const f = fixture();
  const svc = f.make({
    readPage: async () => ({ html: '<p>' + sourceText + '</p>' }),
    readScraplingPage: async (url) => ({
      final_url: url,
      status: 'ok',
      content: '<p>' + note + '</p>',
    }),
  });
  const research = svc.providers.model.research.bind(svc.providers.model);
  svc.providers.model.research = async (request) => {
    const { pages } = JSON.parse(request.messages[1].content);
    const result = await research(request);
    if (!pages || !request.schema.properties.admission_facts) return result;
    const entry = (result.body || result).output[0].content[0];
    const data = JSON.parse(entry.text);
    data.admission_facts = pages.some((page) => page.text.includes(note))
      ? [policyFact('complete_supply', note)]
      : [];
    entry.text = JSON.stringify(data);
    return result;
  };
  try {
    const result = await svc.research(
      input,
      { source_url: site, operation_id: 'missing-supply-evidence' },
      { admissionVersion: 'website-admission-v1' },
    );
    assert.equal(result.新增, 1);
    assert.equal(result.research.company_name, 'Acme Screens');
    assert.equal(result.research.eligibility.code, 'complete_supply');
    assert.deepEqual(
      result.collection_attempts.map((a) => [a.method, a.reason]),
      [
        ['node', 'initial_read'],
        ['scrapling', 'missing_operating_evidence'],
      ],
    );
    const evidence = result.research.facts.filter((f) =>
      ['company_name', 'admission_facts'].includes(f.field),
    );
    assert.deepEqual(
      evidence.map((f) => [f.quote, f.snapshot_id]),
      [
        [sourceText, result.collection_attempts[0].snapshot_id],
        [note, result.collection_attempts[1].snapshot_id],
      ],
    );
  } finally {
    svc.close();
  }
});
test('新版官网采集记录跨站和非公网来源，禁止交给外部补采', async () => {
  const { make, calls } = fixture();
  const overseas = 'https://other-domain.example.org/';
  const redirects = [
    ['https://site-redirect.example.org/', 'off_site_redirect', overseas],
    ['https://private-source.example.org/', 'non_public_source', null],
  ];
  const svc = make({
    readPage: async (url) => {
      if (url.hostname === 'site-redirect.example.org') return { redirect: overseas };
      throw Object.assign(new Error('非公网来源'), { code: 'WEBSITE_NOT_PUBLIC' });
    },
    readScraplingPage: async () => assert.fail('blocked source was sent to the browser'),
  });
  try {
    for (const [url, reason, redirect] of redirects) {
      const result = await svc.research(
        input,
        { source_url: url, operation_id: new URL(url).hostname.split('.')[0] },
        { admissionVersion: 'website-admission-v1' },
      );
      assert.equal(result.outcome, 'review');
      assert.deepEqual(
        result.collection_attempts.map((a) => [a.status, a.reason, a.final_url]),
        [['blocked', reason, redirect || url]],
      );
    }
    assert.ok(calls.every((call) => !/tavily.com\/extract|deepseek.com/.test(call.url)));
  } finally {
    svc.close();
  }
});
test('主办方官网从法律声明取得身份后排除，参展与匿名对照保持待核实', async () => {
  const role = 'Become an exhibitor at GaLaBau';
  const roleForVendor = 'Oakleaf Shade is listed as an exhibitor showing outdoor roller blinds.';
  for (const [domain, noticePath, exhibitor, outcome] of [
    ['www.galabau-messe.com', '/en/legal-notice', false, 'rejected'],
    ['event-owner.example.org', '/imprint', false, 'rejected'],
    ['www.galabau-messe.com', '/en/legal-notice', true, 'review'],
    ['event-unverified.example.org', '', false, 'review'],
  ]) {
    const origin = 'https://' + domain;
    const source = origin + (exhibitor ? '/en/exhibitors/oakleaf' : '/en/exhibit');
    const imprint = origin + noticePath;
    const name = domain.startsWith('www.galabau') ? 'NürnbergMesse GmbH' : 'Arc Event Owner GmbH';
    const quote = noticePath === '/imprint' ? 'Copyright ' + name : name;
    const mainText = exhibitor ? roleForVendor : role;
    const { make, fetchImpl } = fixture();
    const native = make({
      readPage: async (url) => ({
        html:
          url.href === source
            ? [
                '<p>' + mainText + '</p>',
                '<a href="/en/contact">Contact</a><a href="/en/contact/partners">Sales partners</a>',
                '<a href="/en/about">About</a>',
                noticePath ? '<a href="' + noticePath + '"><span>Imprint</span></a>' : '',
              ].join('')
            : noticePath && url.href === imprint
              ? '<h1>Imprint</h1><p>' + quote + '</p>'
              : '<p>Information for visitors.</p>',
      }),
      fetchImpl: async (url, options) => {
        if (url !== 'https://api.deepseek.com/responses') return fetchImpl(url, options);
        const request = JSON.parse(options.body);
        const { pages } = JSON.parse(request.input[1].content);
        const notice =
          noticePath &&
          pages.find((page) => page.source_url === imprint && page.text.includes(quote));
        const evidence = (value, quote, source_url = source) => ({ value, quote, source_url });
        return json({
          status: 'completed',
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    company_name: notice ? evidence(name, quote, imprint) : null,
                    legal_company_name: notice ? evidence(name, quote, imprint) : null,
                    entity_type: evidence('business', mainText),
                    admission_facts: [
                      evidence(exhibitor ? 'third_party_profile' : 'trade_show_operator', mainText),
                    ],
                  }),
                },
              ],
            },
          ],
        });
      },
    });
    try {
      const result = await native.research(
        { ...input, product_scope: 'all', product: 'window coverings' },
        { source_url: source, operation_id: 'legal-notice-selection' },
        { admissionVersion: 'website-admission-v1' },
      );
      assert.equal(result.outcome, outcome, source);
      assert.equal(result.新增, 0, source);
      if (noticePath)
        assert.equal(
          result.collection_attempts.find((attempt) => attempt.requested_url === imprint)?.status,
          'ok',
          source,
        );
      if (outcome === 'rejected') {
        assert.equal(result.research.company_name, name, source);
        assert.equal(
          result.research.facts.find((fact) => fact.field === 'legal_company_name').source_url,
          imprint,
        );
      }
    } finally {
      native.close();
    }
  }
});
test('官网研究正文解码法人名称和标点，保留数值字符与短页原文', async () => {
  const { make } = fixture();
  const pages = new Map([
    ['https://organizer.example.org/', ['<p>N&uuml;rnbergMesse GmbH</p>', 'NürnbergMesse GmbH']],
    [
      'https://dealer.example.org/',
      ['<p>Dealer&rsquo;s blinds &#x2013; &#x1f31e;</p>', 'Dealer’s blinds – 🌞'],
    ],
    ['https://plain.example.org/', ['<p>Plain Blinds</p>', 'Plain Blinds']],
  ]);
  const native = make({
    readPage: async (url) => ({ html: pages.get(url.href)[0] }),
  });
  try {
    for (const [url, [, expected]] of pages) {
      const collected = await native.collect(url, { unified: true });
      assert.equal(collected.page_text, expected, url);
    }
  } finally {
    native.close();
  }
});
test('供应商档案发现后保留待核实，只有独立官网写入主库', async () => {
  const nsw = 'https://buy.nsw.gov.au/supplier/profile/12468764';
  const second = 'https://tender-network.example.org/companies/913';
  const official = 'https://wattle-shade.example.org/supplier/profile';
  const sites = new Map([
    [
      nsw,
      [
        'PAMIDO PTY LTD',
        'A NSW Government website. This supplier has self-identified in the following products and services.',
        'At Pamido, we manufacture premium window furnishings.',
      ],
    ],
    [
      second,
      [
        'Wattle Shade Pty Ltd',
        'Supplier directory. Further information on this supplier is available to registered buyers.',
        'Wattle Shade Pty Ltd supplies custom roller blinds for building windows.',
      ],
    ],
    [
      official,
      [
        'Wattle Shade Pty Ltd',
        'About our company: Wattle Shade Pty Ltd.',
        'Wattle Shade Pty Ltd supplies custom roller blinds for building windows.',
      ],
    ],
  ]);
  const requests = [];
  const { make } = fixture();
  const fetchImpl = async (url, options) => {
    if (url === 'https://api.tavily.com/search')
      return json({ results: [...sites].map(([url, [title]]) => ({ url, title })) });
    if (url !== 'https://api.deepseek.com/responses') assert.fail('Unexpected external request');
    const payload = JSON.parse(JSON.parse(options.body).input[1].content);
    const source = payload.pages?.[0].source_url || payload.company?.website;
    requests.push(source);
    if (payload.sources)
      return json({
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: {
                  result: 'relevant',
                  sources: payload.sources.map((s) => s.i),
                  reason: '经营窗饰',
                },
              },
            ],
          },
        ],
      });
    const [name, , productQuote] = sites.get(source);
    const evidence = (value, quote) => ({ value, quote, source_url: source });
    return json({
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: {
                company_name: evidence(name, name),
                entity_type: evidence('business', name),
                products: [
                  {
                    ...evidence(
                      source === nsw ? 'window furnishings' : 'roller blinds',
                      productQuote,
                    ),
                    window_use: 'window_covering',
                  },
                ],
                admission_facts: [evidence('complete_supply', productQuote)],
              },
            },
          ],
        },
      ],
    });
  };
  const native = make({
    env: { TAVILY_API_KEY: 'fixture-search', DEEPSEEK_API_KEY: 'fixture-model' },
    fetchImpl,
    readPage: async (url) => {
      const values = sites.get(url.href);
      if (!values) return { html: '<p>Welcome</p>' };
      const [name, identity, quote] = values;
      return { html: '<h1>' + name + '</h1><p>' + identity + '</p><p>' + quote + '</p>' };
    },
  });
  await withApp(
    {
      env: { TAVILY_API_KEY: 'fixture-search', DEEPSEEK_API_KEY: 'fixture-model' },
      nativeImpl: native,
      fetchImpl,
    },
    async (base) => {
      const jobs = base + '/api/v1/acquisition/jobs';
      const created = await fetch(jobs, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'supplier-profile-custody',
        },
        body: JSON.stringify({
          country: 'Australia',
          product_scope: 'all',
          query_mode: 'auto',
          target_count: 4,
        }),
      });
      assert.equal(created.status, 202);
      const { id } = await created.json();
      let job;
      for (let n = 0; n < 100; n++) {
        job = await (await fetch(jobs + '/' + id)).json();
        if (job.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.deepEqual(
        job.rows.map((row) => [row.source_url, row.result]),
        [
          [nsw, 'review'],
          [second, 'review'],
          [official, 'inserted'],
        ],
      );
      const archive = await (await fetch(base + '/api/v1/leads/real/list')).json();
      assert.deepEqual(
        archive.leads.map(({ website, name }) => [website, name]),
        [[official, 'Wattle Shade Pty Ltd']],
      );
      assert.deepEqual(requests, [official, official]);
    },
  );
});
