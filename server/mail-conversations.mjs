import { initializeThreadSearch, listThreadPage } from './mail-thread-page.mjs';
import {
  backfillOfflineCompletions,
  initializeThreadWorkflow,
  mergeThreadWorkflow,
} from './mail-thread-workflow.mjs';
import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { mailSyncFailure } from './mail-sync-errors.mjs';
import { classifyInboundReply, incomingClassification } from './communication-rounds.mjs';
import {
  initializeReplyHistory,
  listReplyHistory,
  internalSenderSql,
  replyToInboundSql,
} from './mail-reply-history.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const SYNC_CONTENT_VERSION = 3;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, maximum = 500) => (typeof value === 'string' ? value.slice(0, maximum) : '');
const address = (value) => {
  const normalized = text(value, 254).trim().toLowerCase();
  return /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(normalized) ? normalized : '';
};
const messageId = (value) => {
  const id = text(value).trim();
  return /^<[^<>\s@]+@[^<>\s@]+>$/u.test(id) ? id : '';
};
const keyFor = (mailbox) => hash([mailbox.id, address(mailbox.email)]);
export { keyFor as mailboxAccountKey };
const accountParameters = (boxes) => boxes.flatMap((box) => [keyFor(box), box.email.toLowerCase()]);
const iso = (value) => new Date(value).toISOString();
const attachmentMetadata = (value) =>
  Array.isArray(value)
    ? value.slice(0, 100).map((entry) => ({
        name: text(entry.name || entry.filename, 500),
        contentType: text(entry.contentType, 200),
        size: Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null,
      }))
    : [];

const positivePageSize = 25;
export function positiveReplyTaskSql(accountCount, countOnly = false) {
  const accountRows = Array.from({ length: accountCount }, () => '(?,?)').join(',');
  const columns = countOnly
    ? 'count(*) AS total'
    : 'h.id,h.account_key,h.thread_id,h.sender,h.subject,h.stamp,h.external_id,h.request_type';
  return `WITH account_email(account_key,email) AS (VALUES ${accountRows})
    SELECT ${columns} FROM mailbox_reply_headers h
    JOIN account_email a ON a.account_key=h.account_key
    WHERE h.direction='inbound' AND h.source='imap' AND h.business_kind='positive'
      AND NOT (${internalSenderSql('SELECT email FROM account_email')})
      AND NOT EXISTS(SELECT 1 FROM mail_offline_handled done WHERE done.message_id=h.id)
      AND NOT EXISTS(SELECT 1 FROM mailbox_reply_headers o WHERE ${replyToInboundSql('a.email')})
    ${countOnly ? '' : 'ORDER BY h.stamp,h.id LIMIT ? OFFSET ?'}`;
}

