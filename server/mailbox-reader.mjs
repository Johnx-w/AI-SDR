import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const IMAP = Object.freeze({ host: 'imap.qiye.aliyun.com', port: 993, secure: true });
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_HEADERS_BYTES = 64 * 1024;
const MAX_MESSAGES = 50;
const MAX_INLINE_IMAGE_BYTES = 512 * 1024;
const MAX_INLINE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_WIRE_BYTES = MAX_INLINE_IMAGE_BYTES * 3 + 4096;
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const HEADERS = [
  'from',
  'to',
  'cc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
];
const readMessages = {
  MAILBOX_READ_FAILED: '邮箱邮件同步失败，请检查收件连接后重试',
  MAILBOX_READ_AUTH_FAILED: '邮箱收件验证失败，请检查账号和客户端密码',
  MAILBOX_READ_INVALID: '邮箱收件参数不正确',
};

export class MailboxReadError extends Error {
  constructor(code = 'MAILBOX_READ_FAILED') {
    super(readMessages[code] || readMessages.MAILBOX_READ_FAILED);
    this.name = 'MailboxReadError';
    this.code = Object.hasOwn(readMessages, code) ? code : 'MAILBOX_READ_FAILED';
    this.status = this.code === 'MAILBOX_READ_INVALID' ? 400 : 503;
  }
}
const invalid = () => new MailboxReadError('MAILBOX_READ_INVALID');
const safeError = (error) =>
  error instanceof MailboxReadError
    ? error
    : new MailboxReadError(
        ['EAUTH', 'AUTHENTICATIONFAILED', 'AuthenticationFailed'].includes(error?.code)
          ? 'MAILBOX_READ_AUTH_FAILED'
          : 'MAILBOX_READ_FAILED',
      );
const clean = (value, maximum = 1000) =>
  String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .slice(0, maximum);
