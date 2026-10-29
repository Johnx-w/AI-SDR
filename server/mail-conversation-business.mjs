import { createHash } from 'node:crypto';

const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);
const fail = (message) => Object.assign(new Error(message), { status: 409 });

/** Records confirmed mailbox facts without drafting demands or taking ownership. */
export async function recordMailConversation({ store, conversation, messages }) {
  const customerId = conversation.customerId;
  if (!customerId) return { recorded: 0 };
  const account = conversation.account.toLowerCase();
  const eligible = messages.filter(
    (message) =>
      (message.direction === 'inbound' && message.deliveryStatus === 'received') ||
      (message.direction === 'outbound' && ['accepted', 'sent'].includes(message.deliveryStatus)),
  );
  if (!eligible.length) return { recorded: 0 };
  await store.actualCustomer(customerId);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const context = store.context(customerId);
    if (context.fixedEmail && context.fixedEmail.toLowerCase() !== account)
      throw fail('客户固定邮箱与邮件会话不一致，请核对归属');
    const all = store.all('messages');
    const priorFor = (message) =>
      all.filter(
        (item) =>
          item.channel === 'email' &&
          item.account?.toLowerCase() === account &&
          (message.messageId
            ? item.externalId === message.messageId
            : item.mailboxMessageId === message.id),
      );
    const linked = [
      ...new Set(
        eligible.flatMap((message) => priorFor(message).map((item) => item.conversationId)),
      ),
    ];
    if (linked.length > 1) throw fail('邮件对应多个客户业务会话，请先核对');
    const mappedId = 'conv_mail_' + digest([customerId, account, conversation.id]);
    let target = linked.length
      ? store.get('conversations', linked[0])
      : store.get('conversations', mappedId);
    if (!target) {
      const candidates = store
        .all('conversations')
        .filter(
          (item) =>
            item.customerId === customerId &&
            item.channel === 'email' &&
            item.account?.toLowerCase() === account &&
            item.participant?.toLowerCase() === conversation.participant.toLowerCase() &&
            item.status === 'active',
        );
      if (candidates.length > 1) throw fail('客户存在多个可用沟通会话，请先核对');
      target = candidates[0];
    }
    const timestamp = store.timestamp();
    if (target && (target.customerId !== customerId || target.account.toLowerCase() !== account))
      throw fail('既有沟通记录的客户或邮箱归属不一致');
    if (!target) {
      target = {
        id: mappedId,
        customerId,
        title: conversation.subject || '邮件沟通',
        channel: 'email',
        account,
        participant: conversation.participant,
        ownership: 'auto',
        owner: '',
        status: 'active',
        version: 1,
        audit: [{ action: 'mailbox_imported', at: timestamp, mailboxThreadId: conversation.id }],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      store.put('conversations', target);
    }
    let recorded = 0;
    for (const message of eligible) {
      const duplicate = priorFor(message);
      if (duplicate.length > 1) throw fail('邮件消息编号重复，请核对业务记录');
      const prior = duplicate[0];
      if (prior) {
        if (
          prior.customerId !== customerId ||
          prior.conversationId !== target.id ||
          prior.from.toLowerCase() !== message.from.toLowerCase() ||
          prior.body !== (message.bodyText || '（邮件正文为空）')
        )
          throw fail('相同邮件编号的原文或客户归属不同，未覆盖原记录');
        if (prior.deliveryStatus === 'accepted' && message.deliveryStatus === 'sent') {
          store.put('messages', {
            ...prior,
            deliveryStatus: 'sent',
            notes: '已在原邮箱已发件箱核实副本；不代表客户已经收件或阅读。',
            version: prior.version + 1,
            updatedAt: timestamp,
            audit: [...(prior.audit || []), { action: 'mailbox_sent_confirmed', at: timestamp }],
          });
        }
        continue;
      }
      const record = {
        id: 'msg_mail_' + digest([account, message.id]),
        customerId,
        conversationId: target.id,
        mailboxMessageId: message.id,
        channel: 'email',
        direction: message.direction,
        subject: message.subject,
        body: message.bodyText || '（邮件正文为空）',
        from: message.from,
        to: message.to,
        account,
        occurredAt: message.occurredAt,
        deliveryStatus: message.deliveryStatus,
        classification: [
          'normal',
          'auto_reply',
          'unsubscribe',
          'hard_bounce',
          'complaint',
        ].includes(message.classification)
          ? message.classification
          : 'normal',
        externalId: message.messageId || '',
        attachments: [],
        attachmentMetadata: message.attachments || [],
        demandIds: [],
        actualConfirmed: true,
        origin: 'manual',
        notes:
          message.deliveryStatus === 'accepted'
            ? '服务商已接受发送请求；尚未通过已发件箱核实，不代表客户已收到或阅读。'
            : '来自沟通中心的真实邮件同步。',
        audit: [
          {
            action: message.source === 'manual' ? 'manual_mail_reply' : 'mailbox_imported',
            at: timestamp,
          },
        ],
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      store.put('messages', record);
      recorded++;
    }
    store.putContext({ ...context, fixedEmail: account, updatedAt: timestamp });
    store.db.exec('COMMIT');
    return { recorded, conversationId: target.id };
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
