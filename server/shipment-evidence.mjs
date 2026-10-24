import { domainKey } from './website-identity.mjs';

const normalize = (s) =>
  String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const companyName = (s) =>
  normalize(s)
    .replace(/\b(?:incorporated|corporation|limited|inc|corp|ltd|llc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Website facts have already passed the shared verbatim-quote audit. A cargo
// description or US disclosure port is never evidence of the operating country.
export function matchShipmentBuyer(buyer, research, website) {
  const identity = research.company_identity || {};
  const names = [
    research.company_name,
    identity.name,
    identity.legal_name,
    identity.website_name,
    ...(identity.aliases || []),
  ].filter(Boolean);
  const name = companyName(buyer.name);
  const nameMatched = name.length >= 4 && names.some((s) => companyName(s) === name);
  if (!nameMatched) return { status: 'conflict', reason: '海关买方名称与官网经营主体不匹配' };
  const country = normalize(research.actual_country);
  const declared = normalize(buyer.country);
  if (
    country &&
    declared &&
    country !== declared &&
    !(
      [country, declared].every((c) => ['us', 'usa', 'united states'].includes(c)) ||
      [country, declared].every((c) => ['ca', 'canada'].includes(c))
    )
  )
    return { status: 'conflict', reason: '买方经营国与官网所在地冲突，需人工消歧' };
  const address = research.address || {};
  const cargoAddress = normalize(buyer.address);
  const postal = normalize(address.postal_code).replace(/ /g, '');
  const postalMatched = postal.length >= 5 && cargoAddress.replace(/ /g, '').includes(postal);
  const street = normalize(address.street);
  const city = normalize(address.city);
  const streetMatched =
    street.length >= 8 &&
    cargoAddress.includes(street) &&
    city.length >= 3 &&
    cargoAddress.includes(city);
  const domainMatched = buyer.source_url && domainKey(buyer.source_url) === domainKey(website);
  if (postalMatched || streetMatched || (domainMatched && country))
    return {
      status: 'verified',
      reason:
        postalMatched || streetMatched
          ? '官网主体名称和地址与海关买方一致'
          : '买方官网域名、主体名称和经营国一致',
    };
  return {
    status: 'name_only',
    reason: '官网经营主体名称一致，缺少地址等第二身份依据；进口记录尚未核实关联',
  };
}

export function mergeShipmentEvidence(prior = {}, incoming = {}) {
  const records = new Map();
  for (const record of [
    ...(prior.records || []),
    ...(incoming.records || incoming.shipments || []),
  ]) {
    // Keep different provider roles/parties even when sharing a B/L.
    const key = record.id ? `${record.provider}:${record.id}` : JSON.stringify(record);
    records.set(key, record);
  }
  const rows = [...records.values()];
  const bills = [...new Set(rows.map((r) => r.bill_of_lading_number).filter(Boolean))];
  const dates = rows
    .map((r) => r.date)
    .filter(Boolean)
    .sort();
  return {
    ...prior,
    ...incoming,
    records: rows,
    shipments: undefined,
    metrics: {
      record_count: rows.length,
      bill_of_lading_count: bills.length,
      unnumbered_record_count: rows.filter((r) => !r.bill_of_lading_number).length,
      active_months: [...new Set(dates.map((s) => s.slice(0, 7)))],
      last_event_date: dates.at(-1) || null,
      frequency_semantics: 'observed_bills_not_purchase_orders',
    },
  };
}
