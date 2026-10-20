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
  const region = /^(US|USA|United States|美国)$/i.test(country)
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
    const ext = raw.match(/(?:;ext=|\bext\.?\s*|\bx\s*)(\d{1,6})\s*$/i)?.[1] || '';
    let base = raw.replace(/(?:;ext=|\bext\.?\s*|\bx\s*)\d{1,6}\s*$/i, '').trim();
    if (!/^[+\d\s().-]+$/.test(base)) return null;
    let n = base.replace(/\D/g, '');
    if (n.length < 7 || n.length > 15 || /^(\d)\1+$/.test(n)) return null;
    if (base.startsWith('00')) {
      n = n.slice(2);
      base = '+' + n;
    }
    let normalized;
    if (base.startsWith('+')) normalized = '+' + n;
    else if (region === 'US' && n.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(n))
      normalized = '+1' + n;
    else if (region === 'US' && n.length === 11 && /^1[2-9]\d{2}[2-9]\d{6}$/.test(n))
      normalized = '+' + n;
    else if (region === 'AU' && /^0[23478]\d{8}$/.test(n)) normalized = '+61' + n.slice(1);
    else if (region === 'AU' && /^1[38]00\d{6}$/.test(n)) normalized = n;
    else if (region === 'GB' && /^0\d{9,10}$/.test(n)) normalized = '+44' + n.slice(1);
    else if (region === 'AE' && /^0[234679]\d{7}$/.test(n)) normalized = '+971' + n.slice(1);
    else if (region === 'AE' && /^05\d{8}$/.test(n)) normalized = '+971' + n.slice(1);
    else if (!region && !base.startsWith('+')) normalized = n;
    else return null;
    if (normalized.startsWith('+1') && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(normalized)) return null;
    if (normalized.startsWith('+61') && !/^\+61[23478]\d{8}$/.test(normalized)) return null;
    if (normalized.startsWith('+44') && !/^\+44\d{9,10}$/.test(normalized)) return null;
    if (normalized.startsWith('+971') && !/^\+971\d{8,9}$/.test(normalized)) return null;
    return {
      value: base + (ext ? ' ext. ' + ext : ''),
      normalized: normalized + (ext ? ';ext=' + ext : ''),
    };
  };
  const found = [];
  const html = String(content || '');
  const pageVisible = visible(html);
  const faxPrefix = (s) =>
    /(?:fax(?:\s*(?:number|no\.?))?|传真(?:号码)?)\s*[:：]?\s*\[?\s*$/i.test(s);
  const add = (kind, value, method, quote) => {
    if (kind === 'phone') {
      const parsed = phone(value);
      if (!parsed) return;
      found.push({
        kind,
        ...parsed,
        source_url: sourceUrl,
        quote: visible(quote).slice(0, 320),
        method,
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
            add(k === 'email' ? 'email' : 'phone', value, 'json_ld', k + ': ' + value);
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
      /(?<![\w\d])(?:1[\s.-]+)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]+[2-9]\d{2}[\s.-]+\d{4}(?!\d)/g,
    );
  if (region === 'AU') patterns.push(/\b(?:0[23478](?:[\s().-]*\d){8}|1[38]00(?:[\s.-]*\d){6})\b/g);
  if (['GB', 'AE'].includes(region)) patterns.push(/\b0(?:[\s().-]*\d){8,10}\b/g);
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
  return [...new Map(found.map((c) => [c.kind + ':' + c.normalized, c])).values()]
    .map((c) => {
      const first = found.find((f) => f.kind === c.kind && f.normalized === c.normalized);
      return first;
    })
    .slice(0, 40);
}
