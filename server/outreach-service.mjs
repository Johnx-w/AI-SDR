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
import { OutreachFollowUps } from './outreach-follow-ups.mjs';
import { MailboxTags } from './mailbox-tags.mjs';
import { initializeOutreachBounces, recordOutreachBounces } from './outreach-bounces.mjs';
import { MailConversations, mailboxAccountKey } from './mail-conversations.mjs';
import { MailReplies } from './mail-replies.mjs';
import { MailReception } from './mail-reception.mjs';

import { siteAllowsProduct } from '../src/domain/mail-site.mjs';
import { renderMailboxSignature, signaturePlainTextHtml } from '../src/domain/mail-signature.mjs';
import { deliveryGroup } from '../src/domain/outreach-status.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const list = (value) =>
  Array.isArray(value) ? [...new Set(value.map((v) => text(v)).filter(Boolean))].slice(0, 200) : [];
const iso = (now) => new Date(now()).toISOString();
const outcomeSql = "CASE WHEN state='failed' THEN json_extract(data,'$.resolution.outcome') END";
const draftSql =
  "CASE WHEN state='draft' THEN coalesce(json_extract(data,'$.subject'),'')!='' ELSE 0 END";
const terminal = new Set(['accepted', 'failed', 'unknown', 'blocked', 'skipped', 'cancelled']);
const customerSkipCodes = new Set([
  'match_unverified',
  'assessment_conflict',
  'identity_incomplete',
  'suppressed',
  'already_contacted_or_unknown',
  'business_unverified',
  'contact_unverified',
  'duplicate_company',
  'product_match_unconfirmed',
]);
const senderVersion = (m) =>
  hash([
    m.id,
    m.email,
    m.displayName,
    m.signature,
    ...(m.signatureDesign ? [m.signatureDesign] : []),
    [...(m.productIds || [])].sort(),
  ]);
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });
const day = (date) => dayFormat.format(new Date(date));
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
    answerQuestion = () => ({
      automatic: false,
      reason: '尚无所选资料',
      sources: [],
      body: 'Could you confirm the model and the detail you need?',
    }),
    getEnv = () => ({}),
    fetchImpl,
    draftPhotos = () => [],
    photoOptions,
    guardPhotos,
    getDraftModel = () => null,
    getScope = () => 'local',
    businessState = () => ({}),
    customerMailState,
    setMailOwnership,
    customers = () => [],
    recordAccepted,
    recordCommunication,
    recordFollowUp,
    generator,
    now = Date.now,
    tickMs = 2000,
    acquisitionSources = () => [],
    isMaintaining = () => false,
  } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.function('mail_account_key', { deterministic: true }, (id, email) =>
      mailboxAccountKey({ id, email }),
    );
    // SQLite's built-in lower only handles ASCII; preserve the former browser search semantics.
    this.db.function('outreach_lower', { deterministic: true }, (value) =>
      String(value ?? '').toLowerCase(),
    );
    this.db.function(
      'outreach_delivery_group',
      { deterministic: true },
      (status, subject, outcome) =>
        deliveryGroup({ status, subject, resolution: outcome ? { outcome } : null }),
    );
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS outreach_campaigns(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_deliveries(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outreach_delivery_campaign ON outreach_deliveries(campaign_id,state);
      CREATE INDEX IF NOT EXISTS outreach_counts ON outreach_deliveries(campaign_id,state,${outcomeSql},${draftSql});
      DROP INDEX IF EXISTS outreach_record_search;
      CREATE INDEX IF NOT EXISTS outreach_customer_deliveries ON outreach_deliveries(campaign_id,json_extract(data,'$.customerId'));
      CREATE INDEX IF NOT EXISTS outreach_activity ON outreach_deliveries(state,id,json_extract(data,'$.mailboxId'),json_extract(data,'$.sentAt'),json_extract(data,'$.attemptedAt'),json_extract(data,'$.createdAt'));
      CREATE TABLE IF NOT EXISTS outreach_reservations(identity TEXT PRIMARY KEY,delivery_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_requests(key TEXT PRIMARY KEY,kind TEXT NOT NULL,result_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outreach_suppression(identity TEXT PRIMARY KEY,reason TEXT NOT NULL);`);
    Object.assign(this, {
      mailboxes,
      loadLeads,
      products,
      answerQuestion,
      draftPhotos,
      photoOptions,
      guardPhotos,
      getDraftModel,
      getEnv,
      getScope,
      businessState,
      setMailOwnership,
      recordAccepted,
      generator,
      fetchImpl,
      now,
      tickMs,
      acquisitionSources,
      isMaintaining,
    });
    this.customerMailState =
      customerMailState ||
      ((id) => {
        const graph = businessState();
        return {
          context: graph.customerContexts?.find((c) => c.customerId === id),
          conversations: (graph.conversations || []).filter((c) => c.customerId === id),
          demands: (graph.demands || []).filter((d) => d.customerId === id),
        };
      });
    this.followUps = new OutreachFollowUps(this, recordFollowUp);
    this.tags = new MailboxTags(this.db, mailboxes);
    this.db
      .exec(`CREATE INDEX IF NOT EXISTS outreach_sequence_pending ON outreach_followups(json_extract(data,'$.campaignId'),state);
      CREATE INDEX IF NOT EXISTS outreach_sequence_first ON outreach_followups(json_extract(data,'$.firstId'),json_extract(data,'$.step'));
      CREATE INDEX IF NOT EXISTS outreach_sequence_contacts ON outreach_deliveries(campaign_id,state,json_extract(data,'$.sentAt') DESC,id);`);
    this.preparing = new Map();
    this.conversations = new MailConversations({
      db: this.db,
      mailboxes,
      deliveries: () =>
        this.db
          .prepare(
            `SELECT data FROM outreach_deliveries WHERE state='accepted'
            AND NOT EXISTS (SELECT 1 FROM mailbox_imported_deliveries
              WHERE delivery_id=outreach_deliveries.id)
            UNION ALL SELECT data FROM outreach_followups WHERE state='accepted'
            AND NOT EXISTS (SELECT 1 FROM mailbox_imported_deliveries
              WHERE delivery_id=outreach_followups.id)`,
          )
          .all()
          .map((row) => JSON.parse(row.data)),
      customers,
      recordCommunication,
      onMessage: (box, thread, message, lookup) =>
        this.reception.observe(box, thread, message, lookup),
      recordDeliveryBounces: (mailbox, messages) => {
        const matched = recordOutreachBounces(
          this.db,
          messages.map((message) => ({
            ...message,
            mailboxId: mailbox.id,
            account: mailbox.email,
          })),
        );
        for (const bounce of matched || [])
          this.followUps.stopFor({
            mailboxId: mailbox.id,
            firstId: bounce.id,
            at: bounce.receivedAt,
            reason: '原邮件已确认退信',
          });
      },
      now,
    });
    this.transaction(() => initializeOutreachBounces(this.db));
    this.replies = new MailReplies({
      db: this.db,
      mailboxes,
      conversations: this.conversations,
      guardReply: (input) => this.reception.guardReply(input),
      onSettled: (op) => this.reception.settled(op),
      recordCommunication,
      now,
    });
    this.reception = new MailReception(this);
    this.preparationQueue = Promise.resolve();
    this.running = null;
    this.timer = null;
    this.closed = false;
    for (const d of this.deliveries(undefined, ['sending']))
      this.putDelivery({
        ...d,
        status: 'unknown',
        reason: '发送时服务中断，请核对原邮箱；系统不会自动重发',
      });
    for (const d of this.deliveries(undefined, ['draft']).filter((d) => !d.subject)) {
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
    const { stats, deliveryGroups, ...data } = c;
    this.db
      .prepare(
        'INSERT INTO outreach_campaigns VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(c.id, JSON.stringify(data));
    return this.withStats(data);
  }
  deliveryActivity(state) {
    return this.db
      .prepare(
        `SELECT state AS status,id,json_extract(data,'$.mailboxId') AS mailboxId,json_extract(data,'$.sentAt') AS sentAt,json_extract(data,'$.attemptedAt') AS attemptedAt,json_extract(data,'$.createdAt') AS createdAt FROM outreach_deliveries INDEXED BY outreach_activity ${state ? 'WHERE state=?' : ''}`,
      )
      .all(...(state ? [state] : []));
  }
  deliveries(campaignId, states, customerId) {
    const where = [],
      params = [];
    if (campaignId) {
      where.push('campaign_id=?');
      params.push(campaignId);
    }
    if (states) {
      where.push(`state IN (${states.map(() => '?').join(',')})`);
      params.push(...states);
    }
    if (customerId !== undefined) {
      where.push("json_extract(data,'$.customerId')=?");
      params.push(customerId);
    }
    return this.db
      .prepare(
        `SELECT data FROM outreach_deliveries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid${campaignId ? '' : ' DESC'}`,
      )
      .all(...params)
      .map((r) => JSON.parse(r.data));
  }
  delivery(id) {
    const row = this.db.prepare('SELECT data FROM outreach_deliveries WHERE id=?').get(id);
    if (!row) throw fail(404, '发送记录不存在');
    return JSON.parse(row.data);
  }
  deliveryRecord(id) {
    const { candidate, ...delivery } = this.delivery(id);
    delivery.campaignName = this.db
      .prepare("SELECT json_extract(data,'$.name') AS name FROM outreach_campaigns WHERE id=?")
      .get(delivery.campaignId)?.name;
    const bounce =
      delivery.status === 'accepted' &&
      this.db
        .prepare('SELECT received_at FROM outreach_delivery_bounces WHERE delivery_id=?')
        .get(id);
    return bounce ? { ...delivery, bouncedAt: bounce.received_at } : delivery;
  }
  putDelivery(d) {
    if (d.status === 'unknown' && !d.reconciliation) {
      const previous = this.db
        .prepare('SELECT state FROM outreach_deliveries WHERE id=?')
        .get(d.id);
      if (previous?.state === 'sending') d = { ...d, autoReconcilePending: true };
    }
    this.db
      .prepare(
        'INSERT INTO outreach_deliveries VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data',
      )
      .run(d.id, d.campaignId, d.status, JSON.stringify(d));
    return d;
  }
  withStats(c) {
    const { stats, deliveryGroups } = this.deliveryCounts(c.id);
    return { ...c, stats, deliveryGroups };
  }
  deliveryCounts(campaignId) {
    const deliveryGroups = {
      pending: 0,
      sent: 0,
      attention: 0,
      resolved: 0,
      skipped: 0,
      cancelled: 0,
    };
    const stats = {
      draft: 0,
      queued: 0,
      accepted: 0,
      failed: 0,
      unknown: 0,
      blocked: 0,
      skipped: 0,
      sending: 0,
    };
    let total = 0,
      cancelled = 0;
    for (const row of this.db
      .prepare(
        `SELECT state,${outcomeSql} AS outcome,${draftSql} AS ready,count(*) AS count FROM outreach_deliveries INDEXED BY outreach_counts ${campaignId ? 'WHERE campaign_id=?' : ''} GROUP BY campaign_id,state,outcome,ready`,
      )
      .all(...(campaignId ? [campaignId] : []))) {
      total += row.count;
      if (row.state === 'cancelled') cancelled += row.count;
      if (row.state in stats) stats[row.state] += row.count;
      deliveryGroups[
        deliveryGroup({
          status: row.state,
          subject: row.ready,
          resolution: { outcome: row.outcome },
        })
      ] += row.count;
    }
    return { stats, total, cancelled, deliveryGroups };
  }
  campaignPage(params) {
    const view = params.get('view'),
      status = params.get('status'),
      q = params.get('q')?.trim().toLowerCase();
    const where = [],
      args = [];
    const history = "json_extract(data,'$.status') IN ('completed','cancelled')";
    where.push(
      view === 'tests'
        ? "json_extract(data,'$.mode')='internal_test'"
        : `json_extract(data,'$.mode')='production' AND ${view === 'history' ? '' : 'NOT'} (${history})`,
    );
    if (q) {
      where.push("instr(outreach_lower(json_extract(data,'$.name')),?)>0");
      args.push(q);
    }
    if (status === 'attention')
      where.push(
        `(coalesce(json_extract(data,'$.lastError'),'') != '' OR EXISTS (SELECT 1 FROM outreach_deliveries INDEXED BY outreach_counts WHERE campaign_id=outreach_campaigns.id AND outreach_delivery_group(state,${draftSql},${outcomeSql})='attention'))`,
      );
    else if (status && status !== 'all') {
      where.push("json_extract(data,'$.status')=?");
      args.push(status);
    }
    const source = 'FROM outreach_campaigns WHERE ' + where.join(' AND ');
    const filtered = this.db.prepare(`SELECT count(*) AS count ${source}`).get(...args).count;
    const size = [10, 20, 50, 100].includes(Number(params.get('pageSize')))
      ? Number(params.get('pageSize'))
      : 20;
    const page = Math.max(
      1,
      Math.min(Math.ceil(filtered / size), Math.floor(Number(params.get('page'))) || 1),
    );
    const campaigns = this.db
      .prepare(
        `SELECT json_array_length(data,'$.customerIds') AS customerCount,json_remove(data,'$.customerIds','$.baselineCustomerIds','$.productScopes') AS data ${source} ORDER BY rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, size, (page - 1) * size)
      .map(({ data, customerCount }) => this.withStats({ ...JSON.parse(data), customerCount }));
    return { campaigns, filtered, page };
  }
  detail(id) {
    return { campaign: this.withStats(this.campaign(id)), deliveries: this.deliveries(id) };
  }
  generatorClient() {
    return (
      this.generator || createOutreachGenerator({ env: this.getEnv(), fetchImpl: this.fetchImpl })
    );
  }
  async state(params) {
    const mailboxes = this.mailboxes
      .list({ withBusinessNote: true })
      .map(({ signatureDesign, ...mailbox }) => mailbox);
    const { stats, total, cancelled, deliveryGroups } = this.deliveryCounts();
    const deliveryStats = { ...stats, total, cancelled };
    let generatorConfigured = false;
    try {
      generatorConfigured = !!this.generatorClient().configured;
    } catch {}
    if (params?.has('view')) {
      const counts = this.db
        .prepare(
          "SELECT count(*) AS total,count(*) FILTER (WHERE json_extract(data,'$.status')='active') AS active FROM outreach_campaigns",
        )
        .get();
      const page = ['current', 'history', 'tests'].includes(params.get('view'))
        ? this.campaignPage(params)
        : { campaigns: [], filtered: 0, page: 1 };
      const products = (params.get('view') === 'mailboxes' ? [] : this.products()).map(
        ({
          id,
          name,
          label,
          category,
          approved,
          status,
          brands,
          sourceUrl,
          materialOnly,
          materialCategory,
          version,
          effectiveDate,
        }) => ({
          id,
          name,
          label,
          category,
          approved,
          brands,
          sourceUrl,
          materialOnly,
          materialCategory,
          version,
          effectiveDate,
          status,
        }),
      );
      return {
        mailboxes,
        products,
        ...page,
        counts,
        reviewCount: this.db
          .prepare(
            "SELECT count(*) AS n FROM mail_reception WHERE state IN ('review','attention','uncertain')",
          )
          .get().n,
        deliveryStats,
        deliveryGroups,
        readiness: { generatorConfigured },
      };
    }
    const campaigns = this.campaigns();
    const followUps = this.followUps.all();
    const followUpStats = {
      sending: followUps.filter((item) => item.status === 'sending').length,
      active: followUps.filter((item) => {
        const campaign = campaigns.find((c) => c.id === item.campaignId);
        return (
          item.status === 'pending' &&
          campaign?.followUpEnabled &&
          !campaign.followUpPaused &&
          ['active', 'completed'].includes(campaign.status) &&
          this.acquisitionAllowed(campaign, true)
        );
      }).length,
    };
    return {
      mailboxes,
      campaigns,
      deliveryStats,
      deliveryGroups,
      followUpStats,
      products: this.products(),
      readiness: { generatorConfigured },
    };
  }
  saveCampaign(input, id) {
    const prior = id ? this.campaign(id) : null;
    if (prior?.acquisitionSource) throw fail(409, '请在获客任务中管理自动首发');
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
    const mailboxIds = list(input.mailboxIds);
    if (mailboxIds.some((v) => !this.mailboxes.get(v))) throw fail(400, '请选择存在的邮箱');
    const c = {
      id: prior?.id || randomUUID(),
      name,
      mode: 'production',
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
      followUpEnabled:
        input.followUpEnabled === undefined
          ? !!prior?.followUpEnabled
          : input.followUpEnabled === true,
      followUpPaused: !!prior?.followUpPaused,
      customerIds:
        input.customerIds === undefined ? (prior?.customerIds ?? []) : list(input.customerIds),
      createdAt: prior?.createdAt || iso(this.now),
      updatedAt: iso(this.now),
      scope: this.getScope(),
      baselineCustomerIds: prior?.baselineCustomerIds ?? null,
      lastError: '',
      sendWindow: input.sendWindow === undefined ? (prior?.sendWindow ?? null) : input.sendWindow,
    };
    c.productScopes = this.salesProducts()
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
  syncAcquisition() {
    if (this.closed) return;
    const sources = this.acquisitionSources();
    if (!sources.length) return;
    const campaigns = new Map(this.campaigns().map((campaign) => [campaign.id, campaign]));
    for (const source of sources) {
      if (source.scope !== this.getScope()) continue;
      const id = `acquisition-${source.jobId}`;
      const prior = campaigns.get(id);
      const campaign = prior || {
        id,
        name: source.name,
        mode: 'production',
        status: source.status,
        followUpEnabled: source.followUpEnabled === true,
        revision: 1,
        approvedRevision: 1,
        targetCount: null,
        intervalSeconds: 5,
        includeExisting: true,
        continuous: true,
        customerIds: [],
        filters: { markets: [], grades: [], products: [], categories: [] },
        baselineCustomerIds: [],
        scope: source.scope,
        createdAt: iso(this.now),
        approvedAt: iso(this.now),
        lastError: '',
        sendWindow: null,
      };
      const boxes = this.mailboxes
        .list()
        .filter(
          (box) =>
            box.configured &&
            !box.paused &&
            box.smtpStatus === 'connected' &&
            box.signature?.trim() &&
            box.displayName?.trim(),
        );
      const products = this.salesProducts().filter(
        (product) =>
          product.status === 'approved' &&
          boxes.some((box) => box.productIds?.includes(product.id)),
      );
      const configuration = {
        mailboxIds: boxes.map((box) => box.id),
        filters: { ...campaign.filters, products: products.map((product) => product.id) },
        productScopes: products.map(outreachProductScope),
      };
      const acquisitionSource = {
        jobId: source.jobId,
        scheduleId: source.scheduleId,
        roundId: source.roundId,
      };
      const changed =
        !prior ||
        campaign.status !== source.status ||
        JSON.stringify(campaign.customerIds) !== JSON.stringify(source.customerIds) ||
        JSON.stringify(campaign.acquisitionSource) !== JSON.stringify(acquisitionSource) ||
        Object.entries(configuration).some(
          ([key, value]) => JSON.stringify(campaign[key]) !== JSON.stringify(value),
        );
      if (!changed) continue;
      this.putCampaign({
        ...campaign,
        ...configuration,
        status: source.status,
        customerIds: source.customerIds,
        acquisitionSource,
        updatedAt: iso(this.now),
        lastRefreshAt: null,
      });
      if (source.status === 'cancelled' || source.status === 'completed') {
        for (const delivery of this.deliveries(id, ['draft', 'queued', 'blocked'])) {
          this.putDelivery({
            ...delivery,
            status: 'cancelled',
            reason:
              source.status === 'completed'
                ? '本轮首发已结束，新获客轮次已开始'
                : '获客自动首发已取消',
          });
          this.release(delivery.id);
        }
      }
    }
  }
  acquisitionAllowed(campaign, followUp = false) {
    return (
      !campaign.acquisitionSource ||
      this.acquisitionSources().some(
        (source) =>
          source.jobId === campaign.acquisitionSource.jobId &&
          source.scope === this.getScope() &&
          (source.status === 'active' ||
            (followUp && source.status === 'completed' && source.followUpsAllowed)),
      )
    );
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
  skipDelivery(delivery, reason, reasonCode = 'contact_unverified') {
    this.transaction(() => {
      const current = this.db
        .prepare('SELECT data FROM outreach_deliveries WHERE id=?')
        .get(delivery.id);
      if (current) {
        const saved = JSON.parse(current.data);
        if (saved.status === 'skipped') return;
        if (
          !['draft', 'queued', 'blocked'].includes(saved.status) ||
          saved.attemptedAt ||
          saved.messageId ||
          saved.sentAt
        )
          throw fail(409, '邮件已尝试发送，不能跳过本次首发');
      }
      this.putDelivery({
        ...delivery,
        status: 'skipped',
        reason,
        reasonCode,
        skippedAt: iso(this.now),
      });
      this.release(delivery.id);
    });
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
  salesProducts() {
    return this.products().filter((p) => !p.materialOnly);
  }
  materialReason(delivery, campaign = this.campaign(delivery.campaignId)) {
    if (delivery.mode !== 'production' || !delivery.candidate) return '';
    const product = this.products().find((row) => row.id === delivery.candidate.productId);
    const version = outreachMaterialVersion(product, campaign, new Date(this.now()));
    const mailbox = this.mailboxes.get(delivery.mailboxId);
    if (
      product &&
      mailbox &&
      (!siteAllowsProduct(product, mailbox) ||
        (delivery.senderWebsite &&
          (delivery.senderWebsite !== mailbox.website ||
            delivery.senderBrand !== mailbox.brandName)))
    )
      return '官网或负责品牌已变化，请重新准备邮件';
    return !version ||
      product.version !== delivery.productVersion ||
      (delivery.materialVersion && version !== delivery.materialVersion)
      ? '产品资料已更新、过期或不再适用，待重新准备邮件'
      : '';
  }
  refreshProductMaterials() {
    if (this.closed) return;
    for (const delivery of this.deliveries(undefined, ['draft', 'queued']).filter(
      (row) => row.mode === 'production',
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
      const canRefresh = this.deliveries(campaign.id, ['blocked']).some(
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
          this.prepare(campaign.id, false);
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
    let eligibleLeads = c.includeExisting
      ? leads
      : leads.filter((l) => !c.baselineCustomerIds.includes(l.id));
    const skipped = new Set(
      this.deliveries(c.id, ['skipped', 'failed'])
        .filter(
          (d) =>
            d.status === 'skipped' || (d.status === 'failed' && d.resolution?.outcome === 'failed'),
        )
        .map((d) => d.customerId),
    );
    eligibleLeads = eligibleLeads.filter((lead) => !skipped.has(lead.id));
    if (c.acquisitionSource) {
      const members = new Set(c.customerIds);
      const prepared = this.deliveries(c.id, ['blocked']).filter(
        (delivery) =>
          delivery.subject && delivery.acquisitionRoundId === c.acquisitionSource.roundId,
      );
      eligibleLeads = eligibleLeads.filter((lead) => {
        if (!members.has(lead.id)) return false;
        const draft = prepared.find((delivery) => delivery.customerId === lead.id);
        const mailbox = draft && this.mailboxes.get(draft.mailboxId);
        // Same-round configuration repairs cannot change a prepared email's sender identity.
        return !draft || (mailbox && draft.senderVersion === senderVersion(mailbox));
      });
    }
    const existing = ignoreDelivery ? this.delivery(ignoreDelivery) : null;
    const history = this.deliveryActivity()
      .concat(this.followUps.all())
      .filter((d) => d.id !== ignoreDelivery);
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
    const automaticSenders = c.acquisitionSource
      ? mailboxes.filter(
          (box) =>
            c.mailboxIds.includes(box.id) &&
            box.configured &&
            !box.paused &&
            box.smtpStatus === 'connected' &&
            box.signature?.trim() &&
            box.displayName?.trim(),
        )
      : mailboxes;
    const result = selectOutreachCandidates({
      leads: eligibleLeads,
      mailboxes: automaticSenders,
      products: c.acquisitionSource
        ? this.salesProducts().filter((product) => c.filters.products.includes(product.id))
        : this.salesProducts(),
      // Once a draft is reviewed its sender stays fixed. Workload only allocates
      // new customers; it must not move a queued email between accounts.
      campaign: existing
        ? {
            ...c,
            customerIds: [existing.customerId],
            mailboxIds: [existing.mailboxId],
            filters: { ...c.filters, products: [existing.candidate.productId] },
          }
        : {
            ...c,
            senderAssignments: this.deliveries(c.id, ['blocked'])
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
      if (this.identities(candidate).some((key) => identities.has(key) || stopped.has(key)))
        blocked.push({
          ...candidate,
          reasonCode: 'already_contacted_or_unknown',
          reason: '已有发送安排、沟通记录或停止联系标记',
        });
      else eligible.push(candidate);
    }
    return { eligible, blocked };
  }
  prepare(id, includeDetail = true) {
    const c = this.campaign(id);
    if (['cancelled', 'completed'].includes(c.status))
      throw fail(409, '计划已结束，不能重新准备样稿');
    if (this.preparing.has(id)) return includeDetail ? this.detail(id) : undefined;
    if (c.mode !== 'production') throw fail(400, '测试计划使用固定测试内容');
    if (!c.mailboxIds.length && !c.acquisitionSource) throw fail(400, '请先选择发件邮箱');
    if (!this.acquisitionAllowed(c)) throw fail(409, '获客自动首发已暂停或关闭');
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
            status:
              current.status === 'paused'
                ? 'paused'
                : wasActive
                  ? c.acquisitionSource
                    ? 'active'
                    : 'paused'
                  : 'draft',
            lastError: safeError(error),
          });
      })
      .finally(() => this.preparing.delete(id));
    this.preparationQueue = operation;
    this.preparing.set(id, operation);
    return includeDetail ? this.detail(id) : undefined;
  }
  async prepareDrafts(id, revision, wasActive) {
    const c = this.campaign(id);
    if (this.closed || c.revision !== revision || ['paused', 'cancelled'].includes(c.status))
      return;
    const result = await this.candidates(c);
    const latest = this.campaign(id);
    if (
      this.closed ||
      latest.revision !== revision ||
      ['paused', 'cancelled'].includes(latest.status)
    )
      return;
    let slots =
      (c.acquisitionSource ? Infinity : c.targetCount) -
      this.db
        .prepare(
          "SELECT count(*) AS n FROM outreach_deliveries WHERE campaign_id=? AND state NOT IN ('blocked','cancelled','skipped')",
        )
        .get(id).n;
    const configurationIssues = new Map();
    for (const candidate of result.blocked.slice(0, c.acquisitionSource ? undefined : 200)) {
      if (customerSkipCodes.has(candidate.reasonCode)) {
        const prior = this.deliveries(id, undefined, candidate.customerId).find(
          (d) => d.customerId === candidate.customerId && d.status !== 'cancelled',
        );
        if (
          !prior ||
          (['draft', 'queued', 'blocked'].includes(prior.status) &&
            !prior.attemptedAt &&
            !prior.messageId &&
            !prior.sentAt)
        )
          this.skipDelivery(
            prior || {
              id: randomUUID(),
              campaignId: id,
              mode: 'production',
              customerId: candidate.customerId,
              companyName: candidate.companyName,
              to: '',
              mailboxId: '',
              from: '',
              subject: '',
              bodyText: '',
              createdAt: iso(this.now),
            },
            candidate.reason,
            candidate.reasonCode,
          );
        continue;
      }
      // Account configuration and capacity are plan-level conditions, not customer tasks.
      if (candidate.reasonCode) {
        configurationIssues.set(
          candidate.reason,
          (configurationIssues.get(candidate.reason) || 0) + 1,
        );
        for (const old of this.deliveries(id, ['blocked'], candidate.customerId).filter(
          (delivery) =>
            delivery.customerId === candidate.customerId &&
            !delivery.subject &&
            !delivery.bodyText &&
            !delivery.attemptedAt &&
            !delivery.materialRefresh,
        )) {
          this.putDelivery({ ...old, status: 'cancelled', reason: '发件或产品配置待修复，未提交' });
          this.release(old.id);
        }
        continue;
      }
      const priorBlocked = this.deliveries(id, ['blocked'], candidate.customerId).find(
        (d) =>
          d.customerId === candidate.customerId && d.status === 'blocked' && !d.materialRefresh,
      );
      if (c.acquisitionSource && priorBlocked && priorBlocked.reason !== candidate.reason)
        this.putDelivery({ ...priorBlocked, reason: candidate.reason || candidate.reasonCode });
      if (
        this.deliveries(id, undefined, candidate.customerId).some(
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
        if (
          this.campaign(id).revision !== revision ||
          ['paused', 'cancelled'].includes(this.campaign(id).status)
        )
          return;
        const mailbox = this.mailboxes.get(candidate.mailboxId),
          product = this.products().find((p) => p.id === candidate.productId);
        // Retry an empty, unsubmitted draft in place instead of accumulating cancellations.
        const unfinished = this.deliveries(id, ['blocked'], candidate.customerId).find(
          (delivery) =>
            delivery.customerId === candidate.customerId &&
            delivery.status === 'blocked' &&
            !delivery.subject &&
            !delivery.bodyText &&
            !delivery.attemptedAt &&
            !delivery.messageId,
        );
        const replaced = this.deliveries(id, ['blocked'], candidate.customerId).find(
          (delivery) =>
            delivery.customerId === candidate.customerId &&
            delivery.status === 'blocked' &&
            delivery.materialRefresh,
        );
        if (!mailbox?.signature?.trim()) {
          const reason = '请先配置并确认该邮箱的发件签名';
          configurationIssues.set(reason, (configurationIssues.get(reason) || 0) + 1);
          if (unfinished?.reason === reason) {
            this.putDelivery({
              ...unfinished,
              status: 'cancelled',
              reason: '发件配置待修复，未提交',
            });
            this.release(unfinished.id);
          }
          continue;
        }
        const template = this.followUps.policy();
        const d = {
          firstTemplateRevision: template.revision,
          id: unfinished?.id || randomUUID(),
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
          createdAt: unfinished?.createdAt || iso(this.now),
          candidate,
          revision,
          acquisitionRoundId: c.acquisitionSource?.roundId,
          senderWebsite: mailbox.website,
          senderBrand: mailbox.brandName,
          senderVersion: senderVersion(mailbox),
          productVersion: product.version,
          materialVersion:
            candidate.materialVersion || outreachMaterialVersion(product, c, new Date(this.now())),
          ...(replaced
            ? {
                replacesDeliveryId:
                  replaced.id === unfinished?.id ? replaced.replacesDeliveryId : replaced.id,
                materialRefresh: true,
              }
            : {}),
        };
        try {
          this.transaction(() => {
            this.reserve(d);
            for (const prior of this.deliveries(id, ['blocked'], d.customerId))
              if (
                prior.id !== d.id &&
                prior.customerId === d.customerId &&
                prior.status === 'blocked'
              )
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
            firstInstruction: template.firstInstruction,
            firstBodyInstruction: template.firstBodyInstruction,
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
            status: wasActive && current.approvedRevision === revision ? 'queued' : 'draft',
            reason: '',
            sourceIds: generated.sourceIds || [],
            productClaimIds: generated.factIds || [],
            productFacts: eligibleOutreachFacts(product, c, new Date(this.now())).filter((fact) =>
              (generated.factIds || []).includes(fact.id),
            ),
          });
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
    if (current.revision === revision && !['paused', 'cancelled'].includes(current.status)) {
      const deliveries = this.db
        .prepare(
          "SELECT state AS status, CASE WHEN state='blocked' THEN json_extract(data,'$.reason') END AS reason FROM outreach_deliveries WHERE campaign_id=? ORDER BY rowid",
        )
        .all(id);
      const pending = deliveries.some((d) => ['draft', 'queued', 'sending'].includes(d.status));
      const reasons = new Map();
      for (const delivery of deliveries.filter((d) => d.status === 'blocked')) {
        const reason = delivery.reason || '条件尚未补齐';
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
      for (const [reason, count] of configurationIssues)
        reasons.set(reason, (reasons.get(reason) || 0) + count);
      const summary = [...reasons]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, count]) => `${count} 家：${reason}`)
        .join('；');
      this.putCampaign({
        ...current,
        status: wasActive ? 'active' : 'ready',
        preparedAt: iso(this.now),
        waitingReason: configurationIssues.size ? summary : '',
        lastError: pending
          ? ''
          : summary
            ? `暂未生成邮件。${summary}。请打开“执行详情”查看。`
            : deliveries.some((d) => d.status === 'skipped')
              ? ''
              : '当前没有可加入的未开发客户',
      });
    }
  }
  activate(id, revision) {
    const c = this.campaign(id);
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
      if (d.status === 'draft' && d.subject) this.putDelivery({ ...d, status: 'queued' });
    this.start();
    if (!this.deliveries(id, ['queued']).length) this.prepare(id, false);
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
    if (this.isMaintaining()) return false;
    if (!this.acquisitionAllowed(c, Boolean(d.firstId))) return false;
    if (!m || m.paused || m.smtpStatus !== 'connected' || !m.configured) return false;
    if (c.mode === 'internal_test') return true;
    if (c.approvedRevision !== c.revision || !this.inWindow(c)) return false;
    return this.replyCapacity(m, c.intervalSeconds);
  }
  replyCapacity(m, interval = 0, except = '') {
    const replies = this.db
      .prepare(
        `SELECT json_extract(data,'$.createdAt') AS attemptedAt, status FROM mail_reply_operations WHERE
      json_extract(data,'$.mailboxId')=? AND idempotency_key<>? AND status IN ('accepted','sending','unknown','failed') AND json_extract(data,'$.createdAt')>=?`,
      )
      .all(m.id, except, new Date(this.now() - 86400000).toISOString())
      .map((r) => ({ ...r, mailboxId: m.id }));
    const history = this.deliveryActivity()
      .concat(replies)
      .concat(this.followUps.all())
      .filter(
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
    return this.now() - last >= Math.max(interval || 0, m.intervalSeconds || 0) * 1000;
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }
  tick() {
    if (this.closed || this.isMaintaining()) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runTick()
      .catch(() => {})
      .finally(() => (this.running = null));
    return this.running;
  }
  async runTick() {
    if (
      typeof this.mailboxes.readMailbox === 'function' &&
      (!this.lastMailboxSync || this.now() - this.lastMailboxSync >= 60000)
    ) {
      this.lastMailboxSync = this.now();
      await this.conversations.sync().catch(() => {});
    }
    if (this.isMaintaining()) return;
    const unchecked = this.db
      .prepare(
        "SELECT id FROM outreach_deliveries WHERE state='unknown' AND json_extract(data,'$.mode')='production' AND json_extract(data,'$.autoReconcilePending')=1 AND json_extract(data,'$.reconciliation') IS NULL LIMIT 1",
      )
      .get();
    if (unchecked) await this.reconcileDelivery(unchecked.id);
    if (this.isMaintaining()) return;
    this.syncAcquisition();
    this.refreshProductMaterials();
    const campaigns = this.campaigns().filter((c) => c.status === 'active');
    const used = new Set();
    for (const summary of campaigns) {
      if (this.closed || this.isMaintaining()) break;
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
      for (const d of this.deliveries(c.id, ['queued'])) {
        if (used.has(d.mailboxId)) continue;
        const m = this.mailboxes.get(d.mailboxId);
        if (!this.canDispatch(c, d, m)) continue;
        used.add(d.mailboxId);
        await this.dispatch(c, d, m);
      }
      if (this.closed || this.isMaintaining()) break;
      const current = this.campaign(c.id);
      if (current.status !== 'active') continue;
      const rows = this.db
        .prepare(
          `SELECT state AS status,
          CASE WHEN state='blocked' THEN json_extract(data,'$.materialRefresh') ELSE 0 END AS materialRefresh
         FROM outreach_deliveries WHERE campaign_id=?`,
        )
        .all(c.id);
      const consumed = rows.filter((d) =>
        ['accepted', 'unknown', 'sending', 'failed'].includes(d.status),
      ).length;
      if (c.mode === 'internal_test' && rows.every((d) => terminal.has(d.status)))
        this.putCampaign({
          ...current,
          status: rows.every((d) => d.status === 'accepted') ? 'completed' : 'paused',
        });
      else if (
        !c.acquisitionSource &&
        consumed >= c.targetCount &&
        !rows.some((d) => ['queued', 'sending'].includes(d.status))
      )
        this.putCampaign({ ...current, status: 'completed' });
      else if (
        c.mode === 'production' &&
        (c.continuous || c.waitingReason) &&
        !this.preparing.has(c.id) &&
        (!current.lastRefreshAt || this.now() - Date.parse(current.lastRefreshAt) > 60000)
      ) {
        this.putCampaign({ ...current, lastRefreshAt: iso(this.now) });
        try {
          this.prepare(c.id, false);
        } catch (error) {
          if (!c.acquisitionSource) throw error;
          this.putCampaign({ ...this.campaign(c.id), lastError: safeError(error) });
        }
      } else if (
        c.mode === 'production' &&
        !c.continuous &&
        !rows.some((d) => ['draft', 'queued', 'sending'].includes(d.status)) &&
        !rows.some((d) => d.status === 'blocked' && d.materialRefresh) &&
        !c.waitingReason &&
        !this.preparing.has(c.id)
      ) {
        const skippedWithoutBlockers =
          rows.some((d) => d.status === 'skipped') && !rows.some((d) => d.status === 'blocked');
        this.putCampaign({
          ...current,
          status: 'paused',
          lastError: skippedWithoutBlockers
            ? ''
            : `本轮已提交 ${consumed} / ${c.targetCount} 封，剩余客户或邮件条件待处理，请查看执行详情。`,
        });
      }
    }
    await this.followUps.tick();
    await this.reception.tick();
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
        const customerBlock = result.blocked.find(
          (row) => row.customerId === d.customerId && customerSkipCodes.has(row.reasonCode),
        );
        if (customerBlock) {
          this.skipDelivery(d, customerBlock.reason, customerBlock.reasonCode);
          return;
        }
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
        (latestCampaign.approvedRevision !== c.revision || this.isReserved(d.candidate, d.id)))
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
            if (this.isMaintaining())
              throw Object.assign(fail(503, '发布维护，邮件保留在队列中'), {
                code: 'OUTREACH_MAINTENANCE',
              });
            const campaign = this.campaign(c.id);
            const reason =
              (c.mode === 'production' && campaign.scope !== this.getScope()
                ? '客户数据来源已改变，邮件尚未提交发送'
                : '') ||
              (c.mode === 'production' && this.materialReason(d, campaign)) ||
              (campaign.status !== 'active' ||
              campaign.revision !== c.revision ||
              !this.acquisitionAllowed(campaign)
                ? '计划已暂停或更新，邮件尚未提交发送'
                : '') ||
              (c.mode === 'production' && campaign.approvedRevision !== c.revision
                ? '当前计划授权已失效，请重新核对'
                : '') ||
              (senderVersion(this.mailboxes.get(m.id)) !== d.senderVersion
                ? '发件身份已变化，邮件尚未提交发送'
                : '') ||
              (c.mode === 'production' && this.isReserved(d.candidate, d.id)
                ? '客户联系安排已变化，请重新检查'
                : '');
            if (reason)
              throw Object.assign(fail(409, reason), { code: 'OUTREACH_PRE_SEND_BLOCKED' });
            // Freeze the policy immediately before SMTP handoff, after transport setup.
            this.transaction(() => {
              pending.submittedAt = iso(this.now);
              pending.followUpAtSubmission =
                campaign.mode === 'production' && campaign.followUpEnabled === true;
              if (pending.followUpAtSubmission)
                pending.sequencePolicyRevision = this.followUps.policy().revision;
              this.putDelivery(pending);
            });
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
      const completed = this.transaction(() => {
        const saved = this.putDelivery({
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
        if (accepted && pending.followUpAtSubmission)
          this.followUps.schedule(saved, this.campaign(c.id));
        return saved;
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
      if (error.code === 'OUTREACH_MAINTENANCE') {
        this.putDelivery(d);
        return;
      }
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
  async reconcileDelivery(id) {
    const delivery = this.delivery(id);
    if (delivery.status !== 'unknown' || delivery.mode !== 'production')
      throw fail(409, '只能核实正式发送中结果未知的记录');
    let syncError = '';
    if (typeof this.mailboxes.readMailbox === 'function') {
      try {
        const result = await this.conversations.sync({ mailboxId: delivery.mailboxId });
        syncError =
          result.mailboxes.find((mailbox) => mailbox.mailboxId === delivery.mailboxId)?.error || '';
      } catch (error) {
        syncError = safeError(error);
      }
    }
    const { result, acceptedNow } = this.transaction(() => {
      const current = this.delivery(id);
      if (current.status !== 'unknown') return { result: current, acceptedNow: false };
      const evidence = this.conversations.sentEvidence(current);
      const reconciliation = {
        at: iso(this.now),
        result: evidence ? 'sent' : 'unconfirmed',
        evidence: evidence
          ? `原邮箱已发送：${evidence.folder}，UID ${evidence.uid}，Message-ID ${evidence.messageId}`
          : syncError || '未找到足以确认发送结果的证据',
      };
      const result = this.putDelivery({
        ...current,
        ...(evidence
          ? {
              status: 'accepted',
              reason: '',
              sentAt: evidence.occurredAt || current.attemptedAt,
              resolution: {
                outcome: 'accepted',
                source: 'imap',
                evidence: reconciliation.evidence,
                at: reconciliation.at,
              },
            }
          : {}),
        reconciliation,
      });
      if (evidence && current.followUpAtSubmission === true)
        this.followUps.schedule(result, this.campaign(current.campaignId));
      return { result, acceptedNow: !!evidence };
    });
    if (acceptedNow && this.recordAccepted) {
      try {
        await this.recordAccepted(result);
        return this.putDelivery({ ...result, businessRecordedAt: iso(this.now), recordError: '' });
      } catch (error) {
        return this.putDelivery({
          ...result,
          recordError: '发送已核实，客户业务记录待核对：' + safeError(error),
        });
      }
    }
    return result;
  }
  async resolveDelivery(id, { outcome, evidence, operator } = {}) {
    if (!['accepted', 'failed'].includes(outcome)) throw fail(400, '请选择核实结果');
    if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000)
      throw fail(400, '请填写核实依据（最多 2000 字）');
    if (typeof operator !== 'string' || !operator.trim() || operator.length > 100)
      throw fail(400, '请填写操作人（最多 100 字）');
    const result = this.transaction(() => {
      const current = this.delivery(id);
      if (current.status !== 'unknown' || current.mode !== 'production')
        throw fail(409, '只能处理正式发送中结果未知的记录');
      if (outcome === 'failed' && this.conversations.sentEvidence(current))
        throw fail(409, '原邮箱已有已发送证据，不能确认未提交');
      const resolved = this.putDelivery({
        ...current,
        status: outcome,
        reason: outcome === 'accepted' ? '' : '人工核实未成功提交，本次首发已结束',
        sentAt: outcome === 'accepted' ? current.attemptedAt : null,
        resolution: {
          outcome,
          source: 'manual',
          evidence: evidence.trim(),
          operator: operator.trim(),
          at: iso(this.now),
        },
      });
      if (outcome === 'failed') this.release(id);
      if (outcome === 'accepted' && current.followUpAtSubmission === true)
        this.followUps.schedule(resolved, this.campaign(current.campaignId));
      return resolved;
    });
    if (outcome === 'accepted' && this.recordAccepted) {
      try {
        await this.recordAccepted(result);
        return this.putDelivery({ ...result, businessRecordedAt: iso(this.now), recordError: '' });
      } catch (error) {
        return this.putDelivery({
          ...result,
          recordError: '发送已核实，客户业务记录待核对：' + safeError(error),
        });
      }
    }
    return result;
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
