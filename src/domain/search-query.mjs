import acquisition from '../data/acquisition.json' with { type: 'json' };
import { isAllProductScope, productTerms } from './acquisition-products.mjs';

const quote = (value) => '"' + value.replace(/"/g, '') + '"';
const audienceTerms = {
  B: '(wholesale OR trade OR commercial)',
  C: '(residential OR homeowners)',
  BC: '',
};
export const MAX_AUTO_SEARCH_QUERIES = 600;

// The default campaign covers businesses and delivery forms, rather than treating
// the finished-product catalog as a list of required customer products.
const broadProductLanes = {
  general: ['window coverings', 'window furnishings', 'window treatments'],
  indoor: [
    'roller blinds',
    'curtains',
    'venetian blinds',
    'cellular shades',
    'roman shades',
    'vertical blinds',
    'plantation shutters',
  ],
  outdoor: ['outdoor blinds', 'awnings', 'zip screens', 'pergolas', 'outdoor shading'],
  semifinished: [
    'semi finished blinds',
    'blinds fabric',
    'curtain fabric',
    'blind profiles',
    'blind slats',
  ],
  components: [
    'blind components',
    'curtain hardware',
    'blind motors',
    'awning components',
    'shutter components',
    'curtain tracks',
  ],
};

const greatestCommonDivisor = (left, right) => {
  while (right) [left, right] = [right, left % right];
  return left;
};

function broadSearchPlan(input, countries, roleVariants, hints) {
  const cycle =
    input.environment_preference === 'indoor'
      ? ['indoor', 'general', 'outdoor', 'semifinished', 'indoor', 'components']
      : input.environment_preference === 'outdoor'
        ? ['outdoor', 'general', 'indoor', 'semifinished', 'outdoor', 'components']
        : ['general', 'indoor', 'outdoor', 'semifinished', 'components'];
  const suffixes = ['', 'company contact', 'showroom'];
  const lanes = Object.fromEntries(
    Object.entries(broadProductLanes).map(([name, terms]) => {
      const total = terms.length * countries.length * roleVariants.length * suffixes.length;
      // A coprime stride visits every combination once. It also varies markets,
      // product families and roles before a short run consumes its search budget.
      let stride = Math.max(1, Math.round(total * 0.618));
      while (greatestCommonDivisor(stride, total) !== 1) stride++;
      return [name, { terms, total, stride, cursor: 0 }];
    }),
  );
  const queries = new Map();
  let remaining = Object.values(lanes).reduce((sum, lane) => sum + lane.total, 0);
  let position = 0;
  while (remaining && queries.size < MAX_AUTO_SEARCH_QUERIES) {
    const lane = lanes[cycle[position++ % cycle.length]];
    if (lane.cursor >= lane.total) continue;
    let index = (lane.cursor++ * lane.stride) % lane.total;
    remaining--;
    const country = countries[index % countries.length];
    index = Math.floor(index / countries.length);
    const term = lane.terms[index % lane.terms.length];
    index = Math.floor(index / lane.terms.length);
    const role = roleVariants[index % roleVariants.length];
    index = Math.floor(index / roleVariants.length);
    const suffix = suffixes[index % suffixes.length];
    const query = [
      quote(term),
      role,
      audienceTerms[input.audience || 'BC'],
      suffix === '' ? hints.join(' ') : '',
      input.region,
      country,
      suffix,
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 395);
    queries.set(query, { country, query });
  }
  return [...queries.values()];
}

export function automaticSearchPlan(input, countries = [input.country]) {
  const roles = input.customer_types || (input.customer_type ? [input.customer_type] : []);
  const selected = acquisition.customerTypes.filter((type) => roles.includes(type.value));
  const roleVariants = selected.length
    ? selected.map((type) => type.terms)
    : ['', 'supplier', 'dealer', 'manufacturer'];
  const preferences = String(input.preferred_requirements || '');
  const hints = [
    [/电动|自动化|motori[sz]ed/i, 'motorized'],
    [/酒店|hotel/i, 'hotel projects'],
    [/工程|商用|commercial/i, 'commercial projects'],
    [/定制|custom/i, 'custom made'],
  ]
    .filter(([pattern]) => pattern.test(preferences))
    .map(([, term]) => term);
  if (isAllProductScope(input)) return broadSearchPlan(input, countries, roleVariants, hints);
  const suffixes = ['', 'company contact', 'showroom'];
  const products = productTerms(input);
  const total = suffixes.length * roleVariants.length * products.length * countries.length;
  const sampleSize = Math.min(total, MAX_AUTO_SEARCH_QUERIES);
  let stride = Math.max(1, Math.ceil(total / sampleSize));
  while (total > sampleSize && greatestCommonDivisor(stride, total) !== 1) stride++;
  const queries = [];
  // The worker can execute at most 600 searches. For larger Cartesian products,
  // sample evenly across suffix, role, product and country instead of letting the
  // first outer dimension consume the whole budget.
  for (let sample = 0; sample < sampleSize; sample++) {
    let index = total <= sampleSize ? sample : (sample * stride) % total;
    const country = countries[index % countries.length];
    index = Math.floor(index / countries.length);
    const product = products[index % products.length];
    index = Math.floor(index / products.length);
    const role = roleVariants[index % roleVariants.length];
    index = Math.floor(index / roleVariants.length);
    const suffix = suffixes[index % suffixes.length];
    queries.push({
      country,
      query: [
        quote(product),
        role,
        audienceTerms[input.audience || 'BC'],
        suffix === '' ? hints.join(' ') : '',
        input.region,
        country,
        suffix,
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 395),
    });
  }
  return [...new Map(queries.map((q) => [q.query, q])).values()];
}

export function buildSearchQuery(input) {
  if (input.query_mode === 'auto' || isAllProductScope(input))
    return automaticSearchPlan(input)[0]?.query || '';
  const products = String(input.product || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.includes(' ') ? '"' + p.replace(/"/g, '') + '"' : p));
  const productQuery = products.length > 1 ? '(' + products.join(' OR ') + ')' : products[0];
  return [
    productQuery,
    acquisition.customerTypes.find((t) => t.value === input.customer_type)?.terms,
    acquisition.profiles.find((p) => p.value === input.customer_profile)?.terms,
    input.audience === 'B'
      ? '(wholesale OR trade OR commercial)'
      : input.audience === 'C'
        ? '(residential OR homeowners)'
        : '',
    input.region,
    input.country,
  ]
    .filter(Boolean)
    .join(' ');
}
