import { acquisitionConfig } from './acquisition-config.mjs';
import { readFeishu } from './feishu.mjs';
import { FeishuClient } from './feishu-direct.mjs';
import { NativeAcquisition } from './native-acquisition.mjs';
import { customsConfig } from './customs-discovery.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

// HTTP routes and the batch scheduler use the same provider contract. Keep
// transport details and recovery specific to an engine inside its adapter.
export function createAcquisitionProvider({ env, fetchImpl = fetch, nativeImpl } = {}) {
  const config = acquisitionConfig(env);
  if (config.provider === 'native') {
    const feishu = new FeishuClient({ env, fetchImpl });
    let native;
    const service = () =>
      (native ??= nativeImpl || new NativeAcquisition({ env, fetchImpl, feishu }));
    return {
      info: {
        ...config,
        configured: config.nativeReady,
        workflowId: '',
        editorUrl: '',
        transport: 'direct',
        customs: customsConfig(env),
        webProvider: config.webSearchProvider,
        modelProvider: config.researchModelProvider,
        note: config.nativeReady
          ? '后端直连网页检索、研究模型与飞书；海关发现独立配置，真实任务结果见任务记录。'
          : '后端直连配置缺失：' + config.missing.join('、'),
      },
      readLeads: async () => {
        const data = await feishu.readLeads();
        return service().decorateLeads ? service().decorateLeads(data) : data;
      },
      assessmentInfo: () => service().assessmentInfo(),
      assessRecord: (...args) => service().assessRecord(...args),
      updateContacts: async (...args) => {
        const result = await service().updateContacts(...args);
        return {
          ...result,
          lead: service().decorateLeads
            ? service().decorateLeads({ leads: [result.lead] }).leads[0]
            : result.lead,
        };
      },
      supplementRecord: (...args) => service().supplementRecord(...args),
      pendingSupplement: (...args) => service().pendingSupplement(...args),
      assessmentHistory: (...args) => service().assessmentHistory(...args),
      discover: (...args) => service().discover(...args),
      research: (...args) => service().research(...args),
      status: (id) => service().status(id),
      recoverRun: (id) => service().status(id),
      run: (...args) => service().run(...args),
      history: () => service().store.history(),
      close: () => native?.close(),
    };
  }
  return new N8nAcquisition({ env, fetchImpl, nativeReady: config.nativeReady });
}

class N8nAcquisition {
  constructor({ env, fetchImpl, nativeReady }) {
    this.env = env;
    this.fetch = fetchImpl;
    this.baseUrl = (env.N8N_BASE_URL || 'https://vynox.app.n8n.cloud').replace(/\/$/, '');
    const workflowId = env.N8N_WORKFLOW_ID || 'EycE9OmaPkRFUDSq';
    let validWebhook = false;
    try {
      const webhook = new URL(env.N8N_WEBHOOK_URL);
      validWebhook =
        webhook.protocol === 'https:' &&
        webhook.origin === new URL(this.baseUrl).origin &&
        webhook.pathname.startsWith('/webhook/') &&
        !webhook.username &&
        !webhook.password;
    } catch {
      /* Missing configuration is reported through info. */
    }
    const configured = Boolean(
      validWebhook && env.N8N_WEBHOOK_SECRET && env.N8N_WEBHOOK_ENABLED === 'true',
    );
    this.info = {
      configured,
      workflowId,
      editorUrl: `${this.baseUrl}/workflow/${encodeURIComponent(workflowId)}`,
      provider: 'n8n',
      transport: 'webhook',
      nativeReady,
      note: configured
        ? 'Webhook 调用参数已配置；尚不代表已通过真实运行验证。'
        : '尚未配置生产 Webhook 与 Header Auth；Codex MCP OAuth 不自动授权本应用。',
    };
  }
  readLeads() {
    return readFeishu({ env: this.env, fetchImpl: this.fetch });
  }
  async call(body, { timeout = 600000, requestId } = {}) {
    const response = await this.fetch(this.env.N8N_WEBHOOK_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      headers: {
        'Content-Type': 'application/json',
        'X-Shadeflow-Key': this.env.N8N_WEBHOOK_SECRET,
        ...(requestId ? { 'X-Request-ID': requestId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw fail(502, `n8n 返回 HTTP ${response.status}；请核对执行记录后再决定是否重试。`);
    let output;
    try {
      output = await response.json();
    } catch {
      throw fail(502, 'n8n 未返回 JSON。请检查 Webhook 的响应设置。');
    }
    const payload = Array.isArray(output) && output.length === 1 ? output[0] : output;
    if (['Workflow was started', 'Workflow got started'].includes(payload?.message))
      throw fail(502, 'Webhook 仅返回了启动确认，请改为等待最后节点完成再响应。');
    return output;
  }
  async batchCall(body) {
    const raw = await this.call(body);
    const output = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
    if (!output || typeof output !== 'object') throw fail(502, 'n8n 返回格式异常');
    return output;
  }
  discover(input, search, seen) {
    return this.batchCall({
      ...input,
      batch_mode: 'discover',
      search_query: search.query,
      search_country: search.country,
      exclude_domains: seen.slice(-150),
    });
  }
  async research(input, item) {
    try {
      return await this.batchCall({ ...input, ...item, batch_mode: 'research' });
    } catch {
      for (let attempt = 0; attempt < 12; attempt++) {
        const result = await this.status(item.operation_id).catch(() => null);
        if (result?.settled) return result.output;
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
      throw new Error('当前企业执行结果尚未确认');
    }
  }
  status(operation_id) {
    return this.batchCall({ batch_mode: 'status', operation_id });
  }
  run(input, requestId) {
    return this.call({ ...input, request_id: requestId }, { timeout: 110000, requestId });
  }
  recoverRun() {
    // Legacy single runs have no operation-status contract. Do not replay them.
    return { settled: false };
  }
  async history() {
    if (!this.env.N8N_API_KEY)
      throw fail(503, '读取历史记录需要配置服务端 N8N_API_KEY；运行工作流只需 Webhook 凭证。');
    const response = await this.fetch(
      `${this.baseUrl}/api/v1/executions?workflowId=${encodeURIComponent(this.info.workflowId)}&limit=10&includeData=false`,
      {
        redirect: 'error',
        headers: { 'X-N8N-API-KEY': this.env.N8N_API_KEY },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw fail(502, `读取 n8n 历史记录失败 (HTTP ${response.status})`);
    const payload = await response.json();
    return (payload.data || []).map((item) => ({
      id: item.id,
      status: item.status,
      startedAt: item.startedAt,
      stoppedAt: item.stoppedAt,
    }));
  }
  close() {}
}
