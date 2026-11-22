import { createHash } from 'node:crypto';
import { customerReplyText } from './communication-rounds.mjs';
import { renderMailboxSignature, signaturePlainTextHtml } from '../src/domain/mail-signature.mjs';

const fail = (message) =>
  Object.assign(new Error(message), { status: 409, code: 'REPLY_POLICY_CHANGED' });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lower = (value) => String(value || '').toLowerCase();
const active = "('pending','review','attention','human_draft')";
const locked = "('sending','accepted','unknown')";
const timestamp = (m) => Date.parse(m.receivedAt || m.occurredAt);

// The IMAP cursor and the per-message work item commit in the same SQLite transaction.
export class MailReception {
  constructor(service) {
    this.s = service;
    this.db = service.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS mail_reception (
     source_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, mailbox_id TEXT NOT NULL,
     state TEXT NOT NULL, received_at INTEGER NOT NULL, next_at INTEGER NOT NULL, info TEXT NOT NULL);
     CREATE INDEX IF NOT EXISTS mail_reception_due ON mail_reception(state,next_at);
     CREATE INDEX IF NOT EXISTS mail_reception_queue ON mail_reception(state,received_at DESC);
     CREATE INDEX IF NOT EXISTS mail_reception_review_order ON mail_reception(received_at DESC,source_id) WHERE state IN ('review','attention','uncertain');
     CREATE INDEX IF NOT EXISTS mail_reception_thread ON mail_reception(thread_id,state);
     CREATE INDEX IF NOT EXISTS mail_reply_source ON mail_reply_operations(conversation_id,json_extract(data,'$.replyToMessageId'),status);
     CREATE INDEX IF NOT EXISTS mail_by_external_id ON mailbox_thread_messages(account_key,json_extract(data,'$.messageId'));
     CREATE INDEX IF NOT EXISTS outreach_message_id ON outreach_deliveries(json_extract(data,'$.messageId'));
     CREATE INDEX IF NOT EXISTS followup_message_id ON outreach_followups(json_extract(data,'$.messageId'));`);
    for (const [status, state, reason] of [
      ['accepted', 'done', '回复已被服务商接受'],
      ['unknown', 'uncertain', '回信提交结果待核实'],
    ]) {
      this.db
        .prepare(
          `UPDATE mail_reception SET state=?,info=json_set(info,'$.reason',?) WHERE state IN ${active} AND EXISTS(
        SELECT 1 FROM mail_reply_operations o WHERE o.conversation_id=mail_reception.thread_id AND json_extract(o.data,'$.replyToMessageId')=mail_reception.source_id AND o.status=?)`,
        )
        .run(state, reason, status);
    }
  }
  row(source) {
    return this.db.prepare('SELECT * FROM mail_reception WHERE source_id=?').get(source);
  }
  finish(id, state, reason, nextAt = 0) {
    this.db
      .prepare(
        `UPDATE mail_reception SET state=?,next_at=?,info=json_set(info,'$.reason',?) WHERE source_id=?`,
      )
      .run(state, nextAt, reason, id);
  }
  operation(thread, source, except = '') {
    return this.db
      .prepare(
        `SELECT status FROM mail_reply_operations WHERE conversation_id=? AND json_extract(data,'$.replyToMessageId')=? AND status IN ${locked} AND idempotency_key<>? LIMIT 1`,
      )
      .get(thread, source, except);
  }
  isOwnSequenceMail(messageId) {
    return (
      messageId &&
      this.db
        .prepare(
          `SELECT 1 FROM outreach_deliveries WHERE json_extract(data,'$.messageId')=?
     UNION ALL SELECT 1 FROM outreach_followups WHERE json_extract(data,'$.messageId')=? LIMIT 1`,
        )
        .get(messageId, messageId)
    );
  }
  observe(box, thread, m, lookup) {
    if (!['imap', 'manual', 'automatic'].includes(m.source)) return;
    const inbound = m.direction === 'inbound',
      kind = m.classification;
    if (inbound && kind === 'auto_reply') return;
    if (!inbound && this.isOwnSequenceMail(m.messageId)) return;
    const at = timestamp(m);
    const peer = lower(inbound ? m.from : m.toAddresses?.[0] || m.to);
    let customerId =
      thread.customerId &&
      this.db
        .prepare(
          `SELECT 1 FROM mailbox_thread_messages
     WHERE thread_id=? AND json_extract(data,'$.direction')='outbound' AND lower(json_extract(data,'$.to'))=? LIMIT 1`,
        )
        .get(thread.id, peer)
        ? thread.customerId
        : '';
    if (
      !customerId &&
      (box.replyEnabledAt ||
        kind === 'unsubscribe' ||
        this.db.prepare("SELECT 1 FROM outreach_followups WHERE state='pending' LIMIT 1").get())
    ) {
      try {
        customerId = (lookup || this.s.conversations.customerLookup())(peer)?.id || '';
      } catch {}
    }
    if (kind === 'unsubscribe')
      this.s.suppress({ customerId, email: peer, reason: '客户邮件退订' });
    if (kind !== 'hard_bounce')
      this.s.followUps.stopFor({
        mailboxId: box.id,
        email: peer,
        customerId,
        at: new Date(at).toISOString(),
        reason: !inbound
          ? '业务员已回复，结束本轮追信'
          : kind === 'unverified'
            ? '收到待核实回执，停止本轮自动追信'
            : '收到客户来信，结束本轮追信',
      });
    if (kind === 'hard_bounce' || kind === 'auto_reply') return;
    this.db
      .prepare(
        `UPDATE mail_reception SET state='cancelled',info=json_set(info,'$.reason',?)
      WHERE (thread_id=? OR (?=1 AND mailbox_id=? AND json_extract(info,'$.from')=?)) AND state IN ${active} AND received_at<=?`,
      )
      .run(
        inbound ? '收到更新的来信' : '业务员已回复',
        thread.id,
        Number(!inbound || kind === 'unsubscribe'),
        box.id,
        peer,
        at,
      );
    if (
      !inbound ||
      kind !== 'normal' ||
      !box.replyEnabledAt ||
      box.replyMode === 'manual' ||
      at < Date.parse(box.replyEnabledAt)
    )
      return;
    if (!customerId) return;
    this.db.prepare('INSERT OR IGNORE INTO mail_reception VALUES(?,?,?,?,?,?,?)').run(
      m.id,
      thread.id,
      box.id,
      'pending',
      at,
      0,
      JSON.stringify({
        from: peer,
        subject: m.subject,
        account: box.email,
        customerId,
        owner: box.owner || box.displayName || '',
        reason: '等待处理',
        scope: this.s.getScope(),
      }),
    );
  }
  list({ page = 1 } = {}) {
    page = Number(page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw fail('审核列表页码无效');
    const where = "WHERE state IN ('review','attention','uncertain')";
    const { total } = this.db
      .prepare('SELECT count(*) AS total FROM mail_reception ' + where)
      .get();
    const items = this.db
      .prepare(
        `SELECT source_id,thread_id,state,received_at,info FROM mail_reception INDEXED BY mail_reception_review_order ${where} ORDER BY received_at DESC,source_id LIMIT 20 OFFSET ?`,
      )
      .all((page - 1) * 20)
      .map((r) => ({
        sourceId: r.source_id,
        threadId: r.thread_id,
        state: r.state,
        receivedAt: new Date(r.received_at).toISOString(),
        ...JSON.parse(r.info),
      }));
    return { items, total, page, pageSize: 20 };
  }
  suppressed(thread, peer) {
    return !!this.db
      .prepare('SELECT 1 FROM outreach_suppression WHERE identity IN (?,?)')
      .get('company:' + (thread.customerId || ''), 'email:' + lower(peer));
  }
  stopped(thread, peer, humanDraft) {
    const customerId = thread.customerId || '';
    const data = this.s.customerMailState(customerId);
    if (data.context?.doNotContact || this.suppressed(thread, peer)) return '客户已退订或停止联系';
    if (lower(data.context?.fixedEmail) !== lower(thread.account))
      return '客户固定邮箱尚未核实或与本会话不符';
    const conversations = data.conversations.filter(
      (c) => lower(c.account) === lower(thread.account),
    );
    if (
      conversations.some(
        (c) => c.status === 'closed' || (!humanDraft && c.ownership === 'human'),
      ) ||
      (!humanDraft && data.demands.some((d) => d.ownership === 'human'))
    )
      return '客户已由业务员接管或关闭会话';
    return '';
  }
  inspect(row, except = '', humanDraft = false) {
    const detail = this.s.conversations.detail(row.thread_id);
    const box = this.s.mailboxes.get(row.mailbox_id);
    const m = detail.messages.find((m) => m.id === row.source_id);
    const info = JSON.parse(row.info);
    if (
      !m ||
      info.scope !== this.s.getScope() ||
      detail.conversation.customerId !== info.customerId ||
      lower(info.account) !== lower(box.email) ||
      m.classification !== 'normal' ||
      !box.replyEnabledAt ||
      timestamp(m) < Date.parse(box.replyEnabledAt) ||
      box.replyMode === 'manual'
    )
      throw fail('来信归属或接待授权已变化');
    const stop = this.stopped(detail.conversation, m.from, humanDraft);
    if (stop) {
      const error = fail(stop);
      error.needsReview = stop === '客户固定邮箱尚未核实或与本会话不符';
      throw error;
    }
    if (this.operation(row.thread_id, m.id, except))
      throw fail('本封来信已有回信提交，请核对原邮件');
    if (
      detail.messages.some(
        (other) =>
          other.id !== m.id &&
          timestamp(other) >= timestamp(m) &&
          ((other.direction === 'outbound' && !this.isOwnSequenceMail(other.messageId)) ||
            (other.direction === 'inbound' &&
              other.classification !== 'auto_reply' &&
              timestamp(other) > timestamp(m))),
      )
    )
      throw fail('会话已有更新的来信或发信');
    return { box, detail, m };
  }
  answer(row, inspected) {
    const { box, m } = inspected;
    const question = customerReplyText({ body: m.bodyText });
    const result = this.s.answerQuestion(box, question, this.s.now());
    const direct =
      m.toAddresses?.length === 1 &&
      lower(m.toAddresses[0]) === lower(box.email) &&
      !m.cc?.length &&
      (!m.replyTo?.length || (m.replyTo.length === 1 && lower(m.replyTo[0]) === lower(m.from)));
    const simple = !!m.messageId && direct && !m.attachments?.length && !m.bodyUnavailable;
    const signature = renderMailboxSignature(box);
    const bodyText = [result.body, signature.text].filter(Boolean).join('\n\n');
    const bodyHtml =
      signaturePlainTextHtml(result.body) + (signature.html ? '<br><br>' + signature.html : '');
    const stamp = hash([
      box.email,
      box.website,
      box.replyMode,
      box.replyEnabledAt,
      box.knowledgeProductIds,
      box.owner,
      bodyText,
      bodyHtml,
      result.sources,
      simple,
    ]);
    return {
      bodyText,
      bodyHtml,
      provenance: {
        sourceId: row.source_id,
        stamp,
        sources: result.sources,
        automatic: simple && result.automatic && !!signature.text,
        reason: !simple
          ? '请核对收件人、附件或原信'
          : !signature.text
            ? '请补齐此邮箱的签名'
            : result.reason,
      },
    };
  }
  guardReply({ id, source, draft, origin, key }) {
    const thread = this.s.conversations.detail(id).conversation;
    if (
      this.suppressed(thread, thread.participant) ||
      (thread.customerId && this.s.customerMailState(thread.customerId).context?.doNotContact)
    )
      throw fail('客户已退订或停止联系');
    const row = this.row(source);
    if (!row) return;
    const prior = this.operation(id, source, key);
    if (
      prior &&
      (draft.provenance ||
        origin === 'automatic' ||
        this.db
          .prepare(
            `SELECT 1 FROM mail_reply_operations WHERE conversation_id=? AND json_extract(data,'$.replyToMessageId')=? AND json_extract(data,'$.origin')='automatic' AND status IN ${locked}`,
          )
          .get(id, source))
    )
      throw fail('客户此封来信已有回信提交');
    if (!draft.provenance) return;
    const humanDraft = row.state === 'human_draft' && origin === 'manual' && draft.edited === true;
    if (!humanDraft && !['pending', 'review'].includes(row.state))
      throw fail('接待状态已变化，请重新打开会话');
    const inspected = this.inspect(row, key, humanDraft);
    if (this.answer(row, inspected).provenance.stamp !== draft.provenance.stamp)
      throw fail('资料或邮箱策略已更新，请重新生成草稿');
    const fresh = this.s.replies.draft(id);
    if (
      !fresh ||
      fresh.revision !== draft.revision ||
      this.s.isMaintaining() ||
      inspected.box.paused
    )
      throw fail('草稿、服务或发件状态已变化');
    if (
      origin === 'automatic' &&
      (inspected.box.replyMode !== 'auto' || !draft.provenance.automatic || draft.edited)
    )
      throw fail('本封回信需要业务员审核');
    if (origin === 'automatic' && !this.s.replyCapacity(inspected.box, 0, key))
      throw fail('邮箱发送间隔或当日额度已变化');
  }
  async verifyInbox(box) {
    await this.s.conversations.sync({ mailboxId: box.id });
    const state = this.s.conversations.syncState(box);
    if (state.error || state.hasMore || state.folderCoverage?.sent === false || !state.lastSyncAt)
      throw fail('最新邮箱尚未完整同步，请稍后再试');
  }
  discardDraft(id, input) {
    return this.s.transaction(() => {
      const draft = this.s.replies.draft(id);
      const result = this.s.replies.deleteDraft(id, input);
      if (draft?.provenance)
        this.db
          .prepare(
            `UPDATE mail_reception SET state='cancelled',info=json_set(info,'$.reason','业务员已删除草稿') WHERE source_id=? AND state IN ${active}`,
          )
          .run(draft.replyToMessageId);
      return result;
    });
  }
  async prepare(source, { regenerate = false } = {}) {
    const row = this.row(source);
    if (
      !row ||
      !(regenerate ? ['pending', 'attention', 'review'] : ['pending']).includes(row.state)
    )
      return;
    const op = this.operation(row.thread_id, source);
    if (op) {
      this.finish(source, op.status === 'accepted' ? 'done' : 'uncertain', '回信已提交');
      return;
    }
    let inspected;
    try {
      if (this.s.conversations.syncState(this.s.mailboxes.get(row.mailbox_id)).syncing) return;
      inspected = this.inspect(row);
    } catch (e) {
      this.finish(
        source,
        e.needsReview || !e.status ? 'attention' : 'cancelled',
        e.status ? e.message : '归属待核对',
      );
      return;
    }
    const { box, m } = inspected;
    let draft = this.s.replies.draft(row.thread_id);
    if (
      draft &&
      (!draft.provenance || draft.edited) &&
      !(regenerate && draft.replyToMessageId === source)
    ) {
      this.finish(source, 'attention', '会话中有业务员草稿，请打开会话核对');
      return;
    }
    const answer = this.answer(row, inspected);
    if (!draft || draft.provenance?.stamp !== answer.provenance.stamp || regenerate)
      draft = this.s.replies.saveDraft(
        row.thread_id,
        { ...answer, replyToMessageId: m.id, expectedRevision: draft?.revision || 0 },
        answer.provenance,
      );
    if (regenerate || box.replyMode !== 'auto' || !answer.provenance.automatic || box.paused) {
      this.finish(source, 'review', answer.provenance.reason);
      return;
    }
    if (!this.s.replyCapacity(box)) {
      this.finish(source, 'pending', '等待邮箱发送间隔或当日额度', this.s.now() + 60000);
      return;
    }
    try {
      await this.verifyInbox(box);
    } catch {
      if (this.row(source)?.state === 'pending')
        this.finish(source, 'pending', '等待完整同步最新邮件', this.s.now() + 60000);
      return;
    }
    if (this.row(source)?.state !== 'pending') return;
    await this.s.replies.reply(
      row.thread_id,
      {
        replyToMessageId: m.id,
        draftRevision: draft.revision,
        idempotencyKey: 'auto-' + hash([source, draft.revision]),
      },
      'automatic',
    );
  }
  settled(operation) {
    if (!this.row(operation.replyToMessageId)) return;
    const state = {
      accepted: 'done',
      unknown: 'uncertain',
      failed:
        this.row(operation.replyToMessageId)?.state === 'cancelled' ? 'cancelled' : 'attention',
    }[operation.status];
    if (state)
      this.finish(operation.replyToMessageId, state, operation.error || '已由邮箱服务商接受');
  }
  detail(thread) {
    const item = this.db
      .prepare(
        `SELECT source_id,state,info FROM mail_reception WHERE thread_id=? ORDER BY received_at DESC,rowid DESC LIMIT 1`,
      )
      .get(thread.id);
    const customer = thread.customerId ? this.s.customerMailState(thread.customerId) : null;
    const related =
      customer?.conversations.filter((c) => lower(c.account) === lower(thread.account)) || [];
    return {
      sourceId: item?.source_id,
      state: item?.state,
      reason: item ? JSON.parse(item.info).reason : '',
      owner:
        related.find((c) => c.ownership === 'human')?.owner ||
        this.s.conversations.selected(thread.mailboxId)[0]?.owner ||
        '',
      human: related.some((c) => c.ownership === 'human'),
      stopped: !!customer?.context?.doNotContact || this.suppressed(thread, thread.participant),
    };
  }
  async ownership(id, action) {
    if (!['takeover', 'resume'].includes(action) || !this.s.setMailOwnership)
      throw fail('无法更改此会话归属');
    const detail = this.s.conversations.detail(id),
      thread = detail.conversation;
    if (!thread.customerId) throw fail('请先关联客户');
    if (
      action === 'resume' &&
      (this.s.customerMailState(thread.customerId).context?.doNotContact ||
        this.suppressed(thread, thread.participant))
    )
      throw fail('客户已退订或停止联系');
    const box = this.s.mailboxes.get(thread.mailboxId);
    await this.s.setMailOwnership(
      detail,
      action === 'takeover' ? 'human' : 'auto',
      box.owner || box.displayName,
    );
    if (action === 'takeover') {
      const draft = this.s.replies.draft(id);
      if (draft?.provenance && !draft.edited)
        this.s.replies.deleteDraft(id, { revision: draft.revision });
      this.s.followUps.stopFor({
        mailboxId: box.id,
        customerId: thread.customerId,
        email: thread.participant,
        at: new Date(this.s.now()).toISOString(),
        reason: '业务员已接管',
      });
      this.db
        .prepare(
          `UPDATE mail_reception SET state=CASE WHEN source_id=? THEN 'human_draft' ELSE 'cancelled' END,
            info=json_set(info,'$.reason','业务员已接管') WHERE mailbox_id=? AND json_extract(info,'$.customerId')=? AND state IN ${active}`,
        )
        .run(
          draft?.provenance && draft.edited ? draft.replyToMessageId : '',
          box.id,
          thread.customerId,
        );
    }
    return this.detail(thread);
  }
  async tick() {
    const rows = this.db
      .prepare(
        "SELECT source_id FROM mail_reception WHERE state='pending' AND next_at<=? ORDER BY next_at,received_at LIMIT 12",
      )
      .all(this.s.now());
    for (const { source_id: id } of rows) {
      if (this.s.closed || this.s.isMaintaining()) return;
      try {
        await this.prepare(id);
      } catch (err) {
        if (this.row(id)?.state === 'pending')
          this.finish(id, 'attention', err.status ? err.message : '生成或同步失败，请重新核对');
      }
    }
  }
}
