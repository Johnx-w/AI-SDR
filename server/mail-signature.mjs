import { createHash } from 'node:crypto';
import { inspectBrandImage } from './branding-image.mjs';
import { MAX_SIGNATURE_LOGO_BYTES } from '../src/domain/mail-signature.mjs';

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function signatureImage(source) {
  if (typeof source !== 'string' || source.length > MAX_SIGNATURE_LOGO_BYTES * 1.4 + 100)
    return null;
  const match = source.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/u);
  if (!match) return null;
  const content = Buffer.from(match[2], 'base64');
  if (content.length > MAX_SIGNATURE_LOGO_BYTES || content.toString('base64') !== match[2])
    return null;
  const image = inspectBrandImage(content);
  return image?.contentType === match[1] && image.width <= 4096 && image.height <= 4096
    ? { contentType: image.contentType, content }
    : null;
}

export function normalizeSignatureDesign(input) {
  if (input == null) return null;
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) => !['closing', 'companyName', 'address', 'website', 'logo', 'logoWidth'].includes(key),
    )
  )
    throw invalid('邮件签名格式不正确');
  const design = {};
  for (const [key, maximum] of Object.entries({
    closing: 160,
    companyName: 160,
    address: 1000,
    website: 2000,
  })) {
    const value = input[key] ?? '';
    if (
      typeof value !== 'string' ||
      value.length > maximum ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
      (key !== 'address' && /[\r\n]/u.test(value))
    )
      throw invalid('签名资料格式不正确或内容过长');
    design[key] = value.trim();
  }
  if (design.website) {
    try {
      const url = new URL(
        design.website.includes('://') ? design.website : 'https://' + design.website,
      );
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
      design.website = url.href;
    } catch {
      throw invalid('请填写有效的公司官网地址');
    }
  }
  design.logoWidth = input.logoWidth ?? 160;
  if (!Number.isSafeInteger(design.logoWidth) || design.logoWidth < 80 || design.logoWidth > 320)
    throw invalid('Logo 显示宽度应为 80–320 像素');
  design.logo = null;
  if (input.logo != null) {
    const logo = input.logo;
    if (
      !object(logo) ||
      Object.keys(logo).some((key) => !['name', 'contentType', 'contentBase64'].includes(key)) ||
      typeof logo.name !== 'string' ||
      !logo.name.trim() ||
      logo.name.length > 255 ||
      /[\u0000-\u001f\u007f/\\]/u.test(logo.name) ||
      !['image/png', 'image/jpeg'].includes(logo.contentType) ||
      typeof logo.contentBase64 !== 'string' ||
      !signatureImage(`data:${logo.contentType};base64,${logo.contentBase64}`)
    )
      throw invalid('Logo 需要是 256 KB 以内、尺寸不超过 4096 像素的 PNG 或 JPG 图片');
    design.logo = {
      name: logo.name.trim(),
      contentType: logo.contentType,
      contentBase64: logo.contentBase64,
    };
  }
  return design;
}

// Embed uploaded images in both SMTP and the saved Sent copy without fetching URLs.
export function embedSignatureImages(html) {
  const attachments = new Map();
  const body = html.replace(
    /\bsrc="(data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+)"/gu,
    (_all, source) => {
      const image = signatureImage(source);
      if (!image) throw invalid('邮件中的 Logo 图片无效，请重新上传');
      const cid = createHash('sha256').update(image.content).digest('hex') + '@signature';
      attachments.set(cid, {
        filename: image.contentType === 'image/png' ? 'company-logo.png' : 'company-logo.jpg',
        contentType: image.contentType,
        content: image.content,
        contentDisposition: 'inline',
        cid,
      });
      return `src="cid:${cid}"`;
    },
  );
  return { html: body, attachments: [...attachments.values()] };
}
