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

function originalMessageTable(f) {
  const options = (names) => ({ options: names.map((name) => ({ name })) });
  f.fields.set('t3', [
    { field_name: '沟通记录ID', type: 1005 },
    { field_name: '关联客户', type: 18, property: { table_id: 't2', multiple: true } },
    {
      field_name: '触达渠道',
      type: 3,
      property: options(['邮件', 'WhatsApp', '网站留言', '人工电话', '其他']),
    },
    { field_name: '发送/沟通时间', type: 5 },
    ...['发送内容摘要', '收到回复内容', '提取客户信息', '客户需求摘要', '业务员纪要'].map(
      (field_name) => ({ field_name, type: 1 }),
    ),
    {
      field_name: '回复类型',
      type: 3,
      property: options(['无回复', '系统自动回复', '真人客户回复', '联系方式失效']),
    },
    { field_name: '本次动作指令', type: 3, property: options(['继续跟进找关键人']) },
    { field_name: '关联模板', type: 18, property: { table_id: 't10', multiple: true } },
  ]);
  const write = f.client.write;
  f.client.write = async (...args) => {
    if (args[4] === 't3')
      for (const name of Object.keys(args[1])) {
        assert(
          f.fields.get('t3').some((field) => field.field_name === name),
          'Unexpected T3 field: ' + name,
        );
        assert.notEqual(name, '沟通记录ID');
      }
    const record = await write(...args);
    if (args[4] === 't3' && args[0] === 'insert') {
      record.fields['沟通记录ID'] = 'NO.' + f.records.get('t3').length;
      f.records.get('t3').find((r) => r.record_id === record.record_id).fields['沟通记录ID'] =
        record.fields['沟通记录ID'];
    }
    return record;
  };
}

function originalTaskTable(f) {
  f.fields.set('t4', [
    { field_name: '任务ID', type: 1005 },
    { field_name: '关联客户', type: 18, property: { table_id: 't2', multiple: true } },
    { field_name: '关联沟通记录', type: 18, property: { table_id: 't3', multiple: true } },
    {
      field_name: '任务类型',
      type: 3,
      property: {
        options: ['邮件触达', 'WhatsApp触达', '网站留言', '人工电话外呼'].map((name) => ({ name })),
      },
    },
    { field_name: '计划执行时间', type: 5 },
    {
      field_name: '任务状态',
      type: 3,
      property: {
        options: ['待执行', '已完成', '跳过', '终止'].map((name) => ({ name })),
      },
    },
    { field_name: '使用模板', type: 18, property: { table_id: 't10', multiple: true } },
    { field_name: '任务说明', type: 1 },
    { field_name: '负责业务员', type: 18, property: { table_id: 't8', multiple: true } },
  ]);
  f.records.set('t8', [{ record_id: 'sales-1', fields: { 业务员名称: 'Johnson' } }]);
  const write = f.client.write;
  f.client.write = async (...args) => {
    if (args[4] === 't4') {
      const names = new Set(f.fields.get('t4').map((field) => field.field_name));
      for (const name of Object.keys(args[1])) {
        assert(names.has(name), 'Unexpected task field: ' + name);
        assert.notEqual(name, '任务ID', 'Auto-number must never be written');
      }
    }
    const record = await write(...args);
    if (args[4] === 't4' && args[0] === 'insert') {
      record.fields.任务ID = 'NO.001';
      f.records.get('t4').find((row) => row.record_id === record.record_id).fields.任务ID =
        'NO.001';
    }
    return record;
  };
}

