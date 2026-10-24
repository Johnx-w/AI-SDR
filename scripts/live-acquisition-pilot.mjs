// Explicit, bounded live acceptance run. No outreach or connection changes.
// Usage: node --env-file-if-exists=.env scripts/live-acquisition-pilot.mjs baseline|observe|start <lane>
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { connectionEnvironment } from '../server/api-connections.mjs';
import { researchProviderConfig } from '../server/acquisition-config.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { customsSearchPlan } from '../server/customs-products.mjs';
import { validateInput } from '../server/app.mjs';
import { fieldText } from '../server/feishu.mjs';

const env = connectionEnvironment();
const config = researchProviderConfig(env);
const root = resolve('.data/live-acquisition-pilot-20261024');
const api = 'http://127.0.0.1:4311/api/v1';
const plans = [
  ['fabrics-ca', 'Canada', 'roller blind fabric, sunscreen fabric, zebra blind fabric'],
  ['components-us', 'United States', 'blind components, roller blind clutch, basswood slat'],
  ['shutters-us', 'United States', 'plantation shutters'],
].map(([lane, country, product]) => ({
  lane,
  key: `live-pilot-20261024-${lane}`,
  input: {
    country,
    region: '',
    product,
    product_scope: 'specific',
    query_mode: 'auto',
    acquisition_channel: 'customs',
    customs_record_budget: 20,
    audience: 'BC',
    target_count: 1,
  },
}));

