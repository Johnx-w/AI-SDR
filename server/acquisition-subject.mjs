import { createHash } from 'node:crypto';
import { domainKey } from './website-identity.mjs';

export const acquisitionIdentityVersion = 'registered-operator-v1';

export function acquisitionUrl(value) {
  try {
    const url = new URL(value);
    const domain = domainKey(value);
    if (!domain) return '';
    return `https://${domain}${url.pathname.replace(/\/+$/, '') || '/'}${url.search}`;
  } catch {
    return '';
  }
}

export const subjectName = (value) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/(?:limited|ltd|incorporated|inc|llc|corporation|corp|gmbh)$/u, '');

// Read a registration only from the verified operator's own legal excerpt.
// A bare name, a place's identifier, or a number elsewhere on the page is insufficient.
export function verifiedRegistration(identity, facts = []) {
  if (identity?.status !== 'legal_name_self_reported') return null;
  const registrations = new Map();
  for (const fact of identity.evidence || []) {
    if (fact.field !== 'legal_company_name' || !fact.snapshot_id) continue;
    const quote = fact.quote.normalize('NFKC').replace(/\s+/g, ' ');
    const uk = /\b(?:england and wales|scotland|northern ireland|united kingdom|uk)\b/i.test(quote)
      ? /\b(?:company|registration)\s+(?:registration\s+)?(?:number|no\.?)\s*[:#]?\s*((?:[A-Z]{2}\s*)?\d{6,8})\b/i.exec(
          quote,
        )
      : null;
    const abn =
      /\b(?:ABN|Australian Business Number)\s*[:#]?\s*(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})\b/i.exec(
        quote,
      );
    const id = (uk?.[1] || abn?.[1] || '').replace(/\s/g, '').toUpperCase();
    if (uk && !/^(?:[A-Z]{2}\d{6}|\d{8})$/.test(id)) continue;
    if (id) registrations.set(`${uk ? 'gb-company' : 'au-abn'}:${id}`, fact);
  }
  if (registrations.size > 1) return null;
  if (registrations.size === 1) {
    const [[key, evidence]] = registrations;
    return { key, kind: 'identifier', evidence };
  }
  const literal = (value) =>
    String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const evidence = identity.evidence.find(
    (fact) => fact.field === 'legal_company_name' && fact.snapshot_id,
  );
  if (!evidence) return null;
  const company = literal(identity.legal_name);
  const offices = new Map();
  for (const fact of facts) {
    if (fact.field !== 'address' || !fact.snapshot_id || fact.quote === evidence.quote) continue;
    const quote = literal(fact.quote);
    if (
      !/\b(?:registered office|registered address|siège social|firmensitz|sede legale|domicilio social)\b/u.test(
        quote,
      )
    )
      continue;
    if (!` ${quote} `.includes(` ${company} `)) continue;
    const { street, city, postal_code, country } = fact.value || {};
    const address = [street, city, postal_code, country].map(literal);
    if (!address.every((part) => part && ` ${quote} `.includes(` ${part} `))) continue;
    const key =
      'registered-office:' +
      createHash('sha256')
        .update(JSON.stringify([company, ...address]))
        .digest('hex');
    offices.set(key, fact);
  }
  if (offices.size !== 1) return null;
  const [[key, address_evidence]] = offices;
  return { key, kind: 'registered_office', evidence, address_evidence };
}
