import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessCompany,
  ASSESSMENT_RULE_VERSION,
  formatAssessmentEvidence,
} from '../server/customer-assessment.mjs';
import { summarizeLead } from '../server/lead-library.mjs';
import { customerMirrorFields } from '../server/customer-mirror.mjs';
import { connectionEnvironment } from '../server/api-connections.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { configureMirrorSchema } from '../server/feishu-mirror-schema.mjs';

export function currentAssessment(snapshot, research) {
  if (snapshot.ruleVersion === ASSESSMENT_RULE_VERSION) return snapshot;
  assert(
    snapshot.id && snapshot.target && Array.isArray(snapshot.opportunities),
    '缺少完整评估证据，不能迁移',
  );
  return assessCompany({
    id: snapshot.id,
    target: snapshot.target,
    at: Date.parse(snapshot.evaluatedAt),
    research: {
      ...research,
      entity_type: snapshot.entityType,
      company_name: snapshot.companyName,
      source_url: snapshot.website,
      facts: snapshot.facts || [],
      checked_urls: snapshot.checkedUrls || [],
      incomplete_reason: snapshot.incompleteReason,
      assessment_opportunities: snapshot.opportunities,
    },
  });
}

// Explicit, repeatable migration. The user requested no backup of obsolete grades.
export function migrateMirrorData(env, { apply = false } = {}) {
  const paths = {
    acquisition:
      env.ASSESSMENT_DB_PATH ||
      env.ACQUISITION_DB_PATH ||
      env.BATCH_DB_PATH ||
      '.data/acquisition.sqlite',
    customers: env.LEAD_LIBRARY_DB_PATH || '.data/lead-library.sqlite',
    business: env.CUSTOMER_BUSINESS_DB_PATH || env.BATCH_DB_PATH || '.data/acquisition.sqlite',
    outreach: env.OUTREACH_DB_PATH || '.data/outreach/outreach.sqlite',
  };
  const opened = new Map();
  const open = (path) => {
    const absolute = resolve(path);
    assert(existsSync(absolute), '数据库不存在：' + absolute);
    if (!opened.has(absolute))
      opened.set(absolute, new DatabaseSync(absolute, { readOnly: !apply }));
    return opened.get(absolute);
  };
  try {
    const acquisition = open(paths.acquisition),
      customers = open(paths.customers),
      business = open(paths.business),
      outreach = open(paths.outreach);
    const operations = acquisition
      .prepare('SELECT id,data FROM acquisition_operations')
      .all()
      .map((row) => ({ ...row, value: JSON.parse(row.data) }));
    const researchByAssessment = new Map(
      operations
        .filter((row) => row.value.assessment?.id)
        .map((row) => [row.value.assessment.id, row.value.research]),
    );
    const entries = acquisition
      .prepare('SELECT id,scope,record_id,data FROM customer_assessments')
      .all();
    const assessments = new Map(),
      byCustomer = new Map(),
      obsoleteLabels = new Set();
    for (const row of entries) {
      const entry = JSON.parse(row.data);
      if (entry.snapshot.grade && !['A', 'B', 'C'].includes(entry.snapshot.grade))
        obsoleteLabels.add(entry.snapshot.grade);
      const snapshot = currentAssessment(
        entry.snapshot,
        researchByAssessment.get(entry.snapshot.id),
      );
      assessments.set(snapshot.id, snapshot);
      byCustomer.set(row.record_id, snapshot);
    }
    const rewrite = (value, assessment) => {
      if (Array.isArray(value)) return value.map((item) => rewrite(item, assessment));
      if (!value || typeof value !== 'object') return value;
      const current =
        byCustomer.get(value.customerId || value.recordId || value.record_id || value.id) ||
        assessment;
      if (value.ruleVersion && value.id && Array.isArray(value.opportunities)) {
        const snapshot =
          assessments.get(value.id) || currentAssessment(value, researchByAssessment.get(value.id));
        return {
          ...snapshot,
          ...(value.evidenceReason ? { evidenceReason: formatAssessmentEvidence(snapshot) } : {}),
        };
      }
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === '画像JSON' && typeof item === 'string') {
          let parsed;
          try {
            parsed = JSON.parse(item);
          } catch {
            result[key] = item;
            continue;
          }
          result[key] = JSON.stringify(rewrite(parsed, current));
          continue;
        }
        if (['development', 'developmentVersion', 'developmentReviewedVersion'].includes(key))
          continue;
        if (
          ['grade', '初评结果', '用户评级', '客户等级', '用户等级'].includes(key) &&
          typeof item === 'string' &&
          !['A', 'B', 'C', '未评级', ''].includes(item)
        ) {
          result[key] = current?.grade || (key === 'grade' ? null : '');
        } else if (typeof item === 'string' && obsoleteLabels.has(item)) {
          result[key] = current?.grade || '';
        } else if (
          ['reason', 'ratingReason', '评级依据'].includes(key) &&
          typeof item === 'string' &&
          [...obsoleteLabels].some((label) => item.includes(label))
        ) {
          result[key] = current?.reason || '';
        } else if (key === 'ruleVersion' && item !== ASSESSMENT_RULE_VERSION) {
          // Partial historical summaries have no independent current rule authority.
          continue;
        } else result[key] = rewrite(item, current);
      }
      return result;
    };
    const writes = [];
    const stage = (db, table, keyColumn, row, value) => {
      const data = JSON.stringify(value);
      if (data !== row.data)
        writes.push(() =>
          db.prepare(`UPDATE ${table} SET data=? WHERE ${keyColumn}=?`).run(data, row[keyColumn]),
        );
    };
    for (const row of entries)
      stage(acquisition, 'customer_assessments', 'id', row, {
        ...JSON.parse(row.data),
        snapshot: assessments.get(row.id),
      });
    for (const row of operations)
      stage(acquisition, 'acquisition_operations', 'id', row, rewrite(row.value));
    for (const row of acquisition.prepare('SELECT id,data FROM jobs').all())
      stage(acquisition, 'jobs', 'id', row, rewrite(JSON.parse(row.data)));
    const contexts = business
      .prepare('SELECT scope,customer_id,data FROM customer_business_contexts')
      .all();
    for (const row of contexts) {
      const next = rewrite(JSON.parse(row.data));
      if (JSON.stringify(next) !== row.data)
        writes.push(() =>
          business
            .prepare('UPDATE customer_business_contexts SET data=? WHERE scope=? AND customer_id=?')
            .run(JSON.stringify(next), row.scope, row.customer_id),
        );
    }
    const entities = business
      .prepare('SELECT scope,kind,id,data FROM customer_business_entities')
      .all();
    for (const row of entities) {
      const next = rewrite(JSON.parse(row.data));
      if (next.mailboxMessageId && next.origin === 'manual') next.origin = 'mailbox';
      if (JSON.stringify(next) !== row.data)
        writes.push(() =>
          business
            .prepare(
              'UPDATE customer_business_entities SET data=? WHERE scope=? AND kind=? AND id=?',
            )
            .run(JSON.stringify(next), row.scope, row.kind, row.id),
        );
    }
    for (const row of outreach.prepare('SELECT id,data FROM outreach_deliveries').all())
      stage(outreach, 'outreach_deliveries', 'id', row, rewrite(JSON.parse(row.data)));
    let pausedPlans = 0;
    for (const row of outreach.prepare('SELECT id,data FROM outreach_campaigns').all()) {
      const value = JSON.parse(row.data),
        next = rewrite(value);
      if ((value.filters?.grades || []).some((grade) => !['A', 'B', 'C'].includes(grade))) {
        next.filters.grades = value.filters.grades.filter((grade) =>
          ['A', 'B', 'C'].includes(grade),
        );
        next.status = ['cancelled', 'completed'].includes(value.status) ? value.status : 'paused';
        next.approvedRevision = null;
        next.lastError = '评级筛选已更新，请选择 A/B/C 并核对后再启动计划';
        pausedPlans++;
      }
      stage(outreach, 'outreach_campaigns', 'id', row, next);
    }
    let customerCount = 0;
    const grades = {};
    for (const row of customers
      .prepare('SELECT scope,record_id,detail,version FROM lead_library_customers')
      .all()) {
      const original = JSON.parse(row.detail);
      const snapshot = byCustomer.get(row.record_id);
      const lead = rewrite(original, snapshot);
      if (snapshot) {
        lead.grade = snapshot.grade || '未评级';
        lead.assessment = { ...snapshot, evidenceReason: formatAssessmentEvidence(snapshot) };
        lead.ratingReason = snapshot.reason;
      }
      // The only existing hold was confirmed to be test data by the user.
      if (['暂缓开发', '暂停开发'].includes(lead.status)) lead.status = '待开发';
      const graph = {
        messages: entities
          .filter((entity) => entity.kind === 'messages')
          .map((entity) => JSON.parse(entity.data)),
        demands: entities
          .filter((entity) => entity.kind === 'demands')
          .map((entity) => JSON.parse(entity.data)),
        customerContexts: contexts.map((context) => rewrite(JSON.parse(context.data))),
      };
      const { fields } = customerMirrorFields([lead], graph)[0];
      lead.status = fields.开发状态;
      lead.fields = { ...lead.fields, ...fields };
      const summary = summarizeLead(lead);
      grades[fields.初评结果 || 'excluded'] = (grades[fields.初评结果 || 'excluded'] || 0) + 1;
      const tracked = customers
        .prepare('SELECT data FROM customer_archive_sync WHERE scope=? AND record_id=?')
        .get(row.scope, row.record_id);
      const prior = tracked ? rewrite(JSON.parse(tracked.data), snapshot) : {};
      const mirror = {
        ...prior,
        record: {
          ...prior.record,
          record_id: row.record_id,
          created_time: prior.record?.created_time || lead.createdAt,
          fields: { ...prior.record?.fields, ...lead.fields },
        },
        remoteId: prior.remoteId || (row.record_id.startsWith('local_') ? null : row.record_id),
        fields: { ...prior.fields, ...fields },
        revision: (prior.revision || 0) + 1,
        syncedRevision: prior.syncedRevision || 0,
        error: '',
      };
      writes.push(() => {
        customers
          .prepare(
            'UPDATE lead_library_customers SET detail=?,summary=?,version=? WHERE scope=? AND record_id=?',
          )
          .run(
            JSON.stringify(lead),
            JSON.stringify(summary),
            summary.version,
            row.scope,
            row.record_id,
          );
        customers
          .prepare('INSERT OR REPLACE INTO customer_archive_sync VALUES(?,?,?)')
          .run(row.scope, row.record_id, JSON.stringify(mirror));
      });
      customerCount++;
    }
    if (apply) {
      for (const db of opened.values()) db.exec('BEGIN IMMEDIATE');
      try {
        for (const write of writes) write();
        customers.exec('DELETE FROM customer_archive_schema');
        for (const db of opened.values()) db.exec('COMMIT');
      } catch (error) {
        for (const db of opened.values()) {
          try {
            db.exec('ROLLBACK');
          } catch {}
        }
        throw error;
      }
    }
    return {
      applied: apply,
      customers: customerCount,
      assessments: assessments.size,
      grades,
      pausedPlans,
      writes: writes.length,
    };
  } finally {
    for (const db of opened.values()) db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode] = process.argv.slice(2);
  assert(
    ['preview', 'apply', 'schema'].includes(mode),
    '用法：preview | apply（先停止服务）| schema',
  );
  const env = connectionEnvironment();
  const result =
    mode === 'schema'
      ? await configureMirrorSchema(new FeishuClient({ env }))
      : migrateMirrorData(env, { apply: mode === 'apply' });
  console.log(JSON.stringify(result, null, 2));
}
