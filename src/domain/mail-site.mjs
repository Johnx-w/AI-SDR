const names = {
  'honeybadgerblinds.com': 'Honey Badger Blinds',
  'shutterblindssolutions.com': 'Shutter & Blinds Solutions',
  'shuangshengshutter.com': 'Shuangsheng Shutter',
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
  if (source && names[source]) return source === domain;
  return requireSite ? !!domain && source === domain : true;
}
export function mentionsOtherSite(question, mailbox) {
  const domain = mailSite(mailbox.website),
    normalized = question.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return Object.entries(names).some(
    ([other, name]) =>
      other !== domain &&
      (normalized.includes(other.split('.')[0]) ||
        normalized.includes(name.toLowerCase().replace(/[^a-z0-9]/gu, ''))),
  );
}
