import { researchProviderConfig } from './acquisition-config.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MODELS = 500;
const TIMEOUT_MS = 15000;

class ModelDiscoveryError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.status = statusCode;
    this.statusCode = statusCode;
  }
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('aborted'));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
}

function cancelBody(response) {
  // Do not retain or display upstream error bodies, and release the connection.
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    /* Already consumed. */
  }
}

async function limitedJson(response, signal) {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    cancelBody(response);
    throw new ModelDiscoveryError('模型目录响应过大，请手动填写模型名称');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ModelDiscoveryError('模型目录未返回有效 JSON');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES)
        throw new ModelDiscoveryError('模型目录响应过大，请手动填写模型名称');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new ModelDiscoveryError('模型目录未返回有效 JSON');
    }
  } finally {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      /* Already closed. */
    }
    try {
      reader.releaseLock();
    } catch {
      /* An aborted read may still be settling. */
    }
  }
}

const cleanText = (value) =>
  typeof value === 'string' && value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : '';

function modelList(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.data))
    throw new ModelDiscoveryError('模型目录格式不符合约定，请手动填写模型名称');
  const models = new Map();
  let truncated = false;
  for (const row of body.data) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const id = cleanText(row.id);
    if (!id || /\s/.test(id)) continue;
    const name = cleanText(row.name),
      ownedBy = cleanText(row.owned_by);
    const context = row.context_window ?? row.context_length;
    const item = {
      id,
      ...(name ? { name } : {}),
      ...(ownedBy ? { ownedBy } : {}),
      ...(Number.isSafeInteger(context) && context > 0 ? { contextWindow: context } : {}),
    };
    const prior = models.get(id);
    if (prior) models.set(id, { ...item, ...prior });
    else if (models.size < MAX_MODELS) models.set(id, item);
    else truncated = true;
  }
  if (body.data.length && !models.size)
    throw new ModelDiscoveryError('模型目录未包含有效模型标识，请手动填写模型名称');
  return { models: [...models.values()], truncated };
}

// Listing is a read-only capability check. A listed model is not necessarily
// compatible with the structured company-research request used elsewhere.
export async function discoverResearchModels({
  env = {},
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  let config;
  try {
    // A malformed or incomplete web/customs connection must not block choosing
    // a model. Resolve the shared model aliases without reading unrelated env.
    const modelEnv = {};
    for (const key of [
      'RESEARCH_MODEL_PROVIDER',
      'RESEARCH_MODEL_BASE_URL',
      'RESEARCH_MODEL_API_KEY',
      'RESEARCH_MODEL_MODEL',
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_MODEL',
    ])
      modelEnv[key] = env[key];
    config = researchProviderConfig(modelEnv).model;
  } catch {
    throw new ModelDiscoveryError('研究模型连接配置无效，请检查提供方和 HTTPS 基础地址', 503);
  }
  // A model name is intentionally not required: the directory helps choose it.
  if (!config.apiKey || !config.baseUrl)
    throw new ModelDiscoveryError('请先配置研究模型 API 基础地址和密钥，再读取模型目录', 503);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    if (requestSignal.aborted) throw new Error('aborted');
    response = await abortable(
      fetchImpl(config.baseUrl.replace(/\/+$/, '') + '/models', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + config.apiKey, Accept: 'application/json' },
        redirect: 'error',
        signal: requestSignal,
      }),
      requestSignal,
    );
  } catch {
    throw new ModelDiscoveryError('模型目录连接中断或超时，请稍后重试或手动填写模型名称');
  }
  if ([404, 405, 501].includes(response.status)) {
    cancelBody(response);
    return {
      status: 'unsupported',
      provider: config.provider,
      models: [],
      message: '该 API 不支持读取模型目录，请手动填写模型名称',
    };
  }
  if (!response.ok) {
    cancelBody(response);
    if ([401, 403].includes(response.status))
      throw new ModelDiscoveryError('模型目录认证失败，请检查 API 密钥和访问权限', response.status);
    if (response.status === 429)
      throw new ModelDiscoveryError('模型目录请求频率受限，请稍后重试', 429);
    throw new ModelDiscoveryError('模型目录请求失败，请稍后重试或手动填写模型名称');
  }
  let result;
  try {
    result = modelList(await limitedJson(response, requestSignal));
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error;
    throw new ModelDiscoveryError('模型目录读取中断或超时，请稍后重试或手动填写模型名称');
  }
  return {
    status: 'available',
    provider: config.provider,
    models: result.models,
    message: result.truncated
      ? '模型目录已截取前 500 项；列出模型不代表已验证企业研究兼容性'
      : result.models.length
        ? '已读取模型目录；列出模型不代表已验证企业研究兼容性'
        : '该 API 返回空模型目录，请手动填写模型名称',
  };
}
