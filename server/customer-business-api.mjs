import { createHash } from 'node:crypto';
import { CustomerBusiness } from './customer-business.mjs';
import { CustomerBusinessFeishu } from './customer-business-feishu.mjs';
import { ProductKnowledgeFeishu } from './product-knowledge-feishu.mjs';
import { FeishuClient } from './feishu-direct.mjs';
import { fieldText } from './feishu.mjs';
import { decorateLeadDevelopment } from './lead-development.mjs';
import { customerMirrorFields } from './customer-mirror.mjs';
import { enrichCommunicationMessages } from './communication-analysis.mjs';
import { BUSINESS_TABLE_ID_ENV } from './feishu-business-client.mjs';

export const CUSTOMER_BUSINESS_VERSION = 't1-t3-t4-v2';
const kinds = new Set(['conversations', 'messages', 'demands', 'tasks']);
const methods = {
  conversations: 'saveConversation',
  messages: 'saveMessage',
  demands: 'saveDemand',
  tasks: 'saveTask',
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const mirrorHash = (workspace, products, env) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        version: CUSTOMER_BUSINESS_VERSION,
        workspace,
        products,
        tables: Object.values(BUSINESS_TABLE_ID_ENV).map((key) => env[key] || ''),
      }),
    )
    .digest('hex');

