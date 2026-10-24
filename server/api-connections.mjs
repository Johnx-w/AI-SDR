import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  acquisitionConfig,
  providerBaseUrl,
  researchProviderConfig,
} from './acquisition-config.mjs';

const fields = [
  ['WEB_SEARCH_PROVIDER', '网页检索提供方', false, ['tavily', 'http']],
  ['WEB_SEARCH_BASE_URL', '网页检索 API 基础地址', false],
  ['WEB_SEARCH_API_KEY', '网页检索 API Key', true],
  ['TAVILY_API_KEY', 'Tavily API Key', true],
  ['RESEARCH_MODEL_PROVIDER', '研究模型提供方', false, ['deepseek', 'openai_compatible']],
  ['RESEARCH_MODEL_BASE_URL', '研究模型 API 基础地址', false],
  ['RESEARCH_MODEL_API_KEY', '研究模型 API Key', true],
  ['RESEARCH_MODEL_MODEL', '研究模型名称', false],
  ['RESEARCH_MODEL_MAX_OUTPUT_TOKENS', '单次模型输出上限', false],
  [
    'RESEARCH_MODEL_REASONING_EFFORT',
    '研究推理强度（DeepSeek）',
    false,
    ['none', 'low', 'high', 'max'],
  ],
  ['DEEPSEEK_API_KEY', 'DeepSeek API Key', true],
  ['DEEPSEEK_MODEL', 'DeepSeek 模型', false],
  ['CUSTOMS_PROVIDER', '海关数据提供方', false, ['billofladingdata', 'http']],
  ['CUSTOMS_BASE_URL', '海关 API 基础地址', false],
  ['CUSTOMS_API_KEY', '海关 API Key', true],
  ['FEISHU_APP_ID', '飞书 App ID', false],
  ['FEISHU_APP_SECRET', '飞书 App Secret', true],
  ['FEISHU_APP_TOKEN', '多维表格 App Token', true],
  ['FEISHU_TABLE_ID', '多维表格 Table ID', false],
];
const fail = (message) => Object.assign(new Error(message), { status: 400 });

// Return an identifying preview, never the complete secret or its true length.
export function maskConnectionSecret(value) {
  const chars = [...String(value || '').trim()];
  if (!chars.length) return '';
  if (chars.length <= 8) return '********';
  const visible = chars.length >= 16 ? 4 : 2;
  return chars.slice(0, visible).join('') + '********' + chars.slice(-visible).join('');
}

export function connectionEnvironment(env = process.env) {
  return new ApiConnections({
    env,
    path: env.CONNECTIONS_PATH || '.data/api-connections.json',
  }).environment();
}

