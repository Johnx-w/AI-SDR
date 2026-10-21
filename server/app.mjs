import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { discoverBranding } from './branding.mjs';
import { summarizeRunOutput } from './run-outcome.mjs';
import { validateTarget, locationOptions } from './search-target.mjs';
import { BatchJobs, validateCount } from './batch-jobs.mjs';
import { createAcquisitionProvider } from './acquisition-provider.mjs';
import { ApiConnections } from './api-connections.mjs';
import { AcquisitionSchedules } from './acquisition-schedules.mjs';

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
  nativeImpl,
} = {}) {
  const connections = new ApiConnections({ env, path: env.CONNECTIONS_PATH });
  let provider = createAcquisitionProvider({
    env: connections.environment(),
    fetchImpl,
    nativeImpl,
  });
  const readLeads = () => provider.readLeads();
  const runs = new Map();
  const realLeads = new Map();
  const brandingCache = new Map();
  let readingLeads;
  const loadLeads = async () => {
    if (!readingLeads)
      readingLeads = readLeads()
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
  let batch;
  const jobs = () =>
    (batch ??= new BatchJobs({
      path: env.BATCH_DB_PATH || ':memory:',
      provider: provider.info.provider,
      discover: (...args) => provider.discover(...args),
      research: (...args) => provider.research(...args),
      status: (id) => provider.status(id),
      readLeads: async () => (await readLeads()).leads,
    }));
  let schedules;
  const plans = () =>
    (schedules ??= new AcquisitionSchedules({
      path: env.SCHEDULE_DB_PATH || ':memory:',
      jobs,
      ready: () => provider.info.configured,
      available: () => running === 0 && ![...runs.values()].some((run) => run.status === 'unknown'),
    }));
  const completeRun = (requestId, hash, output) => {
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
    return result;
  };
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
        if (url.pathname === '/api/v1/connections') {
          if (request.method === 'GET') return json(response, 200, connections.view());
          if (request.method === 'PUT') {
            const body = await readJson(request);
            if (
              running ||
              readingLeads ||
              jobs().active() ||
              [...runs.values()].some((r) => r.status === 'unknown')
            )
              throw new ApiError(409, '请先完成或核对当前任务，再修改 API 连接');
            const result = connections.update(body);
            provider.close();
            batch?.close();
            batch = undefined;
            provider = createAcquisitionProvider({
              env: connections.environment(),
              fetchImpl,
              nativeImpl,
            });
            realLeads.clear();
            brandingCache.clear();
            return json(response, 200, result);
          }
          throw new ApiError(405, '不支持的配置操作');
        }
        const prefix = url.pathname.startsWith('/api/v1/acquisition')
          ? '/api/v1/acquisition'
          : '/api/v1/integrations/n8n';
        if (
          url.pathname === `${prefix}/schedules` ||
          url.pathname.startsWith(`${prefix}/schedules/`)
        ) {
          const suffix = url.pathname
            .slice(`${prefix}/schedules`.length)
            .split('/')
            .filter(Boolean);
          const manager = plans();
          if (!suffix.length && request.method === 'GET')
            return json(response, 200, {
              schedules: manager.list().map((plan) => manager.view(plan)),
            });
          if (!suffix.length && request.method === 'POST') {
            const body = await readJson(request);
            if (!body || typeof body !== 'object' || Array.isArray(body))
              throw new ApiError(400, '请提交有效的定时计划');
            if (!provider.info.configured) throw new ApiError(503, '请先填写 API 连接配置');
            const plan = manager.create(
              {
                name: body.name,
                timing: body.timing,
                input: {
                  ...validateInput(body.input),
                  target_count: validateCount(body.input?.target_count),
                },
              },
              request.headers['idempotency-key'],
            );
            return json(response, 201, manager.view(plan));
          }
          if (suffix.length === 2 && request.method === 'POST')
            return json(response, 200, manager.view(manager.control(suffix[0], suffix[1])));
          throw new ApiError(404, '定时计划接口不存在');
        }
        if (url.pathname === `${prefix}/locations` && request.method === 'GET')
          return json(
            response,
            200,
            locationOptions(
              url.searchParams.get('country') || 'United States',
              url.searchParams.get('region') || '',
            ),
          );
        if (url.pathname === '/api/v1/leads/real' && request.method === 'GET')
          return json(response, 200, await loadLeads());
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
          return json(response, 200, provider.info);
        if (url.pathname === `${prefix}/jobs` || url.pathname.startsWith(`${prefix}/jobs/`)) {
          const suffix = url.pathname.slice(`${prefix}/jobs`.length).split('/').filter(Boolean);
          const manager = jobs();
          if (!suffix.length && request.method === 'GET')
            return json(response, 200, { jobs: manager.list().map((j) => manager.view(j)) });
          if (!suffix.length && request.method === 'POST') {
            if (!provider.info.configured)
              throw new ApiError(503, '获客执行引擎尚未配置，请检查接入状态');
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
            if (suffix[1] === 'resume') {
              if (!provider.info.configured) throw new ApiError(503, '获客执行引擎尚未配置');
              return json(response, 200, manager.view(await manager.resume(suffix[0])));
            }
          }
          throw new ApiError(404, '任务接口不存在');
        }
        if (url.pathname === `${prefix}/runs` && request.method === 'POST') {
          if (!provider.info.configured)
            throw new ApiError(503, '获客执行引擎尚未配置，请先完成接入配置。');
          const input = validateInput(await readJson(request));
          const requestId = request.headers['idempotency-key'] || randomUUID();
          if (typeof requestId !== 'string' || !/^[\w-]{8,100}$/.test(requestId))
            throw new ApiError(400, '无效的 Idempotency-Key');
          const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
          const existing = runs.get(requestId);
          if (existing) {
            if (existing.hash !== hash) throw new ApiError(409, '同一请求编号不能使用不同参数');
            if (existing.result) return json(response, 200, existing.result);
            if (existing.status === 'unknown') {
              const settled = await provider.recoverRun(requestId);
              if (settled.settled)
                return json(response, 200, completeRun(requestId, hash, settled.output));
            }
            throw new ApiError(
              409,
              existing.status === 'unknown'
                ? '该任务结果待确认，请先查看执行记录，避免重复入库。'
                : '该任务正在执行，请勿重复提交。',
            );
          }
          if (running >= 1 || jobs().active())
            throw new ApiError(429, '已有获客任务正在执行或待核对，请先处理该任务。');
          // 不自动重试：此工作流会调用付费搜索并写入飞书。
          // 为防止不确定结果被自动重复执行，本地幂等记录保留到服务重启。
          if (runs.size >= 500)
            throw new ApiError(503, '本地运行记录已满，请核对所有任务后重启服务。');
          runs.set(requestId, { hash, status: 'running' });
          running++;
          try {
            const output = await provider.run(input, requestId);
            return json(response, 200, completeRun(requestId, hash, output));
          } catch (error) {
            runs.set(requestId, { hash, status: 'unknown' });
            if (error.status) throw error;
            throw new ApiError(
              504,
              '未能确认执行结果。任务可能仍在运行，请先查看任务记录，勿直接重复提交。',
            );
          } finally {
            running--;
          }
        }
        if (url.pathname === `${prefix}/executions` && request.method === 'GET') {
          return json(response, 200, { data: await provider.history() });
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
  server.on('listening', () => plans().start());
  server.on('close', () => {
    schedules?.close();
    if (batch && !batch.busy) batch.close();
    if (!batch?.busy && !running) provider.close();
  });
  return server;
}
