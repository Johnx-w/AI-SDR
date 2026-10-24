// Bounded, standard-API live acceptance. Only `start` starts paid work/writes.
// baseline [directory] | start <directory> <lane> | observe <directory> | finalize <directory>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { connectionEnvironment } from '../server/api-connections.mjs';
import { researchProviderConfig, acquisitionConfig } from '../server/acquisition-config.mjs';
import { customsConfig } from '../server/customs-provider.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { fieldText } from '../server/feishu.mjs';
import { domainKey } from '../server/website-identity.mjs';
import { normalizeCountry } from '../server/relevance.mjs';
import { validateInput } from '../server/app.mjs';

const isEntryPoint =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
// Pure verifier imports (including tests) do not load local account credentials.
const env = isEntryPoint ? connectionEnvironment() : {};
const config = researchProviderConfig(env);
const api = `http://127.0.0.1:${Number(env.PORT || 4311)}/api/v1`;
const dataRoot = resolve('.data');
const invalidId = 'reczz28R6bOYYebh';
const recordBudget = 20;
const totalRecordCap = 60;
const researchBudget = 4;
const terminal = new Set(['completed', 'partial']);
const lanes = [
  ['fabrics-ca', 'Canada', 'roller blind fabric, sunscreen fabric, zebra blind fabric'],
  ['components-us', 'United States', 'blind components, roller blind clutch, basswood slat'],
  ['shutters-us', 'United States', 'plantation shutters'],
];
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const connectionFingerprint = () =>
  digest([
    config.web.baseUrl,
    config.web.apiKey,
    config.model.baseUrl,
    config.model.apiKey,
    env.CUSTOMS_API_KEY || env.BILLOFLADINGDATA_API_KEY,
    env.FEISHU_APP_TOKEN,
    env.FEISHU_TABLE_ID,
  ]);
const modelIdentity = () => ({
  provider: config.model.provider,
  model: config.model.model,
  reasoningEffort: config.model.reasoningEffort ?? 'none',
  maxOutputTokens: config.model.maxOutputTokens,
});
const plain = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();

function runDirectory(value) {
  const directory = resolve(value || '');
  const path = relative(dataRoot, directory);
  if (
    !value ||
    path.startsWith('..') ||
    isAbsolute(path) ||
    !/^dual-handoff-acceptance-20261024-[\w-]+$/.test(basename(directory)) ||
    path !== basename(directory)
  )
    throw new Error(
      'Acceptance directory must be a dedicated .data/dual-handoff-acceptance-20261024-* folder.',
    );
  return directory;
}
function read(directory, name) {
  return JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
}
function save(directory, name, value) {
  const path = resolve(directory, name);
  writeFileSync(path, JSON.stringify(value, null, 2), { flag: 'wx' });
  return path;
}
function checkpoint(directory, prefix, value) {
  return save(directory, `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.json`, value);
}
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
  const safe = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      return { unavailable: true, error: error.message };
    }
  };
  const [tavily, deepseek, customs] = await Promise.all([
    safe(async () => {
      if (config.web.provider !== 'tavily') return { unavailable: true, reason: 'not_tavily' };
      const v = await json(`${config.web.baseUrl}/usage`, {
        headers: { Authorization: `Bearer ${config.web.apiKey}` },
      });
      // Never persist the upstream key object, account identifiers or secrets.
      return Object.fromEntries(
        ['current_plan', 'plan_usage', 'plan_limit', 'search_usage', 'extract_usage', 'paygo_usage']
          .filter((k) => v.account?.[k] !== undefined)
          .map((k) => [k, v.account[k]]),
      );
    }),
    safe(async () => {
      if (config.model.provider !== 'deepseek')
        return { unavailable: true, reason: 'not_deepseek' };
      const v = await json(`${config.model.baseUrl}/user/balance`, {
        headers: { Authorization: `Bearer ${config.model.apiKey}` },
      });
      return {
        is_available: v.is_available === true,
        balances: (v.balance_infos || []).map((b) => ({
          currency: b.currency,
          total_balance: b.total_balance,
        })),
      };
    }),
    safe(async () => {
      const v = await json('https://tradedata.billofladingdata.com/partner-api/credit-usage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': env.CUSTOMS_API_KEY || env.BILLOFLADINGDATA_API_KEY,
        },
        body: '{}',
      });
      const c = v.data?.credits?.data_credits;
      return {
        code: v.code,
        data_credits: c && { total: c.total, used: c.used, remaining: c.remaining },
        shipping_record_views: v.data?.usage?.shipping_record_views,
        company_profile_views: v.data?.usage?.company_profile_views,
      };
    }),
  ]);
  return { at: new Date().toISOString(), tavily, deepseek, customs };
}
function checkCreditMeter(value) {
  const c = value.customs?.data_credits;
  if (
    value.customs.code !== 200 ||
    !c ||
    ![c.total, c.used, c.remaining].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    c.used + c.remaining !== c.total
  )
    throw new Error('Cannot verify the official customs credit meter; no job started.');
  return c;
}
function recordIndex(records) {
  return records.map((r) => ({
    id: r.record_id,
    domain: domainKey(fieldText(r.fields?.['来源链接'])),
    fields_digest: digest(r.fields),
  }));
}
function invalidRecord(records) {
  const r = records.find((entry) => entry.record_id === invalidId);
  return r
    ? {
        id: invalidId,
        source_url: fieldText(r.fields?.['来源链接']),
        grade: fieldText(r.fields?.['用户评级']),
        development_status: fieldText(r.fields?.['开发状态']),
        recommendation:
          'Known third-party source retained as temporarily not for development; preserved for audit and excluded from newly captured companies.',
      }
    : null;
}
function localRows(
  table,
  where,
  values = [],
  path = env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || '.data/acquisition.sqlite',
) {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
      return [];
    return db
      .prepare(`SELECT data FROM ${table} ${where}`)
      .all(...values)
      .map((r) => JSON.parse(r.data));
  } finally {
    db.close();
  }
}
const localJob = (key) =>
  localRows('jobs', 'WHERE idem=?', [key], env.BATCH_DB_PATH || '.data/acquisition.sqlite')[0];