export class ApiConnections {
  constructor({ env, path }) {
    this.base = { ...env };
    this.path = path;
    this.saved = {};
    if (path) {
      try {
        const stored = JSON.parse(readFileSync(path, 'utf8'));
        for (const key of [...fields.map(([key]) => key), 'ACQUISITION_PROVIDER'])
          if (typeof stored[key] === 'string') this.saved[key] = stored[key];
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('API 连接配置无法读取，请检查本机配置文件');
      }
    }
  }
  environment() {
    return { ...this.base, ...this.saved };
  }
  // Preview only the model connection. Draft credentials never reach disk or the
  // acquisition provider, and unrelated connection fields are not accepted.
  previewModelEnvironment(body) {
    const allowed = new Set(
      fields.map(([key]) => key).filter((key) => /^(RESEARCH_MODEL_|DEEPSEEK_)/.test(key)),
    );
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !body.values ||
      typeof body.values !== 'object' ||
      Array.isArray(body.values)
    )
      throw fail('请提交有效的模型连接设置');
    const cleared = body.clear ?? [];
    if (!Array.isArray(cleared) || cleared.some((key) => !allowed.has(key)))
      throw fail('模型列表只接受模型连接配置');
    const next = this.environment();
    for (const [key, value] of Object.entries(body.values)) {
      if (
        !allowed.has(key) ||
        typeof value !== 'string' ||
        value.length > 2000 ||
        /[\r\n\0]/.test(value)
      )
        throw fail('模型连接配置项格式不正确');
      if (key.endsWith('_API_KEY') && value.includes('*'))
        throw fail('脱敏摘要不能用于读取模型，请输入完整的新密钥或使用已保存密钥');
      if (value.trim()) next[key] = value.trim();
    }
    for (const key of cleared) next[key] = '';
    try {
      // Ignore the unrelated web connection when validating a model preview.
      researchProviderConfig({
        RESEARCH_MODEL_PROVIDER: next.RESEARCH_MODEL_PROVIDER,
        RESEARCH_MODEL_BASE_URL: next.RESEARCH_MODEL_BASE_URL,
        RESEARCH_MODEL_API_KEY: next.RESEARCH_MODEL_API_KEY,
        RESEARCH_MODEL_MODEL: next.RESEARCH_MODEL_MODEL,
        DEEPSEEK_API_KEY: next.DEEPSEEK_API_KEY,
        DEEPSEEK_MODEL: next.DEEPSEEK_MODEL,
      });
    } catch (error) {
      throw fail(error.message);
    }
    return next;
  }
  view() {
    const env = this.environment();
    const config = acquisitionConfig(env);
    const research = researchProviderConfig(env);
    const effective = {
      WEB_SEARCH_BASE_URL: research.web.baseUrl,
      RESEARCH_MODEL_BASE_URL: research.model.baseUrl,
      RESEARCH_MODEL_MODEL: research.model.model,
      RESEARCH_MODEL_MAX_OUTPUT_TOKENS: String(research.model.maxOutputTokens),
      RESEARCH_MODEL_REASONING_EFFORT: research.model.reasoningEffort,
      CUSTOMS_BASE_URL:
        env.CUSTOMS_BASE_URL ||
        (!env.CUSTOMS_PROVIDER || env.CUSTOMS_PROVIDER === 'billofladingdata'
          ? 'https://tradedata.billofladingdata.com'
          : env.CUSTOMS_API_URL || ''),
    };
    const defaults = {
      WEB_SEARCH_PROVIDER: 'tavily',
      RESEARCH_MODEL_PROVIDER: 'deepseek',
      DEEPSEEK_MODEL: 'deepseek-flash',
      CUSTOMS_PROVIDER: 'billofladingdata',
    };
    return {
      provider: env.ACQUISITION_PROVIDER || 'n8n',
      webSearchProvider: config.webSearchProvider,
      researchModelProvider: config.researchModelProvider,
      fields: fields.map(([key, label, secret, options]) => ({
        key,
        label,
        secret,
        configured: Boolean(env[key]?.trim()),
        value: secret ? '' : env[key] || defaults[key] || '',
        ...(secret
          ? { maskedValue: maskConnectionSecret(env[key]) }
          : Object.hasOwn(effective, key)
            ? { effectiveValue: effective[key] }
            : {}),
        required: config.requirements.includes(key),
        ...(options ? { options } : {}),
      })),
      ready: config.nativeReady,
      missing: config.missing,
    };
  }
  update(body) {
    if (
      !body ||
      typeof body !== 'object' ||
      !body.values ||
      Array.isArray(body.values) ||
      typeof body.values !== 'object'
    )
      throw fail('请提交有效的 API 连接设置');
    const known = new Set(fields.map(([key]) => key));
    const cleared = body.clear ?? [];
    if (!Array.isArray(cleared) || cleared.some((key) => !known.has(key)))
      throw fail('包含不支持的配置项');
    const next = { ...this.saved, ACQUISITION_PROVIDER: 'native' };
    const current = this.environment();
    for (const [key, value] of Object.entries(body.values)) {
      if (
        !known.has(key) ||
        typeof value !== 'string' ||
        value.length > 2000 ||
        /[\r\n\0]/.test(value)
      )
        throw fail('API 配置项格式不正确');
      // A saved preview is display-only. Never replace credentials with stars.
      if (fields.some(([name, , secret]) => name === key && secret) && value.trim()) {
        if (current[key] && value.trim() === maskConnectionSecret(current[key])) continue;
        if (/^(?:.{2}|.{4})?\*{8}(?:.{2}|.{4})?$/.test(value.trim()))
          throw fail('脱敏摘要不能作为密钥保存，请输入完整的新密钥');
      }
      // Empty inputs preserve the server value; clearing is a separate explicit action.
      if (value.trim()) next[key] = value.trim();
    }
    for (const key of cleared) next[key] = '';
    if (next.DEEPSEEK_MODEL && !/^[\w.-]{1,100}$/.test(next.DEEPSEEK_MODEL))
      throw fail('模型名称只能包含字母、数字、下划线、点或短横线');
    const merged = { ...this.base, ...next };
    if (
      merged.RESEARCH_MODEL_MODEL &&
      !/^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(merged.RESEARCH_MODEL_MODEL)
    )
      throw fail('研究模型名称格式不正确');
    if (merged.CUSTOMS_PROVIDER && !['billofladingdata', 'http'].includes(merged.CUSTOMS_PROVIDER))
      throw fail('CUSTOMS_PROVIDER 只能是 billofladingdata 或 http');
    try {
      acquisitionConfig(merged);
      if (merged.CUSTOMS_BASE_URL) providerBaseUrl(merged.CUSTOMS_BASE_URL, 'CUSTOMS_BASE_URL');
    } catch (error) {
      throw fail(error.message);
    }
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = this.path + '.tmp';
      writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(temporary, this.path);
    }
    this.saved = next;
    return this.view();
  }
}
