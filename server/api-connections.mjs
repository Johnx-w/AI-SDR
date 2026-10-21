import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nativeRequirements } from './acquisition-config.mjs';

const fields = [
  ['TAVILY_API_KEY', 'Tavily API Key', true],
  ['DEEPSEEK_API_KEY', 'DeepSeek API Key', true],
  ['DEEPSEEK_MODEL', 'DeepSeek 模型', false],
  ['FEISHU_APP_ID', '飞书 App ID', false],
  ['FEISHU_APP_SECRET', '飞书 App Secret', true],
  ['FEISHU_APP_TOKEN', '多维表格 App Token', true],
  ['FEISHU_TABLE_ID', '多维表格 Table ID', false],
];
const fail = (message) => Object.assign(new Error(message), { status: 400 });

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
  view() {
    const env = this.environment();
    return {
      provider: env.ACQUISITION_PROVIDER || 'n8n',
      fields: fields.map(([key, label, secret]) => ({
        key,
        label,
        secret,
        configured: Boolean(env[key]?.trim()),
        value: secret ? '' : env[key] || (key === 'DEEPSEEK_MODEL' ? 'deepseek-flash' : ''),
      })),
      ready: nativeRequirements.every((key) => env[key]?.trim()),
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
    for (const [key, value] of Object.entries(body.values)) {
      if (
        !known.has(key) ||
        typeof value !== 'string' ||
        value.length > 2000 ||
        /[\r\n\0]/.test(value)
      )
        throw fail('API 配置项格式不正确');
      // Empty inputs preserve the server value; clearing is a separate explicit action.
      if (value.trim()) next[key] = value.trim();
    }
    for (const key of cleared) next[key] = '';
    if (next.DEEPSEEK_MODEL && !/^[\w.-]{1,100}$/.test(next.DEEPSEEK_MODEL))
      throw fail('模型名称只能包含字母、数字、下划线、点或短横线');
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
