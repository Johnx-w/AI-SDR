import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BUSINESS_SCHEMA_VERSION,
  CUSTOMER_FIELD_ALIASES,
  canonicalCustomerFields,
  assessmentSummaryFields,
  customerWebsite,
} from './customer-fields.mjs';
import { PRODUCT_KNOWLEDGE_FEISHU_FIELDS } from './product-knowledge-feishu.mjs';
import { domainKey, thirdPartyCompanySource } from './website-identity.mjs';

const currentVersion = 'acquisition-v3.2';
const quarantineId = 'reczz28R6bOYYebh';
const t5Name = 'T5 产品资料库';
const addedFields = [
  { field_name: '企业官网', type: 15 },
  { field_name: '主要供货机会', type: 1 },
  { field_name: '待确认事项', type: 1 },
];
const addedNames = new Set(addedFields.map((field) => field.field_name));
const canonical = (value) =>
  JSON.stringify(value, (_, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)),
        )
      : entry,
  );
export const businessSchemaDigest = (value) =>
  createHash('sha256')
    .update(canonical(value) ?? 'undefined')
    .digest('hex');
const text = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (typeof value === 'object') return value.link || value.text || value.name || '';
  return String(value);
};
const entries = (context) =>
  typeof context.currentAssessments === 'function'
    ? context.currentAssessments()
    : context.currentAssessments;

export async function assertBusinessMigrationIdle(readApi) {
  const [jobs, schedules] = await Promise.all([
    readApi('/api/v1/integrations/n8n/jobs'),
    readApi('/api/v1/integrations/n8n/schedules'),
  ]);
  assert(Array.isArray(jobs.jobs) && Array.isArray(schedules.schedules), '任务状态响应不完整');
  assert(
    !jobs.jobs.some((job) => ['running', 'stopping', 'paused'].includes(job.status)),
    '请先完成或关闭当前获客任务',
  );
  assert(
    !schedules.schedules.some((schedule) => schedule.status === 'enabled'),
    '请先暂停定时获客计划',
  );
}

export async function captureBusinessSchema(context) {
  const { client, t2Id, scope } = context;
  assert(t2Id && scope, '迁移必须指定客户主表与数据库范围');
  const [tables, fields, records] = await Promise.all([
    client.tables(),
    client.fields(t2Id),
    client.records(t2Id),
  ]);
  assert(
    tables.some((table) => table.table_id === t2Id && /^T2(?:\s|$)/.test(table.name)),
    '配置的目标不是T2客户主表',
  );
  const histories = tables.filter((table) => /^T12(?:\s|$)/.test(table.name));
  assert(histories.length <= 1, '存在多张T12，停止自动迁移');
  const t12 = histories[0]?.table_id || null;
  assert(t12 !== t2Id, 'T12不能指向客户主表');
  const [historyFields, history] = t12
    ? await Promise.all([client.fields(t12), client.records(t12)])
    : [[], []];
  const products = tables.filter((table) => table.name === t5Name);
  assert(products.length <= 1, '存在同名重复T5，停止自动迁移');
  const t5 = products[0]?.table_id || null;
  const [productFields, productRecords] = t5
    ? await Promise.all([client.fields(t5), client.records(t5)])
    : [[], []];
  return {
    at: new Date().toISOString(),
    businessSchemaVersion: BUSINESS_SCHEMA_VERSION,
    scope,
    t2: t2Id,
    t12,
    tables,
    fields,
    records,
    historyFields,
    history,
    t5,
    productFields,
    productRecords,
    currentAssessments: structuredClone(await entries(context)),
  };
}

function assertLocalCurrent(local, baseline) {
  assert(Array.isArray(local), '本地评估读取不完整');
  assert.equal(local.length, 15, '预期15条最新评估，数据已变化');
  assert.equal(
    new Set(local.map((entry) => entry.recordId)).size,
    local.length,
    '本地仍含重复评估历史',
  );
  for (const entry of local) {
    const snapshot = entry.snapshot;
    assert(
      snapshot && snapshot.id && snapshot.website && snapshot.dimensions,
      '本地评估快照不完整',
    );
    assert(
      Array.isArray(snapshot.opportunities) &&
        Array.isArray(snapshot.missing) &&
        Array.isArray(snapshot.facts),
      '本地评估依据不完整',
    );
    assert.equal(snapshot.ruleVersion, currentVersion, '存在旧规则评估');
    assert.notEqual(entry.recordId, quarantineId, '隔离客户不能恢复自动评估');
  }
  if (baseline) {
    const comparable = (rows) =>
      rows
        .map((entry) => ({ recordId: entry.recordId, snapshot: entry.snapshot }))
        .sort((left, right) => left.recordId.localeCompare(right.recordId));
    assert.equal(
      businessSchemaDigest(comparable(local)),
      businessSchemaDigest(comparable(baseline)),
      '迁移期间最新评估发生变化',
    );
  }
}

