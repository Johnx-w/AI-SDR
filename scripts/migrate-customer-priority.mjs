import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { connectionEnvironment } from '../server/api-connections.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { assessmentRating, formatAssessmentEvidence } from '../server/customer-assessment.mjs';
import { customerWebsite, fieldValue } from '../server/customer-fields.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { fieldText, mapFeishuRecord } from '../server/feishu.mjs';
import { summarizeLead } from '../server/lead-library.mjs';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { planPriorityHistoryReplay } from '../server/priority-history-replay.mjs';
import { cleanupRejectedHistory } from '../server/rejected-history-cleanup.mjs';
import { domainKey } from '../server/website-identity.mjs';

const [mode, directory = '.data', backupDirectory] = process.argv.slice(2);
assert(
  ['preview', 'apply'].includes(mode),
  '用法：node --env-file-if-exists=.env scripts/migrate-customer-priority.mjs preview|apply [数据目录] [备份目录]',
);
if (mode === 'apply') assert(backupDirectory, '正式迁移必须指定私有备份目录');

const env = connectionEnvironment();
const dataDir = resolve(directory);
const acquisitionPath = join(dataDir, 'acquisition.sqlite');
const libraryPath = join(dataDir, 'lead-library.sqlite');
const scope = String(env.FEISHU_APP_TOKEN) + '/' + String(env.FEISHU_TABLE_ID);
assert(env.FEISHU_APP_ID && env.FEISHU_APP_TOKEN && env.FEISHU_TABLE_ID, '缺少飞书客户表配置');
const libraryScope = createHash('sha256')
  .update(
    JSON.stringify([
      'native',
      env.FEISHU_APP_ID || '',
      env.FEISHU_APP_TOKEN || '',
      env.FEISHU_TABLE_ID || '',
      '',
    ]),
  )
  .digest('hex');
const gradeNames = ['A', 'B', 'C'];
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const byId = (rows, key) => new Map(rows.map((row) => [row[key], row]));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function loadLocal() {
  const acquisition = new DatabaseSync(acquisitionPath, { readOnly: true });
  const library = new DatabaseSync(libraryPath, { readOnly: true });
  try {
    const assessments = acquisition
      .prepare('SELECT record_id,data FROM customer_assessments WHERE scope=?')
      .all(scope)
      .map((row) => ({ recordId: row.record_id, entry: JSON.parse(row.data) }));
    const operations = acquisition
      .prepare('SELECT data FROM acquisition_operations')
      .all()
      .map((row) => JSON.parse(row.data));
    const leads = library
      .prepare('SELECT record_id,detail,version FROM lead_library_customers WHERE scope=?')
      .all(libraryScope)
      .map((row) => ({
        recordId: row.record_id,
        version: row.version,
        lead: JSON.parse(row.detail),
      }));
    const mirrors = library
      .prepare('SELECT record_id,data FROM customer_archive_sync WHERE scope=?')
      .all(libraryScope)
      .map((row) => ({ recordId: row.record_id, entry: JSON.parse(row.data) }));
    const jobs = acquisition
      .prepare('SELECT data FROM jobs')
      .all()
      .map((row) => JSON.parse(row.data));
    return { assessments, operations, leads, mirrors, jobs };
  } finally {
    acquisition.close();
    library.close();
  }
}

