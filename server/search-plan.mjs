import { validateCountryScope } from './search-target.mjs';
import acquisition from '../src/data/acquisition.json' with { type: 'json' };
import { automaticSearchPlan } from '../src/domain/search-query.mjs';
import {
  acquisitionMarkets,
  countryFor,
  WORLDWIDE_COUNTRY,
} from '../src/domain/country-catalog.ts';
import { isAllProductScope, productTerms } from '../src/domain/acquisition-products.mjs';

import { searchRegions } from './search-regions.mjs';

export const unifiedExecutionVersion = 'unified-batches-v1';

const localizedTerritories = {
  FR: ['fr', 'France'],
  DE: ['de', 'Deutschland'],
  ES: ['es', 'España'],
  MX: ['es', 'México'],
  AR: ['es', 'Argentina'],
  CL: ['es', 'Chile'],
  CO: ['es', 'Colombia'],
  BR: ['pt', 'Brasil'],
  IT: ['it', 'Italia'],
  NL: ['nl', 'Nederland'],
};
const localizedWords = {
  fr: ['fournisseur', 'stores', 'rideaux', 'stores extérieurs', 'composants pour stores'],
  de: ['Anbieter', 'Fensterrollos', 'Gardinen', 'Markisen', 'Rollo Zubehör'],
  es: ['proveedor', 'persianas', 'cortinas', 'toldos', 'componentes para persianas'],
  pt: ['fornecedor', 'persianas', 'cortinas', 'toldos', 'acessórios para persianas'],
  it: ['fornitore', 'tende a rullo', 'tende per finestre', 'tende da sole', 'accessori per tende'],
  nl: ['leverancier', 'rolgordijnen', 'gordijnen', 'zonwering', 'rolgordijn onderdelen'],
};

export function unifiedSearchPlan(input) {
  const plan = searchPlan(input).map((entry) => ({
    ...entry,
    language: input.query_mode !== 'auto' && entry.query === input.search_query ? 'und' : 'en',
  }));
  const worldwide = input.country === WORLDWIDE_COUNTRY;
  const territories = worldwide
    ? [
        ...new Set([
          'United States',
          'Mexico',
          'France',
          ...acquisitionMarkets.map(({ value }) => value),
          'Spain',
        ]),
      ]
    : [input.country];
  const broad = isAllProductScope(input);
  const products = broad ? [] : productTerms(input);
  const markets = [];
  for (let round = 0; round < 4; round++) {
    for (const country of territories) {
      const [language, place] = localizedTerritories[countryFor(country)?.code] || ['en', country];
      const original = plan[(round + 1) % plan.length];
      const words = localizedWords[language];
      const product = broad ? words?.[round + 1] : products[round % products.length];
      const query =
        product && words
          ? `"${product}" ${words[0]} ${place}`
          : worldwide
            ? `${place} ${original.query}`
            : original.query;
      markets.push({
        country,
        query: query.slice(0, 395),
        language,
        ...(worldwide ? { scope: WORLDWIDE_COUNTRY } : {}),
      });
    }
  }
  const interleaved = [plan[0]];
  for (let index = 0; index < Math.max(markets.length, plan.length - 1); index++) {
    if (markets[index]) interleaved.push(markets[index]);
    if (plan[index + 1]) interleaved.push(plan[index + 1]);
  }
  return [...new Map(interleaved.map((entry) => [entry.query, entry])).values()];
}

const lane = ({ country, language }) => JSON.stringify([country, language]);
export function productiveSearch(job, plan, unusedSearch) {
  // Keep two slots in three on the plan cursor even when one market performs well.
  if (job.searches < 8 || job.searches % 3 !== 2) return;
  const totals = new Map();
  for (const metric of job.searchStats) {
    if (metric.status !== 'completed') continue;
    const key = lane(metric);
    const total = totals.get(key) || { inserted: 0, researched: 0, credits: 0, seconds: 0 };
    total.inserted += metric.inserted;
    total.researched += metric.researched;
    total.credits += typeof metric.usage?.credits === 'number' ? metric.usage.credits : 1;
    total.seconds += Math.max(
      1,
      (Date.parse(metric.lastProcessedAt || metric.completedAt) - Date.parse(metric.startedAt)) /
        1000,
    );
    totals.set(key, total);
  }
  const score = ({ inserted, researched, credits, seconds }) =>
    (inserted / Math.max(1, researched)) * (inserted / seconds) * (inserted / Math.max(1, credits));
  for (const [key, total] of [...totals].sort(([, a], [, b]) => score(b) - score(a))) {
    if (!total.inserted) break;
    for (const candidate of plan) {
      if (lane(candidate) !== key) continue;
      const search = unusedSearch(candidate);
      if (search) return search;
    }
  }
}

export function regionalSearchAfter(job) {
  if (job.input.query_mode !== 'auto' && !isAllProductScope(job.input)) return;
  const previous = job.searchStats?.at(-1);
  const regions = searchRegions.get(job.input.country);
  if (
    !regions?.length ||
    previous?.status !== 'completed' ||
    previous.searchRegion ||
    !previous.duplicates ||
    previous.inserted !== 0 ||
    job.cursor < 1
  )
    return;
  const region = regions[(job.cursor - 1) % regions.length];
  const query = previous.query + ' ' + region;
  // Both supported providers must receive the complete product, country and region.
  if (query.length <= 128)
    return {
      country: job.input.country,
      query,
      searchRegion: region,
      ...(previous.language ? { language: previous.language } : {}),
    };
}

export function searchPlan(input) {
  validateCountryScope(input);
  const country = input.country;
  if (country === WORLDWIDE_COUNTRY || input.query_mode === 'auto' || isAllProductScope(input))
    return automaticSearchPlan(input);
  // Quote multi-word product phrases so Tavily matches them as exact phrases
  // instead of scattering generic words (e.g. "awnings") across unrelated sites.
  const products = input.product
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.includes(' ') ? '"' + p + '"' : p));
  const variants = input.customer_type
    ? ['', 'company', 'contact', 'showroom']
    : ['', 'supplier', 'installation', 'dealer', 'manufacturer', 'company', 'contact', 'showroom'];
  const result = [];
  for (const suffix of variants)
    for (const product of products) {
      result.push({
        country,
        query: [
          product,
          acquisition.customerTypes.find((t) => t.value === input.customer_type)?.terms,
          acquisition.profiles.find((p) => p.value === input.customer_profile)?.terms,
          country,
          suffix,
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 395),
      });
    }
  if (input.search_query) result.unshift({ country, query: input.search_query });
  return [...new Map(result.map((p) => [p.query, p])).values()];
}
