import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  selectOutreachCandidates,
  createOutreachGenerator,
  outreachProductScope,
  outreachMaterialVersion,
  eligibleOutreachFacts,
} from './outreach-content.mjs';
import { MailConversations } from './mail-conversations.mjs';
import { MailReplies } from './mail-replies.mjs';
import { renderMailboxSignature, signaturePlainTextHtml } from '../src/domain/mail-signature.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const list = (value) =>
  Array.isArray(value) ? [...new Set(value.map((v) => text(v)).filter(Boolean))].slice(0, 200) : [];
const iso = (now) => new Date(now()).toISOString();
const terminal = new Set(['accepted', 'failed', 'unknown', 'blocked', 'cancelled']);
const senderVersion = (m) =>
  hash([
    m.id,
    m.email,
    m.displayName,
    m.signature,
    ...(m.signatureDesign ? [m.signatureDesign] : []),
    [...(m.productIds || [])].sort(),
  ]);
const day = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(date));
function sendWindowError(w) {
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!w || !validTime.test(w.start) || !validTime.test(w.end) || w.start === w.end)
    return '发送时段须为有效且不同的起止时间';
  if (typeof w.timezone !== 'string' || !w.timezone.trim()) return '发送时区无效';
  try {
    new Intl.DateTimeFormat('en', { timeZone: w.timezone }).format();
  } catch {
    return '发送时区无效';
  }
  return '';
}
const safeError = (error) =>
  error?.status ? text(error.message, 350) : '处理失败，请核对连接后重试';

