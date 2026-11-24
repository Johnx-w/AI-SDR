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

const refusalEvidence =
  /\b(?:not interested|no (?:current )?(?:interest|need)|not looking for|do not (?:buy|purchase|source|need|wish)|don(?:'|’)t (?:buy|purchase|source|need|wish)|not (?:adding|considering|seeking) (?:a )?(?:new )?supplier|manufactur(?:e|ed|ing) .{0,80}\bin[- ]house|remove (?:me|us) from (?:future|your) (?:sales |marketing |email )?(?:outreach|messages|list))\b|暂不(?:考虑|采购|需要)|不(?:感兴趣|考虑新供应商|外采)/iu;
const referralEvidence =
  /\b(?:submit|send|direct) (?:all |your |supplier |business |commercial )*(?:enquir(?:y|ies)|inquir(?:y|ies)|proposal|application)s? (?:through|to|via|using) (?:our |the )?(?:commercial |business |supplier |vendor )?(?:contact |enquiry |inquiry |registration |application )?form\b|\b(?:supplier|vendor) (?:registration|application) (?:page|portal|form)\b|请通过.{0,30}(?:商务|供应商|采购).{0,12}(?:表单|页面|入口)/iu;
const positiveEvidence = {
  quote:
    /\b(?:send|share|provide|request|need|like|want|see|receive|get|have)\b.{0,80}\b(?:price(?: list| sheet| details| information|s)?|pricing|quotation|quote)\b|\b(?:price(?: list| sheet)|pricing|quotation|quote)\b.{0,80}\b(?:please|send|share|provide|request|need|like|want|see|receive|get)\b|(?:索价|报价|价目表)/iu,
  catalog:
    /\b(?:send|share|provide|request|need|like|want|see|receive|get|have)\b.{0,80}\b(?:catalog(?:ue)?|brochure|product (?:range|sheet|literature))\b|\b(?:catalog(?:ue)?|brochure)\b.{0,80}\b(?:please|send|share|provide|request|need|like|want|see|receive|get)\b|(?:产品)?(?:目录|型录)/iu,
  meeting:
    /\b(?:arrange|schedule|book|have|join|accept|agree to|happy to|available for)\b.{0,80}\b(?:meeting|call|video call|appointment)\b|\b(?:meeting|call|appointment)\b.{0,80}\b(?:next week|tomorrow|available|schedule|arrange|happy|interested)\b|(?:同意|安排|预约).{0,12}(?:会面|会议|通话)/iu,
};

export const BUSINESS_REPLY_LABELS = Object.freeze({
  positive: '积极回复',
  refusal: '明确拒绝',
  referral: '渠道转介',
  notification: '客服通知',
  bounce: '退信',
  unverified: '待核实',
  other: '其他真人回复',
});
export const POSITIVE_REQUEST_LABELS = Object.freeze({
  quote: '索价',
  catalog: '索目录',
  meeting: '约见',
});

/** Shared deterministic business classification for inbox, ledger and reminders. */
export function classifyInboundReply(message) {
  if (message.businessKind)
    return { kind: message.businessKind, requestType: message.requestType || null };
  const raw = customerReplyText({ body: message.bodyText || message.body || '' });
  const divider = raw.search(helpdeskDivider);
  const customerPart = divider > 0 ? raw.slice(0, divider).trim() : raw;
  const classification = incomingClassification(message);
  // A helpdesk reply typed above its divider is customer evidence even though the
  // footer below it is an automated receipt.
  const humanAboveTicket = divider > 0 && customerPart;
  if (!humanAboveTicket) {
    if (classification === 'hard_bounce') return { kind: 'bounce', requestType: null };
    if (classification === 'auto_reply') return { kind: 'notification', requestType: null };
    if (classification === 'unverified') return { kind: 'unverified', requestType: null };
    if (
      /^\s*automatic reply\b/iu.test(customerPart) ||
      (/\bwe have received your (?:request|message|inquiry|enquiry)\b/iu.test(customerPart) &&
        ticketNumber.test(customerPart))
    )
      return { kind: 'notification', requestType: null };
  }
  const analyzed = String(message.replyAnalysis?.demandSummary || '');
  if (
    refusalEvidence.test(customerPart + '\n' + analyzed) ||
    ['unsubscribe', 'complaint'].includes(classification)
  )
    return { kind: 'refusal', requestType: null };
  if (referralEvidence.test(customerPart)) return { kind: 'referral', requestType: null };
  for (const requestType of ['quote', 'catalog', 'meeting'])
    if (positiveEvidence[requestType].test(customerPart)) return { kind: 'positive', requestType };
  if (!customerPart || customerPart === '（邮件正文为空）')
    return { kind: 'unverified', requestType: null };
  return { kind: 'other', requestType: null };
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
  const business = replies.map(classifyInboundReply);
  const businessPriority = [
    'positive',
    'refusal',
    'referral',
    'notification',
    'bounce',
    'unverified',
    'other',
  ];
  const businessKind = businessPriority.find((kind) => business.some((item) => item.kind === kind));
  return {
    发送内容摘要: anchor.direction === 'outbound' ? anchor.body || null : null,
    收到回复内容: replies.length
      ? replies
          .map((message, i) =>
            [
              '【' + stamp(message.occurredAt) + ' 北京时间｜' + types[i] + '】',
              business[i]
                ? '回信分类：' +
                  BUSINESS_REPLY_LABELS[business[i].kind] +
                  (business[i].requestType
                    ? '｜客户请求：' + POSITIVE_REQUEST_LABELS[business[i].requestType]
                    : '')
                : '',
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
    回信分类: businessKind ? BUSINESS_REPLY_LABELS[businessKind] : null,
    客户请求: join(business.map((item) => POSITIVE_REQUEST_LABELS[item.requestType])),
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