/** Local read model. Reading this model never opens an IMAP or SMTP connection. */
export class MailConversations {
  constructor({
    db,
    mailboxes,
    deliveries = () => [],
    customers = () => [],
    recordCommunication,
    recordDeliveryBounces,
    onMessage,
    now = Date.now,
  }) {
    Object.assign(this, {
      db,
      mailboxes,
      deliveries,
      customers,
      recordCommunication,
      recordDeliveryBounces,
      onMessage,
      now,
    });
    this.pending = new Map();
    this.closed = false;
    db.exec(`
      CREATE TABLE IF NOT EXISTS mailbox_threads (
        id TEXT PRIMARY KEY, account_key TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mailbox_threads_account ON mailbox_threads(account_key);
      CREATE TABLE IF NOT EXISTS mailbox_thread_messages (
        id TEXT PRIMARY KEY, account_key TEXT NOT NULL, thread_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mailbox_thread_messages_thread ON mailbox_thread_messages(thread_id);
      CREATE TABLE IF NOT EXISTS mailbox_thread_links (
        account_key TEXT NOT NULL, external_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        PRIMARY KEY(account_key,external_id)
      );
      CREATE TABLE IF NOT EXISTS mailbox_sync_state (
        account_key TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mailbox_imported_deliveries (
        delivery_id TEXT PRIMARY KEY
      );
    `);
    initializeReplyHistory(db);
    initializeThreadSearch(db);
    initializeThreadWorkflow(db);
    this.db.function('mail_text_fold', { deterministic: true }, (value) =>
      String(value ?? '').toLowerCase(),
    );
    this.db
      .exec(`CREATE INDEX IF NOT EXISTS mailbox_thread_order ON mailbox_threads(account_key,json_extract(data,'$.updatedAt') DESC,id);
      CREATE INDEX IF NOT EXISTS mailbox_inbound_thread ON mailbox_reply_headers(thread_id) WHERE direction='inbound';
      CREATE INDEX IF NOT EXISTS mailbox_positive_tasks ON mailbox_reply_headers(account_key,stamp,id)
        WHERE direction='inbound' AND source='imap' AND business_kind='positive';
      CREATE INDEX IF NOT EXISTS mailbox_reply_evidence ON mailbox_reply_headers(account_key,thread_id)
        WHERE direction='inbound' AND source='imap' AND parent_id IS NOT NULL;`);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS mailbox_summary_migrations (version INTEGER PRIMARY KEY)',
    );
    if (!db.prepare('SELECT 1 FROM mailbox_summary_migrations WHERE version=4').get())
      this.transaction(() => {
        if (db.prepare('INSERT OR IGNORE INTO mailbox_summary_migrations VALUES(4)').run().changes)
          backfillOfflineCompletions(db);
      });
    if (!this.db.prepare('SELECT 1 FROM mailbox_summary_migrations WHERE version=1').get())
      this.transaction(() => {
        if (
          !this.db.prepare('INSERT OR IGNORE INTO mailbox_summary_migrations VALUES(1)').run()
            .changes
        )
          return;
        this.db.exec(`WITH names AS (
          SELECT h.thread_id, json_extract(m.data,'$.fromName') AS name,
            row_number() OVER (PARTITION BY h.thread_id ORDER BY json_extract(m.data,'$.occurredAt') DESC,m.id DESC) AS ordinal
          FROM mailbox_reply_headers h JOIN mailbox_threads t ON t.id=h.thread_id
          JOIN mailbox_thread_messages m ON m.id=h.id
          WHERE h.direction='inbound' AND h.sender=json_extract(t.data,'$.participant')
            AND trim(coalesce(json_extract(m.data,'$.fromName'),''))!=''
        )
        UPDATE mailbox_threads AS t SET data=json_set(t.data,'$.participantName',trim(names.name))
          FROM names WHERE names.ordinal=1 AND names.thread_id=t.id`);
      });
    if (!this.db.prepare('SELECT 1 FROM mailbox_summary_migrations WHERE version=3').get())
      this.transaction(() => {
        if (
          !this.db.prepare('INSERT OR IGNORE INTO mailbox_summary_migrations VALUES(3)').run()
            .changes
        )
          return;
        const update = this.db.prepare('UPDATE mailbox_thread_messages SET data=? WHERE id=?');
        const rows = this.db
          .prepare(
            `SELECT id,data FROM mailbox_thread_messages
             WHERE json_extract(data,'$.direction')='inbound'
             AND json_extract(data,'$.source')='imap'`,
          )
          .all();
        for (const row of rows) {
          const message = JSON.parse(row.data);
          const business = classifyInboundReply({
            ...message,
            businessKind: undefined,
            requestType: undefined,
          });
          if (
            message.businessKind === business.kind &&
            (message.requestType || null) === (business.requestType || null)
          )
            continue;
          message.businessKind = business.kind;
          if (business.requestType) message.requestType = business.requestType;
          else delete message.requestType;
          update.run(JSON.stringify(message), row.id);
        }
      });
  }

  replyHistory(filters) {
    return listReplyHistory(this, filters, keyFor);
  }

  positiveReplyCount(accounts = this.mailboxes.list()) {
    if (!accounts.length) return 0;
    return this.db
      .prepare(positiveReplyTaskSql(accounts.length, true))
      .get(...accountParameters(accounts)).total;
  }

  positiveReplyPage(requestedPage = 1) {
    // Counts and rows share one snapshot even when a second process is syncing mail.
    return this.transaction(
      () => {
        const accounts = this.mailboxes.list();
        const positiveReplyTotal = this.positiveReplyCount(accounts);
        const positiveReplyPage = Math.min(
          requestedPage,
          Math.max(1, Math.ceil(positiveReplyTotal / positivePageSize)),
        );
        return {
          positiveReplyTotal,
          positiveReplyPage,
          positiveReplyPageSize: positivePageSize,
          positiveReplies: positiveReplyTotal
            ? this.positiveReplyTasks(positiveReplyPage, accounts)
            : [],
        };
      },
      { readOnly: true },
    );
  }

  positiveReplyTasks(page = 1, accounts = this.mailboxes.list()) {
    if (!accounts.length) return [];
    const byKey = new Map(accounts.map((box) => [keyFor(box), box]));
    const rows = this.db
      .prepare(positiveReplyTaskSql(accounts.length))
      .all(...accountParameters(accounts), positivePageSize, (page - 1) * positivePageSize);
    const lookup = this.customerLookup();
    return rows.flatMap((row) => {
      const box = byKey.get(row.account_key);
      if (!box) return [];
      const customer = this.localCustomer({ participant: row.sender }, lookup);
      const waitingHours = Math.max(0, Math.floor((this.now() - Date.parse(row.stamp)) / 3600000));
      return [
        {
          id: row.id,
          messageId: row.id,
          externalId: row.external_id,
          threadId: row.thread_id,
          mailboxId: box.id,
          account: box.email,
          from: row.sender,
          customerId: customer.customerId || null,
          customer: customer.companyName || row.sender,
          subject: row.subject,
          receivedAt: row.stamp,
          requestType: row.request_type,
          waitingHours,
          to:
            '/inbox?' +
            new URLSearchParams({
              tab: 'inbox',
              thread: row.thread_id,
              mailboxId: box.id,
            }),
        },
      ];
    });
  }

  transaction(work, { readOnly = false } = {}) {
    if (this.db.isTransaction) return work();
    this.db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  selected(id = 'all') {
    const accounts = this.mailboxes.list();
    if (id === 'all') return accounts;
    const mailbox = accounts.find((item) => item.id === id);
    if (!mailbox) throw fail(404, '邮箱不存在');
    return [mailbox];
  }

  syncState(mailbox) {
    const row = this.db
      .prepare('SELECT data FROM mailbox_sync_state WHERE account_key=?')
      .get(keyFor(mailbox));
    const state = row ? JSON.parse(row.data) : {};
    return {
      mailboxId: mailbox.id,
      email: mailbox.email,
      lastSyncAt: state.lastSyncAt || null,
      error: state.error || null,
      lastError: state.lastError || null,
      syncing: this.pending.has(keyFor(mailbox)),
      hasMore: state.hasMore || false,
      folders: state.folders || [],
      folderCoverage: state.folderCoverage || null,
      since: state.since || null,
      skipped: state.skipped || 0,
    };
  }

  sentEvidence(delivery) {
    if (!messageId(delivery.messageId)) return null;
    const mailbox = this.mailboxes.list().find((item) => item.id === delivery.mailboxId);
    if (!mailbox) return null;
    const rows = this.db
      .prepare(
        "SELECT data FROM mailbox_thread_messages WHERE account_key=? AND json_extract(data,'$.messageId')=?",
      )
      .all(keyFor(mailbox), delivery.messageId);
    const expectedFrom = address(delivery.from);
    const expectedTo = address(delivery.to);
    for (const row of rows) {
      const message = JSON.parse(row.data);
      const recipients = Array.isArray(message.toAddresses) ? message.toAddresses.map(address) : [];
      if (
        message.source === 'imap' &&
        message.direction === 'outbound' &&
        message.deliveryStatus === 'sent' &&
        address(message.from) === expectedFrom &&
        (recipients.includes(expectedTo) || address(message.to) === expectedTo) &&
        message.sourceLocator?.sent === true
      )
        return {
          messageId: message.messageId,
          occurredAt: message.occurredAt,
          folder: message.sourceLocator.folder,
          uid: message.sourceLocator.uid,
        };
    }
    return null;
  }

  saveState(key, state) {
    this.db
      .prepare(
        `INSERT INTO mailbox_sync_state VALUES(?,?)
      ON CONFLICT(account_key) DO UPDATE SET data=excluded.data`,
      )
      .run(key, JSON.stringify(state));
  }

  messages(id) {
    return this.db
      .prepare('SELECT data FROM mailbox_thread_messages WHERE thread_id=? ORDER BY rowid')
      .all(id)
      .map((row) => JSON.parse(row.data))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  }

  rebuild(id, mailbox, extra = {}) {
    const prior = this.db.prepare('SELECT data FROM mailbox_threads WHERE id=?').get(id);
    const existing = prior ? JSON.parse(prior.data) : {};
    const messages = this.messages(id);
    const latest = messages.at(-1);
    if (!latest) return;
    const first = messages[0];
    const participant =
      messages.find((item) => item.direction === 'inbound')?.from ||
      first.to.split(/[,;]/u)[0].trim();
    const thread = {
      ...existing,
      ...extra,
      id,
      mailboxId: mailbox.id,
      account: mailbox.email,
      participant,
      participantName: messages
        .findLast(
          (message) =>
            message.direction === 'inbound' &&
            message.from === participant &&
            message.fromName?.trim(),
        )
        ?.fromName.trim(),
      subject: first.subject || latest.subject,
      updatedAt: latest.occurredAt,
      unread: messages.some((item) => item.unread),
      messageCount: messages.length,
      preview: latest.bodyText.replace(/\s+/gu, ' ').slice(0, 180),
    };
    this.db
      .prepare(
        `INSERT INTO mailbox_threads VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(id, keyFor(mailbox), JSON.stringify(thread));
    return thread;
  }

  linkMessage(accountKey, input, id, externalId, preferredId) {
    const references = [
      ...new Set(
        [
          ...(Array.isArray(input.references) ? input.references.slice(-100) : []),
          input.inReplyTo,
          externalId,
        ]
          .map(messageId)
          .filter(Boolean),
      ),
    ];
    const linked = references
      .map(
        (reference) =>
          this.db
            .prepare(
              'SELECT thread_id FROM mailbox_thread_links WHERE account_key=? AND external_id=?',
            )
            .get(accountKey, reference)?.thread_id,
      )
      .filter(Boolean);
    if (preferredId || input.threadId) {
      const forced = this.db
        .prepare('SELECT account_key FROM mailbox_threads WHERE id=?')
        .get(preferredId || input.threadId);
      if (!forced || forced.account_key !== accountKey) throw fail(409, '回复会话与邮箱归属不一致');
      linked.unshift(preferredId || input.threadId);
    }
    const matches = [...new Set(linked)];
    const threadId = matches[0] || 'thread_' + hash([accountKey, references[0] || id]);
    // A late parent can join replies that arrived before it, including separate pages.
    let inherited = {};
    for (const other of matches.slice(1)) {
      const row = this.db.prepare('SELECT data FROM mailbox_threads WHERE id=?').get(other);
      if (row) {
        const thread = JSON.parse(row.data);
        if (thread.customerId)
          inherited = { customerId: thread.customerId, companyName: thread.companyName };
      }
      this.db
        .prepare('UPDATE mailbox_thread_messages SET thread_id=? WHERE thread_id=?')
        .run(threadId, other);
      this.db
        .prepare('UPDATE mailbox_thread_links SET thread_id=? WHERE thread_id=?')
        .run(threadId, other);
      mergeThreadWorkflow(this.db, other, threadId);
      this.db.prepare('DELETE FROM mailbox_threads WHERE id=?').run(other);
    }
    for (const reference of references)
      this.db
        .prepare(
          `INSERT INTO mailbox_thread_links VALUES(?,?,?)
      ON CONFLICT(account_key,external_id) DO UPDATE SET thread_id=excluded.thread_id`,
        )
        .run(accountKey, reference, threadId);
    return { threadId, inherited };
  }

  putMessage(mailbox, input, extra = {}, lookup) {
    const accountKey = keyFor(mailbox);
    const externalId = messageId(input.messageId);
    const from = address(input.from);
    const to = text(input.to, 4000).trim();
    const id = 'email_' + hash([accountKey, externalId || input.identity, from]);
    const prior = this.db
      .prepare('SELECT thread_id,data FROM mailbox_thread_messages WHERE id=?')
      .get(id);
    const old = prior && JSON.parse(prior.data);
    const richFields = {
      bodyHtml: text(input.bodyHtml, 1024 * 1024),
      bodyFormatVersion: input.bodyFormatVersion,
      fromName: text(input.fromName, 500),
      toAddresses: Array.isArray(input.toAddresses)
        ? input.toAddresses.map(address).filter(Boolean).slice(0, 200)
        : [],
      cc: Array.isArray(input.cc) ? input.cc.map(address).filter(Boolean).slice(0, 200) : [],
      replyTo: Array.isArray(input.replyTo)
        ? input.replyTo.map(address).filter(Boolean).slice(0, 20)
        : [],
      inReplyTo: messageId(input.inReplyTo) || undefined,
      references: Array.isArray(input.references)
        ? input.references.map(messageId).filter(Boolean).slice(-50)
        : [],
      inlineImages: Array.isArray(input.inlineImages) ? input.inlineImages.slice(0, 20) : [],
      sourceLocator: input.sourceLocator,
    };
    // Enrich old cached mail without replacing original text or local read decisions.
    if (prior) {
      // The same Message-ID in another folder cannot lend sent-folder proof to different recipients.
      if (old.to.toLowerCase() !== to.toLowerCase()) return 0;
      let enriched = { ...old };
      if (input.source === 'imap' && input.bodyFormatVersion === 2) {
        enriched = {
          ...enriched,
          ...richFields,
          bodyText: old.bodyText || text(input.bodyText, 1024 * 1024),
          bodyHtml: richFields.bodyHtml || old.bodyHtml,
          inReplyTo: richFields.inReplyTo || old.inReplyTo,
          references: richFields.references.length ? richFields.references : old.references || [],
          classification:
            input.direction === 'inbound' &&
            (!old.classification || ['normal', 'unverified'].includes(old.classification))
              ? incomingClassification({
                  ...input,
                  bodyText: old.bodyText || input.bodyText,
                  bodyHtml: input.bodyHtml || old.bodyHtml,
                })
              : old.classification,
          attachments: input.attachments ? attachmentMetadata(input.attachments) : old.attachments,
        };
        if (input.direction === 'inbound') {
          const business = classifyInboundReply({
            ...enriched,
            businessKind: undefined,
            requestType: undefined,
          });
          enriched = {
            ...enriched,
            businessKind: business.kind,
            requestType: business.requestType || undefined,
          };
        }
      }
      if (
        ['outreach', 'manual', 'automatic'].includes(old.source) &&
        input.source === 'imap' &&
        input.direction === 'outbound' &&
        old.from === from
      ) {
        enriched = { ...enriched, sendOrigin: old.source, source: 'imap', deliveryStatus: 'sent' };
      }
      this.db
        .prepare('UPDATE mailbox_thread_messages SET data=? WHERE id=?')
        .run(JSON.stringify(enriched), id);
      const changedHeaders =
        (enriched.inReplyTo && enriched.inReplyTo !== old.inReplyTo) ||
        (enriched.references?.length &&
          JSON.stringify(old.references) !== JSON.stringify(enriched.references));
      const inherited = changedHeaders
        ? this.linkMessage(accountKey, enriched, id, externalId, prior.thread_id).inherited
        : {};
      this.rebuild(prior.thread_id, mailbox, { ...inherited, ...extra });
      return 0;
    }
    const occurredAt = Number.isFinite(Date.parse(input.occurredAt)) ? iso(input.occurredAt) : null;
    if (!from || !to || !occurredAt || !['inbound', 'outbound'].includes(input.direction)) {
      throw Object.assign(fail(502, '邮件数据不完整，未推进同步位置'), {
        code: 'MAILBOX_SYNC_INVALID',
      });
    }
    const { threadId, inherited } = this.linkMessage(accountKey, input, id, externalId);
    const data = {
      id,
      direction: input.direction,
      from,
      to,
      subject: text(input.subject, 2000),
      bodyText: text(input.bodyText, 1024 * 1024),
      ...richFields,
      bodyUnavailable: input.bodyUnavailable || undefined,
      attachments: attachmentMetadata(input.attachments),
      occurredAt,
      receivedAt: input.receivedAt || occurredAt,
      deliveryStatus: input.deliveryStatus,
      classification: input.direction === 'inbound' ? incomingClassification(input) : 'normal',
      messageId: externalId || undefined,
      source: input.source,
      unread: input.direction === 'inbound' && input.unread !== false,
    };
    if (data.direction === 'inbound') {
      const business = classifyInboundReply(data);
      data.businessKind = business.kind;
      data.requestType = business.requestType || undefined;
    }
    this.db
      .prepare('INSERT INTO mailbox_thread_messages VALUES(?,?,?,?)')
      .run(id, accountKey, threadId, JSON.stringify(data));
    const thread = this.rebuild(threadId, mailbox, { ...inherited, ...extra });
    if (
      data.direction === 'inbound' &&
      ['normal', 'unverified', 'unsubscribe', 'complaint'].includes(data.classification)
    ) {
      const arrival = Number.isFinite(Date.parse(data.receivedAt))
        ? iso(data.receivedAt)
        : occurredAt;
      this.db
        .prepare(
          `UPDATE mail_thread_workflow SET state='open',snooze_until=NULL,updated_at=?
        WHERE thread_id=? AND state!='open' AND updated_at<=?`,
        )
        .run(arrival, threadId, arrival);
    }
    this.onMessage?.(mailbox, thread, data, lookup);
    return 1;
  }

  importDeliveries() {
    const accounts = new Map(this.mailboxes.list().map((mailbox) => [mailbox.id, mailbox]));
    this.transaction(() => {
      for (const delivery of this.deliveries()) {
        const mailbox = accounts.get(delivery.mailboxId);
        if (
          !mailbox ||
          address(mailbox.email) !== address(delivery.from) ||
          delivery.status !== 'accepted'
        )
          continue;
        const occurredAt = delivery.sentAt;
        if (!Number.isFinite(Date.parse(occurredAt)) || !messageId(delivery.messageId)) continue;
        this.putMessage(
          mailbox,
          {
            identity: 'outreach:' + delivery.id,
            messageId: delivery.messageId,
            direction: 'outbound',
            from: delivery.from,
            to: delivery.to,
            subject: delivery.subject,
            inReplyTo: delivery.inReplyTo,
            references: delivery.references,
            bodyText: delivery.bodyText,
            bodyHtml: delivery.bodyHtml,
            occurredAt,
            source: 'outreach',
            deliveryStatus: 'accepted',
            unread: false,
          },
          delivery.customerId
            ? { customerId: delivery.customerId, companyName: delivery.companyName }
            : {},
        );
        this.db
          .prepare('INSERT OR IGNORE INTO mailbox_imported_deliveries VALUES (?)')
          .run(delivery.id);
      }
    });
  }

  customerLookup() {
    let matches;
    return (participant) => {
      if (!matches) {
        matches = new Map();
        for (const customer of this.customers()) {
          const emails = [
            customer.email,
            ...(customer.contactEvidence || [])
              .filter((entry) => entry.kind === 'email')
              .map((entry) => entry.value),
          ];
          for (const email of new Set(
            emails
              .flatMap((value) =>
                text(value, 8000)
                  .split(/[\s,;；、]+/u)
                  .map(address),
              )
              .filter(Boolean),
          ))
            matches.set(email, matches.has(email) ? null : customer);
        }
      }
      return matches.get(participant);
    };
  }
  localCustomer(thread, lookup = this.customerLookup()) {
    if (thread.customerId) return thread;
    const participant = address(thread.participant);
    if (!participant) return thread;
    try {
      const customer = lookup(participant);
      return customer ? { ...thread, customerId: customer.id, companyName: customer.name } : thread;
    } catch {
      return thread;
    }
  }

  list(
    {
      mailboxId = 'all',
      customerId = '',
      q = '',
      unread = false,
      inboundOnly = false,
      hasReply = false,
      folder = '',
      page = 1,
      pageSize = 25,
    } = {},
    lookup = this.customerLookup(),
  ) {
    this.importDeliveries();
    const keys = this.selected(mailboxId).map(keyFor);
    const result = listThreadPage(this, keys, lookup, {
      customerId,
      query: text(q, 500).toLowerCase().trim(),
      unread,
      inboundOnly,
      hasReply,
      folder,
      page,
      pageSize,
    });
    return {
      ...result,
      mailboxes: this.mailboxes.list().map((mailbox) => this.syncState(mailbox)),
    };
  }
  detail(id) {
    this.importDeliveries();
    const row = this.db.prepare('SELECT account_key,data FROM mailbox_threads WHERE id=?').get(id);
    if (!row || !this.mailboxes.list().some((mailbox) => keyFor(mailbox) === row.account_key)) {
      throw fail(404, '邮件会话不存在');
    }
    return {
      conversation: this.localCustomer(JSON.parse(row.data)),
      messages: this.messages(id).map(({ unread, ...message }) => message),
    };
  }

  markRead(id, unread) {
    if (unread !== false) throw fail(400, '只支持标记本地会话已读');
    const { conversation } = this.detail(id);
    const mailbox = this.selected(conversation.mailboxId)[0];
    const updated = this.transaction(() => {
      for (const message of this.messages(id)) {
        this.db
          .prepare('UPDATE mailbox_thread_messages SET data=? WHERE id=?')
          .run(JSON.stringify({ ...message, unread: false }), message.id);
      }
      return this.rebuild(id, mailbox);
    });
    return { conversation: this.localCustomer(updated) };
  }

  syncOne(mailbox, requestedSince, rescan = false) {
    const key = keyFor(mailbox);
    if (this.pending.has(key)) return this.pending.get(key);
    const operation = this.performSync(mailbox, requestedSince, rescan).finally(() =>
      this.pending.delete(key),
    );
    this.pending.set(key, operation);
    return operation;
  }

  async performSync(mailbox, requestedSince, rescan) {
    const key = keyFor(mailbox);
    const row = this.db.prepare('SELECT data FROM mailbox_sync_state WHERE account_key=?').get(key);
    const prior = row ? JSON.parse(row.data) : {};
    const extendWindow =
      requestedSince && prior.since && Date.parse(requestedSince) < Date.parse(prior.since);
    const since =
      requestedSince && (extendWindow || rescan || !prior.since)
        ? iso(requestedSince)
        : prior.since || iso(this.now() - 30 * 86400000);
    const checkpointIsCurrent = () =>
      this.db.prepare('SELECT data FROM mailbox_sync_state WHERE account_key=?').get(key)?.data ===
      row?.data;
    let stage = 'read';
    try {
      if (!mailbox.configured)
        throw Object.assign(fail(409, '请先配置邮箱客户端授权码'), {
          code: 'MAILBOX_NOT_CONFIGURED',
        });
      const restartWindow = extendWindow || rescan || prior.contentVersion !== SYNC_CONTENT_VERSION;
      const batch = await this.mailboxes.readMailbox(mailbox.id, {
        // Re-read the original window in bounded pages when the reader gains new content.
        cursors: restartWindow ? {} : prior.cursors || {},
        since,
      });
      const current = this.mailboxes.list().find((item) => item.id === mailbox.id);
      if (!current || keyFor(current) !== key)
        throw Object.assign(fail(409, '邮箱身份已变化，请刷新后重新同步'), {
          code: 'MAILBOX_IDENTITY_CHANGED',
        });
      stage = 'validate';
      if (!Array.isArray(batch.folders)) throw fail(502, '邮件同步结果无效');
      let imported = 0;
      const lookup = this.customerLookup();
      stage = 'save';
      this.transaction(() => {
        // Another reader may have committed this (or a newer) page while IMAP was open.
        if (!checkpointIsCurrent()) return;
        const cursors = restartWindow ? {} : { ...prior.cursors };
        for (const folder of batch.folders) {
          if (
            !folder.path ||
            !/^\d+$/u.test(String(folder.uidValidity)) ||
            !Number.isSafeInteger(folder.nextUid) ||
            folder.nextUid < 1 ||
            !Array.isArray(folder.messages)
          ) {
            throw Object.assign(fail(502, '邮件同步位置无效'), { code: 'MAILBOX_SYNC_INVALID' });
          }
          for (const message of folder.messages) {
            imported += this.putMessage(
              mailbox,
              {
                ...message,
                identity: [folder.path, folder.uidValidity, message.uid],
                sourceLocator: {
                  folder: folder.path,
                  sent: folder.sent === true,
                  uidValidity: String(folder.uidValidity),
                  uid: message.uid,
                },
                source: 'imap',
                deliveryStatus: message.direction === 'inbound' ? 'received' : 'sent',
              },
              {},
              lookup,
            );
          }
          cursors[folder.path] = {
            uidValidity: String(folder.uidValidity),
            nextUid: folder.nextUid,
          };
        }
        this.recordDeliveryBounces?.(
          mailbox,
          batch.folders.filter((folder) => !folder.sent).flatMap((folder) => folder.messages),
        );
        this.saveState(key, {
          contentVersion: SYNC_CONTENT_VERSION,
          cursors,
          since,
          lastSyncAt: iso(this.now()),
          error: null,
          lastError: prior.lastError || null,
          folders: batch.folders.map((folder) => folder.path),
          folderCoverage: batch.folderCoverage,
          hasMore: !!batch.hasMore,
          skipped: batch.folders.reduce((sum, folder) => sum + (folder.skipped || 0), 0),
        });
      });
      if (this.recordCommunication) {
        for (const thread of this.list({ mailboxId: mailbox.id, pageSize: 200 }, lookup).items) {
          await yieldToRequests();
          if (this.closed || !this.mailboxes.list().some((current) => keyFor(current) === key))
            break;
          try {
            await this.recordCommunication({
              conversation: thread,
              messages: this.messages(thread.id).map(({ unread, ...message }) => message),
            });
            this.setBusinessStatus(thread.id, '');
          } catch {
            this.setBusinessStatus(thread.id, '邮件已保存，客户沟通记录待核对；下次同步会重试。');
          }
        }
      }
      return imported;
    } catch (error) {
      const failure = mailSyncFailure(error, stage);
      this.transaction(() => {
        if (!checkpointIsCurrent()) return;
        this.saveState(key, {
          ...prior,
          since: prior.since || since,
          error: failure.message,
          lastError: {
            ...failure.diagnostic,
            message: failure.message,
            occurredAt: iso(this.now()),
          },
        });
      });
      return 0;
    }
  }

  setBusinessStatus(id, error) {
    const row = this.db.prepare('SELECT data FROM mailbox_threads WHERE id=?').get(id);
    if (!row) return;
    const saved = JSON.parse(row.data);
    if ((saved.recordError || '') === (error || '')) return;
    const thread = { ...saved, recordError: error || undefined };
    this.db.prepare('UPDATE mailbox_threads SET data=? WHERE id=?').run(JSON.stringify(thread), id);
  }

  async sync({ mailboxId = 'all' } = {}) {
    if (this.closed) throw fail(503, '邮件服务已关闭');
    const accounts = this.selected(mailboxId);
    let imported = 0;
    for (let start = 0; start < accounts.length; start += 3) {
      const results = await Promise.all(
        accounts.slice(start, start + 3).map((mailbox) => this.syncOne(mailbox)),
      );
      imported += results.reduce((sum, count) => sum + count, 0);
    }
    this.importDeliveries();
    return { imported, mailboxes: this.mailboxes.list().map((mailbox) => this.syncState(mailbox)) };
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
  }
}
