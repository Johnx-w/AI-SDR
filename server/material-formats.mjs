import { Open } from 'unzipper-esm';
import { Parser } from 'saxen';
import { workbookType, checkOfficeArchive } from './product-workbooks.mjs';

export const videoLimit = 80 * 1024 * 1024;
export const types = {
  xlsx: workbookType,
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
export function materialType(name) {
  const ext = /\.([a-z0-9]+)$/iu.exec(String(name ?? ''))?.[1]?.toLowerCase();
  return ext && Object.hasOwn(types, ext) ? types[ext] : undefined;
}
export function validateFile(name, type, bytes) {
  if (!name || name.length > 200 || /[\\/\x00-\x1f\x7f]/u.test(name) || !bytes.length)
    throw fail('文件名或文件内容无效');
  if (!type || type !== materialType(name))
    throw fail('仅支持 PDF、DOCX、XLSX、Markdown、TXT、图片和视频');
  const head = bytes.subarray(0, 16).toString('latin1');
  let valid = false;
  if (type.startsWith('text/')) {
    try {
      valid = !new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0');
    } catch {}
  } else if (type === types.xlsx || type === types.docx) valid = head.startsWith('PK\x03\x04');
  else if (type === types.pdf) valid = head.startsWith('%PDF-');
  else if (type === types.png) valid = head.startsWith('\x89PNG\r\n\x1a\n');
  else if (type === types.jpg) valid = head.startsWith('\xff\xd8\xff');
  else if (type === types.webp) valid = head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
  else if (type === types.gif) valid = /^GIF8[79]a/.test(head);
  else if (type === types.webm) valid = head.startsWith('\x1a\x45\xdf\xa3');
  else valid = head.slice(4, 8) === 'ftyp';
  if (!valid) throw fail('文件内容与格式不符，文本请另存为 UTF-8');
}
export async function extractText(file) {
  let paragraphs = [];
  if (file.contentType === types.docx) {
    try {
      checkOfficeArchive(file.bytes);
      const archive = await Open.buffer(file.bytes);
      const xml = archive.files.find((entry) => entry.path === 'word/document.xml');
      if (!xml || archive.files.length > 2000 || xml.uncompressedSize > 8 * 1024 * 1024)
        throw fail('Word 文档结构无效或过大');
      const buffers = [];
      let size = 0;
      for await (const part of xml.stream()) {
        size += part.length;
        if (size > 8 * 1024 * 1024) throw fail('Word 正文过大');
        buffers.push(part);
      }
      const raw = Buffer.concat(buffers).toString('utf8');
      if (/<!DOCTYPE/i.test(raw)) throw fail('Word 文档结构无效');
      const parser = new Parser();
      parser.ns({
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
        'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
      });
      let text = '',
        inline = false;
      parser.on('openTag', (tag) => {
        if (tag === 'w:p') text = '';
        if (tag === 'w:t') inline = true;
      });
      parser.on('text', (value, decode) => {
        if (inline) text += decode(value);
      });
      parser.on('closeTag', (tag) => {
        if (tag === 'w:t') inline = false;
        if (tag === 'w:p') paragraphs.push(text);
      });
      parser.on('error', (err) => {
        throw err;
      });
      parser.parse(raw);
    } catch {
      throw fail('无法读取 DOCX 正文，请检查原件');
    }
  } else
    paragraphs = file.bytes
      .toString('utf8')
      .replace(/^\ufeff/, '')
      .split(/\r?\n/);
  const facts = [];
  let truncated = false;
  for (const [i, p] of paragraphs.entries()) {
    if (!p.trim()) continue;
    if (facts.length >= 200) {
      truncated = true;
      break;
    }
    if (p.length > 4000) truncated = true;
    facts.push({ text: p.trim().slice(0, 4000), page: 1, location: '第 ' + (i + 1) + ' 段' });
  }
  return {
    facts,
    warnings: truncated
      ? ['正文超过预览上限，仅显示前 200 个非空段落、每段 4000 字。完整内容可下载原件。']
      : [],
    model: 'local-text',
    extractedAt: new Date().toISOString(),
  };
}
