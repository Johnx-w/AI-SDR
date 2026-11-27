import { setTimeout as delay } from 'node:timers/promises';
import { platformJson, researchProviderConfig } from './acquisition-config.mjs';
import { websiteUrl } from './branding.mjs';

const fail = (message, status = 502) => Object.assign(new Error(message), { status });

function requireConfigured(config, label) {
  if (!config.apiKey || !config.baseUrl || (label === '研究模型' && !config.model))
    throw fail(label + '连接配置不完整', 503);
}

function normalizeWebResults(data, label) {
  if (!Array.isArray(data?.results)) throw fail(label + '未返回有效结果');
  return {
    results: data.results.flatMap((row) => {
      const url = typeof row?.url === 'string' && websiteUrl(row.url);
      if (!url) return [];
      return [
        {
          url: url.href,
          title: typeof row.title === 'string' ? row.title : '',
          ...(typeof row.content === 'string' ? { content: row.content } : {}),
          ...(typeof row.raw_content === 'string' ? { raw_content: row.raw_content } : {}),
          ...(typeof row.score === 'number' ? { score: row.score } : {}),
        },
      ];
    }),
    ...(data.usage !== undefined ? { usage: data.usage } : {}),
  };
}

function requestLane() {
  let active = 0;
  let cooldownUntil = 0;
  const waiting = [];
  return async (send) => {
    if (active < 4) active++;
    else await new Promise((resolve) => waiting.push(resolve));
    try {
      for (let attempt = 0; ; attempt++) {
        while (cooldownUntil > Date.now()) await delay(cooldownUntil - Date.now());
        try {
          return await send();
        } catch (error) {
          if (error.upstreamStatus !== 429) throw error;
          const cooldown = error.retryAfterMs ?? 1000 * 2 ** attempt;
          cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.min(cooldown, 60000));
          if (attempt >= 2 || cooldown > 60000) throw error;
        }
      }
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export function addModelTokens(usage, response) {
  const tokens = response.usage || response.body?.usage || {};
  const input = tokens.input_tokens ?? tokens.prompt_tokens;
  const output = tokens.output_tokens ?? tokens.completion_tokens;
  const valid = (value) => Number.isSafeInteger(value) && value >= 0;
  for (const [field, value] of [
    ['input_tokens', input],
    [
      'input_cached_tokens',
      tokens.input_tokens_details?.cached_tokens ??
        tokens.prompt_tokens_details?.cached_tokens ??
        tokens.prompt_cache_hit_tokens,
    ],
    ['output_tokens', output],
    [
      'total_tokens',
      tokens.total_tokens ?? (valid(input) && valid(output) ? input + output : undefined),
    ],
  ]) {
    if (valid(value)) usage[field] = (usage[field] || 0) + value;
  }
}

// HTTP search gateways implement POST /search and /extract using the same
// provider-neutral request fields as the current flow (query/urls, limits etc.).
// Their JSON response is { results: [{url,title,content?,raw_content?}], usage? }.
// No response/error text is ever copied into transport failures or logs.
export function createResearchProviders({ env = {}, fetchImpl = fetch } = {}) {
  const config = researchProviderConfig(env);
  const webLane = requestLane();
  const modelLane =
    config.web.baseUrl &&
    config.model.baseUrl &&
    new URL(config.web.baseUrl).origin === new URL(config.model.baseUrl).origin
      ? webLane
      : requestLane();
  const call = (lane, url, options, timeout, label) =>
    lane(() =>
      platformJson(fetchImpl, url, { ...options, signal: AbortSignal.timeout(timeout) }, label),
    );
  const deepseekCall = (path, body) => {
    requireConfigured(config.web, '网页检索');
    return call(
      webLane,
      config.web.baseUrl.replace(/\/v1$/, '') + '/v1/tools/' + path,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.web.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      path === 'fetch' ? 60000 : 30000,
      'DeepSeek',
    );
  };
  const webCall = async (path, body) => {
    requireConfigured(config.web, '网页检索');
    const label = config.web.provider === 'tavily' ? 'Tavily' : '网页检索';
    const data = await call(
      webLane,
      config.web.baseUrl + '/' + path,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.web.apiKey,
          'Content-Type': 'application/json',
        },
        // Ask the official provider for per-request billing telemetry. Keep
        // generic HTTP gateways' contract unchanged and never raise depth.
        body: JSON.stringify(
          config.web.provider === 'tavily' ? { ...body, include_usage: true } : body,
        ),
      },
      path === 'extract' ? 60000 : 30000,
      label,
    );
    if (!Array.isArray(data?.results)) throw fail(label + ' 未返回有效结果');
    // Keep existing Tavily result/usage semantics for backward compatibility.
    return config.web.provider === 'tavily' ? data : normalizeWebResults(data, label);
  };
  return {
    web: {
      provider: config.web.provider,
      search: async (body) => {
        if (config.web.provider !== 'deepseek') return webCall('search', body);
        let query = body.query.slice(0, 128);
        // shortcut: only exclusions fitting 128 characters reach DeepSeek, upgrade if repeats starve discovery.
        for (const domain of [...(body.exclude_domains || [])].reverse()) {
          const exclusion = ' -site:' + domain;
          if (query.length + exclusion.length <= 128) query += exclusion;
        }
        const data = await deepseekCall('search', {
          query,
          count: body.max_results,
          need_content: false,
        });
        return normalizeWebResults(
          {
            results: Array.isArray(data.results)
              ? data.results.map((row) => ({
                  url: row?.url,
                  title: row?.title,
                  content: row?.summary || row?.snippet,
                }))
              : data.results,
          },
          'DeepSeek',
        );
      },
      extract: async (body) => {
        if (config.web.provider !== 'deepseek') return webCall('extract', body);
        const pages = await Promise.allSettled(
          body.urls.map(async (url) => {
            const page = await deepseekCall('fetch', { url });
            return { url, raw_content: page.content || '' };
          }),
        );
        return {
          results: pages.filter((page) => page.status === 'fulfilled').map((page) => page.value),
        };
      },
    },
    model: {
      provider: config.model.provider,
      // Non-secret semantics only. Keep parameters aligned with research() and
      // bump the version if request behavior changes outside these fields.
      cacheIdentity: {
        version: 'company-research-request-v1',
        protocol: config.model.provider === 'deepseek' ? 'responses' : 'chat_completions',
        provider: config.model.provider,
        baseUrl: config.model.baseUrl,
        model: config.model.model,
        requestParameters:
          config.model.provider === 'deepseek'
            ? {
                max_output_tokens: config.model.maxOutputTokens,
                reasoning: { effort: config.model.reasoningEffort },
                temperature: 0,
                store: false,
                text: { format: { type: 'json_schema', name: 'company_research', strict: true } },
              }
            : {
                max_tokens: config.model.maxOutputTokens,
                temperature: 0,
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: 'company_research', strict: true },
                },
              },
      },
      async research({ messages, schema }) {
        requireConfigured(config.model, '研究模型');
        const deepseek = config.model.provider === 'deepseek';
        const body = deepseek
          ? {
              model: config.model.model,
              input: messages,
              max_output_tokens: config.model.maxOutputTokens,
              reasoning: { effort: config.model.reasoningEffort },
              temperature: 0,
              store: false,
              text: {
                format: { type: 'json_schema', name: 'company_research', strict: true, schema },
              },
            }
          : {
              model: config.model.model,
              messages,
              max_tokens: config.model.maxOutputTokens,
              temperature: 0,
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'company_research', strict: true, schema },
              },
            };
        return call(
          modelLane,
          config.model.baseUrl + (deepseek ? '/responses' : '/chat/completions'),
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + config.model.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          },
          config.model.timeoutMs,
          deepseek ? 'DeepSeek' : '研究模型',
        );
      },
    },
  };
}
