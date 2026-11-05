import test from 'node:test';
import assert from 'node:assert/strict';
import { currentAssessment, migrateMirrorData } from '../scripts/migrate-feishu-mirrors.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureMirrorSchema, CUSTOMER_MIRROR_FIELDS } from '../server/feishu-mirror-schema.mjs';

test('迁移依据保存的事实重算评级，不将旧等级或分数机械映射', () => {
  const snapshot = {
    id: 'assessment-one',
    ruleVersion: 'obsolete',
    grade: 'obsolete',
    score: 0,
    evaluatedAt: '2026-11-01T08:00:00Z',
    target: { product: 'roller blinds' },
    entityType: 'business',
    website: 'https://buyer.example.org/',
    companyName: 'Buyer',
    opportunities: [
      {
        direction: 'finished',
        product: 'roller blinds',
        facts: ['core_product', 'specialist_supply'].map((kind) => ({
          kind,
          value: kind,
          quote: kind,
          source_url: 'https://buyer.example.org/',
        })),
      },
    ],
  };
  const result = currentAssessment(snapshot);
  assert.equal(result.grade, 'A');
  assert.equal(result.ruleVersion, 'acquisition-v5.0');
  assert.equal(result.id, snapshot.id);
  assert.deepEqual(result.opportunities[0].facts, snapshot.opportunities[0].facts);
  assert.equal(Date.parse(result.evaluatedAt), Date.parse(snapshot.evaluatedAt));
  assert.throws(() => currentAssessment({ id: 'incomplete' }), /缺少完整评估证据/);
});

test('字段迁移只新增三列，保留隐藏正文及其他字段，重复运行不重复新增', async () => {
  const select = (name) => ({
    field_id: name,
    field_name: name,
    type: 3,
    property: { options: [{ name: 'obsolete' }] },
  });
  const rows = {
    t2: [
      { field_name: '客户编号', field_id: 'id', type: 1, is_primary: true },
      select('初评结果'),
      select('开发状态'),
    ],
    t3: [{ field_name: '正文', field_id: 'body', type: 1 }, select('发送结果')],
  };
  const properties = {};
  let adds = 0;
  const client = {
    env: { FEISHU_TABLE_ID: 't2' },
    tablePath: (id) => '/' + id,
    fields: async (id) => structuredClone(rows[id]),
    tables: async () => [{ table_id: 't3', name: 'T3 多渠道沟通记录表' }],
    request: async (path, { method = 'GET', body } = {}) => {
      const [, id, resource, field] = path.split('/');
      if (resource === 'fields') {
        if (method === 'POST') {
          rows[id].push({ ...body, field_id: body.field_name });
          adds++;
        } else
          Object.assign(
            rows[id].find((item) => item.field_id === field),
            body,
          );
      } else if (!field) return { items: [{ view_type: 'grid', view_id: 'view' }] };
      else if (method === 'PATCH') {
        if (id === 't2')
          assert.equal(Object.hasOwn(body.property.filter_info.conditions[0], 'value'), false);
        properties[id] = body.property;
      } else return { view: { property: properties[id] } };
      return {};
    },
  };
  await configureMirrorSchema(client);
  await configureMirrorSchema(client);
  assert.equal(adds, 3);
  assert.deepEqual(
    rows.t2.slice(-3).map((item) => item.field_name),
    CUSTOMER_MIRROR_FIELDS.map((item) => item.field_name),
  );
  assert.deepEqual(
    rows.t2
      .find((item) => item.field_name === '初评结果')
      .property.options.map((item) => item.name),
    ['A', 'B', 'C'],
  );
  assert(properties.t3.hidden_fields.includes('body'));
  assert(!properties.t2.hidden_fields.includes('id'));
});

