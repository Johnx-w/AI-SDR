import { groupedMarkets, audienceTerms } from './markets.mjs';
import { locationOptions } from './search-target.mjs';
import acquisition from '../src/data/acquisition.json' with { type: 'json' };
import { automaticSearchPlan } from '../src/domain/search-query.mjs';
import { isAllProductScope } from '../src/domain/acquisition-products.mjs';
import { customsSearchPlan } from './customs-discovery.mjs';

export function searchPlan(input) {
  const channel = input.acquisition_channel;
  if (channel === 'customs') return customsSearchPlan(input);
  if (channel === 'dual')
    return [
      ...customsSearchPlan(input),
      ...webSearchPlan(input).map((s) => ({ ...s, source_kind: 'web' })),
    ];
  return webSearchPlan(input);
}

function webSearchPlan(input) {
  locationOptions(input.country, input.region);
  const countries = groupedMarkets[input.country] || [input.country];
  if (input.query_mode === 'auto' || isAllProductScope(input))
    return automaticSearchPlan(input, countries);
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
    for (const product of products)
      for (const country of countries) {
        result.push({
          country,
          query: [
            product,
            audienceTerms[input.audience],
            acquisition.customerTypes.find((t) => t.value === input.customer_type)?.terms,
            acquisition.profiles.find((p) => p.value === input.customer_profile)?.terms,
            input.region,
            country,
            suffix,
          ]
            .filter(Boolean)
            .join(' ')
            .slice(0, 395),
        });
      }
  if (countries.length === 1) result.unshift({ country: input.country, query: input.search_query });
  return [...new Map(result.map((p) => [p.query, p])).values()];
}
