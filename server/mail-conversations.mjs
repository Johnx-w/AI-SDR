import { createHash } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
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
const iso = (value) => new Date(value).toISOString();
const attachmentMetadata = (value) =>
  Array.isArray(value)
    ? value.slice(0, 100).map((entry) => ({
        name: text(entry.name || entry.filename, 500),
        contentType: text(entry.contentType, 200),
        size: Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null,
      }))
    : [];

/** Local read model. Reading this model never opens an IMAP or SMTP connection. */
export class MailConversations {
  constructor({
    db,
    mailboxes,
    deliveries = () => [],
    customers = () => [],
    recordCommunication,
    now = Date.now,
  }) {
    Object.assign(this, { db, mailboxes, deliveries, customers, recordCommunication, now });
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
    `);
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
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
      syncing: this.pending.has(keyFor(mailbox)),
      hasMore: state.hasMore || false,
      folders: state.folders || [],
      since: state.since || null,
      skipped: state.skipped || 0,
    };
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

  putMessage(mailbox, input, extra = {}) {
    const accountKey = keyFor(mailbox);
    const externalId = messageId(input.messageId);
    const from = address(input.from);
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
      let enriched = { ...old };
      if (input.source === 'imap' && input.bodyFormatVersion === 2) {
        enriched = {
          ...enriched,
          ...richFields,
          attachments: input.attachments ? attachmentMetadata(input.attachments) : old.attachments,
        };
      }
      if (
        ['outreach', 'manual'].includes(old.source) &&
        input.source === 'imap' &&
        input.direction === 'outbound' &&
        old.from === from
      ) {
        enriched = { ...enriched, source: 'imap', deliveryStatus: 'sent' };
      }
      this.db
        .prepare('UPDATE mailbox_thread_messages SET data=? WHERE id=?')
        .run(JSON.stringify(enriched), id);
      this.rebuild(prior.thread_id, mailbox, extra);
      return 0;
    }
    const to = text(input.to, 4000).trim();
    const occurredAt = Number.isFinite(Date.parse(input.occurredAt)) ? iso(input.occurredAt) : null;
    if (!from || !to || !occurredAt || !['inbound', 'outbound'].includes(input.direction)) {
      throw fail(502, '邮件数据不完整，未推进同步位置');
    }
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
    if (input.threadId) {
      const forced = this.db
        .prepare('SELECT account_key FROM mailbox_threads WHERE id=?')
        .get(input.threadId);
      if (!forced || forced.account_key !== accountKey) throw fail(409, '回复会话与邮箱归属不一致');
      linked.unshift(input.threadId);
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
      this.db.prepare('DELETE FROM mailbox_threads WHERE id=?').run(other);
    }
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
      deliveryStatus: input.deliveryStatus,
      messageId: externalId || undefined,
      source: input.source,
      unread: input.direction === 'inbound' && input.unread !== false,
    };
    this.db
      .prepare('INSERT INTO mailbox_thread_messages VALUES(?,?,?,?)')
      .run(id, accountKey, threadId, JSON.stringify(data));
    for (const reference of references)
      this.db
        .prepare(
          `INSERT INTO mailbox_thread_links VALUES(?,?,?)
      ON CONFLICT(account_key,external_id) DO UPDATE SET thread_id=excluded.thread_id`,
        )
        .run(accountKey, reference, threadId);
    this.rebuild(threadId, mailbox, { ...inherited, ...extra });
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
            bodyText: delivery.bodyText,
            occurredAt,
            source: 'outreach',
            deliveryStatus: 'accepted',
            unread: false,
          },
          delivery.customerId
            ? { customerId: delivery.customerId, companyName: delivery.companyName }
            : {},
        );
      }
    });
  }

  localCustomer(thread) {
    if (thread.customerId) return thread;
    const participant = address(thread.participant);
    if (!participant) return thread;
    let customers;
    try {
      customers = this.customers();
    } catch {
      return thread;
    }
    const matched = customers.filter((customer) => {
      const emails = [
        customer.email,
        ...(customer.contactEvidence || [])
          .filter((entry) => entry.kind === 'email')
          .map((entry) => entry.value),
      ];
      return emails.some((value) =>
        text(value, 8000)
          .split(/[\s,;；、]+/u)
          .some((email) => address(email) === participant),
      );
    });
    return matched.length === 1
      ? { ...thread, customerId: matched[0].id, companyName: matched[0].name }
      : thread;
  }

  list({ mailboxId = 'all', q = '', unread = false } = {}) {
    this.importDeliveries();
    const selected = this.selected(mailboxId);
    const query = text(q, 500).toLowerCase().trim();
    const items = selected
      .flatMap((mailbox) =>
        this.db
          .prepare('SELECT data FROM mailbox_threads WHERE account_key=?')
          .all(keyFor(mailbox))
          .map((row) => this.localCustomer(JSON.parse(row.data))),
      )
      .filter(
        (thread) =>
          (!unread || thread.unread) &&
          (!query ||
            [thread.account, thread.participant, thread.subject, thread.preview, thread.companyName]
              .join(' ')
              .toLowerCase()
              .includes(query) ||
            this.messages(thread.id).some((message) =>
              [message.subject, message.from, message.to, message.bodyText]
                .join(' ')
                .toLowerCase()
                .includes(query),
            )),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return {
      items: items.slice(0, 200),
      total: items.length,
      hasMore: items.length > 200,
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

  syncOne(mailbox) {
    const key = keyFor(mailbox);
    if (this.pending.has(key)) return this.pending.get(key);
    const operation = this.performSync(mailbox).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  async performSync(mailbox) {
    const key = keyFor(mailbox);
    const row = this.db.prepare('SELECT data FROM mailbox_sync_state WHERE account_key=?').get(key);
    const prior = row ? JSON.parse(row.data) : {};
    const since = prior.since || iso(this.now() - 30 * 86400000);
    try {
      if (!mailbox.configured) throw fail(409, '请先配置邮箱客户端授权码');
      const batch = await this.mailboxes.readMailbox(mailbox.id, {
        // One bounded rescan upgrades previously cached text-only messages. Later
        // pages continue from their returned cursors, using the original window.
        cursors: prior.contentVersion === 2 ? prior.cursors || {} : {},
        since,
      });
      const current = this.mailboxes.list().find((item) => item.id === mailbox.id);
      if (!current || keyFor(current) !== key) throw fail(409, '邮箱身份已变化，请刷新后重新同步');
      if (!Array.isArray(batch.folders)) throw fail(502, '邮件同步结果无效');
      let imported = 0;
      this.transaction(() => {
        const cursors = { ...prior.cursors };
        for (const folder of batch.folders) {
          if (
            !folder.path ||
            !/^\d+$/u.test(String(folder.uidValidity)) ||
            !Number.isSafeInteger(folder.nextUid) ||
            folder.nextUid < 1 ||
            !Array.isArray(folder.messages)
          ) {
            throw fail(502, '邮件同步位置无效');
          }
          for (const message of folder.messages) {
            imported += this.putMessage(mailbox, {
              ...message,
              identity: [folder.path, folder.uidValidity, message.uid],
              sourceLocator: {
                folder: folder.path,
                uidValidity: String(folder.uidValidity),
                uid: message.uid,
              },
              source: 'imap',
              deliveryStatus: message.direction === 'inbound' ? 'received' : 'sent',
            });
          }
          cursors[folder.path] = {
            uidValidity: String(folder.uidValidity),
            nextUid: folder.nextUid,
          };
        }
        this.saveState(key, {
          contentVersion: 2,
          cursors,
          since,
          lastSyncAt: iso(this.now()),
          error: null,
          folders: batch.folders.map((folder) => folder.path),
          hasMore: !!batch.hasMore,
          skipped: batch.folders.reduce((sum, folder) => sum + (folder.skipped || 0), 0),
        });
      });
      if (this.recordCommunication) {
        for (const thread of this.list({ mailboxId: mailbox.id }).items) {
          try {
            await this.recordCommunication(this.detail(thread.id));
            this.setBusinessStatus(thread.id, '');
          } catch {
            this.setBusinessStatus(thread.id, '邮件已保存，客户沟通记录待核对；下次同步会重试。');
          }
        }
      }
      return imported;
    } catch (error) {
      // Provider errors and credentials never enter the read model or HTTP responses.
      const safe =
        error?.code === 'MAILBOX_NOT_CONFIGURED' || !mailbox.configured
          ? '请先配置邮箱客户端授权码'
          : '收件同步失败，请检查邮箱授权码及 IMAP 服务后重试';
      this.saveState(key, { ...prior, since, error: safe });
      return 0;
    }
  }

  setBusinessStatus(id, error) {
    const row = this.db.prepare('SELECT data FROM mailbox_threads WHERE id=?').get(id);
    if (!row) return;
    const thread = { ...JSON.parse(row.data), recordError: error || undefined };
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
