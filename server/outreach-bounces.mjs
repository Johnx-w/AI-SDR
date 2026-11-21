const aliyunSender = 'no-reply@mailsupport.aliyun.com';
const normalize = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();
const email = (value) =>
  value?.match(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/iu)?.[0].toLowerCase();

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
    `INSERT INTO outreach_delivery_bounces(delivery_id,received_at) VALUES(?,?)
    ON CONFLICT(delivery_id) DO UPDATE SET received_at=max(received_at, excluded.received_at)`,
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
      save.run(matches[0].id, receivedAt);
      confirmed.push({ id: matches[0].id, receivedAt });
    }
  }
  return confirmed;
}

export function initializeOutreachBounces(db) {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='outreach_delivery_bounces'").get())
    return;
  db.exec(`CREATE TABLE outreach_delivery_bounces (
    delivery_id TEXT PRIMARY KEY, received_at TEXT NOT NULL
  )`);
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