const localOperation = (id) => localRows('acquisition_operations', 'WHERE id=?', [id])[0];
function safeJob(job) {
  return {
    id: job.id,
    input: job.input,
    status: job.status,
    reason: job.reason,
    target: job.target,
    countPolicy: job.countPolicy,
    inserted: job.inserted,
    qualified: job.qualified,
    updated: job.updated,
    researched: job.researched,
    rejected: job.rejected,
    review: job.review,
    failed: job.failed,
    pending: job.pending,
    queued: job.queued,
    limits: job.limits,
    customsUsedRecords: job.customsUsedRecords,
    researchUsage: job.researchUsage,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    current: job.current && {
      source_url: job.current.source_url,
      operation_id: job.current.operation_id,
    },
    rows: job.rows,
    searchStats: job.searchStats,
  };
}
function verifyIdentity(baseline) {
  if (baseline.connection_fingerprint !== connectionFingerprint())
    throw new Error('Connections changed after this baseline; create a new acceptance baseline.');
  if (digest(baseline.model) !== digest(modelIdentity()))
    throw new Error('Research model or reasoning effort changed after this baseline.');
}
async function snapshot(directory) {
  const baseline = read(directory, 'baseline.json');
  verifyIdentity(baseline);
  const jobs = [];
  for (const plan of baseline.plans) {
    const receipt = resolve(directory, `started-${plan.lane}.json`);
    const id = existsSync(receipt)
      ? read(directory, `started-${plan.lane}.json`).job_id
      : localJob(plan.key)?.id;
    if (id) jobs.push({ lane: plan.lane, ...safeJob(await json(`${api}/acquisition/jobs/${id}`)) });
  }
  const records = await new FeishuClient({ env }).records();
  return {
    at: new Date().toISOString(),
    model: modelIdentity(),
    jobs,
    records: recordIndex(records),
    known_invalid_record: invalidRecord(records),
    meters: await meters(),
  };
}
// A live acceptance row is a newly read-back business record with evidence for
// the intended market and product. Contacts, D completeness, and an A/B score
// are deliberately not prerequisites for counting the captured lead.
export function verifyCapturedCompany({
  row = {},
  research = {},
  assessment = null,
  job = {},
  baseline = { records: [] },
} = {}) {
  const domain = domainKey(row.source_url);
  const checks = {
    new_record: row.result === 'inserted' && row.inserted_new === true,
    record_id_present: typeof row.record_id === 'string' && !!row.record_id,
    outside_preexisting_baseline: !baseline.records.some(
      (r) => r.id === row.record_id || (domain && r.domain === domain),
    ),
    official_website_domain:
      !!domain &&
      !/importkey|importinfo|importgenius|panjiva|volza|trademo|mapquest|trustpilot|yellowpages/i.test(
        domain,
      ),
    business_entity: research.entity_type === 'business',
    expected_country:
      normalizeCountry(research.actual_country) === normalizeCountry(job.input?.country) &&
      research.country_match === 'matched',
    relevant_product_line: research.product_match === 'matched',
    identity_has_original_source:
      !!research.company_identity?.name &&
      ['legal_name_self_reported', 'website_name_only'].includes(
        research.company_identity.status,
      ) &&
      research.company_identity.evidence?.some(
        (fact) => domainKey(fact.source_url) === domain && plain(fact.quote),
      ),
  };
  const passed = Object.values(checks).every(Boolean);
  return {
    passed,
    verification_status: passed ? 'passed' : 'failed',
    checks,
    id: row.record_id,
    domain,
    name: research.company_name || row.name,
    source_kind: row.source_kind || 'web',
    operation_id: row.operation_id,
    country: research.actual_country || null,
    product_match: research.product_match || null,
    grade: assessment?.grade || null,
    score: assessment?.score ?? null,
    direction: assessment?.direction || null,
    product: assessment?.product || null,
    missing: assessment?.missing || [],
  };
}
function verifyIncluded(row, job, baseline) {
  const op = row.operation_id ? localOperation(row.operation_id) : null;
  return verifyCapturedCompany({
    row,
    research: op?.research || op?.output?.research || {},
    assessment: op?.assessment || op?.output?.assessment || row.assessment,
    job,
    baseline,
  });
}

