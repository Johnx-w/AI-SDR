import sanitizeHtml from 'sanitize-html';
import { createHash } from 'node:crypto';

export const MAX_REPLY_ATTACHMENTS = 10;
export const MAX_REPLY_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_BODY_CHARS = 1024 * 1024;
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

/** Only the basic formatting supplied by the reply editor is retained. */
export function sanitizeReplyHtml(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > MAX_BODY_CHARS)
    throw invalid('邮件正文格式不正确或内容过长');
  return sanitizeHtml(value, {
    allowedTags: [
      'p',
      'br',
      'div',
      'span',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'blockquote',
      'a',
      'h1',
      'h2',
      'h3',
      'h4',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'hr',
      'pre',
      'code',
    ],
    allowedAttributes: {
      '*': ['style'],
      a: ['href', 'title', 'target', 'rel'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedStyles: {
      '*': {
        'text-align': [/^(?:left|right|center|justify)$/u],
        color: [/^#[a-f0-9]{3,8}$/iu, /^rgba?\([\d\s.,%]+\)$/iu],
        'background-color': [/^#[a-f0-9]{3,8}$/iu, /^rgba?\([\d\s.,%]+\)$/iu],
        'font-weight': [/^(?:normal|bold|[1-9]00)$/u],
        'font-style': [/^(?:normal|italic)$/u],
        'text-decoration': [/^(?:none|underline|line-through)$/u],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    },
  });
}

function plainText(value) {
  if (typeof value !== 'string' || value.length > MAX_BODY_CHARS)
    throw invalid('邮件正文格式不正确或内容过长');
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\ufeff]/gu, '')
    .replace(/\u00a0/gu, ' ')
    .trim();
}

export function htmlToText(value) {
  const html = sanitizeReplyHtml(value)
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|tr|blockquote|h[1-4]|pre)>/giu, '\n');
  const escaped = sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
  const decoded = escaped.replace(
    /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[a-f0-9]+);/giu,
    (match, entity) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (Object.hasOwn(named, entity.toLowerCase())) return named[entity.toLowerCase()];
      const number = entity.toLowerCase().startsWith('#x')
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      return Number.isSafeInteger(number) &&
        number > 0 &&
        number <= 0x10ffff &&
        !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number)
        : match;
    },
  );
  return plainText(decoded).replace(/\n{3,}/gu, '\n\n');
}

export function normalizeReplyContent(input = {}, { allowEmpty = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid('邮件内容格式不正确');
  const bodyHtml = sanitizeReplyHtml(input.bodyHtml ?? '');
  const bodyText = bodyHtml.trim() ? htmlToText(bodyHtml) : plainText(input.bodyText ?? '');
  if (!allowEmpty && !bodyText) throw invalid('请填写邮件正文');
  return { bodyHtml, bodyText };
}

/** Never forward paths, URLs, client-reported sizes or arbitrary Nodemailer options. */
export function normalizeAttachments(value = []) {
  if (!Array.isArray(value) || value.length > MAX_REPLY_ATTACHMENTS)
    throw invalid('每封邮件最多添加 10 个附件');
  let total = 0;
  return value.map((attachment) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment))
      throw invalid('附件格式不正确');
    const originalName = attachment.filename ?? attachment.name ?? attachment.fileName;
    const name =
      typeof originalName === 'string'
        ? originalName
            .split(/[\\/]/u)
            .at(-1)
            .replace(/[\u0000-\u001f\u007f]/gu, '')
            .trim()
        : '';
    if (!name || ['.', '..'].includes(name) || name.length > 255) throw invalid('附件名称不正确');
    const contentBase64 = attachment.contentBase64;
    if (
      typeof contentBase64 !== 'string' ||
      contentBase64.length > Math.ceil(MAX_REPLY_ATTACHMENT_BYTES / 3) * 4 ||
      contentBase64.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/u.test(contentBase64)
    )
      throw invalid('附件内容必须是有效的 Base64 文件数据');
    const bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.toString('base64') !== contentBase64) throw invalid('附件内容编码不正确');
    total += bytes.length;
    if (total > MAX_REPLY_ATTACHMENT_BYTES) throw invalid('附件总大小不能超过 10 MB');
    const contentType = attachment.contentType || 'application/octet-stream';
    if (
      typeof contentType !== 'string' ||
      contentType.length > 200 ||
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(contentType)
    )
      throw invalid('附件类型格式不正确');
    const id =
      typeof attachment.id === 'string' && /^[\w-]{1,128}$/u.test(attachment.id)
        ? attachment.id
        : 'attachment_' +
          createHash('sha256').update(name).update(bytes).digest('hex').slice(0, 24);
    return { id, name, contentType, size: bytes.length, contentBase64 };
  });
}
