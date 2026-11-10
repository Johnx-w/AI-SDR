import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { CustomerBusinessApi } from '../server/customer-business-api.mjs';
import { FollowUpFeishu } from '../server/follow-up-feishu.mjs';
import { referenceRows } from '../scripts/fill-follow-up-references.mjs';

function fixture() {
  const fields = [
    ['任务ID', 1005],
    ['关联客户', 18, 't2'],
    ['关联沟通记录', 18, 't3'],
    ['任务类型', 3, ['邮件触达', 'WhatsApp触达', '网站留言', '人工电话外呼']],
    ['计划执行时间', 5],
    ['任务状态', 3, ['待执行', '已完成', '跳过', '终止']],
    ['使用模板', 18, 't10'],
    ['任务说明', 1],
    ['负责业务员', 18, 't8'],
  ].map(([field_name, type, values]) => ({
    field_name,
    type,
    property:
      type === 18
        ? { table_id: values, multiple: true }
        : type === 3
          ? { options: values.map((name) => ({ name })) }
          : null,
  }));
  const rows = new Map([
    ['t4', []],
    ['t2', [{ record_id: 'new-customer', fields: { 官网链接: 'https://buyer.test' } }]],
    ['t3', []],
    [
      't8',
      [
        {
          record_id: 'owner',
          fields: {
            业务员名称: 'Lucy',
            账号类型: '邮箱账号',
            '账号地址/号码': 'sales@example.test',
            账号状态: '正常',
          },
        },
      ],
    ],
    [
      't10',
      [
        {
          record_id: 'template',
          fields: { 模板名称: '首封', 模板类型: '邮件模板', 启用状态: '停用' },
        },
      ],
    ],
  ]);
  const writes = [];
  const journal = [];
  const client = {
    fields: async (table) => {
      assert.equal(table, 't4');
      return structuredClone(fields);
    },
    records: async (table) => structuredClone(rows.get(table)),
    record: async (id, table) => structuredClone(rows.get(table).find((r) => r.record_id === id)),
    write: async (action, fields, id, _token, table) => {
      assert.equal(table, 't4', '只允许写 T4');
      assert(!Object.hasOwn(fields, '任务ID') && !Object.hasOwn(fields, '任务编号'));
      writes.push({ action, fields });
      const record =
        action === 'insert'
          ? { record_id: 'task-' + rows.get(table).length, fields: { 任务ID: 'NO.001' } }
          : rows.get(table).find((r) => r.record_id === id);
      Object.assign(record.fields, structuredClone(fields));
      if (action === 'insert') rows.get(table).push(record);
      return structuredClone(record);
    },
  };
  const options = {
    env: { FEISHU_APP_TOKEN: 'new-base', FEISHU_TABLE_ID: 't4', FEISHU_TASKS_TABLE_ID: 't4' },
    client,
    journal,
  };
  const task = {
    id: 'local-task',
    version: 1,
    customerId: 'local-customer',
    channel: 'email',
    dueAt: '2026-11-11T01:00:00Z',
    status: 'pending',
    notes: '介绍产品',
    messageIds: [],
    ownerIds: ['owner'],
    templateIds: ['template'],
  };
  return {
    rows,
    writes,
    journal,
    options,
    task,
    mirror: new FollowUpFeishu(options),
    customers: [{ id: 'local-customer', website: 'https://buyer.test' }],
  };
}

test('T4 同步仅写九个字段，真实关联、自动编号、跨实例重复同步不新增', async () => {
  const f = fixture();
  const workspace = { tasks: [f.task], messages: [], demands: [] };
  const result = await f.mirror.sync(workspace, { customers: f.customers });
  assert.equal(result.status, 'synced', result.error);
  assert.deepEqual(f.writes[0].fields.关联客户, ['new-customer']);
  assert.deepEqual(f.writes[0].fields.关联沟通记录, []);
  assert.deepEqual(f.writes[0].fields.使用模板, ['template']);
  assert.equal(f.writes[0].fields.任务类型, '邮件触达');
  const restarted = new FollowUpFeishu(f.options);
  assert.equal((await restarted.sync(workspace, { customers: f.customers })).status, 'synced');
  assert.equal(f.writes.length, 1);
  assert.equal(f.journal.findLast((r) => r.state === 'mapped').displayId, 'NO.001');
  workspace.tasks[0] = { ...f.task, version: 2, status: 'skipped' };
  assert.equal((await restarted.sync(workspace, { customers: f.customers })).status, 'synced');
  assert.equal(f.writes[1].fields.任务状态, '跳过');
});

