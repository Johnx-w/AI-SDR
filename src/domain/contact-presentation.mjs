import { emailPurpose } from './email-purpose.mjs';

const text = (value) => (value === undefined || value === null ? '' : String(value));
const keyText = (value) => text(value).trim().toLowerCase().replace(/\s+/g, ' ');
const control = /[\u0000-\u001f\u007f]/;
const emailPattern =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

function emailIdentity(value) {
  const address = text(value)
    .trim()
    .replace(/^mailto:/i, '');
  return {
    key: address.toLowerCase(),
    ...(emailPattern.test(address) &&
    !control.test(address) &&
    !/[?]/.test(address) &&
    !/%0[ad]/i.test(address)
      ? { href: 'mailto:' + encodeURIComponent(address).replace(/%40/gi, '@') }
      : {}),
  };
}

function phoneIdentity(value) {
  const raw = text(value).trim().replace(/^tel:/i, '');
  const extension = raw.match(/(?:;ext=|\bext\.?\s*|\bx\s*)(\d{1,6})\s*$/i);
  const base = (extension ? raw.slice(0, extension.index) : raw).trim();
  const international = base.startsWith('+') || base.startsWith('00');
  let digits = base.replace(/\D/g, '');
  if (international && base.startsWith('00')) digits = digits.slice(2);
  const number = (international ? '+' : '') + digits;
  const suffix = extension ? ';ext=' + extension[1] : '';
  const valid =
    !control.test(raw) &&
    /^[+\d\s().‐‑–—-]+$/.test(base) &&
    !/\+.*\+|\d.*\+/.test(base) &&
    digits.length >= 7 &&
    digits.length <= 15;
  return {
    key: valid ? number + suffix : 'raw:' + keyText(raw),
    ...(valid ? { href: 'tel:' + number + suffix } : {}),
  };
}