function plan(local, remoteRecords) {
  const leads = byId(local.leads, 'recordId');
  const mirrors = byId(local.mirrors, 'recordId');
  const operationGroups = new Map();
  for (const operation of local.operations) {
    const id = operation.assessment?.id;
    if (id) operationGroups.set(id, [...(operationGroups.get(id) || []), operation]);
  }
  const remote = remoteRecords ? byId(remoteRecords, 'record_id') : null;
  const entries = [],
    skipped = {};
  const remoteIds = new Set();
  for (const { recordId, entry } of local.assessments) {
    const leadRow = leads.get(recordId);
    const mirror = mirrors.get(recordId)?.entry;
    const remoteId = mirror?.remoteId || (recordId.startsWith('local_') ? null : recordId);
    if (mirror && (mirror.revision !== mirror.syncedRevision || mirror.error || !remoteId))
      throw new Error('本地镜像尚未同步，停止迁移');
    assert(remoteId && !remoteIds.has(remoteId), '远端客户编号缺失或重复');
    remoteIds.add(remoteId);
    const remoteRecord = remote?.get(remoteId);
    if (remote && !remoteRecord) throw new Error('远端客户不存在，停止迁移');
    const candidates = operationGroups.get(entry.snapshot?.id) || [];
    const result = planPriorityHistoryReplay({
      operation: candidates.length === 1 ? candidates[0] : null,
      entry,
      lead: leadRow?.lead,
      record: remoteRecord ? { ...remoteRecord, record_id: recordId } : undefined,
      scope,
    });
    if (!result.ok) {
      skipped[result.reason] = (skipped[result.reason] || 0) + 1;
      continue;
    }
    entries.push({
      recordId,
      remoteId,
      oldEntry: entry,
      oldLeadVersion: leadRow.version,
      oldMirror: mirror || null,
      snapshot: result.snapshot,
      fields: result.fields,
    });
  }
  assert.equal(local.assessments.length, local.leads.length, '评估与客户档案数量不一致');
  assert.equal(remoteIds.size, local.assessments.length, '远端编号映射不完整');
  if (remote) assert.equal(remote.size, remoteIds.size, '飞书客户数量与本地档案不一致');
  const grades = {};
  for (const entry of entries) {
    const grade = assessmentRating(entry.snapshot);
    grades[grade] = (grades[grade] || 0) + 1;
  }
  return {
    entries,
    report: { total: local.assessments.length, ready: entries.length, skipped, grades },
  };
}

function assertIdle(local) {
  assert(
    local.jobs.every((job) => ['completed', 'partial'].includes(job.status) && !job.current),
    '仍有未结束或待核对的获客任务',
  );
  assert(
    local.operations.every((operation) => operation.state === 'completed'),
    '仍有未结束或待核对的获客操作',
  );
}

async function assertAppStopped() {
  const port = Number(env.PORT || 4311);
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, '本地服务端口无效');
  const listening = await new Promise((resolveListening, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveListening(true);
    });
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolveListening(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('本地服务状态未确认'));
    });
  });
  assert(!listening, '本地服务仍在运行，请停用服务后再迁移');
}

function fieldValueText(record, name) {
  return fieldText(fieldValue(record.fields || {}, name));
}

function desired(record, fields) {
  return Object.entries(fields).every(
    ([name, value]) => fieldValueText(record, name) === fieldText(value),
  );
}

function journalAt(root) {
  const path = join(root, 'journal.json');
  const events = existsSync(path) ? json(path) : [];
  assert(Array.isArray(events), '迁移日志损坏');
  const last = (key) => events.filter((event) => event.key === key).at(-1);
  const save = (key, state) => {
    events.push({ at: new Date().toISOString(), key, state });
    writeFileSync(path + '.tmp', JSON.stringify(events));
    renameSync(path + '.tmp', path);
  };
  return { last, save };
}

