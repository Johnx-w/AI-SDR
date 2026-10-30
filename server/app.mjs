import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { decorateLeadDevelopment } from './lead-development.mjs';
import { BrandingCache } from './branding-cache.mjs';
import { summarizeRunOutput } from './run-outcome.mjs';
import { validateTarget, locationOptions } from './search-target.mjs';
import { BatchJobs, validateCount, validateResearchBudget } from './batch-jobs.mjs';
import { AcquisitionReviews } from './acquisition-reviews.mjs';
import { createAcquisitionProvider } from './acquisition-provider.mjs';
import { ApiConnections } from './api-connections.mjs';
import { discoverResearchModels } from './model-discovery.mjs';
import { AcquisitionSchedules } from './acquisition-schedules.mjs';
import { ProductCatalog } from './product-catalog.mjs';
import { ProductKnowledge } from './product-knowledge.mjs';
import { ProductKnowledgeFeishu } from './product-knowledge-feishu.mjs';
import { CustomerBusinessApi } from './customer-business-api.mjs';
import { searchPlan } from './search-plan.mjs';
import { OutreachMailboxes } from './outreach-mailboxes.mjs';
import { OutreachService } from './outreach-service.mjs';
import { handleOutreach } from './outreach-api.mjs';
import { recordOutreachInBusiness } from './outreach-business.mjs';
import { recordMailConversation } from './mail-conversation-business.mjs';
import { validateContactEdit } from './lead-contacts.mjs';
import { LeadLibrary } from './lead-library.mjs';
import { LeadPerformance } from './lead-performance.mjs';
import { OverviewService } from './overview.mjs';
import { websiteScope } from './website-metadata.mjs';

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
const maxJsonBytes = 32768;
export function validateInput(input) {
  const target = validateTarget(input);
  if (input.research_budget !== undefined)
    target.research_budget = validateResearchBudget(input.research_budget);
  if (target.query_mode === 'auto') return { ...target, search_query: searchPlan(target)[0].query };
  if (
    typeof input.search_query !== 'string' ||
    !input.search_query.trim() ||
    input.search_query.length > 500
  )
    throw new ApiError(400, '参数 search_query 不能为空且不能超过 500 字符');
  return { ...target, search_query: input.search_query.trim() };
}
async function readJson(request, maximum = maxJsonBytes) {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new ApiError(415, '请使用 application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum)
      throw new ApiError(
        413,
        maximum === maxJsonBytes ? '请求体不能超过 32 KB' : '邮件及附件内容过大',
      );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new ApiError(400, 'JSON 格式不正确');
  }
}

