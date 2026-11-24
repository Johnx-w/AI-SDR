const aliyunSender = 'no-reply@mailsupport.aliyun.com';
const normalize = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();
const email = (value) =>
  value?.match(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/iu)?.[0].toLowerCase();

export const invalidAddressReason = 'bounce_invalid_recipient';
const actions = {
  invalid: '抑制该确切地址，重新核实公开联系方式',
  dns: '核对收件域拼写和 MX 解析',
  connection: '核对收件服务器连接及事件时段',
  temporary: '临时限制，核实最终投递结果',
  access: '核对 5.4.1 拒收原因及发件身份',
  policy: '核对网关、组或中继策略，确认允许收信后再联系',
  unknown: '人工核对原退信',
};

export function bounceDiagnosis(message) {
  const body = String(message.bodyText || '').slice(0, 16384);
  const lines = body.split(/\r?\n/u);
  const aliyun = normalize(message.from) === aliyunSender;
  const response = aliyun
    ? lines.find((line) => /^\s*系统应答\s*[:：]/u.test(line))
    : lines.find((line) => /^\s*Diagnostic-Code:/iu.test(line)) ||
      lines.find((line) => /^\s*[45]\d\d[ -]/u.test(line)) ||
      body.match(
        /^(?:the (?:response|reply)(?: from the remote server)? was):[ \t]*\r?\n\s*([^\r\n]+)/imu,
      )?.[1];
  const explanation = aliyun
    ? lines.find((line) => /^\s*退信原因\s*[:：]/u.test(line))
    : lines.find((line) =>
        /^(?:\*\* )?(?:Address not found|Message blocked)(?: \*\*)?$/iu.test(line.trim()),
      );
  const diagnostic = [response, explanation]
    .filter(Boolean)
    .map((line) => line.trim())
    .join('\n')
    .slice(0, 2000);
  const primary = classifyResponse(response || '');
  const category = primary === 'unknown' ? classifyResponse(explanation || '') : primary;
  return { category, diagnostic, action: actions[category] };
}

function classifyResponse(primary) {
  if (
    /\b5\.1\.1\b|no such (?:user|recipient)|user unknown|(?:account|user|mailbox).*does not exist|address not found|mailbox (?:disabled|unavailable permanently)|收件人不存在|接收地址不存在/iu.test(
      primary,
    )
  )
    return /\b4\d\d[ -]/u.test(primary) ? 'temporary' : 'invalid';
  if (
    /resolving by dns failed|domain not found|nxdomain|dns (?:lookup )?fail|域名不存在/iu.test(
      primary,
    )
  )
    return 'dns';
  if (/connect(?:ion)? (?:to .*failed|refused|timed out)|连接收件方邮件系统失败/iu.test(primary))
    return 'connection';
  if (/\b4\d\d[ -]|\b4\.\d\.\d\b|临时性错误/iu.test(primary)) return 'temporary';
  if (/\b5\.4\.1\b/iu.test(primary)) return 'access';
  if (
    /5\.7\.\d|message blocked|relay.*denied|blocklist|blacklist|policy|group.*reject/iu.test(
      primary,
    )
  )
    return 'policy';
  return 'unknown';
}

function bounceNotice(message) {
  if (message.direction !== 'inbound') return null;
  const sender = normalize(message.from);
  const subject = String(message.subject || '').trim();
  if (sender === aliyunSender && subject.includes('退信')) {
    const body = String(message.bodyText || '').slice(0, 16_384);
    if (!body.includes('邮件被退回') || !body.includes('退信原因')) return null;
    const header = body.split('退信原因', 1)[0];
    const originalSender = email(header.match(/^[^\S\r\n]*发件人[ \t]*[:：]([^\r\n]+)/mu)?.[1]);
    const originalSubject = header.match(/^[^\S\r\n]*主题[ \t]*[:：]([^\r\n]+)/mu)?.[1].trim();
    const recipients = [...header.matchAll(/^[^\S\r\n]*无法发送到[ \t]*[:：]?([^\r\n]+)/gmu)];
    const recipient = recipients.length === 1 ? email(recipients[0][1]) : '';
    if (recipients.length && recipients[0][1].split('@').length !== 2) return null;
    if (originalSender === normalize(message.account) && recipient && originalSubject)
      return { recipient, subject: originalSubject };
    return null;
  }
  if (
    !/^(?:mailer-daemon|postmaster)@/iu.test(sender) ||
    !/^(?:delivery status notification\s*\(failure\)|undeliverable\b|undelivered mail returned to sender\b)/iu.test(
      subject,
    )
  )
    return null;
  const originalId = message.inReplyTo || message.references?.at(-1);
  return /^<[^<>\s@]+@[^<>\s@]+>$/u.test(originalId || '') ? { originalId } : null;
}