function assertPreserved(baseline, live) {
  assert(live.scope === baseline.scope, '客户数据库范围改变');
  assert.equal(live.t2, baseline.t2, '客户主表改变');
  assert.equal(baseline.records.length, 16, '预期16家原客户，数据已变化');
  assert.deepEqual(
    live.records.map((row) => row.record_id).sort(),
    baseline.records.map((row) => row.record_id).sort(),
    '客户记录集合改变',
  );
  const business = (fields) =>
    Object.fromEntries(
      Object.entries(canonicalCustomerFields(fields)).filter(
        ([name, value]) => !addedNames.has(name) && text(value) !== '',
      ),
    );
  for (const original of baseline.records) {
    const current = live.records.find((record) => record.record_id === original.record_id);
    assert.equal(
      businessSchemaDigest(business(current.fields)),
      businessSchemaDigest(business(original.fields)),
      '客户原有字段值改变：' + original.record_id,
    );
  }
  for (const original of baseline.fields) {
    const current = live.fields.find((field) => field.field_id === original.field_id);
    assert(current, '原有字段被删除或重建：' + original.field_name);
    assert(
      [original.field_name, CUSTOMER_FIELD_ALIASES[original.field_name]].includes(
        current.field_name,
      ),
      '字段名称出现未经确认的变化',
    );
    assert.equal(current.type, original.type, '字段类型改变：' + original.field_name);
    assert.equal(
      businessSchemaDigest(current.property),
      businessSchemaDigest(original.property),
      '字段选项或属性改变：' + original.field_name,
    );
  }
  assertLocalCurrent(live.currentAssessments, baseline.currentAssessments);
  const quarantine = live.records.find((record) => record.record_id === quarantineId);
  assert(quarantine && !text(quarantine.fields['企业官网']), '隔离客户被误填企业官网');
}

// Every write is preceded by a read, and uncertain writes are only reconciled.
// A persisted pending/uncertain operation is never blindly replayed on rerun.
async function reconciledWrite(context, key, write, confirm) {
  const journal = context.journal || [];
  const prior = journal.filter((event) => event.key === key).at(-1);
  const save = async (state, extra = {}) => {
    const event = { at: new Date().toISOString(), key, state, ...extra };
    journal.push(event);
    await context.checkpoint?.(event, journal);
  };
  if (await confirm()) {
    if (prior && ['pending', 'uncertain'].includes(prior.state))
      await save('done', { reconciled: true });
    return;
  }
  if (prior && ['pending', 'uncertain'].includes(prior.state))
    throw new Error('上次写入结果仍不确定，请先核对：' + key);
  await save('pending');
  let failure;
  try {
    await write();
  } catch (error) {
    failure = error;
  }
  let verified = false;
  try {
    verified = await confirm();
  } catch (error) {
    failure ||= error;
  }
  if (!verified) {
    await save('uncertain', { error: failure?.message || '读回结果不一致' });
    throw new Error('外部写入待核对，未自动重试：' + key, { cause: failure });
  }
  await save('done');
}

async function validateT5(client, { requireEmpty = false } = {}) {
  const matches = (await client.tables()).filter((table) => table.name === t5Name);
  assert.equal(matches.length, 1, 'T5不存在或存在同名重复表');
  const tableId = matches[0].table_id;
  const [fields, records] = await Promise.all([client.fields(tableId), client.records(tableId)]);
  assert.equal(fields.length, PRODUCT_KNOWLEDGE_FEISHU_FIELDS.length, 'T5字段数不符合确认方案');
  for (const expected of PRODUCT_KNOWLEDGE_FEISHU_FIELDS) {
    const field = fields.find((item) => item.field_name === expected.field_name);
    assert(field && field.type === expected.type, 'T5字段缺失或类型不符：' + expected.field_name);
    if (expected.property?.options)
      assert.deepEqual(
        (field.property?.options || []).map((option) => option.name).sort(),
        expected.property.options.map((option) => option.name).sort(),
        'T5单选选项不符合方案：' + expected.field_name,
      );
  }
  if (requireEmpty) assert.equal(records.length, 0, '新建T5不得预填未经核实的产品资料');
  return tableId;
}

