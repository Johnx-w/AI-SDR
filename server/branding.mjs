import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

export function publicAddress(address) {
  if (isIP(address) === 6)
    return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:|10:|20:)/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(
    [0, 10, 127].includes(a) ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}
export function websiteUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      !url.hostname.includes('.') ||
      /(?:^|\.)(?:localhost|local|internal|example|lan|home|test|invalid)$/.test(url.hostname) ||
      (isIP(url.hostname.replace(/[\[\]]/g, '')) &&
        !publicAddress(url.hostname.replace(/[\[\]]/g, '')))
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
const decode = (value) =>
  value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) =>
      String.fromCodePoint(
        Math.min(0x10ffff, n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)),
      ),
    );
const compact = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
export function parseBranding(html, base, companyName) {
  const names = [
    compact(companyName),
    compact(new URL(base).hostname.replace(/^www\./, '').split('.')[0]),
  ].filter((n) => n.length > 3);
  const marks = [];
  for (const tag of html.matchAll(/<(img|link)\b[^>]*>/gi)) {
    const attrs = Object.fromEntries(
      [...tag[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((m) => [
        m[1].toLowerCase(),
        decode(m[2] ?? m[3] ?? m[4] ?? ''),
      ]),
    );
    if (tag[1].toLowerCase() === 'img') {
      const src = attrs['data-src'] || attrs.src || '';
      const alt = attrs.alt || '';
      const url = websiteUrl(src, base);
      if (
        !url ||
        !(/logo|wordmark|brandmark/i.test(url.pathname) || (alt.length < 90 && /logo/i.test(alt)))
      )
        continue;
      const named = names.some((n) => compact(alt + ' ' + url.pathname).includes(n));
      if (!named && !['', 'logo', 'logopng', 'companylogo'].includes(compact(alt))) continue;
      marks.push({ url: url.href, kind: 'logo', rank: named ? 20 : 10 });
    } else if (/(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(attrs.rel || '')) {
      const url = websiteUrl(attrs.href, base);
      if (url) marks.push({ url: url.href, kind: 'website_icon', rank: 1 });
    }
  }
  const unique = new Map();
  for (const { rank, ...mark } of marks.sort((a, b) => b.rank - a.rank))
    if (!unique.has(mark.url)) unique.set(mark.url, mark);
  return [...unique.values()].slice(0, 6);
}
// Never treat a truncated prefix as a complete page: contact links often live in the footer.
export function readHtmlResponse(response, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      reject(e);
    };
    response.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new Error('官网 HTML 超过读取上限，未使用截断页面'));
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      if (done) return;
      done = true;
      resolve({ html: Buffer.concat(chunks).toString('utf8') });
    });
    response.on('aborted', () => fail(new Error('官网 HTML 未完整返回')));
    response.on('error', fail);
  });
}
export async function readPublicHtml(url, signal) {
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error('非公网来源');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        method: 'GET',
        maxHeaderSize: 16384,
        headers: {
          'User-Agent': 'ShadeFlow/0.1 public-website-research',
          Accept: 'text/html',
          'Accept-Encoding': 'identity',
        },
        lookup: (_host, options, callback) =>
          options?.all
            ? callback(null, [selected])
            : callback(null, selected.address, selected.family),
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          return resolve({ redirect: response.headers.location });
        }
        if (response.statusCode !== 200 || !response.headers['content-type']?.includes('html')) {
          response.resume();
          return resolve({ html: '' });
        }
        readHtmlResponse(response).then(resolve, reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}
export async function discoverBranding(lead, { readPage = readPublicHtml } = {}) {
  const initial = websiteUrl(lead.website || (lead.domain ? 'https://' + lead.domain : ''));
  if (!initial) return { candidates: [] };
  const domain = initial.hostname.replace(/^www\./, '');
  let url = new URL('/', initial);
  let candidates = [];
  const signal = AbortSignal.timeout(8000);
  try {
    for (let hop = 0; hop < 3; hop++) {
      const result = await readPage(url, signal);
      if (result.redirect) {
        const next = websiteUrl(result.redirect, url);
        if (!next || next.hostname.replace(/^www\./, '') !== domain) break;
        url = next;
        continue;
      }
      candidates = parseBranding(result.html || '', url.href, lead.name);
      break;
    }
  } catch {
    /* 官网不可访问时保留图标与缩写降级。 */
  }
  const fallback = [
    { url: new URL('/favicon.ico', initial).href, kind: 'website_icon' },
    {
      url: 'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(domain) + '.ico',
      kind: 'website_icon',
      provider: 'DuckDuckGo',
    },
  ];
  return { candidates: [...new Map([...candidates, ...fallback].map((m) => [m.url, m])).values()] };
}
