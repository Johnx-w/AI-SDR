import sharp from 'sharp';

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
export async function workbookPictures(pictures, owners, warnings) {
  const photos = [];
  let total = 0;
  for (const { sheet, row, col, singleRow, image } of pictures) {
    const item = owners.get(sheet)?.get(row + ',' + col) ?? owners.get(sheet)?.get(row);
    if (!item || !singleRow || !image) continue;
    let jpeg;
    try {
      jpeg = await jpegPreview(Buffer.from(image, 'base64'));
    } catch {
      continue;
    }
    if (jpeg.length > 524288) continue;
    total += jpeg.length;
    if (total > 64 * 1024 ** 2) throw Error('图片预览超限');
    photos.push({ sheet, item, origin: sheet + ' · 第 ' + row + ' 行', jpeg });
  }
  const missing = pictures.length - photos.length;
  if (missing) warnings.push(missing + ' 张插图需核对所属产品，可在原件中查看。');
  return photos;
}
