import { extractContacts } from './contact-extractor.mjs';
// These helpers are also embedded in n8n Code nodes; keep them dependency-free.
export function websiteTextExcerpt(content, limit = 12000) {
  const text = String(content || '')
    .replace(/!\[[^\]]*\]\(\s*data:[^)]*\)/gi, '')
    .replace(/<img\b[^>]*\bsrc\s*=\s*["']data:[^>]*>/gi, '')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim();
  if (text.length <= limit) return text;
  const tail = Math.min(4000, Math.floor(limit / 3));
  return text.slice(0, limit - tail - 2) + '\n\n' + text.slice(-tail);
}
export function websiteScope(value, base = '') {
  let text = String(value || '')
    .trim()
    .replace(/&amp;/g, '&');
  const origin = /^(https:\/\/[^/?#]+)/i.exec(String(base))?.[1];
  if (text.startsWith('//')) text = 'https:' + text;
  else if (!/^[a-z][\w+.-]*:/i.test(text) && origin) {
    if (text.startsWith('/')) text = origin + text;
    else
      text =
        (String(base).slice(origin.length).includes('/')
          ? String(base)
              .replace(/[?#].*$/, '')
              .replace(/[^/]*$/, '')
          : origin + '/') + text;
  }
  const match = /^https:\/\/([a-z0-9.-]+)(\/[^#]*)?(?:#.*)?$/i.exec(text);
  if (!match || text.length > 2500) return null;
  const host = match[1].toLowerCase().replace(/\.$/, '');
  if (
    !host.includes('.') ||
    /^\d+(\.\d+){3}$/.test(host) ||
    /(^|\.)(localhost|local|internal|test|invalid|example|lan)$/.test(host)
  )
    return null;
  const path = (match[2] || '/').split('?')[0];
  if (path.includes('..') || /%2e|%2f|%5c/i.test(path)) return null;
  return {
    url: 'https://' + host + (match[2] || '/'),
    host,
    domain: host.replace(/^www\./, ''),
    origin: 'https://' + host,
    path,
  };
}

export function extractWebsiteMetadata({ content, sourceUrl }) {
  const html = String(content || '');
  const decode = (value) =>
    String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;|&#160;/g, ' ');
  const plain = (value) =>
    decode(value)
      .replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const social = [];
  const addresses = [];
  const snippets = [];
  const serviceAreas = [];
  const source = websiteScope(sourceUrl);
  if (!source) return { social, addresses, snippets, service_areas: serviceAreas };
  const addArea = (value, method, quote, sectionQuote) => {
    if (Array.isArray(value)) {
      value.forEach((v) => addArea(v, method, quote, sectionQuote));
      return;
    }
    const name = typeof value === 'string' ? value.trim() : value?.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 300 || /^https?:/i.test(name))
      return;
    const parent = typeof value === 'object' ? value.containedInPlace?.name : null;
    serviceAreas.push({
      name: name.trim() + (parent ? ', ' + parent : ''),
      type: typeof value === 'object' ? value['@type'] || null : null,
      source_url: sourceUrl,
      method,
      quote: String(quote).slice(0, 1500),
      ...(sectionQuote ? { section_quote: sectionQuote } : {}),
    });
  };
  const countryName = (value) => {
    const raw = typeof value === 'object' ? value?.name || value?.['@id'] : value;
    const countries = {
      US: 'United States',
      USA: 'United States',
      'UNITED STATES': 'United States',
      'UNITED STATES OF AMERICA': 'United States',
      AU: 'Australia',
      AUS: 'Australia',
      AUSTRALIA: 'Australia',
      GB: 'United Kingdom',
      UK: 'United Kingdom',
      'UNITED KINGDOM': 'United Kingdom',
      CA: 'Canada',
      CANADA: 'Canada',
      AE: 'United Arab Emirates',
      UAE: 'United Arab Emirates',
      'UNITED ARAB EMIRATES': 'United Arab Emirates',
      NZ: 'New Zealand',
      'NEW ZEALAND': 'New Zealand',
    };
    return (
      countries[
        String(raw || '')
          .trim()
          .toUpperCase()
      ] ||
      String(raw || '').trim() ||
      null
    );
  };
  const addSocial = (raw, method, quote) => {
    const u = websiteScope(decode(raw).replace(/^http:\/\//i, 'https://'), sourceUrl);
    if (!u) return;
    const host = u.host.replace(/^(www|m|mobile)\./, '');
    const parts = u.path.split('/').filter(Boolean);
    let platform;
    let url = u.url.split(/[?#]/)[0].replace(/\/$/, '');
    if (
      host === 'facebook.com' &&
      parts.length &&
      !/^(sharer|share|dialog|plugins|tr|login|help|watch)$/i.test(parts[0])
    ) {
      platform = 'Facebook';
      if (parts[0] === 'profile.php') {
        const id = /[?&]id=(\d+)/.exec(u.url)?.[1];
        if (!id) return;
        url += '?id=' + id;
      } else if (!['p', 'pages', 'groups'].includes(parts[0]))
        url = 'https://www.facebook.com/' + parts[0];
    } else if (
      host === 'instagram.com' &&
      parts.length &&
      !/^(p|reel|reels|stories|explore|accounts|direct|about)$/i.test(parts[0])
    ) {
      platform = 'Instagram';
      url = 'https://www.instagram.com/' + parts[0];
    } else if (
      /(^|\.)linkedin\.com$/.test(host) &&
      /^(company|in|school)$/.test(parts[0]) &&
      parts[1]
    ) {
      platform = 'LinkedIn';
      url = 'https://www.linkedin.com/' + parts.slice(0, 2).join('/');
    } else if (
      host === 'youtube.com' &&
      (/^@/.test(parts[0] || '') || (/^(channel|c|user)$/.test(parts[0]) && parts[1]))
    )
      platform = 'YouTube';
    else if (host === 'tiktok.com' && /^@/.test(parts[0] || '')) {
      platform = 'TikTok';
      url = 'https://www.tiktok.com/' + parts[0];
    } else if (
      ['x.com', 'twitter.com'].includes(host) &&
      parts.length &&
      !/^(intent|share|search|home|i|hashtag|login)$/i.test(parts[0])
    ) {
      platform = 'X';
      url = 'https://x.com/' + parts[0];
    } else if (
      host === 'pinterest.com' &&
      parts.length &&
      !/^(pin|search|login|ideas)$/i.test(parts[0])
    ) {
      platform = 'Pinterest';
      url = 'https://www.pinterest.com/' + parts[0];
    } else if (host === 'wa.me' && /^\d{7,15}$/.test(parts[0] || '')) {
      platform = 'WhatsApp';
      url = 'https://wa.me/' + parts[0];
    } else if (host === 'api.whatsapp.com' && parts[0] === 'send') {
      const phone = /[?&]phone=(\d{7,15})(?:&|$)/.exec(u.url)?.[1];
      if (!phone) return;
      platform = 'WhatsApp';
      url = 'https://wa.me/' + phone;
    }
    if (platform)
      social.push({
        platform,
        url,
        source_url: sourceUrl,
        method,
        quote: String(quote).slice(0, 1500),
        status: '公开未验证',
      });
  };
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi))
    addSocial(m[1], 'website_link', m[0]);
  for (const m of html.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi))
    addSocial(m[1], 'markdown_link', m[0]);
  const addAddress = (address, method, quote, owner = '', mapUrl = null) => {
    if (!address || typeof address !== 'object' || Array.isArray(address)) return;
    const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 300) : '');
    const candidate = {
      country: countryName(address.addressCountry),
      region: str(address.addressRegion) || null,
      city: str(address.addressLocality) || null,
      street: str(address.streetAddress) || null,
      postal_code: str(address.postalCode) || null,
      source_url: sourceUrl,
      method,
      quote: String(quote).slice(0, 3000),
      owner: str(owner),
      ...(mapUrl ? { map_url: mapUrl } : {}),
      status: '官网公开地址',
    };
    if (candidate.street && (candidate.city || candidate.region)) addresses.push(candidate);
  };
  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const raw = m[1].trim();
      const walk = (v, depth = 0) => {
        if (!v || typeof v !== 'object' || depth > 15) return;
        if (Array.isArray(v)) {
          v.forEach((x) => walk(x, depth + 1));
          return;
        }
        const kinds = (Array.isArray(v['@type']) ? v['@type'] : [v['@type']])
          .filter(Boolean)
          .join(' ');
        const ownerUrl = websiteScope(v.url || v['@id'], sourceUrl);
        const eligible =
          /Organization|Corporation|LocalBusiness|Store|Service|Business|Place|Office/i.test(
            kinds,
          ) &&
          !/ServiceArea|AdministrativeArea|Country|State|City|Product/i.test(kinds) &&
          (!ownerUrl || ownerUrl.domain === source.domain);
        if (eligible) {
          addArea(v.areaServed || v.serviceArea, 'json_ld', raw);
          for (const a of Array.isArray(v.address) ? v.address : [v.address])
            addAddress(a, 'json_ld', raw, v.name);
          for (const link of Array.isArray(v.sameAs) ? v.sameAs : [v.sameAs])
            if (typeof link === 'string') addSocial(link, 'json_ld', raw);
          if (v.address || v.telephone || v.email || v.sameAs)
            snippets.push({ source_url: sourceUrl, text: raw.slice(0, 12000) });
        }
        for (const [key, x] of Object.entries(v))
          if (
            !/^(areaServed|serviceArea|author|review|reviews|manufacturer|seller|brand|mentions|address|sameAs)$/i.test(
              key,
            ) &&
            x &&
            typeof x === 'object'
          )
            walk(x, depth + 1);
      };
      walk(JSON.parse(raw));
    } catch {
      /* Malformed JSON-LD must not block other sources. */
    }
  }
  // Complete, explicit postal lines can be normalized without guessing from a service-area heading.
  const lines = decode(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?\s*>|<\/(?:p|div|address|li)>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  );
  // Keep explicit service statements as evidence, never as the company's address.
  for (const m of lines.matchAll(
    /(?:^|[\n.!?])\s*((?:We\s+(?:(?:are|now|proudly)\s+)*(?:serve|service|servicing)|Proudly\s+serving|Serving|Service\s+areas?\s*:)[^\n.!?]{3,250})/gi,
  ))
    addArea(m[1].trim(), 'service_statement', m[1]);
  const postal = (text, method, quote, mapUrl) => {
    for (const m of text.matchAll(
      /\b(\d{1,6}[A-Z]?\s+[A-Za-z0-9 .#'-]{3,100}),\s*([A-Za-z .'-]{2,45}),\s*(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s*,?\s*(\d{5}(?:-\d{4})?)(?:\s*,?\s*(USA|United States(?: of America)?))?(?=[\s.\])<]|$)/g,
    ))
      addAddress(
        {
          streetAddress: m[1],
          addressLocality: m[2],
          addressRegion: m[3],
          postalCode: m[4],
          addressCountry: m[5] || 'US',
        },
        method,
        quote || m[0],
        '',
        mapUrl,
      );
  };
  const isMap = (value) => {
    const u = websiteScope(decode(value).replace(/^http:\/\//i, 'https://'));
    return u &&
      (['maps.app.goo.gl', 'maps.google.com', 'goo.gl'].includes(u.host) ||
        (/(^|\.)google\.[a-z.]+$/.test(u.host) && /^\/maps(?:\/|$)/.test(u.path)))
      ? u.url
      : null;
  };
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const map = isMap(m[1]);
    if (map) postal(plain(m[2]), 'map_address_link', m[0], map);
  }
  for (const m of html.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi)) {
    const map = isMap(m[2]);
    if (map) postal(m[1], 'map_address_link', m[0], map);
  }
  postal(lines, 'postal_text');
  // Only read lists inside an explicit coverage section; generic site navigation is not coverage evidence.
  for (const heading of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    if (
      !/^(?:Cities\s+We\s+(?:Serve|Service)|Service\s+Areas?|Areas?\s+We\s+(?:Serve|Service)|Our\s+Service\s+Areas?)\s*:?$/i.test(
        plain(heading[2]),
      )
    )
      continue;
    const tail = html.slice(
      heading.index + heading[0].length,
      heading.index + heading[0].length + 24000,
    );
    const section = tail.split(/<h[1-6]\b/i)[0];
    const list = /<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(section)?.[2] || '';
    for (const item of list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const name = plain(item[1]);
      if (
        /^[A-Za-zÀ-ž][A-Za-zÀ-ž .,'’&()/-]{0,99}$/.test(name) &&
        !/contact|privacy|terms|quote|copyright|facebook|instagram|whatsapp/i.test(name)
      )
        addArea(name, 'service_list', item[0], heading[0]);
    }
  }
  for (const heading of html.matchAll(
    /^#{1,6}\s+(Cities We (?:Serve|Service)|Service Areas?|Areas We Serve)\s*\n/gim,
  )) {
    const section = html
      .slice(heading.index + heading[0].length)
      .split(/^#{1,6}\s/m)[0]
      .slice(0, 12000);
    for (const item of section.matchAll(/^[ \t]*[-*+]\s+([^\n]+)/gm)) {
      const name = plain(item[1])
        .replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1')
        .trim();
      if (/^[A-Za-zÀ-ž][A-Za-zÀ-ž .,'’&()/-]{0,99}$/.test(name))
        addArea(name, 'service_list', item[0], heading[0]);
    }
  }
  const uniq = (items, key) =>
    items.filter((item, i) => items.findIndex((x) => key(x) === key(item)) === i);
  return {
    social: uniq(social, (x) => x.platform + ':' + x.url).slice(0, 30),
    addresses: uniq(
      addresses.sort((a, b) => (b.method === 'json_ld') - (a.method === 'json_ld')),
      (x) => [x.country, x.region, x.city, x.street, x.postal_code].join('|'),
    ).slice(0, 10),
    snippets: snippets.slice(0, 4),
    service_areas: uniq(serviceAreas, (x) => x.name)
      .filter(
        (x) => x.name.includes(',') || !serviceAreas.some((y) => y.name.startsWith(x.name + ', ')),
      )
      .slice(0, 150),
  };
}

export function planWebsitePages(sourceUrl, content = '') {
  const base = websiteScope(sourceUrl);
  if (!base) return [];
  const urls = [base.url, base.origin + '/'];
  const links = [
    ...String(content).matchAll(/(?:href\s*=\s*["']([^"']+)["']|\[[^\]]*\]\(([^\s)]+)\))/gi),
  ];
  for (const m of links) {
    const raw = m[1] || m[2];
    const next = websiteScope(raw, base.url);
    if (
      next &&
      next.domain === base.domain &&
      /contact|about|联系我们|聯絡/i.test(m[0]) &&
      !/\.(pdf|jpg|png|zip)$/i.test(next.path)
    )
      urls.push(next.url);
  }
  const first = [...new Set(urls)].slice(0, base.path === '/' ? 1 : 2);
  const extra = [...new Set(urls)]
    .filter((u) => !first.includes(u))
    .sort(
      (a, b) => Number(/contact|联系我们|聯絡/i.test(b)) - Number(/contact|联系我们|聯絡/i.test(a)),
    );
  return [...first, ...extra].slice(0, 3);
}

export function combineWebsiteEvidence(pages, country = '') {
  const social = [],
    addresses = [],
    contacts = [],
    snippets = [],
    serviceAreas = [];
  for (const page of pages) {
    const meta = extractWebsiteMetadata({ content: page.content, sourceUrl: page.url });
    social.push(...meta.social);
    addresses.push(...meta.addresses);
    snippets.push(...meta.snippets);
    serviceAreas.push(...meta.service_areas);
    contacts.push(
      ...extractContacts({
        content: page.content,
        sourceUrl: page.url,
        country: meta.addresses[0]?.country || country,
      }),
    );
  }
  const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
  const addressRank = (a) => (a.method === 'json_ld' ? 3 : a.method === 'map_address_link' ? 2 : 1);
  return {
    version: 'website-evidence-v4',
    social: unique(social, (x) => x.platform + ':' + x.url),
    addresses: unique(
      addresses.sort((a, b) => addressRank(a) - addressRank(b)),
      (x) => [x.country, x.region, x.city, x.street].join('|'),
    ).sort((a, b) => addressRank(b) - addressRank(a)),
    service_areas: unique(serviceAreas, (x) => x.name),
    contacts: unique(contacts, (x) => x.kind + ':' + x.normalized),
    snippets: unique(snippets, (x) => x.text),
    checked_urls: [...new Set(pages.filter((p) => p.content).map((p) => p.url))],
    checked_at: Date.now(),
  };
}

export function enrichmentFields(profile, evidence, existing = {}) {
  const fieldText = (v) =>
    Array.isArray(v)
      ? v.map(fieldText).join('\n')
      : v && typeof v === 'object'
        ? v.text || ''
        : String(v ?? '');
  const mergeLines = (a, b) =>
    [...new Set([...fieldText(a).split('\n'), ...b].map((v) => v.trim()).filter(Boolean))].join(
      '\n',
    );
  const old = profile.website_metadata || {};
  const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
  const social = unique(
    [...(old.social || []), ...evidence.social],
    (x) => x.platform + ':' + x.url,
  );
  const contacts = unique(
    [...(profile.latest_research?.contact_evidence || []), ...evidence.contacts],
    (x) => x.kind + ':' + (x.normalized || x.value),
  );
  const address = evidence.addresses[0] || old.addresses?.[0];
  const areas = unique(
    [...(old.service_areas || []), ...(evidence.service_areas || [])],
    (x) => x.name,
  );
  const next = {
    ...profile,
    ...(address?.country ? { actual_country: address.country } : {}),
    website_metadata: {
      ...old,
      ...evidence,
      social,
      service_areas: areas,
      addresses: evidence.addresses.length ? evidence.addresses : old.addresses || [],
      snippets: undefined,
    },
    latest_research: {
      ...profile.latest_research,
      contact_evidence: contacts,
      contact_extraction_version: evidence.version,
    },
  };
  const fields = { 画像JSON: JSON.stringify(next) };
  for (const kind of ['phone', 'email']) {
    const label = kind === 'phone' ? '电话' : '邮箱';
    const merged = mergeLines(
      existing[label],
      contacts.filter((c) => c.kind === kind).map((c) => c.value),
    );
    const normalized = new Map();
    for (const line of merged.split('\n').filter(Boolean)) {
      const key =
        kind === 'email'
          ? line.toLowerCase()
          : extractContacts({
              content:
                '<script type="application/ld+json">' +
                JSON.stringify({ telephone: line }) +
                '</script>',
              sourceUrl: '',
              country: address?.country || profile.actual_country || '',
            })[0]?.normalized || line;
      if (!normalized.has(key)) normalized.set(key, line);
    }
    const value = [...normalized.values()].join('\n');
    if (value) fields[label] = value;
  }
  for (const platform of [
    'Facebook',
    'Instagram',
    'LinkedIn',
    'YouTube',
    'TikTok',
    'X',
    'Pinterest',
    'WhatsApp',
  ]) {
    const value = mergeLines(
      existing[platform],
      social.filter((x) => x.platform === platform).map((x) => x.url),
    );
    if (value) fields[platform] = value;
  }
  if (social.length) fields['社媒JSON'] = JSON.stringify(social);
  if (areas.length) {
    fields['服务地区'] = mergeLines(
      existing['服务地区'],
      areas.map((x) => x.name),
    );
    fields['服务地区JSON'] = JSON.stringify(areas);
  }
  if (address) {
    if (address.country) fields['国家'] = address.country;
    if (address.region) fields['州'] = address.region;
    if (address.city) fields['城市'] = address.city;
    fields['详细地址'] = [
      address.street,
      address.city,
      address.region,
      address.postal_code,
      address.country,
    ]
      .filter(Boolean)
      .join(', ');
  }
  return { fields, profile: next };
}
