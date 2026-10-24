import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { connectionEnvironment } from '../server/api-connections.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import {
  prepareBusinessSchema,
  finalizeBusinessSchema,
} from '../server/business-schema-migration.mjs';

const mode = process.argv[2];
assert(
  ['prepare', 'finalize'].includes(mode),
  '用法：node --env-file-if-exists=.env scripts/migrate-business-schema.mjs prepare|finalize',
);
const env = connectionEnvironment({
  ...process.env,
  BATCH_DB_PATH: process.env.BATCH_DB_PATH || '.data/acquisition.sqlite',
  SCHEDULE_DB_PATH: process.env.SCHEDULE_DB_PATH || '.data/acquisition-schedules.sqlite',
});
const t2Id = env.FEISHU_TABLE_ID;
const scope = String(env.FEISHU_APP_TOKEN) + '/' + String(t2Id);
const root = resolve('.data/backups/t2-t5-20261024');
const beforePath = join(root, 'before.json');
const journalPath = join(root, 'journal.json');
mkdirSync(root, { recursive: true });
const baseline = existsSync(beforePath) ? JSON.parse(readFileSync(beforePath, 'utf8')) : undefined;
if (baseline) assert(baseline.scope === scope, '已有迁移备份属于其他客户表');
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : [];
assert(Array.isArray(journal), '迁移日志无效');
if (mode === 'finalize') assert(baseline, '请先执行prepare阶段并保存备份');
const dbPath = env.ASSESSMENT_DB_PATH || env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH;
const currentAssessments = () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT record_id,data FROM customer_assessments WHERE scope=? ORDER BY record_id,evaluated_at DESC,rowid DESC',
      )
      .all(scope)
      .map((row) => ({ recordId: row.record_id, snapshot: JSON.parse(row.data).snapshot }));
  } finally {
    db.close();
  }
};
const readApi = async (path) => {
  const response = await fetch('http://127.0.0.1:' + (env.PORT || 4311) + path, {
    signal: AbortSignal.timeout(20000),
  });
  assert(response.ok, '本地服务读取失败：' + path + ' HTTP ' + response.status);
  return response.json();
};
const persistBackup = async (snapshot, phase) => {
  const stamp = snapshot.at.replace(/[^\dTZ]/g, '');
  const prefix = phase + '-before-' + stamp;
  const paths = [
    ...new Set(
      [
        dbPath,
        env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH,
        env.PRODUCT_DB_PATH || env.BATCH_DB_PATH,
        env.PRODUCT_KNOWLEDGE_DB_PATH || env.PRODUCT_DB_PATH || env.BATCH_DB_PATH,
        env.SCHEDULE_DB_PATH,
      ]
        .filter((path) => path && path !== ':memory:')
        .map((path) => resolve(path)),
    ),
  ];
  for (const [index, path] of paths.entries()) {
    assert(existsSync(path), '待备份数据库不存在：' + path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      await sqliteBackup(db, join(root, prefix + '-' + index + '.sqlite'));
    } finally {
      db.close();
    }
  }
  writeFileSync(join(root, prefix + '.json'), JSON.stringify(snapshot, null, 2), { flag: 'wx' });
  if (!existsSync(beforePath))
    writeFileSync(beforePath, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
};
const context = {
  client: new FeishuClient({ env }),
  t2Id,
  scope,
  readApi,
  currentAssessments,
  baseline,
  journal,
  backup: persistBackup,
  checkpoint: async () => writeFileSync(journalPath, JSON.stringify(journal, null, 2)),
};
try {
  const verification = await (mode === 'prepare'
    ? prepareBusinessSchema(context)
    : finalizeBusinessSchema(context));
  writeFileSync(
    join(root, 'verification-' + mode + '.json'),
    JSON.stringify({ at: new Date().toISOString(), ...verification }, null, 2),
  );
  console.log(JSON.stringify({ ...verification, backupDirectory: root }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
