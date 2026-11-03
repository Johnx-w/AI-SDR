import { createHash } from 'node:crypto';
import { validateTarget } from './search-target.mjs';
import { canonicalJson } from './research-reuse.mjs';

const EXCLUSION_RULE_VERSION = 'explicit-exclusion-v1';
const sorted = (items) =>
  [...items].sort((a, b) => {
    const left = canonicalJson(a),
      right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });

export function exclusionConditionsKey(input) {
  const target = validateTarget(input);
  const products = sorted(
    (target.products || []).map((product) => ({
      ...product,
      aliases: sorted(product.aliases || []),
    })),
  );
  const conditions = {
    country: target.country,
    region: target.region,
    market_countries: sorted(target.market_countries),
    product_scope: target.product_scope || 'specific',
    product: products.length ? products.map((product) => product.value).join(', ') : target.product,
    products,
    environment_preference: target.environment_preference ?? 'all',
    audience: target.audience,
    customer_type: target.customer_type,
    customer_types: sorted(target.customer_types || []),
    customer_profile: target.customer_profile,
    preferred_requirements: target.preferred_requirements ?? '',
    required_requirements: sorted(target.required_requirements || []),
    query_mode: target.query_mode ?? '',
    acquisition_channel: target.acquisition_channel,
  };
  return createHash('sha256')
    .update(canonicalJson({ version: EXCLUSION_RULE_VERSION, conditions }))
    .digest('hex');
}