function requireIdempotencyKey(request) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key))
    throw new ApiError(400, '邮件发送需要有效的 Idempotency-Key');
  return key;
}
export function createApp({
  env = process.env,
  fetchImpl = fetch,
  dist = resolve('dist'),
  nativeImpl,
  outreachServiceFactory,
  brandingOptions,
} = {}) {
  const connections = new ApiConnections({ env, path: env.CONNECTIONS_PATH });
  let provider = createAcquisitionProvider({
    env: connections.environment(),
    fetchImpl,
    nativeImpl,
  });
  const runs = new Map();
  const brandingCache = new BrandingCache({ path: env.BRANDING_CACHE_PATH, ...brandingOptions });
  let readingLeads;
  const readLeads = () => {
    if (!readingLeads)
      readingLeads = provider.readLeads().finally(() => {
        readingLeads = undefined;
      });
    return readingLeads;
  };
  let leadLibrary;
  let leadPerformance = new LeadPerformance();
  const library = () => {
    if (!leadLibrary) {
      const current = connections.environment();
      leadLibrary = new LeadLibrary({
        path: env.LEAD_LIBRARY_DB_PATH || env.BATCH_DB_PATH || ':memory:',
        scope: createHash('sha256')
          .update(
            JSON.stringify([
              current.ACQUISITION_PROVIDER || 'n8n',
              current.FEISHU_APP_ID || '',
              current.FEISHU_APP_TOKEN || '',
              current.FEISHU_TABLE_ID || '',
              current.FEISHU_READ_WEBHOOK_URL || '',
            ]),
          )
          .digest('hex'),
        readLeads,
        ...(env.LEAD_LIBRARY_TTL_MS !== undefined
          ? { ttlMs: Number(env.LEAD_LIBRARY_TTL_MS) }
          : {}),
      });
      leadLibrary.start();
    }
    return leadLibrary;
  };
  const loadLeads = () => library().all();
  // Task deduplication and write verification must always use a fresh upstream read.
  const verifiedLeads = async () => {
    await library().refresh({ afterCurrent: true });
    return (await loadLeads()).leads;
  };
  let running = 0;
  const acquisitionScope = () =>
    createHash('sha256')
      .update(
        JSON.stringify([
          connections.environment().FEISHU_APP_TOKEN || '',
          connections.environment().FEISHU_TABLE_ID || '',
        ]),
      )
      .digest('hex');
  let batch;
  const jobs = () =>
    (batch ??= new BatchJobs({
      path: env.BATCH_DB_PATH || ':memory:',
      provider: provider.info.provider,
      scope: acquisitionScope(),
      discover: (...args) => provider.discover(...args),
      research: (...args) => provider.research(...args),
      status: (id) => provider.status(id),
      readLeads: verifiedLeads,
    }));
  let acquisitionReviews;
  const reviews = () =>
    (acquisitionReviews ??= new AcquisitionReviews(jobs().db, acquisitionScope()));
  const reviewJob = (job) => {
    const snapshot = jobs().view(job);
    const resolutions = reviews().forJob(job.id);
    return {
      ...snapshot,
      rows: snapshot.rows.map((row, index) => ({
        ...row,
        ...(resolutions.has(index) ? { review_resolution: resolutions.get(index) } : {}),
      })),
    };
  };
  const reviewPlan = (plan) => {
    const snapshot = plans().view(plan);
    return snapshot.lastJob ? { ...snapshot, lastJob: reviewJob(snapshot.lastJob) } : snapshot;
  };
  let schedules;
  let products;
  const catalog = () =>
    (products ??= new ProductCatalog(env.PRODUCT_DB_PATH || env.BATCH_DB_PATH || ':memory:'));
  let productKnowledge;
  const knowledge = () =>
    (productKnowledge ??= new ProductKnowledge(
      env.PRODUCT_KNOWLEDGE_DB_PATH || env.PRODUCT_DB_PATH || env.BATCH_DB_PATH || ':memory:',
    ));
  const productMirror = () =>
    new ProductKnowledgeFeishu({ env: connections.environment(), fetchImpl });
  const business = new CustomerBusinessApi({
    getEnv: () => connections.environment(),
    fetchImpl,
    knowledge,
    loadCustomers: async () => (await loadLeads()).leads,
  });
  let outbound;
  const outreach = () =>
    (outbound ??= outreachServiceFactory
      ? outreachServiceFactory({ env })
      : new OutreachService({
          path: env.OUTREACH_DB_PATH || ':memory:',
          mailboxes: new OutreachMailboxes({ env }),
          loadLeads: async () =>
            decorateLeadDevelopment(await loadLeads(), business.state().store.view()).leads,
          products: () => knowledge().list(),
          getEnv: () => connections.environment(),
          getScope: acquisitionScope,
          businessState: () => business.state().store.view(),
          customers: () => library().snapshot(true).leads,
          recordAccepted: (delivery) =>
            recordOutreachInBusiness({ store: business.state().store, delivery }),
          recordCommunication: (detail) =>
            recordMailConversation({ store: business.state().store, ...detail }),
        }));
  const checkCapabilities = (input) => {
    if (['customs', 'dual'].includes(input.acquisition_channel)) {
      if (provider.info.provider !== 'native')
        throw new ApiError(400, '海关逐票发现需要后端直连引擎');
      if (!provider.info.customs?.configured) throw new ApiError(503, '请先配置海关数据连接');
    }
    if (
      provider.info.provider !== 'native' &&
      (input.product_scope === 'all' ||
        (input.environment_preference && input.environment_preference !== 'all') ||
        input.customer_types?.length ||
        input.required_requirements?.length ||
        input.preferred_requirements ||
        input.products?.length)
    )
      throw new ApiError(
        400,
        '全部窗饰范围、室内外偏好、多类型及产品目录获客需要在API连接中选择后端直连引擎',
      );
    return input;
  };
  const plans = () =>
    (schedules ??= new AcquisitionSchedules({
      path: env.SCHEDULE_DB_PATH || ':memory:',
      jobs,
      ready: () => provider.info.configured,
      available: () => running === 0 && ![...runs.values()].some((run) => run.status === 'unknown'),
      checkInput: (input) => checkCapabilities(input),
      scope: acquisitionScope,
    }));
  const overview = new OverviewService({
    customers: async () =>
      decorateLeadDevelopment(await library().list(), business.state().store.view()),
    customerSnapshot: () =>
      decorateLeadDevelopment(library().snapshot(), business.state().store.view()),
    business: () => business.state().store.view(),
    acquisition: () => ({ ...jobs().overview(), schedules: plans().list() }),
    products: () => knowledge().list(),
    scope: () =>
      createHash('sha256')
        .update(
          JSON.stringify([
            acquisitionScope(),
            connections.environment().ACQUISITION_PROVIDER || 'n8n',
            connections.environment().FEISHU_READ_WEBHOOK_URL || '',
          ]),
        )
        .digest('hex'),
  });
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
    leadLibrary?.invalidate();
    return result;
  };
  const json = (response, status, body, serialized = JSON.stringify(body)) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(serialized);
  };
  const leadJson = async (response, operation, read) => {
    const started = performance.now();
    // Keep measurements scoped to the connection that started this request.
    const metrics = leadPerformance;
    try {
      const body = decorateLeadDevelopment(await read(), business.state().store.view());
      const serialized = JSON.stringify(body);
      const durationMs = performance.now() - started;
      metrics.record(operation, { durationMs, bytes: Buffer.byteLength(serialized) });
      response.setHeader('Server-Timing', `${operation};dur=${durationMs.toFixed(2)}`);
      return json(response, 200, body, serialized);
    } catch (error) {
      const durationMs = performance.now() - started;
      metrics.record(operation, { durationMs, error: true });
      response.setHeader('Server-Timing', `${operation};dur=${durationMs.toFixed(2)}`);
      throw error;
    }
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
        if (url.pathname === '/api/v1/overview') {
          if (request.method !== 'GET') throw new ApiError(405, '总览仅支持读取');
          return json(
            response,
            200,
            await overview.read({
              period: url.searchParams.get('period') || '7d',
              asOf: url.searchParams.get('asOf') || undefined,
            }),
          );
        }
        if (url.pathname.startsWith('/api/v1/outreach/')) {
          return json(
            response,
            200,
            await handleOutreach({
              request,
              url,
              service: outreach(),
              readJson: (input) =>
                readJson(
                  input,
                  /^\/api\/v1\/outreach\/conversations\/[\w-]+\/(?:draft|reply)$/.test(url.pathname)
                    ? 16 * 1024 * 1024
                    : /^\/api\/v1\/outreach\/mailboxes(?:\/[\w-]+)?$/.test(url.pathname)
                      ? 512 * 1024
                      : maxJsonBytes,
                ),
              idempotencyKey: requireIdempotencyKey,
            }),
          );
        }
        if (url.pathname === '/api/v1/connections/models') {
          if (request.method !== 'POST') throw new ApiError(405, '不支持的模型目录操作');
          const preview = connections.previewModelEnvironment(await readJson(request));
          const controller = new AbortController();
          const abort = () => controller.abort();
          request.once('aborted', abort);
          try {
            return json(
              response,
              200,
              await discoverResearchModels({ env: preview, fetchImpl, signal: controller.signal }),
            );
          } finally {
            request.off('aborted', abort);
          }
        }
        if (url.pathname === '/api/v1/business' || url.pathname.startsWith('/api/v1/business/')) {
          const result = await business.handle(request, url, readJson);
          return json(response, result.status, result.body);
        }
        if (url.pathname === '/api/v1/connections') {
          if (request.method === 'GET') return json(response, 200, connections.view());
          if (request.method === 'PUT') {
            const body = await readJson(request);
            if (
              running ||
              business.active ||
              readingLeads ||
              leadLibrary?.refreshing ||
              jobs().active() ||
              [...runs.values()].some((r) => r.status === 'unknown')
            )
              throw new ApiError(409, '请先完成或核对当前任务，再修改 API 连接');
            const result = connections.update(body);
            leadLibrary?.close();
            leadLibrary = undefined;
            leadPerformance = new LeadPerformance();
            overview.reset();
            business.reset();
            provider.close();
            batch?.close();
            batch = undefined;
            provider = createAcquisitionProvider({
              env: connections.environment(),
              fetchImpl,
              nativeImpl,
            });
            brandingCache.entries.clear();
            return json(response, 200, result);
          }
          throw new ApiError(405, '不支持的配置操作');
        }
        if (url.pathname === '/api/v1/products/knowledge') {
          if (request.method === 'GET')
            return json(response, 200, {
              products: knowledge().list(),
              source: 'local',
              feishu: await productMirror().info(),
            });
          if (request.method === 'POST' || request.method === 'PUT') {
            const body = await readJson(request);
            if (!body || typeof body !== 'object' || Array.isArray(body))
              throw new ApiError(400, '产品资料格式不正确');
            const { expectedVersion, ...value } = body;
            if (request.method === 'POST' && value.id)
              throw new ApiError(400, '新增产品资料不能指定已有编号');
            if (request.method === 'PUT' && !value.id)
              throw new ApiError(400, '修改产品资料需要产品编号');
            const key = request.method === 'POST' ? request.headers['idempotency-key'] : undefined;
            if (
              request.method === 'POST' &&
              (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key))
            )
              throw new ApiError(400, '新增产品资料需要有效的 Idempotency-Key');
            const product = knowledge().save(value, { expectedVersion, idempotencyKey: key });
            outbound?.refreshProductMaterials?.();
            const feishu = await productMirror().sync(product);
            return json(response, request.method === 'POST' ? 201 : 200, { product, feishu });
          }
          throw new ApiError(405, '不支持的产品资料操作');
        }
        const productSync = url.pathname.match(
          /^\/api\/v1\/products\/knowledge\/(pk_[a-f0-9]{32})\/sync$/,
        );
        if (productSync && request.method === 'POST') {
          const product = knowledge().get(productSync[1]);
          if (!product) throw new ApiError(404, '产品资料不存在，请刷新资料库');
          return json(response, 200, { product, feishu: await productMirror().sync(product) });
        }
        const prefix = url.pathname.startsWith('/api/v1/acquisition')
          ? '/api/v1/acquisition'
          : '/api/v1/integrations/n8n';
        if (url.pathname === `${prefix}/products`) {
          if (request.method === 'GET') return json(response, 200, { products: catalog().list() });
          if (request.method === 'POST')
            return json(response, 201, catalog().save(await readJson(request)));
          throw new ApiError(405, '不支持的产品目录操作');
        }
        if (url.pathname === `${prefix}/search-preview` && request.method === 'POST') {
          const input = checkCapabilities(
            validateInput({ ...(await readJson(request)), query_mode: 'auto' }),
          );
          return json(response, 200, { queries: searchPlan(input) });
        }
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
              schedules: manager.list().map(reviewPlan),
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
                  ...checkCapabilities(validateInput(body.input)),
                  target_count: validateCount(body.input?.target_count),
                },
              },
              request.headers['idempotency-key'],
            );
            return json(response, 201, reviewPlan(plan));
          }
          if (suffix.length === 2 && request.method === 'POST')
            return json(response, 200, reviewPlan(manager.control(suffix[0], suffix[1])));
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
        if (url.pathname === '/api/v1/leads/real/metrics' && request.method === 'GET')
          return json(response, 200, {
            scope: library().scope,
            sync: {
              ...library().metrics(),
              mode: library().mode,
              intervalMs: library().intervalMs,
            },
            performance: leadPerformance.snapshot(),
          });
        if (url.pathname === '/api/v1/leads/real/list' && request.method === 'GET') {
          if (request.headers['x-lead-library-activity'] === 'active') library().touch();
          return await leadJson(response, 'list', () => library().list());
        }
        if (url.pathname === '/api/v1/leads/real/refresh' && request.method === 'POST')
          return await leadJson(response, 'refresh', () => library().refresh());
        if (url.pathname === '/api/v1/leads/real' && request.method === 'GET')
          return await leadJson(response, 'export', loadLeads);
        const leadRoute = url.pathname.match(/^\/api\/v1\/leads\/real\/([\w-]{1,100})$/);
        if (leadRoute && request.method === 'GET')
          return await leadJson(response, 'detail', () => library().detail(leadRoute[1]));
        const supplementRoute = url.pathname.match(
          /^\/api\/v1\/leads\/real\/([\w-]{1,100})\/supplements$/,
        );
        if (supplementRoute) {
          if (request.method === 'GET' && provider.pendingSupplement)
            return json(response, 200, await provider.pendingSupplement(supplementRoute[1]));
          if (request.method !== 'POST') throw new ApiError(405, '不支持的补充资料操作');
          if (!provider.supplementRecord) throw new ApiError(503, '补充资料需要后端直连引擎');
          const key = request.headers['idempotency-key'];
          if (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key))
            throw new ApiError(400, '保存资料需要有效Idempotency-Key');
          const input = await readJson(request);
          if (running || jobs().active())
            throw new ApiError(409, '请先完成当前获客任务，再补充资料');
          running++;
          try {
            const result = await provider.supplementRecord(
              supplementRoute[1],
              input,
              key,
              business.state().store,
            );
            library().upsert(result.lead);
            return json(response, 200, result);
          } finally {
            running--;
          }
        }
        const contactRoute = url.pathname.match(
          /^\/api\/v1\/leads\/real\/([\w-]{1,100})\/contacts$/,
        );
        if (contactRoute && request.method === 'PATCH') {
          const input = validateContactEdit(await readJson(request));
          if (!provider.updateContacts) throw new ApiError(503, '修改联系方式需要后端直连引擎');
          const directEnv = connections.environment();
          if (
            !directEnv.FEISHU_APP_ID ||
            !directEnv.FEISHU_APP_SECRET ||
            !directEnv.FEISHU_APP_TOKEN ||
            !directEnv.FEISHU_TABLE_ID
          )
            throw new ApiError(503, '请先配置飞书应用直连，以保存联系方式');
          if (running || jobs().active())
            throw new ApiError(409, '请先完成当前获客任务，再修改联系方式');
          running++;
          try {
            const result = await provider.updateContacts(contactRoute[1], input);
            library().upsert(result.lead);
            return json(response, 200, result);
          } finally {
            running--;
          }
        }
        if (url.pathname === '/api/v1/assessments/rules' && request.method === 'GET') {
          if (!provider.assessmentInfo) throw new ApiError(503, '自动评级目前需要后端直连引擎');
          return json(response, 200, provider.assessmentInfo());
        }
        const assessmentRoute = url.pathname.match(
          /^\/api\/v1\/leads\/real\/([\w-]+)\/assessments(?:\/(ev_[a-f0-9]{36})\/retry)?$/,
        );
        if (assessmentRoute) {
          if (!provider.assessRecord) throw new ApiError(503, '自动评级目前需要后端直连引擎');
          const [, recordId, evaluationId] = assessmentRoute;
          await library().detail(recordId);
          if (request.method === 'GET' && !evaluationId)
            return json(response, 200, provider.assessmentHistory(recordId));
          if (request.method === 'POST' && evaluationId)
            throw new ApiError(410, '评估历史同步已停用，请刷新查看最新评估');
          if (request.method === 'POST' && !evaluationId) {
            if (!provider.info.configured) throw new ApiError(503, '请先配置企业研究所需API');
            if (running || jobs().active())
              throw new ApiError(409, '请先完成当前获客任务或核对其写入结果');
            const body = await readJson(request);
            if (
              !body ||
              typeof body !== 'object' ||
              Array.isArray(body) ||
              Object.keys(body).some((key) => !['product', 'country'].includes(key))
            )
              throw new ApiError(400, '评级只接收产品与国家，不接受客户端分数或证据');
            for (const value of Object.values(body))
              if (typeof value !== 'string' || value.length > 500)
                throw new ApiError(400, '产品和国家必须为500字以内文本');
            const key = request.headers['idempotency-key'];
            if (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key))
              throw new ApiError(400, '研究评级需要有效Idempotency-Key');
            running++;
            try {
              const output = await provider.assessRecord(recordId, body, 'rating-' + key);
              library().invalidate();
              void library()
                .refresh({ afterCurrent: true })
                .catch(() => {});
              return json(response, 200, output);
            } finally {
              running--;
            }
          }
          throw new ApiError(405, '不支持的评估操作');
        }
        const brandAsset = url.pathname.match(/^\/api\/v1\/branding\/assets\/([a-f0-9]{64})$/);
        if (brandAsset && ['GET', 'HEAD'].includes(request.method)) {
          const asset = await brandingCache.asset(brandAsset[1]);
          if (!asset) throw new ApiError(404, '品牌图片不存在');
          response.setHeader('Content-Type', asset.contentType);
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          response.setHeader('ETag', asset.etag);
          response.setHeader('X-Content-Type-Options', 'nosniff');
          response.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
          );
          if (request.headers['if-none-match'] === asset.etag) {
            response.writeHead(304);
            return response.end();
          }
          response.setHeader('Content-Length', asset.body.length);
          response.writeHead(200);
          return response.end(request.method === 'HEAD' ? undefined : asset.body);
        }
        const branding = url.pathname.match(/^\/api\/v1\/leads\/real\/([\w-]+)\/branding$/);
        if (branding && request.method === 'GET') {
          const { lead } = await library().detail(branding[1]);
          return json(response, 200, await brandingCache.get(lead));
        }
        if (url.pathname === `${prefix}/status` && request.method === 'GET')
          return json(response, 200, provider.info);
        if (url.pathname === `${prefix}/jobs` || url.pathname.startsWith(`${prefix}/jobs/`)) {
          const suffix = url.pathname.slice(`${prefix}/jobs`.length).split('/').filter(Boolean);
          const manager = jobs();
          if (!suffix.length && request.method === 'GET')
            return json(response, 200, { jobs: manager.list().map(reviewJob) });
          if (!suffix.length && request.method === 'POST') {
            if (!provider.info.configured)
              throw new ApiError(503, '获客执行引擎尚未配置，请检查接入状态');
            if (running) throw new ApiError(409, '单次任务正在执行');
            const body = await readJson(request);
            const input = {
              ...checkCapabilities(validateInput(body)),
              target_count: validateCount(body.target_count),
            };
            const job = manager.create(input, request.headers['idempotency-key']);
            return json(response, 202, reviewJob(job));
          }
          if (suffix.length === 1 && request.method === 'GET')
            return json(response, 200, reviewJob(manager.get(suffix[0])));
          if (suffix.length === 3 && suffix[1] === 'reviews') {
            const job = manager.get(suffix[0]);
            if (job.scope !== manager.scope) throw new ApiError(409, '执行记录所属客户库已变化');
            const index = Number(suffix[2]);
            if (!Number.isSafeInteger(index) || index < 0 || String(index) !== suffix[2])
              throw new ApiError(400, '待核实行号无效');
            const row = job.rows[index];
            if (!row || row.result !== 'review') throw new ApiError(404, '待核实企业不存在');
            if (request.method === 'GET') {
              const resolution = reviews().get(job.id, index);
              return json(response, 200, {
                resolution,
                evidence:
                  provider.reviewEvidence?.(resolution?.operation_id || row.operation_id) || null,
              });
            }
            if (request.method !== 'POST') throw new ApiError(405, '不支持的核实操作');
            if (provider.info.provider !== 'native' || !provider.info.configured)
              throw new ApiError(503, '待核实企业需要已配置的直连获客引擎');
            if (running || manager.active())
              throw new ApiError(409, '当前获客任务正在处理，请完成后再核实该企业');
            const body = await readJson(request);
            const source = websiteScope(body?.source_url);
            if (!source) throw new ApiError(400, '请填写公网 HTTPS 企业官网');
            const key = request.headers['idempotency-key'];
            if (typeof key !== 'string' || !/^[\w-]{8,80}$/.test(key))
              throw new ApiError(400, '核实操作需要有效 Idempotency-Key');
            const prior = reviews().get(job.id, index);
            const attempt = reviews().begin(job.id, index, key, source.url);
            if (prior?.key === key) {
              if (!['pending', 'uncertain'].includes(attempt.status))
                return json(response, 200, { resolution: attempt });
              const result = await provider.status(attempt.operation_id);
              if (result?.settled) {
                const resolution = reviews().settle(job.id, index, result.output);
                if (['inserted', 'updated'].includes(resolution.status)) library().invalidate();
                return json(response, 200, { resolution });
              }
              if (result?.reason?.includes('操作记录不存在'))
                return json(response, 200, {
                  resolution: reviews().settle(job.id, index, {
                    outcome: 'failed',
                    reason: '上次核实操作未建立，请重新提交',
                  }),
                });
              throw new ApiError(409, '核实结果尚待确认，未重复执行');
            }
            running++;
            try {
              const output = await provider.research(job.input, {
                ...row,
                source_url: source.url,
                source_title: '',
                operation_id: attempt.operation_id,
              });
              const resolution = reviews().settle(job.id, index, output);
              if (['inserted', 'updated'].includes(resolution.status)) library().invalidate();
              return json(response, 200, { resolution });
            } catch {
              reviews().uncertain(job.id, index);
              throw new ApiError(409, '核实结果待确认，请使用同一操作编号重试，避免重复入库');
            } finally {
              running--;
            }
          }
          if (suffix.length === 2 && request.method === 'POST') {
            if (suffix[1] === 'stop')
              return json(response, 200, reviewJob(manager.stop(suffix[0])));
            if (suffix[1] === 'resume') {
              if (!provider.info.configured) throw new ApiError(503, '获客执行引擎尚未配置');
              return json(response, 200, reviewJob(await manager.resume(suffix[0])));
            }
          }
          throw new ApiError(404, '任务接口不存在');
        }
        if (url.pathname === `${prefix}/runs` && request.method === 'POST') {
          if (!provider.info.configured)
            throw new ApiError(503, '获客执行引擎尚未配置，请先完成接入配置。');
          const input = checkCapabilities(validateInput(await readJson(request)));
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
  server.on('listening', () => {
    plans().start();
    if (env.OUTREACH_DB_PATH) outreach().start();
  });
  server.on('close', () => {
    leadLibrary?.close();
    if (outbound) void outbound.close();
    products?.close();
    productKnowledge?.close();
    business.close();
    schedules?.close();
    if (batch && !batch.busy) batch.close();
    if (!batch?.busy && !running) provider.close();
  });
  return server;
}
