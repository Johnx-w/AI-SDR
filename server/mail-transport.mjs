import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

export const ALIBABA_MAIL_ENDPOINTS = Object.freeze({
  imap: Object.freeze({ host: 'imap.qiye.aliyun.com', port: 993, secure: true }),
  smtp: Object.freeze({ host: 'smtp.qiye.aliyun.com', port: 465, secure: true }),
});

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_MESSAGES_PER_SYNC = 50;
const TEST_MARKER_PATTERN = /^\[ShadeFlow-Test:([a-f0-9-]{36})\]$/i;
const MESSAGE_ID_PATTERN = /^<[^<>\s@]+@[^<>\s@]+>$/;

export class MailTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MailTransportError';
    this.code = code;
  }
}

function normalizeAddress(value) {
  if (typeof value !== 'string') return '';
  const address = value.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) return '';
  return address;
}

function requireAddress(value, code = 'MAIL_INVALID_ADDRESS') {
  const address = normalizeAddress(value);
  if (!address) throw new MailTransportError(code);
  return address;
}

function requireMessageId(value) {
  if (typeof value !== 'string' || !MESSAGE_ID_PATTERN.test(value.trim())) {
    throw new MailTransportError('MAIL_INVALID_MESSAGE_ID');
  }
  return value.trim();
}

function normalizeReferences(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : String(value).split(/\s+/);
  return [...new Set(values.filter(Boolean).map(requireMessageId))].slice(-30);
}

function headerValue(mail, name) {
  const value = mail?.headers?.get?.(name);
  return typeof value === 'string' ? value : '';
}

function addressValues(addressObject) {
  return (addressObject?.value ?? []).map((item) => normalizeAddress(item.address)).filter(Boolean);
}

function headerMessageIds(mail) {
  const references = Array.isArray(mail.references)
    ? mail.references
    : typeof mail.references === 'string'
      ? mail.references.split(/\s+/)
      : [];
  return [mail.inReplyTo, ...references].filter((id) => typeof id === 'string');
}

function uidNumber(value) {
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid < 1) throw new MailTransportError('MAIL_INVALID_CURSOR');
  return uid;
}

function validatedCursor(cursor) {
  if (!cursor || !/^\d+$/.test(String(cursor.uidValidity))) {
    throw new MailTransportError('MAIL_INVALID_CURSOR');
  }
  return {
    uidValidity: String(cursor.uidValidity),
    nextUid: uidNumber(cursor.nextUid),
  };
}

function safeFailure(error, fallback) {
  if (error instanceof MailTransportError) return error;
  // Never propagate library error text: providers can echo credentials or message content.
  if (['EAUTH', 'AUTHENTICATIONFAILED', 'AuthenticationFailed'].includes(error?.code)) {
    return new MailTransportError('MAIL_AUTH_FAILED');
  }
  return new MailTransportError(fallback);
}

function makeMessageId(account, createId) {
  return `<shadeflow.${createId()}@${account.split('@')[1]}>`;
}

function safeBody(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) {
    throw new MailTransportError(`MAIL_INVALID_${field}`);
  }
  return value.trim();
}

function safeSubject(value) {
  const subject = safeBody(value, 'SUBJECT');
  if (subject.length > 250 || /[\r\n\u0000-\u001f\u007f]/.test(subject)) {
    throw new MailTransportError('MAIL_INVALID_SUBJECT');
  }
  return subject;
}

function exactTestMarker(value) {
  if (typeof value !== 'string' || !TEST_MARKER_PATTERN.test(value)) {
    throw new MailTransportError('MAIL_INVALID_TEST_MARKER');
  }
  return value;
}

/** Classify a parsed MIME message without network access. A bounce is never inferred from an ordinary complaint. */
export function classifyIncomingMail(mail) {
  const subject = String(mail?.subject ?? '');
  const body = String(mail?.text ?? '');
  const sender = addressValues(mail?.from)[0] ?? '';
  const hasDeliveryStatusPart = (mail?.attachments ?? []).some(
    (part) => part.contentType?.toLowerCase() === 'message/delivery-status',
  );
  const failedRecipient = Boolean(headerValue(mail, 'x-failed-recipients'));
  const automaticSender = /^(mailer-daemon|postmaster)@/i.test(sender);
  const deliverySubject =
    /(?:delivery status notification|undeliver(?:ed|able)|mail delivery failed|邮件退信|投递失败)/i.test(
      subject,
    );
  if (hasDeliveryStatusPart || failedRecipient || (automaticSender && deliverySubject)) {
    const diagnostic = [
      body,
      ...(mail?.attachments ?? [])
        .filter((part) => part.contentType?.toLowerCase() === 'message/delivery-status')
        .map((part) => part.content?.toString?.('utf8') ?? ''),
    ].join('\n');
    const status = diagnostic.match(/^Status:\s*([245])\.\d+\.\d+/im)?.[1];
    return {
      kind: 'bounce',
      permanence: status === '5' ? 'hard' : status === '4' ? 'soft' : 'unknown',
    };
  }

  const unsubscribeLines = body.split(/\r?\n/).map((line) => line.trim().toLowerCase());
  if (
    unsubscribeLines.some((line) =>
      /^(退订|请退订|取消订阅|不要再联系我|不再联系|unsubscribe|please unsubscribe(?: me)?|remove me from (?:your )?(?:mailing )?list)[.!。！]?$/i.test(
        line,
      ),
    )
  ) {
    return { kind: 'unsubscribe' };
  }
  return { kind: 'reply' };
}

