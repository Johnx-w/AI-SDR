import { createHash } from 'node:crypto';

const CACHE_POLICY_VERSION = 'exact-research-request-v1';

// Canonical JSON: object key order is immaterial; array order and string bytes
// are not. Reject non-JSON values rather than risking an ambiguous cache hit.
function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Not JSON');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('Not a JSON object');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++)
        if (!Object.hasOwn(value, index)) throw new Error('Sparse array is not JSON');
      return '[' + value.map((item) => canonicalJson(item, ancestors)).join(',') + ']';
    }
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key], ancestors))
        .join(',') +
      '}'
    );
  } finally {
    ancestors.delete(value);
  }
}

// Adapters explicitly opt into reuse with a non-empty JSON identity object.
// Identity must describe the request semantics, never credentials. This helper
// only returns a digest: no storage, credentials or customer writes belong here.
export function researchCacheKey({ messages, schema, identity } = {}) {
  if (
    !identity ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    !Object.keys(identity).length ||
    !Array.isArray(messages) ||
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema)
  )
    return null;
  try {
    const request = canonicalJson({ policy: CACHE_POLICY_VERSION, identity, messages, schema });
    return createHash('sha256').update(request).digest('hex');
  } catch {
    // Unknown adapter identities and unsupported payloads safely skip reuse.
    return null;
  }
}
