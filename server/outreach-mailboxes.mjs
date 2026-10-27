import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { ImapFlow } from 'imapflow';
import { createMailboxReader, MailboxReadError } from './mailbox-reader.mjs';

const SMTP = Object.freeze({ host: 'smtp.qiye.aliyun.com', port: 465, secure: true });
const IMAP = Object.freeze({ host: 'imap.qiye.aliyun.com', port: 993, secure: true });
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DPAPI = 'windows-dpapi-current-user';
const AES = 'aes-256-gcm-local-key';
const brandNames = {
  'honeybadgerblinds.com': 'Honey Badger Blinds',
  'shutterblindssolutions.com': 'Shutter & Blinds Solutions',
  'shuangshengshutter.com': 'Shuangsheng Shutter',
};
const messages = {
  MAILBOX_INVALID: '邮箱配置格式不正确',
  MAILBOX_NOT_FOUND: '邮箱不存在',
  MAILBOX_DUPLICATE: '该邮箱已经登记',
  MAILBOX_STORAGE_FAILED: '邮箱配置保存失败',
  MAILBOX_CREDENTIAL_FAILED: '邮箱密码无法安全读取或保存，请重新配置',
  MAILBOX_NOT_CONFIGURED: '请先配置邮箱客户端密码',
  MAILBOX_NOT_VERIFIED: '请先验证邮箱连接',
  MAILBOX_PAUSED: '该邮箱已暂停发送',
  MAILBOX_VERIFY_FAILED: '邮箱连接验证失败，请检查账号和客户端密码',
  MAILBOX_SEND_FAILED: '邮件发送结果待核实，请勿自动重发',
  MAILBOX_SENT_SAVE_FAILED: '邮件已发送，但已发送副本保存失败，请核对后重试保存',
  MAILBOX_IDENTITY_CHANGED: '邮箱身份已变化，请刷新后重新核对',
};