async function json(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(45000),
    ...options,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${new URL(url).pathname}`);
  return response.json();
}
async function meters() {
  const at = new Date().toISOString();
  const read = async (url, key, project) => {
    try {
      return project(await json(url, { headers: { Authorization: `Bearer ${key}` } }));
    } catch (error) {
      return { unavailable: true, error: error.message };
    }
  };
  const tavily =
    config.web.provider === 'tavily'
      ? await read(`${config.web.baseUrl}/usage`, config.web.apiKey, (v) => ({
          key: v.key,
          account: v.account,
        }))
      : { unavailable: true, reason: 'not_tavily' };
  const deepseek =
    config.model.provider === 'deepseek'
      ? await read(`${config.model.baseUrl}/user/balance`, config.model.apiKey, (v) => ({
          is_available: v.is_available,
          balance_infos: v.balance_infos,
        }))
      : { unavailable: true, reason: 'not_deepseek' };
  let customs;
  try {
    const v = await json('https://tradedata.billofladingdata.com/partner-api/credit-usage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': env.CUSTOMS_API_KEY || env.BILLOFLADINGDATA_API_KEY,
      },
      body: '{}',
    });
    customs = { code: v.code, credits: v.data?.credits, usage: v.data?.usage };
  } catch (error) {
    customs = { unavailable: true, error: error.message };
  }
  return { at, tavily, deepseek, customs };
}
function localEvidence() {
  const path =
    env.CUSTOMS_DB_PATH ||
    env.ACQUISITION_DB_PATH ||
    env.BATCH_DB_PATH ||
    '.data/acquisition.sqlite';
  if (!existsSync(path)) return { pages: [], cursors: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = (table) => {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
      return [];
    return db.prepare(`SELECT * FROM ${table}`).all();
  };
  const output = {
    pages: rows('customs_pages').map((r) => ({ id: r.id, ...JSON.parse(r.data) })),
    cursors: rows('customs_cursors').map((r) => ({ id: r.id, ...JSON.parse(r.data) })),
    customsEvidence: rows('customs_company_evidence').map((r) => JSON.parse(r.data)),
    operations: rows('acquisition_operations').map((r) => JSON.parse(r.data)),
  };
  db.close();
  return output;
}
function save(name, data) {
  mkdirSync(root, { recursive: true });
  const path = resolve(root, name);
  writeFileSync(path, JSON.stringify(data, null, 2), { flag: 'wx' });
  return path;
}
const [command, lane] = process.argv.slice(2);
if (command === 'baseline') {
  if (existsSync(resolve(root, 'baseline.json')))
    throw new Error('Baseline exists; observe instead.');
  const jobs = await json(`${api}/acquisition/jobs`);
  if (jobs.jobs.some((j) => ['running', 'stopping', 'paused'].includes(j.status)))
    throw new Error('Active job exists.');
  const leads = await json(`${api}/leads/real`);
  const records = await new FeishuClient({ env }).records();
  const models = await json(`${config.model.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.model.apiKey}` },
  });
  const metering = await meters();
  const data = {
    at: new Date().toISOString(),
    plans,
    meters: metering,
    leads,
    records,
    jobs,
    model: {
      provider: config.model.provider,
      model: config.model.model,
      available: models.data?.some((m) => m.id === config.model.model) === true,
    },
    local: localEvidence(),
  };
  const path = save('baseline.json', data);
  console.log(
    JSON.stringify(
      {
        path,
        records: records.length,
        model: data.model,
        meters: metering,
        customsPages: data.local.pages.map(({ id, status, query }) => ({ id, status, query })),
        cursors: data.local.cursors,
        plans,
      },
      null,
      2,
    ),
  );
} else if (['start', 'start-v2'].includes(command)) {
  const baseline = JSON.parse(readFileSync(resolve(root, 'baseline.json'), 'utf8'));
  const storedPlan = baseline.plans.find((p) => p.lane === lane);
  const plan = storedPlan
    ? { ...storedPlan, key: storedPlan.key + (command === 'start-v2' ? '-v2' : '') }
    : null;
  if (!plan) throw new Error('Unknown lane');
  if (!baseline.model.available) throw new Error('Model unavailable at baseline');
  const authorization = JSON.parse(readFileSync(resolve(root, 'authorization.json'), 'utf8'));
  const customsBaseline = JSON.parse(readFileSync(resolve(root, 'customs-baseline.json'), 'utf8'));
  const before = await meters();
  const credit = before.customs?.credits?.data_credits;
  const cap = authorization.customs_credit_cap_for_entire_pilot;
  const budget = plan.input.customs_record_budget;
  if (
    !credit ||
    before.customs.code !== 200 ||
    ![
      credit.total,
      credit.used,
      credit.remaining,
      customsBaseline.total_data_credits,
      customsBaseline.data_credits_used,
      cap,
      budget,
    ].every((v) => Number.isSafeInteger(v) && v >= 0) ||
    cap < 1 ||
    cap > 500 ||
    budget !== 20 ||
    credit.used + credit.remaining !== credit.total ||
    customsBaseline.data_credits_used > customsBaseline.total_data_credits ||
    credit.total !== customsBaseline.total_data_credits ||
    credit.remaining < budget
  )
    throw new Error('Cannot verify customs credit cap against account meter.');
  const consumed = credit.used - customsBaseline.data_credits_used;
  if (consumed < 0 || consumed + budget > cap)
    throw new Error('The next job could exceed the authorized cumulative customs credit cap.');
  save(`meter-before-${lane}-${randomUUID()}.json`, before);
  const job = await json(`${api}/acquisition/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': plan.key,
    },
    body: JSON.stringify(plan.input),
  });
  save(`${command}-${lane}-${randomUUID()}.json`, job);
  console.log(JSON.stringify(job, null, 2));
} else if (command === 'quarantine-invalid') {
  const id = 'reczz28R6bOYYebh';
  const baseline = JSON.parse(readFileSync(resolve(root, 'baseline.json'), 'utf8'));
  if (baseline.records.some((r) => r.record_id === id))
    throw new Error('Never quarantine a baseline customer.');
  const jobs = await json(`${api}/acquisition/jobs`);
  if (jobs.jobs.some((j) => ['running', 'stopping', 'paused'].includes(j.status)))
    throw new Error('An active job must be reconciled first.');
  const client = new FeishuClient({ env });
  const recordsBefore = await client.records();
  const recordBefore = recordsBefore.find((r) => r.record_id === id);
  if (
    !recordBefore ||
    fieldText(recordBefore.fields['来源链接']) !==
      'https://importkey.com/i/2557697-ontario-corp-blind-and-shu'
  )
    throw new Error(
      'Invalid pilot record does not exactly match the confirmed third-party source.',
    );
  const historyBefore = await json(`${api}/leads/real/${id}/assessments`);
  const archive = save(`invalid-source-before-${randomUUID()}.json`, {
    at: new Date().toISOString(),
    recordBefore,
    recordsBefore,
    historyBefore,
  });
  console.log(JSON.stringify({ stage: 'archived_invalid_pilot_record', id, archive }));
  const output = await json(`${api}/leads/real/${id}/assessments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'live-pilot-20261024-isolate-importkey',
    },
    body: JSON.stringify({ country: 'Canada', product: plans[0].input.product }),
  });
  const recordsAfter = await client.records();
  const recordAfter = recordsAfter.find((r) => r.record_id === id);
  const historyAfter = await json(`${api}/leads/real/${id}/assessments`);
  const byId = new Map(
    recordsBefore
      .filter((r) => r.record_id !== id)
      .map((r) => [r.record_id, JSON.stringify(r.fields)]),
  );
  const otherRecordsUnchanged = recordsAfter
    .filter((r) => r.record_id !== id)
    .every((r) => byId.get(r.record_id) === JSON.stringify(r.fields));
  const changedFields = [
    ...new Set([...Object.keys(recordBefore.fields), ...Object.keys(recordAfter.fields)]),
  ].filter(
    (key) => JSON.stringify(recordBefore.fields[key]) !== JSON.stringify(recordAfter.fields[key]),
  );
  const path = save(`invalid-source-quarantine-${randomUUID()}.json`, {
    at: new Date().toISOString(),
    archive,
    output,
    recordBefore,
    recordAfter,
    historyBefore,
    historyAfter,
    otherRecordsUnchanged,
    changedFields,
  });
  console.log(
    JSON.stringify(
      {
        path,
        id,
        grade: fieldText(recordAfter.fields['用户评级']),
        reason: fieldText(recordAfter.fields['评级依据']),
        changedFields,
        otherRecordsUnchanged,
        output,
        recordDeleted: false,
      },
      null,
      2,
    ),
  );
} else if (command === 'search-probe') {
  if (config.web.provider !== 'tavily')
    throw new Error('This fixed billing probe requires the configured Tavily provider.');
  const results = [];
  for (const query of [
    '"TRIBUTE WINDOW COVERINGS" Canada official website',
    '"ZMC WINDOW COVERING" official website',
  ]) {
    const response = await json(`${config.web.baseUrl}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.web.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        auto_parameters: false,
        include_usage: true,
      }),
    });
    results.push({
      query,
      usage: response.usage,
      results: response.results.map(({ url, title, score }) => ({ url, title, score })),
    });
  }
  const path = save(`short-query-probe-${randomUUID()}.json`, {
    at: new Date().toISOString(),
    results,
  });
  console.log(JSON.stringify({ path, results }, null, 2));
} else if (command === 'dedupe-signature') {
  const site = 'https://www.signaturewindowcoverings.com/';
  const client = new FeishuClient({ env });
  const before = await client.records();
  const matches = before.filter((r) =>
    JSON.stringify(r.fields).includes('signaturewindowcoverings.com'),
  );
  if (matches.length !== 1)
    throw new Error('Expected one existing Signature company before dedupe verification.');
  const trace = [];
  const readOnlyFetch = async (url, options = {}) => {
    const u = new URL(url);
    trace.push({
      host: u.hostname,
      path: u.pathname.replace(
        /\/bitable\/v1\/apps\/[^/]+\/tables\/[^/]+/,
        '/bitable/v1/apps/[redacted]/tables/[redacted]',
      ),
      method: options.method || 'GET',
    });
    if (
      u.hostname !== 'open.feishu.cn' ||
      ((options.method || 'GET') !== 'GET' &&
        !u.pathname.endsWith('/auth/v3/tenant_access_token/internal'))
    )
      throw new Error(
        'Dedupe probe permits Feishu reads/auth only; no model, search, or remote mutation.',
      );
    return fetch(url, options);
  };
  const native = new NativeAcquisition({
    env: { ...env, BATCH_DB_PATH: env.BATCH_DB_PATH || '.data/acquisition.sqlite' },
    fetchImpl: readOnlyFetch,
    readPage: async () => {
      throw new Error('Website reads forbidden during remote-read-only dedupe verification.');
    },
  });
  let output;
  try {
    const input = {
      ...validateInput(plans.find((p) => p.lane === 'components-us').input),
      target_count: 1,
    };
    output = await native.research(input, {
      source_url: site,
      source_kind: 'customs',
      operation_id: 'live-pilot-20261024-dedupe-signature',
    });
  } finally {
    native.close();
  }
  const after = await client.records();
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  const unchanged = JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
  const path = save(`dedupe-signature-${randomUUID()}.json`, {
    at: new Date().toISOString(),
    before,
    after,
    unchanged,
    output,
    trace,
  });
  console.log(
    JSON.stringify(
      {
        path,
        beforeCount: before.length,
        afterCount: after.length,
        unchanged,
        existingRecord: matches[0].record_id,
        output,
        trace,
      },
      null,
      2,
    ),
  );
} else if (command === 'replay') {
  // Online recheck of the exact already-paid page after a deterministic filter
  // repair. Real web/model/Feishu calls, but forbid ANY fresh customs page call.
  const baseline = JSON.parse(readFileSync(resolve(root, 'baseline.json'), 'utf8'));
  const plan = baseline.plans.find((p) => p.lane === lane);
  if (!plan) throw new Error('Unknown lane');
  const active = (await json(`${api}/acquisition/jobs`)).jobs.some((j) =>
    ['running', 'stopping', 'paused'].includes(j.status),
  );
  if (active) throw new Error('Finish or reconcile the active API job first.');
  // Keep the same complete target snapshot as the real API job so transport-only
  // differences in this verification harness do not invalidate exact reuse.
  const input = { ...validateInput(plan.input), target_count: plan.input.target_count };
  const search = customsSearchPlan(input)[0];
  const family = search.family;
  const page = localEvidence().pages.find(
    (p) =>
      p.status === 'complete' &&
      p.query.family === family &&
      p.query.page_no === 1 &&
      p.query.page_size === 20 &&
      p.query.date_range?.end_date === baseline.at.slice(0, 10) &&
      p.query.scope_version === search.scope_version &&
      JSON.stringify(p.query.products) === JSON.stringify(search.products) &&
      JSON.stringify(p.query.source_markets) === JSON.stringify(search.source_markets) &&
      !p.query.hs_codes?.length &&
      p.result.records.every((r) => r.provider === 'billofladingdata'),
  );
  if (!page)
    throw new Error(
      'No complete first-page cache; this command never pays for another customs page.',
    );
  const trace = [];
  const tracedFetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/shipping-records'))
      throw new Error('Fresh customs calls forbidden during cached online replay');
    if (parsed.hostname === 'api.tavily.com' && ['/search', '/extract'].includes(parsed.pathname)) {
      // Official opt-in billing telemetry; does not change search depth/content.
      options = {
        ...options,
        body: JSON.stringify({ ...JSON.parse(options.body), include_usage: true }),
      };
    }
    const measured = ['/search', '/extract', '/responses', '/chat/completions'].some((p) =>
      parsed.pathname.endsWith(p),
    );
    const entry = measured
      ? { host: parsed.hostname, path: parsed.pathname, started_at: new Date().toISOString() }
      : null;
    if (entry) trace.push(entry);
    const response = await fetch(url, options);
    if (entry) {
      entry.status = response.status;
      try {
        const data = await response.clone().json();
        entry.usage = data.usage;
        entry.model = data.model;
        if (parsed.pathname.endsWith('/search')) {
          entry.query = JSON.parse(options.body).query;
          entry.results = data.results?.map((r) => ({
            url: r.url,
            title: r.title,
            score: r.score,
          }));
        }
      } catch {
        /* No upstream body is logged. */
      }
    }
    return response;
  };
  const native = new NativeAcquisition({
    env: { ...env, BATCH_DB_PATH: env.BATCH_DB_PATH || '.data/acquisition.sqlite' },
    fetchImpl: tracedFetch,
  });
  const runId = `live-pilot-20261024-replay-${lane}`;
  const before = await meters();
  const results = [];
  let found;
  try {
    found = await native.discoverShipments(
      input,
      { ...customsSearchPlan(input)[0], ...page.query, run_id: runId, remaining_budget: 20 },
      [],
    );
    for (const item of found.candidates.slice(0, 5)) {
      const index = results.length + 1;
      console.log(
        JSON.stringify({
          stage: 'research',
          index,
          buyer: item.customs_evidence?.name,
          website: item.source_url,
        }),
      );
      const result = await native.research(input, { ...item, operation_id: `${runId}-${index}` });
      results.push({ item, output: result });
      save(`replay-checkpoint-${lane}-${index}-${randomUUID()}.json`, {
        runId,
        lane,
        before,
        found,
        results,
        trace,
      });
      console.log(
        JSON.stringify({
          stage: 'result',
          index,
          inserted: result.新增,
          updated: result.更新,
          reason: result.reason,
          outcome: result.outcome,
          rows: result.明细,
          usage: result.research_usage,
        }),
      );
      if (result.新增 === 1) break;
    }
  } finally {
    native.close();
  }
  const after = await meters();
  const path = save(`replay-${lane}-${randomUUID()}.json`, {
    runId,
    lane,
    before,
    after,
    found,
    results,
    trace,
  });
  console.log(
    JSON.stringify(
      {
        path,
        before,
        after,
        customsUsage: found.usage,
        candidates: found.candidates.map((c) => ({
          buyer: c.customs_evidence?.name,
          website: c.source_url,
        })),
        reviewed: found.review_candidates.map((c) => ({ buyer: c.name, reason: c.reason })),
        trace,
      },
      null,
      2,
    ),
  );
} else if (command === 'observe') {
  const jobs = await json(`${api}/acquisition/jobs`);
  const pilotJobs = jobs.jobs.filter((j) => j.createdAt >= '2026-10-24T00:00:00Z');
  const leads = await json(`${api}/leads/real`);
  const records = await new FeishuClient({ env }).records();
  const baseline = JSON.parse(readFileSync(resolve(root, 'baseline.json'), 'utf8'));
  const prior = new Map(baseline.records.map((r) => [r.record_id, r]));
  const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const added = records.filter((r) => !prior.has(r.record_id));
  const changed = records.filter(
    (r) => prior.has(r.record_id) && digest(r.fields) !== digest(prior.get(r.record_id).fields),
  );
  const data = {
    at: new Date().toISOString(),
    meters: await meters(),
    jobs: pilotJobs,
    leads,
    records,
    added,
    changed,
    local: localEvidence(),
  };
  const path = save(`observe-${Date.now()}-${randomUUID()}.json`, data);
  console.log(
    JSON.stringify(
      {
        path,
        meters: data.meters,
        total: records.length,
        added: added.map((r) => r.record_id),
        changed: changed.map((r) => r.record_id),
        jobs: pilotJobs.map((j) => ({
          id: j.id,
          country: j.input.country,
          product: j.input.product,
          status: j.status,
          reason: j.reason,
          inserted: j.inserted,
          updated: j.updated,
          researched: j.researched,
          rejected: j.rejected,
          review: j.review,
          failed: j.failed,
          queued: j.queued,
          customsUsedRecords: j.customsUsedRecords,
          researchUsage: j.researchUsage,
          current: j.current
            ? { website: j.current.source_url, operation_id: j.current.operation_id }
            : null,
          rows: j.rows.map(({ customs_evidence, ...row }) => row),
          searchStats: j.searchStats.map((s) => ({
            status: s.status,
            family: s.family,
            discovered: s.discovered,
            duplicates: s.duplicates,
            returned_records: s.usage?.returned_records,
            charged_records: s.usage?.charged_records,
            cache_hits: s.usage?.cache_hits,
            web_search_calls: s.usage?.web_search_calls,
            web_search_credits: s.usage?.web_search_credits,
          })),
        })),
      },
      null,
      2,
    ),
  );
} else throw new Error('Use baseline, observe, start <lane>, or replay <lane>.');