const [command, directoryArgument, lane] = isEntryPoint ? process.argv.slice(2) : [];
if (isEntryPoint && command === 'baseline') {
  if (!acquisitionConfig(env).nativeReady || !customsConfig(env).configured)
    throw new Error(
      'Native acquisition, research and customs must be configured before acceptance.',
    );
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const directory = runDirectory(
    directoryArgument || resolve('.data', `dual-handoff-acceptance-20261024-${stamp}`),
  );
  if (existsSync(directory))
    throw new Error('Use a fresh acceptance directory; existing evidence is never overwritten.');
  const jobs = (await json(`${api}/acquisition/jobs`)).jobs;
  if (jobs.some((j) => ['running', 'stopping', 'paused'].includes(j.status)))
    throw new Error('An unfinished job exists; reconcile it before creating this baseline.');
  const plans = lanes.map(([name, country, product]) => ({
    lane: name,
    key: `dual-handoff-${stamp}-${name}`,
    input: {
      country,
      region: '',
      product,
      product_scope: 'specific',
      query_mode: 'auto',
      acquisition_channel: 'dual',
      customs_record_budget: recordBudget,
      research_budget: researchBudget,
      target_count: 1,
      audience: 'BC',
    },
  }));
  for (const plan of plans) {
    if (validateInput(plan.input).research_budget !== researchBudget)
      throw new Error(
        'The local input contract does not preserve research_budget; finish the API change first.',
      );
  }
  const catalogue = await json(`${config.model.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.model.apiKey}` },
  });
  const availableModels = catalogue.data?.map((m) => m.id) || [];
  if (!availableModels.includes(config.model.model))
    throw new Error('The configured research model is absent from its live model catalogue.');
  const records = await new FeishuClient({ env }).records();
  const metering = await meters();
  if (checkCreditMeter(metering).remaining < totalRecordCap)
    throw new Error('The current customs balance cannot cover this bounded three-lane run.');
  mkdirSync(directory, { recursive: false });
  const baseline = {
    at: new Date().toISOString(),
    connection_fingerprint: connectionFingerprint(),
    model: modelIdentity(),
    available_models: availableModels,
    plans,
    safety_limits: {
      total_customs_record_cap: totalRecordCap,
      records_per_lane: recordBudget,
      research_per_lane: researchBudget,
      note: 'Bounded small-batch acceptance scope, not a company spending restriction.',
    },
    records: recordIndex(records),
    known_invalid_record: invalidRecord(records),
    meters: metering,
    starting_job_ids: jobs.map((j) => j.id),
  };
  const path = save(directory, 'baseline.json', baseline);
  console.log(
    JSON.stringify(
      {
        directory,
        path,
        record_count: records.length,
        model: baseline.model,
        meters: metering,
        plans,
        known_invalid_record: baseline.known_invalid_record,
      },
      null,
      2,
    ),
  );
} else if (isEntryPoint && command === 'start') {
  const directory = runDirectory(directoryArgument);
  const baseline = read(directory, 'baseline.json');
  verifyIdentity(baseline);
  const plan = baseline.plans.find((p) => p.lane === lane);
  if (!plan) throw new Error('Choose fabrics-ca, components-us or shutters-us.');
  const existing = localJob(plan.key);
  if (existing) {
    const job = await json(`${api}/acquisition/jobs/${existing.id}`);
    if (!existsSync(resolve(directory, `started-${lane}.json`)))
      save(directory, `started-${lane}.json`, {
        at: new Date().toISOString(),
        lane,
        key: plan.key,
        job_id: job.id,
        recovered: true,
      });
    console.log(JSON.stringify({ recovered_existing_job: true, job: safeJob(job) }, null, 2));
  } else {
    const jobs = (await json(`${api}/acquisition/jobs`)).jobs;
    if (jobs.some((j) => ['running', 'stopping', 'paused'].includes(j.status)))
      throw new Error('An unfinished job exists; no parallel acceptance job was started.');
    const before = await meters();
    const credit = checkCreditMeter(before);
    const first = checkCreditMeter(baseline.meters);
    const used = credit.used - first.used;
    if (
      credit.total !== first.total ||
      used < 0 ||
      used + plan.input.customs_record_budget > totalRecordCap ||
      credit.remaining < plan.input.customs_record_budget
    )
      throw new Error(
        'The next job could exceed this acceptance run scope or its official meter cannot be reconciled.',
      );
    checkpoint(directory, `before-${lane}`, {
      at: new Date().toISOString(),
      meters: before,
      input: plan.input,
      key: plan.key,
    });
    const job = await json(`${api}/acquisition/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': plan.key },
      body: JSON.stringify(plan.input),
    });
    save(directory, `started-${lane}.json`, {
      at: new Date().toISOString(),
      lane,
      key: plan.key,
      job_id: job.id,
    });
    if (job.limits?.research !== researchBudget || job.input.acquisition_channel !== 'dual') {
      await json(`${api}/acquisition/jobs/${job.id}/stop`, { method: 'POST' });
      throw new Error(
        'The running server did not honor the bounded dual/research contract; the new job was stopped.',
      );
    }
    console.log(JSON.stringify({ directory, job: safeJob(job) }, null, 2));
  }
} else if (isEntryPoint && (command === 'observe' || command === 'finalize')) {
  const directory = runDirectory(directoryArgument);
  const state = await snapshot(directory);
  if (command === 'observe') {
    const path = checkpoint(directory, 'observe', state);
    console.log(
      JSON.stringify(
        {
          path,
          at: state.at,
          model: state.model,
          meters: state.meters,
          record_count: state.records.length,
          jobs: state.jobs.map(({ rows, searchStats, ...j }) => ({
            ...j,
            row_count: rows.length,
            source_searches: searchStats.map((s) => ({
              source_kind: s.source_kind || 'web',
              status: s.status,
              discovered: s.discovered,
              usage: s.usage,
            })),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    const baseline = read(directory, 'baseline.json');
    const results = state.jobs.map((j) => {
      const counted = j.rows.filter((r) => r.inserted_new === true && r.result === 'inserted');
      const verified = counted.map((r) => verifyIncluded(r, j, baseline));
      const observedSources = [
        ...new Set(
          j.searchStats.filter((s) => s.status === 'completed').map((s) => s.source_kind || 'web'),
        ),
      ];
      const checks = {
        terminal: terminal.has(j.status),
        target_reached: j.status === 'completed' && j.reason === 'target_reached',
        inserted_target_reached: Number.isInteger(j.inserted) && j.inserted >= j.target,
        count_matches_rows: counted.length === j.inserted,
        customs_and_web_executed: ['customs', 'web'].every((s) => observedSources.includes(s)),
        every_counted_enterprise_verified: verified.length > 0 && verified.every((v) => v.passed),
        bounded_records:
          Number.isInteger(j.customsUsedRecords) && j.customsUsedRecords <= recordBudget,
        bounded_research: j.researched <= researchBudget,
      };
      return {
        lane: j.lane,
        id: j.id,
        passed: Object.values(checks).every(Boolean),
        checks,
        status: j.status,
        reason: j.reason,
        inserted: j.inserted,
        updated: j.updated,
        researched: j.researched,
        observed_sources: observedSources,
        verified,
        researchUsage: j.researchUsage,
        searchUsage: j.searchStats.map((s) => ({
          source_kind: s.source_kind || 'web',
          query: s.query,
          status: s.status,
          discovered: s.discovered,
          researched: s.researched,
          usage: s.usage,
        })),
      };
    });
    const verified = results.flatMap((r) => r.verified);
    const touched = new Set(
      state.jobs.flatMap((j) => j.rows.map((r) => r.record_id).filter(Boolean)),
    );
    const after = new Map(state.records.map((r) => [r.id, r]));
    const missing = baseline.records.filter((r) => !after.has(r.id)).map((r) => r.id);
    const unexpectedChanges = baseline.records
      .filter(
        (r) =>
          after.has(r.id) &&
          r.fields_digest !== after.get(r.id).fields_digest &&
          !touched.has(r.id) &&
          r.id !== invalidId,
      )
      .map((r) => r.id);
    const statePath = checkpoint(directory, 'final-state', state);
    let credit,
      first,
      creditDelta = null;
    try {
      credit = checkCreditMeter(state.meters);
      first = checkCreditMeter(baseline.meters);
      creditDelta = credit.used - first.used;
    } catch {
      // Preserve the completed business evidence even if the meter is unavailable.
      // The report remains failed/unknown instead of manufacturing a zero cost.
    }
    const checks = {
      all_three_lanes_started: results.length === baseline.plans.length,
      all_lanes_passed: results.length > 0 && results.every((r) => r.passed),
      distinct_enterprises_across_lanes:
        new Set(verified.map((r) => r.id)).size === verified.length &&
        new Set(verified.map((r) => r.domain)).size === verified.length,
      official_customs_meter_bounded:
        !!credit &&
        !!first &&
        credit.total === first.total &&
        creditDelta >= 0 &&
        creditDelta <= totalRecordCap,
      baseline_records_preserved: missing.length === 0,
      unrelated_baseline_records_unchanged: unexpectedChanges.length === 0,
      all_counted_records_read_back: verified.every((r) => after.get(r.id)?.domain === r.domain),
    };
    const report = {
      at: state.at,
      state_path: statePath,
      passed: Object.values(checks).every(Boolean),
      checks,
      model: state.model,
      results,
      record_count_before: baseline.records.length,
      record_count_after: state.records.length,
      missing_baseline_record_ids: missing,
      unexpected_changed_record_ids: unexpectedChanges,
      customs_credit_delta: creditDelta,
      meters_before: baseline.meters,
      meters_after: state.meters,
      known_invalid_record: state.known_invalid_record,
      limitations: [
        'This verifies the executed small batch only; it does not establish market-wide yield, order intent or throughput.',
        'Model catalogue visibility and reasoning settings do not themselves prove accuracy.',
        'Customs shipment records remain trade evidence, not purchase orders or expressed buying intent.',
        'Account meter changes can include delayed reporting or use by other clients; per-request usage remains separate.',
      ],
    };
    const path = checkpoint(directory, 'final', report);
    console.log(JSON.stringify({ path, ...report }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
} else if (isEntryPoint) {
  console.log(
    'Usage: node --env-file-if-exists=.env scripts/verify-dual-handoff-live.mjs baseline [directory] | start <directory> <fabrics-ca|components-us|shutters-us> | observe <directory> | finalize <directory>',
  );
  if (command && !['help', '--help'].includes(command)) process.exitCode = 1;
}