function assertProductRecordsPreserved(before, after) {
  const sorted = (rows) =>
    [...rows].sort((left, right) => left.record_id.localeCompare(right.record_id));
  assert.equal(
    businessSchemaDigest(sorted(before)),
    businessSchemaDigest(sorted(after)),
    '迁移期间T5产品资料发生变化',
  );
}

export async function prepareBusinessSchema(context) {
  await assertBusinessMigrationIdle(context.readApi);
  const live = await captureBusinessSchema(context);
  const baseline = context.baseline || live;
  assertLocalCurrent(live.currentAssessments);
  assertPreserved(baseline, live);
  assert.equal(typeof context.backup, 'function', '必须先配置持久备份');
  await context.backup(live, 'prepare');
  const { client, t2Id } = context;
  for (const definition of addedFields) {
    const confirm = async () => {
      const field = (await client.fields(t2Id)).find(
        (item) => item.field_name === definition.field_name,
      );
      if (field) assert.equal(field.type, definition.type, '新增字段已有不兼容类型');
      return Boolean(field);
    };
    await reconciledWrite(
      context,
      'field:' + definition.field_name,
      () =>
        client.request(client.tablePath(t2Id) + '/fields', { method: 'POST', body: definition }),
      confirm,
    );
  }
  const snapshots = new Map(
    live.currentAssessments.map((entry) => [entry.recordId, entry.snapshot]),
  );
  for (const original of live.records) {
    const snapshot = snapshots.get(original.record_id);
    if (!snapshot || original.record_id === quarantineId) continue;
    assert.equal(
      domainKey(snapshot.website),
      domainKey(customerWebsite(original)),
      '官网与已存评估不一致：' + original.record_id,
    );
    assert(!thirdPartyCompanySource({ url: snapshot.website }), '第三方资料不能回填企业官网');
    const updates = {
      企业官网: { text: snapshot.website, link: snapshot.website },
      ...assessmentSummaryFields(snapshot),
    };
    const patch = Object.fromEntries(Object.entries(updates).filter(([, value]) => text(value)));
    const confirm = async () => {
      const current = await client.record(original.record_id, t2Id);
      for (const [name, value] of Object.entries(patch)) {
        const existing = text(current.fields?.[name]);
        assert(
          !existing || existing === text(value),
          '新增摘要已被修改，请先核对：' + original.record_id + '/' + name,
        );
      }
      return Object.entries(patch).every(
        ([name, value]) => text(current.fields?.[name]) === text(value),
      );
    };
    await reconciledWrite(
      context,
      'backfill:' + original.record_id,
      () => client.write('update', patch, original.record_id, undefined, t2Id),
      confirm,
    );
  }
  const appTablesPath = client.tablePath(t2Id).split('/tables/')[0] + '/tables';
  const tableExists = async () => {
    const tables = (await client.tables()).filter((table) => table.name === t5Name);
    assert(tables.length <= 1, 'T5存在同名重复表');
    return tables.length === 1;
  };
  await reconciledWrite(
    context,
    'table:' + t5Name,
    () =>
      client.request(appTablesPath, {
        method: 'POST',
        body: {
          table: {
            name: t5Name,
            default_view_name: '产品资料',
            fields: PRODUCT_KNOWLEDGE_FEISHU_FIELDS,
          },
        },
      }),
    tableExists,
  );
  const t5 = await validateT5(client, { requireEmpty: !live.t5 });
  const after = await captureBusinessSchema(context);
  assertPreserved(baseline, after);
  assertProductRecordsPreserved(live.productRecords, after.productRecords);
  assert.equal(
    after.fields.length,
    baseline.fields.length +
      addedFields.filter(
        (field) => !baseline.fields.some((prior) => prior.field_name === field.field_name),
      ).length,
    'T2出现非预期字段',
  );
  assert.equal(after.t12, baseline.t12, '准备阶段不得删除T12');
  assert.equal(
    businessSchemaDigest(after.history),
    businessSchemaDigest(live.history),
    '准备阶段T12记录发生变化',
  );
  return {
    phase: 'prepared',
    t2: t2Id,
    t5,
    t12: after.t12,
    customers: after.records.length,
    fields: after.fields.length,
    currentAssessments: after.currentAssessments.length,
  };
}

