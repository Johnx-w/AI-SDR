import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssessmentService } from '../server/assessment-service.mjs';
import { AssessmentStore } from '../server/assessment-store.mjs';
import { assessCompany } from '../server/customer-assessment.mjs';

const env = { FEISHU_APP_TOKEN: 'test-base', FEISHU_TABLE_ID: 'test-customers' };
const customer = { record_id: 'customer-1', fields: { 来源链接: 'https://customer.example/' } };
const snapshot = (id, at) =>
  assessCompany({
    research: { source_url: 'https://customer.example/', entity_type: 'business', facts: [] },
    target: { product: 'roller blinds' },
    id,
    at: Date.parse(at),
  });

test('最新评估替换旧快照，重启仍能读取证据，旧操作恢复不覆盖新评估', () => {
  const directory = mkdtempSync(join(tmpdir(), 'current-assessment-'));
  const settings = { ...env, ASSESSMENT_DB_PATH: join(directory, 'assessment.sqlite') };
  let service = new AssessmentService({ env: settings });
  const first = snapshot('first', '2026-10-24T01:00:00Z');
  const second = snapshot('second', '2026-10-24T02:00:00Z');
  try {
    service.save(first, customer);
    const saved = service.save(second, customer);
    assert.equal(saved.id, 'second');
    assert.equal(saved.sync, undefined);
    assert.ok(saved.evidenceReason);
    assert.equal(service.summary('first'), null);
    assert.deepEqual(service.save(second, customer), saved, '重复操作不追加记录');
    assert.equal(service.save(first, customer).id, 'second');
    service.close();
    service = new AssessmentService({ env: settings });
    assert.equal(service.latest(customer.record_id).id, 'second');
    assert.equal(
      service.store.db.prepare('SELECT count(*) AS n FROM customer_assessments').get().n,
      1,
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('主体不符、旧规则或复用评估编号篡改内容均被拒绝，原最新结果不变', () => {
  const service = new AssessmentService({ env });
  const current = snapshot('same-id', '2026-10-24T01:00:00Z');
  try {
    service.save(current, customer);
    assert.throws(() => service.save({ ...current, score: 100 }, customer), /不能更换/);
    assert.throws(
      () => service.save({ ...current, ruleVersion: 'acquisition-v3.0' }, customer),
      /当前规则/,
    );
    assert.throws(
      () => service.save(current, { ...customer, fields: { 来源链接: 'https://other.example/' } }),
      /不一致/,
    );
    assert.equal(service.latest(customer.record_id).score, current.score);
  } finally {
    service.close();
  }
});

test('不同飞书表范围下同名客户相互隔离，不能占用其他范围的评估编号', () => {
  const directory = mkdtempSync(join(tmpdir(), 'current-assessment-scope-'));
  const path = join(directory, 'assessment.sqlite');
  const a = new AssessmentStore(path, 'a');
  const b = new AssessmentStore(path, 'b');
  try {
    a.saveCurrent(snapshot('a-id', '2026-10-24T01:00:00Z'), 'same-customer');
    b.saveCurrent(snapshot('b-id', '2026-10-24T01:00:00Z'), 'same-customer');
    assert.throws(
      () => b.saveCurrent(snapshot('a-id', '2026-10-24T02:00:00Z'), 'same-customer'),
      /其他客户表/,
    );
    assert.equal(a.latest('same-customer').id, 'a-id');
    assert.equal(b.latest('same-customer').id, 'b-id');
  } finally {
    a.close();
    b.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
