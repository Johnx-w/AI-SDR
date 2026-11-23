import { researchProviderConfig } from './acquisition-config.mjs';
import { createHash } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });

export function mailDraftModel(env, fetchImpl) {
  let config;
  try {
    config = researchProviderConfig(env).model;
  } catch {
    return null;
  }
  const { apiKey: key, baseUrl, provider, model: name } = config;
  if (!key || !baseUrl || !name) return null;
  // A custom gateway must have its own credential, separate from the official account.
  if (
    provider === 'deepseek' &&
    !env.RESEARCH_MODEL_API_KEY?.trim() &&
    new URL(baseUrl).origin !== 'https://api.deepseek.com'
  )
    return null;
  return {
    name,
    connectionId: createHash('sha256')
      .update(JSON.stringify([provider, baseUrl, name]))
      .digest('hex'),
    async generate(messages) {
      let response;
      try {
        const payload = {
          model: name,
          messages,
          ...(provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
          response_format: { type: 'json_object' },
          max_tokens: 1200,
        };
        const signal = AbortSignal.timeout(60000);
        for (;;) {
          response = await fetchImpl(baseUrl + '/chat/completions', {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (provider !== 'openai_compatible' || response.status !== 400) break;
          const { error } = (await response.json().catch(() => null)) || {};
          if (!['unsupported_parameter', 'unsupported_value'].includes(error?.code)) break;
          if (error.param === 'response_format' && payload.response_format)
            delete payload.response_format;
          else if (error.param === 'max_tokens' && payload.max_tokens) {
            payload.max_completion_tokens = payload.max_tokens;
            delete payload.max_tokens;
          } else break;
        }
      } catch {
        throw fail(502, '连接草稿模型服务失败或超时，请重试');
      }
      if (response.status === 401 || response.status === 403)
        throw fail(503, '草稿模型鉴权失败，请核对当前模型连接的 API Key');
      if (response.status === 402) throw fail(503, '当前模型服务账户余额不足');
      if (response.status === 429) throw fail(429, '当前模型服务请求过于频繁，请稍后重试');
      if (!response.ok) throw fail(502, '模型服务未能生成草稿，请检查模型配置或稍后重试');
      const data = await response.json().catch(() => null);
      const choice = data?.choices?.[0];
      if (
        choice?.finish_reason !== 'stop' ||
        typeof choice.message?.content !== 'string' ||
        !choice.message.content.trim()
      )
        throw fail(502, '模型服务返回的草稿不完整，请重试');
      return choice.message.content;
    },
  };
}
