import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CustomerBusinessFeishu, safeWrite, sameFields } from './customer-business-feishu.mjs';
import { formatAssessmentEvidence, ASSESSMENT_RULE_VERSION } from './customer-assessment.mjs';
import { fieldValue, customerWebsite } from './customer-fields.mjs';
import { fieldText } from './feishu.mjs';
import { domainKey } from './website-identity.mjs';
import { checkMirrorMaintenance } from './mirror-maintenance.mjs';

const formalBase = 'Xat4bgUFuaL6tBsXqRccnYaknEf';
const formalT2 = 'tbloekB1ocuwmfuG';
const formalT12 = 'tblrD2ZCIfhiMUcq';
const required = {
  评估记录ID: 1005,
  关联客户: 18,
  评估时间: 5,
  本次综合得分: 2,
  本次评级: 3,
  打分依据摘要: 1,
  AI评估结论: 1,
  评估版本: 1,
};
const relationIds = (value) =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((item) =>
      typeof item === 'string' ? [item] : item?.record_ids || [item?.record_id || item?.id],
    )
    .filter(Boolean);

// T12 holds one current row per T2 customer. The auto-number is owned by Feishu.
export async function syncAssessmentFeishu({
  env,
  assessments = [],
  customers = [],
  customerRemoteId = (id) => id,
  client,
  journalPath,
  apply = false,
  isMaintaining = () => false,
} = {}) {
  const mirror = new CustomerBusinessFeishu({
    env,
    isMaintaining,
    client,
    journalPath:
      journalPath ||
      join(
        dirname(env.CONNECTIONS_PATH || '.data/api-connections.json'),
        'assessment-feishu-journal.json',
      ),
  });
  assert(mirror.configured, '飞书连接未配置');
  const tables = await mirror.client.tables();
  const t2 = tables.find((table) => table.table_id === env.FEISHU_TABLE_ID);
  assert(t2?.name.startsWith('T2｜'), '飞书客户主表与目标 Base 不一致');
  if (env.FEISHU_APP_TOKEN === formalBase)
    assert.equal(t2.table_id, formalT2, 'T2 不是正式 Base 原表');
  const matches = tables.filter((table) => table.name.startsWith('T12｜'));
  if (env.FEISHU_APP_TOKEN !== formalBase && !matches.length)
    return { configured: false, source: assessments.length, create: 0, update: 0 };
  assert.equal(matches.length, 1, '未找到唯一的 T12 客户评估表');
  const t12 = matches[0];
  if (env.FEISHU_APP_TOKEN === formalBase)
    assert.equal(t12.table_id, formalT12, 'T12 不是正式 Base 原表');
  const [fields, t2Records, t12Records] = await Promise.all([
    mirror.client.fields(t12.table_id),
    mirror.client.records(t2.table_id),
    mirror.client.records(t12.table_id, undefined, 200),
  ]);
  for (const [name, type] of Object.entries(required))
    assert(
      fields.some((field) => field.field_name === name && field.type === type),
      'T12 字段缺失或类型不符：' + name,
    );
  const relation = fields.find((field) => field.field_name === '关联客户');
  assert(
    relation.property?.table_id === t2.table_id && relation.property?.multiple === true,
    'T12 关联客户目标不符',
  );
  const choices = new Set(
    fields
      .find((field) => field.field_name === '本次评级')
      .property?.options?.map((option) => option.name),
  );
  assert(
    ['A', 'B', 'C'].every((grade) => choices.has(grade)),
    'T12 本次评级缺少 A/B/C 选项',
  );
  const byCustomer = new Map();
  for (const record of t12Records) {
    const ids = [...new Set(relationIds(record.fields?.关联客户))];
    assert(ids.length === 1, 'T12 评估必须关联唯一客户');
    assert(!byCustomer.has(ids[0]), 'T12 同一客户存在多条评估');
    byCustomer.set(ids[0], record);
  }
  const t2ById = new Map(t2Records.map((record) => [record.record_id, record]));
  const localById = new Map(customers.map((lead) => [lead.id, lead]));
  const planned = [];
  const sourceIds = new Set();
  const remoteIds = new Set();
  let pendingCustomers = 0;
  for (const snapshot of assessments) {
    assert(snapshot.ruleVersion === ASSESSMENT_RULE_VERSION, 'T12 只同步当前评估版本');
    assert(
      snapshot.id && snapshot.recordId && !sourceIds.has(snapshot.recordId),
      '当前评估客户编号缺失或重复',
    );
    sourceIds.add(snapshot.recordId);
    const remoteId = customerRemoteId(snapshot.recordId);
    if (!remoteId) {
      pendingCustomers++;
      continue;
    }
    assert(!remoteIds.has(remoteId), '多份评估指向同一 T2 客户：' + remoteId);
    remoteIds.add(remoteId);
    const customer = t2ById.get(remoteId);
    assert(customer, 'T12 关联的 T2 客户不存在：' + snapshot.recordId);
    const website = customerWebsite(customer) || localById.get(snapshot.recordId)?.website;
    assert(
      domainKey(website) && domainKey(website) === domainKey(snapshot.website),
      'T12 评估与 T2 客户官网主体不一致：' + snapshot.recordId,
    );
    const grade = snapshot.grade === null || snapshot.grade === '' ? null : snapshot.grade;
    assert(
      grade === null || ['A', 'B', 'C'].includes(grade),
      'T12 当前评级无效：' + snapshot.recordId,
    );
    assert(Number.isFinite(snapshot.score), 'T12 当前得分无效：' + snapshot.recordId);
    assert.equal(
      fieldText(fieldValue(customer.fields, '用户评级')),
      grade || '',
      'T2 当前评级与评估快照不一致：' + snapshot.recordId,
    );
    assert(
      typeof snapshot.reason === 'string' &&
        snapshot.reason.startsWith(`[自动评估 ${snapshot.id}]`),
      'T12 评估结论缺少稳定编号：' + snapshot.recordId,
    );
    const values = {
      关联客户: [remoteId],
      评估时间: Date.parse(snapshot.evaluatedAt),
      本次综合得分: snapshot.score,
      本次评级: grade,
      打分依据摘要: formatAssessmentEvidence(snapshot),
      AI评估结论: snapshot.reason,
      评估版本: snapshot.ruleVersion,
    };
    assert(Number.isFinite(values.评估时间), 'T12 评估时间无效：' + snapshot.recordId);
    planned.push({ remoteId, record: byCustomer.get(remoteId), values });
  }
  const pending = planned.filter(
    ({ record, values }) => !record || !sameFields(record, values, fields),
  );
  const result = {
    configured: true,
    source: assessments.length,
    pendingCustomers,
    create: pending.filter((item) => !item.record).length,
    update: pending.filter((item) => item.record).length,
  };
  if (!apply) return result;
  for (const item of pending) {
    checkMirrorMaintenance(isMaintaining);
    let record = item.record;
    let attempted = false;
    const key = `${mirror.scope}:T12:${t12.table_id}:${item.remoteId}`;
    const token = createHash('sha256').update(key).digest('hex');
    const uuid = `${token.slice(0, 8)}-${token.slice(8, 12)}-4${token.slice(13, 16)}-a${token.slice(17, 20)}-${token.slice(20, 32)}`;
    await safeWrite(
      {
        journal: mirror.journal,
        checkpoint: () => mirror.persistJournal(),
        retry: Boolean(record),
      },
      key,
      async () => {
        attempted = true;
        record = await mirror.client.write(
          record ? 'update' : 'insert',
          record
            ? item.values
            : Object.fromEntries(Object.entries(item.values).filter(([, value]) => value !== null)),
          record?.record_id,
          uuid,
          t12.table_id,
        );
      },
      async () => {
        if (!record && attempted) {
          const matches = (await mirror.client.records(t12.table_id, undefined, 200)).filter(
            (row) => relationIds(row.fields?.关联客户).includes(item.remoteId),
          );
          assert(matches.length <= 1, 'T12 同一客户存在多条评估');
          record = matches[0];
        }
        if (!record) return false;
        const saved = await mirror.client.record(record.record_id, t12.table_id);
        if (!sameFields(saved, item.values, fields)) return false;
        byCustomer.set(item.remoteId, saved);
        return true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return result;
}
