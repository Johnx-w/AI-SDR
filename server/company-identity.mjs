import { thirdPartyCompanySource } from './website-identity.mjs';
import { researchEvidencePages } from './research-text.mjs';

// Also embedded with the shared website-source policy in legacy Code nodes.
export function verifyCompanyIdentity(facts, pages, sourceUrl) {
  pages = researchEvidencePages(pages);
  const literal = (value) =>
    String(value || '')
      .normalize('NFKC')
      .replace(/&amp;/gi, '&')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const normalize = (value) =>
    String(value || '')
      .normalize('NFKC')
      .replace(/&amp;/gi, '&')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .toLowerCase();
  const host = (value) =>
    /^https:\/\/([^/?#]+)/i
      .exec(String(value || ''))?.[1]
      .toLowerCase()
      .replace(/^www\./, '') || null;
  const sourceHost = host(sourceUrl);
  if (
    thirdPartyCompanySource({
      url: sourceUrl,
      text: (pages || [])
        .filter((page) => host(page.source_url) === sourceHost)
        .map((page) => page.text || '')
        .join('\n'),
    })
  )
    return {
      name: null,
      website_name: null,
      legal_name: null,
      aliases: [],
      status: 'third_party_source',
      customs_match_status: 'requires_identity_match',
      evidence: [],
    };
  const fields = ['company_name', 'legal_company_name', 'trading_names'];
  const accepted = (facts || []).filter((fact) => {
    if (
      !fields.includes(fact.field) ||
      typeof fact.value !== 'string' ||
      fact.value.length > 200 ||
      /[\r\n]|https?:\/\//i.test(fact.value) ||
      !sourceHost ||
      host(fact.source_url) !== sourceHost
    )
      return false;
    const value = normalize(fact.value),
      quote = normalize(fact.quote);
    if (!literal(fact.quote).includes(literal(fact.value))) return false;
    if (value.length < 2 || !(' ' + quote + ' ').includes(' ' + value + ' ')) return false;
    if (
      !pages.some(
        (page) => page.source_url === fact.source_url && normalize(page.text).includes(quote),
      )
    )
      return false;
    if (
      /^(?:blinds?|screens?|shades?|shutters?|home|about us|contact us|company|website)$/.test(
        value,
      )
    )
      return false;
    const index = (' ' + quote + ' ').indexOf(' ' + value + ' ');
    const before = quote.slice(0, index).trim();
    // A valid excerpt can still name a supplier, competitor or website designer.
    if (
      /(?:\b(?:website|site|design|powered|processed) by|\b(?:dealers?|distributors?|suppliers?|partners?) (?:for|of)|\b(?:affiliated|associated|endorsed|sponsored) (?:with|by)|\b(?:trademark|manufactured|manufactured exclusively) (?:of|by))$/.test(
        before,
      )
    )
      return false;
    if (
      /(?:\b(?:we|they) (?:sell|stock|supply|offer|represent)|\b(?:our|their) (?:brands?|customers?|clients?|suppliers?|partners?) (?:include|includes|are)|\b(?:import|export|shipment|shipping|trade) (?:data|records?|history) (?:for|of)|\b(?:products?|brands?) (?:from|by))$/.test(
        before,
      )
    )
      return false;
    if (fact.field === 'legal_company_name') {
      const suffix =
        /\b(?:llc|l l c|inc|incorporated|corp|corporation|ltd|limited|pty|llp|plc|gmbh)\b/.test(
          value,
        );
      const legalContext =
        /\b(?:trading (?:name of|as)|d b a|doing business as|operated by|owned and operated by|legal (?:name|entity)|registered (?:company|name)|terms|privacy|copyright)\b/.test(
          quote,
        ) ||
        /©|&copy;/i.test(fact.quote) ||
        /\/(?:[^/?#]*(?:privacy|terms|legal|impressum))/i.test(fact.source_url);
      if (!suffix || !legalContext) return false;
    }
    return true;
  });
  const unique = (entries) => [
    ...new Map(entries.map((fact) => [normalize(fact.value), fact])).values(),
  ];
  const legal = unique(accepted.filter((fact) => fact.field === 'legal_company_name'));
  const website = unique(accepted.filter((fact) => fact.field === 'company_name'));
  const conflicting = legal.length > 1 || website.length > 1;
  const chosenLegal = !conflicting ? legal[0] : null;
  const chosenWebsite = website.length === 1 ? website[0] : null;
  const chosen = chosenLegal || chosenWebsite;
  const linked = accepted.filter(
    (fact) =>
      fact.field !== 'trading_names' ||
      (/\b(?:trading (?:name|as)|d b a|doing business as|also known as|formerly known as)\b/.test(
        normalize(fact.quote),
      ) &&
        [chosenLegal, chosenWebsite].some(
          (name) =>
            name && (' ' + normalize(fact.quote) + ' ').includes(' ' + normalize(name.value) + ' '),
        )),
  );
  const aliases = chosen
    ? unique(linked)
        .map((fact) => fact.value)
        .filter((value) => normalize(value) !== normalize(chosen.value))
    : [];
  return {
    name: chosen?.value.trim() || null,
    website_name: chosenWebsite?.value.trim() || null,
    legal_name: chosenLegal?.value.trim() || null,
    aliases: conflicting ? [] : aliases,
    status: conflicting
      ? 'identity_conflict'
      : chosenLegal
        ? 'legal_name_self_reported'
        : chosen
          ? 'website_name_only'
          : 'unverified',
    // Website self-description never proves who appears as consignee/importer.
    customs_match_status: 'requires_identity_match',
    evidence: linked,
  };
}
