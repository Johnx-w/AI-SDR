import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAlibabaMailTransport } from './mail-transport.mjs';

export const PILOT_MAILBOX = 'SL01@shutterblindssolutions.com';
export const PILOT_TEST_RECIPIENT = 'SL01@honeybadgerblinds.com';

const TEST_BODY =
  '这是一封 ShadeFlow 邮箱连接测试邮件，仅发送到公司控制的测试邮箱。请直接回复本邮件以验证收件和会话关联。此邮件不是产品推广。';
const ADDRESS_LOWER = PILOT_MAILBOX.toLowerCase();
const RECIPIENT_LOWER = PILOT_TEST_RECIPIENT.toLowerCase();
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const MESSAGE_ID_PATTERN = /^<[^<>\s@]+@[^<>\s@]+>$/;
const TEST_MARKER_PATTERN = /^\[ShadeFlow-Test:[a-f0-9-]{36}\]$/i;

const ERROR_MESSAGES = Object.freeze({
  MAIL_NOT_CONFIGURED: '邮箱客户端安全密码尚未在本机配置',
  MAIL_NOT_INITIALIZED: '邮箱首次同步基线尚未建立',
  MAIL_CONFIRMATION_REQUIRED: '需要明确确认本次发送',
  MAIL_INVALID_IDEMPOTENCY_KEY: '无效的发送操作编号',
  MAIL_IDEMPOTENCY_CONFLICT: '发送操作编号已用于其他内容',
  MAIL_SEND_OUTCOME_UNKNOWN: '发送结果尚未核实，已暂停重发',
  MAIL_TEST_ALREADY_ATTEMPTED: '本次试点测试信已尝试发送，不能重复发送',
  MAIL_CONVERSATION_NOT_FOUND: '测试会话不存在',
  MAIL_INVALID_DRAFT: '回信草稿无效',
  MAIL_DRAFT_CONFLICT: '草稿版本已变化，请刷新后重试',
  MAIL_DRAFT_NOT_READY: '没有可发送的待审核草稿',
  MAIL_DRAFT_STALE: '草稿对应的来信已不是最新消息，请重新审核',
  MAIL_THREAD_NOT_READY: '测试线程尚无可回复的来信',
  MAIL_CONVERSATION_PAUSED: '该会话已暂停，不能继续发信',
  MAIL_CONNECTION_NOT_READY: '邮箱连接验证未通过',
  MAIL_TRANSPORT_FAILED: '邮箱服务暂时不可用',
  MAIL_SEND_UNCONFIRMED: '无法确认邮件是否已提交，已暂停重发',
  MAIL_SYNC_FAILED: '邮箱同步失败',
  MAIL_UNEXPECTED_IDENTITY: '邮箱试点账号或测试收件地址与固定配置不一致',
});

export class MailServiceError extends Error {
  constructor(code, status = 409) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.MAIL_TRANSPORT_FAILED);
    this.name = 'MailServiceError';
    this.code = code;
    this.status = status;
  }
}

function safeError(error, fallback = 'MAIL_TRANSPORT_FAILED') {
  return error instanceof MailServiceError ? error : new MailServiceError(fallback, 503);
}

function operationKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new MailServiceError('MAIL_INVALID_IDEMPOTENCY_KEY', 400);
  }
  return value;
}

