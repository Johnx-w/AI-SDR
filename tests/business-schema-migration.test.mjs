import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSINESS_SCHEMA_VERSION,
  CUSTOMER_FIELD_ALIASES,
  canonicalCustomerFields,
} from '../server/customer-fields.mjs';
import {
  captureBusinessSchema,
  prepareBusinessSchema,
  finalizeBusinessSchema,
} from '../server/business-schema-migration.mjs';
import { PRODUCT_KNOWLEDGE_FEISHU_FIELDS } from '../server/product-knowledge-feishu.mjs';

const quarantineId = 'reczz28R6bOYYebh';
const baseNames = [
  'customer_id',
  '公司名称',
  '来源链接',
  '国家',
  '州 / 城市',
  '客户类型',
  '相关产品',
  '邮箱',
  '电话',
  'Facebook',
  'LinkedIn',
  'Instagram',
  '服务地区',
  '详细地址',
  '服务客群',
  '主营产品偏好',
  '客户行业画像',
  '用户评级',
  '首次发现时间',
  '最近研究时间',
  '广告代码',
  '需求产品',
  '开发状态',
];

function fixture() {
  const tables = new Map([
    ['t2', { name: 'T2 客户主表', table_id: 't2' }],
    ['t12', { name: 'T12 客户评估历史表', table_id: 't12' }],
  ]);
  const fields = new Map([
    [
      't2',
      baseNames.map((field_name, index) => ({
        field_name,
        field_id: 'f' + index,
        type: field_name === '用户评级' ? 3 : 1,
        ...(field_name === '用户评级'
          ? { property: { options: [{ id: 'opt-a', name: 'A' }] } }
          : {}),
      })),
    ],
    ['t12', [{ field_name: '规则版本', field_id: 'h1', type: 1 }]],
  ]);
  const records = new Map([
    [
      't2',
      Array.from({ length: 16 }, (_, index) => ({
        record_id: index === 15 ? quarantineId : 'rec' + index,
        fields: {
          customer_id: 'customer-' + index,
          公司名称: 'Buyer ' + index,
          来源链接:
            index === 15
              ? 'https://importkey.com/buyer/quarantine'
              : 'https://buyer' + index + '.example.org/',
          用户评级: index === 15 ? '暂不开发' : 'A',
          开发状态: index === 15 ? '暂缓开发' : '人工跟进中',
          需求产品: index === 0 ? '具有来源的真实求购信息' : '',
          邮箱: 'buyer' + index + '@example.org',
        },
      })),
    ],
    [
      't12',
      Array.from({ length: 15 }, (_, index) => ({
        record_id: 'history' + index,
        fields: { 规则版本: 'acquisition-v3.2' },
      })),
    ],
  ]);
  const local = Array.from({ length: 15 }, (_, index) => ({
    recordId: 'rec' + index,
    snapshot: {
      id: 'assessment' + index,
      ruleVersion: 'acquisition-v3.2',
      website: 'https://buyer' + index + '.example.org/',
      score: 75,
      dimensions: { P: { score: 40 }, R: { score: 30 }, D: { score: 5 }, V: { score: 0 } },
      product: 'roller blinds',
      direction: 'finished',
      opportunities: [{ direction: 'finished', product: 'roller blinds' }],
      missing: ['采购方式待沟通'],
      facts: [],
    },
  }));
  const mutations = [],
    backups = [],
    journal = [];
  const state = {
    active: false,
    rules: { assessmentStorage: 'latest_only', businessSchemaVersion: BUSINESS_SCHEMA_VERSION },
  };
  const client = {
    tablePath: (id = 't2') => '/bitable/v1/apps/app/tables/' + id,
    tables: async () => structuredClone([...tables.values()]),
    fields: async (id = 't2') => structuredClone(fields.get(id)),
    records: async (id = 't2') => structuredClone(records.get(id)),
    record: async (id, table = 't2') =>
      structuredClone(records.get(table).find((record) => record.record_id === id)),
    write: async (action, patch, id, token, table = 't2') => {
      mutations.push({ kind: 'record', id, patch });
      const row = records.get(table).find((record) => record.record_id === id);
      Object.assign(row.fields, structuredClone(patch));
      return structuredClone(row);
    },
    request: async (path, options) => {
      mutations.push({ path, ...structuredClone(options) });
      if (state.failBeforeCommit?.(path, options)) throw new Error('unknown write result');
      const pieces = path.split('/tables');
      const rest = pieces[1].split('/').filter(Boolean);
      if (options.method === 'POST' && !rest.length) {
        tables.set('t5', { name: options.body.table.name, table_id: 't5' });
        fields.set(
          't5',
          options.body.table.fields.map((field, index) => ({
            ...structuredClone(field),
            field_id: 'p' + index,
          })),
        );
        records.set('t5', []);
      } else if (options.method === 'POST' && rest[1] === 'fields') {
        fields
          .get(rest[0])
          .push({ ...options.body, field_id: 'added' + fields.get(rest[0]).length });
      } else if (options.method === 'PUT' && rest[1] === 'fields') {
        const field = fields.get(rest[0]).find((candidate) => candidate.field_id === rest[2]);
        const oldName = field.field_name;
        Object.assign(field, structuredClone(options.body));
        for (const row of records.get(rest[0])) {
          if (Object.hasOwn(row.fields, oldName))
            row.fields[field.field_name] = row.fields[oldName];
          delete row.fields[oldName];
        }
      } else if (options.method === 'DELETE' && rest.length === 1) {
        tables.delete(rest[0]);
        fields.delete(rest[0]);
        records.delete(rest[0]);
      } else throw new Error('Unsupported mock mutation');
      if (state.failAfterCommit?.(path, options)) throw new Error('response lost after commit');
      return {};
    },
  };
  const context = {
    client,
    t2Id: 't2',
    scope: 'app/t2',
    journal,
    currentAssessments: () => structuredClone(local),
    readApi: async (path) => {
      if (path.endsWith('/jobs')) return { jobs: state.active ? [{ status: 'running' }] : [] };
      if (path.endsWith('/schedules')) return { schedules: [] };
      if (path.endsWith('/rules')) return structuredClone(state.rules);
      const id = path.split('/').at(-2);
      const entry = local.find((row) => row.recordId === id);
      return { assessment: entry?.snapshot || null, assessments: entry ? [entry.snapshot] : [] };
    },
    backup: async (snapshot, phase) =>
      backups.push({
        snapshot: structuredClone(snapshot),
        phase,
        mutationsBefore: mutations.length,
      }),
    checkpoint: async () => {},
  };
  return { context, tables, fields, records, local, state, mutations, backups, journal };
}

