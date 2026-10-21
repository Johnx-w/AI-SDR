export const nativeRequirements = [
  'TAVILY_API_KEY',
  'DEEPSEEK_API_KEY',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_APP_TOKEN',
  'FEISHU_TABLE_ID',
];

export function acquisitionConfig(env) {
  const provider = env.ACQUISITION_PROVIDER || 'n8n';
  if (!['n8n', 'native'].includes(provider))
    throw Object.assign(new Error('ACQUISITION_PROVIDER 只能是 n8n 或 native'), { status: 503 });
  const missing = nativeRequirements.filter((name) => !env[name]?.trim());
  return { provider, nativeReady: missing.length === 0, missing };
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