async function backupBefore(root, local, fields, records, result) {
  if (existsSync(root)) {
    const manifestPath = join(root, 'manifest.json');
    assert(existsSync(manifestPath), '备份目录不完整，停止迁移');
    const manifest = json(manifestPath);
    assert.equal(manifest.scope, scope, '备份属于其他客户表');
    assert.equal(manifest.libraryScope, libraryScope, '备份属于其他本地客户库');
    assert.equal(manifest.dataDir, dataDir, '备份对应其他数据目录');
    for (const name of [
      'acquisition.sqlite',
      'lead-library.sqlite',
      'feishu-before.json',
      'plan.json',
    ])
      assert(existsSync(join(root, name)), '备份文件不完整：' + name);
    const planned = json(join(root, 'plan.json'));
    assert.equal(planned.entries.length, manifest.count, '备份计划条数不一致');
    assert.equal(planned.report.ready, planned.report.total, '备份计划包含无法重评的客户');
    return { before: json(join(root, 'feishu-before.json')), planned };
  }
  assertIdle(local);
  assert.equal(result.report.ready, result.report.total, '存在无法可信重评的客户，未开始迁移');
  mkdirSync(root, { recursive: true });
  for (const [path, name] of [
    [acquisitionPath, 'acquisition.sqlite'],
    [libraryPath, 'lead-library.sqlite'],
  ]) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      await sqliteBackup(db, join(root, name));
    } finally {
      db.close();
    }
  }
  const after = loadLocal();
  assert(
    same(local.assessments, after.assessments) &&
      same(local.operations, after.operations) &&
      same(local.leads, after.leads) &&
      same(local.mirrors, after.mirrors) &&
      same(local.jobs, after.jobs),
    '备份期间本地客户资料发生变化，停止迁移',
  );
  const before = { fields, records };
  writeFileSync(join(root, 'feishu-before.json'), JSON.stringify(before), { flag: 'wx' });
  writeFileSync(join(root, 'plan.json'), JSON.stringify(result), { flag: 'wx' });
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      scope,
      libraryScope,
      dataDir,
      count: result.entries.length,
    }),
    { flag: 'wx' },
  );
  return { before, planned: result };
}

async function ensureGradeOptions(client, before, journal) {
  const original = before.fields.find((field) => field.field_name === '初评结果');
  assert(original && original.type === 3 && original.field_id, '飞书初评结果单选字段缺失');
  const oldOptions = original.property?.options || [];
  const verify = (field) =>
    field?.field_id === original.field_id &&
    field.type === 3 &&
    oldOptions.every((old) =>
      field.property?.options?.some(
        (current) =>
          current.id === old.id && current.name === old.name && current.color === old.color,
      ),
    ) &&
    gradeNames.every((name) => field.property?.options?.some((option) => option.name === name));
  const current = (await client.fields()).find((field) => field.field_id === original.field_id);
  assert(
    current && current.field_name === original.field_name && current.type === 3,
    '飞书初评字段已变化，停止迁移',
  );
  if (verify(current)) return await client.fields();
  assert(same(current.property, original.property), '飞书初评选项已被其他操作修改');
  const key = 'field:' + original.field_id;
  assert(!['pending', 'uncertain'].includes(journal.last(key)?.state), '字段写入结果待核对');
  journal.save(key, 'pending');
  const options = [
    ...oldOptions,
    ...gradeNames
      .filter((name) => !oldOptions.some((option) => option.name === name))
      .map((name) => ({ name })),
  ];
  try {
    await client.request(client.tablePath() + '/fields/' + encodeURIComponent(original.field_id), {
      method: 'PUT',
      body: {
        field_name: original.field_name,
        type: 3,
        property: { ...original.property, options },
      },
    });
  } catch {
    // A lost response is resolved only by the next field read.
  }
  const after = (await client.fields()).find((field) => field.field_id === original.field_id);
  if (!verify(after)) {
    journal.save(key, 'uncertain');
    throw new Error('飞书初评字段更新待核对，未继续写客户');
  }
  journal.save(key, 'done');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  return await client.fields();
}

