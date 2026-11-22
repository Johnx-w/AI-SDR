import assert from 'node:assert/strict';
import sanitizeHtml from 'sanitize-html';

export const REPLY_TYPES = ['无回复', '系统自动回复', '真人客户回复', '联系方式失效', '待核实回执'];

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

const helpdeskDivider = /^\s*##-\s*Please type your reply above this line\s*-##/imu;
const ticketNumber =
  /\b(?:ticket|case|request)\s*(?:reference|number|no\.?|id)?\s*[:#(\s-]*[a-z]{0,8}[- ]?\d{2,}\b/iu;

function receiptEvidence(message) {
  const plain = customerReplyText({ body: message.bodyText || message.body });
  const html = message.bodyHtml || '';
  const containsQuote = /<blockquote\b|\b(?:gmail_quote|yahoo_quoted|divRplyFwdMsg)\b/iu.test(html);
  let body = plain;
  let hasTicketHeading = false;
  if (
    html &&
    (!plain || containsQuote || /thank(?:s| you)(?: so much)? for your message/iu.test(plain))
  ) {
    const ownHtml = sanitizeHtml(html, {
      allowedTags: ['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr'],
      allowedAttributes: {},
      nonTextTags: ['script', 'style', 'textarea', 'option', 'head', 'blockquote', 'mail-quote'],
      transformTags: {
        '*': (tagName, attribs) => ({
          tagName: /\b(?:gmail_quote|yahoo_quoted|divRplyFwdMsg)\b/iu.test(
            (attribs.class || '') + ' ' + (attribs.id || ''),
          )
            ? 'mail-quote'
            : tagName,
          attribs: {},
        }),
      },
    });
    hasTicketHeading = /<h[1-6]>[^<>]{0,140}\bticket\b[^<>]{0,140}<\/h[1-6]>/iu.test(ownHtml);
    const htmlText = customerReplyText({
      body: ownHtml
        .replace(/<[^>]+>/gu, '\n')
        .replace(/&nbsp;/giu, ' ')
        .replace(/&#(?:39|x27);|&apos;/giu, "'"),
    });
    if (!plain || containsQuote) body = htmlText || (!containsQuote ? plain : '');
    else if (ticketNumber.test(htmlText)) body += '\n' + htmlText;
  }
  const separator = body.search(helpdeskDivider);
  if (separator >= 0 && body.slice(0, separator).trim()) body = body.slice(0, separator);
  return { body: body.replace(/[’‘]/gu, "'").trim(), hasTicketHeading, plain };
}

function genericAcknowledgment(body) {
  const lines = body
    .replace(/[’‘]/gu, "'")
    .split(/\r?\n/gu)
    .map((s) => s.trim())
    .filter(Boolean);
  // Short sign-offs commonly appear as separate plain-text lines in HTML alternatives.
  const signoff =
    /[.!]\s+(?:(?:kind|best|warm) regards|regards|best wishes|many thanks|thank you|thanks|best)\s*[,!]?(?:\s+|$)/iu;
  const generic =
    /^(?:(?:hi|hello)[!, .]+)?thank(?:s| you) for (?:getting in touch|contacting us|your message)[,.!\s-]+we(?:'ll| will) (?:be back (?:in touch )?with you|get back to you|respond|reply) within (?:the next )?\d{1,3}(?:\s*(?:[-–—]|to)\s*\d{1,3})?\s+(?:(?:working|business) )?hours?[.!\s]*$/iu;
  const flat = lines.join(' ');
  if (generic.test(flat.split(signoff)[0].trim())) return true;
  if (!generic.test(lines[0] || '') || lines.length > 3) return false;
  return lines
    .slice(1)
    .every(
      (line) =>
        /^[\p{L}\p{M} ,.‘’'&-]{1,32}$/u.test(line) &&
        !/\b(?:please|send|need|can|could|price|quote|order|sample|specifications?|what|when|how)\b/iu.test(
          line,
        ),
    );
}

function receiptType(body, hasTicketHeading) {
  const flat = body.replace(/\s+/gu, ' ');
  const received =
    /\b(?:we(?:'ve| have) received your (?:message|request|ticket|enquiry|inquiry)|your (?:message|request|ticket|enquiry|inquiry)(?:\s*\([^)]{1,40}\))? (?:has been|was) received)\b/iu;
  if (
    (helpdeskDivider.test(body) &&
      received.test(flat) &&
      (ticketNumber.test(flat) ||
        /\b(?:being (?:reviewed|processed)|our (?:team|staff) (?:is|are|will))\b/iu.test(flat))) ||
    (/\bthank(?:s| you)(?: so much)? for your message\b/iu.test(flat) &&
      /\bteam\b.{0,95}\bwill be in touch (?:with you )?soon\b/iu.test(flat) &&
      (ticketNumber.test(flat) || hasTicketHeading)) ||
    (/\byour message is with our team\b.{0,95}\bwe(?:'ll| will) reply\b/iu.test(flat) &&
      /\breceived outside (?:of )?our opening hours\b/iu.test(flat))
  )
    return '系统自动回复';
  if (genericAcknowledgment(body) || !flat || flat === '（邮件正文为空）') return '待核实回执';
  return null;
}

export function knownReplyType(message) {
  if (message.classification === 'hard_bounce') return '联系方式失效';
  if (message.classification === 'unverified') return '待核实回执';
  const { body, hasTicketHeading, plain } = receiptEvidence(message);
  const subject = String(message.subject || '');
  const ownSubject = /^(?:re|fw|fwd)\s*:/iu.test(subject.trim()) ? '' : subject;
  const notification =
    /^(?:mailer-daemon|postmaster)@/iu.test(message.from || '') ||
    /delivery status notification|undeliverable|delivery failure|退信|投递失败/i.test(ownSubject);
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
      ownSubject,
    ) ||
    /^\s*this is an (?:automated|automatically generated) (?:e-?mail|message)[.!](?:\s|$)/im.test(
      body,
    ) ||
    /currently (?:on leave|away from the office)|we have received your email and our team will be in touch|acknowledge that we have received your inquiry|tracking your request in case/i.test(
      body,
    )
  )
    return '系统自动回复';
  if (['unsubscribe', 'complaint'].includes(message.classification)) return '真人客户回复';
  return (
    receiptType(body, hasTicketHeading) ||
    (body !== plain && genericAcknowledgment(plain) ? '待核实回执' : null)
  );
}

export function incomingClassification(message) {
  const body = customerReplyText({ body: message.bodyText || message.body || '' });
  const subject = String(message.subject || '');
  if (
    /^(?:mailer-daemon|postmaster)@/iu.test(message.from) &&
    /undeliverable|failure|delivery failed|undelivered|退信|投递失败/iu.test(subject)
  )
    return 'hard_bounce';
  if (/^no-reply@mailsupport\.aliyun\.com$/iu.test(message.from) && /退信/u.test(subject))
    return 'hard_bounce';
  if (message.classification && message.classification !== 'normal') return message.classification;
  const replyType = knownReplyType(message);
  if (replyType === '系统自动回复' || /^(?:no[-_.]?reply|notifications?)@/iu.test(message.from))
    return 'auto_reply';
  if (
    /^(?:re:\s*)?unsubscribe\s*[.!]?$/iu.test(subject) ||
    /(?:^|[.!?\n]\s*)\s*(?:please\s+)?(?:unsubscribe(?:\s+me)?|remove me from (?:your|the) (?:mailing )?list|(?:please )?(?:do not|don't|stop) (?:contact(?:ing)?|email(?:ing)?) (?:me|us))\b/imu.test(
      body,
    ) ||
    /请勿(?:再)?(?:联系|发信)|请(?:帮我)?退订|^退订[。\s]*$/mu.test(body)
  )
    return 'unsubscribe';
  if (
    /\b(?:report(?:ed|ing)? (?:you|this) (?:as|for) spam|this is spam)\b|我要投诉|这是垃圾邮件/iu.test(
      body,
    )
  )
    return 'complaint';
  return replyType === '待核实回执' ? 'unverified' : 'normal';
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
      : types.includes('待核实回执')
        ? '待核实回执'
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
