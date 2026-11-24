const names = {
  'honeybadgerblinds.com': 'Honey Badger Blinds',
  'shutterblindssolutions.com': 'Shutter & Blinds Solutions',
  'shuangshengshutter.com': 'Shuangsheng Shutter',
};
const brandMention = {
  'honeybadgerblinds.com': /\bhoney[\s-]*badger(?:\s*blinds)?\b|蜜獾/iu,
  'shuangshengshutter.com': /\bshuang[\s-]*sheng(?:\s*shutters?)?\b|双盛/iu,
  'shutterblindssolutions.com': /\bshutter\s*(?:&|and)?\s*blinds?\s*solutions?\b|\bSBS\b/iu,
};
export function mailSite(url) {
  try {
    return new URL(url.includes('://') ? url : 'https://' + url).hostname
      .toLowerCase()
      .replace(/^www\./u, '');
  } catch {
    return '';
  }
}
export const siteBrand = (website) => names[mailSite(website)] || '';
export function siteAllowsProduct(product, mailbox, requireSite = false) {
  if (product.materialOnly && !requireSite) return false;
  const domain = mailSite(mailbox.website),
    source = mailSite(product.sourceUrl || '');
  const brands = (product.brands || []).map((s) => s.toLowerCase().trim());
  const knownSender = mailbox.email?.toLowerCase().split('@')[1];
  if (names[knownSender] && knownSender !== domain) return false;
  if (source && names[source] && source !== domain) return false;
  if (brands.length)
    return (
      !!domain &&
      [domain, (names[domain] || mailbox.brandName || '').toLowerCase()].some((s) =>
        brands.includes(s),
      )
    );
  if (source) return source === domain;
  // Legacy custom mailboxes can have manually assigned, untagged sales products.
  return !requireSite && !names[domain];
}
export function otherSitesInText(question, mailbox) {
  const domain = mailSite(mailbox.website),
    normalized = question.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return Object.entries(names)
    .filter(
      ([other, name]) =>
        other !== domain &&
        (brandMention[other].test(question) ||
          normalized.includes(other.split('.')[0]) ||
          normalized.includes(name.toLowerCase().replace(/[^a-z0-9]/gu, ''))),
    )
    .map(([domain]) => domain);
}
export function mentionsOtherSite(question, mailbox) {
  return otherSitesInText(question, mailbox).length > 0;
}
