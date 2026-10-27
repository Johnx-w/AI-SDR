import { createHash, randomUUID } from 'node:crypto';
import { normalizeAttachments, normalizeReplyContent } from './mail-content.mjs';
import { renderMailboxSignature } from '../src/domain/mail-signature.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const address = (value) => {
  const normalized =
    typeof value === 'string' ? value.trim().toLowerCase() : value?.address?.trim().toLowerCase();
  return typeof normalized === 'string' &&
    /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(normalized)
    ? normalized
    : '';
};
const messageId = (value) =>
  typeof value === 'string' && /^<[^<>\s@]+@[^<>\s@]+>$/u.test(value) ? value : '';
const sourceId = (input) => input.replyToMessageId ?? input.sourceMessageId;
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const validInput = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fail(400, '回信请求格式不正确');
  return value;
};
const replySubject = (value) => {
  const clean =
    typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim() : '';
  return (/^re\s*:/iu.test(clean) ? clean : 'Re: ' + (clean || '（无主题）')).slice(0, 250);
};
const preSendFailures = new Set([
  'MAILBOX_PAUSED',
  'MAILBOX_NOT_CONFIGURED',
  'MAILBOX_NOT_VERIFIED',
  'MAILBOX_NOT_FOUND',
  'MAILBOX_INVALID',
  'MAILBOX_CREDENTIAL_FAILED',
  'MAILBOX_IDENTITY_CHANGED',
]);

/** Human replies own a separate durable send ledger; they never enter outreach scheduling. */
export class MailReplies {
  constructor({ db, mailboxes, conversations, recordCommunication, now = Date.now }) {
    Object.assign(this, { db, mailboxes, conversations, recordCommunication, now });
    this.pending = new Map();
    this.retainedResults = new Map();
    this.closed = false;
    db.exec(`
      CREATE TABLE IF NOT EXISTS mail_reply_drafts (
        conversation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT
      );
      CREATE TABLE IF NOT EXISTS mail_reply_operations (
        idempotency_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, draft_revision INTEGER NOT NULL,
        status TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_reply_operations_conversation
        ON mail_reply_operations(conversation_id);
    `);
    for (const row of db.prepare('SELECT * FROM mail_reply_operations').all()) {
      const operation = JSON.parse(row.data);
      let changed = false;
      if (operation.status === 'sending') {
        operation.status = 'unknown';
        operation.error = '服务在发送完成前中断，结果待核实，请勿重复发送';
        changed = true;
      }
      if (operation.archiveStatus === 'saving') {
        operation.archiveStatus = 'error';
        operation.archiveError = '已发送文件夹归档结果待核实';
        changed = true;
      }
      if (operation.recordStatus === 'recording') {
        operation.recordStatus = 'error';
        operation.recordError = '客户沟通记录登记结果待核实';
        changed = true;
      }
      if (changed) this.persist(operation);
    }
  }

  timestamp() {
    return new Date(this.now()).toISOString();
  }

  ensureOpen() {
    if (this.closed) throw fail(503, '人工回信服务已关闭');
  }

  boundMailbox(conversation) {
    const mailbox = this.mailboxes.list().find((item) => item.id === conversation.mailboxId);
    if (
      !mailbox ||
      !address(mailbox.email) ||
      address(mailbox.email) !== address(conversation.account)
    )
      throw fail(409, '会话的发件邮箱身份已变化，请重新核对');
    return mailbox;
  }

