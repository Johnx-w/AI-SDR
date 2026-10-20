import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFeishu } from './feishu.mjs';
import { discoverBranding } from './branding.mjs';
import { discoverContacts } from './contacts.mjs';
import { summarizeRunOutput } from './run-outcome.mjs';
import { validateTarget, locationOptions } from './search-target.mjs';
import { generateSearchQuery } from './deepseek.mjs';
import { BatchJobs, validateCount } from './batch-jobs.mjs';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
export function validateInput(input) {
  const target = validateTarget(input);
  if (
    typeof input.search_query !== 'string' ||
    !input.search_query.trim() ||
    input.search_query.length > 500
  )
    throw new ApiError(400, '参数 search_query 不能为空且不能超过 500 字符');
  return { ...target, search_query: input.search_query.trim() };
}
async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new ApiError(415, '请使用 application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new ApiError(413, '请求体不能超过 8 KB');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new ApiError(400, 'JSON 格式不正确');
  }
}
export function createApp({
  env = process.env,
  fetchImpl = fetch,
  dist = resolve('dist'),
  contactsImpl = discoverContacts,
} = {}) {
  const workflowId = env.N8N_WORKFLOW_ID || 'EycE9OmaPkRFUDSq';
  const baseUrl = (env.N8N_BASE_URL || 'https://vynox.app.n8n.cloud').replace(/\/$/, '');
  const editorUrl = `${baseUrl}/workflow/${encodeURIComponent(workflowId)}`;
  const runs = new Map();
  const realLeads = new Map();
  const brandingCache = new Map();
  const contactsCache = new Map();
  let readingLeads;
  const loadLeads = async () => {
    if (!readingLeads)
      readingLeads = readFeishu({ env, fetchImpl })
        .then((data) => {
          realLeads.clear();
          data.leads.forEach((lead) => realLeads.set(lead.id, lead));
          return data;
        })
        .finally(() => {
          readingLeads = undefined;
        });
    return readingLeads;
  };
  let running = 0;
  let generatingQuery = false;
  let batch;
  const batchCall = async (body) => {
    const response = await fetchImpl(env.N8N_WEBHOOK_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(600000),
      headers: { 'Content-Type': 'application/json', 'X-Shadeflow-Key': env.N8N_WEBHOOK_SECRET },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`n8n HTTP ${response.status}`);
    const raw = await response.json();
    const output = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
    if (!output || typeof output !== 'object') throw new Error('n8n 返回格式异常');
    return output;
  };
  const jobs = () =>
    (batch ??= new BatchJobs({
      path: env.BATCH_DB_PATH || ':memory:',
      discover: (input, search, seen) =>
        batchCall({
          ...input,
          batch_mode: 'discover',
          search_query: search.query,
          search_country: search.country,
          exclude_domains: seen.slice(-150),
        }),
      research: async (input, item) => {
        try {
          return await batchCall({ ...input, ...item, batch_mode: 'research' });
        } catch {
          // A gateway timeout does not cancel n8n. Only query the same operation;
          // never repeat its paid research or write request.
          for (let attempt = 0; attempt < 12; attempt++) {
            const result = await batchCall({
              batch_mode: 'status',
              operation_id: item.operation_id,
            }).catch(() => null);
            if (result?.settled) return result.output;
            await new Promise((resolve) => setTimeout(resolve, 10000));
          }
          throw new Error('当前企业执行结果尚未确认');
        }
      },
      status: (operation_id) => batchCall({ batch_mode: 'status', operation_id }),
      readLeads: async () => (await readFeishu({ env, fetchImpl })).leads,
    }));
  let validWebhook = false;
  try {
    const webhook = new URL(env.N8N_WEBHOOK_URL);
    validWebhook =
      webhook.protocol === 'https:' &&
      webhook.origin === new URL(baseUrl).origin &&
      webhook.pathname.startsWith('/webhook/') &&
      !webhook.username &&
      !webhook.password;
  } catch {
    /* 未配置时返回明确状态。 */
  }
  const configured = Boolean(
    validWebhook && env.N8N_WEBHOOK_SECRET && env.N8N_WEBHOOK_ENABLED === 'true',
  );
  const json = (response, status, body) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        const origin = request.headers.origin;
        const allowed = new Set([
          'http://127.0.0.1:5174',
          'http://localhost:5174',
          `http://127.0.0.1:${env.PORT || 4311}`,
          `http://localhost:${env.PORT || 4311}`,
        ]);
        if (origin && !allowed.has(origin)) throw new ApiError(403, '该来源无权调用本地接口');
        if (request.headers['sec-fetch-site'] === 'cross-site')
          throw new ApiError(403, '不允许跨站调用');
        if (url.pathname === '/api/health' && request.method === 'GET')
          return json(response, 200, { ok: true });
        const prefix = '/api/v1/integrations/n8n';
        if (url.pathname === `${prefix}/locations` && request.method === 'GET')
          return json(
            response,
            200,
            locationOptions(
              url.searchParams.get('country') || 'United States',
              url.searchParams.get('region') || '',
            ),
          );
        if (url.pathname === `${prefix}/search-query` && request.method === 'POST') {
          const target = validateTarget(await readJson(request));
          if (generatingQuery) throw new ApiError(429, '正在生成搜索词，请稍候');
          generatingQuery = true;
          try {
            return json(response, 200, await generateSearchQuery(target, { env, fetchImpl }));
          } finally {
            generatingQuery = false;
          }
        }
        if (url.pathname === '/api/v1/leads/real' && request.method === 'GET')
          return json(response, 200, await loadLeads());
        const contactRequest = url.pathname.match(/^\/api\/v1\/leads\/real\/([\w-]+)\/contacts$/);
        if (contactRequest && request.method === 'GET') {
          if (!realLeads.size) await loadLeads();
          const lead = realLeads.get(contactRequest[1]);
          if (!lead) throw new ApiError(404, '客户不存在');
          const key = [lead.id, lead.website, lead.market].join('|');
          let cached = contactsCache.get(key);
          if (url.searchParams.get('refresh') === '1') {
            if (cached?.pending) return json(response, 200, await cached.promise);
            cached = undefined;
          }
          if (!cached || cached.expires < Date.now()) {
            if (contactsCache.size >= 500) contactsCache.clear();
            cached = { pending: true, expires: Date.now() + 600000 };
            const entry = cached;
            cached.promise = contactsImpl(lead)
              .catch((error) => {
                contactsCache.delete(key);
                throw error;
              })
              .finally(() => {
                entry.pending = false;
              });
            contactsCache.set(key, cached);
          }
          return json(response, 200, await cached.promise);
        }
        const branding = url.pathname.match(/^\/api\/v1\/leads\/real\/([\w-]+)\/branding$/);
        if (branding && request.method === 'GET') {
          if (!realLeads.size) await loadLeads();
          const lead = realLeads.get(branding[1]);
          if (!lead) throw new ApiError(404, '客户不存在');
          let cached = brandingCache.get(lead.website);
          if (!cached || cached.expires < Date.now()) {
            if (brandingCache.size >= 500) brandingCache.clear();
            cached = { promise: discoverBranding(lead), expires: Date.now() + 3600000 };
            brandingCache.set(lead.website, cached);
          }
          return json(response, 200, await cached.promise);
        }
        if (url.pathname === `${prefix}/status` && request.method === 'GET')
          return json(response, 200, {
            configured,
            workflowId,
            editorUrl,
            transport: 'webhook',
            note: configured
              ? 'Webhook 调用参数已配置；尚不代表已通过真实运行验证。'
              : '尚未配置生产 Webhook 与 Header Auth；Codex MCP OAuth 不自动授权本应用。',
          });
        if (url.pathname === `${prefix}/jobs` || url.pathname.startsWith(`${prefix}/jobs/`)) {
          if (!configured) throw new ApiError(503, 'n8n Webhook 尚未配置');
          const suffix = url.pathname.slice(`${prefix}/jobs`.length).split('/').filter(Boolean);
          const manager = jobs();
          if (!suffix.length && request.method === 'GET')
            return json(response, 200, { jobs: manager.list().map((j) => manager.view(j)) });
          if (!suffix.length && request.method === 'POST') {
            if (running) throw new ApiError(409, '单次任务正在执行');
            const body = await readJson(request);
            const input = {
              ...validateInput(body),
              target_count: validateCount(body.target_count),
            };
            const job = manager.create(input, request.headers['idempotency-key']);
            return json(response, 202, manager.view(job));
          }
          if (suffix.length === 1 && request.method === 'GET')
            return json(response, 200, manager.view(manager.get(suffix[0])));
          if (suffix.length === 2 && request.method === 'POST') {
            if (suffix[1] === 'stop')
              return json(response, 200, manager.view(manager.stop(suffix[0])));
            if (suffix[1] === 'resume')
              return json(response, 200, manager.view(await manager.resume(suffix[0])));
          }
          throw new ApiError(404, '任务接口不存在');
        }
        if (url.pathname === `${prefix}/runs` && request.method === 'POST') {
          if (!configured)
            throw new ApiError(503, 'n8n Webhook 尚未配置，请先完成自动化中心中的接入步骤。');
          const input = validateInput(await readJson(request));
          const requestId = request.headers['idempotency-key'] || randomUUID();
          if (typeof requestId !== 'string' || !/^[\w-]{8,100}$/.test(requestId))
            throw new ApiError(400, '无效的 Idempotency-Key');
          const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
          const existing = runs.get(requestId);
          if (existing) {
            if (existing.hash !== hash) throw new ApiError(409, '同一请求编号不能使用不同参数');
            if (existing.result) return json(response, 200, existing.result);
            throw new ApiError(
              409,
              existing.status === 'unknown'
                ? '该任务结果待确认，请先在 n8n 查看执行记录，避免重复入库。'
                : '该任务正在执行，请勿重复提交。',
            );
          }
          if (running >= 1 || jobs().active())
            throw new ApiError(429, '已有一个 n8n 任务正在执行，请稍后再提交。');
          // 不自动重试：此工作流会调用付费搜索并写入飞书。
          // 为防止不确定结果被自动重复执行，本地幂等记录保留到服务重启。
          if (runs.size >= 500)
            throw new ApiError(503, '本地运行记录已满，请核对所有任务后重启服务。');
          runs.set(requestId, { hash, status: 'running' });
          running++;
          try {
            const upstream = await fetchImpl(env.N8N_WEBHOOK_URL, {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(110000),
              headers: {
                'Content-Type': 'application/json',
                'X-Shadeflow-Key': env.N8N_WEBHOOK_SECRET,
                'X-Request-ID': requestId,
              },
              body: JSON.stringify({ ...input, request_id: requestId }),
            });
            const text = await upstream.text();
            if (!upstream.ok)
              throw new ApiError(
                502,
                `n8n 返回 HTTP ${upstream.status}；请核对执行记录后再决定是否重试。`,
              );
            let output;
            try {
              output = JSON.parse(text);
            } catch {
              throw new ApiError(502, 'n8n 未返回 JSON。请检查 Webhook 的响应设置。');
            }
            if (
              output?.message === 'Workflow was started' ||
              output?.message === 'Workflow got started'
            )
              throw new ApiError(502, 'Webhook 仅返回了启动确认，请改为等待最后节点完成再响应。');
            let summary;
            try {
              summary = summarizeRunOutput(output);
            } catch (error) {
              throw new ApiError(502, error.message);
            }
            const result = {
              requestId,
              status: 'completed',
              summary,
              result: output,
              completedAt: new Date().toISOString(),
            };
            runs.set(requestId, { hash, status: 'completed', result });
            return json(response, 200, result);
          } catch (error) {
            runs.set(requestId, { hash, status: 'unknown' });
            if (error instanceof ApiError) throw error;
            throw new ApiError(
              504,
              '未能确认 n8n 执行结果。任务可能仍在运行，请先查看 n8n 执行记录，勿直接重复提交。',
            );
          } finally {
            running--;
          }
        }
        if (url.pathname === `${prefix}/executions` && request.method === 'GET') {
          if (!env.N8N_API_KEY)
            throw new ApiError(
              503,
              '读取历史记录需要配置服务端 N8N_API_KEY；运行工作流只需 Webhook 凭证。',
            );
          const upstream = await fetchImpl(
            `${baseUrl}/api/v1/executions?workflowId=${encodeURIComponent(workflowId)}&limit=10&includeData=false`,
            {
              redirect: 'error',
              headers: { 'X-N8N-API-KEY': env.N8N_API_KEY },
              signal: AbortSignal.timeout(15000),
            },
          );
          if (!upstream.ok)
            throw new ApiError(502, `读取 n8n 历史记录失败 (HTTP ${upstream.status})`);
          const payload = await upstream.json();
          return json(response, 200, {
            data: (payload.data || []).map((item) => ({
              id: item.id,
              status: item.status,
              startedAt: item.startedAt,
              stoppedAt: item.stoppedAt,
            })),
          });
        }
        throw new ApiError(404, '接口不存在');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD')
        throw new ApiError(405, '不支持的请求方法');
      const pathname = decodeURIComponent(url.pathname);
      let target = resolve(dist, `.${pathname}`);
      if (target !== dist && !target.startsWith(dist + sep)) throw new ApiError(403, '无效路径');
      try {
        if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
      } catch {
        target = resolve(dist, 'index.html');
      }
      let content;
      try {
        content = await readFile(target);
      } catch {
        throw new ApiError(404, '请先运行 npm run build，或使用 npm run dev');
      }
      response.writeHead(200, {
        'Content-Type': types[extname(target)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      json(response, error.status || 500, {
        error: error.status ? error.message : '服务处理失败，请查看本地日志',
      });
    }
  });
  server.on('close', () => {
    if (batch && !batch.busy) batch.close();
  });
  return server;
}
