export const nativeRequirements = [
  'TAVILY_API_KEY',
  'DEEPSEEK_API_KEY',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_APP_TOKEN',
  'FEISHU_TABLE_ID',
];

const configured = (value) => typeof value === 'string' && Boolean(value.trim());
const configError = (message) => Object.assign(new Error(message), { status: 503 });

export function providerBaseUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configError(name + ' 必须是有效的 HTTPS 地址');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw configError(name + ' 必须使用 HTTPS，且不能包含账号、密码、查询参数或片段');
  return url.href.replace(/\/+$/, '');
}

// Only this boundary knows provider names, legacy variable aliases and endpoints.
// The acquisition/research flow consumes the same contract for every provider.
export function researchProviderConfig(env = {}) {
  const webProvider = env.WEB_SEARCH_PROVIDER?.trim() || 'tavily';
  const modelProvider = env.RESEARCH_MODEL_PROVIDER?.trim() || 'deepseek';
  if (!['tavily', 'http'].includes(webProvider))
    throw configError('WEB_SEARCH_PROVIDER 只能是 tavily 或 http');
  if (!['deepseek', 'openai_compatible'].includes(modelProvider))
    throw configError('RESEARCH_MODEL_PROVIDER 只能是 deepseek 或 openai_compatible');
  const webKeyName =
    webProvider === 'tavily' && !configured(env.WEB_SEARCH_API_KEY)
      ? 'TAVILY_API_KEY'
      : 'WEB_SEARCH_API_KEY';
  const modelKeyName =
    modelProvider === 'deepseek' && !configured(env.RESEARCH_MODEL_API_KEY)
      ? 'DEEPSEEK_API_KEY'
      : 'RESEARCH_MODEL_API_KEY';
  const webBase =
    env.WEB_SEARCH_BASE_URL?.trim() || (webProvider === 'tavily' ? 'https://api.tavily.com' : '');
  const modelBase =
    env.RESEARCH_MODEL_BASE_URL?.trim() ||
    (modelProvider === 'deepseek' ? 'https://api.deepseek.com' : '');
  const reasoningEffort = env.RESEARCH_MODEL_REASONING_EFFORT?.trim() || 'none';
  if (!['none', 'low', 'high', 'max'].includes(reasoningEffort))
    throw configError('研究推理强度只能是 none、low、high 或 max');
  const defaultOutput =
    modelProvider === 'deepseek'
      ? ['high', 'max'].includes(reasoningEffort)
        ? 48000
        : reasoningEffort === 'low'
          ? 24000
          : 16000
      : 16000;
  const outputSetting = env.RESEARCH_MODEL_MAX_OUTPUT_TOKENS?.trim() || String(defaultOutput);
  const maxOutputTokens = Number(outputSetting);
  if (
    !/^\d+$/.test(outputSetting) ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 4096 ||
    maxOutputTokens > 65536
  )
    throw configError('研究模型输出上限必须是 4096–65536 的整数');
  return {
    web: {
      provider: webProvider,
      baseUrl: webBase ? providerBaseUrl(webBase, 'WEB_SEARCH_BASE_URL') : '',
      apiKey: env[webKeyName]?.trim() || '',
      requirements: [webKeyName, ...(webProvider === 'http' ? ['WEB_SEARCH_BASE_URL'] : [])],
    },
    model: {
      provider: modelProvider,
      baseUrl: modelBase ? providerBaseUrl(modelBase, 'RESEARCH_MODEL_BASE_URL') : '',
      apiKey: env[modelKeyName]?.trim() || '',
      reasoningEffort,
      maxOutputTokens,
      timeoutMs: modelProvider === 'deepseek' && reasoningEffort !== 'none' ? 480000 : 180000,
      model:
        env.RESEARCH_MODEL_MODEL?.trim() ||
        (modelProvider === 'deepseek' ? env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash' : ''),
      requirements: [
        modelKeyName,
        ...(modelProvider === 'openai_compatible'
          ? ['RESEARCH_MODEL_BASE_URL', 'RESEARCH_MODEL_MODEL']
          : []),
      ],
    },
  };
}

export function acquisitionConfig(env = {}) {
  const provider = env.ACQUISITION_PROVIDER || 'n8n';
  if (!['n8n', 'native'].includes(provider))
    throw Object.assign(new Error('ACQUISITION_PROVIDER 只能是 n8n 或 native'), { status: 503 });
  const research = researchProviderConfig(env);
  const requirements = [
    ...research.web.requirements,
    ...research.model.requirements,
    ...nativeRequirements.filter((name) => name.startsWith('FEISHU_')),
  ];
  const missing = requirements.filter((name) => !configured(env[name]));
  return {
    provider,
    webSearchProvider: research.web.provider,
    researchModelProvider: research.model.provider,
    nativeReady: missing.length === 0,
    requirements,
    missing,
  };
}

export async function platformJson(fetchImpl, url, options, service) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: options.signal || AbortSignal.timeout(30000),
    });
  } catch {
    throw Object.assign(new Error(service + '连接中断或超时'), { status: 502 });
  }
  if (!response.ok)
    throw Object.assign(new Error(service + '请求失败（HTTP ' + response.status + '）'), {
      status: 502,
      upstreamStatus: response.status,
    });
  try {
    return await response.json();
  } catch {
    throw Object.assign(new Error(service + '返回格式异常'), { status: 502 });
  }
}
