import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const kinds = { conversations: 'conv_', messages: 'msg_', demands: 'dem_', tasks: 'task_' };
const channels = ['email', 'whatsapp', 'form', 'phone', 'other'];
const ownerships = ['auto', 'human'];
const communicationKinds = new Set(['first_contact', 'clarify_specs', 'quote_followup']);
const terminalStages = new Set(['won', 'lost', 'closed']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, name, maximum = 500, required = false) => {
  if (value === undefined || value === null) {
    if (required) throw fail(400, '请填写' + name);
    return '';
  }
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    throw fail(400, name + '格式错误或内容过长');
  const result = value.trim();
  if (required && !result) throw fail(400, '请填写' + name);
  return result;
};
const choice = (value, options, fallback, name) => {
  const result = value ?? fallback;
  if (!options.includes(result)) throw fail(400, name + '不正确');
  return result;
};
const ids = (value, name, maximum = 30) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw fail(400, name + '格式或数量不正确');
  return [...new Set(value.map((item) => text(item, name, 180, true)))];
};
const date = (value, name, required = true) => {
  const result = text(value, name, 40, required);
  if (!result && !required) return '';
  if (
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(result) ||
    !Number.isFinite(Date.parse(result))
  )
    throw fail(400, name + '必须是带时区的有效时间');
  if (new Date(result.slice(0, 10)).toISOString().slice(0, 10) !== result.slice(0, 10))
    throw fail(400, name + '日期无效');
  return new Date(result).toISOString();
};
const account = (value, channel, required = false) => {
  const result = text(value, '对外账号', 240, required);
  if (!result || channel !== 'email') return result;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/u.test(result))
    throw fail(400, '请填写有效的对外邮箱账号');
  return result.toLowerCase();
};
const safeAttachment = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail(400, '附件必须为有效的 HTTP/HTTPS 链接');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw fail(400, '附件链接不正确');
  return url.href;
};
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const readOnly = new Set([
  'id',
  'version',
  'createdAt',
  'updatedAt',
  'productVersions',
  'productReadiness',
  'audit',
  'events',
  'completedAt',
  'resultMessageId',
]);
const requestHash = (value) =>
  hash(Object.fromEntries(Object.entries(value).filter(([key]) => !readOnly.has(key))));
const overlapping = (left, right) => left.some((id) => right.includes(id));
const isActualReply = (message) =>
  message.direction === 'inbound' &&
  message.deliveryStatus === 'received' &&
  message.classification === 'normal';
const actualEmail = (message) =>
  message.channel === 'email' &&
  ((message.direction === 'inbound' && message.deliveryStatus === 'received') ||
    (message.direction === 'outbound' && ['sent', 'accepted'].includes(message.deliveryStatus)));
const developmentState = (value = {}) => ({
  version: 0,
  paused: false,
  reason: '',
  notes: '',
  reviewDate: '',
  pausedAt: '',
  updatedAt: '',
  resumeNotes: '',
  audit: [],
  ...value,
});

