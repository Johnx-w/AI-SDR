import { setTimeout as delay } from 'node:timers/promises';
import { countryFor } from '../src/domain/country-catalog.ts';

const searchLimit = 3;
const placeLimit = 20;
const mapTimeoutMs = 2500;

function googlePlaces({ env, fetchImpl }) {
  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key) return { unavailable: 'credentials_missing' };
  if (env.GOOGLE_PLACES_IDS_ONLY !== 'true') return { unavailable: 'website_mapping_unavailable' };
  return {
    name: 'google_places',
    identifiersOnly: true,
    async search({ query, country, signal }) {
      const region = countryFor(country)?.code;
      const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.id',
        },
        body: JSON.stringify({
          textQuery: query,
          pageSize: placeLimit,
          ...(region ? { regionCode: region.toLowerCase() } : {}),
        }),
      });
      if (!response.ok)
        throw Object.assign(new Error('Places HTTP ' + response.status), {
          status: response.status,
          retryAfter: response.headers.get('retry-after'),
        });
      const data = await response.json();
      return { places: data.places?.map(({ id }) => ({ id })) ?? [] };
    },
  };
}

function retryDelay(value) {
  if (value == null || value === '') return 250;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
}

async function readPlaces(provider, search, deadline) {
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(deadline.reason);
    deadline.addEventListener('abort', abort, { once: true });
    if (deadline.aborted) abort();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => provider.search({ ...search, signal: deadline })),
      interrupted,
    ]);
  } finally {
    deadline.removeEventListener('abort', abort);
  }
}

export function createMapsDiscovery({
  env,
  fetchImpl,
  provider = googlePlaces({ env, fetchImpl }),
}) {
  let active = false;
  let cooldownUntil = 0;
  return async (search, context) => {
    const { blocked, used, unknown } = context;
    const metric = {
      attempts: 0,
      returned: 0,
      resolved: 0,
      ...(provider.name ? { provider: provider.name } : {}),
    };
    const result = (status, reason, places = []) => ({
      maps: { ...metric, status, ...(reason ? { reason } : {}) },
      places,
    });
    if (blocked) return result('paused', blocked);
    if (provider.unavailable) return result('unavailable', provider.unavailable);
    if (unknown) return result('paused', 'request_unknown');
    if (used >= searchLimit) return result('budget_limit');
    if (active) return result('deferred', 'provider_busy');
    if (cooldownUntil > Date.now()) return result('rate_limited', 'provider_cooldown');
    active = true;
    const deadline = AbortSignal.timeout(mapTimeoutMs);
    try {
      while (++metric.attempts <= 2) {
        try {
          context.beforeRequest(metric.attempts);
          const data = await readPlaces(provider, search, deadline);
          if (!Array.isArray(data?.places)) return result('failed', 'invalid_response');
          const places = data.places.slice(0, placeLimit).flatMap((place) => {
            const { id, name, website } = place || {};
            if (typeof id !== 'string' || !/^[\w-]{1,255}$/.test(id)) return [];
            return [
              {
                id,
                ...(typeof name === 'string' && name.trim()
                  ? { name: name.trim().slice(0, 300) }
                  : {}),
                ...(typeof website === 'string' && website.length <= 2048 ? { website } : {}),
              },
            ];
          });
          metric.returned = places.length;
          if (Number.isFinite(data.usage?.credits) && data.usage.credits >= 0)
            metric.usage = { credits: data.usage.credits };
          if (provider.identifiersOnly)
            return result('identifiers_only', 'website_mapping_unavailable');
          return result('completed', null, places);
        } catch (error) {
          if ([401, 403].includes(error?.status)) return result('unavailable', 'permission_denied');
          if (error?.status !== 429)
            return result(
              'failed',
              deadline.aborted || !error?.status ? 'request_unknown' : 'provider_failed',
            );
          const retryMs = retryDelay(error.retryAfter);
          cooldownUntil = Date.now() + (Number.isFinite(retryMs) ? Math.max(retryMs, 250) : 1000);
          if (metric.attempts !== 1 || !Number.isFinite(retryMs) || retryMs < 0 || retryMs > 500)
            return result('rate_limited', 'retry_deferred');
          try {
            await delay(retryMs, undefined, { signal: deadline });
          } catch {
            return result('rate_limited', 'retry_deferred');
          }
        }
      }
    } finally {
      active = false;
    }
  };
}