export class OutreachMailboxError extends Error {
  constructor(code, status = 400) {
    super(messages[code] || messages.MAILBOX_INVALID);
    this.name = 'OutreachMailboxError';
    this.code = code;
    this.status = status;
  }
}
const fail = (code = 'MAILBOX_INVALID', status) => new OutreachMailboxError(code, status);
const plainObject = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function text(value, max = 200, required = false, multiline = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    throw fail();
  if (!multiline && /[\r\n]/u.test(value)) throw fail();
  const result = value.trim();
  if (required && !result) throw fail();
  return result;
}
function email(value) {
  const result = text(value, 254, true);
  if (
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/u.test(
      result,
    )
  )
    throw fail();
  return result;
}
function website(value) {
  const raw = text(value, 2000, true);
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : 'https://' + raw);
  } catch {
    throw fail();
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(url.hostname) ||
    url.hash ||
    url.search
  )
    throw fail();
  return url.origin;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail();
  return value;
}
function smtp(value) {
  if (value === undefined) return { ...SMTP };
  if (
    !plainObject(value) ||
    Object.keys(value).some((key) => !['host', 'port', 'secure'].includes(key)) ||
    value.host !== SMTP.host ||
    value.port !== SMTP.port ||
    value.secure !== true
  )
    throw fail();
  return { ...SMTP };
}
function threadId(value) {
  const id = text(value, 500, true);
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/u.test(id)) throw fail();
  return id;
}
function requireExpectedAccount(record, message) {
  if (
    plainObject(message) &&
    message.expectedAccount !== undefined &&
    email(message.expectedAccount).toLowerCase() !== record.email.toLowerCase()
  )
    throw fail('MAILBOX_IDENTITY_CHANGED', 409);
}
function outgoing(record, message) {
  if (
    !plainObject(message) ||
    Object.keys(message).some(
      (key) =>
        ![
          'to',
          'subject',
          'text',
          'html',
          'messageId',
          'inReplyTo',
          'references',
          'attachments',
          'sentAt',
          'expectedAccount',
        ].includes(key),
    )
  )
    throw fail();
  const to = email(message.to),
    subject = text(message.subject, 250, true);
  const body = text(message.text ?? '', 1024 * 1024, false, true);
  const html =
    message.html === undefined ? undefined : text(message.html, 1024 * 1024, false, true);
  if (!body && !html) throw fail();
  const messageId = threadId(message.messageId);
  const inReplyTo = message.inReplyTo === undefined ? undefined : threadId(message.inReplyTo);
  if (
    message.references !== undefined &&
    (!Array.isArray(message.references) || message.references.length > 50)
  )
    throw fail();
  const references = [...new Set((message.references || []).map(threadId))];
  if (inReplyTo && !references.includes(inReplyTo)) references.push(inReplyTo);
  if (
    message.attachments !== undefined &&
    (!Array.isArray(message.attachments) || message.attachments.length > 10)
  )
    throw fail();
  let attachmentBytes = 0;
  const attachments = (message.attachments || []).map((attachment) => {
    if (
      !plainObject(attachment) ||
      Object.keys(attachment).some(
        (key) => !['id', 'name', 'contentType', 'size', 'contentBase64'].includes(key),
      )
    )
      throw fail();
    if (attachment.id !== undefined) text(attachment.id, 180, true);
    const filename = text(attachment.name, 255, true),
      contentType = text(attachment.contentType, 200, true);
    if (
      /[/\\]/u.test(filename) ||
      ['.', '..'].includes(filename) ||
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(contentType)
    )
      throw fail();
    const base64 = attachment.contentBase64;
    if (
      typeof base64 !== 'string' ||
      base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
      base64.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/u.test(base64) ||
      (base64.includes('=') && !/^={1,2}$/u.test(base64.slice(base64.indexOf('='))))
    )
      throw fail();
    const content = Buffer.from(base64, 'base64');
    if (
      content.toString('base64') !== base64 ||
      content.length > MAX_ATTACHMENT_BYTES ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size !== content.length
    )
      throw fail();
    attachmentBytes += content.length;
    if (attachmentBytes > MAX_ATTACHMENT_BYTES) throw fail();
    return { filename, contentType, content, contentDisposition: 'attachment' };
  });
  let date;
  if (message.sentAt !== undefined) {
    if (typeof message.sentAt !== 'string' || !Number.isFinite(Date.parse(message.sentAt)))
      throw fail();
    date = new Date(message.sentAt);
  }
  return {
    from: { name: record.displayName, address: record.email },
    replyTo: record.email,
    to,
    subject,
    text: body,
    ...(html ? { html } : {}),
    messageId,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(date ? { date } : {}),
    envelope: { from: record.email, to: [to] },
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}
function publicMailbox(record) {
  const { credential, credentialProtection, ...metadata } = record;
  const configured = Boolean(credential);
  const smtpStatus = record.verification.smtpVerified
    ? 'connected'
    : record.verification.status === 'error'
      ? 'error'
      : configured
        ? 'not_checked'
        : 'not_configured';
  const reportedError = record.verification.error || record.verification.message;
  const lastError =
    smtpStatus === 'error'
      ? Object.values(messages).includes(reportedError)
        ? reportedError
        : messages.MAILBOX_VERIFY_FAILED
      : null;
  return structuredClone({
    ...metadata,
    credentialConfigured: configured,
    configured,
    smtpStatus,
    lastCheckedAt: record.verification.checkedAt || null,
    lastError,
    configurationComplete: Boolean(credential && record.signature),
  });
}

// Data is passed exclusively through stdin. Neither passwords nor provider errors
// enter the command line, logs, or a returned child-process error.
const dpapiScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$clearBytes = $null
try {
  [void][Reflection.Assembly]::LoadWithPartialName('System.Security')
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($payload.operation -eq 'protect') {
    $clearBytes = [Text.Encoding]::Unicode.GetBytes($payload.value)
    $protected = [Security.Cryptography.ProtectedData]::Protect($clearBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([BitConverter]::ToString($protected).Replace('-', '').ToLowerInvariant())
  } elseif ($payload.operation -eq 'unprotect') {
    if ($payload.value -notmatch '^[0-9a-fA-F]+$' -or $payload.value.Length % 2 -ne 0) { exit 1 }
    $protected = New-Object byte[] ($payload.value.Length / 2)
    for ($i = 0; $i -lt $protected.Length; $i++) { $protected[$i] = [Convert]::ToByte($payload.value.Substring($i * 2, 2), 16) }
    $clearBytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::Unicode.GetString($clearBytes))
  } else { exit 1 }
} catch { exit 1 }
finally { if ($null -ne $clearBytes) { [Array]::Clear($clearBytes, 0, $clearBytes.Length) } }
`;

function dpapi(operation, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', dpapiScript],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(fail('MAILBOX_CREDENTIAL_FAILED', 503)) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, 15_000);
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > 64 * 1024) {
        child.kill();
        finish(true);
      } else chunks.push(chunk);
    });
    child.once('error', () => finish(true));
    child.stdin.once('error', () => finish(true));
    child.once('close', (code) => {
      const result = Buffer.concat(chunks).toString('utf8');
      finish(code !== 0 || !result, result);
    });
    child.stdin.end(JSON.stringify({ operation, value }));
  });
}

function localKey(path, create) {
  const keyPath = join(dirname(path), '.credential-key');
  if (!existsSync(keyPath) && create) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw fail('MAILBOX_CREDENTIAL_FAILED', 503);
  return key;
}
async function protectCredential(value, path) {
  if (process.platform === 'win32')
    return { credentialProtection: DPAPI, credential: await dpapi('protect', value) };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', localKey(path, true), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    credentialProtection: AES,
    credential: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'),
  };
}
async function unprotectCredential(value, protection, path) {
  if (protection === DPAPI && process.platform === 'win32') return dpapi('unprotect', value);
  if (protection !== AES || process.platform === 'win32')
    throw fail('MAILBOX_CREDENTIAL_FAILED', 503);
  const data = Buffer.from(value, 'base64');
  if (data.length < 29) throw fail('MAILBOX_CREDENTIAL_FAILED', 503);
  const decipher = createDecipheriv('aes-256-gcm', localKey(path, false), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

function normalize(input, previous) {
  if (!plainObject(input)) throw fail();
  const allowed = [
    'id',
    'email',
    'website',
    'brandName',
    'displayName',
    'signature',
    'productIds',
    'priority',
    'dailyLimit',
    'intervalSeconds',
    'paused',
    'clientPassword',
    'smtp',
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw fail();
  const value = { ...previous, ...input };
  const id = value.id || 'mailbox_' + randomUUID();
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(id)) throw fail();
  const address = email(value.email);
  const site = website(value.website ?? 'https://' + address.split('@')[1]);
  const defaultBrand = brandNames[new URL(site).hostname] || '';
  const productIds = value.productIds ?? [];
  if (!Array.isArray(productIds) || productIds.length > 500) throw fail();
  const paused = value.paused ?? true;
  if (typeof paused !== 'boolean') throw fail();
  return {
    id,
    email: address,
    website: site,
    smtp: smtp(value.smtp),
    brandName: text(value.brandName ?? defaultBrand, 160),
    displayName: text(value.displayName ?? defaultBrand, 160),
    signature: text(value.signature ?? '', 8000, false, true),
    productIds: [...new Set(productIds.map((id) => text(id, 180, true)))],
    priority: integer(value.priority ?? 100, 0, 10000),
    dailyLimit: integer(value.dailyLimit ?? 50, 1, 500),
    intervalSeconds: integer(value.intervalSeconds ?? 60, 30, 86400),
    paused,
    sendingEnabled: false,
  };
}

/** Credentials are server-only; connection verification never grants campaign authorization. */
export class OutreachMailboxes {
  constructor({
    env = process.env,
    path,
    seedPath,
    transportFactory = (config) => nodemailer.createTransport(config),
    mailboxReaderFactory = createMailboxReader,
    imapFactory = (config) => new ImapFlow(config),
    protect,
    unprotect,
  } = {}) {
    this.path = path || join(env.OUTREACH_DATA_DIR || '.data/outreach', 'mailboxes.json');
    this.seedPath = seedPath === null ? null : seedPath || '.data/outreach-mailboxes.dpapi.json';
    this.transportFactory = transportFactory;
    this.mailboxReaderFactory = mailboxReaderFactory;
    this.imapFactory = imapFactory;
    this.protect = protect || ((value) => protectCredential(value, this.path));
    this.unprotect =
      unprotect || ((value, protection) => unprotectCredential(value, protection, this.path));
    this.records = new Map();
    this.serial = Promise.resolve();
    const existing = existsSync(this.path);
    const source = existing
      ? this.path
      : this.seedPath && existsSync(this.seedPath)
        ? this.seedPath
        : null;
    if (source) {
      try {
        const document = JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/u, ''));
        if ((document.schemaVersion ?? document.schema) !== 1 || !Array.isArray(document.mailboxes))
          throw fail();
        for (const record of document.mailboxes) {
          const {
            credential,
            credentialProtection,
            verification,
            sendingEnabled,
            createdAt,
            updatedAt,
            ...settings
          } = record;
          const normalized = normalize({ ...settings, paused: settings.paused ?? false });
          if (
            this.records.has(normalized.id) ||
            [...this.records.values()].some(
              (item) => item.email.toLowerCase() === normalized.email.toLowerCase(),
            )
          )
            throw fail();
          if (
            credential !== undefined &&
            (typeof credential !== 'string' ||
              credential.length > 64000 ||
              ![DPAPI, AES].includes(credentialProtection))
          )
            throw fail();
          const checkedAt =
            typeof verification?.checkedAt === 'string' &&
            Number.isFinite(Date.parse(verification.checkedAt))
              ? verification.checkedAt
              : null;
          const verified = Boolean(
            credential &&
              checkedAt &&
              verification?.smtpVerified === true &&
              (!verification.email ||
                verification.email.toLowerCase() === normalized.email.toLowerCase()),
          );
          this.records.set(normalized.id, {
            ...normalized,
            credential: credential || null,
            credentialProtection: credential ? credentialProtection : null,
            verification: {
              smtpVerified: verified,
              checkedAt,
              status: verified ? 'connected' : 'not_verified',
            },
            createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
            updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date().toISOString(),
          });
        }
        if (!existing) this.persist(this.records);
      } catch {
        throw fail('MAILBOX_STORAGE_FAILED', 503);
      }
    }
  }
  persist(records) {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      writeFileSync(
        temporary,
        JSON.stringify({ schemaVersion: 1, mailboxes: [...records.values()] }, null, 2),
        { flag: 'wx', mode: 0o600 },
      );
      renameSync(temporary, this.path);
      if (process.platform !== 'win32') chmodSync(this.path, 0o600);
    } catch {
      throw fail('MAILBOX_STORAGE_FAILED', 503);
    }
  }
  runSerial(work) {
    const result = this.serial.then(work, work);
    this.serial = result.catch(() => {});
    return result;
  }
  required(id) {
    const record = this.records.get(id);
    if (!record) throw fail('MAILBOX_NOT_FOUND', 404);
    return record;
  }
  list() {
    return [...this.records.values()]
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map(publicMailbox);
  }
  get(id) {
    return publicMailbox(this.required(id));
  }
  async prepare(input, records) {
    const previous = plainObject(input) && input.id ? records.get(input.id) : undefined;
    const record = normalize(input, previous);
    if (
      [...records.values()].some(
        (item) => item.id !== record.id && item.email.toLowerCase() === record.email.toLowerCase(),
      )
    )
      throw fail('MAILBOX_DUPLICATE', 409);
    const identityChanged = previous && previous.email.toLowerCase() !== record.email.toLowerCase();
    let credential = identityChanged ? null : previous?.credential || null;
    let credentialProtection = identityChanged ? null : previous?.credentialProtection || null;
    const passwordChanged = Object.hasOwn(input, 'clientPassword');
    if (passwordChanged) {
      if (
        typeof input.clientPassword !== 'string' ||
        !input.clientPassword.trim() ||
        input.clientPassword.length > 4096 ||
        /[\r\n\u0000]/u.test(input.clientPassword)
      )
        throw fail();
      try {
        const protectedValue = await this.protect(input.clientPassword);
        const result =
          typeof protectedValue === 'string'
            ? {
                credential: protectedValue,
                credentialProtection: process.platform === 'win32' ? DPAPI : AES,
              }
            : protectedValue;
        if (
          !result?.credential ||
          typeof result.credential !== 'string' ||
          result.credential === input.clientPassword ||
          ![DPAPI, AES].includes(result.credentialProtection)
        )
          throw fail();
        credential = result.credential;
        credentialProtection = result.credentialProtection;
      } catch {
        throw fail('MAILBOX_CREDENTIAL_FAILED', 503);
      }
    }
    const now = new Date().toISOString();
    return {
      ...record,
      credential,
      credentialProtection,
      verification:
        !previous || identityChanged || passwordChanged
          ? { smtpVerified: false, checkedAt: null, status: 'not_verified' }
          : previous.verification,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
  }
  save(input) {
    return this.runSerial(async () => {
      const next = new Map(this.records);
      const record = await this.prepare(input, next);
      next.set(record.id, record);
      this.persist(next);
      this.records = next;
      return publicMailbox(record);
    });
  }
  import(list) {
    return this.runSerial(async () => {
      if (!Array.isArray(list) || list.length < 1 || list.length > 20) throw fail();
      const next = new Map(this.records);
      const imported = [];
      for (const input of list) {
        const record = await this.prepare(input, next);
        if (imported.some((item) => item.id === record.id)) throw fail('MAILBOX_DUPLICATE', 409);
        next.set(record.id, record);
        imported.push(record);
      }
      this.persist(next);
      this.records = next;
      return imported.map(publicMailbox);
    });
  }
  async transport(record) {
    if (!record.credential) throw fail('MAILBOX_NOT_CONFIGURED', 409);
    let password;
    try {
      password = await this.unprotect(record.credential, record.credentialProtection);
      if (typeof password !== 'string' || !password) throw fail();
    } catch {
      throw fail('MAILBOX_CREDENTIAL_FAILED', 503);
    }
    try {
      return await this.transportFactory({
        ...smtp(record.smtp),
        auth: { user: record.email, pass: password },
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: SMTP.host },
        logger: false,
        debug: false,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      });
    } catch {
      throw fail('MAILBOX_VERIFY_FAILED', 503);
    }
  }
  async readMailbox(id, options = {}) {
    const record = this.required(id);
    if (!record.credential) throw fail('MAILBOX_NOT_CONFIGURED', 409);
    let password;
    try {
      password = await this.unprotect(record.credential, record.credentialProtection);
      if (typeof password !== 'string' || !password) throw fail();
    } catch {
      throw fail('MAILBOX_CREDENTIAL_FAILED', 503);
    }
    // Sending pause and SMTP verification do not govern this separate read-only capability.
    try {
      const reader = await this.mailboxReaderFactory({
        account: record.email,
        clientPassword: password,
      });
      return await reader.read(options);
    } catch (error) {
      throw error instanceof MailboxReadError ? error : new MailboxReadError();
    }
  }
  verify(id) {
    return this.runSerial(async () => {
      const record = this.required(id);
      let transport;
      let failure;
      try {
        transport = await this.transport(record);
        if ((await transport.verify()) !== true) throw fail();
      } catch (error) {
        failure =
          error instanceof OutreachMailboxError ? error : fail('MAILBOX_VERIFY_FAILED', 503);
      } finally {
        try {
          transport?.close?.();
        } catch {}
      }
      const checked = {
        ...record,
        verification: {
          smtpVerified: !failure,
          checkedAt: new Date().toISOString(),
          status: failure ? 'error' : 'connected',
        },
      };
      const next = new Map(this.records).set(id, checked);
      this.persist(next);
      this.records = next;
      if (failure) throw failure;
      return publicMailbox(checked);
    });
  }
  send(id, message) {
    return this.runSerial(async () => {
      const record = this.required(id);
      requireExpectedAccount(record, message);
      if (record.paused) throw fail('MAILBOX_PAUSED', 409);
      if (!record.credential) throw fail('MAILBOX_NOT_CONFIGURED', 409);
      if (!record.verification.smtpVerified) throw fail('MAILBOX_NOT_VERIFIED', 409);
      const mail = outgoing(record, message);
      const { to, messageId } = mail;
      let transport;
      try {
        transport = await this.transport(record);
        const result = await transport.sendMail(mail);
        const matches = (values) =>
          (Array.isArray(values) ? values : []).some(
            (value) => typeof value === 'string' && value.toLowerCase() === to.toLowerCase(),
          );
        return {
          accepted: matches(result?.accepted) ? [to] : [],
          rejected: matches(result?.rejected) ? [to] : [],
          messageId,
        };
      } catch (error) {
        if (error instanceof OutreachMailboxError) throw error;
        throw fail('MAILBOX_SEND_FAILED', 503);
      } finally {
        try {
          transport?.close?.();
        } catch {}
      }
    });
  }
  saveSent(id, message) {
    return this.runSerial(async () => {
      const record = this.required(id);
      requireExpectedAccount(record, message);
      if (!record.credential) throw fail('MAILBOX_NOT_CONFIGURED', 409);
      const mail = outgoing(record, message);
      let password;
      try {
        password = await this.unprotect(record.credential, record.credentialProtection);
        if (typeof password !== 'string' || !password) throw fail();
      } catch {
        throw fail('MAILBOX_CREDENTIAL_FAILED', 503);
      }
      let client,
        connected = false,
        lock,
        timer;
      const close = () => {
        try {
          client?.close?.();
        } catch {}
      };
      const release = () => {
        if (lock) {
          const held = lock;
          lock = null;
          try {
            held.release();
          } catch {}
        }
      };
      try {
        const raw = await new Promise((resolve, reject) =>
          new MailComposer(mail)
            .compile()
            .build((error, buffer) => (error ? reject(error) : resolve(buffer))),
        );
        client = await this.imapFactory({
          ...IMAP,
          auth: { user: record.email, pass: password },
          tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: IMAP.host },
          logger: false,
          logRaw: false,
          disableAutoIdle: true,
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 30000,
        });
        client.on?.('error', () => {});
        const work = (async () => {
          await client.connect();
          connected = true;
          const listed = await client.list();
          const folder =
            Array.isArray(listed) &&
            listed.find(
              (item) =>
                item.specialUse === '\\Sent' && item.path && !item.flags?.has?.('\\Noselect'),
            );
          if (!folder) throw fail('MAILBOX_SENT_SAVE_FAILED', 503);
          lock = await client.getMailboxLock(folder.path, { readOnly: true });
          const found = await client.search(
            { header: { 'message-id': mail.messageId } },
            { uid: true },
          );
          if (!Array.isArray(found)) throw fail('MAILBOX_SENT_SAVE_FAILED', 503);
          if (found.length)
            return {
              saved: true,
              alreadyPresent: true,
              folder: folder.path,
              messageId: mail.messageId,
            };
          const appended = await client.append(
            folder.path,
            raw,
            ['\\Seen'],
            mail.date || new Date(),
          );
          if (!appended) throw fail('MAILBOX_SENT_SAVE_FAILED', 503);
          return {
            saved: true,
            alreadyPresent: false,
            folder: folder.path,
            messageId: mail.messageId,
          };
        })();
        return await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              close();
              reject(fail('MAILBOX_SENT_SAVE_FAILED', 503));
            }, 90000);
          }),
        ]);
      } catch {
        throw fail('MAILBOX_SENT_SAVE_FAILED', 503);
      } finally {
        clearTimeout(timer);
        release();
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
    });
  }
}
