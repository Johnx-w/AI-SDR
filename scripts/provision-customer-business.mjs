import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { connectionEnvironment } from '../server/api-connections.mjs';
import { CustomerBusinessFeishu } from '../server/customer-business-feishu.mjs';

const env = connectionEnvironment({
  ...process.env,
  BATCH_DB_PATH: process.env.BATCH_DB_PATH || '.data/acquisition.sqlite',
  SCHEDULE_DB_PATH: process.env.SCHEDULE_DB_PATH || '.data/acquisition-schedules.sqlite',
});
const root = resolve('.data/backups/t1-t3-t4-20261024');
mkdirSync(root, { recursive: true });
const beforePath = join(root, 'before.json');
const journalPath = join(root, 'journal.json');
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : [];
const bridge = new CustomerBusinessFeishu({ env });
if (existsSync(beforePath))
  assert(
    JSON.parse(readFileSync(beforePath, 'utf8')).scope === bridge.scope,
    '已有备份属于其他客户表',
  );
const readApi = async (path) => {
  const response = await fetch('http://127.0.0.1:' + (env.PORT || 4311) + path, {
    signal: AbortSignal.timeout(20000),
  });
  assert(response.ok, '本地任务状态读取失败');
  return response.json();
};
try {
  const result = await bridge.provision({
    readApi,
    journal,
    checkpoint: async () => writeFileSync(journalPath, JSON.stringify(journal, null, 2)),
    backup: async (snapshot) => {
      const stamp = snapshot.at.replace(/[^\dTZ]/g, '');
      const paths = [
        ...new Set(
          [
            env.ASSESSMENT_DB_PATH || env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH,
            env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH,
            env.PRODUCT_KNOWLEDGE_DB_PATH || env.PRODUCT_DB_PATH || env.BATCH_DB_PATH,
            env.CUSTOMER_BUSINESS_DB_PATH || env.BATCH_DB_PATH,
            env.SCHEDULE_DB_PATH,
          ]
            .filter((path) => path && path !== ':memory:')
            .map((path) => resolve(path)),
        ),
      ];
      for (const [index, path] of paths.entries()) {
        if (!existsSync(path)) continue;
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          await sqliteBackup(db, join(root, 'before-' + stamp + '-' + index + '.sqlite'));
        } finally {
          db.close();
        }
      }
      writeFileSync(join(root, 'before-' + stamp + '.json'), JSON.stringify(snapshot, null, 2), {
        flag: 'wx',
      });
      if (!existsSync(beforePath))
        writeFileSync(beforePath, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
    },
  });
  writeFileSync(
    join(root, 'verification.json'),
    JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2),
  );
  console.log(JSON.stringify({ ...result, backupDirectory: root }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