test('关联目标不存在时留空，不创建其他表；失效模板引用阻止写入', async () => {
  const f = fixture();
  f.rows.set('t2', []);
  assert.equal(
    (
      await f.mirror.sync(
        { tasks: [f.task], messages: [], demands: [] },
        { customers: f.customers },
      )
    ).status,
    'synced',
  );
  assert.deepEqual(f.writes[0].fields.关联客户, []);
  f.rows.set('t10', []);
  const result = await f.mirror.sync(
    { tasks: [{ ...f.task, version: 2 }], messages: [], demands: [] },
    { customers: f.customers },
  );
  assert.equal(result.status, 'pending');
  assert.equal(f.writes.length, 1);
});

test('T4 专用同步从 API 提前返回，不调用客户、产品或其他业务表同步', async () => {
  const f = fixture();
  const api = new CustomerBusinessApi({
    getEnv: () => ({}),
    knowledge: () => ({ list: () => [] }),
    loadCustomers: async () => f.customers,
    syncCustomers: () => assert.fail('不应同步客户'),
    saveCustomerFields: () => assert.fail('不应保存客户字段'),
  });
  api.state = () => ({
    tasksOnly: true,
    env: {},
    mirror: f.mirror,
    store: {
      scope: 'local',
      view: () => ({ tasks: [], messages: [], demands: [] }),
      db: { prepare: () => ({ run: () => {} }) },
    },
  });
  const result = await api.synchronize();
  assert.equal(result.counts.tasks, 0);
  assert.equal(f.writes.length, 0);
});

test('任务不需要旧行动标题，消息归属和类型校验，跳过与终止为终态', async () => {
  const store = new CustomerBusiness({
    customer: async (id) => ({ record_id: id }),
    now: () => new Date('2026-11-10T01:00:00Z'),
  });
  try {
    const base = {
      customerId: 'customer',
      channel: 'email',
      dueAt: '2026-11-11T01:00:00Z',
      notes: '发送介绍',
      templateIds: ['template'],
      ownerIds: ['owner'],
    };
    const task = await store.saveTask(base);
    assert.equal(task.kind, 'follow_up');
    assert.equal(task.title, '发送介绍');
    assert.deepEqual(task.templateIds, ['template']);
    const skipped = await store.actTask(task.id, { action: 'skip', expectedVersion: task.version });
    assert.equal(skipped.status, 'skipped');
    await assert.rejects(() => store.saveTask({ ...skipped, notes: '覆盖' }), /不能覆盖/);
    await assert.rejects(
      () => store.actTask(task.id, { action: 'complete', expectedVersion: skipped.version }),
      /已经完成、跳过或终止/,
    );
    const other = await store.saveTask(base);
    assert.equal(
      (await store.actTask(other.id, { action: 'cancel', expectedVersion: other.version })).status,
      'cancelled',
    );
    const conversation = await store.saveConversation({
      customerId: 'another',
      title: '其他客户',
      channel: 'email',
    });
    const message = await store.saveMessage({
      customerId: 'another',
      conversationId: conversation.id,
      direction: 'inbound',
      account: 'sales@example.test',
      from: 'buyer@another.test',
      to: 'sales@example.test',
      channel: 'email',
      occurredAt: '2026-11-10T00:00:00Z',
      deliveryStatus: 'received',
      body: 'hello',
      actualConfirmed: true,
    });
    await assert.rejects(
      () => store.saveTask({ ...base, messageIds: [message.id] }),
      /其他客户|所属企业/,
    );
  } finally {
    store.close();
  }
});

test('T8 仅导出业务字段，今日成功数排除失败和未知；T10 只填三条已确认首封模板', () => {
  const rows = referenceRows(
    [
      {
        id: 'm',
        displayName: 'Lucy',
        email: 'sales@test.org',
        dailyLimit: 50,
        paused: false,
        verification: { smtpVerified: true },
        credential: 'must-not-export',
      },
    ],
    ['accepted', 'failed', 'unknown'].map((status) => ({
      mailboxId: 'm',
      status,
      sentAt: '2026-11-09T17:00:00Z',
    })),
    readFileSync('docs/new-feishu-bitable-filling-spec.md', 'utf8'),
    '2026-11-10',
  );
  assert.equal(rows.owners[0].今日已发送数量, 1);
  assert(!JSON.stringify(rows).includes('must-not-export'));
  assert.equal(rows.templates.length, 3);
  assert(
    rows.templates.every((r) => r.启用状态 === '停用' && r.沟通场景.startsWith('首次开发邮件-')),
  );
});
