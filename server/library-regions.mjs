import subdivisions from './data/subdivisions-bilingual.json' with { type: 'json' };
import { countries, countryFor } from '../src/domain/country-catalog.ts';
import { marketRegions } from './market-regions.mjs';
const subdivisionsByCountry = new Map();
for (const country of countries) {
  const lookup = new Map();
  const rows = [
    ...(subdivisions[country.code] || []),
    ...(marketRegions[country.name] || []).map((r) => [r.code, r.name, r.label]),
  ];
  // Keep older spellings searchable while displaying one preferred label per subdivision.
  const labels = new Map(rows.map(([code, en, zh]) => [code, zh + '.' + en]));
  for (const [code, en, zh] of rows) {
    const label = labels.get(code);
    for (const key of [code, en, zh, country.code + '-' + code])
      lookup.set(key.toLowerCase(), label);
  }
  subdivisionsByCountry.set(country.code, lookup);
}
export function addressRegion(lead) {
  const country = countryFor(lead.market);
  const token = String(lead.region || '')
    .split('·')[0]
    .trim()
    .toLowerCase();
  if (
    country?.code === 'AE' &&
    (!token || token === '迪拜') &&
    (token === '迪拜' || ['dubai', '迪拜'].includes(String(lead.market).toLowerCase()))
  )
    return '迪拜酋长国.Dubai';
  return subdivisionsByCountry.get(country?.code)?.get(token) || '待核实';
}
export function regionChoices(market, observed) {
  const country = countryFor(market);
  const known = country ? subdivisionsByCountry.get(country.code).values() : observed;
  return [...new Set(known)]
    .filter((v) => v && v !== '待核实')
    .sort(
      (a, b) =>
        a.slice(a.indexOf('.') + 1).localeCompare(b.slice(b.indexOf('.') + 1), 'en') ||
        a.localeCompare(b, 'zh'),
    );
}
