import { splitMaterialText } from './material-chunks.mjs';
import {
  checkMaterialSize,
  pagedMaterialTypes,
  videoTypes,
} from '../src/domain/material-upload.mjs';
import { workbookType } from './product-workbooks.mjs';

export const types = {
  xlsx: workbookType,
  ...pagedMaterialTypes,
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ...videoTypes,
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
    throw fail('仅支持 PDF、DOCX、PPTX、XLSX、Markdown、TXT、图片和视频');
  checkMaterialSize(name, bytes.length);
  const head = bytes.subarray(0, 16).toString('latin1');
  let valid = false;
  if (type.startsWith('text/')) {
    try {
      valid = !new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0');
    } catch {}
  } else if (type === types.xlsx || type === types.docx || type === types.pptx)
    valid = head.startsWith('PK\x03\x04');
  else if (type === types.pdf) valid = head.startsWith('%PDF-');
  else if (type === types.png) valid = head.startsWith('\x89PNG\r\n\x1a\n');
  else if (type === types.jpg) valid = head.startsWith('\xff\xd8\xff');
  else if (type === types.webp) valid = head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP';
  else if (type === types.gif) valid = /^GIF8[79]a/.test(head);
  else if (type === types.webm) valid = head.startsWith('\x1a\x45\xdf\xa3');
  else valid = head.slice(4, 8) === 'ftyp';
  if (!valid) throw fail('文件内容与格式不符，文本请另存为 UTF-8');
}
// Stop scanning a large text file once the existing paragraph preview is full.
function* textParagraphs(bytes) {
  const text = bytes.toString('utf8').replace(/^\ufeff/, '');
  for (const line of text.matchAll(/([^\n]*)\n?/g)) yield line[1].replace(/\r$/, '');
}

export async function extractText(file) {
  const paragraphs = textParagraphs(file.bytes);
  const facts = [];
  let extractedBytes = 0,
    number = 0;
  const headings = [];
  let fence = '';
  for (const p of paragraphs) {
    number++;
    const text = p.trim();
    if (!text) continue;
    if (file.contentType === types.md) {
      const marker = /^(`{3,}|~{3,})/u.exec(text)?.[1];
      if (marker && !fence) fence = marker;
      else if (fence && marker?.startsWith(fence) && text === marker) fence = '';
      const heading = !fence && /^(#{1,6})\s+(.+)$/u.exec(text);
      if (heading) {
        headings.length = heading[1].length - 1;
        headings.push(heading[2]);
      }
    }
    const context = headings.filter(Boolean).join(' / ').slice(0, 160);
    let part = 0;
    for (const chunk of splitMaterialText(text)) {
      extractedBytes += Buffer.byteLength(chunk) + 200;
      if (extractedBytes > 4 * 1024 * 1024)
        throw fail('正文超过单份可解析容量，请按章节拆分导入。');
      const location = '第 ' + number + ' 段' + (text.length > 1600 ? ' · 分块 ' + ++part : '');
      facts.push({
        text: chunk,
        page: 1,
        location: context ? location + ' · ' + context : location,
      });
    }
  }
  if (!facts.length) throw fail('正文没有可读文字，请检查原件。');
  return {
    facts,
    warnings: [],
    model: 'local-text',
    extractedAt: new Date().toISOString(),
  };
}