// The HTTP entry point owns graph persistence and its collaboration mirror.
// A saved business record remains readable when the mirror needs reconciliation.
export class CustomerBusinessApi {
  constructor({
    getEnv,
    fetchImpl = fetch,
    knowledge,
    loadCustomers,
    customerRecord,
    customerRemoteId,
    syncCustomers,
    mailBodies = () => ({}),
    saveCustomerFields,
    communicationModel,
  }) {
    this.getEnv = getEnv;
    this.fetch = fetchImpl;
    this.knowledge = knowledge;
    this.loadCustomers = loadCustomers;
    this.customerRecord = customerRecord;
    this.customerRemoteId = customerRemoteId;
    this.syncCustomers = syncCustomers;
    this.mailBodies = mailBodies;
    this.saveCustomerFields = saveCustomerFields;
    this.communicationModel = communicationModel;
    this.active = 0;
    this.current = null;
    this.syncTail = Promise.resolve();
  }
  state() {
    const env = this.getEnv();
    const path = env.CUSTOMER_BUSINESS_DB_PATH || env.BATCH_DB_PATH || ':memory:';
    const scope = String(env.FEISHU_APP_TOKEN || '') + '/' + String(env.FEISHU_TABLE_ID || '');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          path,
          scope,
          env.FEISHU_APP_ID || '',
          env.FEISHU_APP_SECRET || '',
          Object.entries(env).filter(
            ([key]) =>
              Object.values(BUSINESS_TABLE_ID_ENV).includes(key) ||
              /^(RESEARCH_MODEL_|DEEPSEEK_)/.test(key),
          ),
        ]),
      )
      .digest('hex');
    if (this.current?.fingerprint === fingerprint) return this.current;
    this.reset();
    const client = new FeishuClient({ env, fetchImpl: this.fetch });
    const store = new CustomerBusiness({
      path,
      scope,
      customer: async (id) => this.customerRecord?.(id) || client.record(id),
      product: async (id) => this.knowledge().get(id),
    });
    const mirror = new CustomerBusinessFeishu({
      env,
      customerRemoteId: this.customerRemoteId,
      fetchImpl: this.fetch,
      journalPath:
        env.BUSINESS_MIRROR_JOURNAL_PATH || (path === ':memory:' ? ':memory:' : undefined),
    });
    this.current = { fingerprint, store, mirror, env };
    return this.current;
  }
  reset() {
    this.current?.store.close();
    this.current = null;
  }
  close() {
    clearInterval(this.timer);
    if (this.syncing) return this.syncTail.catch(() => {}).finally(() => this.reset());
    this.reset();
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.syncing) void this.synchronize({ force: false }).catch(() => {});
    }, 60000);
    this.timer.unref();
  }
  async synchronize({ force = true } = {}) {
    const state = this.state();
    this.syncing = (this.syncing || 0) + 1;
    const operation = this.syncTail
      .catch(() => {})
      .then(async () => {
        try {
          const workspace = state.store.view();
          const customers = await this.loadCustomers();
          if (this.saveCustomerFields) {
            const byId = new Map(customers.map((lead) => [lead.id, lead]));
            for (const { id, fields } of customerMirrorFields(customers, workspace, {
              emailValidity: Boolean(state.env.FEISHU_MESSAGES_TABLE_ID?.trim()),
            })) {
              const changed = Object.fromEntries(
                Object.entries(fields).filter(
                  ([key, value]) => fieldText(byId.get(id).fields?.[key]) !== fieldText(value),
                ),
              );
              if (Object.keys(changed).length) await this.saveCustomerFields(id, changed);
            }
          }
          await this.syncCustomers?.();
          const products = this.knowledge().list();
          const hash = mirrorHash(workspace, products, state.env);
          const prior = state.store.db
            .prepare('SELECT hash,error FROM customer_business_sync WHERE scope=?')
            .get(state.store.scope);
          if (!force && prior?.hash === hash && !prior.error) return { status: 'synced' };
          const productIds = new Set(products.map((product) => product.id));
          const productMirror = new ProductKnowledgeFeishu({
            env: state.env,
            fetchImpl: this.fetch,
          });
          for (const id of productIds) {
            const product = this.knowledge().get(id);
            if (!product) throw new Error('关联产品资料不存在，请核对后重新同步');
            const result = await productMirror.sync(product);
            if (result.status !== 'synced')
              throw new Error('T5 产品资料尚未核对同步，请先处理产品资料');
          }
          const mirrorWorkspace = state.env.FEISHU_MESSAGES_TABLE_ID?.trim()
            ? {
                ...workspace,
                messages: await enrichCommunicationMessages(state.store, workspace.messages, {
                  env: state.env,
                  fetchImpl: this.fetch,
                  model: this.communicationModel,
                }),
              }
            : workspace;
          const result = await state.mirror.sync(mirrorWorkspace, { products });
          state.store.db
            .prepare('INSERT OR REPLACE INTO customer_business_sync VALUES(?,?,?)')
            .run(
              state.store.scope,
              result.status === 'synced' ? hash : prior?.hash || '',
              result.error || (result.status === 'synced' ? '' : '飞书同步未完成'),
            );
          return result;
        } catch (error) {
          state.store.db
            .prepare('INSERT OR REPLACE INTO customer_business_sync VALUES(?,?,?)')
            .run(state.store.scope, '', error.message);
          return {
            status: 'pending',
            error: '业务记录已保存在后台，飞书同步未完成，稍后自动重试',
          };
        }
      })
      .finally(() => {
        this.syncing--;
      });
    this.syncTail = operation;
    return operation;
  }
  async workspace(url) {
    const { store, mirror } = this.state();
    const data = store.view({
      customerId: url.searchParams.get('customerId') || undefined,
      productId: url.searchParams.get('productId') || undefined,
    });
    let customers = [];
    let customerError = '';
    try {
      customers = decorateLeadDevelopment(
        { leads: await this.loadCustomers() },
        store.view(),
      ).leads.map((row) => ({
        id: row.id,
        name: row.name,
        website: row.website,
        grade: row.grade,
        status: row.status,
      }));
    } catch {
      customerError = 'T2 企业资料暂时无法读取；已保存的业务记录仍可查看';
    }
    const sync = store.db
      .prepare('SELECT hash,error FROM customer_business_sync WHERE scope=?')
      .get(store.scope);
    const products = this.knowledge().list();
    const pending = sync?.hash !== mirrorHash(store.view(), products, this.state().env);
    const feishu = await mirror.info();
    return {
      schemaVersion: CUSTOMER_BUSINESS_VERSION,
      ...data,
      customers,
      products,
      customerError,
      feishu:
        pending || sync?.error
          ? { ...feishu, status: 'pending', error: sync?.error || '' }
          : feishu,
    };
  }
  async handle(request, url, readJson) {
    this.active++;
    try {
      const suffix = url.pathname.slice('/api/v1/business'.length).split('/').filter(Boolean);
      if (!suffix.length && request.method === 'GET')
        return { status: 200, body: await this.workspace(url) };
      if (suffix.length === 1 && suffix[0] === 'schema' && request.method === 'GET')
        return {
          status: 200,
          body: {
            schemaVersion: CUSTOMER_BUSINESS_VERSION,
            feishu: await this.state().mirror.info(),
          },
        };
      if (suffix.length === 1 && suffix[0] === 'sync' && request.method === 'POST')
        return { status: 200, body: { feishu: await this.synchronize() } };
      const [kind, id, action] = suffix;
      if (!kinds.has(kind) || suffix.length > 3) throw fail(404, '业务记录入口不存在');
      if (id && !/^[\w-]{1,100}$/.test(id)) throw fail(400, '业务记录编号无效');
      const store = this.state().store;
      if (request.method === 'GET') {
        if (kind === 'conversations' && id && action === 'mail-bodies') {
          if (!store.get(kind, id)) throw fail(404, '业务会话不存在，请刷新列表');
          return {
            status: 200,
            body: {
              originals: await this.mailBodies(
                store
                  .all('messages')
                  .filter((row) => row.conversationId === id && row.channel === 'email'),
              ),
            },
          };
        }
        if (action) throw fail(405, '不支持的业务记录读取操作');
        if (!id) return { status: 200, body: { records: (await this.workspace(url))[kind] } };
        const record = store.get(kind, id);
        if (!record) throw fail(404, '业务记录不存在，请刷新列表');
        return { status: 200, body: { record } };
      }
      if (kind === 'tasks' && id && action === 'preflight' && request.method === 'POST')
        return { status: 200, body: await store.preflightTask(id) };
      if (kind === 'tasks' && id && action === 'action' && request.method === 'POST') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw fail(400, '任务操作格式不正确');
        const record = await store.actTask(id, body);
        return { status: 200, body: { record, feishu: { status: 'pending' } } };
      }
      if (suffix.length !== 1 || !['POST', 'PUT'].includes(request.method))
        throw fail(405, '不支持的业务记录操作');
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw fail(400, '业务记录格式不正确');
      const { expectedVersion, ...value } = body;
      if (request.method === 'POST' && value.id) throw fail(400, '新增业务记录不能指定已有编号');
      if (request.method === 'PUT' && !value.id) throw fail(400, '修改业务记录需要记录编号');
      const key = request.method === 'POST' ? request.headers['idempotency-key'] : undefined;
      if (request.method === 'POST' && (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key)))
        throw fail(400, '新增业务记录需要有效的 Idempotency-Key');
      const record = await store[methods[kind]](value, { expectedVersion, idempotencyKey: key });
      return {
        status: request.method === 'POST' ? 201 : 200,
        body: { record, feishu: { status: 'pending' } },
      };
    } finally {
      this.active--;
    }
  }
}
