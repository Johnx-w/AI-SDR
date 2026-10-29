import { overviewRange, taskBucket, activeDemand } from '../src/domain/overview-rules.mjs';

const dayMs = 86400000;
const stages = {
  new: '新需求',
  clarifying: '确认规格',
  quoting: '报价中',
  sampling: '样品中',
  negotiating: '商务沟通',
  won: '已成交',
  lost: '未成交',
  closed: '已关闭',
};
const sourceNames = {
  customers: '客户库',
  business: '客户业务',
  acquisition: '获客执行',
  products: '产品资料',
};
const date = (value) => (Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
const latest = (records, fallback) =>
  records
    .map((row) => date(row.updatedAt || row.capturedAt || row.createdAt))
    .filter(Boolean)
    .sort()
    .at(-1) || fallback;
const link = (path, params) =>
  path +
  '?' +
  new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== ''),
  );
const businessLink = (tab, params = {}) => link('/business', { tab, ...params });

// Reads existing facts only. Source caches are scoped to the active connection,
// and never turn a missing source into a successful zero or a demo result.
export class OverviewService {
  constructor({
    customers,
    customerSnapshot,
    business,
    acquisition,
    products,
    scope = () => '',
    now = Date.now,
    timeoutMs = 8000,
  }) {
    this.readers = { customers, business, acquisition, products };
    this.customerSnapshot = customerSnapshot;
    this.scope = scope;
    this.now = now;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;
    this.cache = new Map();
    this.currentScope = undefined;
    this.generation = 0;
  }
  reset() {
    this.cache.clear();
    this.currentScope = undefined;
    this.generation++;
  }
  async source(key, asOf, generation) {
    let timer;
    try {
      const pending = this.readers[key]();
      const data = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('总览来源读取超时')), this.timeoutMs);
        }),
      ]);
      const records =
        key === 'customers'
          ? data.leads
          : key === 'business'
            ? [...data.conversations, ...data.demands, ...data.tasks, ...data.messages]
            : key === 'products'
              ? data
              : [...data.jobs, ...data.captures, ...data.schedules];
      const updatedAt = key === 'customers' ? data.syncedAt || null : latest(records, asOf);
      const stale = key === 'customers' && (data.sync?.stale || data.sync?.error);
      const status = {
        state: stale ? 'stale' : 'ready',
        updatedAt,
        error: stale ? '客户库同步尚未完成，当前显示上次保存的数据' : '',
      };
      if (generation === this.generation) this.cache.set(key, { data, status });
      return { data, status };
    } catch {
      let prior = this.cache.get(key);
      if (!prior && key === 'customers' && this.customerSnapshot) {
        try {
          const data = this.customerSnapshot();
          if (data.syncedAt) prior = { data, status: { updatedAt: data.syncedAt } };
        } catch {
          /* No readable local replica. */
        }
      }
      return {
        data: prior?.data || null,
        status: {
          state: prior ? 'stale' : 'unavailable',
          updatedAt: prior?.status.updatedAt || null,
          error:
            sourceNames[key] +
            (prior ? '读取失败，当前显示上次保存的数据' : '暂时无法读取，请稍后重试'),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
  async read({ period = '7d', asOf } = {}) {
    const range = overviewRange(period, asOf || this.now());
    const scope = this.scope();
    if (scope !== this.currentScope) {
      this.cache.clear();
      this.currentScope = scope;
      this.generation++;
    }
    const generation = this.generation;
    const keys = Object.keys(this.readers);
    const entries = await Promise.all(
      keys.map(async (key) => [key, await this.source(key, range.asOf, generation)]),
    );
    if (generation !== this.generation || scope !== this.scope())
      throw Object.assign(new Error('客户表已切换，请刷新总览'), { status: 409 });
    const results = Object.fromEntries(entries);
    const sources = Object.fromEntries(entries.map(([key, value]) => [key, value.status]));
    const customers = results.customers.data?.leads || [];
    const customerMap = new Map(customers.map((customer) => [customer.id, customer]));
    const graph = results.business.data;
    const acquisition = results.acquisition.data;
    const productRows = results.products.data;
    const captures = (acquisition?.captures || [])
      .filter(
        (row) =>
          Date.parse(row.capturedAt) >= Date.parse(range.start) &&
          Date.parse(row.capturedAt) < Date.parse(range.end),
      )
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
      .map((row) => ({
        ...row,
        name: customerMap.get(row.customerId)?.name || row.domain,
        available: results.customers.data ? customerMap.has(row.customerId) : null,
      }));
    const work = graph
      ? { overdue: 0, today: 0, paused: 0 }
      : { overdue: null, today: null, paused: null };
    if (graph)
      for (const task of graph.tasks) {
        const bucket = taskBucket(task, range);
        if (bucket) work[bucket]++;
      }
    const activeDemands = graph?.demands.filter(activeDemand) || [];
    const reviewDay = new Date(Date.parse(range.asOf) + 8 * 3600000).toISOString().slice(0, 10);
    const developmentReviews = graph
      ? (graph.customerContexts || [])
          .filter(
            (context) =>
              context.development?.paused &&
              context.development.reviewDate &&
              context.development.reviewDate <= reviewDay,
          )
          .sort(
            (a, b) =>
              a.development.reviewDate.localeCompare(b.development.reviewDate) ||
              a.customerId.localeCompare(b.customerId),
          )
          .map((context) => ({
            customerId: context.customerId,
            name:
              customerMap.get(context.customerId)?.name ||
              `${context.customerId}（企业资料暂不可用）`,
            reason: context.development.reason,
            reviewDate: context.development.reviewDate,
            to: link('/leads', { lead: context.customerId }),
          }))
      : null;
    const priority = [];
    const selected = new Set();
    const suppressed = new Set([
      ...(graph?.customerContexts || [])
        .filter((context) => context.doNotContact || context.development?.paused)
        .map((context) => context.customerId),
      ...customers
        .filter((customer) =>
          /暂不开发|暂缓开发|暂停开发|停止开发|拒绝联系|已退订/u.test(customer.status || ''),
        )
        .map((customer) => customer.id),
    ]);
    const addPriority = (customerId, value) => {
      if (selected.has(customerId)) return;
      selected.add(customerId);
      const customer = customerMap.get(customerId);
      priority.push({
        customerId,
        name: customer?.name || `${customerId}（企业资料暂不可用）`,
        market: customer?.market || '未记录',
        grade: customer?.grade || '未评级',
        ...value,
      });
    };
    if (graph) {
      const dueTasks = graph.tasks
        .filter((task) => ['overdue', 'today'].includes(taskBucket(task, range)))
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
      for (const task of dueTasks)
        addPriority(task.customerId, {
          reason:
            (taskBucket(task, range) === 'overdue' ? '跟进任务已逾期' : '今日有待执行跟进') +
            (suppressed.has(task.customerId) &&
            ['first_contact', 'clarify_specs', 'quote_followup'].includes(task.kind)
              ? '，需先核对联系限制'
              : ''),
          action: task.title,
          dueAt: task.dueAt,
          owner: task.owner || '',
          to: businessLink('tasks', { customerId: task.customerId, task: task.id }),
        });
      const openTasks = graph.tasks.filter((task) => ['pending', 'paused'].includes(task.status));
      for (const demand of activeDemands.sort(
        (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id),
      )) {
        const hasNextStep = openTasks.some(
          (task) =>
            task.customerId === demand.customerId &&
            ((task.demandIds || []).includes(demand.id) ||
              (!task.demandIds?.length &&
                (!task.conversationId || task.conversationId === demand.conversationId))),
        );
        if (!hasNextStep)
          addPriority(demand.customerId, {
            reason: suppressed.has(demand.customerId)
              ? '进行中需求需人工核对联系限制'
              : '进行中需求尚未安排下一步',
            action: demand.title,
            owner: demand.owner || '',
            to: businessLink('demands', { customerId: demand.customerId, demand: demand.id }),
          });
      }
      const contacted = new Set(
        [...graph.conversations, ...graph.messages, ...graph.demands, ...graph.tasks].map(
          (record) => record.customerId,
        ),
      );
      const ranked = customers
        .filter(
          (customer) =>
            ['A', 'B'].includes(customer.grade) &&
            ['待开发', '未开发', '未联系', '待联系', '新线索', '未记录', ''].includes(
              customer.status || '',
            ) &&
            !suppressed.has(customer.id) &&
            !contacted.has(customer.id),
        )
        .sort((a, b) => a.grade.localeCompare(b.grade) || a.name.localeCompare(b.name));
      for (const customer of ranked)
        addPriority(customer.id, {
          reason: `${customer.grade} 级待开发客户`,
          action: '查看档案与开发依据',
          to: link('/leads', { lead: customer.id }),
        });
    }
    const trend = [];
    for (let at = Date.parse(range.start); at <= Date.parse(range.todayStart); at += dayMs) {
      const day = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
      trend.push({
        date: day,
        count: acquisition
          ? captures.filter(
              (row) => Date.parse(row.capturedAt) >= at && Date.parse(row.capturedAt) < at + dayMs,
            ).length
          : null,
      });
    }
    const jobOrder = { running: 0, stopping: 1, paused: 2, partial: 3, completed: 4 };
    const jobs = (acquisition?.jobs || [])
      .filter((job) => job.countPolicy === 'broad-business-v1')
      .sort(
        (a, b) =>
          (jobOrder[a.status] ?? 5) - (jobOrder[b.status] ?? 5) ||
          (b.createdAt || '').localeCompare(a.createdAt || ''),
      )
      .slice(0, 6)
      .map((job) => ({
        id: job.id,
        title: [
          job.input?.country,
          job.input?.region,
          job.input?.products?.map((product) => product.label).join('、') ||
            job.input?.product ||
            (job.input?.product_scope === 'all' ? '全部窗饰产品' : ''),
        ]
          .filter(Boolean)
          .join(' · '),
        status: job.status,
        inserted: job.inserted || 0,
        target: job.target || 0,
        updated: job.updated || 0,
        pending: job.pending || 0,
        reason: job.message || job.reason || '',
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        to: link('/automation', { tab: 'runs', job: job.id }),
      }));
    const jobIds = new Set(acquisition?.jobs.map((job) => job.id));
    const schedules = (acquisition?.schedules || [])
      .filter(
        (plan) =>
          !['closed', 'completed'].includes(plan.status) &&
          (plan.scope === acquisition.scope || (!plan.scope && jobIds.has(plan.lastJobId))),
      )
      .sort((a, b) => (a.nextRunAt || 'z').localeCompare(b.nextRunAt || 'z'))
      .slice(0, 6)
      .map((plan) => ({
        id: plan.id,
        name: plan.name,
        status: plan.status,
        nextRunAt: plan.nextRunAt || null,
        to: '/automation?tab=schedules',
      }));
    const taskLink = (bucket) => businessLink('tasks', { bucket, asOf: range.asOf });
    return {
      asOf: range.asOf,
      timeZone: 'Asia/Shanghai',
      range,
      sources,
      metrics: {
        companies: results.customers.data ? customers.length : null,
        newCompanies: acquisition ? captures.length : null,
        activeDemands: graph ? activeDemands.length : null,
        dueTasks: graph ? work.overdue + work.today : null,
      },
      work,
      developmentReviews,
      links: {
        companies: '/leads',
        newCompanies: link('/automation', {
          tab: 'runs',
          view: 'captures',
          period,
          asOf: range.asOf,
        }),
        activeDemands: businessLink('demands', { state: 'active' }),
        dueTasks: taskLink('due'),
        overdue: taskLink('overdue'),
        today: taskLink('today'),
        paused: taskLink('paused'),
      },
      priority: priority.slice(0, 8),
      jobs,
      schedules,
      trend,
      captures,
      stages: graph
        ? Object.entries(stages).map(([stage, label]) => ({
            stage,
            label,
            count: graph.demands.filter((demand) => demand.stage === stage).length,
            to: businessLink('demands', { state: stage }),
          }))
        : [],
      products: {
        draft: productRows
          ? productRows.filter((product) => product.status === 'draft').length
          : null,
        to: '/materials?status=draft',
        syncIssues: null,
      },
      coverage: { recordedOnly: true, note: '按已记录新增统计，未记录历史不补为零' },
    };
  }
}