  context(detail, requestedId) {
    const { conversation, messages } = detail;
    const mailbox = this.boundMailbox(conversation);
    const selected = requestedId
      ? messages.find((item) => item.id === requestedId)
      : messages.filter((item) => item.direction === 'inbound').at(-1) || messages.at(-1);
    if (!selected || !['inbound', 'outbound'].includes(selected.direction))
      throw fail(409, '请选择同一会话内的一封实际邮件再回复');
    const own = address(mailbox.email);
    let to;
    if (selected.direction === 'inbound') {
      const preferred = Array.isArray(selected.replyTo) ? address(selected.replyTo[0]) : '';
      to = preferred && preferred !== own ? preferred : address(selected.from);
      if (to === own) to = '';
    } else {
      const values =
        Array.isArray(selected.toAddresses) && selected.toAddresses.length
          ? selected.toAddresses
          : typeof selected.to === 'string'
            ? selected.to.split(/[,;]/u)
            : [];
      const recipients = [
        ...new Set(values.map(address).filter((value) => value && value !== own)),
      ];
      if (recipients.length > 1)
        throw fail(409, '原邮件有多个收件人，请选择一封收件人明确的邮件回复');
      to = recipients[0];
    }
    if (!to) throw fail(409, '原邮件没有可回复的单一外部地址');
    const inReplyTo = messageId(selected.messageId) || undefined;
    const references = [
      ...new Set(
        [
          ...(Array.isArray(selected.references) ? selected.references.slice(-99) : []),
          selected.inReplyTo,
          inReplyTo,
        ]
          .map(messageId)
          .filter(Boolean),
      ),
    ].slice(-50);
    const sendReason = mailbox.paused
      ? '该邮箱已暂停发送'
      : !mailbox.configured
        ? '请先配置邮箱客户端授权码'
        : mailbox.smtpStatus !== 'connected'
          ? '请先验证该邮箱的 SMTP 连接'
          : null;
    return {
      mailboxId: mailbox.id,
      from: mailbox.email,
      signature: mailbox.signature || '',
      signatureHtml: renderMailboxSignature(mailbox).html,
      replyToMessageId: selected.id,
      sourceMessageId: selected.id,
      to,
      subject: replySubject(selected.subject),
      inReplyTo,
      references,
      canReply: true,
      canSend: !sendReason,
      reason: sendReason,
    };
  }

  draftRow(id) {
    return this.db
      .prepare('SELECT revision,data FROM mail_reply_drafts WHERE conversation_id=?')
      .get(id);
  }

  draft(id) {
    this.ensureOpen();
    this.conversations.detail(id);
    const row = this.draftRow(id);
    return row?.data ? JSON.parse(row.data) : null;
  }

  saveDraft(id, input = {}) {
    this.ensureOpen();
    validInput(input);
    const detail = this.conversations.detail(id);
    const row = this.draftRow(id);
    const previous = row?.data ? JSON.parse(row.data) : null;
    const expected = input.expectedRevision ?? input.revision ?? 0;
    if (!revision(expected) || expected !== (previous?.revision || 0))
      throw fail(409, '回信草稿已变化，请重新读取后保存');
    const context = this.context(detail, sourceId(input) || previous?.replyToMessageId);
    const content = normalizeReplyContent(input, { allowEmpty: true });
    const attachments = normalizeAttachments(input.attachments || []);
    const draft = {
      conversationId: id,
      replyToMessageId: context.replyToMessageId,
      sourceMessageId: context.replyToMessageId,
      revision: (row?.revision || 0) + 1,
      subject: context.subject,
      ...content,
      attachments,
      updatedAt: this.timestamp(),
    };
    this.db
      .prepare(
        `INSERT INTO mail_reply_drafts VALUES(?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET revision=excluded.revision,data=excluded.data`,
      )
      .run(id, draft.revision, JSON.stringify(draft));
    return draft;
  }

  deleteDraft(id, input = {}) {
    this.ensureOpen();
    validInput(input);
    this.conversations.detail(id);
    const expected = input.expectedRevision ?? input.revision;
    if (expected === undefined) throw fail(400, '删除草稿需要当前修订号');
    const row = this.draftRow(id);
    if (!revision(expected) || expected !== (row?.data ? row.revision : 0))
      throw fail(409, '回信草稿已变化，请重新读取后删除');
    this.db.prepare('UPDATE mail_reply_drafts SET data=NULL WHERE conversation_id=?').run(id);
    return { deleted: !!row?.data };
  }

  operations(id) {
    return this.db
      .prepare('SELECT data FROM mail_reply_operations WHERE conversation_id=? ORDER BY rowid DESC')
      .all(id)
      .map((row) => {
        const stored = JSON.parse(row.data);
        return this.retainedResults.get(stored.idempotencyKey) || stored;
      });
  }

  publicReply(operation) {
    const { payload, payloadHash, ...reply } = operation;
    return reply;
  }

  detailExtras(id) {
    this.ensureOpen();
    const detail = this.conversations.detail(id);
    const draft = this.draft(id);
    let replyContext;
    try {
      replyContext = this.context(detail, draft?.replyToMessageId);
    } catch (error) {
      replyContext = {
        mailboxId: detail.conversation.mailboxId,
        from: detail.conversation.account,
        replyToMessageId: draft?.replyToMessageId || null,
        canReply: false,
        reason: error.status ? error.message : '无法确定回复地址，请重新核对原邮件',
      };
    }
    return {
      draft,
      replies: this.operations(id).map((operation) => this.publicReply(operation)),
      replyContext,
    };
  }