async function prepare(f) {
  const result = await prepareBusinessSchema(f.context);
  f.context.baseline = f.backups[0].snapshot;
  return result;
}

test('准备阶段先备份，只新增三列和空T5；保留旧字段及人工信息，重复执行不重复写入', async () => {
  const f = fixture();
  const original = structuredClone(f.records.get('t2'));
  const result = await prepare(f);
  assert.equal(f.backups[0].mutationsBefore, 0);
  assert.equal(result.phase, 'prepared');
  assert.equal(result.fields, 26);
  assert.equal(f.tables.has('t12'), true);
  assert.equal(f.records.get('t12').length, 15);
  assert.equal(f.fields.get('t5').length, PRODUCT_KNOWLEDGE_FEISHU_FIELDS.length);
  assert.deepEqual(f.records.get('t5'), []);
  for (const row of original) {
    const current = f.records.get('t2').find((candidate) => candidate.record_id === row.record_id);
    for (const [name, value] of Object.entries(row.fields))
      assert.deepEqual(current.fields[name], value);
  }
  assert(!f.records.get('t2').at(-1).fields['企业官网']);
  assert(!Object.hasOwn(f.records.get('t2')[0].fields, '初评结果'));
  assert.match(f.records.get('t2')[0].fields['主要供货机会'], /潜在供货机会/);
  const mutations = f.mutations.length;
  await prepareBusinessSchema(f.context);
  assert.equal(f.mutations.length, mutations);
});

test('准备阶段有活动任务时不备份、不写入', async () => {
  const f = fixture();
  f.state.active = true;
  await assert.rejects(prepareBusinessSchema(f.context), /请先完成/);
  assert.equal(f.backups.length, 0);
  assert.equal(f.mutations.length, 0);
});

test('未加载两项新版标识时，完成阶段拒绝改名或删除T12', async () => {
  for (const rules of [
    { assessmentStorage: 'history', businessSchemaVersion: BUSINESS_SCHEMA_VERSION },
    { assessmentStorage: 'latest_only' },
  ]) {
    const f = fixture();
    await prepare(f);
    f.state.rules = rules;
    const writes = f.mutations.length;
    await assert.rejects(finalizeBusinessSchema(f.context), /请先手动重启/);
    assert.equal(f.mutations.length, writes);
    assert(f.tables.has('t12'));
  }
});

