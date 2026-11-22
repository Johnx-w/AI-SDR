import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { syncReadonlyMail } from './sync-mail-readonly.mjs';

const { values } = parseArgs({
  options: { 'data-dir': { type: 'string' }, port: { type: 'string', default: '14322' } },
});
if (!values['data-dir']) throw new Error('请指定用于本地查看的数据库快照目录');
const dir = resolve(values['data-dir']),
  outreach = join(dir, 'outreach'),
  registry = join(outreach, 'mailboxes.json');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口号无效');
const env = {
  PORT: String(port),
  OUTREACH_DATA_DIR: outreach,
  OUTREACH_DB_PATH: join(outreach, 'outreach.sqlite'),
  BATCH_DB_PATH: join(dir, 'acquisition.sqlite'),
  LEAD_LIBRARY_DB_PATH: join(dir, 'lead-library.sqlite'),
  SCHEDULE_DB_PATH: join(dir, 'acquisition-schedules.sqlite'),
  BRANDING_CACHE_PATH: join(dir, 'branding'),
};
if (
  ![registry, env.OUTREACH_DB_PATH, env.BATCH_DB_PATH, env.LEAD_LIBRARY_DB_PATH].every(existsSync)
)
  throw new Error('快照目录中缺少数据库或邮箱注册文件');
const mailboxes = new OutreachMailboxes({ path: registry, seedPath: null });
const reading = new Map();
const app = createApp({
  env,
  fetchImpl: async () => {
    throw new Error('本地资料与邮箱查看使用本地数据库');
  },
  localMailInspection: {
    sync: async (accounts) => {
      const results = [];
      for (const { id } of accounts) {
        if (!reading.has(id))
          reading.set(
            id,
            syncReadonlyMail({
              path: env.OUTREACH_DB_PATH,
              mailboxes,
              mailbox: id,
              maxPages: 5,
            }).finally(() => reading.delete(id)),
          );
        results.push(...(await reading.get(id)));
      }
      return results;
    },
  },
});
app.on('error', (error) => {
  console.error(error.code || 'LOCAL_MAIL_START_FAILED');
  process.exitCode = 1;
});
app.listen(port, '127.0.0.1', () =>
  console.log('本机邮件工作区 http://127.0.0.1:' + port + '/business?view=replies'),
);
