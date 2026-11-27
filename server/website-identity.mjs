export function domainKey(value) {
  try {
    const u = new URL(value);
    const host = u.hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      !host.includes('.') ||
      /[:\d]$/.test(host)
    )
      return '';
    return host;
  } catch {
    return '';
  }
}

// High-confidence evidence that a page describes another company as a trade
// database entry. Domain lists alone cannot cover new or white-labelled data
// platforms. A supplier mentioning its own imports/shipments is not enough.
export function thirdPartyTradeProfile({ title = '', text = '' } = {}) {
  const content = [title, text].join(' ').normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
  const records =
    /\b(?:bill[ -]of[ -]lading (?:data|records?|database)|(?:customs|import|export|shipment|shipping) (?:import )?(?:data|records?|history|database))\b/.test(
      content,
    );
  const platform =
    /\b(?:search (?:importers|exporters|buyers|suppliers)|(?:subscribe|sign up|register|upgrade) to (?:unlock|access|view)|unlock (?:trade|shipment|import|export|contact) (?:data|records?|history|details)|(?:importer|exporter|buyer|supplier) (?:database|directory))\b/.test(
      content,
    );
  return records && platform;
}

export function thirdPartySupplierProfile({ url = '', title = '', text = '' } = {}) {
  const path = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url)?.[1] || '';
  const numberedProfile =
    /\/(?:suppliers?|vendors?|sellers?)\/(?:profiles?|records?|listings?)\/\d+\/?$/i.test(path);
  const content = [title, text]
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
  return (
    numberedProfile ||
    /\bthis supplier has self[- ]identified in the following (?:products|services)\b|\b(?:further|more) (?:information|details) (?:on|about) this supplier (?:is|are) available to registered buyers\b/i.test(
      content,
    )
  );
}

export function businessDirectoryEvidence(text) {
  const content = text.normalize('NFKC').replace(/\s+/g, ' ');
  const directoryListingFeed =
    /\bbusiness directory\b/i.test(content) &&
    /\b(?:new|latest|search) business(?:es)? listings\b/i.test(content);
  return {
    browseProfiles:
      directoryListingFeed ||
      /\b(?:browse|review|compare|explore) (?:[\w&-]+ ){0,5}(?:(?:business|company|contractor|provider|supplier|vendor|merchant) (?:profiles|listings)|(?:businesses|companies|contractors|providers|suppliers|vendors|merchants) in your area)\b/i.test(
        content,
      ),
    publishListings:
      /\b(?:claim or add your business|add your business|submit a business listing|list your business)\b/i.test(
        content,
      ),
    manageProfile:
      /\b(?:update (?:this |the )?listing|claim (?:this|your) (?:business|listing|profile))\b/i.test(
        content,
      ) && /\b(?:write|leave|submit) a review\b/i.test(content),
  };
}

// A supplier's product card on a marketplace belongs to the marketplace
// operator. Its membership, legal address and customer-service contacts must
// never be attributed to the merchant named in that card.
export function thirdPartyCompanySource({ url = '', title = '', text = '' } = {}) {
  const host =
    /^https?:\/\/([^/?#]+)/i
      .exec(String(url))?.[1]
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '') || '';
  const platforms = [
    'safer.fmcsa.dot.gov',
    'freightglobal.com',
    'mapquest.com',
    'trustpilot.com',
    'bloomberg.com',
    'panjiva.com',
    'importinfo.com',
    'eximagent.ai',
    'importkey.com',
    'importyeti.com',
    'importgenius.com',
    'exporthub.com',
    'globalsources.com',
    'tradeindia.com',
    'indiamart.com',
    'mydeal.com.au',
    'canpages.ca',
    'yp.ca',
    'loc8nearme.com',
    'infoisinfo-ca.com',
    'go4worldbusiness.com',
    'etsy.com',
    'tracxn.com',
  ];
  if (platforms.some((platform) => host === platform || host.endsWith('.' + platform))) return true;
  if (thirdPartyTradeProfile({ title, text }) || thirdPartySupplierProfile({ url, title, text }))
    return true;
  const content = [title, text]
    .join(' ')
    .normalize('NFKC')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const disclaimer =
    /\b(?:all (?:the )?content is user posted|website acts as (?:a )?(?:mere )?(?:venue|platform)|we do not take part in the actual transaction)\b/.test(
      content,
    );
  const merchantCard =
    /\b(?:contact (?:this )?supplier|verified supplier|about (?:the )?supplier|new products from this supplier|supplier (?:details|information|profile)|seller profile)\b/.test(
      content,
    );
  const marketplaceOperations =
    /\b(?:post (?:buy(?:ing)? requirements|products)|send quote to buyer|register (?:as )?(?:a )?buyer|buyer registration|buyer sign up|sign up (?:as )?(?:a )?buyer)\b/.test(
      content,
    );
  const membership =
    /\b(?:premium (?:membership|services)|upgrade your account|free member|gold (?:member|supplier))\b/.test(
      content,
    );
  return disclaimer || (marketplaceOperations && (merchantCard || membership));
}
