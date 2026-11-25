import { XMLParser } from 'fast-xml-parser';
import { Open } from 'unzipper-esm';
import { posix } from 'node:path';
import sharp from 'sharp';

const many = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
});
export function photoRows(photos) {
  // Distinct occurrences of the same printed name can be different variants.
  // The reply matcher asks for clarification when it finds several rows.
  return photos.map((p, i) => [
    p.sheet,
    i + 1,
    p.item,
    JSON.stringify([{ ref: 'A' + (i + 1), field: '产品', value: p.item }]),
  ]);
}
export async function jpegPreview(bytes) {
  return sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 })
    .rotate()
    .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: 'white' })
    .jpeg({ quality: 72 })
    .toBuffer();
}
// Follow package relationships: drawing numbers and worksheet order can differ.
export async function workbookPictures(bytes, owners, warnings) {
  const zip = await Open.buffer(bytes);
  const files = new Map(zip.files.map((e) => [e.path, e]));
  const photos = [];
  if (![...files.keys()].some((p) => p.startsWith('xl/media/'))) return photos;
  async function xml(path) {
    const entry = files.get(path);
    if (!entry) return {};
    const source = (await entry.buffer()).toString('utf8');
    if (/<!DOCTYPE/i.test(source)) throw Error('工作簿 XML 无效');
    return parser.parse(source);
  }
  async function targets(path) {
    const rel = await xml(posix.join(posix.dirname(path), '_rels', posix.basename(path) + '.rels'));
    return new Map(
      many(rel.Relationships?.Relationship)
        .filter((r) => r['@_TargetMode'] !== 'External')
        .map((r) => [r['@_Id'], posix.resolve('/', posix.dirname(path), r['@_Target']).slice(1)]),
    );
  }
  const book = 'xl/workbook.xml',
    sheets = (await xml(book)).workbook?.sheets,
    parts = await targets(book);
  let unassigned = 0,
    total = 0;
  for (const s of many(sheets?.sheet)) {
    const sheet = s['@_name'].replaceAll('&amp;', '&'),
      path = parts.get(s['@_id']);
    if (!path) continue;
    const sheetRels = await targets(path);
    for (const drawing of many((await xml(path)).worksheet?.drawing)) {
      const path = sheetRels.get(drawing['@_id']);
      if (!path) continue;
      const doc = (await xml(path)).wsDr,
        images = await targets(path);
      for (const anchor of [
        ...many(doc?.oneCellAnchor),
        ...many(doc?.twoCellAnchor),
        ...many(doc?.absoluteAnchor),
      ]) {
        if (!anchor.pic) continue;
        const row = Number(anchor.from?.row) + 1,
          item =
            owners.get(sheet)?.get(row + ',' + Number(anchor.from?.col)) ??
            owners.get(sheet)?.get(row);
        const file = files.get(images.get(anchor.pic.blipFill?.blip?.['@_embed']));
        if (
          !item ||
          !file ||
          Number(anchor.to?.row) > row ||
          (Number(anchor.to?.row) === row && Number(anchor.to?.rowOff) > 0)
        ) {
          unassigned++;
          continue;
        }
        try {
          const jpeg = await jpegPreview(await file.buffer());
          if (jpeg.length > 524288) {
            unassigned++;
            continue;
          }
          total += jpeg.length;
          if (total > 64 * 1024 * 1024) throw Error('图片预览超限');
          photos.push({ sheet, item, origin: sheet + ' · 第 ' + row + ' 行', jpeg });
        } catch (e) {
          if (total > 64 * 1024 * 1024) throw e;
          unassigned++;
        }
      }
    }
  }
  if (unassigned) warnings.push(unassigned + ' 张插图需核对所属产品，可在原件中查看。');
  return photos;
}
