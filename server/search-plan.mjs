import { validateCountryScope } from './search-target.mjs';
import acquisition from '../src/data/acquisition.json' with { type: 'json' };
import { automaticSearchPlan, MAX_AUTO_SEARCH_QUERIES } from '../src/domain/search-query.mjs';
import {
  acquisitionCountryNames,
  countryFor,
  WORLDWIDE_COUNTRY,
} from '../src/domain/country-catalog.ts';
import { isAllProductScope, productTerms } from '../src/domain/acquisition-products.mjs';

import { searchRegions } from './search-regions.mjs';

export const unifiedExecutionVersion = 'unified-batches-v1';

const localizedTerritories = {
  DE: ['de', 'Deutschland'],
  MX: ['es', 'México'],
  AR: ['es', 'Argentina'],
  CL: ['es', 'Chile'],
  CO: ['es', 'Colombia'],
  BR: ['pt', 'Brasil'],
  IT: ['it', 'Italia'],
  NL: ['nl', 'Nederland'],
};
const localizedWords = {
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
  const territories = worldwide ? acquisitionCountryNames : [input.country];
  const broad = isAllProductScope(input);
  const products = broad ? [] : productTerms(input);
  const markets = [];
  for (let round = 0; round < 4; round++) {
    for (const country of territories) {
      const [language, place] = localizedTerritories[countryFor(country)?.code] || [];
      if (!language) continue;
      const words = localizedWords[language];
      const product = broad ? words?.[round + 1] : products[round % products.length];
      if (!product) continue;
      markets.push({
        country,
        query: `"${product}" ${words[0]} ${place}`.slice(0, 395),
        language,
      });
    }
  }
  const firstPass = worldwide ? acquisitionCountryNames.length : 1;
  const interleaved = plan
    .slice(0, firstPass)
    .map(
      (entry) =>
        (worldwide ? markets.find(({ country }) => country === entry.country) : null) || entry,
    );
  for (let index = 0; index < Math.max(markets.length, plan.length - firstPass); index++) {
    if (markets[index]) interleaved.push(markets[index]);
    if (plan[index + firstPass]) interleaved.push(plan[index + firstPass]);
  }
  return [...new Map(interleaved.map((entry) => [entry.query, entry])).values()].slice(
    0,
    MAX_AUTO_SEARCH_QUERIES,
  );
}

const lane = ({ country, language }) => JSON.stringify([country, language]);
function addUsage(total, field, value) {
  total[field] =
    total[field] !== null && Number.isFinite(value) && value >= 0
      ? (total[field] || 0) + value
      : null;
}

export function productiveSearch(job, plan, unusedSearch) {
  // Keep two slots in three on the plan cursor even when one market performs well.
  if (job.searches < 8 || job.searches % 3 !== 2) return;
  const totals = new Map();
  const bySearch = new Map();
  for (const metric of job.searchStats) {
    if (!['completed', 'failed'].includes(metric.status)) continue;
    const key = lane(metric);
    const total = totals.get(key) || { inserted: 0, researched: 0, seconds: 0 };
    total.inserted += metric.inserted;
    total.researched += metric.researched;
    addUsage(total, 'search_attempts', 1);
    addUsage(total, 'search_credits', metric.usage?.credits);
    total.seconds += Math.max(
      1,
      (Date.parse(metric.lastProcessedAt || metric.completedAt) - Date.parse(metric.startedAt)) /
        1000,
    );
    totals.set(key, total);
    bySearch.set(metric.id, total);
  }
  for (const row of job.rows) {
    const total = row.operation_id && bySearch.get(row.search_id);
    if (!total) continue;
    const models = row.research_usage;
    const extracts = row.web_usage;
    addUsage(total, 'model_calls', models?.model_calls);
    for (const direction of ['input', 'output']) {
      const field = direction + '_tokens';
      const value =
        models?.model_calls === 0
          ? 0
          : models?.model_calls === models?.['model_calls_with_' + field]
            ? models?.[field]
            : undefined;
      addUsage(total, field, value);
    }
    addUsage(total, 'web_extract_calls', extracts?.web_extract_calls);
    addUsage(
      total,
      'web_extract_credits',
      extracts?.web_extract_calls === 0 ? 0 : extracts?.web_extract_credits,
    );
  }
  const productive = [...totals].filter(([, total]) => total.inserted > 0);
  const evidence = { metered: [], attempts: [] };
  const comparable = (key) => productive.every(([, total]) => Number.isFinite(total[key]));
  for (const [meter, attempts] of [
    ['search_credits', 'search_attempts'],
    ['input_tokens', 'model_calls'],
    ['output_tokens', 'model_calls'],
    ['web_extract_credits', 'web_extract_calls'],
  ]) {
    if (comparable(meter)) evidence.metered.push(meter);
    else if (comparable(attempts) && !evidence.attempts.includes(attempts))
      evidence.attempts.push(attempts);
  }
  const units = [...evidence.metered, ...evidence.attempts];
  const score = (total) => {
    // Compare use per confirmed customer within each unit before combining ranks.
    const rank = units.reduce(
      (sum, unit) =>
        sum +
        productive.filter(
          ([, other]) => other[unit] / other.inserted < total[unit] / total.inserted,
        ).length,
      0,
    );
    const penalty = 1 + rank / (Math.max(1, units.length) * Math.max(1, productive.length - 1));
    return (
      ((total.inserted / Math.max(1, total.researched)) * (total.inserted / total.seconds)) /
      penalty
    );
  };
  const ranked = productive.map(([key, total]) => [key, score(total)]);
  for (const [key] of ranked.sort(([, a], [, b]) => b - a)) {
    for (const candidate of plan) {
      if (lane(candidate) !== key) continue;
      const search = unusedSearch(candidate);
      if (search) return { ...search, dispatchEvidence: evidence };
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
  if (country === WORLDWIDE_COUNTRY)
    return automaticSearchPlan(input)
      .slice(0, Math.ceil(MAX_AUTO_SEARCH_QUERIES / acquisitionCountryNames.length))
      .flatMap(({ query }) =>
        acquisitionCountryNames.map((country) => ({
          country,
          query: query.slice(0, 394 - country.length) + ' ' + country,
        })),
      )
      .slice(0, MAX_AUTO_SEARCH_QUERIES);
  if (input.query_mode === 'auto' || isAllProductScope(input)) return automaticSearchPlan(input);
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
