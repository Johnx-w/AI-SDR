import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { mailDraftModel } from '../server/mail-draft-model.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { syncReadonlyMail } from './sync-mail-readonly.mjs';

const { values } = parseArgs({
  options: {
    connections: { type: 'string' },
    'data-dir': { type: 'string' },
    port: { type: 'string', default: '14324' },
  },
});
if (!values['data-dir']) throw new Error('请指定用于本地查看的数据库快照目录');
const dir = resolve(values['data-dir']),
  outreach = join(dir, 'outreach'),
  registry = join(outreach, 'mailboxes.json');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口号无效');
const configured = values.connections
  ? JSON.parse(readFileSync(resolve(values.connections), 'utf8'))
  : {};
const localConnections = Object.fromEntries(
  Object.entries(configured).filter(([key]) =>
    /^(FEISHU_|MATERIAL_DEEPSEEK_|RESEARCH_MODEL_|DEEPSEEK_)/u.test(key),
  ),
);
const env = {
  ...localConnections,
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
function inspectionFetch(input, init = {}) {
  const url = new URL(input),
    method = (init.method || 'GET').toUpperCase();
  const deepseek =
    url.origin === 'https://api.deepseek.com' &&
    ((method === 'POST' &&
      /^\/(?:v1\/)?(?:tools\/ocr|files|chat\/completions)$/.test(url.pathname)) ||
      (method === 'DELETE' && /^\/(?:v1\/)?files\/file-[\w-]+$/.test(url.pathname)));
  const feishu =
    values.connections &&
    url.origin === 'https://open.feishu.cn' &&
    (method === 'GET' ||
      (method === 'POST' &&
        (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal' ||
          /^\/open-apis\/bitable\/v1\/apps\/[^/]+\/tables\/[^/]+\/records\/search$/.test(
            url.pathname,
          ))));
  if (!deepseek && !feishu) throw new Error('本机预览仅开放 DeepSeek 解析与起草、飞书只读访问');
  return fetch(url, { ...init, redirect: 'error' });
}
const app = createApp({
  env,
  fetchImpl: inspectionFetch,
  localMailInspection: {
    draftModel: mailDraftModel(
      {
        ...env,
        DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY,
        DEEPSEEK_MODEL: env.DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL,
      },
      inspectionFetch,
    ),
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
