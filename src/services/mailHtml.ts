import DOMPurify from 'dompurify';
import { MAX_SIGNATURE_LOGO_BYTES } from '../domain/mail-signature.mjs';
import type {
  MailInlineImage,
  MailMessage,
  MailReplyAttachment,
  MailReplyContext,
} from './mailConversations';

export const MAIL_ATTACHMENT_LIMIT = 10 * 1024 * 1024;
export const escapeMailText = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
export const plainTextHtml = (value: string) => escapeMailText(value).replace(/\r?\n/g, '<br>');
export const mailFramePolicy = (externalImages: boolean) =>
  `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${externalImages ? ' https: http:' : ''}; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'`;
const cidKey = (value: string) => {
  try {
    return decodeURIComponent(value.replace(/^cid:/i, ''))
      .replace(/^<|>$/g, '')
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
};
export function inlineImageSource(value: string, images: MailInlineImage[] = []) {
  const image = images.find((item) => cidKey(item.cid) === cidKey(value));
  if (
    !image ||
    !/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(image.contentType) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image.contentBase64)
  )
    return '';
  return `data:${image.contentType.toLowerCase()};base64,${image.contentBase64}`;
}
export function safeMailLink(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}
export function makeMailFrame(
  bodyHtml: string,
  images: MailInlineImage[] = [],
  externalImages = false,
) {
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return null;
  const root = DOMPurify.sanitize(bodyHtml, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    ADD_TAGS: ['style'],
    ADD_ATTR: [
      'bgcolor',
      'background',
      'align',
      'valign',
      'cellpadding',
      'cellspacing',
      'border',
      'width',
      'height',
    ],
    FORBID_TAGS: [
      'script',
      'iframe',
      'frame',
      'frameset',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'select',
      'textarea',
      'video',
      'audio',
      'source',
      'svg',
      'math',
      'link',
      'meta',
      'base',
    ],
    FORBID_ATTR: [
      'srcdoc',
      'srcset',
      'action',
      'formaction',
      'autofocus',
      'contenteditable',
      'ping',
      'download',
    ],
  }) as HTMLElement;
  let remoteImages = 0;
  const imageUrl = (value: string) => {
    if (/^cid:/i.test(value)) return inlineImageSource(value, images);
    if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[A-Za-z0-9+/]*={0,2}$/i.test(value))
      return value;
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      if (!['https:', 'http:'].includes(url.protocol)) return '';
      remoteImages++;
      return externalImages ? url.href : '';
    } catch {
      return '';
    }
  };
  const cleanCss = (value: string) =>
    value
      .replace(/@import[^;]*;?/gi, '')
      .replace(/url\(\s*(['"]?)([^)]+?)\1\s*\)/gi, (_all, _quote, url: string) => {
        const source = imageUrl(url.trim());
        return source ? `url("${source.replace(/["\\\r\n]/g, '')}")` : 'none';
      });
  root.querySelectorAll('*').forEach((element) => {
    if (element.hasAttribute('style'))
      element.setAttribute('style', cleanCss(element.getAttribute('style') || ''));
    if (element.tagName === 'STYLE') element.textContent = cleanCss(element.textContent || '');
    if (element.hasAttribute('background')) {
      const background = imageUrl(element.getAttribute('background') || '');
      if (background) element.setAttribute('background', background);
      else element.removeAttribute('background');
    }
    if (element.tagName === 'IMG') {
      const source = imageUrl(element.getAttribute('src') || '');
      if (source) element.setAttribute('src', source);
      else {
        element.removeAttribute('src');
        if (!element.getAttribute('alt')) element.setAttribute('alt', '图片尚未加载');
      }
      element.setAttribute('referrerpolicy', 'no-referrer');
      element.setAttribute('decoding', 'async');
    }
    if (element.tagName === 'A') {
      const href = safeMailLink(element.getAttribute('href') || '');
      if (href) element.setAttribute('href', href);
      else element.removeAttribute('href');
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  });
  // Keep the sender's document styles and body attributes inside this isolated document.
  // A viewport-relative body height would otherwise grow with the parent resize observer.
  const body = root.querySelector('body');
  if (body) {
    body.style.setProperty('height', 'auto', 'important');
    body.style.setProperty('min-height', '0', 'important');
  }
  const prelude = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeMailText(mailFramePolicy(externalImages))}"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light;background:#fff;overflow-x:auto}body{margin:0;padding:4px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{overflow-wrap:anywhere}</style>`;
  const source =
    '<!doctype html>' + root.outerHTML.replace(/<head[^>]*>/i, (head) => head + prelude);
  return { srcDoc: source, remoteImages };
}
export function sanitizeReplyHtml(value: string) {
  if (typeof window === 'undefined' || !DOMPurify.isSupported)
    return plainTextHtml(value.replace(/<[^>]+>/g, ''));
  const fragment = DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'ul',
      'ol',
      'li',
      'a',
      'blockquote',
      'div',
      'span',
      'img',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'width'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM: true,
  }) as HTMLElement;
  fragment.querySelectorAll('img').forEach((element) => {
    const source = element.getAttribute('src') || '';
    if (
      source.length > MAX_SIGNATURE_LOGO_BYTES * 1.4 + 100 ||
      !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(source)
    )
      element.remove();
    else
      element.setAttribute(
        'width',
        String(Math.max(80, Math.min(320, Number(element.getAttribute('width')) || 160))),
      );
  });
  return fragment.innerHTML;
}
export function replyRecipient(message: MailMessage | undefined, context: MailReplyContext) {
  const preferred = message?.replyTo?.[0];
  return message && message.id !== context.replyToMessageId
    ? preferred && preferred.toLowerCase() !== context.from.toLowerCase()
      ? preferred
      : message.from
    : context.to;
}
export function validateMailAttachments(files: Pick<MailReplyAttachment, 'size'>[]) {
  if (files.length > 10) return '每封回复最多添加 10 个附件。';
  if (
    files.some((file) => file.size > MAIL_ATTACHMENT_LIMIT) ||
    files.reduce((sum, file) => sum + file.size, 0) > MAIL_ATTACHMENT_LIMIT
  )
    return '附件总大小不能超过 10 MB。';
  return '';
}