export function recordOutreachBounces(db, messages) {
  const notices = messages.flatMap((message) => {
    const evidence = bounceNotice(message);
    const receivedAt = Date.parse(message.occurredAt);
    return evidence && Number.isFinite(receivedAt)
      ? [
          {
            ...evidence,
            diagnosis: bounceDiagnosis(message),
            finalRecipients: [
              ...String(message.bodyText || '')
                .slice(0, 16384)
                .matchAll(/^Final-Recipient:[^;\r\n]*;([^\r\n]*)/gimu),
            ].map((match) => email(match[1])),
            mailboxId: message.mailboxId,
            account: normalize(message.account),
            receivedAt,
          },
        ]
      : [];
  });
  if (!notices.length) return;
  // Project delivery metadata once per batch, so matching never reopens large mail bodies per row.
  const deliveries = db
    .prepare(
      `SELECT id, json_extract(data, '$.mailboxId') AS mailboxId,
        lower(json_extract(data, '$.from')) AS account, lower(json_extract(data, '$.to')) AS recipient,
        json_extract(data, '$.subject') AS subject, json_extract(data, '$.messageId') AS messageId,
        coalesce(json_extract(data, '$.sentAt'), json_extract(data, '$.attemptedAt')) AS submittedAt
      FROM outreach_deliveries
      WHERE state IN ('sending','unknown','accepted')
        AND json_extract(data, '$.mailboxId') IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...new Set(notices.map((notice) => notice.mailboxId))]));
  const save = db.prepare(
    `INSERT INTO outreach_delivery_bounces(delivery_id,received_at,diagnosis) VALUES(?,?,?)
    ON CONFLICT(delivery_id) DO UPDATE SET received_at=excluded.received_at, diagnosis=excluded.diagnosis WHERE excluded.received_at >= received_at`,
  );
  const confirmed = [];
  for (const notice of notices) {
    const matches = deliveries.filter(
      (delivery) =>
        delivery.mailboxId === notice.mailboxId &&
        delivery.account === notice.account &&
        Date.parse(delivery.submittedAt) <= notice.receivedAt &&
        (notice.originalId
          ? delivery.messageId === notice.originalId
          : delivery.recipient === notice.recipient && delivery.subject?.trim() === notice.subject),
    );
    if (matches.length === 1) {
      const receivedAt = new Date(notice.receivedAt).toISOString();
      if (
        notice.diagnosis.category === 'invalid' &&
        notice.finalRecipients.some((address) => address !== matches[0].recipient)
      ) {
        notice.diagnosis = {
          ...notice.diagnosis,
          category: 'unknown',
          action: '回执中的最终收件地址与原信不一致，人工核对',
        };
      }
      save.run(matches[0].id, receivedAt, JSON.stringify(notice.diagnosis));
      if (notice.diagnosis.category === 'invalid' && matches[0].recipient)
        db.prepare('INSERT OR IGNORE INTO outreach_suppression(identity,reason) VALUES(?,?)').run(
          'email:' + matches[0].recipient,
          invalidAddressReason,
        );
      confirmed.push({ id: matches[0].id, receivedAt });
    }
  }
  return confirmed;
}

export function initializeOutreachBounces(db) {
  const columns = db.prepare('PRAGMA table_info(outreach_delivery_bounces)').all();
  if (columns.some((column) => column.name === 'diagnosis')) return;
  if (columns.length) db.exec('ALTER TABLE outreach_delivery_bounces ADD COLUMN diagnosis TEXT');
  else
    db.exec(
      'CREATE TABLE outreach_delivery_bounces(delivery_id TEXT PRIMARY KEY, received_at TEXT NOT NULL, diagnosis TEXT)',
    );
  const messages = db
    .prepare(
      `SELECT m.data, json_extract(t.data, '$.mailboxId') AS mailboxId,
        json_extract(t.data, '$.account') AS account
      FROM mailbox_thread_messages m JOIN mailbox_threads t ON t.id = m.thread_id
      WHERE json_extract(m.data, '$.source') = 'imap'
        AND json_extract(m.data, '$.direction') = 'inbound'
        AND (json_extract(m.data, '$.from') = ? OR json_extract(m.data, '$.from') GLOB 'mailer-daemon@*'
          OR json_extract(m.data, '$.from') GLOB 'postmaster@*')`,
    )
    .all(aliyunSender)
    .map(({ data, mailboxId, account }) => ({ ...JSON.parse(data), mailboxId, account }));
  recordOutreachBounces(db, messages);
}
