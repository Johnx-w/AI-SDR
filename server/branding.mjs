import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { isIP } from 'node:net';
import { websiteProxyUrl } from './website-proxy.mjs';

export const WEBSITE_USER_AGENT = 'Mozilla/5.0';

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

// Some sites canonicalize apex HTTPS URLs to an HTTP www URL even though the
// canonical host supports HTTPS. Try its secure form without following HTTP.
export function websiteRedirectUrl(value, base) {
  const current = websiteUrl(base instanceof URL ? base.href : base);
  if (!current) return null;
  try {
    const next = new URL(value, current);
    if (
      next.protocol === 'http:' &&
      !next.port &&
      next.hostname.replace(/^www\./, '') === current.hostname.replace(/^www\./, '')
    )
      next.protocol = 'https:';
    return websiteUrl(next.href);
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
const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((m) => [
      m[1].toLowerCase(),
      decode(m[2] ?? m[3] ?? m[4] ?? ''),
    ]),
  );
const brandWords = /logo|wordmark|brandmark|site[-_ ]?branding|navbar[-_ ]?brand/i;
const unrelatedBrand =
  /partner|sponsor|payment|paypal|visa|mastercard|facebook|instagram|linkedin|youtube|pinterest|trustpilot|badge|certification|placeholder|spinner|loading/i;

function imageSources(attrs, base, pictureSources = []) {
  const sources = [];
  const add = (value, width = 0) => {
    // Reject unresolved templates, placeholder data URLs and accidental srcset values in src.
    if (!value || /[\s<>`{}]|,\s*(?:https?:)?\/\//.test(value)) return;
    const url = websiteUrl(value, base);
    if (url) sources.push({ url, width });
  };
  for (const set of [
    ...pictureSources,
    attrs['data-srcset'],
    attrs['data-lazy-srcset'],
    attrs.srcset,
  ]) {
    for (const item of (set || '').split(',')) {
      const match = item.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/);
      if (match) add(match[1], Number(match[2] || 1) * (match[3] === 'x' ? 320 : 1));
    }
  }
  for (const field of ['data-src', 'data-lazy-src', 'data-original', 'src'])
    add(attrs[field], Number(attrs.width) || 0);
  // An SVG stays sharp at any size. For bitmaps prefer the largest available source up
  // to 1280px, without downloading multi-megapixel originals just for an avatar.
  return sources.sort((a, b) => {
    const quality = (source) =>
      /\.svg$/i.test(source.url.pathname)
        ? 10000
        : source.width >= 160 && source.width <= 1280
          ? 4000 + source.width
          : source.width > 1280
            ? 2000 - source.width / 10000
            : source.width;
    return quality(b) - quality(a);
  });
}
export function parseBranding(html, base, companyName) {
  const names = [
    compact(companyName),
    compact(new URL(base).hostname.replace(/^www\./, '').split('.')[0]),
  ].filter((n) => n.length > 3);
  const marks = [];
  const stack = [];
  const page = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  let count = 0;
  for (const tag of page.matchAll(/<(\/?)([a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    if (++count > 30000) break;
    const name = tag[2].toLowerCase();
    if (tag[1]) {
      const index = stack.findLastIndex((entry) => entry.name === name);
      if (index >= 0) stack.length = index;
      continue;
    }
    const attrs = attributes(tag[3]);
    const label = [attrs.class, attrs.id, attrs.role, attrs['aria-label']]
      .filter(Boolean)
      .join(' ');
    if (name === 'source') {
      const picture = stack.findLast((entry) => entry.name === 'picture');
      if (picture) picture.sources.push(attrs['data-srcset'] || attrs.srcset || '');
    } else if (name === 'img') {
      const picture = stack.findLast((entry) => entry.name === 'picture');
      const sources = imageSources(attrs, base, picture?.sources);
      const url = sources[0]?.url;
      if (!url) continue;
      const alt = (attrs.alt || '').slice(0, 160);
      const identity = alt + ' ' + url.pathname + ' ' + label;
      const context = stack.map((entry) => entry.label).join(' ');
      if (
        unrelatedBrand.test(identity) ||
        /partner|sponsor|payment|social[-_ ]?(?:links|icons|media)|logo[-_ ]?(?:list|slider|carousel)|splide__slide/i.test(
          context,
        )
      )
        continue;
      const inHeader = stack.some(
        (entry) =>
          /^(?:header|nav)$/.test(entry.name) ||
          /header|navbar|(?:^|[-_\s])nav(?:$|[-_\s])|site[-_ ]?branding|^banner$/i.test(
            entry.label,
          ),
      );
      const homeLink = stack.some((entry) => {
        if (entry.name !== 'a' || !entry.attrs.href) return false;
        const href = websiteUrl(entry.attrs.href, base);
        return (
          href &&
          href.origin === new URL(base).origin &&
          /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i.test(href.pathname)
        );
      });
      const branded = brandWords.test(
        label +
          ' ' +
          stack
            .slice(-3)
            .map((entry) => entry.label)
            .join(' '),
      );
      const named = names.some((n) => compact(alt + ' ' + url.pathname).includes(n));
      const logoNamed = brandWords.test(url.pathname) || (alt.length < 90 && brandWords.test(alt));
      const generic = ['', 'logo', 'logopng', 'companylogo'].includes(compact(alt));
      if (!(logoNamed || branded || (named && inHeader && homeLink))) continue;
      const genericFilename = /(?:^|\/)(?:logo|wordmark|brandmark)(?:[-_.]|$)/i.test(url.pathname);
      if (
        !(
          named ||
          (generic && (stack.length === 0 || genericFilename)) ||
          (homeLink && (inHeader || branded))
        )
      )
        continue;
      const rank =
        20 +
        (named ? 25 : 0) +
        (inHeader ? 50 : 0) +
        (homeLink ? 25 : 0) +
        (branded ? 20 : 0) -
        (stack.some((entry) => entry.name === 'footer') ? 10 : 0);
      marks.push({
        url: url.href,
        kind: 'logo',
        rank,
        ...(/white|[-_]ko[._-]/i.test(url.pathname) ? { background: 'dark' } : {}),
      });
    } else if (
      name === 'link' &&
      /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(attrs.rel || '')
    ) {
      const url = websiteUrl(attrs.href, base);
      const size = Number((attrs.sizes || '').match(/^(\d+)x\d+$/)?.[1] || 0);
      if (url)
        marks.push({ url: url.href, kind: 'website_icon', rank: -20 + Math.min(size, 512) / 1000 });
    }
    if (
      !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name) &&
      !/\/\s*$/.test(tag[3]) &&
      stack.length < 64
    )
      stack.push({ name, attrs, label, sources: [] });
  }
  // Sites with a text-only header can still explicitly publish their brand in
  // structured data. Only accept a logo on an organization belonging to this site.
  const domain = new URL(base).hostname.replace(/^www\./, '');
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (attributes(script[1]).type !== 'application/ld+json' || script[2].length > 512000) continue;
    try {
      const nodes = [JSON.parse(script[2])];
      for (let index = 0; index < nodes.length && index < 1000; index++) {
        const node = nodes[index];
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) {
          nodes.push(...node.slice(0, 1000 - nodes.length));
          continue;
        }
        const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
        const organization = types.some((type) =>
          /(?:Organization|Corporation|Business|Store|Manufacturer)$/i.test(type || ''),
        );
        const identityValue = typeof node.url === 'string' ? node.url : node['@id'];
        const identity =
          typeof identityValue === 'string' && identityValue
            ? websiteUrl(identityValue, base)
            : null;
        if (organization && identity?.hostname.replace(/^www\./, '') === domain && node.logo) {
          const logo =
            typeof node.logo === 'string' ? node.logo : node.logo.url || node.logo.contentUrl;
          if (typeof logo === 'string') {
            const url = websiteUrl(logo, base);
            if (url)
              marks.push({
                url: url.href,
                kind: 'logo',
                rank: 30,
                ...(/white|[-_]ko[._-]/i.test(url.pathname) ? { background: 'dark' } : {}),
              });
          }
        }
        if (nodes.length < 1000)
          nodes.push(
            ...Object.values(node)
              .filter((value) => value && typeof value === 'object')
              .slice(0, 1000 - nodes.length),
          );
      }
    } catch {
      // Malformed JSON-LD does not invalidate normal header and icon candidates.
    }
  }
  const unique = new Map();
  for (const { rank, ...mark } of marks.sort((a, b) => b.rank - a.rank)) {
    const identity = new URL(mark.url);
    for (const key of ['width', 'height', 'w', 'h']) identity.searchParams.delete(key);
    if (!unique.has(identity.href)) unique.set(identity.href, mark);
  }
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
    response.on('close', () => {
      if (!done) fail(new Error('官网 HTML 未完整返回'));
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

export async function readPublicHtml(
  url,
  signal = AbortSignal.timeout(8000),
  { lookupImpl = lookup, requestImpl = request, proxyImpl = websiteProxyUrl } = {},
) {
  if (!websiteUrl(url.href)) throw new Error('非公网 HTTPS 来源');
  signal.throwIfAborted();
  const [addresses, proxy] = await withSignal(
    Promise.all([lookupImpl(url.hostname, { all: true }), proxyImpl()]),
    signal,
  );
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error('非公网来源');
  const selected = addresses[0];
  const target = new URL(url);
  if (proxy)
    target.hostname = selected.family === 6 ? '[' + selected.address + ']' : selected.address;
  // CONNECT uses the already validated IP, while Host/SNI and certificate
  // verification still identify the original website. Never let a proxy redo DNS.
  const agent = proxy ? new Agent({ proxyEnv: { HTTPS_PROXY: proxy.href } }) : new Agent();
  return new Promise((resolve, reject) => {
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
    req.on('close', () => agent.destroy());
    req.on('error', reject);
    req.end();
  });
}
export async function discoverBranding(
  lead,
  { readPage = readPublicHtml, signal = AbortSignal.timeout(8000) } = {},
) {
  const initial = websiteUrl(lead.website || (lead.domain ? 'https://' + lead.domain : ''));
  if (!initial) return { candidates: [] };
  const domain = initial.hostname.replace(/^www\./, '');
  let url = new URL('/', initial);
  let candidates = [];
  try {
    for (let hop = 0; hop < 3; hop++) {
      const result = await readPage(url, signal);
      if (result.redirect) {
        const next = websiteRedirectUrl(result.redirect, url);
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
