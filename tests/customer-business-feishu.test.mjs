import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BUSINESS_TABLES,
  buildBusinessTableFields,
  CustomerBusinessFeishu,
} from '../server/customer-business-feishu.mjs';
import { PRODUCT_KNOWLEDGE_FEISHU_FIELDS } from '../server/product-knowledge-feishu.mjs';

const time = '2026-10-24T12:00:00.000Z';
const ids = { customers: 't2', products: 't5', demands: 't1', messages: 't3', tasks: 't4' };
const env = {
  FEISHU_TABLE_ID: 't2',
  FEISHU_APP_TOKEN: 'fixture-app',
  BUSINESS_MIRROR_JOURNAL_PATH: ':memory:',
};

function fixture({ provisioned = true, journalPath } = {}) {
  const tables = new Map([
    ['t2', { table_id: 't2', name: 'T2 客户主表' }],
    ['t5', { table_id: 't5', name: 'T5 产品资料库' }],
  ]);
  const t2Names = [
    '初评结果',
    '企业经营产品',
    '主营产品概况',
    '公开采购需求',
    '企业服务客群',
    '企业官网',
    '主要供货机会',
    '待确认事项',
  ];
  const fields = new Map([
    [
      't2',
      [...t2Names, ...Array.from({ length: 18 }, (_, index) => '保留字段' + index)].map(
        (field_name, index) => ({ field_name, field_id: 'c' + index, type: 1 }),
      ),
    ],
    [
      't5',
      PRODUCT_KNOWLEDGE_FEISHU_FIELDS.map((field, index) => ({
        ...structuredClone(field),
        field_id: 'p' + index,
      })),
    ],
  ]);
  const records = new Map([
    ['t2', [{ record_id: 'customer-1', fields: { 公司名称: '真实企业', 开发状态: '人工跟进中' } }]],
    [
      't5',
      [
        {
          record_id: 'product-record-1',
          fields: { 产品编号: 'product-1', 产品名称: '已审核卷帘资料', 资料版本: 2 },
        },
      ],
    ],
  ]);
  if (provisioned)
    for (const [key, definition] of Object.entries(BUSINESS_TABLES)) {
      tables.set(ids[key], { table_id: ids[key], name: definition.name });
      fields.set(
        ids[key],
        buildBusinessTableFields(ids)[key].map((field, index) => ({
          ...structuredClone(field),
          field_id: key + index,
        })),
      );
      records.set(ids[key], []);
    }
  const writes = [],
    state = { active: false };
  const client = {
    tablePath: (id = 't2') => '/bitable/v1/apps/app/tables/' + id,
    tables: async () => structuredClone([...tables.values()]),
    fields: async (id) => structuredClone(fields.get(id)),
    records: async (id) => structuredClone(records.get(id)),
    record: async (id, tableId) =>
      structuredClone(records.get(tableId).find((record) => record.record_id === id)),
    write: async (action, patch, recordId, token, tableId) => {
      writes.push({ action, patch: structuredClone(patch), recordId, token, tableId });
      if (state.failWrite?.({ action, patch, tableId })) throw new Error('write outcome unknown');
      assert(!['t2', 't5'].includes(tableId), 'Mirror must never write T2 or T5');
      if (action === 'insert') {
        recordId = tableId + '-record-' + records.get(tableId).length;
        records.get(tableId).push({ record_id: recordId, fields: structuredClone(patch) });
      } else
        Object.assign(
          records.get(tableId).find((record) => record.record_id === recordId).fields,
          structuredClone(patch),
        );
      if (state.loseResponse?.({ action, patch, tableId }))
        throw new Error('committed response lost');
      return structuredClone(records.get(tableId).find((record) => record.record_id === recordId));
    },
    request: async (path, { method, body }) => {
      writes.push({ path, method, body: structuredClone(body) });
      if (state.failRequest?.({ path, method, body })) throw new Error('request outcome unknown');
      if (method === 'POST' && path.endsWith('/tables')) {
        const key = Object.keys(BUSINESS_TABLES).find(
          (name) => BUSINESS_TABLES[name].name === body.table.name,
        );
        assert(key, 'Unexpected table create');
        const tableId = ids[key];
        assert(!tables.has(tableId), 'Duplicate table create');
        tables.set(tableId, { table_id: tableId, name: body.table.name });
        fields.set(
          tableId,
          body.table.fields.map((field, index) => ({
            ...structuredClone(field),
            field_id: key + index,
          })),
        );
        records.set(tableId, []);
      } else if (method === 'POST' && path.endsWith('/fields')) {
        const tableId = path.split('/tables/')[1].split('/')[0];
        assert(!['t2', 't5'].includes(tableId), 'Provision must not change T2/T5');
        fields.get(tableId).push({
          ...structuredClone(body),
          field_id: tableId + '-field-' + fields.get(tableId).length,
        });
      } else throw new Error('Unexpected mutation');
      return {};
    },
  };
  const bridge = new CustomerBusinessFeishu({
    env,
    client,
    ...(journalPath ? { journalPath } : {}),
  });
  const backups = [],
    journal = [];
  const provision = {
    backup: async (snapshot) =>
      backups.push({ snapshot: structuredClone(snapshot), writesBefore: writes.length }),
    readApi: async (path) =>
      path.endsWith('/jobs')
        ? { jobs: state.active ? [{ status: 'running' }] : [] }
        : { schedules: [] },
    journal,
    checkpoint: async () => {},
  };
  return { bridge, client, tables, fields, records, writes, state, backups, journal, provision };
}