  request(id, input) {
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[\w-]{8,128}$/u.test(key))
      throw fail(400, '回信发送需要有效的幂等编号');
    const requestedId = sourceId(input);
    if (
      typeof requestedId !== 'string' ||
      !requestedId ||
      !revision(input.draftRevision) ||
      input.draftRevision < 1
    )
      throw fail(400, '请选择原邮件并保存当前回信草稿后再发送');
    const descriptor = {
      conversationId: id,
      replyToMessageId: requestedId,
      draftRevision: input.draftRevision,
    };
    if (Object.hasOwn(input, 'bodyHtml') || Object.hasOwn(input, 'bodyText'))
      descriptor.content = normalizeReplyContent(input, { allowEmpty: true });
    if (Object.hasOwn(input, 'attachments'))
      descriptor.attachments = normalizeAttachments(input.attachments);
    return { key, requestedId, descriptor, payloadHash: digest(descriptor) };
  }

  persist(operation) {
    this.db
      .prepare(
        `INSERT INTO mail_reply_operations VALUES(?,?,?,?,?,?)
      ON CONFLICT(idempotency_key) DO UPDATE SET status=excluded.status,data=excluded.data`,
      )
      .run(
        operation.idempotencyKey,
        operation.conversationId,
        operation.payloadHash,
        operation.draftRevision,
        operation.status,
        JSON.stringify(operation),
      );
  }

  persistAttemptResult(operation) {
    try {
      this.persist(operation);
      this.retainedResults.delete(operation.idempotencyKey);
    } catch {
      // The pre-SMTP sending ledger remains a restart-safe unknown outcome. Keep
      // the actual acknowledgement available for retries in this process too.
      operation.persistenceError = '发送结果已取得，本地发送记录保存失败，请核对邮箱';
      operation.recordError ||= operation.persistenceError;
      this.retainedResults.set(operation.idempotencyKey, operation);
    }
  }

  result(operation) {
    try {
      return {
        reply: this.publicReply(operation),
        ...this.conversations.detail(operation.conversationId),
      };
    } catch (error) {
      if (!['accepted', 'unknown', 'failed'].includes(operation.status)) throw error;
      return {
        reply: {
          ...this.publicReply(operation),
          recordError:
            operation.recordError || '发送结果已保存，会话详情暂时无法读取，请刷新后核对',
        },
      };
    }
  }

  reply(id, input = {}) {
    this.ensureOpen();
    validInput(input);
    const request = this.request(id, input);
    const retained = this.retainedResults.get(request.key);
    const row = retained
      ? null
      : this.db
          .prepare('SELECT data FROM mail_reply_operations WHERE idempotency_key=?')
          .get(request.key);
    if (retained || row) {
      const prior = retained || JSON.parse(row.data);
      if (prior.payloadHash !== request.payloadHash) throw fail(409, '该发送编号已用于另一封回信');
      return this.pending.get(request.key) || Promise.resolve(this.result(prior));
    }
    const detail = this.conversations.detail(id);
    const draft = this.draft(id);
    if (
      !draft ||
      draft.revision !== input.draftRevision ||
      draft.replyToMessageId !== request.requestedId
    )
      throw fail(409, '回信草稿版本或原邮件已变化，请重新保存后发送');
    const context = this.context(detail, request.requestedId);
    const content = normalizeReplyContent(draft);
    const attachments = normalizeAttachments(draft.attachments);
    if (
      (request.descriptor.content && digest(request.descriptor.content) !== digest(content)) ||
      (request.descriptor.attachments &&
        digest(request.descriptor.attachments) !== digest(attachments))
    )
      throw fail(409, '发送内容与已保存草稿不一致，请先保存当前内容');
    const payload = {
      expectedAccount: detail.conversation.account,
      to: context.to,
      subject: context.subject,
      text: content.bodyText,
      html: content.bodyHtml,
      attachments,
      messageId: `<shadeflow.reply.${randomUUID()}@${address(context.from).split('@')[1]}>`,
      inReplyTo: context.inReplyTo,
      references: context.references,
    };
    const fingerprint = digest({
      mailboxId: context.mailboxId,
      replyToMessageId: context.replyToMessageId,
      ...payload,
      messageId: undefined,
      attachments: attachments.map(({ name, contentType, contentBase64 }) => ({
        name,
        contentType,
        contentBase64,
      })),
    });
    if (
      this.operations(id).some(
        (operation) =>
          ['sending', 'unknown', 'accepted'].includes(operation.status) &&
          (operation.draftRevision === draft.revision || operation.fingerprint === fingerprint),
      )
    )
      throw fail(409, '这封回信已提交、仍在发送或结果待核实，请勿重复发送');
    const operation = {
      id: 'reply_' + randomUUID(),
      idempotencyKey: request.key,
      payloadHash: request.payloadHash,
      conversationId: id,
      mailboxId: context.mailboxId,
      replyToMessageId: context.replyToMessageId,
      draftRevision: draft.revision,
      from: context.from,
      to: context.to,
      subject: payload.subject,
      messageId: payload.messageId,
      status: 'sending',
      archiveStatus: 'not_requested',
      recordStatus: 'not_requested',
      error: null,
      recordError: null,
      fingerprint,
      payload,
      createdAt: this.timestamp(),
      sentAt: null,
    };
    this.persist(operation);
    const pending = this.send(operation).finally(() => this.pending.delete(request.key));
    this.pending.set(request.key, pending);
    return pending;
  }

  async send(operation) {
    let result;
    try {
      result = await this.mailboxes.send(operation.mailboxId, operation.payload);
      const matches = (values) =>
        Array.isArray(values) && values.some((value) => address(value) === address(operation.to));
      const accepted = result?.accepted === true || matches(result?.accepted);
      const rejected = matches(result?.rejected);
      if (accepted && !rejected) {
        operation.status = 'accepted';
        operation.sentAt = this.timestamp();
      } else if (rejected && !accepted) {
        operation.status = 'failed';
        operation.error = '邮箱服务商拒绝此收件人，请核对地址';
      } else {
        operation.status = 'unknown';
        operation.error = '无法确认发送结果，请在邮箱中核对，勿重复发送';
      }
    } catch (error) {
      operation.status = preSendFailures.has(error?.code) ? 'failed' : 'unknown';
      operation.error =
        operation.status === 'failed'
          ? '邮箱当前不能发信，请核对连接、暂停状态及发件身份'
          : '发送结果待核实，请在邮箱中核对，勿重复发送';
    }
    this.persistAttemptResult(operation);
    if (operation.status !== 'accepted') return this.result(operation);

    try {
      this.db
        .prepare('UPDATE mail_reply_drafts SET data=NULL WHERE conversation_id=? AND revision=?')
        .run(operation.conversationId, operation.draftRevision);
    } catch {
      operation.draftError = '回信已被服务商接受，草稿清理失败，请刷新后核对';
      operation.recordError = operation.draftError;
    }
    try {
      const detail = this.conversations.detail(operation.conversationId);
      const mailbox = this.boundMailbox(detail.conversation);
      this.conversations.putMessage(mailbox, {
        threadId: operation.conversationId,
        identity: operation.id,
        direction: 'outbound',
        from: operation.from,
        to: operation.to,
        toAddresses: [operation.to],
        subject: operation.payload.subject,
        bodyText: operation.payload.text,
        bodyHtml: operation.payload.html,
        attachments: operation.payload.attachments,
        occurredAt: operation.sentAt,
        deliveryStatus: 'accepted',
        source: 'manual',
        messageId: operation.messageId,
        inReplyTo: operation.payload.inReplyTo,
        references: operation.payload.references,
        unread: false,
      });
      operation.messageRecorded = true;
    } catch {
      operation.recordError = '回信已被服务商接受，本地会话记录待核对';
    }
    this.persistAttemptResult(operation);
    if (operation.messageRecorded && typeof this.recordCommunication === 'function') {
      operation.recordStatus = 'recording';
      this.persistAttemptResult(operation);
      try {
        await this.recordCommunication(this.conversations.detail(operation.conversationId));
        operation.recordStatus = 'recorded';
      } catch {
        operation.recordStatus = 'error';
        operation.recordError = '回信已被服务商接受，客户沟通记录登记失败，请核对';
      }
      this.persistAttemptResult(operation);
    }
    if (typeof this.mailboxes.saveSent === 'function') {
      operation.archiveStatus = 'saving';
      this.persistAttemptResult(operation);
      try {
        await this.mailboxes.saveSent(operation.mailboxId, {
          ...operation.payload,
          sentAt: operation.sentAt,
        });
        operation.archiveStatus = 'saved';
      } catch {
        operation.archiveStatus = 'error';
        operation.archiveError = '回信已被服务商接受，已发送文件夹归档失败';
      }
      this.persistAttemptResult(operation);
    }
    return this.result(operation);
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
  }
}
