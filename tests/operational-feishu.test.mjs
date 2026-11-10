import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { acquisitionJobs, syncOperationalFeishu, taskRow } from '../server/operational-feishu.mjs';

const job = (id, status = 'completed') => ({
  id,
  scope: 'test',
  input: {
    country: 'Australia',
    region: '',
    product: 'window coverings',
    acquisition_channel: 'web',
  },
  status,
  reason: status === 'completed' ? 'target_reached' : 'research_limit',
  createdAt: '2026-11-05T23:00:00.670Z',
  completedAt: '2026-11-05T23:32:55.362Z',
  target: 50,
  inserted: status === 'completed' ? 50 : 7,
  skipped: 9,
  researched: 140,
  searches: 23,
});

test('T7 只读取当前 Base 作用域的全部执行，不受页面最近 100 条限制', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO jobs VALUES(?,?)');
    for (let i = 0; i < 102; i++) insert.run(`job-${i}`, JSON.stringify(job(`job-${i}`)));
    insert.run('other', JSON.stringify({ ...job('other'), scope: 'other-base' }));
    assert.equal(acquisitionJobs(db, 'test').length, 102);
    assert(!acquisitionJobs(db, 'test').some((item) => item.id === 'other'));
  } finally {
    db.close();
  }
});

test('T7 保留每次执行的真实口径，部分完成不冒充已完成', () => {
  const row = taskRow(job('original-job', 'partial'));
  assert.equal(row.任务状态, null);
  assert.equal(row.新增有效客户数, 7);
  assert.equal(row.重复客户数量, 9);
  assert.equal(row.任务开始时间, Date.parse('2026-11-05T23:00:00.670Z'));
  assert.match(row.任务日志, /原系统任务编号：original-job/);
  assert.match(row.任务日志, /实际研究：140/);
  assert(!Object.hasOwn(row, '抓取客户总数'));
  assert(!Object.hasOwn(row, '采集渠道'));
});

test('正式 Base T7/T8/T10 首次补写与再次同步均按业务键核对，凭证不外发', async () => {
  const tables = [
    { name: 'T2｜客户主表', table_id: 't2' },
    { name: 'T7｜定时触发调度表', table_id: 't7' },
    { name: 'T8｜销售&账号管理表', table_id: 't8' },
    { name: 'T10｜多场景模板库表', table_id: 't10' },
  ];
  const fields = {
    t7: [
      ['任务ID', 1005],
      ['任务名称', 1],
      ['目标国家/区域', 1],
      ['片区', 1],
      ['任务开始时间', 5],
      ['任务结束时间', 5],
      ['新增有效客户数', 2],
      ['重复客户数量', 2],
      ['任务状态', 3, ['执行中', '已完成']],
      ['任务日志', 1],
    ],
    t8: [
      ['账号ID', 1005],
      ['业务员名称', 1],
      ['账号类型', 3, ['邮箱账号']],
      ['账号地址/号码', 1],
      ['每日发送额度', 2],
      ['今日已发送数量', 2],
      ['账号状态', 3, ['正常', '暂停']],
      ['备注', 1],
    ],
    t10: [
      ['模板ID', 1005],
      ['模板名称', 1],
      ['沟通场景', 3, ['首次开发邮件']],
      ['适用客户等级', 3, ['全部']],
      ['沟通目标', 1],
      ['模板主体文案', 1],
      ['提示词附加业务指引', 1],
      ['启用状态', 3, ['停用']],
      ['模板类型', 3, ['邮件模板']],
      ['适用开发阶段', 3, ['首封开发']],
      ['备注', 1],
    ],
  };
  const records = new Map([
    ['t7', []],
    ['t8', []],
    ['t10', []],
  ]);
  const writes = [];
  const client = {
    tables: async () => tables,
    fields: async (id) =>
      fields[id].map(([field_name, type, options]) => ({
        field_name,
        type,
        ...(options ? { property: { options: options.map((name) => ({ name })) } } : {}),
      })),
    records: async (id) => structuredClone(records.get(id)),
    record: async (id, table) =>
      structuredClone(records.get(table).find((r) => r.record_id === id)),
    write: async (action, values, id, _token, table) => {
      writes.push({ action, table, values });
      const rows = records.get(table);
      const record =
        action === 'insert'
          ? { record_id: `${table}-${rows.length + 1}`, fields: structuredClone(values) }
          : rows.find((row) => row.record_id === id);
      if (action === 'insert') rows.push(record);
      else Object.assign(record.fields, structuredClone(values));
      return structuredClone(record);
    },
  };
  const input = {
    env: { FEISHU_APP_TOKEN: 'formal-base', FEISHU_TABLE_ID: 't2' },
    client,
    journalPath: ':memory:',
    jobs: [job('job-1'), job('job-2', 'partial')],
    mailboxes: [
      {
        id: 'mailbox-1',
        email: 'sales@example.com',
        displayName: 'Lucy',
        brandName: 'Example',
        dailyLimit: 50,
        paused: false,
        verification: { smtpVerified: true },
        credential: 'must-not-export',
      },
    ],
    deliveries: [],
  };
  assert.deepEqual(await syncOperationalFeishu(input), { T7: 2, T8: 1, T10: 3 });
  assert.deepEqual(
    [...records.values()].map((rows) => rows.length),
    [2, 1, 3],
  );
  assert.equal(writes.length, 6);
  assert(!JSON.stringify(writes).includes('must-not-export'));
  await syncOperationalFeishu(input);
  assert.equal(writes.length, 6);
  input.jobs[0].inserted = 51;
  input.mailboxes.push({ ...input.mailboxes[0], id: 'mailbox-2', email: 'other@example.com' });
  await syncOperationalFeishu(input);
  assert.equal(records.get('t7')[0].fields.新增有效客户数, 51);
  assert.equal(records.get('t8').length, 2);
  const before = writes.length;
  fields.t10.find(([name]) => name === '沟通场景')[2] = ['其他'];
  await assert.rejects(syncOperationalFeishu(input), /T10 缺少选项：首次开发邮件/);
  assert.equal(writes.length, before);
});