function workspace() {
  const common = {
    customerId: 'customer-1',
    conversationId: 'conv-1',
    version: 1,
    createdAt: time,
    updatedAt: time,
  };
  return {
    conversations: [{ id: 'conv-1', customerId: 'customer-1' }],
    customerContexts: [],
    messages: [
      {
        ...common,
        id: 'msg-1',
        channel: 'email',
        direction: 'inbound',
        subject: 'Two products',
        body: 'We need roller blinds and outdoor screens.',
        from: 'buyer@example.org',
        to: 'sales@example.org',
        account: 'sales@example.org',
        occurredAt: time,
        deliveryStatus: 'received',
        classification: 'normal',
        externalId: 'external-1',
        attachments: [],
        demandIds: [],
        actualConfirmed: true,
        origin: 'manual',
      },
    ],
    demands: [
      {
        ...common,
        id: 'dem-1',
        sourceMessageId: 'msg-1',
        title: 'Roller blinds',
        category: 'indoor',
        direction: 'finished',
        productText: 'roller blinds',
        productIds: ['product-1'],
        productVersions: { 'product-1': 1 },
        specifications: 'Size to confirm',
        quantity: '100',
        unit: 'sets',
        stage: 'clarifying',
        owner: 'Johnson',
        ownership: 'human',
        evidenceQuote: 'We need roller blinds',
      },
      {
        ...common,
        id: 'dem-2',
        sourceMessageId: 'msg-1',
        title: 'Outdoor screens',
        category: 'outdoor',
        direction: 'finished',
        productText: 'zip screens',
        productIds: [],
        productVersions: {},
        specifications: '',
        quantity: '',
        unit: '',
        stage: 'new',
        ownership: 'auto',
        evidenceQuote: 'outdoor screens',
      },
    ],
    tasks: [
      {
        ...common,
        id: 'task-1',
        title: 'Clarify both product specifications',
        kind: 'clarify_specs',
        channel: 'email',
        dueAt: time,
        status: 'pending',
        owner: 'Johnson',
        notes: 'One unified reply',
        demandIds: ['dem-1', 'dem-2'],
        messageIds: [],
        basisMessageId: 'msg-1',
        resultMessageId: '',
        productIds: ['product-1'],
        productVersions: { 'product-1': 1 },
        audit: [],
        preflight: { allowed: false, reasons: ['客户已回复，需重新确认跟进内容'] },
      },
    ],
  };
}

test('建立三表时先建无关联基础字段，再添加循环关联；备份先于写入且不改T2/T5', async () => {
  const f = fixture({ provisioned: false });
  const original = structuredClone([
    f.fields.get('t2'),
    f.fields.get('t5'),
    f.records.get('t2'),
    f.records.get('t5'),
  ]);
  const result = await f.bridge.provision(f.provision);
  assert(result.configured);
  assert.equal(result.createdRecords, 0);
  assert.equal(f.backups[0].writesBefore, 0);
  const creates = f.writes.filter((write) => write.path?.endsWith('/tables'));
  assert.equal(creates.length, 3);
  assert(creates.every((write) => write.body.table.fields.every((field) => field.type !== 18)));
  const firstRelation = f.writes.findIndex((write) => write.body?.type === 18);
  assert(firstRelation > f.writes.findLastIndex((write) => write.path?.endsWith('/tables')));
  assert.deepEqual(
    [f.fields.get('t2'), f.fields.get('t5'), f.records.get('t2'), f.records.get('t5')],
    original,
  );
  assert.equal(
    f.fields.get('t1').find((field) => field.field_name === '来源沟通').property.table_id,
    't3',
  );
  assert.equal(
    f.fields.get('t3').find((field) => field.field_name === '关联需求').property.table_id,
    't1',
  );
  const count = f.writes.length;
  await f.bridge.provision(f.provision);
  assert.equal(f.writes.length, count);
});

test('建表前检查T12已删除、T2/T5完成迁移与任务空闲，失败时没有写入', async () => {
  for (const mutate of [
    (f) => f.tables.set('t12', { table_id: 't12', name: 'T12 客户评估历史表' }),
    (f) => f.fields.get('t2').pop(),
    (f) => f.fields.get('t5').pop(),
    (f) => {
      f.state.active = true;
    },
  ]) {
    const f = fixture({ provisioned: false });
    mutate(f);
    await assert.rejects(f.bridge.provision(f.provision));
    assert.equal(f.writes.length, 0);
  }
});

test('创建表结果未知时写日志并阻止盲目重复创建', async () => {
  const f = fixture({ provisioned: false });
  f.state.failRequest = () => true;
  await assert.rejects(f.bridge.provision(f.provision), /尚未核对/);
  assert.equal(f.journal.at(-1).state, 'uncertain');
  const count = f.writes.length;
  f.state.failRequest = undefined;
  await assert.rejects(f.bridge.provision(f.provision), /上次写入仍待核对/);
  assert.equal(f.writes.length, count);
});