test('迁移先预演再原位改写，清除旧值及控制数据，保留证据并登记待同步', () => {
  const folder = mkdtempSync(join(tmpdir(), 'mirror-data-'));
  const path = join(folder, 'state.sqlite');
  const db = new DatabaseSync(path);
  const snapshot = {
    id: 'ev_one',
    ruleVersion: 'obsolete',
    grade: 'obsolete',
    entityType: 'business',
    companyName: 'Buyer',
    website: 'https://buyer.example.org/',
    evaluatedAt: '2026-11-01T08:00:00.000Z',
    target: { product: 'roller blinds' },
    opportunities: [
      {
        direction: 'finished',
        product: 'roller blinds',
        facts: [
          {
            kind: 'secondary_product',
            value: 'roller blinds',
            quote: 'roller blinds',
            source_url: 'https://buyer.example.org/',
          },
        ],
      },
    ],
  };
  const lead = {
    id: 'customer-one',
    name: 'Buyer',
    website: snapshot.website,
    grade: 'obsolete',
    status: '待开发',
    facts: [],
    contactEvidence: [],
    fields: {
      公司名称: 'Buyer',
      企业官网: snapshot.website,
      初评结果: 'obsolete',
      画像JSON: JSON.stringify({ grade: 'obsolete', facts: [{ quote: 'original evidence' }] }),
    },
  };
  db.exec(`CREATE TABLE customer_assessments(id TEXT,scope TEXT,record_id TEXT,data TEXT);
    CREATE TABLE acquisition_operations(id TEXT,data TEXT); CREATE TABLE jobs(id TEXT,data TEXT);
    CREATE TABLE customer_business_contexts(scope TEXT,customer_id TEXT,data TEXT);
    CREATE TABLE customer_business_entities(scope TEXT,kind TEXT,id TEXT,data TEXT);
    CREATE TABLE outreach_deliveries(id TEXT,data TEXT); CREATE TABLE outreach_campaigns(id TEXT,data TEXT);
    CREATE TABLE lead_library_customers(scope TEXT,record_id TEXT,detail TEXT,summary TEXT,version TEXT);
    CREATE TABLE customer_archive_sync(scope TEXT,record_id TEXT,data TEXT,PRIMARY KEY(scope,record_id));
    CREATE TABLE customer_archive_schema(scope TEXT,data TEXT);`);
  db.prepare('INSERT INTO customer_assessments VALUES(?,?,?,?)').run(
    'ev_one',
    'scope',
    lead.id,
    JSON.stringify({ snapshot }),
  );
  db.prepare('INSERT INTO lead_library_customers VALUES(?,?,?,?,?)').run(
    'scope',
    lead.id,
    JSON.stringify(lead),
    '{}',
    'before',
  );
  db.prepare('INSERT INTO customer_business_contexts VALUES(?,?,?)').run(
    'scope',
    lead.id,
    JSON.stringify({
      customerId: lead.id,
      fixedEmail: 'sales@example.org',
      development: { paused: true },
    }),
  );
  db.prepare('INSERT INTO outreach_campaigns VALUES(?,?)').run(
    'plan-one',
    JSON.stringify({ status: 'active', filters: { grades: ['obsolete'] }, approvedRevision: 1 }),
  );
  const env = { BATCH_DB_PATH: path, LEAD_LIBRARY_DB_PATH: path, OUTREACH_DB_PATH: path };
  try {
    assert.equal(migrateMirrorData(env).applied, false);
    assert.equal(
      JSON.parse(db.prepare('SELECT detail FROM lead_library_customers').get().detail).grade,
      'obsolete',
    );
    assert.equal(migrateMirrorData(env, { apply: true }).pausedPlans, 1);
    const saved = JSON.parse(db.prepare('SELECT detail FROM lead_library_customers').get().detail);
    assert.equal(saved.grade, 'B');
    assert.equal(JSON.parse(saved.fields.画像JSON).grade, 'B');
    assert.equal(JSON.parse(saved.fields.画像JSON).facts[0].quote, 'original evidence');
    const context = JSON.parse(
      db.prepare('SELECT data FROM customer_business_contexts').get().data,
    );
    assert.equal(context.development, undefined);
    assert.equal(context.fixedEmail, 'sales@example.org');
    const queued = JSON.parse(db.prepare('SELECT data FROM customer_archive_sync').get().data);
    assert.equal(queued.fields.初评结果, 'B');
    assert(queued.revision > queued.syncedRevision);
    const plan = JSON.parse(db.prepare('SELECT data FROM outreach_campaigns').get().data);
    assert.equal(plan.status, 'paused');
    assert.equal(plan.approvedRevision, null);
    assert.deepEqual(plan.filters.grades, []);
    assert.equal(migrateMirrorData(env, { apply: true }).pausedPlans, 0);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
