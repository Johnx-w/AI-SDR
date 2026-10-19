import { readPublicHtml, websiteUrl } from './branding.mjs';
import { extractContacts } from './contact-extractor.mjs';

export async function discoverContacts(lead, { readPage = readPublicHtml } = {}) {
  const initial = websiteUrl(lead.website || (lead.domain ? 'https://' + lead.domain : ''));
  if (!initial) throw Object.assign(new Error('客户尚无可读取的 HTTPS 官网地址'), { status: 422 });
  const domain = initial.hostname.replace(/^www\./, '');
  const queue = [initial, new URL('/', initial)];
  const visited = new Set();
  const checkedUrls = [];
  const failures = [];
  const contacts = [];
  const signal = AbortSignal.timeout(22000);
  for (let page = 0; queue.length && page < 3; ) {
    let url = queue.shift();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    page++;
    try {
      let html = '';
      for (let hop = 0; hop < 3; hop++) {
        const result = await readPage(url, signal);
        if (result.redirect) {
          const next = websiteUrl(result.redirect, url);
          if (!next || next.hostname.replace(/^www\./, '') !== domain)
            throw new Error('官网跳转到了其他站点');
          url = next;
          continue;
        }
        html = result.html || '';
        break;
      }
      if (!html) throw new Error('页面未返回可读取的 HTML');
      checkedUrls.push(url.href);
      contacts.push(
        ...extractContacts({ content: html, sourceUrl: url.href, country: lead.market }),
      );
      if (!queue.some((u) => /contact|about/i.test(u.pathname))) {
        const links = [
          ...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
        ];
        const contact = links.find(
          (m) =>
            /contact(?:[-_]?us)?|联系我们|聯絡/i.test(m[1] + ' ' + m[2].replace(/<[^>]+>/g, ' ')) &&
            /^\/?(?:https?:|[^:#])/i.test(m[1]) &&
            (() => {
              const u = websiteUrl(m[1], url);
              return u && u.hostname.replace(/^www\./, '') === domain && !visited.has(u.href);
            })(),
        );
        if (contact) queue.push(websiteUrl(contact[1], url));
      }
    } catch (e) {
      failures.push({ url: url.href, reason: signal.aborted ? '官网读取超时' : e.message });
    }
    if (signal.aborted) break;
  }
  if (!checkedUrls.length)
    throw Object.assign(new Error('无法读取官网，原有飞书联系方式已保留，请稍后重试。'), {
      status: 502,
    });
  const unique = new Map();
  for (const c of contacts) {
    const key = c.kind + ':' + c.normalized;
    if (!unique.has(key)) unique.set(key, c);
  }
  return {
    contacts: [...unique.values()],
    checkedUrls,
    failures,
    checkedAt: new Date().toISOString(),
    source: 'website',
    persisted: false,
  };
}
