import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { publicAddress, websiteUrl, websiteRedirectUrl, WEBSITE_USER_AGENT } from './branding.mjs';
import { websiteProxyUrl } from './website-proxy.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const dimensions = (contentType, width, height) =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= 65536 &&
  height <= 65536 &&
  width * height <= 100_000_000
    ? { contentType, width, height }
    : null;

function safeImageReference(reference) {
  if (/^#[\w:.-]+$/.test(reference)) return true;
  const data = reference.match(
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/=\r\n\t ]+)$/i,
  );
  if (!data) return false;
  const encoded = data[2].replace(/[\r\n\t ]/g, '');
  if (!/^[a-z\d+/]+={0,2}$/i.test(encoded)) return false;
  const embedded = Buffer.from(encoded, 'base64');
  if (embedded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return false;
  const mime = data[1].toLowerCase();
  // Check a raster signature first so disguised SVG cannot recurse into this parser.
  const raster =
    (mime === 'image/png' &&
      embedded.length >= 8 &&
      embedded.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (mime === 'image/jpeg' && embedded[0] === 255 && embedded[1] === 216) ||
    (mime === 'image/gif' && /^GIF8[79]a$/.test(embedded.toString('ascii', 0, 6))) ||
    (mime === 'image/webp' &&
      embedded.toString('ascii', 0, 4) === 'RIFF' &&
      embedded.toString('ascii', 8, 12) === 'WEBP');
  return raster && inspectBrandImage(embedded)?.contentType === mime;
}

// Inspect bytes rather than trusting an extension or a server's Content-Type.
export function inspectBrandImage(body) {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_BYTES) return null;
  if (
    body.length >= 33 &&
    body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    body.toString('ascii', 12, 16) === 'IHDR'
  )
    return dimensions('image/png', body.readUInt32BE(16), body.readUInt32BE(20));
  if (body.length >= 13 && /^GIF8[79]a$/.test(body.toString('ascii', 0, 6)))
    return dimensions('image/gif', body.readUInt16LE(6), body.readUInt16LE(8));
  if (
    body.length >= 30 &&
    body.toString('ascii', 0, 4) === 'RIFF' &&
    body.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const kind = body.toString('ascii', 12, 16);
    if (kind === 'VP8X')
      return dimensions('image/webp', 1 + body.readUIntLE(24, 3), 1 + body.readUIntLE(27, 3));
    if (kind === 'VP8 ' && body.subarray(23, 26).equals(Buffer.from([157, 1, 42])))
      return dimensions(
        'image/webp',
        body.readUInt16LE(26) & 0x3fff,
        body.readUInt16LE(28) & 0x3fff,
      );
  }
  if (
    body.length >= 25 &&
    body.toString('ascii', 0, 4) === 'RIFF' &&
    body.toString('ascii', 8, 16) === 'WEBPVP8L' &&
    body[20] === 47
  ) {
    const bits = body.readUInt32LE(21);
    return dimensions('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (body.length >= 4 && body[0] === 255 && body[1] === 216) {
    let offset = 2;
    while (offset + 4 <= body.length) {
      if (body[offset++] !== 255) return null;
      while (body[offset] === 255) offset++;
      const marker = body[offset++];
      if (marker === 217 || marker === 218) return null;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > body.length) return null;
      const length = body.readUInt16BE(offset);
      if (length < 2 || offset + length > body.length) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
        return length >= 8
          ? dimensions('image/jpeg', body.readUInt16BE(offset + 5), body.readUInt16BE(offset + 3))
          : null;
      offset += length;
    }
    return null;
  }
  if (body.length >= 22 && body.readUInt16LE(0) === 0 && body.readUInt16LE(2) === 1) {
    const count = body.readUInt16LE(4);
    if (!count || count > 256 || body.length < 6 + count * 16) return null;
    let best;
    for (let i = 0; i < count; i++) {
      const offset = 6 + i * 16;
      const size = body.readUInt32LE(offset + 8);
      const start = body.readUInt32LE(offset + 12);
      if (!size || start < 6 + count * 16 || start + size > body.length) continue;
      const image = dimensions('image/x-icon', body[offset] || 256, body[offset + 1] || 256);
      if (image && (!best || image.width * image.height > best.width * best.height)) best = image;
    }
    return best || null;
  }
  const text = body
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const svg = text.replace(/^<\?xml\b[^?]*\?>\s*/i, '');
  if (!/^<svg\b/i.test(svg) || !(/<\/svg\s*>\s*$/i.test(svg) || /^<svg\b[^>]*\/>\s*$/i.test(svg)))
    return null;
  if (
    /<!(?:DOCTYPE|ENTITY)|<\?xml-stylesheet|<(?:[\w-]+:)?(?:script|foreignObject|iframe|object|embed|audio|video)\b|\son[a-z]+\s*=|@import/i.test(
      text,
    )
  )
    return null;
  for (const match of text.matchAll(/\b(?:[\w-]+:)?(?:href|src)\s*=\s*(["'])([\s\S]*?)\1/gi))
    if (!safeImageReference(match[2])) return null;
  for (const match of text.matchAll(/url\(\s*(["']?)([\s\S]*?)\1\s*\)/gi))
    if (!/^#[\w:.-]+$/.test(match[2])) return null;
  const root = text.match(/<svg\b[^>]*>/i)?.[0] || '';
  const width = Number(root.match(/\bwidth\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i)?.[1]);
  const height = Number(root.match(/\bheight\s*=\s*["'](\d+(?:\.\d+)?)(?:px)?["']/i)?.[1]);
  const viewBox = root.match(
    /\bviewBox\s*=\s*["']\s*([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([\d.e+]+)[\s,]+([\d.e+]+)\s*["']/i,
  );
  const w = width || Number(viewBox?.[3]);
  const h = height || Number(viewBox?.[4]);
  return w && h
    ? dimensions('image/svg+xml', Math.ceil(w), Math.ceil(h))
    : { contentType: 'image/svg+xml' };
}

export function readImageResponse(response, maxBytes = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };
    response.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new Error('品牌图片超过读取上限'));
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    response.on('aborted', () => fail(new Error('品牌图片未完整返回')));
    response.on('close', () => {
      if (!done) fail(new Error('品牌图片未完整返回'));
    });
    response.on('error', fail);
  });
}

function withSignal(promise, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() =>
    signal.removeEventListener('abort', abort),
  );
}

export async function readPublicImage(
  value,
  signal = AbortSignal.timeout(6000),
  { lookupImpl = lookup, requestImpl = request, proxyImpl = websiteProxyUrl } = {},
) {
  let url = websiteUrl(value instanceof URL ? value.href : value);
  for (let hop = 0; hop <= 3; hop++) {
    if (!url) throw new Error('非公网 HTTPS 图片来源');
    signal.throwIfAborted();
    const [addresses, proxy] = await withSignal(
      Promise.all([lookupImpl(url.hostname, { all: true }), proxyImpl()]),
      signal,
    );
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address)))
      throw new Error('非公网图片来源');
    const selected = addresses[0];
    const target = new URL(url);
    if (proxy)
      target.hostname = selected.family === 6 ? '[' + selected.address + ']' : selected.address;
    const agent = proxy ? new Agent({ proxyEnv: { HTTPS_PROXY: proxy.href } }) : new Agent();
    const result = await new Promise((resolve, reject) => {
      const req = requestImpl(
        target,
        {
          agent,
          servername: url.hostname,
          signal,
          method: 'GET',
          maxHeaderSize: 16384,
          headers: {
            Host: url.host,
            'User-Agent': WEBSITE_USER_AGENT,
            Accept: 'image/svg+xml,image/webp,image/png,image/jpeg,image/*;q=0.8',
            'Accept-Encoding': 'identity',
          },
          lookup: (_host, options, callback) =>
            options?.all
              ? callback(null, [selected])
              : callback(null, selected.address, selected.family),
        },
        (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.destroy();
            resolve({ redirect: response.headers.location });
            return;
          }
          if (
            response.statusCode !== 200 ||
            Number(response.headers['content-length']) > MAX_BYTES
          ) {
            response.destroy();
            reject(new Error('品牌图片不可用或超过读取上限'));
            return;
          }
          readImageResponse(response).then((body) => resolve({ body }), reject);
        },
      );
      req.on('close', () => agent.destroy());
      req.on('error', reject);
      req.end();
    });
    if (result.redirect !== undefined) {
      url = websiteRedirectUrl(result.redirect, url);
      continue;
    }
    const image = inspectBrandImage(result.body);
    if (!image) throw new Error('品牌图片格式无效');
    return { body: result.body, ...image };
  }
  throw new Error('品牌图片跳转次数过多');
}
