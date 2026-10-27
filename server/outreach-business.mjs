import { createHash } from 'node:crypto';

const fail = (status, message, code = 'OUTREACH_BUSINESS_CONFLICT') =>
  Object.assign(new Error(message), { status, code });
const invalid = () =>
  fail(400, '只有身份及发送凭据完整的正式已发送邮件可以登记', 'OUTREACH_BUSINESS_INVALID');
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);

function required(value, maximum, multiline = false) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    (!multiline && /[\r\n]/u.test(value))
  )
    throw invalid();
  return value;
}
function email(value) {
  const result = required(value, 254);
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(result)) throw invalid();
  return result;
}
function sentTime(value) {
  required(value, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw invalid();
  const result = new Date(value).toISOString();
  if (new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10))
    throw invalid();
  return result;
}
function actualMessage(message) {
  return (
    (message.direction === 'inbound' && message.deliveryStatus === 'received') ||
    (message.direction === 'outbound' && ['sent', 'accepted'].includes(message.deliveryStatus))
  );
}

/** Internal bridge only: persists SMTP acceptance as a business fact; never sends mail. */
export async function recordOutreachInBusiness({ store, delivery } = {}) {
  if (!delivery || delivery.mode !== 'production' || delivery.status !== 'accepted')
    throw invalid();
  const deliveryId = required(delivery.id, 180);
  const campaignId = required(delivery.campaignId, 180);
  const customerId = required(delivery.customerId, 180);
  const from = email(delivery.from);
  const to = email(delivery.to);
  const account = from.toLowerCase();
  const subject = required(delivery.subject, 500);
  const body = required(delivery.bodyText, 20000, true);
  const externalId = required(delivery.messageId, 500);
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/u.test(externalId)) throw invalid();
  const occurredAt = sentTime(delivery.sentAt);
  const messageId = 'msg_outreach_' + digest(deliveryId);
  const conversationId = 'conv_outreach_' + digest([customerId, deliveryId]);

  // The existing customer lookup may be asynchronous; all conflict checks are
  // repeated inside the database transaction after it finishes.
  if (!store.get('messages', messageId)) await store.actualCustomer(customerId);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const prior = store.get('messages', messageId);
    const original = {
      customerId,
      conversationId: prior?.conversationId || conversationId,
      channel: 'email',
      direction: 'outbound',
      subject,
      body,
      from,
      to,
      account,
      occurredAt,
      deliveryStatus: 'sent',
      classification: 'normal',
      externalId,
      attachments: [],
      demandIds: [],
      actualConfirmed: true,
      origin: 'outreach',
    };
    if (prior) {
      const provenance = prior.audit?.find((event) => event.action === 'outreach_accepted');
      if (
        !store.sameOriginalMessage(prior, original) ||
        provenance?.deliveryId !== deliveryId ||
        provenance?.campaignId !== campaignId
      )
        throw fail(409, '同一触达发送记录不能改变原文、发件身份或客户归属');
      const conversation = store.get('conversations', prior.conversationId);
      if (
        !conversation ||
        conversation.customerId !== customerId ||
        conversation.account.toLowerCase() !== account
      )
        throw fail(409, '原触达会话的客户或邮箱归属存在冲突');
      store.db.exec('COMMIT');
      return { message: prior, conversation, created: false };
    }

    const allMessages = store.all('messages');
    if (
      allMessages.some(
        (message) => message.channel === 'email' && message.externalId === externalId,
      )
    )
      throw fail(409, '该邮件消息编号已有沟通记录，请核对原记录');
    const context = store.context(customerId);
    if (context.fixedEmail && context.fixedEmail.toLowerCase() !== account)
      throw fail(409, '客户已有其他固定邮箱，无法登记不同身份的首次开发信');
    if (context.doNotContact) throw fail(409, '客户已停止联系，请人工核对这次实际发送');

    const conversations = store
      .all('conversations')
      .filter((item) => item.customerId === customerId);
    const demands = store.all('demands').filter((item) => item.customerId === customerId);
    if (
      conversations.some((item) => item.ownership === 'human') ||
      demands.some((item) => item.ownership === 'human')
    )
      throw fail(409, '客户已有人工负责的沟通，请人工核对这次实际发送');
    const messages = allMessages.filter((item) => item.customerId === customerId);
    if (messages.some(actualMessage))
      throw fail(409, '客户已有实际收发记录，不能登记另一封首次开发信');
    if (
      messages.some((item) =>
        ['unsubscribe', 'hard_bounce', 'complaint'].includes(item.classification),
      )
    )
      throw fail(409, '客户已有拒绝联系或渠道异常记录，请人工核对');

    const matching = conversations.filter(
      (item) =>
        item.channel === 'email' &&
        item.status === 'active' &&
        item.ownership === 'auto' &&
        (!item.account || item.account.toLowerCase() === account) &&
        item.participant?.toLowerCase() === to.toLowerCase(),
    );
    if (matching.length > 1) throw fail(409, '客户有多个可用会话，请先确认沟通归属');
    const now = store.timestamp();
    const audit = { action: 'outreach_accepted', at: now, deliveryId, campaignId };
    let conversation = matching[0];
    if (conversation) {
      conversation = {
        ...conversation,
        account,
        version: conversation.version + 1,
        updatedAt: now,
        audit: [...(conversation.audit || []), audit],
      };
    } else {
      if (store.get('conversations', conversationId)) throw fail(409, '首次开发信会话编号已被占用');
      conversation = {
        id: conversationId,
        customerId,
        title: subject.slice(0, 240),
        channel: 'email',
        account,
        participant: to,
        ownership: 'auto',
        owner: '',
        status: 'active',
        audit: [audit],
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
    }
    const message = {
      ...original,
      id: messageId,
      conversationId: conversation.id,
      notes: 'SMTP 服务器已接受发送请求；本记录不是客户收件、阅读或采购意向的证明。',
      audit: [audit],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    store.put('conversations', conversation);
    store.put('messages', message);
    store.putContext({ ...context, fixedEmail: account, updatedAt: now });
    store.pauseBlockedTasks(customerId);
    store.db.exec('COMMIT');
    return { message, conversation, created: true };
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