function originalDemandTable(f) {
  const options = (names) => ({ options: names.map((name) => ({ name })) });
  f.fields.set('t1', [
    { field_name: '询盘编号', type: 1005 },
    { field_name: '关联客户', type: 18, property: { table_id: 't2', multiple: true } },
    {
      field_name: '询盘来源',
      type: 4,
      property: options(['官网表单', '收件邮箱', 'WhatsApp', '网站留言', '人工录入']),
    },
    { field_name: '询盘产品', type: 18, property: { table_id: 't5', multiple: true } },
    { field_name: '客户需求', type: 1 },
    { field_name: '意向等级', type: 3, property: options(['A高意向', 'B中意向', 'C低意向']) },
    { field_name: '询盘接收时间', type: 5 },
    { field_name: '负责业务员', type: 18, property: { table_id: 't8', multiple: true } },
    {
      field_name: '处理状态',
      type: 3,
      property: options(['待处理', '跟进中', '已报价', '已成交', '丢失归档']),
    },
    { field_name: '备注', type: 1 },
  ]);
  f.records.set('t8', [{ record_id: 'sales-1', fields: { 业务员名称: 'Johnson' } }]);
  const write = f.client.write;
  f.client.write = async (...args) => {
    if (args[4] === 't1') {
      for (const name of Object.keys(args[1])) {
        assert(
          f.fields.get('t1').some((field) => field.field_name === name),
          'Unexpected inquiry field: ' + name,
        );
        assert(
          !['询盘编号', '意向等级'].includes(name),
          'Cannot write auto-number or infer intent',
        );
      }
    }
    const record = await write(...args);
    if (args[4] === 't1' && args[0] === 'insert') {
      const number = 'NO.' + String(f.records.get('t1').length).padStart(3, '0');
      record.fields.询盘编号 = number;
      f.records.get('t1').find((row) => row.record_id === record.record_id).fields.询盘编号 =
        number;
    }
    return record;
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

test('信息检查发现关联目标错误时不允许同步', async () => {
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

test('本地客户编号映射到飞书T2，尚未同步的客户不写入错误关联', async () => {
  const f = fixture();
  f.bridge.customerRemoteId = (id) => (id === 'local_customer' ? 'customer-1' : null);
  const graph = workspace();
  for (const key of ['conversations', 'demands', 'messages', 'tasks'])
    for (const row of graph[key] || []) row.customerId = 'local_customer';
  const result = await f.bridge.sync(graph, { products: [{ id: 'product-1', version: 2 }] });
  assert.equal(result.status, 'synced', result.error);
  assert.deepEqual(f.records.get('t3')[0].fields['客户'], ['customer-1']);
  const blocked = fixture();
  blocked.bridge.customerRemoteId = () => null;
  const pending = await blocked.bridge.sync(graph, { products: [{ id: 'product-1', version: 2 }] });
  assert.equal(pending.status, 'pending');
  assert.equal(blocked.writes.length, 0);
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
  f.state.failWrite = undefined;
  assert.equal(
    (await f.bridge.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] })).status,
    'synced',
  );
  assert(f.writes.length > count);
  assert.equal(f.records.get('t3').length, 1);
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

test('重启后先核对未知写入，未成功时以稳定编号重试', async () => {
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
      'synced',
    );
    assert(f.writes.length > count);
    assert.equal(f.records.get('t3').length, 1);
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

test('显式原表编号绕过同名副本，复用旧列、渠道选项与多选客户关联并保留纪要', async () => {
  const f = fixture();
  const names = {
    customers: 'T2｜客户主表',
    products: 'T5｜产品资料库',
    demands: 'T1｜外贸窗饰询盘表',
    messages: 'T3｜多渠道沟通记录表',
    tasks: 'T4｜跟进任务表',
  };
  const mappings = {
    t1: { 客户: '关联客户', 产品资料: '询盘产品' },
    t3: { 客户: '关联客户', 渠道: '触达渠道', 发生时间: '发送/沟通时间', 正文: '沟通正文' },
    t4: { 客户: '关联客户', 关联沟通: '关联沟通记录', 任务类型: '标准任务类型', 渠道: '触达渠道' },
    t5: { MOQ: 'MOQ最小起订量' },
  };
  for (const [kind, tableId] of Object.entries(ids)) {
    const originalName = f.tables.get(tableId).name;
    f.tables.get(tableId).name = names[kind];
    f.tables.set('copy-' + tableId, { table_id: 'copy-' + tableId, name: originalName });
    for (const field of f.fields.get(tableId)) {
      const logical = field.field_name;
      field.field_name = mappings[tableId]?.[logical] || logical;
      if (logical === '客户') field.property.multiple = true;
      if (tableId === 't3' && logical === '渠道')
        for (const option of field.property.options)
          option.name = { 网页留言: '网站留言', 电话: '人工电话' }[option.name] || option.name;
    }
  }
  originalMessageTable(f);
  originalTaskTable(f);
  originalDemandTable(f);
  const bridge = new CustomerBusinessFeishu({
    env: {
      ...env,
      FEISHU_DEMANDS_TABLE_ID: 't1',
      FEISHU_MESSAGES_TABLE_ID: 't3',
      FEISHU_TASKS_TABLE_ID: 't4',
      FEISHU_PRODUCTS_TABLE_ID: 't5',
    },
    client: f.client,
  });
  const graph = workspace();
  graph.messages[0].channel = 'form';
  graph.messages[0].body =
    'We need roller blinds and outdoor screens.\n' + '全文保留\n'.repeat(5000);
  graph.messages[0].notes = '系统备注：实际发送已核对；业务员补充说明原样保存';
  graph.messages[0].replyAnalysis = {
    replyType: '真人客户回复',
    customerInfo: '',
    demandSummary: '',
  };
  graph.messages.push({
    ...graph.messages[0],
    id: 'msg-2',
    direction: 'outbound',
    deliveryStatus: 'sent',
    body: '实际发出的原文',
    notes: '发信结果已核对',
    externalId: 'external-2',
    occurredAt: '2026-10-24T12:01:00.000Z',
  });
  f.records.get('t3').push({
    record_id: 'existing-outbound',
    fields: {
      沟通记录ID: 'NO.099',
      关联客户: ['customer-1'],
      触达渠道: '网站留言',
      '发送/沟通时间': Date.parse(graph.messages[1].occurredAt),
      发送内容摘要: '实际发出的原文',
      收到回复内容: '旧列错误残留',
      业务员纪要: '人工纪要',
    },
  });
  const result = await bridge.sync(graph, { products: [{ id: 'product-1', version: 2 }] });
  assert.equal(result.status, 'synced', result.error);
  const message = f.records.get('t3').find((record) => record.record_id !== 'existing-outbound');
  assert.deepEqual(message.fields['关联客户'], ['customer-1']);
  assert.equal(message.fields['触达渠道'], '网站留言');
  assert.equal(message.fields['发送内容摘要'], undefined);
  assert.equal(message.fields['业务员纪要'], graph.messages[0].notes);
  assert(message.fields['收到回复内容'].includes(graph.messages[0].body));
  assert.equal(message.fields['发送/沟通时间'], Date.parse(time));
  assert(!Object.hasOwn(message.fields, '正文'));
  const outbound = f.records.get('t3').find((record) => record.record_id === 'existing-outbound');
  assert.equal(outbound.fields.发送内容摘要, '实际发出的原文');
  assert.equal(outbound.fields.收到回复内容, null);
  assert.match(outbound.fields.业务员纪要, /人工纪要/);
  assert.deepEqual(f.records.get('t1')[0].fields['询盘产品'], ['product-record-1']);
  const task = f.records.get('t4')[0];
  assert.equal(task.fields['任务ID'], 'NO.001');
  assert.equal(task.fields['任务类型'], '邮件触达');
  assert.equal(
    task.fields['任务说明'],
    graph.tasks[0].title + '\nOne unified reply\n负责人：Johnson',
  );
  assert.deepEqual(task.fields['负责业务员'], ['sales-1']);
  assert(!Object.hasOwn(task.fields, '任务编号'));
  const count = f.writes.length;
  assert.equal(
    (await bridge.sync(graph, { products: [{ id: 'product-1', version: 2 }] })).status,
    'synced',
  );
  assert.equal(f.writes.length, count);
  assert(f.writes.every((write) => !write.tableId?.startsWith('copy-')));
});

test('显式业务表编号失效时返回待核对，不回退同名表写入', async () => {
  const f = fixture();
  const bridge = new CustomerBusinessFeishu({
    env: { ...env, FEISHU_MESSAGES_TABLE_ID: 'missing-t3' },
    client: f.client,
  });
  const result = await bridge.sync(workspace(), { products: [{ id: 'product-1', version: 2 }] });
  assert.equal(result.status, 'pending');
  assert.match(result.error, /业务表不存在/);
  assert.equal(f.writes.length, 0);
});

test('原T3接续已有副本，收发同轮映射共享记录，重启后追加回复并保留T1/T4关联', async () => {
  const root = mkdtempSync(join(tmpdir(), 'original-message-rounds-'));
  try {
    const path = join(root, 'journal.json'),
      f = fixture();
    originalMessageTable(f);
    const graph = workspace(),
      incoming = graph.messages[0];
    incoming.occurredAt = '2026-10-24T12:01:00.000Z';
    incoming.replyAnalysis = {
      replyType: '真人客户回复',
      customerInfo: '联系人：Buyer',
      demandSummary: '需要卷帘和户外遮阳。',
    };
    const outgoing = {
      ...incoming,
      id: 'sent-1',
      direction: 'outbound',
      externalId: '<sent1@example.org>',
      occurredAt: time,
      deliveryStatus: 'sent',
      body: 'Our introduction',
      notes: '发送备注',
    };
    graph.messages.unshift(outgoing);
    graph.tasks[0].messageIds = ['sent-1', 'msg-1'];
    const original = {
      record_id: 'copied-row',
      fields: {
        沟通记录ID: 'NO.163',
        关联客户: ['customer-1'],
        触达渠道: '邮件',
        '发送/沟通时间': Date.parse(time),
        发送内容摘要: outgoing.body,
        业务员纪要: '人工说明',
        关联模板: ['template-1'],
        本次动作指令: '继续跟进找关键人',
      },
    };
    f.records.get('t3').push(original);
    const target = { ...env, FEISHU_MESSAGES_TABLE_ID: 't3' },
      options = { products: [{ id: 'product-1', version: 2 }] };
    const create = () =>
      new CustomerBusinessFeishu({ env: target, client: f.client, journalPath: path });
    const before = structuredClone(graph);
    let result = await create().sync(graph, options);
    assert.equal(result.status, 'synced', result.error);
    assert.deepEqual(graph, before);
    assert.equal(f.records.get('t3').length, 1);
    assert.equal(result.counts.messages, 1);
    assert(original.fields['收到回复内容'].includes(incoming.body));
    assert.equal(original.fields['回复类型'], '真人客户回复');
    assert.equal(original.fields['提取客户信息'], '联系人：Buyer');
    for (const row of f.records.get('t1')) assert.deepEqual(row.fields.来源沟通, ['copied-row']);
    assert.deepEqual(f.records.get('t4')[0].fields.关联沟通, ['copied-row']);
    assert.equal(original.fields['沟通记录ID'], 'NO.163');
    assert.deepEqual(original.fields['关联模板'], ['template-1']);
    assert.equal(original.fields['本次动作指令'], '继续跟进找关键人');
    assert.match(original.fields['业务员纪要'], /人工说明/);
    const auto = {
      ...incoming,
      id: 'auto-2',
      occurredAt: '2026-10-24T12:02:00.000Z',
      externalId: '<auto@example.org>',
      inReplyTo: '<sent1@example.org>',
      classification: 'auto_reply',
      body: 'Request received',
      replyAnalysis: undefined,
    };
    const next = {
      ...outgoing,
      id: 'sent-2',
      occurredAt: '2026-10-24T12:03:00.000Z',
      externalId: '<sent2@example.org>',
      body: 'Follow up',
    };
    graph.messages.push(auto, next);
    result = await create().sync(graph, options);
    assert.equal(result.status, 'synced', result.error);
    assert.equal(f.records.get('t3').length, 2);
    assert(original.fields['收到回复内容'].includes(auto.body));
    assert.equal(original.fields.回复类型, '真人客户回复');
    const second = f.records.get('t3').find((r) => r !== original);
    assert.equal(second.fields.回复类型, '无回复');
    assert(!second.fields.收到回复内容);
    const count = f.writes.length;
    result = await create().sync(graph, options);
    assert.equal(result.status, 'synced', result.error);
    assert.equal(f.writes.length, count);
    const mapped = JSON.parse(readFileSync(path, 'utf8')).filter((e) => e.state === 'mapped');
    assert(mapped.some((e) => e.key.endsWith(':msg-1') && e.recordId === 'copied-row'));
    assert(mapped.some((e) => e.key.endsWith(':auto-2') && e.recordId === 'copied-row'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('原T3新增响应丢失后按发送事实读回接续，不重复插入；冲突副本不猜测覆盖', async () => {
  for (const ambiguous of [false, true]) {
    const f = fixture();
    originalMessageTable(f);
    const graph = workspace();
    graph.demands = [];
    graph.tasks = [];
    graph.messages = [{ ...graph.messages[0], direction: 'outbound', deliveryStatus: 'sent' }];
    const m = graph.messages[0],
      target = { ...env, FEISHU_MESSAGES_TABLE_ID: 't3' },
      journal = [];
    if (ambiguous)
      for (const id of ['a', 'b'])
        f.records.get('t3').push({
          record_id: id,
          fields: {
            关联客户: ['customer-1'],
            触达渠道: '邮件',
            '发送/沟通时间': Date.parse(m.occurredAt),
            发送内容摘要: m.body,
          },
        });
    const bridge = () => new CustomerBusinessFeishu({ env: target, client: f.client, journal });
    f.state.loseResponse = () => true;
    let result = await bridge().sync(graph, { products: [] });
    assert.equal(result.status, 'pending');
    if (ambiguous) {
      assert.equal(f.writes.length, 0);
      continue;
    }
    assert.equal(f.records.get('t3').length, 1);
    f.state.loseResponse = undefined;
    result = await bridge().sync(graph, { products: [] });
    assert.equal(result.status, 'synced', result.error);
    assert.equal(f.records.get('t3').length, 1);
    assert.equal(f.writes.filter((w) => w.action === 'insert').length, 1);
  }
});

test('不同账号或会话即使同一时间发送相同内容，也不能接管同一条原T3记录', async () => {
  const f = fixture();
  originalMessageTable(f);
  const graph = workspace();
  graph.demands = [];
  graph.tasks = [];
  const first = { ...graph.messages[0], direction: 'outbound', deliveryStatus: 'sent' };
  graph.messages = [
    first,
    {
      ...first,
      id: 'other-send',
      account: 'other@example.com',
      conversationId: 'other-conversation',
      externalId: 'other-external',
    },
  ];
  f.records.get('t3').push({
    record_id: 'copied-row',
    fields: {
      关联客户: ['customer-1'],
      触达渠道: '邮件',
      '发送/沟通时间': Date.parse(first.occurredAt),
      发送内容摘要: first.body,
      回复类型: '无回复',
    },
  });
  const journal = [];
  const bridge = new CustomerBusinessFeishu({
    env: { ...env, FEISHU_MESSAGES_TABLE_ID: 't3' },
    client: f.client,
    journal,
  });
  const result = await bridge.sync(graph, { products: [] });
  assert.equal(result.status, 'pending');
  assert.match(result.error, /不同沟通轮次/);
  assert(!journal.some((event) => event.state === 'mapped' && event.key.endsWith(':other-send')));
  assert.equal(f.records.get('t3').length, 1);
});

test('原T4只用九列，重启后通过持久映射更新同一任务，保留自动编号及手填模板', async () => {
  const root = mkdtempSync(join(tmpdir(), 'original-tasks-'));
  try {
    const path = join(root, 'journal.json');
    const f = fixture();
    originalTaskTable(f);
    const taskEnv = { ...env, FEISHU_TASKS_TABLE_ID: 't4' };
    const graph = workspace();
    const options = { products: [{ id: 'product-1', version: 2 }] };
    const bridge = new CustomerBusinessFeishu({
      env: taskEnv,
      client: f.client,
      journalPath: path,
    });
    f.records
      .get('t4')
      .push({ record_id: 'manual-task', fields: { 任务ID: 'NO.099', 任务说明: '原表人工任务' } });
    assert.equal((await bridge.sync(graph, options)).status, 'synced');
    const task = f.records.get('t4').find((row) => row.record_id !== 'manual-task');
    task.fields.使用模板 = ['template-1'];
    const originalId = task.record_id;
    const restarted = new CustomerBusinessFeishu({
      env: taskEnv,
      client: f.client,
      journalPath: path,
    });
    graph.tasks[0] = {
      ...graph.tasks[0],
      version: 2,
      status: 'completed',
      channel: 'whatsapp',
      title: '核对规格已完成',
      owner: '尚未登记的业务员',
      basisMessageId: '',
      resultMessageId: 'msg-1',
    };
    const result = await restarted.sync(graph, options);
    assert.equal(result.status, 'synced', result.error);
    assert.equal(f.records.get('t4').length, 2);
    assert.equal(task.record_id, originalId);
    assert.equal(task.fields.任务ID, 'NO.001');
    assert.equal(task.fields.任务状态, '已完成');
    assert.equal(task.fields.任务类型, 'WhatsApp触达');
    assert.deepEqual(task.fields.使用模板, ['template-1']);
    assert.deepEqual(task.fields.负责业务员, []);
    assert.deepEqual(task.fields.关联沟通记录, [f.records.get('t3')[0].record_id]);
    assert.match(task.fields.任务说明, /尚未登记的业务员/);
    assert.deepEqual(f.records.get('t4')[0].fields, { 任务ID: 'NO.099', 任务说明: '原表人工任务' });
    const count = f.writes.length;
    await restarted.sync(graph, options);
    assert.equal(f.writes.length, count);
    graph.tasks[0].version = 1;
    assert.match((await restarted.sync(graph, options)).error, /更高同步版本/);
    assert.equal(f.writes.length, count);
    await assert.rejects(restarted.provision(f.provision), /无需重新建表/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('原T4新增响应丢失时持久标记待核对，重启和新版本都不重复新增', async () => {
  const f = fixture();
  originalTaskTable(f);
  const taskEnv = { ...env, FEISHU_TASKS_TABLE_ID: 't4' };
  const journal = [];
  const bridge = new CustomerBusinessFeishu({ env: taskEnv, client: f.client, journal });
  f.state.loseResponse = ({ action, tableId }) => tableId === 't4' && action === 'insert';
  const graph = workspace();
  const options = { products: [{ id: 'product-1', version: 2 }] };
  assert.equal((await bridge.sync(graph, options)).status, 'pending');
  assert.equal(f.records.get('t4').length, 1);
  const count = f.writes.length;
  f.state.loseResponse = undefined;
  const restarted = new CustomerBusinessFeishu({
    env: taskEnv,
    client: f.client,
    journal: structuredClone(journal),
  });
  graph.tasks[0].version++;
  assert.match((await restarted.sync(graph, options)).error, /上次写入仍待核对/);
  assert.equal(f.writes.length, count);
  assert.equal(f.records.get('t4').length, 1);
});

test('原T4其他渠道留空并写入说明，缺少业务员对应时不虚构关联', async () => {
  const f = fixture();
  originalTaskTable(f);
  f.records.set('t8', []);
  const bridge = new CustomerBusinessFeishu({
    env: { ...env, FEISHU_TASKS_TABLE_ID: 't4' },
    client: f.client,
  });
  const graph = workspace();
  graph.tasks[0].channel = 'other';
  const result = await bridge.sync(graph, { products: [{ id: 'product-1', version: 2 }] });
  assert.equal(result.status, 'synced', result.error);
  const task = f.records.get('t4')[0];
  assert(!task.fields.任务类型);
  assert.deepEqual(task.fields.负责业务员, []);
  assert.match(task.fields.任务说明, /负责人：Johnson\n触达渠道：其他/);
});

test('原T1仅十列，汇总规格数量，重启后更新原询盘并保留意向等级和沟通关联', async () => {
  const root = mkdtempSync(join(tmpdir(), 'original-inquiries-'));
  try {
    const path = join(root, 'journal.json');
    const f = fixture();
    originalDemandTable(f);
    const inquiryEnv = { ...env, FEISHU_DEMANDS_TABLE_ID: 't1' };
    const graph = workspace();
    graph.demands[0].direction = '';
    graph.messages[0].occurredAt = '2026-10-23T08:00:00.000Z';
    const raw = structuredClone(graph);
    const options = { products: [{ id: 'product-1', version: 2 }] };
    const bridge = new CustomerBusinessFeishu({
      env: inquiryEnv,
      client: f.client,
      journalPath: path,
    });
    let result = await bridge.sync(graph, options);
    assert.equal(result.status, 'synced', result.error);
    assert.deepEqual(graph, raw, '数据库数据不因展示精简而改变');
    const demand = f.records.get('t1')[0];
    assert.equal(
      demand.fields.客户需求,
      'Roller blinds\n产品：roller blinds\n规格：Size to confirm\n数量：100 sets',
    );
    assert.deepEqual(demand.fields.询盘来源, ['收件邮箱']);
    assert.equal(demand.fields.询盘接收时间, Date.parse(graph.messages[0].occurredAt));
    assert.equal(demand.fields.处理状态, '跟进中');
    assert.deepEqual(demand.fields.负责业务员, ['sales-1']);
    assert.deepEqual(demand.fields.关联客户, ['customer-1']);
    assert.deepEqual(demand.fields.询盘产品, ['product-record-1']);
    const originalId = demand.record_id,
      number = demand.fields.询盘编号;
    demand.fields.意向等级 = 'B中意向';
    graph.demands[0] = {
      ...graph.demands[0],
      stage: 'quoting',
      quantity: '200',
      version: 2,
      owner: '未登记业务员',
    };
    const restarted = new CustomerBusinessFeishu({
      env: inquiryEnv,
      client: f.client,
      journalPath: path,
    });
    result = await restarted.sync(graph, options);
    assert.equal(result.status, 'synced', result.error);
    assert.equal(f.records.get('t1').length, 2);
    assert.equal(demand.record_id, originalId);
    assert.equal(demand.fields.询盘编号, number);
    assert.equal(demand.fields.意向等级, 'B中意向');
    assert.equal(demand.fields.处理状态, '已报价');
    assert.match(demand.fields.客户需求, /数量：200 sets/);
    assert.deepEqual(demand.fields.负责业务员, []);
    assert.match(demand.fields.备注, /未登记业务员/);
    assert.deepEqual(
      f.records.get('t3')[0].fields.关联需求,
      f.records.get('t1').map((row) => row.record_id),
    );
    const count = f.writes.length;
    assert.equal((await restarted.sync(graph, options)).status, 'synced');
    assert.equal(f.writes.length, count);
    graph.demands[0].version = 1;
    assert.match((await restarted.sync(graph, options)).error, /更高同步版本/);
    assert.equal(f.writes.length, count);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('原T1新增响应丢失时保留待核对，后续新版本不重复新增', async () => {
  const f = fixture();
  originalDemandTable(f);
  const inquiryEnv = { ...env, FEISHU_DEMANDS_TABLE_ID: 't1' };
  const journal = [];
  const bridge = new CustomerBusinessFeishu({ env: inquiryEnv, client: f.client, journal });
  f.state.loseResponse = ({ action, tableId }) => action === 'insert' && tableId === 't1';
  const graph = workspace();
  const options = { products: [{ id: 'product-1', version: 2 }] };
  assert.equal((await bridge.sync(graph, options)).status, 'pending');
  assert.equal(f.records.get('t1').length, 1);
  const count = f.writes.length;
  f.state.loseResponse = undefined;
  graph.demands[0].version++;
  const restarted = new CustomerBusinessFeishu({
    env: inquiryEnv,
    client: f.client,
    journal: structuredClone(journal),
  });
  assert.match((await restarted.sync(graph, options)).error, /上次写入仍待核对/);
  assert.equal(f.writes.length, count);
  assert.equal(f.records.get('t1').length, 1);
});
