import { phoneMetadata } from './phone-metadata.mjs';

// Keep these functions dependency-free apart from phoneMetadata: n8n embeds the same source.
export function normalizePhone(value, country = '') {
  let raw = String(value ?? '').trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* Keep readable URI text. */
  }
  raw = raw
    .replace(/^(?:tel|callto):/i, '')
    .replace(/^(?:phone|telephone|mobile|电话)\s*[:：]\s*/i, '')
    .trim();
  const extension = raw.match(/(?:;ext=|\bext\.?\s*|\bx\s*)(\d{1,6})\s*$/i)?.[1] || '';
  let base = raw
    .replace(/(?:;ext=|\bext\.?\s*|\bx\s*)\d{1,6}\s*$/i, '')
    .trim()
    .replace(/[‐‑–—]/g, '-');
  if (!/^[+\d\s().-]+$/.test(base) || /\+.*\+/.test(base) || /\d.*\+/.test(base)) return null;
  const metadata = phoneMetadata();
  const iso = metadata.regions[String(country).trim().toUpperCase()]
    ? String(country).trim().toUpperCase()
    : metadata.names[String(country).trim().toLowerCase()];
  const region = metadata.regions[iso];
  if (base.startsWith('00')) base = '+' + base.slice(2);
  else if (
    region &&
    new RegExp('^(?:' + region[4] + ')').test(base.replace(/\D/g, '')) &&
    !base.startsWith('+')
  ) {
    const digits = base.replace(/\D/g, '');
    base = '+' + digits.replace(new RegExp('^(?:' + region[4] + ')'), '');
  }
  if (base.startsWith('+')) base = base.replace(/\(0\)/g, '');
  const digits = base.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return null;
  const valid = (n, data) =>
    data[2].includes(n.length) &&
    new RegExp('^(?:' + data[1] + ')$').test(n) &&
    (data[0] !== '1' || /^[2-9]\d{2}[2-9]\d{6}$/.test(n));
  let callingCode, national;
  if (base.startsWith('+')) {
    callingCode = [1, 2, 3]
      .map((n) => digits.slice(0, n))
      .find((code) => metadata.callingCodes[code]);
    if (!callingCode) return null;
    national = digits.slice(callingCode.length);
    if (!metadata.callingCodes[callingCode].some((id) => valid(national, metadata.regions[id])))
      return null;
  } else {
    if (!region) return null; // A search target or number shape must not supply the country.
    callingCode = region[0];
    const candidates = [digits];
    if (region[3]) candidates.push(digits.replace(new RegExp('^(?:' + region[3] + ')'), ''));
    if (digits.startsWith(callingCode)) candidates.push(digits.slice(callingCode.length));
    national = candidates.find((n) => valid(n, region));
    if (!national || callingCode.length + national.length > 15) return null;
  }
  return {
    value: '+' + callingCode + ' ' + national + (extension ? ' ext. ' + extension : ''),
    normalized: '+' + callingCode + national + (extension ? ';ext=' + extension : ''),
    raw_value: raw,
  };
}

export function normalizePhoneLines(values, country = '', preserveUnparsed = false) {
  const text = (v) =>
    Array.isArray(v)
      ? v.map(text).join('\n')
      : v && typeof v === 'object'
        ? v.text || v.link || ''
        : String(v ?? '');
  const unique = new Map();
  for (const line of text(values)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const parsed = normalizePhone(line, text(country));
    if (parsed) unique.set(parsed.normalized, parsed.value);
    else if (preserveUnparsed) unique.set('unparsed:' + line, line);
  }
  return [...unique.values()].join('\n');
}

export const phoneHelpers = [phoneMetadata, normalizePhone, normalizePhoneLines]
  .map((fn) => fn.toString())
  .join('\n');
