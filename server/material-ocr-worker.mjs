import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { splitMaterialText } from './material-chunks.mjs';
import { PDFiumLibrary } from '@hyzyla/pdfium';
import { createWorker, OEM, PSM } from 'tesseract.js';

async function openOcr() {
  // Tesseract loads both bundled language packs from one directory. No network or shared cache.
  const langPath = await mkdtemp(join(tmpdir(), 'material-ocr-'));
  try {
    for (const code of ['eng', 'chi_sim']) {
      const filename = code + '.traineddata.gz';
      const source = import.meta.resolve(
        '@tesseract.js-data/' + code + (code === 'eng' ? '/4.0.0_best_int/' : '/4.0.0/') + filename,
      );
      await copyFile(new URL(source), join(langPath, filename));
    }
    const worker = await createWorker('eng+chi_sim', OEM.LSTM_ONLY, {
      langPath,
      cacheMethod: 'none',
      errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, user_defined_dpi: '300' });
    return worker;
  } finally {
    await rm(langPath, { recursive: true, force: true });
  }
}

const clean = (text) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '').trim();
const signature = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Sparse OCR can return separate cells in arbitrary order. Use their printed positions to
// reconstruct rows, keeping the two halves of a catalogue spread separate when there is a gutter.
function printedSections(tsv, width, height, native) {
  const lines = new Map();
  for (const row of tsv.split('\n')) {
    const [level, , block, para, line, , x, y, w, h, conf, word] = row.split('\t');
    if (level !== '5' || !word?.trim()) continue;
    const key = [block, para, line].join('/');
    let item = lines.get(key);
    if (!item) {
      item = { x: +x, right: 0, y: +y, bottom: 0, scores: 0, words: [] };
      lines.set(key, item);
    }
    item.x = Math.min(item.x, +x);
    item.y = Math.min(item.y, +y);
    item.right = Math.max(item.right, +x + +w);
    item.bottom = Math.max(item.bottom, +y + +h);
    item.scores += +conf;
    item.words.push(word);
  }
  const known = new Set(native.split('\n').map(signature));
  const found = [];
  for (const item of lines.values()) {
    const text = clean(item.words.join(' ')).replace(
      /(?<=\p{Script=Han}) +(?=\p{Script=Han})/gu,
      '',
    );
    const key = signature(text);
    const confidence = item.scores / item.words.length;
    // A small-font field and its measurement may share a low score. Keep that printed
    // candidate for review rather than silently losing dimensions or product codes.
    const fieldWithValue = /\p{L}{2,}/u.test(text) && /\d/u.test(text);
    if (
      !key ||
      known.has(key) ||
      (confidence < 45 && !fieldWithValue) ||
      (key.length === 1 && !/\d/u.test(key) && confidence < 85)
    )
      continue;
    found.push({ ...item, text, center: (item.y + item.bottom) / 2 });
  }
  const spread =
    width > height &&
    found.length > 8 &&
    !found.some((line) => line.x < width * 0.48 && line.right > width * 0.52);
  const columns = spread
    ? [found.filter((l) => l.x < width / 2), found.filter((l) => l.x >= width / 2)]
    : [found];
  return columns.flatMap((column, index) => {
    const rows = [];
    for (const line of column.sort((a, b) => a.center - b.center)) {
      const last = rows.at(-1);
      if (
        last &&
        line.center - last[0].center <=
          Math.min(line.bottom - line.y, last[0].bottom - last[0].y) / 2
      )
        last.push(line);
      else rows.push([line]);
    }
    const text = rows
      .map((row) =>
        row
          .sort((a, b) => a.x - b.x)
          .map((l) => l.text)
          .join('   '),
      )
      .join('\n');
    return text ? [{ location: spread ? ['左栏图文', '右栏图文'][index] : '页面图文', text }] : [];
  });
}

function passages(text, title, page, location) {
  const chunks = Array.from(splitMaterialText(text.trim(), 1600 - title.length), (part) =>
    (title + '\n' + part).trim(),
  );
  return chunks.map((value, index) => ({
    page,
    location: location + (chunks.length > 1 ? ' · 第 ' + (index + 1) + ' 段' : ''),
    text: value,
  }));
}