function address(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\s<>\u0000-\u001f\u007f]/u.test(value))
    return '';
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/u.test(
    value,
  )
    ? value.toLowerCase()
    : '';
}
function addresses(value) {
  const entries = Array.isArray(value) ? value : value?.value || [];
  return [
    ...new Set(
      entries
        .slice(0, 200)
        .map((item) => address(item?.address))
        .filter(Boolean),
    ),
  ];
}
function messageId(value) {
  return typeof value === 'string' && value.length <= 500 && /^<[^<>\s@]+@[^<>\s@]+>$/u.test(value)
    ? value
    : null;
}
function references(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s+/u)
      : [];
  return [...new Set(values.map(messageId).filter(Boolean))].slice(-50);
}
function uid(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw invalid();
  return number;
}
function cursor(value) {
  if (!value || !/^\d+$/u.test(String(value.uidValidity))) throw invalid();
  return { uidValidity: String(value.uidValidity), nextUid: uid(value.nextUid) };
}
function instant(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function contentId(value) {
  const id = typeof value === 'string' ? value.trim().replace(/^<|>$/gu, '') : '';
  return id && id.length <= 256 && !/[\s<>\u0000-\u001f\u007f]/u.test(id) ? id : '';
}
function textParts(structure, parts = [], attachments = [], inlineParts = []) {
  if (!structure || typeof structure !== 'object') return { parts, attachments, inlineParts };
  const type = structure.type?.toLowerCase();
  if (INLINE_TYPES.has(type) && contentId(structure.id)) inlineParts.push(structure);
  if (String(structure.disposition).toLowerCase() === 'attachment') {
    attachments.push({
      name: clean(structure.dispositionParameters?.filename || structure.parameters?.name, 500),
      contentType: clean(structure.type, 150),
      size: Number.isSafeInteger(structure.size) && structure.size >= 0 ? structure.size : null,
    });
    return { parts, attachments, inlineParts };
  }
  if (['text/plain', 'text/html'].includes(structure.type?.toLowerCase())) parts.push(structure);
  // An attached forwarded message is a separate message, never this message's body.
  if (structure.type?.toLowerCase() !== 'message/rfc822')
    for (const child of (structure.childNodes || []).slice(0, 100))
      textParts(child, parts, attachments, inlineParts);
  return { parts, attachments, inlineParts };
}
function parseOptions() {
  return { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, keepCidLinks: false };
}

function mimePart(part, body, binary = false) {
  const type = part.type.toLowerCase();
  const charset = /^[A-Za-z0-9._-]{1,50}$/u.test(part.parameters?.charset || '')
    ? part.parameters.charset
    : 'utf-8';
  const encoding = ['base64', 'quoted-printable', '7bit', '8bit', 'binary'].includes(
    part.encoding?.toLowerCase(),
  )
    ? part.encoding.toLowerCase()
    : '8bit';
  return Buffer.concat([
    Buffer.from(
      `Content-Type: ${type}${binary ? '' : `; charset="${charset}"`}\r\nContent-Transfer-Encoding: ${encoding}\r\n${binary ? 'Content-Disposition: attachment\r\n' : ''}\r\n`,
    ),
    body,
  ]);
}
function imageSignature(type, bytes) {
  if (type === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (type === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (type === 'image/gif') return /^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'));
  return (
    type === 'image/webp' &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

/** Reads selected MIME bodies and bounded CID images, without remote resources or flag writes. */
export function createMailboxReader({
  account,
  clientPassword,
  imapFactory = (options) => new ImapFlow(options),
  parseMessage = simpleParser,
  timeoutMs = 90_000,
} = {}) {
  const normalizedAccount = address(account);
  if (
    !normalizedAccount ||
    typeof clientPassword !== 'string' ||
    !clientPassword ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw invalid();

  async function readMessage(client, metadata, folder, since, initial) {
    if (!Buffer.isBuffer(metadata.headers) || metadata.headers.length > MAX_HEADERS_BYTES)
      return null;
    const receivedAt = instant(metadata.internalDate);
    if (!receivedAt) return null;
    if (initial && Date.parse(receivedAt) < Date.parse(since)) return null;
    const headers = await parseMessage(metadata.headers, parseOptions());
    const from = addresses(headers.from ?? metadata.envelope?.from);
    const to = addresses(headers.to ?? metadata.envelope?.to);
    const cc = addresses(headers.cc ?? metadata.envelope?.cc);
    if (from.length !== 1) return null;
    const { parts, attachments, inlineParts } = textParts(metadata.bodyStructure);
    const selected = ['text/plain', 'text/html']
      .map((type) => parts.find((item) => item.type.toLowerCase() === type))
      .filter(Boolean);
    let bodyText = '',
      bodyHtml = '',
      loaded = false,
      tooLarge = false;
    for (const part of selected) {
      if (!Number.isSafeInteger(part.size) || part.size < 0 || part.size > MAX_BODY_BYTES) {
        tooLarge = true;
      } else {
        const key = part.part || (metadata.bodyStructure === part ? 'TEXT' : '');
        if (!/^(?:TEXT|\d+(?:\.\d+)*)$/u.test(key)) throw new MailboxReadError();
        const fetched = await client.fetchOne(
          metadata.uid,
          {
            bodyParts: [{ key, start: 0, maxLength: MAX_BODY_BYTES + 1 }],
          },
          { uid: true },
        );
        if (!fetched) return null; // Expunged after metadata was fetched.
        // ImapFlow lowercases section keys: BODY[TEXT] becomes the map key "text".
        const body = fetched.bodyParts?.get(key.toLowerCase());
        if (!Buffer.isBuffer(body)) throw new MailboxReadError();
        if (body.length > MAX_BODY_BYTES) tooLarge = true;
        else {
          const parsed = await parseMessage(mimePart(part, body), parseOptions());
          if (part.type.toLowerCase() === 'text/plain')
            bodyText = clean(parsed.text || '', MAX_BODY_BYTES);
          else {
            bodyHtml = clean(typeof parsed.html === 'string' ? parsed.html : '', MAX_BODY_BYTES);
            if (!loaded) bodyText = clean(parsed.text || '', MAX_BODY_BYTES);
          }
          loaded = true;
        }
      }
    }
    const inlineImages = [],
      savedCids = new Set();
    const referencedCids = new Set(
      [...bodyHtml.matchAll(/\bcid:([^\s"'<>]+)/giu)].map((match) => {
        try {
          return contentId(decodeURIComponent(match[1]));
        } catch {
          return contentId(match[1]);
        }
      }),
    );
    let inlineBytes = 0;
    for (const part of inlineParts.slice(0, 32)) {
      const cid = contentId(part.id),
        type = part.type.toLowerCase();
      if (
        !referencedCids.has(cid) ||
        savedCids.has(cid) ||
        inlineBytes >= MAX_INLINE_TOTAL_BYTES ||
        !/^\d+(?:\.\d+)*$/u.test(part.part || '') ||
        !Number.isSafeInteger(part.size) ||
        part.size < 0 ||
        part.size > MAX_INLINE_WIRE_BYTES
      )
        continue;
      const fetched = await client.fetchOne(
        metadata.uid,
        { bodyParts: [{ key: part.part, start: 0, maxLength: MAX_INLINE_WIRE_BYTES + 1 }] },
        { uid: true },
      );
      if (!fetched) return null;
      const bytes = fetched.bodyParts?.get(part.part);
      if (!Buffer.isBuffer(bytes)) throw new MailboxReadError();
      if (bytes.length > MAX_INLINE_WIRE_BYTES) continue;
      const parsed = await parseMessage(mimePart(part, bytes, true), parseOptions());
      const content = parsed.attachments?.[0]?.content;
      if (
        !Buffer.isBuffer(content) ||
        content.length > MAX_INLINE_IMAGE_BYTES ||
        inlineBytes + content.length > MAX_INLINE_TOTAL_BYTES ||
        !imageSignature(type, content)
      )
        continue;
      inlineImages.push({ cid, contentType: type, contentBase64: content.toString('base64') });
      inlineBytes += content.length;
      savedCids.add(cid);
    }
    return {
      uid: uid(metadata.uid),
      folder: folder.path,
      direction: folder.sent || from[0] === normalizedAccount ? 'outbound' : 'inbound',
      from: from[0],
      fromName: clean(
        headers.from?.value?.[0]?.name || metadata.envelope?.from?.[0]?.name || '',
        500,
      ).replace(/[\r\n]/gu, ' '),
      to: [...new Set([...to, ...cc])].join(', ') || '（收件人未披露）',
      toAddresses: to,
      cc,
      replyTo: addresses(headers.replyTo ?? metadata.envelope?.replyTo),
      subject: clean(headers.subject ?? metadata.envelope?.subject ?? '', 1000).replace(
        /[\r\n]/gu,
        ' ',
      ),
      bodyText,
      bodyHtml,
      bodyFormatVersion: 2,
      bodyUnavailable: loaded ? null : tooLarge ? 'too_large' : 'unsupported',
      inlineImages,
      sourceLocator: {
        folder: folder.path,
        uid: uid(metadata.uid),
        uidValidity: String(client.mailbox.uidValidity),
      },
      occurredAt: instant(headers.date) || receivedAt,
      messageId: messageId(headers.messageId ?? metadata.envelope?.messageId),
      inReplyTo: messageId(headers.inReplyTo ?? metadata.envelope?.inReplyTo),
      references: references(headers.references),
      unread: !metadata.flags?.has?.('\\Seen'),
      attachments,
    };
  }

  async function readFolder(client, folder, previous, since, releases) {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    const release = () => {
      if (releases.delete(release)) {
        try {
          lock.release();
        } catch {}
      }
    };
    releases.add(release);
    try {
      const current = cursor({
        uidValidity: client.mailbox?.uidValidity,
        nextUid: client.mailbox?.uidNext,
      });
      const baseline = previous ? cursor(previous) : null;
      const reset = Boolean(baseline && baseline.uidValidity !== current.uidValidity);
      const incremental = baseline && !reset;
      const found = await client.search(
        incremental ? { uid: `${baseline.nextUid}:*` } : { since: new Date(since) },
        { uid: true },
      );
      if (!Array.isArray(found)) throw new MailboxReadError();
      const candidates = [...new Set(found.map(uid))]
        .filter((value) => !incremental || value >= baseline.nextUid)
        .sort((a, b) => a - b);
      const selected = candidates.slice(0, MAX_MESSAGES),
        messages = [];
      let skipped = 0;
      for (const item of selected) {
        const metadata = await client.fetchOne(
          item,
          {
            uid: true,
            envelope: true,
            flags: true,
            internalDate: true,
            headers: HEADERS,
            bodyStructure: true,
          },
          { uid: true },
        );
        if (!metadata) {
          skipped++;
          continue;
        }
        if (uid(metadata.uid) !== item) throw new MailboxReadError();
        const message = await readMessage(client, metadata, folder, since, !incremental);
        if (message) messages.push(message);
        else skipped++;
      }
      return {
        path: folder.path,
        uidValidity: current.uidValidity,
        nextUid: selected.length
          ? selected.at(-1) + 1
          : Math.max(incremental ? baseline.nextUid : 1, current.nextUid),
        hasMore: candidates.length > selected.length,
        messages,
        skipped,
        reset,
      };
    } finally {
      release();
    }
  }

  return Object.freeze({
    async read({ cursors = {}, since = new Date(Date.now() - 30 * 86400_000).toISOString() } = {}) {
      if (!cursors || typeof cursors !== 'object' || Array.isArray(cursors) || !instant(since))
        throw invalid();
      let client,
        connected = false,
        timer;
      const releases = new Set();
      const close = () => {
        try {
          client?.close?.();
        } catch {}
      };
      try {
        client = await imapFactory({
          ...IMAP,
          auth: { user: account, pass: clientPassword },
          tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: IMAP.host },
          logger: false,
          logRaw: false,
          disableAutoIdle: true,
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 30_000,
          maxLiteralSize: Math.max(MAX_BODY_BYTES, MAX_INLINE_WIRE_BYTES) + MAX_HEADERS_BYTES,
          maxResponseSize: Math.max(MAX_BODY_BYTES, MAX_INLINE_WIRE_BYTES) + MAX_HEADERS_BYTES * 2,
        });
        client.on?.('error', () => {});
        const work = (async () => {
          await client.connect();
          connected = true;
          const listed = await client.list();
          if (!Array.isArray(listed)) throw new MailboxReadError();
          const sent = listed.find(
            (item) => item.specialUse === '\\Sent' && item.path && !item.flags?.has?.('\\Noselect'),
          );
          const inbox = listed.find(
            (item) => item.specialUse === '\\Inbox' || item.path?.toUpperCase() === 'INBOX',
          );
          const folders = [{ path: inbox?.path || 'INBOX', sent: false }];
          if (sent && sent.path !== folders[0].path) folders.push({ path: sent.path, sent: true });
          const results = [];
          for (const folder of folders)
            results.push(
              await readFolder(
                client,
                folder,
                Object.hasOwn(cursors, folder.path) ? cursors[folder.path] : null,
                since,
                releases,
              ),
            );
          return {
            folders: results,
            hasMore: results.some((folder) => folder.hasMore),
            folderCoverage: { inbox: true, sent: folders.length > 1 },
          };
        })();
        return await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              close();
              reject(new MailboxReadError());
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        throw safeError(error);
      } finally {
        clearTimeout(timer);
        for (const release of releases) release();
        if (connected) {
          let logoutTimer;
          try {
            await Promise.race([
              client.logout(),
              new Promise((resolve) => {
                logoutTimer = setTimeout(() => {
                  close();
                  resolve();
                }, 2000);
              }),
            ]);
          } catch {
            close();
          } finally {
            clearTimeout(logoutTimer);
          }
        } else close();
      }
    },
  });
}
