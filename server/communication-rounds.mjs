import assert from 'node:assert/strict';

export const REPLY_TYPES = ['无回复', '系统自动回复', '真人客户回复', '联系方式失效'];

// Keep the customer's signature; quoted outgoing mail is not customer evidence.
export function customerReplyText(message) {
  const lines = String(message.body || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const result = [];
  for (const line of lines) {
    if (
      /^\s*(?:-{2,}\s*(?:original|forwarded) message|On .{1,500}wrote:|在.{1,300}写道[:：]|发件人\s*[:：])/i.test(
        line,
      )
    )
      break;
    if (!/^\s*>/.test(line)) result.push(line);
  }
  return result.join('\n').trim();
}

export function knownReplyType(message) {
  const body = customerReplyText(message);
  const subject = String(message.subject || '');
  const notification =
    /mailer-daemon|postmaster/i.test(message.from || '') ||
    /delivery status notification|undeliverable|delivery failure|退信|投递失败/i.test(subject) ||
    message.classification === 'hard_bounce';
  if (notification) {
    return /address not found|user unknown|no such (?:user|mailbox)|account.{0,70}does not exist|recipient.{0,40}not found|邮箱不存在|用户不存在/i.test(
      body,
    )
      ? '联系方式失效'
      : '系统自动回复';
  }
  if (
    message.classification === 'auto_reply' ||
    /automatic reply|auto(?:matic)?[- ]?response|out of (?:the )?office|\[request received\]|ticket #?\d+ received|we.ve received your inquiry|case closed|share your feedback with us|自动回复/i.test(
      subject,
    ) ||
    /your request.{0,120}has been received|currently (?:on leave|away from the office)|we have received your email and our team will be in touch|acknowledge that we have received your inquiry|tracking your request in case/i.test(
      body,
    )
  )
    return '系统自动回复';
  if (['unsubscribe', 'complaint'].includes(message.classification)) return '真人客户回复';
  return null;
}

const externalId = (value) =>
  String(value || '')
    .trim()
    .replace(/^<|>$/g, '');
const groupKey = (m) =>
  JSON.stringify([
    m.customerId,
    m.conversationId,
    m.channel,
    String(m.account || m.outboundAccount || '').toLowerCase(),
  ]);

export function communicationRounds(messages) {
  const groups = new Map(),
    aliases = new Map(),
    rounds = [];
  for (const message of messages) {
    assert(message.id && message.customerId && message.conversationId, '沟通缺少客户或会话编号');
    assert(Number.isFinite(Date.parse(message.occurredAt)), '沟通时间无效');
    const key = groupKey(message);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  for (const entries of groups.values()) {
    entries.sort(
      (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id),
    );
    const referenced = new Map();
    let latestSend;
    for (const message of entries) {
      let round;
      if (message.direction === 'inbound') {
        const references = [message.inReplyTo, ...[...(message.references || [])].reverse()]
          .map(externalId)
          .filter(Boolean);
        round = references.map((id) => referenced.get(id)).find(Boolean);
        // shortcut: headerless legacy replies use the preceding send in this conversation; backfill headers when available.
        if (!round && !references.length) round = latestSend;
      }
      if (!round) {
        round = { id: message.id, anchor: message, replies: [], members: [] };
        rounds.push(round);
      }
      round.members.push(message);
      if (message.direction === 'inbound') round.replies.push(message);
      if (message.direction === 'outbound') latestSend = round;
      aliases.set(message.id, round.id);
      const id = externalId(message.externalId || message.channelMessageId);
      if (id) {
        assert(!referenced.has(id), '同一会话存在重复渠道消息编号');
        referenced.set(id, round);
      }
    }
  }
  return { rounds, aliases };
}

const join = (values) => [...new Set(values.filter(Boolean))].join('\n') || null;
const stamp = (value) =>
  new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');

export function communicationRoundFields(round) {
  const { anchor, replies } = round;
  const types = replies.map(
    (message) => message.replyAnalysis?.replyType || knownReplyType(message),
  );
  assert(
    types.every((type) => REPLY_TYPES.includes(type) && type !== '无回复'),
    '来信尚未完成回复分类',
  );
  const replyType = types.includes('真人客户回复')
    ? '真人客户回复'
    : types.includes('联系方式失效')
      ? '联系方式失效'
      : replies.length
        ? '系统自动回复'
        : anchor.direction === 'outbound'
          ? '无回复'
          : null;
  return {
    发送内容摘要: anchor.direction === 'outbound' ? anchor.body || null : null,
    收到回复内容: replies.length
      ? replies
          .map((message, i) =>
            [
              '【' + stamp(message.occurredAt) + ' 北京时间｜' + types[i] + '】',
              message.subject ? '主题：' + message.subject : '',
              message.from || message.sender ? '来信邮箱：' + (message.from || message.sender) : '',
              message.body || '',
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n')
      : null,
    回复类型: replyType,
    提取客户信息: join(
      replies.flatMap((message) => String(message.replyAnalysis?.customerInfo || '').split('\n')),
    ),
    客户需求摘要: join(
      replies.map((message, i) =>
        types[i] === '真人客户回复' ? message.replyAnalysis?.demandSummary : null,
      ),
    ),
    业务员纪要: join(
      round.members
        .map((message) => (message.direction === 'note' ? message.body : message.notes))
        .filter((note) => note !== '来自沟通中心的真实邮件同步。'),
    ),
  };
}