async function readPdf(bytes) {
  const lib = await PDFiumLibrary.init();
  let doc, ocr;
  try {
    doc = await lib.loadDocument(bytes);
    const pageCount = doc.getPageCount(),
      facts = [],
      warnings = [],
      empty = [];
    let storedBytes = 0;
    for (let index = 0; index < pageCount; index++) {
      const page = doc.getPage(index),
        number = index + 1;
      parentPort.postMessage({ page: number, total: pageCount });
      try {
        const native = clean(page.getText()).replace(/\r\n?/gu, '\n');
        const hasGraphics =
          !native ||
          page
            .objects()
            .some(
              (o) =>
                o.type === 'image' ||
                o.type === 'form' ||
                (o.type === 'path' && native.length < 250),
            );
        let sections = [];
        if (hasGraphics) {
          ocr ??= await openOcr();
          const { originalWidth: w, originalHeight: h } = page.getOriginalSize();
          const scale = Math.min(3.2, 3200 / Math.max(w, h), Math.sqrt(6500000 / (w * h)));
          const bitmap = await page.render({ scale, colorSpace: 'Gray' });
          const pgm = Buffer.concat([
            Buffer.from('P5\n' + bitmap.width + ' ' + bitmap.height + '\n255\n'),
            bitmap.data,
          ]);
          const { data } = await ocr.recognize(pgm, {}, { text: false, tsv: true });
          sections = printedSections(data.tsv, bitmap.width, bitmap.height, native);
        }
        // Keep selectable originals verbatim. Short page headings also identify OCR-only table rows.
        const title = native.length <= 250 ? native : '';
        const pageFacts =
          native && (!sections.length || !title) ? passages(native, '', number, '印刷文字') : [];
        for (const section of sections)
          pageFacts.push(...passages(section.text, title, number, section.location));
        storedBytes += Buffer.byteLength(JSON.stringify(pageFacts));
        if (storedBytes > 4 * 1024 * 1024) {
          throw new Error('large');
        }
        facts.push(...pageFacts);
        if (!native && !sections.length) empty.push(number);
      } finally {
        page.close();
      }
    }
    if (!facts.length) throw new Error('empty');
    if (empty.length) warnings.push('第 ' + empty.join('、') + ' 页未识别到文字，请对照原件。');
    if (ocr) warnings.push('图片中的型号、数字及单位请与原页核对后采用。');
    return {
      model: 'local-pdf',
      pageCount,
      facts,
      warnings,
      extractedAt: new Date().toISOString(),
    };
  } finally {
    await ocr?.terminate();
    doc?.destroy();
    lib.destroy();
  }
}

async function readImage(bytes) {
  const { default: sharp } = await import('sharp');
  const source = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 });
  const { pages = 1 } = await source.metadata();
  const { data, info } = await source
    .autoOrient()
    .flatten({ background: '#fff' })
    .resize({
      width: 3200,
      height: 3200,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const worker = await openOcr();
  try {
    const bitmap = Buffer.concat([
      Buffer.from('P5\n' + info.width + ' ' + info.height + '\n255\n'),
      data,
    ]);
    const { data: result } = await worker.recognize(bitmap, {}, { text: false, tsv: true });
    const facts = printedSections(result.tsv, info.width, info.height, '').flatMap((section) =>
      passages(section.text, '', 1, section.location),
    );
    if (!facts.length) throw new Error('empty');
    const warnings = ['图片中的型号、数字及单位请与原图核对后采用。'];
    if (pages > 1) warnings.push('动画图片仅提取第一帧。');
    return { model: 'local-image', facts, warnings, extractedAt: new Date().toISOString() };
  } finally {
    await worker.terminate();
  }
}

const isImage = workerData.contentType.startsWith('image/');
try {
  const bytes = Buffer.from(workerData.bytes);
  parentPort.postMessage({ extraction: isImage ? await readImage(bytes) : await readPdf(bytes) });
} catch (error) {
  const messages = {
    empty: isImage ? '图片未识别到可读文字，请对照原图。' : 'PDF 未识别到可读文字，请核对原件。',
    large: 'PDF 识别正文过长，请分册提取。',
  };
  parentPort.postMessage({
    error:
      messages[error.message] ||
      (isImage
        ? '无法读取图片，请检查原图尺寸及完整性。'
        : '无法读取 PDF 正文，请检查原件是否损坏、加密或能正常打开。'),
  });
}
