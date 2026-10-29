import { createHash } from 'node:crypto';
import { CustomerBusiness } from './customer-business.mjs';
import { CustomerBusinessFeishu } from './customer-business-feishu.mjs';
import { ProductKnowledgeFeishu } from './product-knowledge-feishu.mjs';
import { FeishuClient } from './feishu-direct.mjs';
import { fieldText } from './feishu.mjs';
import { decorateLeadDevelopment } from './lead-development.mjs';

export const CUSTOMER_BUSINESS_VERSION = 't1-t3-t4-v1';
const kinds = new Set(['conversations', 'messages', 'demands', 'tasks']);
const methods = {
  conversations: 'saveConversation',
  messages: 'saveMessage',
  demands: 'saveDemand',
  tasks: 'saveTask',
};
const fail = (status, message) => Object.assign(new Error(message), { status });

// The HTTP entry point owns graph persistence and its collaboration mirror.
// A saved business record remains readable when the mirror needs reconciliation.
export class CustomerBusinessApi {
  constructor({ getEnv, fetchImpl = fetch, knowledge, loadCustomers }) {
    this.getEnv = getEnv;
    this.fetch = fetchImpl;
    this.knowledge = knowledge;
    this.loadCustomers = loadCustomers;
    this.active = 0;
    this.current = null;
    this.syncTail = Promise.resolve();
  }
  state() {
    const env = this.getEnv();
    const path = env.CUSTOMER_BUSINESS_DB_PATH || env.BATCH_DB_PATH || ':memory:';
    const scope = String(env.FEISHU_APP_TOKEN || '') + '/' + String(env.FEISHU_TABLE_ID || '');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([path, scope, env.FEISHU_APP_ID || '', env.FEISHU_APP_SECRET || '']))
      .digest('hex');
    if (this.current?.fingerprint === fingerprint) return this.current;
    this.reset();
    const client = new FeishuClient({ env, fetchImpl: this.fetch });
    const store = new CustomerBusiness({
      path,
      scope,
      customer: async (id) => client.record(id),
      product: async (id) => this.knowledge().get(id),
    });
    const mirror = new CustomerBusinessFeishu({
      env,
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
    this.reset();
  }
  async synchronize() {
    const state = this.state();
    const operation = this.syncTail
      .catch(() => {})
      .then(async () => {
        try {
          const workspace = state.store.view();
          const productIds = new Set([
            ...workspace.demands.flatMap((row) => row.productIds || []),
            ...workspace.tasks.flatMap((row) => row.productIds || []),
          ]);
          const productMirror = new ProductKnowledgeFeishu({
            env: state.env,
            fetchImpl: this.fetch,
          });
          for (const id of productIds) {
            const product = this.knowledge().get(id);
            if (!product)
              return { status: 'pending', error: '关联产品资料不存在，请核对后重新同步' };
            const result = await productMirror.sync(product);
            if (result.status !== 'synced')
              return {
                status: 'pending',
                error: '关联的 T5 产品资料尚未核对同步，请先处理产品资料',
              };
          }
          return await state.mirror.sync(workspace, { products: this.knowledge().list() });
        } catch {
          return {
            status: 'pending',
            error: '业务记录已保存在后台，飞书同步待核对，请刷新后重新同步',
          };
        }
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
    return {
      schemaVersion: CUSTOMER_BUSINESS_VERSION,
      ...data,
      customers,
      products: this.knowledge().list(),
      customerError,
      feishu: await mirror.info(),
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
      if (kind === 'customers' && suffix.length === 3 && action === 'development') {
        if (!id || !/^[\w-]{1,100}$/u.test(id)) throw fail(400, '客户编号无效');
        const store = this.state().store;
        let customer;
        if (request.method === 'GET') customer = await store.actualCustomer(id);
        else if (request.method === 'POST') {
          const body = await readJson(request);
          if (!body || typeof body !== 'object' || Array.isArray(body))
            throw fail(400, '开发操作格式不正确');
          customer = await store.actualCustomer(id);
          await store.actDevelopment(id, body, customer);
        } else throw fail(405, '不支持的开发控制操作');
        return {
          status: 200,
          body: {
            ...store.developmentView(id),
            sourceStatus: fieldText(customer.fields?.['开发状态']),
            status: decorateLeadDevelopment(
              {
                lead: {
                  id,
                  status: fieldText(customer.fields?.['开发状态']),
                },
              },
              store.view({ customerId: id }),
            ).lead.status,
          },
        };
      }
      if (!kinds.has(kind) || suffix.length > 3) throw fail(404, '业务记录入口不存在');
      if (id && !/^[\w-]{1,100}$/.test(id)) throw fail(400, '业务记录编号无效');
      const store = this.state().store;
      if (request.method === 'GET') {
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
        return { status: 200, body: { record, feishu: await this.synchronize() } };
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
        body: { record, feishu: await this.synchronize() },
      };
    } finally {
      this.active--;
    }
  }
}