async function assertCurrentApi(context, local) {
  await Promise.all(
    local.map(async (entry) => {
      const response = await context.readApi(
        '/api/v1/leads/real/' + encodeURIComponent(entry.recordId) + '/assessments',
      );
      assert(
        Array.isArray(response.assessments) && response.assessments.length <= 1,
        '接口仍返回评估历史',
      );
      assert.equal(response.assessment?.id, entry.snapshot.id, '接口未显示当前评估');
      assert.equal(response.assessment?.ruleVersion, currentVersion, '接口返回旧规则');
      assert.equal(response.assessment?.score, entry.snapshot.score, '接口分数与本地不一致');
    }),
  );
  const quarantine = await context.readApi('/api/v1/leads/real/' + quarantineId + '/assessments');
  assert(!quarantine.assessment && !quarantine.assessments?.length, '隔离客户被恢复自动评估');
}

export async function finalizeBusinessSchema(context) {
  const rules = await context.readApi('/api/v1/assessments/rules');
  assert.equal(rules.assessmentStorage, 'latest_only', '服务尚未加载最新评估代码，请先手动重启');
  assert.equal(
    rules.businessSchemaVersion,
    BUSINESS_SCHEMA_VERSION,
    '服务尚未加载T2/T5兼容代码，请先手动重启',
  );
  await assertBusinessMigrationIdle(context.readApi);
  const { client, t2Id, baseline } = context;
  assert(baseline?.t12 && baseline.t12 !== t2Id, '未找到已备份的独立T12目标');
  const live = await captureBusinessSchema(context);
  assertPreserved(baseline, live);
  assert(!live.t12 || live.t12 === baseline.t12, 'T12表标识与备份不符');
  assert.equal(live.fields.length, 26, '请先完成T2新增字段准备');
  const t5 = await validateT5(client);
  assert.notEqual(t5, baseline.t12, 'T12删除目标指向T5');
  await assertCurrentApi(context, live.currentAssessments);
  assert.equal(typeof context.backup, 'function', '删除前必须配置持久备份');
  await context.backup(live, 'finalize');
  for (const [oldName, currentName] of Object.entries(CUSTOMER_FIELD_ALIASES)) {
    const original = baseline.fields.find(
      (field) => field.field_name === oldName || field.field_name === currentName,
    );
    assert(original, '备份缺少待改名字段：' + oldName);
    const confirm = async () => {
      const fields = await client.fields(t2Id);
      const current = fields.find((field) => field.field_id === original.field_id);
      assert(current && current.type === original.type, '字段被删除或重建：' + oldName);
      assert(
        !fields.some(
          (field) => field.field_name === currentName && field.field_id !== original.field_id,
        ),
        '新字段名已被其他字段占用：' + currentName,
      );
      return current.field_name === currentName;
    };
    const body = {
      field_name: currentName,
      type: original.type,
      ...(original.property ? { property: original.property } : {}),
      ...(original.description ? { description: original.description } : {}),
    };
    await reconciledWrite(
      context,
      'rename:' + original.field_id,
      () =>
        client.request(
          client.tablePath(t2Id) + '/fields/' + encodeURIComponent(original.field_id),
          { method: 'PUT', body },
        ),
      confirm,
    );
  }
  const renamed = await captureBusinessSchema(context);
  assertPreserved(baseline, renamed);
  await assertBusinessMigrationIdle(context.readApi);
  await assertCurrentApi(context, renamed.currentAssessments);
  await reconciledWrite(
    context,
    'delete:' + baseline.t12,
    () => client.request(client.tablePath(baseline.t12), { method: 'DELETE' }),
    async () => !(await client.tables()).some((table) => table.table_id === baseline.t12),
  );
  const after = await captureBusinessSchema(context);
  assertPreserved(baseline, after);
  assertProductRecordsPreserved(live.productRecords, after.productRecords);
  assert.equal(after.t12, null, 'T12尚未删除');
  assert.equal(after.fields.length, 26);
  assert(
    Object.values(CUSTOMER_FIELD_ALIASES).every((name) =>
      after.fields.some((field) => field.field_name === name),
    ),
    '字段改名未完成',
  );
  await validateT5(client);
  await assertCurrentApi(context, after.currentAssessments);
  return {
    phase: 'complete',
    t2: t2Id,
    t5,
    t12Deleted: baseline.t12,
    customers: after.records.length,
    fields: after.fields.length,
    currentAssessments: after.currentAssessments.length,
    businessSchemaVersion: BUSINESS_SCHEMA_VERSION,
  };
}