async function writeRemote(client, before, entries, journal) {
  const original = byId(before.records, 'record_id');
  for (const [index, entry] of entries.entries()) {
    const key = 'record:' + entry.remoteId;
    const baseline = original.get(entry.remoteId);
    assert(baseline, '飞书备份缺少客户记录');
    let current = await client.record(entry.remoteId);
    assert.equal(
      domainKey(customerWebsite(current)),
      domainKey(customerWebsite(baseline)),
      '飞书客户官网已变化，停止迁移',
    );
    if (desired(current, entry.fields)) {
      if (journal.last(key)?.state !== 'done') journal.save(key, 'done');
      continue;
    }
    assert(
      !['pending', 'uncertain'].includes(journal.last(key)?.state),
      '上次飞书写入尚未确认，未重复写入',
    );
    for (const name of Object.keys(entry.fields))
      assert.equal(
        fieldValueText(current, name),
        fieldValueText(baseline, name),
        '飞书评级或待确认事项已被其他操作修改，停止迁移',
      );
    journal.save(key, 'pending');
    try {
      await client.write(
        'update',
        Object.fromEntries(
          Object.entries(entry.fields).map(([name, value]) => [name, value === '' ? null : value]),
        ),
        entry.remoteId,
        undefined,
        env.FEISHU_TABLE_ID,
      );
    } catch {
      // An uncertain write is read back; it is never immediately repeated.
    }
    try {
      current = await client.record(entry.remoteId);
    } catch {
      journal.save(key, 'uncertain');
      throw new Error('飞书客户更新结果待核对，未自动重试');
    }
    if (!desired(current, entry.fields)) {
      journal.save(key, 'uncertain');
      throw new Error('飞书客户更新读回不一致，未自动重试');
    }
    journal.save(key, 'done');
    if ((index + 1) % 25 === 0) console.log(JSON.stringify({ remoteVerified: index + 1 }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
}

function applyLocal(entries, fields) {
  const store = new AcquisitionStore(acquisitionPath, scope);
  const snapshots = new Map(entries.map((entry) => [entry.recordId, entry.snapshot]));
  const publicEntry = (recordId) => {
    const snapshot = snapshots.get(recordId);
    return snapshot
      ? {
          ...snapshot,
          recordId,
          legacy: false,
          evidenceReason: formatAssessmentEvidence(snapshot),
        }
      : null;
  };
  const assessor = {
    scope,
    latest: publicEntry,
    summary: (id) => {
      const entry = entries.find((item) => item.snapshot.id === id);
      return entry ? publicEntry(entry.recordId) : null;
    },
    close() {},
  };
  const engine = new NativeAcquisition({
    env: { ...env, ACQUISITION_DB_PATH: acquisitionPath },
    store,
    assessments: assessor,
    feishu: {},
    providers: {},
  });
  const db = new DatabaseSync(acquisitionPath);
  const attachPath = libraryPath.replaceAll("'", "''");
  db.exec("ATTACH DATABASE '" + attachPath + "' AS library");
  try {
    const prepared = entries.map((entry) => {
      const row = db
        .prepare(
          'SELECT detail,version FROM library.lead_library_customers WHERE scope=? AND record_id=?',
        )
        .get(libraryScope, entry.recordId);
      assert(row, '本地客户档案缺失');
      const lead = JSON.parse(row.detail);
      assert(
        row.version === entry.oldLeadVersion || lead.assessment?.id === entry.snapshot.id,
        '本地客户档案已发生其他变更',
      );
      const record = {
        record_id: entry.recordId,
        created_time: lead.createdAt,
        fields: { ...lead.fields, ...entry.fields },
      };
      const decorated = engine.decorateLeads({ leads: [mapFeishuRecord(record)] }).leads[0];
      const next = {
        ...lead,
        grade: decorated.grade,
        score: decorated.score,
        ratingReason: decorated.ratingReason,
        assessment: decorated.assessment,
        pendingQuestions: decorated.pendingQuestions,
        supplyOpportunity: decorated.supplyOpportunity,
        facts: decorated.facts,
        fields: { ...lead.fields, ...entry.fields },
      };
      assert.equal(next.assessment?.id, entry.snapshot.id, '新版客户档案未关联新版评估');
      assert.equal(next.grade, assessmentRating(entry.snapshot), '新版客户评级不一致');
      return { ...entry, lead: next, summary: summarizeLead(next) };
    });
    db.exec('BEGIN IMMEDIATE');
    try {
      let changed = 0,
        libraryChanged = 0;
      const now = new Date().toISOString();
      for (const item of prepared) {
        const row = db
          .prepare('SELECT data FROM customer_assessments WHERE scope=? AND record_id=?')
          .get(scope, item.recordId);
        assert(row, '本地评估缺失');
        const current = JSON.parse(row.data);
        if (current.snapshot?.id !== item.snapshot.id) {
          assert(same(current, item.oldEntry), '本地评估已被其他操作修改');
          const saved = {
            id: item.snapshot.id,
            recordId: item.recordId,
            snapshot: item.snapshot,
            createdAt: now,
            savedAt: now,
          };
          db.prepare('DELETE FROM customer_assessments WHERE scope=? AND record_id=?').run(
            scope,
            item.recordId,
          );
          db.prepare('INSERT INTO customer_assessments VALUES(?,?,?,?,?)').run(
            saved.id,
            scope,
            saved.recordId,
            saved.snapshot.evaluatedAt,
            JSON.stringify(saved),
          );
          changed++;
        } else assert(same(current.snapshot, item.snapshot), '已有新版评估内容不同');
        const oldLead = db
          .prepare(
            'SELECT detail,version FROM library.lead_library_customers WHERE scope=? AND record_id=?',
          )
          .get(libraryScope, item.recordId);
        if (oldLead.version !== item.summary.version) {
          assert.equal(oldLead.version, item.oldLeadVersion, '本地客户档案已被其他操作修改');
          db.prepare(
            'UPDATE library.lead_library_customers SET detail=?,summary=?,version=? WHERE scope=? AND record_id=?',
          ).run(
            JSON.stringify(item.lead),
            JSON.stringify(item.summary),
            item.summary.version,
            libraryScope,
            item.recordId,
          );
          libraryChanged++;
        }
        if (item.oldMirror) {
          const mirrorRow = db
            .prepare('SELECT data FROM library.customer_archive_sync WHERE scope=? AND record_id=?')
            .get(libraryScope, item.recordId);
          assert(mirrorRow, '本地镜像缺失');
          const mirror = JSON.parse(mirrorRow.data);
          if (same(mirror, item.oldMirror)) {
            const next = {
              ...mirror,
              record: {
                ...mirror.record,
                fields: {
                  ...mirror.record.fields,
                  ...Object.fromEntries(
                    Object.entries(item.fields).map(([name, value]) => [
                      name,
                      value === '' ? null : value,
                    ]),
                  ),
                },
              },
              revision: mirror.revision + 1,
              syncedRevision: mirror.syncedRevision + 1,
              syncedAt: now,
            };
            db.prepare(
              'UPDATE library.customer_archive_sync SET data=? WHERE scope=? AND record_id=?',
            ).run(JSON.stringify(next), libraryScope, item.recordId);
          } else assert(desired(mirror.record, item.fields), '本地镜像已被其他操作修改');
        }
      }
      if (libraryChanged)
        db.prepare(
          'UPDATE library.lead_library_sync SET revision=revision+1,refreshed_at=?,synced_at=? WHERE scope=?',
        ).run(Date.now(), now, libraryScope);
      db.prepare('UPDATE library.customer_archive_schema SET data=? WHERE scope=?').run(
        JSON.stringify(fields),
        libraryScope,
      );
      db.exec('COMMIT');
      return changed;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
    engine.close();
  }
}

async function verifyAll(client, before, entries) {
  const remote = await client.records();
  assert.equal(remote.length, before.records.length, '飞书客户总数变化');
  const actual = byId(remote, 'record_id');
  const original = byId(before.records, 'record_id');
  const acquisition = new DatabaseSync(acquisitionPath, { readOnly: true });
  const library = new DatabaseSync(libraryPath, { readOnly: true });
  try {
    for (const entry of entries) {
      const record = actual.get(entry.remoteId);
      assert(record && desired(record, entry.fields), '飞书客户最终读回不一致');
      assert.equal(
        domainKey(customerWebsite(record)),
        domainKey(customerWebsite(original.get(entry.remoteId))),
        '飞书客户官网最终读回不一致',
      );
      const saved = acquisition
        .prepare('SELECT data FROM customer_assessments WHERE scope=? AND record_id=?')
        .get(scope, entry.recordId);
      assert(
        saved && same(JSON.parse(saved.data).snapshot, entry.snapshot),
        '本地评估最终读回不一致',
      );
      const row = library
        .prepare(
          'SELECT detail,summary,version FROM lead_library_customers WHERE scope=? AND record_id=?',
        )
        .get(libraryScope, entry.recordId);
      assert(row, '本地客户档案最终读回缺失');
      const lead = JSON.parse(row.detail);
      const summary = summarizeLead(lead);
      assert.equal(lead.assessment?.id, entry.snapshot.id, '客户详情未关联新版评估');
      assert.equal(lead.grade, assessmentRating(entry.snapshot), '客户详情评级读回不一致');
      assert.equal(
        lead.pendingQuestions,
        entry.fields['待确认事项'],
        '客户详情待确认事项读回不一致',
      );
      assert.equal(row.version, summary.version, '客户详情版本读回不一致');
      assert(same(JSON.parse(row.summary), summary), '客户列表摘要读回不一致');
      if (entry.oldMirror) {
        const mirror = library
          .prepare('SELECT data FROM customer_archive_sync WHERE scope=? AND record_id=?')
          .get(libraryScope, entry.recordId);
        assert(mirror, '本地镜像最终读回缺失');
        const value = JSON.parse(mirror.data);
        assert.equal(value.remoteId, entry.remoteId, '本地镜像远端编号变化');
        assert.equal(value.revision, value.syncedRevision, '本地镜像未同步');
        assert(desired(value.record, entry.fields), '本地镜像字段读回不一致');
      }
    }
    const remaining = cleanupRejectedHistory(acquisition, { clearModelCache: true });
    assert.equal(remaining.operationsToRedact, 0, '仍有历史淘汰操作原文');
    assert.equal(remaining.rejectedRowsToRedact, 0, '仍有历史淘汰批次明细');
    assert.equal(remaining.jobsToClean, 0, '仍有终态候选队列');
    assert.equal(remaining.cacheToClear, 0, '模型缓存仍留存');
  } finally {
    acquisition.close();
    library.close();
  }
}

async function main() {
  const local = loadLocal();
  if (mode === 'preview') {
    const remote = process.argv.includes('--remote')
      ? await new FeishuClient({ env }).records()
      : undefined;
    const preview = plan(local, remote);
    const db = new DatabaseSync(acquisitionPath, { readOnly: true });
    try {
      console.log(
        JSON.stringify(
          { ...preview.report, cleanup: cleanupRejectedHistory(db, { clearModelCache: true }) },
          null,
          2,
        ),
      );
    } finally {
      db.close();
    }
    return;
  }
  assert.equal(
    resolve(
      env.ASSESSMENT_DB_PATH || env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || acquisitionPath,
    ),
    acquisitionPath,
    '评估数据路径不是当前获客数据库',
  );
  assert.equal(
    resolve(env.LEAD_LIBRARY_DB_PATH || libraryPath),
    libraryPath,
    '客户库路径不是指定数据目录',
  );
  await assertAppStopped();
  assertIdle(local);
  const client = new FeishuClient({ env });
  const root = resolve(backupDirectory);
  const relativeBackup = relative(join(dataDir, 'backups'), root);
  assert(
    relativeBackup && !relativeBackup.startsWith('..') && !isAbsolute(relativeBackup),
    '私有备份目录必须位于数据目录的 backups 子目录',
  );
  let before, planned;
  if (existsSync(join(root, 'manifest.json'))) {
    ({ before, planned } = await backupBefore(root, local));
  } else {
    const preview = plan(local);
    assert.equal(
      preview.report.ready,
      preview.report.total,
      '存在无法可信重评的客户，停止正式迁移',
    );
    const [fields, records] = await Promise.all([client.fields(), client.records()]);
    const result = plan(local, records);
    assert.equal(result.report.ready, result.report.total, '飞书资料与本地不一致，停止正式迁移');
    ({ before, planned } = await backupBefore(root, local, fields, records, result));
  }
  const journal = journalAt(root);
  const currentFields = await ensureGradeOptions(client, before, journal);
  await writeRemote(client, before, planned.entries, journal);
  const changed = applyLocal(planned.entries, currentFields);
  const db = new DatabaseSync(acquisitionPath);
  let cleanup;
  try {
    cleanup = cleanupRejectedHistory(db, { apply: true, clearModelCache: true });
  } finally {
    db.close();
  }
  await verifyAll(client, before, planned.entries);
  console.log(
    JSON.stringify(
      {
        ...planned.report,
        localUpdated: changed,
        cleanup,
        verified: planned.entries.length,
        backupDirectory: root,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
