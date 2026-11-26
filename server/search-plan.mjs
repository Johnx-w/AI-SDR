import { validateCountryScope } from './search-target.mjs';
import acquisition from '../src/data/acquisition.json' with { type: 'json' };
import { automaticSearchPlan } from '../src/domain/search-query.mjs';
import { isAllProductScope } from '../src/domain/acquisition-products.mjs';

import { marketRegions } from './market-regions.mjs';

export function regionalSearchAfter(job) {
  if (job.input.query_mode !== 'auto' && !isAllProductScope(job.input)) return;
  const previous = job.searchStats?.at(-1);
  const regions = marketRegions[job.input.country];
  if (
    !regions?.length ||
    previous?.status !== 'completed' ||
    previous.searchRegion ||
    !previous.duplicates ||
    previous.inserted !== 0 ||
    job.cursor < 1
  )
    return;
  const region = regions[(job.cursor - 1) % regions.length].name;
  const query = previous.query + ' ' + region;
  // Both supported providers must receive the complete product, country and region.
  if (query.length <= 128) return { country: job.input.country, query, searchRegion: region };
}

export function searchPlan(input) {
  validateCountryScope(input);
  const country = input.country;
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