test('信息检查发现关联目标或多选配置错误时不允许同步', async () => {
  const f = fixture();
  f.fields.get('t1').find((field) => field.field_name === '来源沟通').property.table_id = 't5';
  const result = await f.bridge.info();
  assert.equal(result.configured, false);
  assert.equal(result.status, 'pending');
  assert.match(result.error, /关联字段目标/);
  assert.equal(
    (await f.bridge.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] })).status,
    'pending',
  );
  assert.equal(f.writes.length, 0);
});

test('两遍同步同一来信的两条需求与统一跟进任务，全部循环关系读回后才成功', async () => {
  const f = fixture();
  const original = structuredClone([f.records.get('t2'), f.records.get('t5')]);
  const result = await f.bridge.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] });
  assert.equal(result.status, 'synced', result.error);
  assert.deepEqual(result.counts, { demands: 2, messages: 1, tasks: 1 });
  const message = f.records.get('t3')[0],
    demand = f.records.get('t1')[0],
    task = f.records.get('t4')[0];
  assert.deepEqual(message.fields['客户'], ['customer-1']);
  assert.deepEqual(
    message.fields['关联需求'],
    f.records.get('t1').map((row) => row.record_id),
  );
  assert.deepEqual(demand.fields['来源沟通'], [message.record_id]);
  assert.deepEqual(demand.fields['产品资料'], ['product-record-1']);
  assert.equal(demand.fields['产品资料版本'], 'product-1@v1');
  assert.equal(demand.fields['接待归属'], '人工负责');
  assert.deepEqual(task.fields['关联沟通'], [message.record_id]);
  assert.equal(task.fields['执行前检查'], '客户已回复，需重新确认跟进内容');
  assert.equal(message.fields['记录来源'], '人工补录');
  assert.deepEqual([f.records.get('t2'), f.records.get('t5')], original);
  const count = f.writes.length;
  assert.equal(
    (await f.bridge.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] })).status,
    'synced',
  );
  assert.equal(f.writes.length, count);
});

test('引用产品未同步或跨客户需求引用时，整图在首次写入前返回待核对', async () => {
  for (const mutate of [
    (graph) => {
      graph.demands[0].productIds = ['missing-product'];
    },
    (graph) => {
      graph.demands[0].customerId = 'other-customer';
    },
    (graph) => {
      graph.tasks[0].demandIds = ['missing-demand'];
    },
    (graph) => {
      graph.messages[0].actualConfirmed = false;
    },
  ]) {
    const f = fixture(),
      graph = workspace();
    mutate(graph);
    const result = await f.bridge.sync(graph, { products: [{ id: 'product-1', version: 2 }] });
    assert.equal(result.status, 'pending');
    assert.equal(f.writes.length, 0);
  }
});

test('循环关联写入失败时保留基础记录，返回pending而非部分成功', async () => {
  const f = fixture();
  f.state.failWrite = ({ patch }) => Object.hasOwn(patch, '关联需求');
  const result = await f.bridge.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] });
  assert.equal(result.status, 'pending');
  assert.equal(f.records.get('t3').length, 1);
  assert.equal(f.records.get('t1').length, 2);
  assert.equal(f.records.get('t4').length, 1);
  const count = f.writes.length;
  await f.bridge.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] });
  assert.equal(f.writes.length, count);
});

test('插入已提交但响应丢失时只读回核对，稳定编号不产生重复记录', async () => {
  const f = fixture();
  f.state.loseResponse = () => true;
  const result = await f.bridge.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] });
  assert.equal(result.status, 'synced', result.error);
  assert.equal(f.writes.filter((write) => write.action === 'insert').length, 4);
  assert.equal(f.records.get('t3').length, 1);
  assert(
    f.writes
      .filter((write) => write.action === 'insert')
      .every((write) => /^[a-f\d-]{36}$/.test(write.token)),
  );
});

test('重启后持久化未知写入日志阻止再次插入，内存模式不生成文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'business-mirror-'));
  const path = join(root, 'journal.json');
  try {
    const f = fixture({ journalPath: path });
    f.state.failWrite = () => true;
    await f.bridge.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).at(-1).state, 'uncertain');
    const count = f.writes.length;
    const restarted = new CustomerBusinessFeishu({ env, client: f.client, journalPath: path });
    f.state.failWrite = undefined;
    assert.equal(
      (await restarted.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] })).status,
      'pending',
    );
    assert.equal(f.writes.length, count);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('空业务图同步为零条真实记录；不会播种假询盘或任务', async () => {
  const f = fixture();
  const result = await f.bridge.sync({
    conversations: [],
    messages: [],
    demands: [],
    tasks: [],
    customerContexts: [],
  });
  assert.equal(result.status, 'synced');
  assert.deepEqual(result.counts, { demands: 0, messages: 0, tasks: 0 });
  assert.equal(f.writes.length, 0);
});