/**
 * SMTP/IMAP pilot boundary. The only real recipients are configured company-owned test addresses.
 * The caller must persist the returned cursor and sent Message-ID before it exposes a reply workflow.
 */
export function createAlibabaMailTransport({
  account,
  clientPassword,
  allowedTestRecipients,
  smtpFactory = nodemailer.createTransport,
  imapFactory = (options) => new ImapFlow(options),
  parseMessage = simpleParser,
  createId = randomUUID,
} = {}) {
  const sender = requireAddress(account, 'MAIL_INVALID_ACCOUNT');
  const authenticatedAccount = account.trim();
  if (typeof clientPassword !== 'string' || !clientPassword) {
    throw new MailTransportError('MAIL_MISSING_CLIENT_PASSWORD');
  }
  if (!Array.isArray(allowedTestRecipients) || allowedTestRecipients.length === 0) {
    throw new MailTransportError('MAIL_MISSING_TEST_ALLOWLIST');
  }
  const allowlist = new Set(allowedTestRecipients.map((value) => requireAddress(value)));
  if (allowlist.has(sender)) throw new MailTransportError('MAIL_TEST_RECIPIENT_IS_SENDER');

  function requireTestRecipient(value) {
    const address = requireAddress(value);
    if (!allowlist.has(address)) throw new MailTransportError('MAIL_RECIPIENT_NOT_ALLOWED');
    return address;
  }

  function createSmtp() {
    return smtpFactory({
      ...ALIBABA_MAIL_ENDPOINTS.smtp,
      auth: { user: authenticatedAccount, pass: clientPassword },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  function createImap() {
    return imapFactory({
      ...ALIBABA_MAIL_ENDPOINTS.imap,
      auth: { user: authenticatedAccount, pass: clientPassword },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      logger: false,
      maxLiteralSize: MAX_MESSAGE_BYTES + 64 * 1024,
      maxResponseSize: MAX_MESSAGE_BYTES + 128 * 1024,
    });
  }

  async function withImap(operation) {
    let client;
    let connected = false;
    try {
      client = createImap();
      await client.connect();
      connected = true;
      return await operation(client);
    } catch (error) {
      throw safeFailure(error, 'MAIL_IMAP_FAILED');
    } finally {
      if (connected) {
        try {
          await client.logout();
        } catch {
          /* Do not leak logout diagnostics. */
        }
      }
    }
  }

  async function withInbox(operation) {
    return withImap(async (client) => {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        return await operation(client);
      } finally {
        lock.release();
      }
    });
  }

  async function withSmtp(operation) {
    let transport;
    try {
      transport = createSmtp();
      return await operation(transport);
    } catch (error) {
      throw safeFailure(error, 'MAIL_SMTP_FAILED');
    } finally {
      transport?.close?.();
    }
  }

  async function sendMail(message) {
    const recipient = requireTestRecipient(message.to);
    const result = await withSmtp((transport) =>
      transport.sendMail({
        // No caller-provided From, Sender, Reply-To, envelope sender, CC, BCC or attachments.
        from: authenticatedAccount,
        replyTo: authenticatedAccount,
        to: recipient,
        subject: message.subject,
        text: message.text,
        messageId: message.messageId,
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
        ...(message.references?.length ? { references: message.references } : {}),
        envelope: { from: authenticatedAccount, to: [recipient] },
      }),
    );
    const accepted = (result?.accepted ?? []).map(normalizeAddress);
    if (!accepted.includes(recipient) || (result?.rejected ?? []).length > 0) {
      throw new MailTransportError('MAIL_DELIVERY_UNCONFIRMED');
    }
    return { messageId: message.messageId, to: recipient, accepted: true };
  }

  return Object.freeze({
    account: authenticatedAccount,

    async verifySmtp() {
      return withSmtp(async (transport) => {
        await transport.verify();
        return { connected: true };
      });
    },

    async verifyImap() {
      return withInbox(() => ({ connected: true }));
    },

    async captureInboxCursor() {
      return withInbox((client) => ({
        uidValidity: String(client.mailbox.uidValidity),
        nextUid: uidNumber(client.mailbox.uidNext),
      }));
    },

    async sendTechnicalTest({ to } = {}) {
      const recipient = requireTestRecipient(to);
      const marker = `[ShadeFlow-Test:${createId()}]`;
      exactTestMarker(marker);
      const messageId = makeMessageId(sender, createId);
      const sent = await sendMail({
        to: recipient,
        subject: `${marker} 邮箱连接测试`,
        text: '这是一封 ShadeFlow 邮箱连接测试邮件，仅发送到公司控制的测试邮箱。请直接回复本邮件以验证收件和会话关联。此邮件不是产品推广。',
        messageId,
      });
      return { ...sent, marker };
    },

    async sendTestReply({ to, subject, text, inReplyTo, references } = {}) {
      const recipient = requireTestRecipient(to);
      const parentId = requireMessageId(inReplyTo);
      const threadReferences = normalizeReferences(references);
      return sendMail({
        to: recipient,
        subject: safeSubject(subject),
        text: safeBody(text, 'BODY'),
        inReplyTo: parentId,
        references: [...new Set([...threadReferences, parentId])].slice(-30),
        messageId: makeMessageId(sender, createId),
      });
    },

    async syncTestInbox({ cursor, knownMessageIds = [], knownTestMarkers = [] } = {}) {
      const baseline = validatedCursor(cursor);
      const messageIds = new Set(knownMessageIds.map(requireMessageId));
      const markers = knownTestMarkers.map(exactTestMarker);
      if (messageIds.size === 0 && markers.length === 0) {
        throw new MailTransportError('MAIL_MISSING_TEST_THREAD');
      }
      return withInbox(async (client) => {
        if (String(client.mailbox.uidValidity) !== baseline.uidValidity) {
          throw new MailTransportError('MAIL_UID_VALIDITY_CHANGED');
        }
        const found = await client.search({ uid: `${baseline.nextUid}:*` }, { uid: true });
        if (!Array.isArray(found)) throw new MailTransportError('MAIL_IMAP_SEARCH_FAILED');
        const candidates = [...new Set(found.map(Number))]
          .filter((uid) => Number.isSafeInteger(uid) && uid >= baseline.nextUid)
          .sort((a, b) => a - b);
        const selected = candidates.slice(0, MAX_MESSAGES_PER_SYNC);
        const messages = [];
        const skipped = [];

        for (const uid of selected) {
          const metadata = await client.fetchOne(
            uid,
            {
              envelope: true,
              headers: ['from', 'to', 'cc', 'subject', 'message-id', 'in-reply-to', 'references'],
              size: true,
              internalDate: true,
            },
            { uid: true },
          );
          if (!metadata) continue;
          const from = (metadata.envelope?.from ?? [])
            .map((entry) => normalizeAddress(entry.address))
            .filter(Boolean);
          const to = [...(metadata.envelope?.to ?? []), ...(metadata.envelope?.cc ?? [])]
            .map((entry) => normalizeAddress(entry.address))
            .filter(Boolean);
          if (from.length !== 1 || !allowlist.has(from[0]) || !to.includes(sender)) {
            skipped.push({ uid, reason: 'outside_test_addresses' });
            continue;
          }
          const header = await parseMessage(metadata.headers ?? Buffer.alloc(0));
          const subject = String(metadata.envelope?.subject ?? header.subject ?? '');
          const related = headerMessageIds(header);
          if (
            !markers.some((marker) => subject.includes(marker)) &&
            !related.some((id) => messageIds.has(id))
          ) {
            skipped.push({ uid, reason: 'outside_test_thread' });
            continue;
          }
          if (!Number.isFinite(metadata.size) || metadata.size > MAX_MESSAGE_BYTES) {
            skipped.push({ uid, reason: 'message_too_large' });
            continue;
          }
          const raw = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!raw?.source || raw.source.length > MAX_MESSAGE_BYTES) {
            skipped.push({ uid, reason: 'message_too_large' });
            continue;
          }
          const parsed = await parseMessage(raw.source);
          if (
            addressValues(parsed.from).length !== 1 ||
            addressValues(parsed.from)[0] !== from[0]
          ) {
            skipped.push({ uid, reason: 'sender_mismatch' });
            continue;
          }
          messages.push({
            uid,
            messageId: parsed.messageId ?? null,
            inReplyTo: parsed.inReplyTo ?? null,
            references: Array.isArray(parsed.references)
              ? parsed.references
              : parsed.references
                ? [parsed.references]
                : [],
            from: from[0],
            to: sender,
            subject: parsed.subject ?? subject,
            text: parsed.text ?? '',
            receivedAt: metadata.internalDate?.toISOString?.() ?? null,
            classification: classifyIncomingMail(parsed),
          });
        }

        const nextUid = selected.length
          ? selected.at(-1) + 1
          : Math.max(baseline.nextUid, uidNumber(client.mailbox.uidNext));
        return {
          cursor: { uidValidity: baseline.uidValidity, nextUid },
          messages,
          skipped,
          hasMore: candidates.length > selected.length,
        };
      });
    },
  });
}