function messageId(value) {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value) ? value : null;
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isoDate(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid clock');
  return date.toISOString();
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeAddress(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validatedDraftBody(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim() || bodyText.length > 20_000) {
    throw new MailServiceError('MAIL_INVALID_DRAFT', 400);
  }
  return bodyText.trim();
}

export class MailService {
  constructor({
    env = process.env,
    transportFactory = createAlibabaMailTransport,
    now = () => new Date(),
    pollIntervalMs = 60_000,
  } = {}) {
    if (
      (env.MAIL_ACCOUNT && normalizeAddress(env.MAIL_ACCOUNT) !== ADDRESS_LOWER) ||
      (env.MAIL_TEST_RECIPIENT && normalizeAddress(env.MAIL_TEST_RECIPIENT) !== RECIPIENT_LOWER)
    ) {
      throw new MailServiceError('MAIL_UNEXPECTED_IDENTITY', 400);
    }
    // Unconfigured instances (including ordinary app tests) must not touch a real mailbox DB.
    const path =
      env.MAIL_DB_PATH || (env.MAIL_CLIENT_PASSWORD ? '.data/mail-pilot.sqlite' : ':memory:');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS mail_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mail_conversations (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL, participant TEXT NOT NULL,
        marker TEXT, status TEXT NOT NULL, agent_status TEXT NOT NULL,
        unread INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mail_conversations_marker ON mail_conversations(marker);
      CREATE TABLE IF NOT EXISTS mail_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
        direction TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL,
        subject TEXT NOT NULL, body_text TEXT NOT NULL, occurred_at TEXT NOT NULL,
        delivery_status TEXT NOT NULL, message_id TEXT UNIQUE, in_reply_to TEXT,
        references_json TEXT NOT NULL DEFAULT '[]', classification_json TEXT,
        uid_validity TEXT, imap_uid INTEGER,
        FOREIGN KEY(conversation_id) REFERENCES mail_conversations(id),
        UNIQUE(uid_validity,imap_uid)
      );
      CREATE INDEX IF NOT EXISTS mail_messages_conversation
        ON mail_messages(conversation_id,occurred_at);
      CREATE TABLE IF NOT EXISTS mail_drafts (
        conversation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
        body_text TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL,
        reply_to_message_id TEXT,
        FOREIGN KEY(conversation_id) REFERENCES mail_conversations(id)
      );
      CREATE TABLE IF NOT EXISTS mail_operations (
        idempotency_key TEXT PRIMARY KEY, kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL, conversation_id TEXT NOT NULL,
        state TEXT NOT NULL, result_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );`);
    const draftColumns = this.db.prepare('PRAGMA table_info(mail_drafts)').all();
    if (!draftColumns.some((column) => column.name === 'reply_to_message_id')) {
      this.db.exec('ALTER TABLE mail_drafts ADD COLUMN reply_to_message_id TEXT;');
    }
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
    this.timer = null;
    this.syncPromise = null;
    this.serialPromise = Promise.resolve();
    this.passwordConfigured =
      typeof env.MAIL_CLIENT_PASSWORD === 'string' && env.MAIL_CLIENT_PASSWORD.trim().length > 0;
    this.transport = this.passwordConfigured
      ? transportFactory({
          account: PILOT_MAILBOX,
          clientPassword: env.MAIL_CLIENT_PASSWORD,
          allowedTestRecipients: [PILOT_TEST_RECIPIENT],
        })
      : null;
    this.recoverInterruptedSends();
  }

  transact(work) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = work();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM mail_meta WHERE key=?').get(key);
    return row?.value ?? null;
  }

  setMeta(key, value) {
    this.db
      .prepare(
        'INSERT INTO mail_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }

  recoverInterruptedSends() {
    this.transact(() => {
      const pending = this.db
        .prepare("SELECT conversation_id,kind FROM mail_operations WHERE state='pending'")
        .all();
      if (!pending.length) return;
      const at = isoDate(this.now);
      this.db
        .prepare("UPDATE mail_operations SET state='unknown',updated_at=? WHERE state='pending'")
        .run(at);
      for (const operation of pending) {
        this.db
          .prepare(
            "UPDATE mail_conversations SET status='send_unknown',agent_status='paused',updated_at=? WHERE id=?",
          )
          .run(at, operation.conversation_id);
        if (operation.kind === 'reply') {
          this.db
            .prepare(
              "UPDATE mail_drafts SET status='unknown',updated_at=? WHERE conversation_id=? AND status='sending'",
            )
            .run(at, operation.conversation_id);
        }
      }
    });
  }

  requireTransport() {
    if (!this.transport) throw new MailServiceError('MAIL_NOT_CONFIGURED', 503);
    return this.transport;
  }

  requireCursor() {
    const cursor = parseJson(this.getMeta('inbox_cursor'));
    if (
      !cursor ||
      typeof cursor.uidValidity !== 'string' ||
      !Number.isSafeInteger(cursor.nextUid)
    ) {
      throw new MailServiceError('MAIL_NOT_INITIALIZED', 503);
    }
    return cursor;
  }

  requireConnectionReady() {
    if (
      this.getMeta('smtp_status') !== 'connected' ||
      this.getMeta('imap_status') !== 'connected'
    ) {
      throw new MailServiceError('MAIL_CONNECTION_NOT_READY', 503);
    }
  }

  runSerial(work) {
    const result = this.serialPromise.then(work, work);
    this.serialPromise = result.catch(() => {});
    return result;
  }

  latestInboundMessage(id) {
    return this.db
      .prepare(
        `SELECT message_id,subject FROM mail_messages
         WHERE conversation_id=? AND direction='inbound'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(id);
  }

  status() {
    const pendingReviews = this.db
      .prepare("SELECT COUNT(*) AS count FROM mail_drafts WHERE status='pending_review'")
      .get().count;
    const lastActivityAt = this.getMeta('agent_last_activity_at');
    return {
      mode: 'test_only',
      mailbox: {
        address: PILOT_MAILBOX,
        configured: this.passwordConfigured,
        imapStatus: this.passwordConfigured
          ? this.getMeta('imap_status') || 'not_checked'
          : 'not_configured',
        smtpStatus: this.passwordConfigured
          ? this.getMeta('smtp_status') || 'not_checked'
          : 'not_configured',
        lastSyncAt: this.getMeta('last_sync_at'),
        lastError: this.getMeta('last_error') || null,
      },
      agent: {
        status: 'not_running',
        lastActivityAt,
        pendingReviews,
        pausedReason: '产品资料未审核；自动开发与自动回信未启用，试点回信须人工确认',
      },
    };
  }

  conversationSummary(row) {
    return {
      id: row.id,
      subject: row.subject,
      participant: row.participant,
      updatedAt: row.updated_at,
      unread: Boolean(row.unread),
      status: row.status,
      agentStatus: row.agent_status,
    };
  }

  listConversations() {
    const rows = this.db
      .prepare('SELECT * FROM mail_conversations ORDER BY updated_at DESC,id DESC LIMIT 100')
      .all();
    return { items: rows.map((row) => this.conversationSummary(row)) };
  }

  requireConversation(id) {
    const row =
      typeof id === 'string'
        ? this.db.prepare('SELECT * FROM mail_conversations WHERE id=?').get(id)
        : null;
    if (!row) throw new MailServiceError('MAIL_CONVERSATION_NOT_FOUND', 404);
    return row;
  }

  getConversation(id) {
    const row = this.requireConversation(id);
    const messages = this.db
      .prepare('SELECT * FROM mail_messages WHERE conversation_id=? ORDER BY occurred_at,rowid')
      .all(id)
      .map((item) => ({
        id: item.id,
        direction: item.direction,
        from: item.from_addr,
        to: item.to_addr,
        subject: item.subject,
        bodyText: item.body_text,
        occurredAt: item.occurred_at,
        deliveryStatus: item.delivery_status,
        messageId: item.message_id,
        inReplyTo: item.in_reply_to,
        references: parseJson(item.references_json, []),
        classification: parseJson(item.classification_json),
      }));
    const draftRow = this.db
      .prepare(
        'SELECT body_text,revision,status,reply_to_message_id FROM mail_drafts WHERE conversation_id=?',
      )
      .get(id);
    return {
      conversation: this.conversationSummary(row),
      messages,
      draft: draftRow
        ? {
            bodyText: draftRow.body_text,
            revision: draftRow.revision,
            status: draftRow.status,
            replyToMessageId: draftRow.reply_to_message_id,
          }
        : null,
    };
  }

  saveDraft(id, { bodyText, expectedRevision } = {}) {
    const conversation = this.requireConversation(id);
    if (['unsubscribed', 'hard_bounce', 'send_unknown'].includes(conversation.status)) {
      throw new MailServiceError('MAIL_CONVERSATION_PAUSED');
    }
    if (normalizeAddress(conversation.participant) !== RECIPIENT_LOWER) {
      throw new MailServiceError('MAIL_CONVERSATION_PAUSED');
    }
    const body = validatedDraftBody(bodyText);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new MailServiceError('MAIL_DRAFT_CONFLICT', 409);
    }
    return this.transact(() => {
      const latestIncoming = this.latestInboundMessage(id);
      if (!messageId(latestIncoming?.message_id)) {
        throw new MailServiceError('MAIL_THREAD_NOT_READY', 409);
      }
      const current = this.db
        .prepare('SELECT revision,status FROM mail_drafts WHERE conversation_id=?')
        .get(id);
      if (
        (current?.revision ?? 0) !== expectedRevision ||
        ['sending', 'unknown'].includes(current?.status)
      ) {
        throw new MailServiceError('MAIL_DRAFT_CONFLICT', 409);
      }
      const revision = expectedRevision + 1;
      const at = isoDate(this.now);
      this.db
        .prepare(
          `INSERT INTO mail_drafts
        (conversation_id,revision,body_text,status,updated_at,reply_to_message_id)
        VALUES(?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET
        revision=excluded.revision,body_text=excluded.body_text,
        status=excluded.status,updated_at=excluded.updated_at,
        reply_to_message_id=excluded.reply_to_message_id`,
        )
        .run(id, revision, body, 'pending_review', at, latestIncoming.message_id);
      this.db
        .prepare(
          "UPDATE mail_conversations SET status='awaiting_review',agent_status='awaiting_human',unread=0,updated_at=? WHERE id=?",
        )
        .run(at, id);
      return {
        bodyText: body,
        revision,
        status: 'pending_review',
        replyToMessageId: latestIncoming.message_id,
      };
    });
  }

  async start() {
    if (!this.transport) return this.status();
    const errors = [];
    try {
      await this.transport.verifySmtp();
      this.setMeta('smtp_status', 'connected');
    } catch {
      this.setMeta('smtp_status', 'error');
      errors.push('SMTP_CONNECT_FAILED');
    }
    try {
      if (this.getMeta('inbox_cursor')) {
        this.requireCursor();
        await this.transport.verifyImap();
      } else {
        const cursor = await this.transport.captureInboxCursor();
        this.transact(() => {
          // A concurrent start must not reset an existing baseline.
          if (!this.getMeta('inbox_cursor')) this.setMeta('inbox_cursor', JSON.stringify(cursor));
        });
      }
      this.setMeta('imap_status', 'connected');
    } catch {
      this.setMeta('imap_status', 'error');
      errors.push('IMAP_CONNECT_FAILED');
    }
    this.setMeta('last_error', errors.join(',') || '');
    if (!this.timer && this.pollIntervalMs > 0 && this.getMeta('inbox_cursor')) {
      this.timer = setInterval(() => {
        void this.sync().catch(() => {});
      }, this.pollIntervalMs);
      this.timer.unref?.();
    }
    if (errors.length) throw new MailServiceError('MAIL_TRANSPORT_FAILED', 503);
    return this.status();
  }

  existingOperation(key, kind, payloadHash) {
    const existing = this.db
      .prepare('SELECT * FROM mail_operations WHERE idempotency_key=?')
      .get(key);
    if (!existing) return null;
    if (existing.kind !== kind || existing.payload_hash !== payloadHash) {
      throw new MailServiceError('MAIL_IDEMPOTENCY_CONFLICT', 409);
    }
    if (existing.state === 'succeeded') return parseJson(existing.result_json);
    throw new MailServiceError('MAIL_SEND_OUTCOME_UNKNOWN', 409);
  }

  beginOperation({ key, kind, payloadHash, conversationId }) {
    const at = isoDate(this.now);
    this.db
      .prepare(
        `INSERT INTO mail_operations
      (idempotency_key,kind,payload_hash,conversation_id,state,result_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(key, kind, payloadHash, conversationId, 'pending', null, at, at);
    return at;
  }

  markOperationUnknown(key, conversationId, isReply = false) {
    this.transact(() => {
      const at = isoDate(this.now);
      this.db
        .prepare(
          "UPDATE mail_operations SET state='unknown',updated_at=? WHERE idempotency_key=? AND state='pending'",
        )
        .run(at, key);
      this.db
        .prepare(
          "UPDATE mail_conversations SET status='send_unknown',agent_status='paused',updated_at=? WHERE id=?",
        )
        .run(at, conversationId);
      if (isReply) {
        this.db
          .prepare(
            "UPDATE mail_drafts SET status='unknown',updated_at=? WHERE conversation_id=? AND status='sending'",
          )
          .run(at, conversationId);
      }
      this.setMeta('last_error', 'SEND_OUTCOME_UNKNOWN');
    });
  }

  async sendTechnicalTest({ confirmed, idempotencyKey } = {}) {
    if (confirmed !== true) throw new MailServiceError('MAIL_CONFIRMATION_REQUIRED', 400);
    const key = operationKey(idempotencyKey);
    const transport = this.requireTransport();
    if (
      !this.getMeta('inbox_cursor') &&
      (this.getMeta('smtp_status') === 'error' || this.getMeta('imap_status') === 'error')
    ) {
      this.requireConnectionReady();
    }
    this.requireCursor();
    const payloadHash = hash(['technical_test', PILOT_MAILBOX, PILOT_TEST_RECIPIENT]);
    const prior = this.existingOperation(key, 'technical_test', payloadHash);
    if (prior) return prior;
    this.requireConnectionReady();
    const conversationId = randomUUID();
    this.transact(() => {
      const attempted = this.db.prepare('SELECT id FROM mail_conversations LIMIT 1').get();
      if (attempted) throw new MailServiceError('MAIL_TEST_ALREADY_ATTEMPTED', 409);
      const at = this.beginOperation({ key, kind: 'technical_test', payloadHash, conversationId });
      this.db
        .prepare(
          `INSERT INTO mail_conversations
        (id,subject,participant,marker,status,agent_status,unread,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          conversationId,
          '邮箱连接测试',
          PILOT_TEST_RECIPIENT,
          null,
          'sending_test',
          'not_running',
          0,
          at,
          at,
        );
    });

    try {
      const sent = await transport.sendTechnicalTest({ to: PILOT_TEST_RECIPIENT });
      if (
        sent?.accepted !== true ||
        normalizeAddress(sent.to) !== RECIPIENT_LOWER ||
        !messageId(sent.messageId) ||
        !TEST_MARKER_PATTERN.test(sent.marker)
      ) {
        throw new MailServiceError('MAIL_SEND_UNCONFIRMED', 503);
      }
      const result = {
        conversationId,
        messageId: sent.messageId,
        to: PILOT_TEST_RECIPIENT,
        accepted: true,
      };
      this.transact(() => {
        const at = isoDate(this.now);
        this.db
          .prepare(
            `UPDATE mail_conversations SET subject=?,marker=?,status='waiting_reply',
          agent_status='not_running',updated_at=? WHERE id=?`,
          )
          .run(`${sent.marker} 邮箱连接测试`, sent.marker, at, conversationId);
        this.db
          .prepare(
            `INSERT INTO mail_messages
          (id,conversation_id,direction,from_addr,to_addr,subject,body_text,occurred_at,
          delivery_status,message_id,in_reply_to,references_json,classification_json,uid_validity,imap_uid)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            conversationId,
            'outbound',
            PILOT_MAILBOX,
            PILOT_TEST_RECIPIENT,
            `${sent.marker} 邮箱连接测试`,
            TEST_BODY,
            at,
            'accepted',
            sent.messageId,
            null,
            '[]',
            null,
            null,
            null,
          );
        this.db
          .prepare(
            "UPDATE mail_operations SET state='succeeded',result_json=?,updated_at=? WHERE idempotency_key=?",
          )
          .run(JSON.stringify(result), at, key);
      });
      return result;
    } catch {
      this.markOperationUnknown(key, conversationId);
      throw new MailServiceError('MAIL_SEND_OUTCOME_UNKNOWN', 409);
    }
  }

  async sendReply(id, { draftRevision, confirmed, idempotencyKey } = {}) {
    if (confirmed !== true) throw new MailServiceError('MAIL_CONFIRMATION_REQUIRED', 400);
    const key = operationKey(idempotencyKey);
    return this.runSerial(() => this.performSendReply(id, { draftRevision, key }));
  }

  async performSendReply(id, { draftRevision, key }) {
    const transport = this.requireTransport();
    this.requireCursor();
    if (!Number.isSafeInteger(draftRevision) || draftRevision < 1) {
      throw new MailServiceError('MAIL_DRAFT_CONFLICT', 409);
    }
    const payloadHash = hash(['reply', id, draftRevision]);
    const prior = this.existingOperation(key, 'reply', payloadHash);
    if (prior) return prior;
    await this.performSync();
    const conversation = this.requireConversation(id);
    if (['unsubscribed', 'hard_bounce', 'send_unknown'].includes(conversation.status)) {
      throw new MailServiceError('MAIL_CONVERSATION_PAUSED', 409);
    }
    if (normalizeAddress(conversation.participant) !== RECIPIENT_LOWER) {
      throw new MailServiceError('MAIL_CONVERSATION_PAUSED', 409);
    }
    const draft = this.db.prepare('SELECT * FROM mail_drafts WHERE conversation_id=?').get(id);
    if (draft?.status === 'stale') {
      throw new MailServiceError('MAIL_DRAFT_STALE', 409);
    }
    if (!draft || draft.revision !== draftRevision || draft.status !== 'pending_review') {
      throw new MailServiceError('MAIL_DRAFT_NOT_READY', 409);
    }
    const priorMessages = this.db
      .prepare(
        'SELECT message_id,direction,subject FROM mail_messages WHERE conversation_id=? ORDER BY rowid',
      )
      .all(id);
    const latestIncoming = [...priorMessages]
      .reverse()
      .find((item) => item.direction === 'inbound');
    if (!messageId(latestIncoming?.message_id)) {
      throw new MailServiceError('MAIL_THREAD_NOT_READY', 409);
    }
    if (draft.reply_to_message_id !== latestIncoming.message_id) {
      throw new MailServiceError('MAIL_DRAFT_STALE', 409);
    }
    const references = priorMessages.map((item) => messageId(item.message_id)).filter(Boolean);
    const subject = latestIncoming.subject.toLowerCase().startsWith('re:')
      ? latestIncoming.subject
      : `Re: ${latestIncoming.subject}`;
    this.transact(() => {
      // Recheck the optimistic draft version before claiming this send.
      const fresh = this.db
        .prepare(
          'SELECT revision,status,reply_to_message_id FROM mail_drafts WHERE conversation_id=?',
        )
        .get(id);
      if (
        !fresh ||
        fresh.revision !== draftRevision ||
        fresh.status !== 'pending_review' ||
        fresh.reply_to_message_id !== latestIncoming.message_id
      ) {
        throw new MailServiceError('MAIL_DRAFT_CONFLICT', 409);
      }
      this.beginOperation({ key, kind: 'reply', payloadHash, conversationId: id });
      const at = isoDate(this.now);
      this.db
        .prepare("UPDATE mail_drafts SET status='sending',updated_at=? WHERE conversation_id=?")
        .run(at, id);
      this.db
        .prepare("UPDATE mail_conversations SET status='sending_reply',updated_at=? WHERE id=?")
        .run(at, id);
    });

    try {
      const sent = await transport.sendTestReply({
        to: PILOT_TEST_RECIPIENT,
        subject,
        text: draft.body_text,
        inReplyTo: latestIncoming.message_id,
        references,
      });
      if (
        sent?.accepted !== true ||
        normalizeAddress(sent.to) !== RECIPIENT_LOWER ||
        !messageId(sent.messageId)
      ) {
        throw new MailServiceError('MAIL_SEND_UNCONFIRMED', 503);
      }
      const result = {
        conversationId: id,
        messageId: sent.messageId,
        to: PILOT_TEST_RECIPIENT,
        accepted: true,
      };
      this.transact(() => {
        const at = isoDate(this.now);
        this.db
          .prepare(
            `INSERT INTO mail_messages
          (id,conversation_id,direction,from_addr,to_addr,subject,body_text,occurred_at,
          delivery_status,message_id,in_reply_to,references_json,classification_json,uid_validity,imap_uid)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            id,
            'outbound',
            PILOT_MAILBOX,
            PILOT_TEST_RECIPIENT,
            subject,
            draft.body_text,
            at,
            'accepted',
            sent.messageId,
            latestIncoming.message_id,
            JSON.stringify(references),
            null,
            null,
            null,
          );
        this.db
          .prepare("UPDATE mail_drafts SET status='sent',updated_at=? WHERE conversation_id=?")
          .run(at, id);
        this.db
          .prepare(
            "UPDATE mail_conversations SET status='replied',agent_status='not_running',unread=0,updated_at=? WHERE id=?",
          )
          .run(at, id);
        this.db
          .prepare(
            "UPDATE mail_operations SET state='succeeded',result_json=?,updated_at=? WHERE idempotency_key=?",
          )
          .run(JSON.stringify(result), at, key);
      });
      try {
        await this.performSync();
      } catch {
        // The SMTP result is already known and persisted; the next send still preflights sync.
      }
      return result;
    } catch {
      this.markOperationUnknown(key, id, true);
      try {
        await this.performSync();
      } catch {
        // Keep the send outcome fail-closed even when the follow-up IMAP check also fails.
      }
      throw new MailServiceError('MAIL_SEND_OUTCOME_UNKNOWN', 409);
    }
  }

  async sync() {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.runSerial(() => this.performSync()).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async performSync() {
    const transport = this.requireTransport();
    const cursor = this.requireCursor();
    const conversations = this.db
      .prepare('SELECT id,marker FROM mail_conversations WHERE marker IS NOT NULL')
      .all();
    if (!conversations.length) return { imported: 0, skipped: 0, cursor };
    const knownMessageIds = this.db
      .prepare('SELECT message_id FROM mail_messages WHERE message_id IS NOT NULL')
      .all()
      .map((row) => row.message_id);
    try {
      const batch = await transport.syncTestInbox({
        cursor,
        knownMessageIds,
        knownTestMarkers: conversations.map((item) => item.marker),
      });
      if (!batch?.cursor || !Array.isArray(batch.messages)) throw new Error('Invalid sync result');
      if (
        batch.cursor.uidValidity !== cursor.uidValidity ||
        !Number.isSafeInteger(batch.cursor.nextUid) ||
        batch.cursor.nextUid < cursor.nextUid
      ) {
        throw new MailServiceError('MAIL_SYNC_FAILED', 409);
      }
      let imported = 0;
      let skipped = batch.skipped?.length ?? 0;
      this.transact(() => {
        const freshCursor = this.requireCursor();
        if (
          freshCursor.uidValidity !== cursor.uidValidity ||
          freshCursor.nextUid !== cursor.nextUid
        ) {
          throw new MailServiceError('MAIL_SYNC_FAILED', 409);
        }
        for (const message of batch.messages) {
          if (
            normalizeAddress(message.from) !== RECIPIENT_LOWER ||
            normalizeAddress(message.to) !== ADDRESS_LOWER
          ) {
            skipped += 1;
            continue;
          }
          const relatedIds = [message.inReplyTo, ...(message.references ?? [])].filter(Boolean);
          const matching = conversations.find(
            (conversation) =>
              message.subject?.includes(conversation.marker) ||
              relatedIds.some((relatedId) =>
                this.db
                  .prepare(
                    `SELECT 1 FROM mail_messages
              WHERE conversation_id=? AND message_id=?`,
                  )
                  .get(conversation.id, relatedId),
              ),
          );
          if (
            !matching ||
            !Number.isSafeInteger(message.uid) ||
            message.uid < cursor.nextUid ||
            message.uid >= batch.cursor.nextUid
          ) {
            skipped += 1;
            continue;
          }
          const duplicate = this.db
            .prepare(
              'SELECT 1 FROM mail_messages WHERE (uid_validity=? AND imap_uid=?) OR (message_id IS NOT NULL AND message_id=?)',
            )
            .get(cursor.uidValidity, message.uid, message.messageId ?? '');
          if (duplicate) continue;
          const classification = ['reply', 'unsubscribe', 'bounce'].includes(
            message.classification?.kind,
          )
            ? message.classification
            : { kind: 'reply' };
          const at = isoDate(this.now);
          this.db
            .prepare(
              `INSERT INTO mail_messages
            (id,conversation_id,direction,from_addr,to_addr,subject,body_text,occurred_at,
            delivery_status,message_id,in_reply_to,references_json,classification_json,uid_validity,imap_uid)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              randomUUID(),
              matching.id,
              'inbound',
              PILOT_TEST_RECIPIENT,
              PILOT_MAILBOX,
              String(message.subject ?? ''),
              String(message.text ?? ''),
              message.receivedAt || at,
              'received',
              messageId(message.messageId),
              messageId(message.inReplyTo),
              JSON.stringify(message.references ?? []),
              JSON.stringify(classification),
              cursor.uidValidity,
              message.uid,
            );
          const suppressionStatus =
            classification.kind === 'unsubscribe'
              ? 'unsubscribed'
              : classification.kind === 'bounce' && classification.permanence === 'hard'
                ? 'hard_bounce'
                : null;
          const existingStatus = this.db
            .prepare('SELECT status FROM mail_conversations WHERE id=?')
            .get(matching.id)?.status;
          const stickyStatus = ['unsubscribed', 'hard_bounce'].includes(existingStatus)
            ? existingStatus
            : existingStatus === 'send_unknown' && !suppressionStatus
              ? existingStatus
              : null;
          const nextStatus = stickyStatus ?? suppressionStatus ?? 'awaiting_review';
          this.db
            .prepare(
              'UPDATE mail_conversations SET status=?,agent_status=?,unread=1,updated_at=? WHERE id=?',
            )
            .run(
              nextStatus,
              suppressionStatus || stickyStatus ? 'paused' : 'awaiting_human',
              at,
              matching.id,
            );
          if (suppressionStatus || stickyStatus) {
            this.db
              .prepare(
                "UPDATE mail_drafts SET status='blocked',updated_at=? WHERE conversation_id=? AND status='pending_review'",
              )
              .run(at, matching.id);
          } else if (messageId(message.messageId)) {
            this.db
              .prepare(
                `UPDATE mail_drafts SET status='stale',updated_at=?
                 WHERE conversation_id=? AND status='pending_review'
                 AND (reply_to_message_id IS NULL OR reply_to_message_id<>?)`,
              )
              .run(at, matching.id, message.messageId);
          }
          imported += 1;
        }
        this.setMeta('inbox_cursor', JSON.stringify(batch.cursor));
        this.setMeta('last_sync_at', isoDate(this.now));
        this.setMeta('imap_status', 'connected');
        this.setMeta('last_error', '');
      });
      return { imported, skipped, cursor: batch.cursor, hasMore: Boolean(batch.hasMore) };
    } catch (error) {
      this.setMeta('imap_status', 'error');
      this.setMeta('last_error', 'SYNC_FAILED');
      throw safeError(error, 'MAIL_SYNC_FAILED');
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db.close();
  }
}