function webIdentity(value) {
  const raw = text(value).trim();
  try {
    if (/[\u0000-\u0020\u007f]/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error();
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return { key: url.origin + path + url.search + url.hash, href: url.href };
  } catch {
    return { key: 'raw:' + raw };
  }
}

function currentValues(value, kind) {
  const parts = text(value).split(
    kind === 'email' ? /[\r\n,;，；、]+/ : /\r?\n|[、；,，]|;(?!ext=)/i,
  );
  const values = new Map();
  for (const item of parts) {
    const value = item.trim();
    if (!value) continue;
    const identity = kind === 'email' ? emailIdentity(value) : phoneIdentity(value);
    if (!values.has(identity.key))
      values.set(identity.key, { value, ...(identity.href ? { href: identity.href } : {}) });
  }
  return [...values.values()];
}

function phonePurpose(value, evidence) {
  const identity = phoneIdentity(value).key;
  const entries = evidence.filter(
    (entry) =>
      entry?.kind === 'phone' &&
      phoneIdentity(entry.normalized || entry.value).key === identity &&
      entry.verification_status !== 'invalid' &&
      entry.method !== 'guessed',
  );
  const types = [
    [
      'support',
      '技术 / 售后电话',
      /\b(?:technical support|tech support|customer (?:support|service)|service desk|warranty|repairs?)\b|技术支持|售后|维修/i,
    ],
    [
      'finance',
      '财务电话',
      /\b(?:accounts? payable|accounts? receivable|billing|finance)\b|财务|账务/i,
    ],
    [
      'procurement',
      '采购 / 供应商电话',
      /\b(?:procurement|purchasing|sourcing|buyers?|suppliers?|vendors?)\b|采购|供应商/i,
    ],
    ['fax', '传真', /\bfax\b|传真/i],
    ['sales', '销售电话', /\b(?:sales|product enquiries|order enquiries)\b|销售咨询|销售部/i],
    [
      'general',
      '总机 / 通用电话',
      /\b(?:main office|main line|switchboard|reception|general enquiries|telephone|phone|call us)\b|总机|办公室电话|联系电话/i,
    ],
  ];
  for (const entry of entries) {
    const quote = text(entry.quote).trim();
    if (!entry.source_url || !quote) continue;
    // A shared excerpt with several numbers cannot assign one department to each number.
    if ((quote.match(/\+?\d[\d ().-]{6,}\d/g) || []).length > 1) continue;
    const found = types.find(([, , pattern]) => pattern.test(quote));
    if (found) return { type: found[0], label: found[1], basis: '来源说明' };
  }
  return { type: 'unknown', label: '未识别', basis: '暂无逐号用途说明' };
}

function stableId(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return 'contact-evidence-' + (hash >>> 0).toString(36);
}
const recordKey = (record) =>
  JSON.stringify([record.label, record.value, record.quote, record.source_url]);
const contactLabels = { email: '邮箱', phone: '电话', form: '业务联系表单' };

// Presentation only: saved contact strings remain untouched for edit/version checks.
export function buildContactPresentation(lead = {}) {
  lead ??= {};
  const groups = new Map();
  const addEvidence = (key, label, value, record) => {
    let group = groups.get(key);
    if (!group) {
      group = { id: stableId(key), label, value, records: [] };
      groups.set(key, group);
    }
    if (!group.records.some((saved) => recordKey(saved) === recordKey(record)))
      group.records.push({ ...record });
  };
  for (const entry of Array.isArray(lead.contactEvidence) ? lead.contactEvidence : []) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = text(entry.kind).trim();
    const value = text(entry.value ?? entry.url);
    const quote = text(entry.quote);
    const source_url = text(entry.source_url);
    if (!value && !quote && !source_url) continue;
    const label = Object.hasOwn(contactLabels, kind) ? contactLabels[kind] : '其他联系线索';
    const identity =
      kind === 'email'
        ? emailIdentity(value)
        : kind === 'phone'
          ? phoneIdentity(entry.normalized || value)
          : kind === 'form'
            ? webIdentity(value)
            : { key: keyText(value) };
    const emptyKey = !value.trim() ? JSON.stringify([quote, source_url]) : identity.key;
    addEvidence(JSON.stringify(['contact', kind, emptyKey]), label, value.trim(), {
      label,
      value,
      quote,
      source_url,
    });
  }

  const socials = new Map();
  for (const entry of Array.isArray(lead.social) ? lead.social : []) {
    if (!entry || typeof entry !== 'object') continue;
    const platform = text(entry.platform).trim() || '社交账号';
    const url = text(entry.url).trim();
    const identity = webIdentity(url);
    const key = JSON.stringify([keyText(platform), identity.key]);
    let social = socials.get(key);
    if (!social) {
      social = { platform, url, ...(identity.href ? { href: identity.href } : {}), records: [] };
      socials.set(key, social);
    }
    const label = platform === '社交账号' ? platform : platform + ' 社交账号';
    const record = {
      label,
      value: text(entry.url),
      quote: text(entry.quote),
      source_url: text(entry.source_url),
    };
    if (!social.records.some((saved) => recordKey(saved) === recordKey(record)))
      social.records.push(record);
    addEvidence(JSON.stringify(['social', key]), label, url, record);
  }

  for (const entry of Array.isArray(lead.locationEvidence) ? lead.locationEvidence : []) {
    if (!entry || typeof entry !== 'object') continue;
    const value =
      text(entry.name).trim() ||
      [entry.street, entry.city, entry.region].map(text).filter(Boolean).join(', ');
    const label = entry.street || entry.city || entry.region ? '企业地址' : '服务地区';
    const quote = text(entry.quote),
      source_url = text(entry.source_url);
    if (!value && !quote && !source_url) continue;
    const identity = value ? keyText(value) : JSON.stringify([quote, source_url]);
    addEvidence(JSON.stringify(['location', label, identity]), label, value, {
      label,
      value,
      quote,
      source_url,
    });
  }

  return {
    emails: currentValues(lead.email, 'email').map((item) => ({
      ...item,
      purpose: emailPurpose(
        item.value,
        Array.isArray(lead.contactEvidence) ? lead.contactEvidence : [],
        lead.website,
      ),
    })),
    phones: currentValues(lead.phone, 'phone').map((item) => ({
      ...item,
      purpose: phonePurpose(
        item.value,
        Array.isArray(lead.contactEvidence) ? lead.contactEvidence : [],
      ),
    })),
    social: [...socials.values()],
    evidenceGroups: [...groups.values()],
  };
}
