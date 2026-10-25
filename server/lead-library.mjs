import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');
const contentVersion = (value) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        plainObject(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest('hex');

function validateLead(lead) {
  if (
    !plainObject(lead) ||
    typeof lead.id !== 'string' ||
    !lead.id ||
    typeof lead.name !== 'string' ||
    !Array.isArray(lead.facts) ||
    !Array.isArray(lead.contactEvidence) ||
    !plainObject(lead.fields)
  )
    throw fail(502, '飞书客户数据不完整，已保留上次成功同步的数据');
}

function ratingSummary(lead) {
  const lines = text(lead.assessment?.evidenceReason || lead.ratingReason)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const pending = lines.find((line) => /^(待补充依据|待补充)[:：]/.test(line));
  const reason =
    (['待核实', '待补全', '未评级'].includes(lead.grade) ? pending : '') ||
    lines.find((line) => /^(主营产品|明确经营品类|专业供货角色|综合供货角色)[:：]/.test(line)) ||
    (['待核实', '待补全', '未评级'].includes(lead.grade) ? '关键依据待补充' : '查看评级依据');
  return reason.length > 46 ? reason.slice(0, 45) + '…' : reason;
}

function contactSummary(lead) {
  const count = (value) =>
    text(value)
      .split(/\n|[、；;]/)
      .map((item) => item.trim())
      .filter(Boolean).length;
  if (lead.email && lead.phone)
    return {
      label: '邮箱与电话已记录',
      detail: `${count(lead.email)} 个邮箱 · ${count(lead.phone)} 个电话`,
    };
  if (lead.email) return { label: '已记录邮箱', detail: `${count(lead.email)} 个公开邮箱入口` };
  if (lead.phone) return { label: '已记录电话', detail: `${count(lead.phone)} 个公开电话入口` };
  const forms = (lead.contactEvidence || []).filter((entry) => entry.kind === 'form');
  if (forms.length) return { label: '已有联系表单', detail: `${forms.length} 个官网表单` };
  return { label: '联系入口待补', detail: '未发现公开邮箱或办公电话' };
}

// Persist the projection separately so a list read never parses the research dossier.
export function summarizeLead(lead) {
  const fields = [
    'id',
    'name',
    'domain',
    'market',
    'type',
    'product',
    'score',
    'grade',
    'status',
    'city',
    'contact',
    'email',
    'phone',
    'website',
    'source',
    'updatedAt',
  ];
  const buyers = Array.isArray(lead.customsEvidence) ? lead.customsEvidence : [];
  return {
    version: contentVersion(lead),
    ...Object.fromEntries(
      fields.map((key) => [key, lead[key] ?? (['score', 'updatedAt'].includes(key) ? null : '')]),
    ),
    companyIdentity: lead.companyIdentity
      ? {
          legal_name: lead.companyIdentity.legal_name ?? null,
          website_name: lead.companyIdentity.website_name ?? null,
          aliases: lead.companyIdentity.aliases || [],
          status: lead.companyIdentity.status || '',
        }
      : null,
    ratingSummary: ratingSummary(lead),
    contactSummary: contactSummary(lead),
    customsSummary: {
      recordCount: new Set(
        buyers.flatMap((buyer) =>
          (buyer.records || []).map((record) => `${record.provider || ''}:${record.id}`),
        ),
      ).size,
      buyerCount: buyers.length,
      unverified: buyers.some((buyer) => buyer.match?.status !== 'verified'),
    },
  };
}

export class LeadLibrary {
  constructor({
    path = ':memory:',
    scope = '',
    readLeads,
    now = Date.now,
    ttlMs = 60000,
    retryMs = 15000,
    intervalMs = 60000,
    idleAfterMs = 120000,
    idleIntervalMs = 300000,
    monotonicNow = () => performance.now(),
  }) {
    if (typeof readLeads !== 'function') throw new TypeError('readLeads must be a function');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.scope = scope;
    this.readLeads = readLeads;
    this.now = now;
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.activeIntervalMs = intervalMs;
    this.idleAfterMs = idleAfterMs;
    this.idleIntervalMs = idleIntervalMs;
    this.lastActivityAt = now();
    this.monotonicNow = monotonicNow;
    this.error = '';
    this.lastAttemptAt = null;
    this.pending = null;
    this.refreshChanges = null;
    this.closed = false;
    this.invalidated = false;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS lead_library_customers (
        scope TEXT NOT NULL, record_id TEXT NOT NULL, position INTEGER NOT NULL,
        summary TEXT NOT NULL, detail TEXT NOT NULL, version TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(scope,record_id)
      );
      CREATE INDEX IF NOT EXISTS lead_library_order ON lead_library_customers(scope,position);
      CREATE TABLE IF NOT EXISTS lead_library_sync (
        scope TEXT PRIMARY KEY, synced_at TEXT NOT NULL, refreshed_at INTEGER NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lead_library_metrics (
        scope TEXT PRIMARY KEY, data TEXT NOT NULL
      );`);
    this.migrateVersions();
    this.meta = this.db
      .prepare('SELECT synced_at,refreshed_at,revision FROM lead_library_sync WHERE scope=?')
      .get(scope);
    const metrics = this.db
      .prepare('SELECT data FROM lead_library_metrics WHERE scope=?')
      .get(scope);
    this.syncMetrics = metrics
      ? JSON.parse(metrics.data)
      : { attempts: 0, successes: 0, failures: 0, last: null };
    if (this.syncMetrics.last?.at) this.lastAttemptAt = Date.parse(this.syncMetrics.last.at);
    if (this.syncMetrics.last?.status === 'failed')
      this.error = '飞书同步失败，已保留上次成功同步的数据，请稍后重试';
  }

  migrateVersions() {
    // Upgrade the prior read replica in place; dossiers, ordering and revision remain intact.
    const columns = this.db.prepare('PRAGMA table_info(lead_library_customers)').all();
    if (!columns.some((column) => column.name === 'version'))
      this.db.exec(
        "ALTER TABLE lead_library_customers ADD COLUMN version TEXT NOT NULL DEFAULT ''",
      );
    const rows = this.db
      .prepare("SELECT scope,record_id,detail FROM lead_library_customers WHERE version=''")
      .all();
    if (!rows.length) return;
    const backfill = rows.map((row) => {
      const summary = summarizeLead(JSON.parse(row.detail));
      return { ...row, version: summary.version, summary: JSON.stringify(summary) };
    });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(
        'UPDATE lead_library_customers SET version=?,summary=? WHERE scope=? AND record_id=?',
      );
      for (const row of backfill) update.run(row.version, row.summary, row.scope, row.record_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  assertOpen() {
    if (this.closed) throw fail(503, '客户库正在关闭，请稍后重试');
  }

  get refreshing() {
    return !!this.pending;
  }

  touch() {
    this.assertOpen();
    this.lastActivityAt = Math.max(this.lastActivityAt, this.now());
  }

  get mode() {
    return this.now() - this.lastActivityAt >= this.idleAfterMs ? 'idle' : 'active';
  }

  get intervalMs() {
    return this.mode === 'idle' ? this.idleIntervalMs : this.activeIntervalMs;
  }

  metrics() {
    return structuredClone(this.syncMetrics);
  }

  saveMetrics() {
    this.db
      .prepare('INSERT OR REPLACE INTO lead_library_metrics(scope,data) VALUES(?,?)')
      .run(this.scope, JSON.stringify(this.syncMetrics));
  }

  stale() {
    return !this.meta || this.invalidated || this.now() - this.meta.refreshed_at >= this.ttlMs;
  }

  metadata() {
    return {
      syncedAt: this.meta?.synced_at || null,
      total: this.db
        .prepare('SELECT count(*) AS count FROM lead_library_customers WHERE scope=?')
        .get(this.scope).count,
      source: 'feishu',
      scope: this.scope,
      sync: {
        refreshing: !!this.pending,
        stale: this.stale(),
        error: this.error,
        lastAttemptAt:
          this.lastAttemptAt === null ? null : new Date(this.lastAttemptAt).toISOString(),
        revision: this.meta?.revision || 0,
        mode: this.mode,
        intervalMs: this.intervalMs,
        metrics: this.metrics(),
      },
    };
  }

  snapshot(full = false) {
    const column = full ? 'detail' : 'summary';
    return {
      leads: this.db
        .prepare(
          `SELECT ${column} AS data FROM lead_library_customers WHERE scope=? ORDER BY position,record_id`,
        )
        .all(this.scope)
        .map((row) => JSON.parse(row.data)),
      ...this.metadata(),
    };
  }

  async ensure() {
    this.assertOpen();
    if (!this.meta) {
      await this.refresh();
      this.assertOpen();
    } else if (
      this.stale() &&
      !this.pending &&
      (!this.error ||
        this.lastAttemptAt === null ||
        this.now() - this.lastAttemptAt >= this.retryMs)
    ) {
      void this.refresh().catch(() => {});
    }
  }

  async list() {
    await this.ensure();
    return this.snapshot();
  }

  async all() {
    await this.ensure();
    return this.snapshot(true);
  }

  async detail(id) {
    await this.ensure();
    const row = this.db
      .prepare('SELECT detail,version FROM lead_library_customers WHERE scope=? AND record_id=?')
      .get(this.scope, id);
    if (!row) throw fail(404, '客户不存在，请刷新客户库');
    return { lead: JSON.parse(row.detail), version: row.version, ...this.metadata() };
  }

  refresh({ afterCurrent = false } = {}) {
    this.assertOpen();
    if (afterCurrent && this.pending)
      return this.pending.catch(() => {}).then(() => this.refresh());
    if (this.pending) return this.pending;
    this.lastAttemptAt = this.now();
    const startedAt = this.lastAttemptAt;
    const startedClock = this.monotonicNow();
    let upstreamMs = 0;
    let writeMs = 0;
    this.syncMetrics.attempts++;
    this.saveMetrics();
    const changes = new Map();
    this.refreshChanges = changes;
    const invalidatedAtStart = this.invalidated;
    this.invalidated = false;
    this.pending = Promise.resolve()
      .then(async () => {
        this.assertOpen();
        const upstreamStarted = this.monotonicNow();
        try {
          return await this.readLeads();
        } finally {
          upstreamMs = Math.max(0, this.monotonicNow() - upstreamStarted);
        }
      })
      .then((data) => {
        this.assertOpen();
        if (!plainObject(data) || !Array.isArray(data.leads))
          throw fail(502, '飞书客户数据不完整，已保留上次成功同步的数据');
        const records = new Map();
        for (const lead of data.leads) {
          validateLead(lead);
          if (records.has(lead.id)) throw fail(502, '飞书客户记录重复，已保留上次成功同步的数据');
          records.set(lead.id, lead);
        }
        if (data.total !== undefined && data.total !== data.leads.length)
          throw fail(502, '飞书客户分页不完整，已保留上次成功同步的数据');
        for (const [id, lead] of changes) records.set(id, lead);
        const syncedAt =
          typeof data.syncedAt === 'string' && Number.isFinite(Date.parse(data.syncedAt))
            ? data.syncedAt
            : new Date(this.now()).toISOString();
        // Validate and serialize the complete response before changing any saved rows.
        const serialized = [...records.values()].map((lead, position) => {
          const summary = summarizeLead(lead);
          return {
            id: lead.id,
            position,
            version: summary.version,
            summary: JSON.stringify(summary),
            detail: JSON.stringify(lead),
          };
        });
        const prior = new Map(
          this.db
            .prepare('SELECT record_id,position,version FROM lead_library_customers WHERE scope=?')
            .all(this.scope)
            .map((row) => [row.record_id, row]),
        );
        const counts = {
          total: serialized.length,
          inserted: 0,
          updated: 0,
          deleted: 0,
          unchanged: 0,
          reordered: 0,
          rowsWritten: 0,
        };
        const writes = [];
        for (const row of serialized) {
          const old = prior.get(row.id);
          if (!old) {
            counts.inserted++;
            writes.push({ kind: 'insert', row });
          } else {
            prior.delete(row.id);
            if (old.version !== row.version) {
              counts.updated++;
              writes.push({ kind: 'update', row });
            } else {
              counts.unchanged++;
              if (old.position !== row.position) writes.push({ kind: 'reorder', row });
            }
            if (old.position !== row.position) counts.reordered++;
          }
        }
        counts.deleted = prior.size;
        counts.rowsWritten = writes.length + counts.deleted;
        const meta = {
          synced_at: syncedAt,
          refreshed_at: this.now(),
          revision: (this.meta?.revision || 0) + (counts.rowsWritten ? 1 : 0),
        };
        const writeStarted = this.monotonicNow();
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const insert = this.db.prepare(
            'INSERT INTO lead_library_customers(scope,record_id,position,summary,detail,version) VALUES(?,?,?,?,?,?)',
          );
          const update = this.db.prepare(
            'UPDATE lead_library_customers SET position=?,summary=?,detail=?,version=? WHERE scope=? AND record_id=?',
          );
          const reorder = this.db.prepare(
            'UPDATE lead_library_customers SET position=? WHERE scope=? AND record_id=?',
          );
          const remove = this.db.prepare(
            'DELETE FROM lead_library_customers WHERE scope=? AND record_id=?',
          );
          for (const { kind, row } of writes) {
            if (kind === 'insert')
              insert.run(this.scope, row.id, row.position, row.summary, row.detail, row.version);
            else if (kind === 'update')
              update.run(row.position, row.summary, row.detail, row.version, this.scope, row.id);
            else reorder.run(row.position, this.scope, row.id);
          }
          for (const id of prior.keys()) remove.run(this.scope, id);
          this.db
            .prepare(
              'INSERT OR REPLACE INTO lead_library_sync(scope,synced_at,refreshed_at,revision) VALUES(?,?,?,?)',
            )
            .run(this.scope, meta.synced_at, meta.refreshed_at, meta.revision);
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
        writeMs = Math.max(0, this.monotonicNow() - writeStarted);
        this.meta = meta;
        this.error = '';
        this.syncMetrics.successes++;
        this.syncMetrics.last = {
          at: new Date(startedAt).toISOString(),
          status: 'success',
          durationMs: Math.max(0, this.monotonicNow() - startedClock),
          upstreamMs,
          writeMs,
          ...counts,
        };
        this.saveMetrics();
      })
      .catch(() => {
        if (!this.closed) {
          this.invalidated ||= invalidatedAtStart;
          this.error = '飞书同步失败，已保留上次成功同步的数据，请稍后重试';
          this.syncMetrics.failures++;
          this.syncMetrics.last = {
            at: new Date(startedAt).toISOString(),
            status: 'failed',
            durationMs: Math.max(0, this.monotonicNow() - startedClock),
            upstreamMs,
            writeMs,
            total: this.metadata().total,
            inserted: 0,
            updated: 0,
            deleted: 0,
            unchanged: 0,
            reordered: 0,
            rowsWritten: 0,
          };
          this.saveMetrics();
        }
        throw fail(502, '飞书同步失败，已保留上次成功同步的数据，请稍后重试');
      })
      .finally(() => {
        this.pending = null;
        this.refreshChanges = null;
      })
      .then(() => {
        this.assertOpen();
        return this.snapshot();
      });
    return this.pending;
  }

  upsert(patch) {
    this.assertOpen();
    if (!plainObject(patch) || typeof patch.id !== 'string' || !patch.id)
      throw fail(400, '客户编号无效');
    const prior = this.db
      .prepare(
        'SELECT detail,position,version FROM lead_library_customers WHERE scope=? AND record_id=?',
      )
      .get(this.scope, patch.id);
    const lead = { ...(prior ? JSON.parse(prior.detail) : {}), ...patch };
    validateLead(lead);
    const projection = summarizeLead(lead);
    if (prior?.version === projection.version) {
      if (this.refreshChanges) this.refreshChanges.set(lead.id, structuredClone(lead));
      return lead;
    }
    const summary = JSON.stringify(projection);
    const detail = JSON.stringify(lead);
    const position =
      prior?.position ??
      this.db
        .prepare(
          'SELECT coalesce(max(position)+1,0) AS position FROM lead_library_customers WHERE scope=?',
        )
        .get(this.scope).position;
    const revision = (this.meta?.revision || 0) + 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO lead_library_customers(scope,record_id,position,summary,detail,version)
          VALUES(?,?,?,?,?,?) ON CONFLICT(scope,record_id) DO UPDATE SET
          summary=excluded.summary,detail=excluded.detail,version=excluded.version`,
        )
        .run(this.scope, lead.id, position, summary, detail, projection.version);
      if (this.meta)
        this.db
          .prepare('UPDATE lead_library_sync SET revision=? WHERE scope=?')
          .run(revision, this.scope);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (this.meta) this.meta.revision = revision;
    if (this.refreshChanges) this.refreshChanges.set(lead.id, JSON.parse(detail));
    return lead;
  }

  invalidate() {
    this.assertOpen();
    this.invalidated = true;
    this.lastAttemptAt = null;
  }

  start() {
    this.assertOpen();
    if (this.timer || this.activeIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.activeIntervalMs);
    this.timer.unref();
  }

  async tick() {
    if (this.closed || !this.meta || this.pending) return false;
    if (this.error && this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < this.retryMs)
      return false;
    const since = Math.max(this.meta.refreshed_at, this.lastAttemptAt ?? 0);
    if (!this.invalidated && this.now() - since < this.intervalMs) return false;
    await this.refresh();
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.db.close();
  }
}