test('完成阶段原位改名保留field_id、属性、值，核对最新评估后只删备份中的T12', async () => {
  const f = fixture();
  await prepare(f);
  const before = structuredClone(f.fields.get('t2'));
  const original = structuredClone(f.records.get('t2'));
  const result = await finalizeBusinessSchema(f.context);
  assert.equal(result.phase, 'complete');
  assert.equal(result.t12Deleted, 't12');
  assert(!f.tables.has('t12'));
  assert(f.tables.has('t2') && f.tables.has('t5'));
  assert.equal(f.local.length, 15);
  for (const [oldName, newName] of Object.entries(CUSTOMER_FIELD_ALIASES)) {
    const prior = before.find((field) => field.field_name === oldName);
    const current = f.fields.get('t2').find((field) => field.field_name === newName);
    assert.equal(current.field_id, prior.field_id);
    assert.equal(current.type, prior.type);
    assert.deepEqual(current.property, prior.property);
  }
  for (const row of original) {
    const current = f.records.get('t2').find((candidate) => candidate.record_id === row.record_id);
    const meaningful = (fields) =>
      Object.fromEntries(
        Object.entries(canonicalCustomerFields(fields)).filter(
          ([, value]) => value !== '' && value !== undefined,
        ),
      );
    assert.deepEqual(meaningful(current.fields), meaningful(row.fields));
  }
  const writes = f.mutations.length;
  await finalizeBusinessSchema(f.context);
  assert.equal(f.mutations.length, writes);
  assert.equal(f.backups.filter((backup) => backup.phase === 'finalize').length, 2);
});

test('客户人工值或本地评估变化时，在改名和删除前中止', async () => {
  for (const mutate of [
    (f) => {
      f.records.get('t2')[0].fields['开发状态'] = '客户已回复';
    },
    (f) => {
      f.local[0].snapshot.score = 80;
    },
  ]) {
    const f = fixture();
    await prepare(f);
    mutate(f);
    const writes = f.mutations.length;
    await assert.rejects(finalizeBusinessSchema(f.context), /字段值改变|最新评估发生变化/);
    assert.equal(f.mutations.length, writes);
    assert(f.tables.has('t12'));
  }
});

test('删除响应丢失时仅读表清单核对，已删除的T12不会再次删除', async () => {
  const f = fixture();
  await prepare(f);
  f.state.failAfterCommit = (_path, options) => options.method === 'DELETE';
  await finalizeBusinessSchema(f.context);
  assert.equal(f.mutations.filter((mutation) => mutation.method === 'DELETE').length, 1);
  await finalizeBusinessSchema(f.context);
  assert.equal(f.mutations.filter((mutation) => mutation.method === 'DELETE').length, 1);
});

test('创建字段响应未知且读回不存在时，后续执行保留不确定状态并禁止盲目重试', async () => {
  const f = fixture();
  f.state.failBeforeCommit = (path) => path.endsWith('/fields');
  await assert.rejects(prepareBusinessSchema(f.context), /外部写入待核对/);
  const writes = f.mutations.length;
  f.state.failBeforeCommit = undefined;
  await assert.rejects(prepareBusinessSchema(f.context), /上次写入结果仍不确定/);
  assert.equal(f.mutations.length, writes);
  assert.equal(f.journal.at(-1).state, 'uncertain');
});

test('T12目标、客户集合或隔离客户官网变化时拒绝完成迁移', async () => {
  for (const mutate of [
    (f) => {
      f.context.baseline.t12 = 't5';
    },
    (f) => {
      f.records.get('t2').pop();
    },
    (f) => {
      f.records.get('t2').at(-1).fields['企业官网'] = 'https://fabricated.example.org/';
    },
  ]) {
    const f = fixture();
    await prepare(f);
    mutate(f);
    const writes = f.mutations.length;
    await assert.rejects(finalizeBusinessSchema(f.context));
    assert.equal(f.mutations.length, writes);
    assert(f.tables.has('t12'));
  }
});

test('抓取迁移快照包括远端两表和本地评估，完全只读', async () => {
  const f = fixture();
  const snapshot = await captureBusinessSchema(f.context);
  assert.equal(snapshot.records.length, 16);
  assert.equal(snapshot.fields.length, 23);
  assert.equal(snapshot.history.length, 15);
  assert.equal(snapshot.currentAssessments.length, 15);
  assert.equal(f.mutations.length, 0);
});

test('字段未提供property时仍可安全备份校验；完成阶段保留已登记T5产品', async () => {
  const f = fixture();
  assert(!Object.hasOwn(f.fields.get('t2')[0], 'property'));
  await prepare(f);
  const product = {
    record_id: 'product-entered-by-user',
    fields: { 产品编号: 'product-1', 产品名称: '用户登记资料', 审核状态: '待审核' },
  };
  f.records.get('t5').push(product);
  const result = await finalizeBusinessSchema(f.context);
  assert.equal(result.phase, 'complete');
  assert.deepEqual(f.records.get('t5'), [product]);
  assert.deepEqual(
    f.backups.find((backup) => backup.phase === 'finalize').snapshot.productRecords,
    [product],
  );
});

test('T5单选选项被错误改动时阻止删除T12', async () => {
  const f = fixture();
  await prepare(f);
  f.fields
    .get('t5')
    .find((field) => field.field_name === '审核状态')
    .property.options.pop();
  const writes = f.mutations.length;
  await assert.rejects(finalizeBusinessSchema(f.context), /T5单选选项/);
  assert.equal(f.mutations.length, writes);
  assert(f.tables.has('t12'));
});
