import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncAssessmentFeishu } from '../server/assessment-feishu.mjs';

const env = { FEISHU_APP_TOKEN: 'test-base', FEISHU_TABLE_ID: 't2' };
const snapshot = (id, recordId, website, grade = 'C') => ({
  id,
  recordId,
  website,
  ruleVersion: 'acquisition-v5.0',
  evaluatedAt: '2026-11-13T01:00:00.000Z',
  grade,
  score: grade === 'A' ? 85 : 37,
  reason: `[自动评估 ${id}]\n开发优先级：${grade}`,
  opportunities: [],
});

function fixture() {
  const records = {
    t2: [
      { record_id: 'remote-1', fields: { 官网链接: 'https://one.example/', 最新客户评级: 'A' } },
      { record_id: 'remote-2', fields: { 官网链接: '', 最新客户评级: 'C' } },
    ],
    t12: [],
  };
  const calls = { records: [], writes: [] };
  let loseResponse = false;
  const client = {
    tables: async () => [
      { table_id: 't2', name: 'T2｜客户主表' },
      { table_id: 't12', name: 'T12｜客户评估表' },
    ],
    fields: async () =>
      [
        ['评估记录ID', 1005],
        ['关联客户', 18, { table_id: 't2', multiple: true }],
        ['评估时间', 5],
        ['本次综合得分', 2],
        ['本次评级', 3, { options: ['A', 'B', 'C'].map((name) => ({ name })) }],
        ['打分依据摘要', 1],
        ['AI评估结论', 1],
        ['评估版本', 1],
      ].map(([field_name, type, property]) => ({ field_name, type, property })),
    records: async (id) => {
      calls.records.push(id);
      return structuredClone(records[id]);
    },
    record: async (id, table) =>
      structuredClone(records[table].find((row) => row.record_id === id)),
    write: async (action, values, id, _token, table) => {
      calls.writes.push({ action, values, table });
      const row =
        action === 'insert'
          ? { record_id: 'assessment-' + (records.t12.length + 1), fields: structuredClone(values) }
          : records.t12.find((item) => item.record_id === id);
      if (action === 'insert') records.t12.push(row);
      else Object.assign(row.fields, structuredClone(values));
      if (loseResponse) {
        loseResponse = false;
        throw new Error('response lost');
      }
      return structuredClone(row);
    },
  };
  const input = {
    env,
    client,
    journalPath: ':memory:',
    customers: [
      { id: 'local_1', website: 'https://one.example/' },
      { id: 'local_2', website: 'https://two.example/' },
    ],
    customerRemoteId: (id) => ({ local_1: 'remote-1', local_2: 'remote-2' })[id],
    assessments: [
      snapshot('ev_1', 'local_1', 'https://one.example/', 'A'),
      snapshot('ev_2', 'local_2', 'https://two.example/'),
    ],
  };
  return {
    records,
    calls,
    input,
    loseNextResponse: () => {
      loseResponse = true;
    },
  };
}

test('T12 以客户关联保存最新评估，检查模式只读，复跑不重复，换版原位更新', async () => {
  const f = fixture();
  assert.deepEqual(await syncAssessmentFeishu(f.input), {
    configured: true,
    source: 2,
    pendingCustomers: 0,
    create: 2,
    update: 0,
  });
  assert.equal(f.calls.writes.length, 0);
  await syncAssessmentFeishu({ ...f.input, apply: true });
  assert.equal(f.records.t12.length, 2);
  assert.equal(
    f.calls.records.filter((table) => table === 't12').length,
    2,
    '正常写入不逐行重读整张 T12',
  );
  assert(f.calls.writes.every((call) => call.table === 't12' && !('评估记录ID' in call.values)));
  assert.deepEqual(
    f.records.t12[1].fields.关联客户,
    ['remote-2'],
    'T2 官网空值时可使用本地主档案核对主体',
  );
  assert.equal(f.records.t12[0].fields.本次综合得分, 85);
  assert.match(f.records.t12[0].fields.打分依据摘要, /依据/);
  f.records.t12[0].fields.关联客户 = [{ id: 'remote-1' }];
  await syncAssessmentFeishu({ ...f.input, apply: true });
  assert.equal(f.calls.writes.length, 2);
  const id = f.records.t12[0].record_id;
  f.input.assessments[0] = snapshot('ev_3', 'local_1', 'https://one.example/', 'C');
  f.records.t2[0].fields.最新客户评级 = 'C';
  await syncAssessmentFeishu({ ...f.input, apply: true });
  assert.equal(f.records.t12[0].record_id, id);
  assert.equal(f.records.t12[0].fields.AI评估结论, f.input.assessments[0].reason);
  assert.equal(f.calls.writes.at(-1).action, 'update');
  f.records.t2[0].fields.最新客户评级 = 'B';
  await assert.rejects(syncAssessmentFeishu({ ...f.input, apply: true }), /T2 当前评级/);
  assert.equal(f.calls.writes.length, 3, '评级冲突在任何写入前阻止同步');
});

test('T12 新增响应丢失时按客户关系重新读表确认，不重复新增', async () => {
  const f = fixture();
  f.input.assessments = f.input.assessments.slice(0, 1);
  f.loseNextResponse();
  await syncAssessmentFeishu({ ...f.input, apply: true });
  assert.equal(f.records.t12.length, 1);
  assert.equal(
    f.calls.records.filter((table) => table === 't12').length,
    2,
    '只有不明响应才额外重读 T12',
  );
  await syncAssessmentFeishu({ ...f.input, apply: true });
  assert.equal(f.calls.writes.length, 1);
});

test('T12 既有孤儿行阻止写入，避免失去客户关联后重复新增', async () => {
  const f = fixture();
  f.records.t12.push({ record_id: 'orphan', fields: { AI评估结论: '[自动评估 ev_1]' } });
  await assert.rejects(syncAssessmentFeishu({ ...f.input, apply: true }), /必须关联唯一客户/);
  assert.equal(f.calls.writes.length, 0);
});

test('没有有效评级的最新评估保留空评级，异常评级仍阻止同步', async () => {
  const f = fixture();
  f.records.t2[0].fields.最新客户评级 = '';
  f.input.assessments = [snapshot('ev_none', 'local_1', 'https://one.example/', null)];
  await syncAssessmentFeishu({ ...f.input, apply: true });
  assert.equal(f.records.t12.length, 1);
  assert(!Object.hasOwn(f.records.t12[0].fields, '本次评级'));
  f.input.assessments[0].grade = 'D';
  await assert.rejects(syncAssessmentFeishu({ ...f.input, apply: true }), /当前评级无效/);
  assert.equal(f.calls.writes.length, 1);
});