// This graph records real business activity. It does not fetch mail, send mail,
// turn acquisition scores into inquiries, or share the technical mailbox pilot.
export class CustomerBusiness {
  constructor({
    path = ':memory:',
    scope = '',
    customer = async () => null,
    product = async () => null,
    now = () => new Date(),
  } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.scope = String(scope);
    this.customer = customer;
    this.product = product;
    this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS customer_business_entities(
        scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,
        PRIMARY KEY(scope,kind,id));
      CREATE TABLE IF NOT EXISTS customer_business_requests(
        scope TEXT NOT NULL,kind TEXT NOT NULL,request_key TEXT NOT NULL,body_hash TEXT NOT NULL,entity_id TEXT NOT NULL,
        PRIMARY KEY(scope,kind,request_key));
      CREATE TABLE IF NOT EXISTS customer_business_contexts(
        scope TEXT NOT NULL,customer_id TEXT NOT NULL,data TEXT NOT NULL,
        PRIMARY KEY(scope,customer_id));`);
  }
  timestamp() {
    const now = this.now();
    const result = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(result.getTime())) throw fail(500, '业务记录时间不可用');
    return result.toISOString();
  }
  get(kind, id) {
    if (!Object.hasOwn(kinds, kind)) throw fail(400, '业务记录类型不正确');
    const row = this.db
      .prepare('SELECT data FROM customer_business_entities WHERE scope=? AND kind=? AND id=?')
      .get(this.scope, kind, id);
    return row ? JSON.parse(row.data) : null;
  }
  all(kind) {
    return this.db
      .prepare(
        'SELECT data FROM customer_business_entities WHERE scope=? AND kind=? ORDER BY rowid',
      )
      .all(this.scope, kind)
      .map((row) => JSON.parse(row.data));
  }
  context(customerId) {
    const row = this.db
      .prepare('SELECT data FROM customer_business_contexts WHERE scope=? AND customer_id=?')
      .get(this.scope, customerId);
    const context = row
      ? JSON.parse(row.data)
      : { customerId, fixedEmail: '', doNotContact: false, refusalMessageId: '', updatedAt: '' };
    return { ...context, development: developmentState(context.development) };
  }
  contexts() {
    return this.db
      .prepare('SELECT data FROM customer_business_contexts WHERE scope=? ORDER BY rowid')
      .all(this.scope)
      .map(({ data }) => {
        const context = JSON.parse(data);
        return { ...context, development: developmentState(context.development) };
      });
  }
  development(customerId) {
    return this.context(customerId).development;
  }
  developmentView(customerId) {
    const context = this.context(customerId);
    const messages = this.all('messages')
      .filter((message) => message.customerId === customerId && actualEmail(message))
      .sort(
        (left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id),
      );
    const tasks = this.all('tasks').filter(
      (task) =>
        task.customerId === customerId &&
        task.channel === 'email' &&
        ['pending', 'paused'].includes(task.status),
    );
    const reviewToken = hash({
      messages: messages.map(({ id, version, updatedAt }) => ({ id, version, updatedAt })),
      tasks: tasks.map(({ id, version, updatedAt }) => ({ id, version, updatedAt })),
      fixedEmail: context.fixedEmail,
      doNotContact: context.doNotContact,
    });
    return {
      customerId,
      development: context.development,
      reviewToken,
      messages: messages.slice(0, 10),
      tasks,
      doNotContact: context.doNotContact,
      fixedEmail: context.fixedEmail,
    };
  }
  putContext(context) {
    const current = this.context(context.customerId);
    this.db
      .prepare(
        'INSERT INTO customer_business_contexts VALUES(?,?,?) ON CONFLICT(scope,customer_id) DO UPDATE SET data=excluded.data',
      )
      .run(this.scope, context.customerId, JSON.stringify({ ...current, ...context }));
  }
  async actDevelopment(customerId, value = {}, verifiedCustomer) {
    text(customerId, '客户编号', 180, true);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw fail(400, '开发操作格式不正确');
    const action = choice(value.action, ['pause', 'review', 'resume'], undefined, '开发操作');
    const reason =
      action === 'pause'
        ? choice(value.reason, ['客户要求稍后联系', '我方暂缓', '其他'], undefined, '暂缓原因')
        : '';
    const notes = action === 'pause' ? text(value.notes, '暂缓说明', 2000, reason === '其他') : '';
    const resumeNotes =
      action === 'resume' ? text(value.resumeNotes, '新的发送安排', 2000, true) : '';
    if (action === 'resume' && value.reviewed !== true)
      throw fail(400, '请先核对最新沟通和下一步发送安排');
    if (action === 'resume') text(value.reviewToken, '沟通核对版本', 64, true);
    let reviewDate = '';
    if (action !== 'resume') {
      if (action === 'review' && value.reviewDate === undefined)
        throw fail(400, '请填写复查日期，或明确清空日期以继续暂缓');
      reviewDate = text(value.reviewDate, '复查日期', 10);
      if (reviewDate) {
        const parsed = Date.parse(reviewDate + 'T00:00:00Z');
        if (
          !/^\d{4}-\d{2}-\d{2}$/u.test(reviewDate) ||
          !Number.isFinite(parsed) ||
          new Date(parsed).toISOString().slice(0, 10) !== reviewDate
        )
          throw fail(400, '复查日期必须是有效日期');
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
          new Date(this.timestamp()),
        );
        if (reviewDate < today) throw fail(400, '复查日期不能早于北京时间今天');
      }
    }
    const customer = verifiedCustomer || (await this.actualCustomer(customerId));
    if (customer.record_id !== customerId) throw fail(404, '客户不存在，请先核对企业档案');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const context = this.context(customerId);
      const prior = context.development;
      if (!Number.isInteger(value.expectedVersion) || value.expectedVersion !== prior.version)
        throw fail(409, '客户开发控制已更新，请刷新后再操作');
      if (action === 'pause' ? prior.paused : !prior.paused)
        throw fail(409, action === 'pause' ? '客户已经暂缓开发' : '客户当前未暂缓开发');
      if (action === 'resume' && value.reviewToken !== this.developmentView(customerId).reviewToken)
        throw fail(409, '客户沟通或任务已更新，请重新核对最新情况后恢复');
      const at = this.timestamp();
      const development = {
        ...prior,
        version: prior.version + 1,
        paused: action !== 'resume',
        reason: action === 'pause' ? reason : prior.reason,
        notes: action === 'pause' ? notes : prior.notes,
        reviewDate,
        pausedAt: action === 'pause' ? at : prior.pausedAt,
        updatedAt: at,
        resumeNotes: action === 'resume' ? resumeNotes : '',
      };
      development.audit = [
        ...prior.audit,
        {
          action,
          at,
          actor: '人工操作',
          reason: development.reason,
          notes: development.notes,
          reviewDate,
          ...(action === 'resume' ? { resumeNotes } : {}),
        },
      ];
      this.putContext({ ...context, development, updatedAt: at });
      if (action === 'pause') {
        for (const task of this.all('tasks').filter(
          (row) =>
            row.customerId === customerId &&
            row.channel === 'email' &&
            row.executionMode === 'automatic' &&
            row.status === 'pending' &&
            communicationKinds.has(row.kind),
        ))
          this.put('tasks', {
            ...task,
            status: 'paused',
            version: task.version + 1,
            updatedAt: at,
            audit: [
              ...task.audit,
              { action: 'customer_development_pause', at, reasons: ['客户已暂缓自动邮件开发'] },
            ],
          });
      }
      this.db.exec('COMMIT');
      return development;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  put(kind, record) {
    this.db
      .prepare(
        'INSERT INTO customer_business_entities VALUES(?,?,?,?) ON CONFLICT(scope,kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(this.scope, kind, record.id, JSON.stringify(record));
  }
  required(kind, id, name) {
    const record = this.get(kind, text(id, name, 180, true));
    if (!record) throw fail(404, name + '不存在或属于其他客户表');
    return record;
  }
  async actualCustomer(id) {
    const result = await this.customer(id);
    if (!result || result.record_id !== id) throw fail(404, '客户不存在，请先在 T2 核对企业档案');
    return result;
  }
  sameCustomer(record, customerId, name) {
    if (record.customerId !== customerId) throw fail(409, name + '属于其他客户，不能关联');
  }
  sameConversation(record, conversationId, name) {
    if (record.conversationId !== conversationId) throw fail(409, name + '属于其他会话，不能关联');
  }
  async products(productIds) {
    const versions = {};
    let ready = productIds.length > 0;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
      new Date(this.timestamp()),
    );
    for (const id of productIds) {
      const item = await this.product(id);
      if (!item || item.id !== id || !Number.isInteger(item.version))
        throw fail(404, '关联产品不存在，请先在 T5 核对资料');
      versions[id] = item.version;
      if (item.status !== 'approved' || (item.effectiveDate && item.effectiveDate > today))
        ready = false;
    }
    return {
      productVersions: versions,
      productReadiness: !productIds.length ? 'unlinked' : ready ? 'ready' : 'pending',
    };
  }
  view({ customerId, productId } = {}) {
    let conversations = this.all('conversations');
    let messages = this.all('messages');
    let demands = this.all('demands');
    let tasks = this.all('tasks');
    if (customerId) {
      conversations = conversations.filter((record) => record.customerId === customerId);
      messages = messages.filter((record) => record.customerId === customerId);
      demands = demands.filter((record) => record.customerId === customerId);
      tasks = tasks.filter((record) => record.customerId === customerId);
    }
    if (productId) {
      demands = demands.filter((record) => record.productIds.includes(productId));
      const demandIds = demands.map((record) => record.id);
      tasks = tasks.filter(
        (record) =>
          record.productIds.includes(productId) || overlapping(record.demandIds, demandIds),
      );
      const conversationIds = new Set(
        [...demands, ...tasks].map((record) => record.conversationId).filter(Boolean),
      );
      conversations = conversations.filter((record) => conversationIds.has(record.id));
      messages = messages.filter((record) => conversationIds.has(record.conversationId));
    }
    const customerIds = new Set(
      [...conversations, ...messages, ...demands, ...tasks].map((record) => record.customerId),
    );
    const contexts = this.contexts();
    if (!productId)
      for (const context of contexts)
        if (!customerId || context.customerId === customerId) customerIds.add(context.customerId);
    if (customerId) customerIds.add(customerId);
    const contextMap = new Map(contexts.map((context) => [context.customerId, context]));
    return {
      conversations,
      messages,
      demands,
      tasks,
      customerContexts: [...customerIds].map((id) => contextMap.get(id) || this.context(id)),
    };
  }
  async save(kind, value, options, normalize, after) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw fail(400, '业务记录格式不正确');
    const prior = value.id ? this.required(kind, value.id, '业务记录') : null;
    const { expectedVersion, idempotencyKey } = options || {};
    if (
      idempotencyKey !== undefined &&
      (prior || typeof idempotencyKey !== 'string' || !/^[\w-]{8,100}$/u.test(idempotencyKey))
    )
      throw fail(400, '新增业务记录需要有效的操作编号');
    const bodyHash = requestHash(value);
    if (idempotencyKey) {
      const request = this.db
        .prepare(
          'SELECT * FROM customer_business_requests WHERE scope=? AND kind=? AND request_key=?',
        )
        .get(this.scope, kind, idempotencyKey);
      if (request) {
        if (request.body_hash !== bodyHash) throw fail(409, '同一操作编号不能提交不同业务内容');
        return this.required(kind, request.entity_id, '原操作记录');
      }
    }
    const normalized = await normalize.call(this, value, prior);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (idempotencyKey) {
        const request = this.db
          .prepare(
            'SELECT * FROM customer_business_requests WHERE scope=? AND kind=? AND request_key=?',
          )
          .get(this.scope, kind, idempotencyKey);
        if (request) {
          if (request.body_hash !== bodyHash) throw fail(409, '同一操作编号不能提交不同业务内容');
          const existing = this.required(kind, request.entity_id, '原操作记录');
          this.db.exec('COMMIT');
          return existing;
        }
      }
      const current = prior ? this.required(kind, prior.id, '业务记录') : null;
      const expected = expectedVersion ?? value.version;
      if (current && (!Number.isInteger(expected) || current.version !== expected))
        throw fail(409, '业务记录已更新，请刷新后再操作');
      if (!current && expected !== undefined && expected !== 0)
        throw fail(409, '新记录不能指定已有版本');
      let record;
      if (kind === 'messages' && normalized.externalId && !current) {
        const duplicates = this.all('messages').filter(
          (message) =>
            message.externalId === normalized.externalId &&
            message.channel === normalized.channel &&
            message.account === normalized.account,
        );
        if (duplicates.length > 1) throw fail(409, '存在重复外部消息编号，请先核对');
        if (duplicates[0]) {
          if (!this.sameOriginalMessage(duplicates[0], normalized))
            throw fail(409, '同一外部消息编号不能记录不同的原文或归属');
          record = duplicates[0];
        }
      }
      if (!record) {
        const now = this.timestamp();
        record = {
          ...normalized,
          id: current?.id || kinds[kind] + randomUUID().replaceAll('-', ''),
          version: (current?.version || 0) + 1,
          createdAt: current?.createdAt || now,
          updatedAt: now,
        };
        this.put(kind, record);
        after?.call(this, record, current);
        record = this.get(kind, record.id);
      }
      if (idempotencyKey)
        this.db
          .prepare('INSERT INTO customer_business_requests VALUES(?,?,?,?,?)')
          .run(this.scope, kind, idempotencyKey, bodyHash, record.id);
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async normalizeConversation(value, prior) {
    const customerId = text(value.customerId, '客户编号', 180, true);
    await this.actualCustomer(customerId);
    if (prior && prior.customerId !== customerId) throw fail(409, '会话不能更换所属企业');
    const channel = choice(value.channel, channels, 'email', '沟通渠道');
    if (
      prior &&
      prior.channel !== channel &&
      this.all('messages').some((message) => message.conversationId === prior.id)
    )
      throw fail(409, '已有消息的会话不能更换渠道');
    const outward = account(value.account, channel);
    const fixed = this.context(customerId).fixedEmail;
    if (channel === 'email' && fixed && outward && fixed !== outward)
      throw fail(409, '客户已经绑定固定邮箱，请沿用 ' + fixed);
    if (
      prior &&
      prior.account !== outward &&
      this.all('messages').some(
        (message) => message.conversationId === prior.id && actualEmail(message),
      )
    )
      throw fail(409, '已开始邮件沟通的会话不能更换对外邮箱');
    return {
      customerId,
      title: text(value.title, '会话主题', 240, true),
      channel,
      account: outward,
      participant: text(value.participant, '客户联系入口', 500),
      ownership: choice(value.ownership, ownerships, 'auto', '接待归属'),
      owner: text(value.owner, '负责人', 120),
      status: choice(value.status, ['active', 'closed'], 'active', '会话状态'),
      audit: prior?.audit || [],
    };
  }
  saveConversation(value, options = {}) {
    return this.save(
      'conversations',
      value,
      options,
      this.normalizeConversation,
      function (record) {
        const context = this.context(record.customerId);
        if (
          record.channel === 'email' &&
          context.fixedEmail &&
          record.account &&
          record.account !== context.fixedEmail
        )
          throw fail(409, '客户已经绑定固定邮箱，请沿用 ' + context.fixedEmail);
        if (!context.updatedAt) this.putContext({ ...context, updatedAt: record.updatedAt });
        this.pauseBlockedTasks(record.customerId);
      },
    );
  }
  sameOriginalMessage(left, right) {
    return [
      'customerId',
      'conversationId',
      'channel',
      'direction',
      'subject',
      'body',
      'from',
      'to',
      'account',
      'occurredAt',
      'deliveryStatus',
      'classification',
      'externalId',
      'attachments',
      'actualConfirmed',
      'origin',
    ].every((key) => canonical(left[key]) === canonical(right[key]));
  }
  async normalizeMessage(value, prior) {
    const customerId = text(value.customerId, '客户编号', 180, true);
    await this.actualCustomer(customerId);
    const conversationId = text(value.conversationId, '会话编号', 180, true);
    const conversation = this.required('conversations', conversationId, '会话');
    this.sameCustomer(conversation, customerId, '会话');
    const channel = choice(value.channel, channels, conversation.channel, '沟通渠道');
    const direction = choice(
      value.direction,
      ['inbound', 'outbound', 'note'],
      undefined,
      '消息方向',
    );
    const deliveryStatus = choice(
      value.deliveryStatus,
      ['received', 'sent', 'accepted', 'failed', 'unknown', 'recorded'],
      undefined,
      '消息实际状态',
    );
    if (
      (direction === 'inbound' && deliveryStatus !== 'received') ||
      (direction === 'outbound' &&
        !['sent', 'accepted', 'failed', 'unknown'].includes(deliveryStatus)) ||
      (direction === 'note' && deliveryStatus !== 'recorded')
    )
      throw fail(400, '消息方向与实际收发状态不一致，草稿不能记为已发送');
    if (channel !== conversation.channel && direction !== 'note')
      throw fail(409, '消息渠道与所属会话不一致');
    if (value.actualConfirmed !== true || (value.origin !== undefined && value.origin !== 'manual'))
      throw fail(400, '请确认登记的是真实沟通；本入口不接入邮箱试点或自动发信');
    const outward = account(
      value.account ?? conversation.account,
      channel,
      channel === 'email' && direction !== 'note',
    );
    const fixed = this.context(customerId).fixedEmail;
    if (channel === 'email' && fixed && outward && fixed !== outward)
      throw fail(409, '客户已经绑定固定邮箱，请沿用 ' + fixed);
    if (
      channel === 'email' &&
      direction !== 'note' &&
      conversation.account &&
      outward !== conversation.account
    )
      throw fail(409, '消息对外邮箱与会话账号不一致');
    const from = text(value.from, '发件方', 500, direction !== 'note');
    const to = text(value.to, '收件方', 500, direction !== 'note');
    if (channel === 'email' && direction !== 'note') {
      const side = direction === 'inbound' ? to : from;
      const addresses = side.match(/[^\s<>@,;]+@[^\s<>@,;]+/gu) || [];
      if (!addresses.map((item) => item.toLowerCase()).includes(outward))
        throw fail(400, '真实邮件的收发方必须包含所填对外邮箱');
    }
    const demandIds = ids(value.demandIds, '关联需求');
    for (const id of demandIds) {
      const demand = this.required('demands', id, '需求');
      this.sameCustomer(demand, customerId, '需求');
      this.sameConversation(demand, conversationId, '需求');
    }
    const classification = choice(
      value.classification,
      ['normal', 'auto_reply', 'unsubscribe', 'hard_bounce', 'complaint'],
      'normal',
      '消息分类',
    );
    if (
      direction === 'outbound' &&
      ['unsubscribe', 'hard_bounce', 'complaint'].includes(classification)
    )
      throw fail(400, '客户拒绝、退信或投诉必须登记为实际收到的消息或确认记录');
    if (
      value.attachments !== undefined &&
      (!Array.isArray(value.attachments) || value.attachments.length > 10)
    )
      throw fail(400, '附件链接格式或数量不正确');
    const attachments = [
      ...new Set(
        (value.attachments || []).map((item) => safeAttachment(text(item, '附件链接', 2000, true))),
      ),
    ];
    const record = {
      customerId,
      conversationId,
      channel,
      direction,
      subject: text(value.subject, '消息主题', 500),
      body: text(value.body, '沟通原文', 20000, true),
      from,
      to,
      account: outward,
      occurredAt: date(value.occurredAt, '实际沟通时间'),
      deliveryStatus,
      classification,
      externalId: text(value.externalId, '外部消息编号', 500),
      attachments,
      demandIds,
      actualConfirmed: true,
      origin: 'manual',
      notes: text(value.notes, '沟通备注', 2000),
    };
    if (prior && !this.sameOriginalMessage(prior, record))
      throw fail(409, '沟通原文及实际收发事实不可覆盖，只能补充需求关联和备注');
    if (prior)
      for (const demand of this.all('demands').filter(
        (item) => item.sourceMessageId === prior.id,
      )) {
        if (!record.demandIds.includes(demand.id))
          throw fail(409, '不能移除作为需求原始依据的消息关联');
      }
    return record;
  }
  saveMessage(value, options = {}) {
    return this.save('messages', value, options, this.normalizeMessage, function (record, prior) {
      if (!prior && actualEmail(record)) {
        const context = this.context(record.customerId);
        if (context.fixedEmail && context.fixedEmail !== record.account)
          throw fail(409, '客户已有其他固定邮箱');
        this.putContext({ ...context, fixedEmail: record.account, updatedAt: record.updatedAt });
        const conversation = this.required('conversations', record.conversationId, '会话');
        if (!conversation.account)
          this.put('conversations', {
            ...conversation,
            account: record.account,
            version: conversation.version + 1,
            updatedAt: record.updatedAt,
          });
      }
      if (!prior) this.applyIncoming(record);
    });
  }
  async normalizeDemand(value, prior) {
    const customerId = text(value.customerId, '客户编号', 180, true);
    await this.actualCustomer(customerId);
    const conversationId = text(value.conversationId, '会话编号', 180, true);
    const conversation = this.required('conversations', conversationId, '会话');
    this.sameCustomer(conversation, customerId, '会话');
    const sourceMessageId = text(value.sourceMessageId, '需求来源消息', 180, true);
    const source = this.required('messages', sourceMessageId, '来源消息');
    this.sameCustomer(source, customerId, '来源消息');
    this.sameConversation(source, conversationId, '来源消息');
    if (
      prior &&
      ['customerId', 'conversationId', 'sourceMessageId'].some(
        (key) => prior[key] !== { customerId, conversationId, sourceMessageId }[key],
      )
    )
      throw fail(409, '需求不能更换企业、会话或原始依据');
    if (
      !source.actualConfirmed ||
      !(
        (source.direction === 'inbound' && source.deliveryStatus === 'received') ||
        (source.direction === 'note' &&
          source.channel === 'phone' &&
          source.deliveryStatus === 'recorded')
      ) ||
      ['auto_reply', 'unsubscribe', 'hard_bounce'].includes(source.classification)
    )
      throw fail(409, '需求必须依据客户实际来信或已确认的通话记录，不能由潜客评分或已发邮件生成');
    const evidenceQuote = text(value.evidenceQuote, '需求原文引文', 5000, true);
    if (!source.body.includes(evidenceQuote))
      throw fail(400, '需求引文必须逐字出现在来源消息原文中');
    const productIds = ids(value.productIds, '产品资料');
    return {
      customerId,
      conversationId,
      sourceMessageId,
      title: text(value.title, '需求名称', 240, true),
      category: choice(
        value.category,
        ['ventilation', 'shutters', 'indoor', 'outdoor', 'other'],
        'other',
        '品类',
      ),
      direction: choice(
        value.direction,
        ['finished', 'materials', 'samples'],
        undefined,
        '供货方向',
      ),
      productText: text(value.productText, '客户所需产品', 1000),
      productIds,
      ...(await this.products(productIds)),
      specifications: text(value.specifications, '客户规格要求', 6000),
      quantity: text(value.quantity, '客户所需数量', 200),
      unit: text(value.unit, '数量单位', 100),
      stage: choice(
        value.stage,
        ['new', 'clarifying', 'quoting', 'sampling', 'negotiating', 'won', 'lost', 'closed'],
        'new',
        '需求阶段',
      ),
      owner: text(value.owner, '负责人', 120),
      ownership: choice(value.ownership, ownerships, 'auto', '需求接待归属'),
      evidenceQuote,
    };
  }
  saveDemand(value, options = {}) {
    return this.save('demands', value, options, this.normalizeDemand, function (record) {
      const source = this.required('messages', record.sourceMessageId, '来源消息');
      if (!source.demandIds.includes(record.id))
        this.put('messages', {
          ...source,
          demandIds: [...source.demandIds, record.id],
          version: source.version + 1,
          updatedAt: record.updatedAt,
        });
      this.pauseBlockedTasks(record.customerId);
    });
  }
  async normalizeTask(value, prior) {
    const customerId = text(value.customerId, '客户编号', 180, true);
    await this.actualCustomer(customerId);
    if (prior && prior.customerId !== customerId) throw fail(409, '任务不能更换所属企业');
    const conversationId = text(value.conversationId, '会话编号', 180);
    if (prior?.conversationId && prior.conversationId !== conversationId)
      throw fail(409, '已有会话的任务不能转移到其他会话');
    const conversation = conversationId
      ? this.required('conversations', conversationId, '会话')
      : null;
    if (conversation) this.sameCustomer(conversation, customerId, '会话');
    const kind = choice(
      value.kind,
      ['first_contact', 'clarify_specs', 'quote_followup', 'sample', 'manual_review', 'other'],
      'other',
      '任务类型',
    );
    if (communicationKinds.has(kind) && kind !== 'first_contact' && !conversation)
      throw fail(400, '后续沟通任务需要关联会话');
    const demandIds = ids(value.demandIds, '关联需求');
    const linkedDemands = demandIds.map((id) => this.required('demands', id, '需求'));
    for (const demand of linkedDemands) {
      this.sameCustomer(demand, customerId, '需求');
      if (!conversationId || demand.conversationId !== conversationId)
        throw fail(409, '任务需求必须属于所选会话');
    }
    const messageIds = ids(value.messageIds, '关联消息');
    for (const id of messageIds) {
      const message = this.required('messages', id, '沟通记录');
      this.sameCustomer(message, customerId, '沟通记录');
      if (!conversationId || message.conversationId !== conversationId)
        throw fail(409, '任务消息必须属于所选会话');
    }
    let basisMessageId = text(value.basisMessageId, '跟进依据消息', 180);
    if (!basisMessageId && conversationId && !prior)
      basisMessageId =
        this.all('messages')
          .filter((message) => message.conversationId === conversationId)
          .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
          .at(-1)?.id || '';
    if (basisMessageId) {
      const message = this.required('messages', basisMessageId, '跟进依据消息');
      this.sameCustomer(message, customerId, '跟进依据消息');
      if (!conversationId || message.conversationId !== conversationId)
        throw fail(409, '跟进依据必须属于所选会话');
    }
    const status = choice(
      value.status,
      ['pending', 'paused', 'completed', 'cancelled'],
      prior?.status || 'pending',
      '任务状态',
    );
    if ((!prior && !['pending', 'paused'].includes(status)) || (prior && status !== prior.status))
      throw fail(409, '请通过任务完成、暂停、恢复或取消操作更改状态');
    if (prior && ['completed', 'cancelled'].includes(prior.status))
      throw fail(409, '已完成或取消的任务保留执行记录，不能覆盖');
    const channel = choice(value.channel, channels, conversation?.channel || 'email', '任务渠道');
    if (conversation && communicationKinds.has(kind) && conversation.channel !== channel)
      throw fail(409, '沟通任务渠道与会话不一致');
    const productIds = [
      ...new Set([
        ...ids(value.productIds, '关联产品'),
        ...linkedDemands.flatMap((demand) => demand.productIds),
      ]),
    ];
    const products = await this.products(productIds);
    return {
      customerId,
      conversationId,
      demandIds,
      messageIds,
      productIds,
      productVersions: products.productVersions,
      title: text(value.title, '下一步行动', 240, true),
      kind,
      executionMode: choice(value.executionMode, ['manual', 'automatic'], 'manual', '执行方式'),
      channel,
      dueAt: date(value.dueAt, '执行时间'),
      status,
      owner: text(value.owner, '负责人', 120),
      notes: text(value.notes, '任务备注', 3000),
      basisMessageId,
      audit: prior?.audit || [],
      completedAt: prior?.completedAt || '',
      resultMessageId: prior?.resultMessageId || '',
    };
  }
  saveTask(value, options = {}) {
    return this.save('tasks', value, options, this.normalizeTask, function (record) {
      this.pauseBlockedTasks(record.customerId);
    });
  }
  taskIncludes(task, message) {
    if (message.customerId !== task.customerId) return false;
    if (message.classification === 'unsubscribe' && !message.demandIds.length) return true;
    if (message.classification === 'hard_bounce') {
      if (task.channel !== message.channel) return false;
      const source = this.get('conversations', message.conversationId);
      const target = task.conversationId ? this.get('conversations', task.conversationId) : null;
      return (
        !source?.participant ||
        !target?.participant ||
        source.participant.toLowerCase() === target.participant.toLowerCase()
      );
    }
    if (message.classification === 'complaint')
      return task.conversationId === message.conversationId;
    if (message.demandIds.length)
      return task.demandIds.length
        ? overlapping(task.demandIds, message.demandIds)
        : task.conversationId === message.conversationId;
    return task.conversationId === message.conversationId;
  }
  afterBasis(message, task) {
    if (message.id === task.basisMessageId) return false;
    const basis = task.basisMessageId ? this.get('messages', task.basisMessageId) : null;
    const baseline = basis?.occurredAt || task.createdAt;
    if (Date.parse(message.occurredAt) !== Date.parse(baseline))
      return Date.parse(message.occurredAt) > Date.parse(baseline);
    if (!basis) return Date.parse(message.createdAt) >= Date.parse(task.createdAt);
    const order = this.all('messages').map((item) => item.id);
    return order.indexOf(message.id) > order.indexOf(basis.id);
  }
  localReasons(task) {
    const reasons = [];
    if (!communicationKinds.has(task.kind)) return reasons;
    const context = this.context(task.customerId);
    if (
      task.channel === 'email' &&
      task.executionMode === 'automatic' &&
      context.development.paused
    )
      reasons.push('客户已暂缓自动邮件开发，请先恢复客户开发并重新核对任务');
    if (context.doNotContact) reasons.push('客户已明确拒绝联系，所有渠道的沟通任务暂停');
    const conversation = task.conversationId
      ? this.get('conversations', task.conversationId)
      : null;
    if (conversation?.status === 'closed') reasons.push('会话已经关闭');
    if (task.executionMode === 'automatic' && conversation?.ownership === 'human')
      reasons.push('会话由人工接管');
    if (
      conversation?.channel === 'email' &&
      context.fixedEmail &&
      conversation.account !== context.fixedEmail
    )
      reasons.push('会话账号与客户固定邮箱不一致');
    for (const id of task.demandIds) {
      const demand = this.get('demands', id);
      if (
        !demand ||
        demand.customerId !== task.customerId ||
        demand.conversationId !== task.conversationId
      )
        reasons.push('关联需求归属待核对');
      else {
        if (task.executionMode === 'automatic' && demand.ownership === 'human')
          reasons.push('关联需求由人工接管：' + demand.title);
        if (terminalStages.has(demand.stage)) reasons.push('关联需求已经结束：' + demand.title);
      }
    }
    const messages = this.all('messages').filter(
      (message) => message.customerId === task.customerId,
    );
    for (const message of messages) {
      if (!this.taskIncludes(task, message)) continue;
      if (message.classification === 'unsubscribe')
        reasons.push(message.demandIds.length ? '关联需求已经拒绝继续联系' : '客户已明确拒绝联系');
      else if (message.classification === 'hard_bounce')
        reasons.push('当前渠道及客户联系入口已有硬退信记录');
      else if (message.classification === 'complaint') reasons.push('会话存在投诉，需要人工处理');
      else if (isActualReply(message) && this.afterBasis(message, task))
        reasons.push('客户已回复，请先处理新消息后调整任务');
    }
    const outbound = messages
      .filter(
        (message) =>
          message.direction === 'outbound' &&
          message.channel === task.channel &&
          (!task.conversationId || message.conversationId === task.conversationId),
      )
      .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
      .at(-1);
    if (outbound?.deliveryStatus === 'unknown')
      reasons.push('上一条发出消息的实际结果尚未确认，不能重复联系');
    if (
      task.kind === 'first_contact' &&
      messages.some(
        (message) =>
          actualEmail(message) ||
          (message.direction === 'inbound' && message.deliveryStatus === 'received'),
      )
    )
      reasons.push('客户已有真实沟通，请改为对应的后续行动');
    return [...new Set(reasons)];
  }
  pauseBlockedTasks(customerId) {
    for (const task of this.all('tasks').filter(
      (record) =>
        record.customerId === customerId &&
        record.status === 'pending' &&
        communicationKinds.has(record.kind),
    )) {
      const reasons = this.localReasons(task);
      if (reasons.length) {
        const now = this.timestamp();
        this.put('tasks', {
          ...task,
          status: 'paused',
          version: task.version + 1,
          updatedAt: now,
          audit: [...task.audit, { action: 'auto_pause', at: now, reasons }],
        });
      }
    }
  }
  applyIncoming(message) {
    if (message.classification === 'unsubscribe' && !message.demandIds.length)
      this.putContext({
        ...this.context(message.customerId),
        doNotContact: true,
        refusalMessageId: message.id,
        updatedAt: message.updatedAt,
      });
    if (message.classification === 'complaint') {
      const conversation = this.required('conversations', message.conversationId, '会话');
      this.put('conversations', {
        ...conversation,
        ownership: 'human',
        version: conversation.version + 1,
        updatedAt: message.updatedAt,
        audit: [
          ...conversation.audit,
          { action: 'complaint_handoff', at: message.updatedAt, messageId: message.id },
        ],
      });
    }
    if (
      isActualReply(message) ||
      ['unsubscribe', 'hard_bounce', 'complaint'].includes(message.classification)
    )
      this.pauseBlockedTasks(message.customerId);
  }
  async checkTask(task, { resuming = false } = {}) {
    const reasons = this.localReasons(task);
    if (task.status !== 'pending' && !(resuming && task.status === 'paused'))
      reasons.unshift('任务当前状态为 ' + task.status);
    let customer;
    try {
      customer = await this.actualCustomer(task.customerId);
    } catch {
      reasons.push('T2 企业档案尚未核对成功');
    }
    const development = customer?.fields?.['开发状态'];
    const state =
      typeof development === 'string'
        ? development
        : Array.isArray(development)
          ? development.map((item) => item.text || '').join('')
          : '';
    if (
      communicationKinds.has(task.kind) &&
      /暂不开发|暂缓开发|暂停开发|停止开发|拒绝联系|已退订/u.test(state)
    )
      reasons.push('T2 已由人工标记暂停或不开发');
    if (communicationKinds.has(task.kind)) {
      const versions = [
        task.productVersions,
        ...task.demandIds.map((id) => this.get('demands', id)?.productVersions || {}),
      ];
      const productIds = [
        ...new Set([...task.productIds, ...versions.flatMap((snapshot) => Object.keys(snapshot))]),
      ];
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
        new Date(this.timestamp()),
      );
      for (const id of productIds) {
        let product;
        try {
          product = await this.product(id);
        } catch {
          /* Unavailable product facts remain a reason to hold the task. */
        }
        if (!product || product.id !== id) reasons.push('关联 T5 产品资料已不存在或读取失败');
        else {
          if (product.status !== 'approved')
            reasons.push('关联 T5 产品资料尚未审核或已归档：' + product.name);
          if (product.effectiveDate && product.effectiveDate > today)
            reasons.push('关联 T5 产品资料尚未生效：' + product.name);
          if (
            versions.some(
              (snapshot) => snapshot[id] !== undefined && snapshot[id] !== product.version,
            )
          )
            reasons.push('关联 T5 产品资料版本已变化，请重新核对需求和任务：' + product.name);
        }
      }
    }
    return {
      ready: reasons.length === 0,
      reasons: [...new Set(reasons)],
      message: reasons.length
        ? '任务需要核对后再推进；此入口不会自动发送消息'
        : '记录条件已核对；实际沟通仍由人工执行和登记',
      automaticSend: false,
    };
  }
  async preflightTask(id) {
    return this.checkTask(this.required('tasks', id, '跟进任务'));
  }
  async actTask(id, { action, expectedVersion, resultMessageId, notes } = {}) {
    const task = this.required('tasks', id, '跟进任务');
    await this.actualCustomer(task.customerId);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== task.version)
      throw fail(409, '任务已更新，请刷新后再操作');
    if (!['complete', 'pause', 'resume', 'cancel'].includes(action))
      throw fail(400, '任务操作不正确');
    if (['completed', 'cancelled'].includes(task.status)) throw fail(409, '任务已经完成或取消');
    const actionNotes = text(
      notes,
      '执行说明',
      2000,
      action === 'complete' && !communicationKinds.has(task.kind),
    );
    let result = null;
    if (action === 'complete' && communicationKinds.has(task.kind)) {
      result = this.required('messages', resultMessageId, '实际发出消息');
      this.sameCustomer(result, task.customerId, '实际发出消息');
      if (
        (task.conversationId && result.conversationId !== task.conversationId) ||
        result.channel !== task.channel ||
        result.direction !== 'outbound' ||
        result.deliveryStatus !== 'sent' ||
        !result.actualConfirmed ||
        Date.parse(result.occurredAt) < Date.parse(task.createdAt) ||
        !task.demandIds.every((demandId) => result.demandIds.includes(demandId))
      )
        throw fail(
          409,
          '完成沟通任务需要同一客户、会话及相关需求的实际已发送消息，不能用草稿、失败或结果未知消息证明',
        );
    }
    if (action === 'pause' && task.status !== 'pending') throw fail(409, '只有待执行任务可以暂停');
    if (action === 'resume') {
      if (task.status !== 'paused') throw fail(409, '只有暂停任务可以恢复');
      const check = await this.checkTask(task, { resuming: true });
      if (!check.ready) throw fail(409, check.reasons.join('；'));
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.required('tasks', id, '跟进任务');
      if (current.version !== expectedVersion) throw fail(409, '任务已更新，请刷新后再操作');
      if (action === 'resume') {
        const reasons = this.localReasons(current);
        if (reasons.length) throw fail(409, reasons.join('；'));
      }
      const now = this.timestamp();
      const record = {
        ...current,
        status: { complete: 'completed', pause: 'paused', resume: 'pending', cancel: 'cancelled' }[
          action
        ],
        conversationId: current.conversationId || result?.conversationId || '',
        version: current.version + 1,
        updatedAt: now,
        completedAt: action === 'complete' ? now : '',
        resultMessageId: result?.id || '',
        audit: [
          ...current.audit,
          {
            action,
            at: now,
            notes: actionNotes,
            ...(result ? { resultMessageId: result.id } : {}),
          },
        ],
      };
      this.put('tasks', record);
      this.db.exec('COMMIT');
      return record;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
