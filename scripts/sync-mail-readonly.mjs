import { DatabaseSync } from 'node:sqlite';
import { resolve, join, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { MailConversations } from '../server/mail-conversations.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';

export async function syncReadonlyMail({
  path,
  mailboxes,
  since,
  mailbox = 'all',
  maxPages = 40,
  rescan = false,
}) {
  if (!isAbsolute(path)) throw new Error('数据库必须使用绝对路径');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10000)
    throw new Error('max-pages 须为 1 至 10000');
  if (since && (!Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.now()))
    throw new Error('since 日期无效');
  const accounts = mailboxes.list();
  const requested = accounts.filter(
    (a) => mailbox === 'all' || a.id === mailbox || a.email.toLowerCase() === mailbox.toLowerCase(),
  );
  if (!requested.length) throw new Error('隔离目录没有匹配的邮箱');
  const db = new DatabaseSync(path);
  const results = [];
  try {
    db.exec('PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL');
    // No reception, delivery, business journal or CRM callbacks are registered on this importer.
    const store = new MailConversations({
      db,
      mailboxes: {
        list: () => mailboxes.list(),
        readMailbox: (id, options) => mailboxes.readMailbox(id, options),
      },
    });
    for (const account of requested) {
      let imported = 0,
        pages = 0,
        status;
      do {
        imported += await store.syncOne(account, since, rescan && pages === 0);
        status = store.syncState(account);
        pages++;
      } while (!status.error && status.hasMore && pages < maxPages);
      results.push({
        mailboxId: account.id,
        imported,
        pages,
        hasMore: status.hasMore,
        errorCode: status.error ? status.lastError?.code || 'MAILBOX_READ_FAILED' : null,
      });
    }
    await store.close();
    return results;
  } finally {
    db.close();
  }
}

async function run() {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      mailbox: { type: 'string' },
      since: { type: 'string' },
      rescan: { type: 'boolean' },
      'max-pages': { type: 'string' },
    },
  });
  if (!values['data-dir']) throw new Error('请指定 --data-dir <隔离目录>');
  const dir = resolve(values['data-dir']),
    registry = join(dir, 'mailboxes.json');
  if (!existsSync(registry)) throw new Error('指定隔离目录中没有 mailboxes.json');
  const mailboxes = new OutreachMailboxes({ path: registry, seedPath: null });
  const rows = await syncReadonlyMail({
    path: join(dir, 'outreach.sqlite'),
    mailboxes,
    mailbox: values.mailbox,
    since: values.since,
    rescan: values.rescan,
    maxPages: values['max-pages'] === undefined ? 40 : Number(values['max-pages']),
  });
  console.log(JSON.stringify(rows));
  if (rows.some((r) => r.errorCode)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().catch((error) => {
    console.error(error.code || 'MAIL_SYNC_FAILED', error.message);
    process.exitCode = 1;
  });
}
