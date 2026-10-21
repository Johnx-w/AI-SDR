import acquisition from '../data/acquisition.json' with { type: 'json' };

export function buildSearchQuery(input) {
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