// Outbound work is persisted before SMTP. An interrupted SMTP transaction is
// uncertain, never a reason to automatically transmit the same letter again.
export class OutreachService {
  constructor({
    path = ':memory:',
    mailboxes,
    loadLeads = async () => [],
    products = () => [],
    getEnv = () => ({}),
    getScope = () => 'local',
    businessState = () => ({}),
    customers = () => [],
    recordAccepted,
    recordCommunication,
    generator,
    now = Date.now,
    tickMs = 2000,
  } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // SQLite's built-in lower only handles ASCII; preserve the former browser search semantics.
    this.db.function('outreach_lower', { deterministic: true }, (value) =>
      String(value ?? '').toLowerCase(),
    );
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS outreach_campaigns(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_deliveries(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outreach_delivery_campaign ON outreach_deliveries(campaign_id,state);
      CREATE TABLE IF NOT EXISTS outreach_reservations(identity TEXT PRIMARY KEY,delivery_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_meta(key TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_requests(key TEXT PRIMARY KEY,kind TEXT NOT NULL,result_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_suppression(identity TEXT PRIMARY KEY,reason TEXT NOT NULL);`);
    Object.assign(this, {
      mailboxes,
      loadLeads,
      products,
      getEnv,
      getScope,
      businessState,
      recordAccepted,
      generator,
      now,
      tickMs,
    });
    this.preparing = new Map();
    this.conversations = new MailConversations({
      db: this.db,
      mailboxes,
      deliveries: () => this.deliveries(),
      customers,
      recordCommunication,
      now,
    });
    this.replies = new MailReplies({
      db: this.db,
      mailboxes,
      conversations: this.conversations,
      recordCommunication,
      now,
    });
    this.preparationQueue = Promise.resolve();
    this.running = null;
    this.timer = null;
    this.closed = false;
    for (const d of this.deliveries().filter((d) => d.status === 'sending'))
      this.putDelivery({
        ...d,
        status: 'unknown',
        reason: '发送时服务中断，请核对原邮箱；系统不会自动重发',
      });
    for (const d of this.deliveries().filter((d) => d.status === 'draft' && !d.subject)) {
      this.putDelivery({ ...d, status: 'cancelled', reason: '草稿生成中断，可重新准备' });
      this.release(d.id);
    }
    for (const c of this.campaigns().filter((c) => c.status === 'preparing'))
      this.putCampaign({ ...c, status: 'draft', lastError: '草稿准备曾中断，可以重新准备' });
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  meta(key) {
    const row = this.db.prepare('SELECT data FROM outreach_meta WHERE key=?').get(key);
    return row ? JSON.parse(row.data) : null;
  }
  setMeta(key, value) {
    this.db
      .prepare(
        'INSERT INTO outreach_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data',
      )
      .run(key, JSON.stringify(value));
  }
  campaigns() {
    return this.db
      .prepare('SELECT data FROM outreach_campaigns ORDER BY rowid DESC')
      .all()
      .map((r) => this.withStats(JSON.parse(r.data)));
  }
  campaign(id) {
    const r = this.db.prepare('SELECT data FROM outreach_campaigns WHERE id=?').get(id);
    if (!r) throw fail(404, '触达计划不存在');
    return JSON.parse(r.data);
  }
  putCampaign(c) {
    const { stats, ...data } = c;
    this.db
      .prepare(
        'INSERT INTO outreach_campaigns VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(c.id, JSON.stringify(data));
    return this.withStats(data);
  }
  deliveries(campaignId) {
    return (
      campaignId
        ? this.db
            .prepare('SELECT data FROM outreach_deliveries WHERE campaign_id=? ORDER BY rowid')
            .all(campaignId)
        : this.db.prepare('SELECT data FROM outreach_deliveries ORDER BY rowid DESC').all()
    ).map((r) => JSON.parse(r.data));
  }
  listDeliveries({ page = 1, pageSize = 20, campaignId = 'all', status = 'all', q = '' } = {}) {
    const size = [10, 20, 50, 100].includes(Number(pageSize)) ? Number(pageSize) : 20;
    const requestedPage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
    const where = [],
      params = [];
    if (campaignId !== 'all') {
      where.push('campaign_id = ?');
      params.push(campaignId);
    }
    if (status !== 'all') {
      where.push('state = ?');
      params.push(status);
    }
    const query = String(q).trim();
    if (query) {
      const fields = ['companyName', 'to', 'from', 'subject'];
      where.push(
        `instr(outreach_lower(${fields.map((field) => `coalesce(json_extract(data, '$.${field}'), '')`).join(" || ' ' || ")}), ?) > 0`,
      );
      params.push(query.toLowerCase());
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = this.db
      .prepare(`SELECT count(*) AS total FROM outreach_deliveries${clause}`)
      .get(...params).total;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const currentPage = Math.min(requestedPage, totalPages);
    const items = this.db
      .prepare(`SELECT data FROM outreach_deliveries${clause} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, size, (currentPage - 1) * size)
      .map((row) => JSON.parse(row.data));
    return { items, total, page: currentPage, pageSize: size, totalPages };
  }
  delivery(id) {
    const row = this.db.prepare('SELECT data FROM outreach_deliveries WHERE id=?').get(id);
    if (!row) throw fail(404, '发送记录不存在');
    return JSON.parse(row.data);
  }
  putDelivery(d) {
    this.db
      .prepare(
        'INSERT INTO outreach_deliveries VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data',
      )
      .run(d.id, d.campaignId, d.status, JSON.stringify(d));
    return d;
  }
  withStats(c) {
    const stats = {
      draft: 0,
      queued: 0,
      accepted: 0,
      failed: 0,
      unknown: 0,
      blocked: 0,
      sending: 0,
    };
    for (const d of this.deliveries(c.id)) if (d.status in stats) stats[d.status]++;
    return { ...c, stats };
  }
  detail(id) {
    return { campaign: this.withStats(this.campaign(id)), deliveries: this.deliveries(id) };
  }
  generatorClient() {
    return this.generator || createOutreachGenerator({ env: this.getEnv() });
  }
  testFingerprint() {
    return hash(
      this.mailboxes
        .list()
        .filter((m) => m.configured)
        .map((m) => [m.id, m.email, m.displayName, m.signature, m.signatureDesign]),
    );
  }
  review() {
    const tests = this.campaigns().filter(
      (c) =>
        c.mode === 'internal_test' &&
        c.status === 'completed' &&
        c.testFingerprint === this.testFingerprint(),
    );
    const successful = tests.find(
      (c) => c.stats.accepted >= 2 && this.deliveries(c.id).every((d) => d.status === 'accepted'),
    );
    const reviewed = this.meta('production_review');
    return {
      internalTestPassed: !!successful,
      productionApproved:
        !!successful &&
        reviewed?.testId === successful.id &&
        reviewed?.fingerprint === this.testFingerprint() &&
        this.mailboxes
          .list()
          .filter((m) => m.configured && !m.paused && m.smtpStatus === 'connected')
          .every((m) => successful.mailboxIds.includes(m.id)),
      testId: successful?.id || null,
      testedMailboxIds: successful?.mailboxIds || [],
      internalReceiptVerified:
        !!successful && this.deliveries(successful.id).every((d) => !!d.receivedVerifiedAt),
      reviewedAt: reviewed?.at || null,
    };
  }
  async state() {
    const mailboxes = this.mailboxes.list();
    let generatorConfigured = false;
    try {
      generatorConfigured = !!this.generatorClient().configured;
    } catch {}
    return {
      mailboxes,
      campaigns: this.campaigns(),
      deliveries: this.deliveries().slice(0, 500),
      products: this.products(),
      readiness: { generatorConfigured },
      review: this.review(),
    };
  }
  saveCampaign(input, id) {
    const prior = id ? this.campaign(id) : null;
    if (['cancelled', 'completed'].includes(prior?.status))
      throw fail(409, '计划已结束，请新建触达计划');
    if (prior?.mode === 'internal_test') throw fail(400, '内部测试计划不能改为正式计划');
    if (prior?.status === 'active' || prior?.status === 'preparing' || this.preparing.has(id))
      throw fail(409, '请先暂停计划并等待正在处理的邮件完成');
    if (prior && input.revision !== prior.revision) throw fail(409, '计划已更新，请刷新后再保存');
    const targetCount = Number(input.targetCount ?? 150),
      intervalSeconds = Number(input.intervalSeconds ?? 180);
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 1000)
      throw fail(400, '目标数量应为1至1000');
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 86400)
      throw fail(400, '发送间隔至少5秒');
    const name = text(input.name);
    if (!name) throw fail(400, '请填写计划名称');
    const generationMode = input.generationMode ?? prior?.generationMode ?? 'professional';
    if (!['simple', 'professional'].includes(generationMode)) throw fail(400, '邮件生成方式无效');
    const claims = Array.isArray(input.outreachClaims)
      ? input.outreachClaims.map((v) => ({
          productId: text(v.productId),
          productVersion: Number(v.productVersion),
          text: text(v.text, 1200),
        }))
      : [];
    if (
      claims.some(
        (v) =>
          !v.productId || !Number.isInteger(v.productVersion) || v.productVersion < 1 || !v.text,
      )
    )
      throw fail(400, '请填写有效的产品版本与开发信产品介绍');
    const mailboxIds = list(input.mailboxIds);
    if (mailboxIds.some((v) => !this.mailboxes.get(v))) throw fail(400, '请选择存在的邮箱');
    const c = {
      id: prior?.id || randomUUID(),
      name,
      mode: 'production',
      generationMode,
      status: 'draft',
      revision: (prior?.revision || 0) + 1,
      approvedRevision: null,
      targetCount,
      intervalSeconds,
      filters: {
        markets: list(input.filters?.markets),
        grades: list(input.filters?.grades),
        products: list(input.filters?.products),
        categories: list(input.filters?.categories),
      },
      mailboxIds,
      includeExisting: input.includeExisting !== false,
      continuous: input.continuous !== false,
      customerIds: list(input.customerIds),
      outreachClaims: claims,
      createdAt: prior?.createdAt || iso(this.now),
      updatedAt: iso(this.now),
      scope: this.getScope(),
      baselineCustomerIds: prior?.baselineCustomerIds ?? null,
      lastError: '',
      sendWindow: input.sendWindow === undefined ? (prior?.sendWindow ?? null) : input.sendWindow,
    };
    c.productScopes = this.products()
      .filter(
        (product) =>
          (c.filters.products.length
            ? c.filters.products.includes(product.id)
            : mailboxIds.some((id) => this.mailboxes.get(id).productIds?.includes(product.id))) &&
          (!c.filters.categories.length || c.filters.categories.includes(product.category)),
      )
      .map(outreachProductScope);
    if (c.sendWindow !== null) {
      const error = sendWindowError(c.sendWindow);
      if (error) throw fail(400, error);
    }
    return this.transaction(() => {
      if (prior)
        for (const d of this.deliveries(id).filter((d) =>
          ['draft', 'queued', 'blocked'].includes(d.status),
        )) {
          this.putDelivery({ ...d, status: 'cancelled', reason: '计划已修改，原草稿失效' });
          this.release(d.id);
        }
      return this.putCampaign(c);
    });
  }
  identities(candidate) {
    return [
      `company:${candidate.customerId}`,
      candidate.companyDomain && `domain:${candidate.companyDomain.toLowerCase()}`,
      candidate.to && `email:${candidate.to.toLowerCase()}`,
    ].filter(Boolean);
  }
  reserve(d) {
    for (const key of this.identities(d.candidate))
      this.db.prepare('INSERT INTO outreach_reservations VALUES(?,?)').run(key, d.id);
  }
  release(id) {
    this.db.prepare('DELETE FROM outreach_reservations WHERE delivery_id=?').run(id);
  }
  contactState(ignoreDelivery) {
    const identities = new Set(
      this.db
        .prepare('SELECT identity FROM outreach_reservations WHERE delivery_id<>?')
        .all(ignoreDelivery || '')
        .map((r) => r.identity),
    );
    const blocked = new Set(
      this.db
        .prepare('SELECT identity FROM outreach_suppression')
        .all()
        .map((r) => r.identity),
    );
    const business = this.businessState();
    for (const m of business.messages || [])
      if (m.customerId && ['sent', 'received', 'accepted'].includes(m.deliveryStatus))
        identities.add('company:' + m.customerId);
    for (const c of business.customerContexts || [])
      if (c.fixedEmail || c.doNotContact) identities.add('company:' + c.customerId);
    for (const c of business.conversations || [])
      if (c.ownership === 'human' || c.status === 'active')
        identities.add('company:' + c.customerId);
    return { identities, blocked };
  }
  isReserved(candidate, ignoreDelivery) {
    const { identities, blocked } = this.contactState(ignoreDelivery);
    return this.identities(candidate).some((k) => identities.has(k) || blocked.has(k));
  }
  development(customerId) {
    return (
      this.businessState().customerContexts?.find((row) => row.customerId === customerId)
        ?.development || { version: 0, paused: false }
    );
  }
  developmentReason(delivery) {
    const current = this.development(delivery.customerId);
    if (current.paused) return '客户已暂缓开发，自动邮件暂停';
    return (current.version || 0) !== (delivery.developmentVersion || 0)
      ? '客户开发安排已更新，请重新准备并审核邮件'
      : '';
  }
  developmentReviewed(delivery) {
    return (
      !delivery.developmentVersion ||
      delivery.developmentReviewedVersion === delivery.developmentVersion
    );
  }
  materialReason(delivery, campaign = this.campaign(delivery.campaignId)) {
    if (delivery.mode !== 'production' || !delivery.candidate) return '';
    const product = this.products().find((row) => row.id === delivery.candidate.productId);
    const version = outreachMaterialVersion(product, campaign, new Date(this.now()));
    return !version ||
      product.version !== delivery.productVersion ||
      (delivery.materialVersion && version !== delivery.materialVersion)
      ? '产品资料已更新、过期或不再适用，待重新准备邮件'
      : '';
  }
  refreshProductMaterials() {
    if (this.closed) return;
    for (const delivery of this.deliveries().filter(
      (row) => row.mode === 'production' && ['draft', 'queued'].includes(row.status),
    )) {
      const reason = this.materialReason(delivery);
      if (!reason) continue;
      this.putDelivery({ ...delivery, status: 'blocked', reason, materialRefresh: true });
      this.release(delivery.id);
    }
    for (const campaign of this.campaigns().filter(
      (row) => row.mode === 'production' && ['active', 'ready'].includes(row.status),
    )) {
      if (this.preparing.has(campaign.id) || campaign.scope !== this.getScope()) continue;
      const canRefresh = this.deliveries(campaign.id).some(
        (delivery) =>
          delivery.status === 'blocked' &&
          delivery.materialRefresh &&
          (!delivery.materialRetryAt || Date.parse(delivery.materialRetryAt) <= this.now()) &&
          outreachMaterialVersion(
            this.products().find((product) => product.id === delivery.candidate?.productId),
            campaign,
            new Date(this.now()),
          ),
      );
      if (canRefresh) {
        try {
          this.prepare(campaign.id);
        } catch (error) {
          this.putCampaign({ ...campaign, lastError: safeError(error) });
        }
      }
    }
  }
  async candidates(c, ignoreDelivery) {
    const loaded = await this.loadLeads();
    const leads = Array.isArray(loaded) ? loaded : loaded.leads;
    if (!Array.isArray(leads)) throw fail(503, '客户库暂时不可读取');
    if (c.scope !== this.getScope()) throw fail(409, '客户数据来源已改变，请重新建立计划');
    const latest = this.campaign(c.id);
    if (latest.revision !== c.revision || (latest.status === 'paused' && c.status !== 'paused'))
      throw fail(409, '计划在读取客户时已暂停或改变');
    if (c.baselineCustomerIds === null) {
      c.baselineCustomerIds = latest.baselineCustomerIds || leads.map((l) => l.id);
      this.putCampaign({ ...latest, baselineCustomerIds: c.baselineCustomerIds });
    }
    const eligibleLeads = c.includeExisting
      ? leads
      : leads.filter((l) => !c.baselineCustomerIds.includes(l.id));
    const existing = ignoreDelivery ? this.delivery(ignoreDelivery) : null;
    const history = this.deliveries().filter((d) => d.id !== ignoreDelivery);
    const { identities, blocked: stopped } = this.contactState(ignoreDelivery);
    const identityValues = (keys) =>
      [...keys].map((key) => key.replace(/^(company|domain|email):/, ''));
    const mailboxes = this.mailboxes.list().map((m) => ({
      ...m,
      workload: history.filter(
        (d) =>
          d.mailboxId === m.id &&
          ((!existing && ['draft', 'queued'].includes(d.status)) ||
            (['accepted', 'sending', 'unknown', 'failed'].includes(d.status) &&
              day(d.sentAt || d.attemptedAt || d.createdAt) === day(this.now()))),
      ).length,
    }));
    const result = selectOutreachCandidates({
      leads: eligibleLeads,
      mailboxes,
      products: this.products(),
      // Once a draft is reviewed its sender stays fixed. Workload only allocates
      // new customers; it must not move a queued email between accounts.
      campaign: existing
        ? { ...c, customerIds: [existing.customerId], mailboxIds: [existing.mailboxId] }
        : {
            ...c,
            senderAssignments: this.deliveries(c.id)
              .filter((delivery) => delivery.status === 'blocked' && delivery.materialRefresh)
              .map((delivery) => ({
                customerId: delivery.customerId,
                productId: delivery.candidate?.productId,
                mailboxId: delivery.mailboxId,
              })),
          },
      suppressed: identityValues(stopped),
      contacted: identityValues(identities),
      now: new Date(this.now()),
    });
    const eligible = [],
      blocked = [...result.blocked];
    for (const candidate of result.eligible) {
      const development = this.development(candidate.customerId);
      if (development.paused)
        blocked.push({ ...candidate, reason: '客户已暂缓开发，自动邮件暂停' });
      else if (this.isReserved(candidate, ignoreDelivery))
        blocked.push({ ...candidate, reason: '已有发送安排、沟通记录或停止联系标记' });
      else eligible.push({ ...candidate, developmentVersion: development.version || 0 });
    }
    return { eligible, blocked };
  }
  prepare(id) {
    const c = this.campaign(id);
    if (['cancelled', 'completed'].includes(c.status))
      throw fail(409, '计划已结束，不能重新准备样稿');
    if (this.preparing.has(id)) return this.detail(id);
    if (c.mode !== 'production') throw fail(400, '测试计划使用固定测试内容');
    if (!c.mailboxIds.length) throw fail(400, '请先选择发件邮箱');
    if (!this.generatorClient().configured) throw fail(503, '请先在API连接中配置模型');
    const wasActive = c.status === 'active';
    this.putCampaign({ ...c, status: wasActive ? 'active' : 'preparing', lastError: '' });
    // Allocation and reservations span campaigns. A single preparation queue
    // prevents two concurrent plans from both claiming the last mailbox slot.
    const operation = this.preparationQueue
      .then(() => this.prepareDrafts(id, c.revision, wasActive))
      .catch((error) => {
        if (this.closed) return;
        const current = this.campaign(id);
        if (current.revision === c.revision)
          this.putCampaign({
            ...current,
            status: current.status === 'paused' ? 'paused' : wasActive ? 'paused' : 'draft',
            lastError: safeError(error),
          });
      })
      .finally(() => this.preparing.delete(id));
    this.preparationQueue = operation;
    this.preparing.set(id, operation);
    return this.detail(id);
  }
  async prepareDrafts(id, revision, wasActive) {
    const c = this.campaign(id);
    if (this.closed || c.revision !== revision || c.status === 'paused') return;
    for (const draft of this.deliveries().filter(
      (row) => row.mode === 'production' && ['draft', 'queued'].includes(row.status),
    )) {
      const reason = this.developmentReason(draft);
      if (reason) {
        this.putDelivery({ ...draft, status: 'blocked', reason });
        this.release(draft.id);
      }
    }
    const result = await this.candidates(c);
    const latest = this.campaign(id);
    if (
      this.closed ||
      latest.revision !== revision ||
      ['paused', 'cancelled'].includes(latest.status)
    )
      return;
    let slots =
      c.targetCount -
      this.deliveries(id).filter((d) => !['blocked', 'cancelled'].includes(d.status)).length;
    for (const candidate of result.blocked.slice(0, 200)) {
      if (
        this.deliveries(id).some(
          (d) => d.customerId === candidate.customerId && d.status !== 'cancelled',
        )
      )
        continue;
      this.putDelivery({
        id: randomUUID(),
        campaignId: id,
        mode: 'production',
        customerId: candidate.customerId,
        companyName: candidate.companyName,
        to: candidate.to || '',
        mailboxId: candidate.mailboxId || '',
        from: '',
        subject: '',
        bodyText: '',
        status: 'blocked',
        reason: candidate.reason || candidate.reasonCode,
        matchReason: '',
        createdAt: iso(this.now),
      });
    }
    const selected = result.eligible.slice(0, Math.max(0, slots));
    let cursor = 0;
    const generate = async () => {
      while (cursor < selected.length && !this.closed) {
        const candidate = selected[cursor++];
        if (this.campaign(id).revision !== revision || this.campaign(id).status === 'paused')
          return;
        const mailbox = this.mailboxes.get(candidate.mailboxId),
          product = this.products().find((p) => p.id === candidate.productId);
        const replaced = this.deliveries(id).find(
          (delivery) =>
            delivery.customerId === candidate.customerId &&
            delivery.status === 'blocked' &&
            delivery.materialRefresh,
        );
        if (!mailbox?.signature?.trim()) {
          this.putDelivery({
            id: randomUUID(),
            campaignId: id,
            mode: 'production',
            customerId: candidate.customerId,
            companyName: candidate.companyName,
            to: candidate.to,
            mailboxId: mailbox?.id || '',
            from: mailbox?.email || '',
            subject: '',
            bodyText: '',
            status: 'blocked',
            reason: '请先配置并确认该邮箱的发件签名',
            matchReason: candidate.matchReason,
            createdAt: iso(this.now),
          });
          continue;
        }
        const d = {
          id: randomUUID(),
          campaignId: id,
          mode: 'production',
          customerId: candidate.customerId,
          companyName: candidate.companyName,
          to: candidate.to,
          mailboxId: mailbox.id,
          from: mailbox.email,
          subject: '',
          bodyText: '',
          status: 'draft',
          reason: '正在生成',
          matchReason: candidate.matchReason,
          createdAt: iso(this.now),
          candidate,
          developmentVersion: candidate.developmentVersion,
          ...(c.generationMode === 'simple'
            ? { developmentReviewedVersion: candidate.developmentVersion || 0 }
            : {}),
          revision,
          senderVersion: senderVersion(mailbox),
          productVersion: product.version,
          materialVersion:
            candidate.materialVersion || outreachMaterialVersion(product, c, new Date(this.now())),
          ...(replaced
            ? {
                replacesDeliveryId: replaced.id,
                developmentReviewedVersion: replaced.developmentReviewedVersion,
                materialRefresh: true,
              }
            : {}),
        };
        try {
          this.transaction(() => {
            this.reserve(d);
            for (const prior of this.deliveries(id))
              if (prior.customerId === d.customerId && prior.status === 'blocked')
                this.putDelivery({
                  ...prior,
                  status: 'cancelled',
                  reason: '条件已补齐，已重新准备样稿',
                });
            this.putDelivery(d);
          });
        } catch {
          continue;
        }
        try {
          const generated = await this.generatorClient().generate({
            candidate,
            mailbox,
            product,
            campaign: c,
            now: new Date(this.now()),
          });
          const current = this.campaign(id);
          if (this.closed) return;
          if (current.revision !== revision || ['paused', 'cancelled'].includes(current.status)) {
            if (this.delivery(d.id).status !== 'cancelled')
              this.putDelivery({ ...d, status: 'cancelled', reason: '计划已暂停或修改' });
            this.release(d.id);
            continue;
          }
          const developmentReason = this.developmentReason(d);
          if (developmentReason) {
            this.putDelivery({ ...d, status: 'blocked', reason: developmentReason });
            this.release(d.id);
            continue;
          }
          const materialReason = this.materialReason(d, current);
          if (materialReason) {
            this.putDelivery({
              ...d,
              status: 'blocked',
              reason: materialReason,
              materialRefresh: true,
            });
            this.release(d.id);
            continue;
          }
          if (!generated.subject || !generated.bodyText || /[\r\n]/.test(generated.subject))
            throw fail(422, '邮件生成结果无效');
          const signature = renderMailboxSignature(mailbox);
          const bodyText = generated.bodyText + '\n\n' + signature.text;
          const bodyHtml = signaturePlainTextHtml(generated.bodyText) + '<br><br>' + signature.html;
          this.putDelivery({
            ...d,
            subject: generated.subject,
            bodyText,
            bodyHtml,
            status:
              wasActive && current.approvedRevision === revision && this.developmentReviewed(d)
                ? 'queued'
                : 'draft',
            reason: '',
            sourceIds: generated.sourceIds || [],
            agentId: generated.agentId,
            generationMode: c.generationMode,
            productClaimIds: generated.factIds || [],
            productFacts: eligibleOutreachFacts(product, c, new Date(this.now())).filter((fact) =>
              (generated.factIds || []).includes(fact.id),
            ),
          });
          if (d.developmentVersion && !wasActive && !this.developmentReviewed(d))
            this.putCampaign({ ...this.campaign(id), approvedRevision: null });
        } catch (error) {
          if (this.closed) return;
          const current = this.campaign(id);
          if (current.revision !== revision || ['paused', 'cancelled'].includes(current.status)) {
            if (this.delivery(d.id).status !== 'cancelled')
              this.putDelivery({ ...d, status: 'cancelled', reason: '计划已暂停或修改' });
            this.release(d.id);
            continue;
          }
          const materialRefresh =
            d.materialRefresh ||
            this.delivery(d.id).materialRefresh ||
            Boolean(this.materialReason(d, current));
          this.putDelivery({
            ...d,
            status: 'blocked',
            reason: safeError(error),
            ...(materialRefresh
              ? {
                  materialRefresh: true,
                  materialRetryAt: new Date(this.now() + 60000).toISOString(),
                }
              : {}),
          });
          this.release(d.id);
        }
      }
    };
    await Promise.all([generate(), generate(), generate()]);
    if (this.closed) return;
    const current = this.campaign(id);
    if (current.revision === revision && current.status !== 'paused') {
      const deliveries = this.deliveries(id);
      const pending = deliveries.some((d) => ['draft', 'queued', 'sending'].includes(d.status));
      const reasons = new Map();
      for (const delivery of deliveries.filter((d) => d.status === 'blocked')) {
        const reason = delivery.reason || '条件尚未补齐';
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
      const summary = [...reasons]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, count]) => `${count} 家：${reason}`)
        .join('；');
      this.putCampaign({
        ...current,
        status: wasActive ? 'active' : 'ready',
        preparedAt: iso(this.now),
        lastError: pending
          ? ''
          : summary
            ? `暂未生成样稿。${summary}。请打开“样稿与详情”查看。`
            : '当前没有可加入的未开发客户',
      });
    }
  }
  approve(id, revision) {
    const c = this.campaign(id);
    if (
      c.revision !== revision ||
      !['ready', 'active', 'paused'].includes(c.status) ||
      this.preparing.has(id)
    )
      throw fail(409, '请等待草稿准备完成并检查当前版本');
    const drafts = this.deliveries(id).filter((d) => d.status === 'draft' && d.subject);
    if (!drafts.length) throw fail(400, '尚无可审核的开发信');
    const valid = [];
    for (const draft of drafts) {
      const reason = this.developmentReason(draft);
      if (reason) {
        this.putDelivery({ ...draft, status: 'blocked', reason });
        this.release(draft.id);
      } else valid.push(draft);
    }
    if (!valid.length) throw fail(409, '客户开发安排已变化，请重新准备并审核邮件');
    return this.transaction(() => {
      for (const draft of valid)
        this.putDelivery({
          ...draft,
          developmentReviewedVersion: draft.developmentVersion || 0,
          status: c.status === 'active' ? 'queued' : 'draft',
        });
      return this.putCampaign({ ...c, approvedRevision: revision, approvedAt: iso(this.now) });
    });
  }
  approveReview(approved) {
    if (approved !== true) throw fail(400, '请明确确认已共同检查内部测试邮件');
    const r = this.review();
    if (!r.internalTestPassed) throw fail(409, '请先完成所有内部测试邮件发送，并在原邮箱检查内容');
    this.setMeta('production_review', {
      testId: r.testId,
      fingerprint: this.testFingerprint(),
      at: iso(this.now),
    });
    return this.review();
  }
  activate(id, revision) {
    let c = this.campaign(id);
    if (c.generationMode === 'simple') {
      if (
        c.mode !== 'production' ||
        c.revision !== revision ||
        !['draft', 'ready', 'paused', 'active'].includes(c.status)
      )
        throw fail(409, '计划已更新或正在处理，请刷新后启动');
      if (!this.generatorClient().configured) throw fail(503, '请先配置邮件生成模型');
      if (
        !c.mailboxIds.length ||
        c.mailboxIds.some((id) => {
          const m = this.mailboxes.get(id);
          return (
            !m?.configured ||
            m.paused ||
            m.smtpStatus !== 'connected' ||
            !m.signature?.trim() ||
            !m.displayName?.trim()
          );
        })
      )
        throw fail(409, '请先核对所选邮箱连接和固定签名');
      this.putCampaign({
        ...c,
        status: 'active',
        approvedRevision: revision,
        approvedAt: iso(this.now),
        startedAt: c.startedAt || iso(this.now),
        lastError: '',
      });
      for (const d of this.deliveries(id))
        if (d.status === 'draft' && d.subject && this.developmentReviewed(d))
          this.putDelivery({ ...d, status: 'queued' });
      this.start();
      this.prepare(id);
      void this.tick();
      return this.detail(id);
    }
    if (c.mode !== 'production' || c.revision !== revision || c.approvedRevision !== revision)
      throw fail(409, '请先审核当前版本的计划和邮件样稿');
    if (!this.review().productionApproved)
      throw fail(409, '请先共同检查内部测试结果，再启用正式发送');
    if (c.mailboxIds.some((id) => !this.review().testedMailboxIds.includes(id)))
      throw fail(409, '所选邮箱尚未完成内部测试，请先测试这些邮箱');
    if (c.status === 'active') return this.detail(id);
    if (!['ready', 'paused'].includes(c.status)) throw fail(409, '计划当前不能启动');
    this.transaction(() => {
      for (const d of this.deliveries(id))
        if (d.status === 'draft' && d.subject && this.developmentReviewed(d))
          this.putDelivery({ ...d, status: 'queued' });
      this.putCampaign({
        ...c,
        status: 'active',
        startedAt: c.startedAt || iso(this.now),
        lastError: '',
      });
    });
    this.start();
    void this.tick();
    return this.detail(id);
  }
  pause(id) {
    const c = this.campaign(id);
    if (['cancelled', 'completed'].includes(c.status))
      throw fail(409, '计划已结束，不能恢复或暂停');
    this.putCampaign({ ...c, status: 'paused' });
    return this.detail(id);
  }
  cancel(id, revision, confirmed) {
    const c = this.campaign(id);
    if (confirmed !== true) throw fail(400, '请确认取消该触达计划');
    if (c.status === 'cancelled') return this.detail(id);
    if (c.revision !== revision) throw fail(409, '计划已更新，请刷新后重新确认取消');
    if (!['draft', 'preparing', 'ready', 'active', 'paused'].includes(c.status))
      throw fail(409, '计划已结束，不能取消');
    this.transaction(() => {
      const cancelledAt = iso(this.now);
      for (const d of this.deliveries(id)) {
        if (!['draft', 'queued', 'blocked'].includes(d.status)) continue;
        this.putDelivery({ ...d, status: 'cancelled', reason: '触达计划已取消', cancelledAt });
        this.release(d.id);
      }
      this.putCampaign({
        ...c,
        status: 'cancelled',
        revision: c.revision + 1,
        approvedRevision: null,
        cancelledAt,
        updatedAt: cancelledAt,
        lastError: '',
      });
    });
    return this.detail(id);
  }
  suppress(input) {
    const reason = text(input.reason) || '人工标记不再联系';
    const keys = [
      text(input.customerId) && 'company:' + text(input.customerId),
      text(input.domain) && 'domain:' + text(input.domain).toLowerCase(),
      text(input.email) && 'email:' + text(input.email).toLowerCase(),
    ].filter(Boolean);
    if (!keys.length) throw fail(400, '请指定客户或联系地址');
    for (const key of keys)
      this.db
        .prepare(
          'INSERT INTO outreach_suppression VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET reason=excluded.reason',
        )
        .run(key, reason);
    return { saved: true };
  }
  internalTest({ confirmed, idempotencyKey, expectedMailboxIds, expectedMailboxEmails }) {
    if (confirmed !== true) throw fail(400, '请先确认仅向界面所列公司自有邮箱发送测试信');
    if (!/^[\w-]{8,100}$/.test(idempotencyKey || '')) throw fail(400, '内部测试需要有效操作编号');
    const prior = this.db
      .prepare('SELECT result_id FROM outreach_requests WHERE key=? AND kind=?')
      .get(idempotencyKey, 'internal_test');
    if (prior) return this.detail(prior.result_id);
    const boxes = this.mailboxes
      .list()
      .filter((m) => m.configured && !m.paused && m.smtpStatus === 'connected');
    if (boxes.length < 2) throw fail(400, '至少需要两个连接正常的公司邮箱');
    if (
      expectedMailboxEmails &&
      JSON.stringify(expectedMailboxEmails) !== JSON.stringify(boxes.map((m) => m.email))
    )
      throw fail(409, '测试邮箱地址已变化，请刷新并重新检查收发地址');
    if (
      expectedMailboxIds &&
      JSON.stringify(expectedMailboxIds) !== JSON.stringify(boxes.map((m) => m.id))
    )
      throw fail(409, '测试邮箱列表已变化，请刷新并重新检查收发地址');
    if (this.campaigns().some((c) => c.mode === 'internal_test' && c.status === 'active'))
      throw fail(409, '上一轮内部测试正在执行');
    const id = randomUUID();
    const c = {
      id,
      name: '公司邮箱小批测试',
      mode: 'internal_test',
      status: 'active',
      revision: 1,
      approvedRevision: 1,
      targetCount: boxes.length,
      mailboxIds: boxes.map((m) => m.id),
      intervalSeconds: 0,
      createdAt: iso(this.now),
      testFingerprint: this.testFingerprint(),
      continuous: false,
    };
    this.transaction(() => {
      this.putCampaign(c);
      boxes.forEach((m, i) => {
        const recipient = boxes[(i + 1) % boxes.length];
        const marker = randomUUID();
        const body = `This is a company-controlled technical test of the outbound email workflow.\n\nSender: ${m.email}\nRecipient: ${recipient.email}\nWebsite identity: ${m.website}\nTest reference: ${marker}\n\nThis message is not a customer outreach email. No reply is required.`;
        const signature = renderMailboxSignature(m);
        this.putDelivery({
          id: marker,
          campaignId: id,
          mode: 'internal_test',
          companyName: '公司内部测试 · ' + recipient.brandName,
          to: recipient.email,
          mailboxId: m.id,
          from: m.email,
          subject: `[ShadeFlow-Test:${marker}] Internal outbound workflow test`,
          bodyText: body + (signature.text ? '\n\n' + signature.text : ''),
          bodyHtml:
            signaturePlainTextHtml(body) + (signature.html ? '<br><br>' + signature.html : ''),
          status: 'queued',
          reason: '',
          matchReason: '已连接公司邮箱之间的内部测试',
          createdAt: iso(this.now),
          senderVersion: senderVersion(m),
        });
      });
      this.db
        .prepare('INSERT INTO outreach_requests VALUES(?,?,?)')
        .run(idempotencyKey, 'internal_test', id);
    });
    this.start();
    void this.tick();
    return this.detail(id);
  }
  inWindow(c) {
    if (c.sendWindow == null) return true;
    const w = c.sendWindow;
    if (sendWindowError(w)) return false;
    const current = new Intl.DateTimeFormat('en-GB', {
      timeZone: w.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(this.now()));
    return w.start <= w.end
      ? current >= w.start && current < w.end
      : current >= w.start || current < w.end;
  }
  canDispatch(c, d, m) {
    if (!m || m.paused || m.smtpStatus !== 'connected' || !m.configured) return false;
    if (c.mode === 'internal_test') return true;
    if (
      (c.generationMode !== 'simple' &&
        (!this.review().productionApproved || !this.review().testedMailboxIds.includes(m.id))) ||
      c.approvedRevision !== c.revision ||
      !this.inWindow(c)
    )
      return false;
    const history = this.deliveries().filter(
      (v) =>
        v.mailboxId === m.id && ['accepted', 'sending', 'unknown', 'failed'].includes(v.status),
    );
    if (
      history.filter((v) => day(v.sentAt || v.attemptedAt || v.createdAt) === day(this.now()))
        .length >= m.dailyLimit
    )
      return false;
    const last = Math.max(
      0,
      ...history.map((v) => Date.parse(v.sentAt || v.attemptedAt || v.createdAt)),
    );
    return this.now() - last >= Math.max(c.intervalSeconds, m.intervalSeconds) * 1000;
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runTick()
      .catch(() => {})
      .finally(() => (this.running = null));
    return this.running;
  }
  async runTick() {
    this.refreshProductMaterials();
    const campaigns = this.campaigns().filter((c) => c.status === 'active');
    const used = new Set();
    for (const summary of campaigns) {
      if (this.closed) break;
      const c = this.campaign(summary.id);
      if (c.status !== 'active') continue;
      if (c.mode === 'production' && c.scope !== this.getScope()) {
        this.putCampaign({
          ...c,
          status: 'paused',
          lastError: '客户数据来源已改变，请重新建立计划',
        });
        continue;
      }
      for (const d of this.deliveries(c.id).filter((d) => d.status === 'queued')) {
        if (used.has(d.mailboxId)) continue;
        const m = this.mailboxes.get(d.mailboxId);
        if (!this.canDispatch(c, d, m)) continue;
        used.add(d.mailboxId);
        await this.dispatch(c, d, m);
      }
      if (this.closed) break;
      const current = this.campaign(c.id);
      if (current.status !== 'active') continue;
      const rows = this.deliveries(c.id);
      const consumed = rows.filter((d) =>
        ['accepted', 'unknown', 'sending', 'failed'].includes(d.status),
      ).length;
      if (c.mode === 'internal_test' && rows.every((d) => terminal.has(d.status)))
        this.putCampaign({
          ...current,
          status: rows.every((d) => d.status === 'accepted') ? 'completed' : 'paused',
        });
      else if (
        consumed >= c.targetCount &&
        !rows.some((d) => ['queued', 'sending'].includes(d.status))
      )
        this.putCampaign({ ...current, status: 'completed' });
      else if (
        c.mode === 'production' &&
        c.continuous &&
        !this.preparing.has(c.id) &&
        (!current.lastRefreshAt || this.now() - Date.parse(current.lastRefreshAt) > 60000)
      ) {
        this.putCampaign({ ...current, lastRefreshAt: iso(this.now) });
        this.prepare(c.id);
      } else if (
        c.mode === 'production' &&
        !c.continuous &&
        !rows.some((d) => ['draft', 'queued', 'sending'].includes(d.status)) &&
        !rows.some((d) => d.status === 'blocked' && d.materialRefresh) &&
        !this.preparing.has(c.id)
      )
        this.putCampaign({
          ...current,
          status: c.generationMode === 'simple' ? 'paused' : 'completed',
          ...(c.generationMode === 'simple'
            ? {
                lastError: `本轮已提交 ${consumed} / ${c.targetCount} 封，剩余客户或邮件条件待处理，请查看执行详情。`,
              }
            : {}),
        });
    }
  }
  async dispatch(c, d, m) {
    const current = this.campaign(c.id);
    if (
      current.status !== 'active' ||
      current.revision !== c.revision ||
      this.delivery(d.id).status !== 'queued'
    )
      return;
    if (senderVersion(m) !== d.senderVersion) {
      this.putDelivery({
        ...d,
        status: 'blocked',
        reason: '发件地址、名称、签名或产品范围已变化，请重新准备邮件',
      });
      this.release(d.id);
      return;
    }
    if (c.mode === 'production') {
      const materialReason = this.materialReason(d, c);
      if (materialReason) {
        this.putDelivery({
          ...d,
          status: 'blocked',
          reason: materialReason,
          materialRefresh: true,
        });
        this.release(d.id);
        return;
      }
      const reason =
        this.developmentReason(d) ||
        (!this.developmentReviewed(d) ? '恢复后的邮件尚未重新审核，请先核对样稿' : '');
      if (reason) {
        this.putDelivery({ ...d, status: 'blocked', reason });
        this.release(d.id);
        return;
      }
      let result;
      try {
        result = await this.candidates(this.campaign(c.id), d.id);
      } catch (e) {
        const latest = this.campaign(c.id);
        if (latest.status === 'active' && latest.revision === c.revision)
          this.putCampaign({ ...latest, status: 'paused', lastError: safeError(e) });
        return;
      }
      const latest = this.campaign(c.id);
      if (
        latest.status !== 'active' ||
        latest.revision !== c.revision ||
        this.delivery(d.id).status !== 'queued'
      )
        return;
      const candidate = result.eligible.find(
        (v) =>
          v.customerId === d.customerId &&
          v.to === d.to &&
          v.mailboxId === d.mailboxId &&
          v.productId === d.candidate.productId &&
          v.productVersion === d.productVersion,
      );
      if (!candidate || hash(candidate.leadSnapshot) !== hash(d.candidate.leadSnapshot)) {
        const materialReason = this.materialReason(d, latest);
        this.putDelivery({
          ...d,
          status: 'blocked',
          reason: materialReason || '客户、产品或联系状态已变化，请重新准备邮件',
          ...(materialReason ? { materialRefresh: true } : {}),
        });
        this.release(d.id);
        return;
      }
    } else if (
      !this.mailboxes
        .list()
        .some((box) => box.email.toLowerCase() === d.to.toLowerCase() && box.configured)
    )
      throw fail(400, '内部测试只能使用已配置公司邮箱');
    // Recheck after asynchronous reads: a human can pause while data is loading.
    const latestCampaign = this.campaign(c.id),
      latestMailbox = this.mailboxes.get(m.id);
    if (latestCampaign.status !== 'active' || !this.canDispatch(latestCampaign, d, latestMailbox))
      return;
    if (
      senderVersion(latestMailbox) !== d.senderVersion ||
      latestCampaign.revision !== c.revision ||
      (c.mode === 'production' &&
        ((c.generationMode !== 'simple' && !this.review().productionApproved) ||
          latestCampaign.approvedRevision !== c.revision ||
          this.isReserved(d.candidate, d.id)))
    ) {
      this.putDelivery({
        ...d,
        status: 'blocked',
        reason: '发送前的计划、客户或邮箱配置已变化，请重新检查',
      });
      this.release(d.id);
      return;
    }
    const pending = {
      ...d,
      status: 'sending',
      attemptedAt: iso(this.now),
      messageId: `<${d.id}@${m.email.split('@')[1]}>`,
    };
    const claimed = this.transaction(() => {
      if (this.delivery(d.id).status !== 'queued') return false;
      this.putDelivery(pending);
      return true;
    });
    if (!claimed) return;
    try {
      const result = await this.mailboxes.send(
        m.id,
        {
          to: d.to,
          subject: d.subject,
          text: d.bodyText,
          ...(d.bodyHtml ? { html: d.bodyHtml } : {}),
          messageId: pending.messageId,
          expectedAccount: m.email,
        },
        {
          beforeSend: () => {
            const campaign = this.campaign(c.id);
            const reason =
              (c.mode === 'production' && campaign.scope !== this.getScope()
                ? '客户数据来源已改变，邮件尚未提交发送'
                : '') ||
              (c.mode === 'production' && this.developmentReason(d)) ||
              (c.mode === 'production' && this.materialReason(d, campaign)) ||
              (c.mode === 'production' && !this.developmentReviewed(d)
                ? '恢复后的邮件尚未重新审核，请先核对样稿'
                : '') ||
              (campaign.status !== 'active' || campaign.revision !== c.revision
                ? '计划已暂停或更新，邮件尚未提交发送'
                : '') ||
              (c.mode === 'production' &&
              (campaign.approvedRevision !== c.revision ||
                (campaign.generationMode !== 'simple' && !this.review().productionApproved))
                ? '当前计划或邮箱测试授权已失效，请重新核对'
                : '') ||
              (senderVersion(this.mailboxes.get(m.id)) !== d.senderVersion
                ? '发件身份已变化，邮件尚未提交发送'
                : '') ||
              (c.mode === 'production' && this.isReserved(d.candidate, d.id)
                ? '客户联系安排已变化，请重新检查'
                : '');
            if (reason)
              throw Object.assign(fail(409, reason), { code: 'OUTREACH_PRE_SEND_BLOCKED' });
          },
        },
      );
      const accepted = result.accepted?.some(
        (address) =>
          String(typeof address === 'object' ? address.address : address).toLowerCase() ===
          d.to.toLowerCase(),
      );
      const rejected = result.rejected?.some(
        (address) =>
          String(typeof address === 'object' ? address.address : address).toLowerCase() ===
          d.to.toLowerCase(),
      );
      const completed = this.putDelivery({
        ...pending,
        status: accepted ? 'accepted' : rejected ? 'failed' : 'unknown',
        reason: accepted
          ? ''
          : rejected
            ? '服务商拒绝该收件地址'
            : '发送结果待核实，系统不会自动重发',
        messageId: result.messageId || pending.messageId,
        sentAt: accepted ? iso(this.now) : null,
      });
      if (accepted && c.mode === 'production' && this.recordAccepted) {
        try {
          await this.recordAccepted(completed);
          this.putDelivery({ ...completed, businessRecordedAt: iso(this.now), recordError: '' });
        } catch (error) {
          this.putDelivery({
            ...completed,
            recordError: '邮件已提交，客户业务记录待核对：' + safeError(error),
          });
        }
      }
    } catch (error) {
      if (error.code === 'OUTREACH_PRE_SEND_BLOCKED') {
        this.putDelivery({
          ...d,
          status: 'blocked',
          reason: safeError(error),
          ...(this.materialReason(d, this.campaign(c.id)) ? { materialRefresh: true } : {}),
        });
        this.release(d.id);
        return;
      }
      const definite = /AUTH|NOT_CONFIGURED|PAUSED|NOT_VERIFIED|INVALID|REJECTED/.test(
        error.code || '',
      );
      this.putDelivery({
        ...pending,
        status: definite ? 'failed' : 'unknown',
        reason: definite ? safeError(error) : '发送结果待核实；请检查原邮箱，系统不会自动重发',
      });
      if (!definite || /AUTH|LIMIT|RATE/.test(error.code || ''))
        await this.mailboxes.save({ id: m.id, paused: true });
    }
  }
  confirmInternalReceipt(id) {
    const d = this.delivery(id);
    if (d.mode !== 'internal_test' || d.status !== 'accepted')
      throw fail(400, '只能确认已发送的公司内部测试邮件');
    return this.putDelivery({ ...d, receivedVerifiedAt: iso(this.now) });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([this.running, ...this.preparing.values()].filter(Boolean));
    await this.replies.close();
    await this.conversations.close();
    this.db.close();
  }
}
