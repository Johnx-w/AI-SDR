import { domainKey } from './website-identity.mjs';
import { extractContacts } from './contact-extractor.mjs';

// This is a deterministic business gate over already verified research and
// source contacts, not a second model score. Unknown V does not block handoff.
export function calculateHandoffReadiness({
  research = {},
  assessment,
  contacts = [],
  researchPages = [],
} = {}) {
  const domain = domainKey(research.source_url);
  const identity = research.company_identity;
  const identityVerified = Boolean(
    domain &&
      research.company_name &&
      ['legal_name_self_reported', 'website_name_only'].includes(identity?.status) &&
      identity?.name &&
      Array.isArray(identity.evidence) &&
      identity.evidence.length &&
      identity.evidence.some((fact) => domainKey(fact.source_url) === domain && fact.quote),
  );
  const permitted =
    research.ok === true &&
    research.entity_type === 'business' &&
    research.eligibility?.status === 'eligible' &&
    !research.review_required &&
    !['not_matched', 'unknown'].includes(research.required_match);
  const opportunities = assessment?.opportunities?.length
    ? assessment.opportunities
    : assessment
      ? [assessment]
      : [];
  const qualified =
    permitted &&
    opportunities.some((opportunity) => {
      const dimensions = opportunity.dimensions || {};
      return (
        ['A', 'B'].includes(opportunity.grade) &&
        ['优先开发', '可开发'].includes(opportunity.status) &&
        Number.isFinite(dimensions.P?.score) &&
        dimensions.P.score >= 30 &&
        Number.isFinite(dimensions.R?.score) &&
        dimensions.R.score >= 25 &&
        Number.isFinite(dimensions.D?.score) &&
        ![dimensions.P, dimensions.R, dimensions.D].some((dimension) => dimension?.conflict) &&
        !(opportunity.requirements || opportunity.facts || []).some((fact) =>
          ['identity_conflict', 'mandatory_requirement'].includes(fact.kind),
        )
      );
    });
  const pages = researchPages.filter(
    (page) => domainKey(page.source_url || page.url) === domain && (page.text || page.content),
  );
  const sourceUrls = new Set([
    ...(research.checked_urls || []),
    ...pages.map((page) => page.source_url || page.url),
  ]);
  const extracted = pages.flatMap((page) =>
    extractContacts({
      content: page.content || page.text,
      sourceUrl: page.source_url || page.url,
      country: research.actual_country || '',
    }),
  );
  const thirdPartyContact = (contact) => {
    const ownEmailDomain =
      contact.kind === 'email' && domainKey('https://' + String(contact.value).split('@')[1]);
    if (ownEmailDomain === domain) return false;
    const attribution =
      /\b(?:(?:website|web site|site)\s+(?:(?:was\s+)?(?:design(?:ed)?|develop(?:ed)?|built|created|powered|maintain(?:ed)?|host(?:ed)?)\s+by|support)|web\s+agency|webmaster)\b/i;
    const matchedPages = pages
      .filter((page) => (page.source_url || page.url) === contact.source_url)
      .map((page) => {
        const text = String(page.text || page.content || '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ');
        const needle = String(contact.value || contact.url || '').toLowerCase();
        if (!needle) return null;
        let index = text.toLowerCase().indexOf(needle);
        let attributed = false;
        while (index >= 0) {
          const before = text.slice(Math.max(0, index - 200), index);
          if (!attribution.test(before)) return false;
          attributed = true;
          index = text.toLowerCase().indexOf(needle, index + needle.length);
        }
        return attributed ? true : null;
      });
    if (matchedPages.includes(false)) return false;
    if (matchedPages.includes(true)) return true;
    const valueIndex = String(contact.quote)
      .toLowerCase()
      .indexOf(String(contact.value || contact.url).toLowerCase());
    return attribution.test(valueIndex >= 0 ? contact.quote.slice(0, valueIndex) : contact.quote);
  };
  const verifiedContacts = [
    ...new Map(
      [...contacts, ...extracted]
        .filter(
          (contact) =>
            ['email', 'phone', 'form'].includes(contact.kind) &&
            (contact.value || contact.url) &&
            contact.quote &&
            domainKey(contact.source_url) === domain &&
            sourceUrls.has(contact.source_url) &&
            !thirdPartyContact(contact),
        )
        .map((contact) => [
          contact.kind + ':' + (contact.normalized || contact.value || contact.url),
          contact,
        ]),
    ).values(),
  ];
  const contactVerified = verifiedContacts.length > 0;
  const reasons = [];
  if (!identityVerified) reasons.push('企业与官网主体尚未核实');
  if (!qualified) reasons.push('尚无满足产品、采购角色、持续经营及必需条件的A/B供货机会');
  if (!contactVerified) reasons.push('尚无同官网来源的公司级联系入口');
  return {
    policy: 'sales-handoff-v1',
    ready: identityVerified && qualified && contactVerified,
    reasons,
    identity_verified: identityVerified,
    opportunity_qualified: Boolean(qualified),
    contact_verified: contactVerified,
    contacts: verifiedContacts,
  };
}
