import { normalizePhone } from './phone-format.mjs';
import { phoneMetadata } from './phone-metadata.mjs';

// 此纯函数同时用于本地官网补全与 n8n 入库节点，避免两条链路使用不同规则。
export function extractContacts({ content, sourceUrl, country = '' }) {
  const decode = (s) =>
    String(s || '')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) =>
        String.fromCodePoint(
          Math.min(0x10ffff, n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)),
        ),
      );
  const unescape = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const visible = (s) =>
    decode(
      String(s)
        .replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' '),
    )
      .replace(/\s+/g, ' ')
      .trim();
  const region = /^(US|USA|United States|美国|CA|Canada|加拿大)$/i.test(country)
    ? 'US'
    : /^(AU|Australia|澳大利亚)$/i.test(country)
      ? 'AU'
      : /^(GB|UK|United Kingdom|英国)$/i.test(country)
        ? 'GB'
        : /^(AE|UAE|United Arab Emirates|阿联酋)$/i.test(country)
          ? 'AE'
          : '';
  const phone = (s) => {
    const raw = unescape(decode(s))
      .replace(/^(?:tel|callto):/i, '')
      .trim();
    const formatted = normalizePhone(raw, country);
    if (formatted) return formatted;
    const metadata = phoneMetadata();
    const knownCountry =
      metadata.regions[String(country).trim().toUpperCase()] ||
      metadata.names[String(country).trim().toLowerCase()];
    // Explicit contact fields can supply a national candidate before the company country
    // is known. The record builder formats it only after evidence confirms that country.
    if (knownCountry || /^(?:\+|00)/.test(raw)) return null;
    const ext = raw.match(/(?:;ext=|\bext\.?\s*|\bx\s*)(\d{1,6})\s*$/i)?.[1] || '';
    const base = raw.replace(/(?:;ext=|\bext\.?\s*|\bx\s*)\d{1,6}\s*$/i, '').trim();
    if (!/^[+\d\s().-]+$/.test(base)) return null;
    const n = base.replace(/\D/g, '');
    if (n.length < 7 || n.length > 15 || /^(\d)\1+$/.test(n)) return null;
    if (/^\d{4}[-.]\d{2}[-.]\d{2}$/.test(base)) return null;
    return {
      value: base + (ext ? ' ext. ' + ext : ''),
      normalized: 'national:' + n + (ext ? ';ext=' + ext : ''),
      raw_value: raw,
    };
  };
  const found = [];
  const html = String(content || '');
  const lowerHtml = html.toLowerCase();
  const pageVisible = visible(html);
  const faxPrefix = (s) =>
    /(?:fax(?:\s*(?:number|no\.?))?|传真(?:号码)?)\s*[:：]?\s*\[?\s*$/i.test(s);
  const add = (kind, value, method, quote, primary = false) => {
    if (kind === 'phone') {
      const parsed = phone(value);
      if (!parsed) return;
      found.push({
        kind,
        ...parsed,
        source_url: sourceUrl,
        quote: visible(quote).slice(0, 320),
        method,
        primary,
        status: '公开未验证',
      });
    } else {
      const email = unescape(decode(value))
        .replace(/^mailto:/i, '')
        .split('?')[0]
        .trim();
      if (
        !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email) ||
        /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(email) ||
        /@(?:example\.(?:com|org)|domain\.com)$/i.test(email)
      )
        return;
      found.push({
        kind: 'email',
        value: email,
        normalized: email.toLowerCase(),
        source_url: sourceUrl,
        quote: visible(quote).slice(0, 320),
        method,
        status: '公开未验证',
      });
    }
  };
  // 链接比正文更明确；显示文本和 tel URI 采用同一规范值去重。
  for (const a of html.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a>/gi)) {
    const href = decode(
      a[1]
        .match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
        ?.slice(1)
        .find((v) => v !== undefined) || '',
    );
    const label = visible(a[2]);
    const index = label ? pageVisible.indexOf(label) : -1;
    const context =
      index >= 0 ? pageVisible.slice(Math.max(0, index - 90), index + label.length + 160) : href;
    if (/^(tel|callto):/i.test(href)) {
      if (
        /^fax\b|^传真/i.test(label) ||
        (index >= 0 && faxPrefix(pageVisible.slice(Math.max(0, index - 45), index)))
      )
        continue;
      add(
        'phone',
        phone(label)?.normalized === phone(href)?.normalized ? label : href,
        'tel_link',
        context,
        ['header', 'nav', 'footer'].some((tag) => {
          return (
            lowerHtml.lastIndexOf('<' + tag, a.index) > lowerHtml.lastIndexOf('</' + tag, a.index)
          );
        }),
      );
    }
    if (/^mailto:/i.test(href)) add('email', href, 'mailto_link', context);
  }
  for (const m of html.matchAll(/\]\(\s*((?:tel|callto|mailto):[^\s<>]+)\s*\)/gi)) {
    if (
      !/^mailto/i.test(m[1]) &&
      /(?:fax(?:\s*(?:number|no\.?))?|传真(?:号码)?)\s*[:：]?\s*\[[^\]]*$/i.test(
        visible(html.slice(Math.max(0, m.index - 100), m.index)),
      )
    )
      continue;
    add(
      /^mailto/i.test(m[1]) ? 'email' : 'phone',
      m[1],
      'markdown_link',
      html.slice(Math.max(0, m.index - 70), m.index + m[0].length + 100),
    );
  }
  // JSON-LD 中的 telephone / email 是显式联系字段，不扫描普通脚本中的数字。
  const walk = (v, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 15) return;
    for (const [k, x] of Object.entries(v)) {
      if (/^(telephone|faxNumber|email)$/i.test(k)) {
        if (k.toLowerCase() === 'faxnumber') continue;
        for (const value of Array.isArray(x) ? x : [x])
          if (typeof value === 'string')
            add(
              k === 'email' ? 'email' : 'phone',
              value,
              'json_ld',
              k + ': ' + value,
              depth <= 2 &&
                /Organization|LocalBusiness|Corporation|Store|Business/.test(
                  String(v['@type'] || ''),
                ),
            );
      } else if (x && typeof x === 'object') walk(x, depth + 1);
    }
  };
  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ))
    try {
      walk(JSON.parse(m[1]));
    } catch {
      /* 无效结构化数据不会中断其他提取。 */
    }
  // Cloudflare 的公开邮件保护编码在浏览器中也通过同样的 XOR 方式还原。
  for (const m of html.matchAll(
    /(?:data-cfemail\s*=\s*["']|\/cdn-cgi\/l\/email-protection#)([0-9a-f]{6,})/gi,
  )) {
    const h = m[1];
    if (h.length % 2) continue;
    const key = parseInt(h.slice(0, 2), 16);
    let email = '';
    for (let i = 2; i < h.length; i += 2)
      email += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ key);
    add('email', email, 'protected_email', '公开邮件链接：' + email);
  }
  const text = visible(html).replace(/https?:\/\/[^\s<>]+/gi, ' ');
  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi))
    add(
      'email',
      m[0],
      'visible_text',
      text.slice(Math.max(0, m.index - 65), m.index + m[0].length + 100),
    );
  const patterns = [/(?<![\w\d])\+[1-9](?:[\s().-]*\d){6,14}(?!\d)/g];
  if (region === 'US')
    patterns.push(
      /(?<![\w\d])(?:1[\s.-]+)?(?:\([2-9]\d{2}\)[\s.-]*|[2-9]\d{2}[\s.-]+)[2-9]\d{2}[\s.-]+\d{4}(?!\d)/g,
    );
  if (region === 'AU') patterns.push(/\b(?:0[23478](?:[\s().-]*\d){8}|1[38]00(?:[\s.-]*\d){6})\b/g);
  if (['GB', 'AE'].includes(region)) patterns.push(/\b0(?:[\s().-]*\d){8,10}\b/g);
  for (const m of text.matchAll(
    /(?:\b(?:phone|telephone|tel|mobile|call(?:\s+us)?|toll[- ]?free)(?:\s+(?:number|no\.?))?|电话|聯絡電話)\s*[:：@]?\s*(?:\*\*|\[)?(\+?[\d(][\d\s().-]{5,30}\d(?:\s*(?:ext\.?|x)\s*\d{1,6})?)/gi,
  )) {
    // Markdown tel URIs have already passed the link-specific fax checks above.
    if (/^tel\s*:/i.test(m[0]) && /[("'=]$/.test(text.slice(0, m.index))) continue;
    if (faxPrefix(text.slice(Math.max(0, m.index - 45), m.index))) continue;
    add(
      'phone',
      m[1],
      'labeled_text',
      text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 100),
    );
  }
  for (const pattern of patterns)
    for (const m of text.matchAll(pattern)) {
      if (faxPrefix(text.slice(Math.max(0, m.index - 45), m.index))) continue;
      add(
        'phone',
        m[0],
        'visible_text',
        text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 120),
      );
    }
  // A contact page link is not proof of a usable enquiry form. Keep actual
  // HTML controls and their submission path as auditable source evidence;
  // never submit the form or infer JavaScript-only handlers.
  const attributes = (tag) =>
    Object.fromEntries(
      [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((match) => [
        match[1].toLowerCase(),
        decode(match[2] ?? match[3] ?? match[4] ?? ''),
      ]),
    );
  const formHtml = html
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/<(script|style|svg|template|noscript)\b[^>]*>[^]*?<\/\1\s*>/gi, ' ');
  for (const form of formHtml.matchAll(/<form\b([^>]*)>([^]*?)<\/form\s*>/gi)) {
    if (form[0].length > 32000) continue;
    const attrs = attributes(form[1]);
    if (
      String(attrs.method || '').toLowerCase() !== 'post' ||
      /\bhidden\b/i.test(form[1]) ||
      attrs['aria-hidden'] === 'true' ||
      /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style || '')
    )
      continue;
    const controls = [...form[2].matchAll(/<(input|textarea)\b([^>]*)>/gi)]
      .filter((control) => !/\b(?:disabled|hidden|readonly)\b/i.test(control[2]))
      .map((control) => ({ tag: control[1].toLowerCase(), ...attributes(control[2]) }));
    if (controls.some((control) => /^(?:password|search)$/i.test(control.type || ''))) continue;
    const email = controls.some(
      (control) =>
        /^(?:email)$/i.test(control.type || '') ||
        (!/^(?:hidden|submit|button|checkbox|radio|file)$/i.test(control.type || '') &&
          /(?:^|[^a-z])e[-_]?mail(?:$|[^a-z])/i.test(control.name || '')),
    );
    const message = controls.some(
      (control) =>
        control.tag === 'textarea' ||
        (!/^(?:hidden|submit|button|checkbox|radio|file)$/i.test(control.type || '') &&
          /(?:^|[^a-z])(?:message|enquiry|inquiry)(?:$|[^a-z])/i.test(control.name || '')),
    );
    const submitButtons = [...form[2].matchAll(/<button\b([^>]*)>([^]*?)<\/button\s*>/gi)]
      .filter(
        (button) =>
          !/\bdisabled\b/i.test(button[1]) &&
          /^(?:submit)?$/i.test(attributes(button[1]).type || ''),
      )
      .map((button) => visible(button[2]));
    const submitInputs = controls
      .filter((control) => /^(?:submit|image)$/i.test(control.type || ''))
      .map((control) => control.value || control.alt || '');
    const submits = [...submitButtons, ...submitInputs];
    if (!email || !message || !submits.length) continue;
    // Classify the form's own identity/action/primary submission, rather than
    // optional newsletter checkboxes inside a genuine sales enquiry form.
    const purpose = [attrs.id, attrs.name, attrs.action, ...submits]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z]+/g, ' ');
    if (
      /\b(?:newsletter|subscribe|login|signin|signup|register|registration|password|search|download|comments?|reviews?|careers?|jobs?)\b|\bsign (?:in|up)\b|\blog in\b/.test(
        purpose,
      )
    )
      continue;
    let source, action;
    try {
      source = new URL(sourceUrl);
      action = new URL(attrs.action || source.href, source);
      if (
        [source, action].some(
          (url) =>
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            !url.hostname.includes('.') ||
            /^[\d.]+$/.test(url.hostname) ||
            /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(url.hostname),
        )
      )
        continue;
    } catch {
      continue;
    }
    found.push({
      kind: 'form',
      value: source.href,
      normalized: action.href,
      action_url: action.href,
      source_url: sourceUrl,
      quote: form[0],
      method: 'business_contact_form',
      status: '公开未验证',
    });
  }
  return [...new Map(found.map((c) => [c.kind + ':' + c.normalized, c])).values()]
    .map((c) => {
      const first = found.find((f) => f.kind === c.kind && f.normalized === c.normalized);
      return first;
    })
    .slice(0, 40);
}
