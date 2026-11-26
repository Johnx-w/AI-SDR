import { addressRegion, regionChoices, regionKeywords } from './library-regions.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isDevelopmentCustomer } from './customer-eligibility.mjs';
import { marketLabel, leadProductCategories } from '../src/domain/lead-library-filters.ts';

const eligible = "coalesce(json_extract(summary,'$.developmentEligible'),1) = 1";
const newest = "coalesce(json_extract(summary,'$.createdAt'),0) DESC,position,record_id";

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
    throw fail(502, '客户档案数据不完整');
}

export function ratingSummary(lead) {
  if (['A', 'B'].includes(lead.grade)) {
    const labels = (lead.assessment?.prioritySignals || []).map((signal) => signal.label);
    if (labels.length) return [...new Set(labels)].slice(0, 2).join('、') + '已核实';
  }
  const lines = text(lead.assessment?.evidenceReason || lead.ratingReason)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const pending = lines.find((line) => /^(待补充依据|待补充)[:：]/.test(line));
  const reason =
    (['C', '待核实', '待补全', '未评级'].includes(lead.grade) ? pending : '') ||
    lines.find((line) => /^(主营产品|明确经营品类|专业供货角色|综合供货角色)[:：]/.test(line)) ||
    (['C', '待核实', '待补全', '未评级'].includes(lead.grade)
      ? '关键依据尚未核实'
      : '查看评级依据');
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
  return { label: '暂无公开联系入口', detail: '官网未见公开邮箱、办公电话或联系表单' };
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
    'createdAt',
    'updatedAt',
  ];
  return {
    regionLabel: addressRegion(lead),
    regionLabelVersion: 2,
    version: contentVersion(lead),
    ...Object.fromEntries(
      fields.map((key) => [
        key,
        lead[key] ?? (['score', 'createdAt', 'updatedAt'].includes(key) ? null : ''),
      ]),
    ),
    companyIdentity: lead.companyIdentity
      ? {
          legal_name: lead.companyIdentity.legal_name ?? null,
          website_name: lead.companyIdentity.website_name ?? null,
          aliases: lead.companyIdentity.aliases || [],
          status: lead.companyIdentity.status || '',
        }
      : null,
    developmentEligible: isDevelopmentCustomer(lead),
    matchLevel: text(lead.assessment?.matchLevel),
    ratingSummary: ratingSummary(lead),
    contactSummary: contactSummary(lead),
  };
}

export class LeadLibrary {
  constructor({ path = ':memory:', scope = '', isSyncing = () => false } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.scope = scope;
    this.isSyncing = isSyncing;
    this.closed = false;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS followup_priority(scope TEXT,customer_id TEXT,marked_at TEXT,PRIMARY KEY(scope,customer_id));
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
      CREATE TABLE IF NOT EXISTS customer_archive_sync (
        scope TEXT NOT NULL, record_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(scope,record_id)
      );
      CREATE TABLE IF NOT EXISTS customer_archive_schema (
        scope TEXT PRIMARY KEY, data TEXT NOT NULL
      );`);
    this.migrateVersions();
    this.db
      .exec(`CREATE INDEX IF NOT EXISTS lead_page_order ON lead_library_customers(scope,${newest}) WHERE ${eligible};
      CREATE INDEX IF NOT EXISTS archive_pending_by_scope ON customer_archive_sync(scope) WHERE json_extract(data,'$.revision') > json_extract(data,'$.syncedRevision')`);
    this.db.function('lead_market', marketLabel);
    this.db.function('lead_has_product', (value, category) =>
      Number(leadProductCategories(value || '').includes(category)),
    );
    this.db.function('lead_status', (id, status) => this.pageDecorator({ id, status }).status);
    this.db.function('lead_search', (value, q) => {
      const lead = JSON.parse(value);
      return Number(
        `${lead.name} ${(lead.companyIdentity?.aliases || []).join(' ')} ${lead.domain} ${lead.contact} ${lead.email} ${lead.source}`
          .toLowerCase()
          .includes(q),
      );
    });
    this.meta = this.db
      .prepare('SELECT synced_at,refreshed_at,revision FROM lead_library_sync WHERE scope=?')
      .get(scope);
  }

  migrateVersions() {
    // Upgrade the prior read replica in place; dossiers, ordering and revision remain intact.
    const columns = this.db.prepare('PRAGMA table_info(lead_library_customers)').all();
    if (!columns.some((column) => column.name === 'version'))
      this.db.exec(
        "ALTER TABLE lead_library_customers ADD COLUMN version TEXT NOT NULL DEFAULT ''",
      );
    const rows = this.db
      .prepare(
        "SELECT scope,record_id,detail FROM lead_library_customers WHERE version='' OR json_extract(summary,'$.regionLabelVersion') IS NOT 2",
      )
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

  metadata() {
    return {
      syncedAt: this.meta?.synced_at || null,
      total: this.db
        .prepare('SELECT count(*) AS count FROM lead_library_customers WHERE scope=?')
        .get(this.scope).count,
      source: 'sqlite',
      scope: this.scope,
      sync: {
        refreshing: this.isSyncing(),
        revision: this.meta?.revision || 0,
        ...this.mirrorStatus(),
      },
    };
  }

  mirrorStatus() {
    return {
      ...this.db
        .prepare(
          `SELECT count(*) AS pendingWrites,
      coalesce(max(nullif(json_extract(data,'$.error'),'')),'') AS writeError
      FROM customer_archive_sync WHERE scope=?
      AND json_extract(data,'$.revision') > json_extract(data,'$.syncedRevision')`,
        )
        .get(this.scope),
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
  mailContacts() {
    const revision = this.meta?.revision || 0;
    if (this.contactsRevision !== revision) {
      this.mailDirectory = this.db
        .prepare(
          "SELECT record_id AS id,json_extract(summary,'$.name') AS name,json_extract(summary,'$.email') AS email,json_extract(detail,'$.contactEvidence') AS evidence FROM lead_library_customers WHERE scope=?",
        )
        .all(this.scope)
        .map(({ id, name, email, evidence }) => ({
          id,
          name,
          email,
          contactEvidence: (JSON.parse(evidence || '[]') || [])
            .filter((item) => item.kind === 'email')
            .map(({ kind, value }) => ({ kind, value })),
        }));
      this.contactsRevision = revision;
    }
    return this.mailDirectory;
  }

  async list() {
    this.assertOpen();
    return this.snapshot();
  }

  page(filters, decorate, { exportDetails = false, prepareDossiers } = {}) {
    this.assertOpen();
    const revision = this.meta?.revision || 0;
    const base = `FROM lead_library_customers WHERE scope=? AND ${eligible}`;
    if (this.pageDecorator !== decorate || this.facetRevision !== revision) {
      this.pageDecorator = decorate;
      const grades = Object.create(null),
        regions = new Set(),
        markets = new Set(),
        statuses = new Set();
      let total = 0;
      for (const row of this.db
        .prepare(
          `SELECT json_extract(summary,'$.grade') AS grade,lead_market(json_extract(summary,'$.market')) AS market,json_extract(summary,'$.regionLabel') AS region,lead_status(record_id,json_extract(summary,'$.status')) AS status,count(*) AS count ${base} GROUP BY grade,market,region,status`,
        )
        .all(this.scope)) {
        grades[row.grade] = (grades[row.grade] || 0) + row.count;
        markets.add(row.market);
        regions.add(row.region);
        statuses.add(row.status);
        total += row.count;
      }
      this.facets = {
        grades,
        regions: regionChoices('', regions),
        markets: [...markets],
        statuses: [...statuses],
        total,
      };
      this.facetRevision = revision;
    }
    const where = [],
      args = [this.scope];
    for (const [key, condition] of Object.entries({
      q: 'lead_search(summary,?)',
      market: "lead_market(json_extract(summary,'$.market'))=?",
      region: "json_extract(summary,'$.regionLabel')=?",
      grade: "json_extract(summary,'$.grade')=?",
      product: "lead_has_product(json_extract(summary,'$.product'),?)",
      status: "lead_status(record_id,json_extract(summary,'$.status'))=?",
    })) {
      const value = filters.get(key);
      if (!value) continue;
      where.push(condition);
      args.push(key === 'q' ? value.toLowerCase() : value);
    }
    const source = base + (where.length ? ' AND ' + where.join(' AND ') : '');
    const filteredTotal = where.length
      ? this.db.prepare(`SELECT count(*) AS total ${source}`).get(...args).total
      : this.facets.total;
    const requested = Number(filters.get('page'));
    const page = Math.min(
      Math.max(1, Math.ceil(filteredTotal / 8)),
      Number.isSafeInteger(requested) && requested > 0 ? requested : 1,
    );
    const rows = this.db
      .prepare(
        `SELECT ${exportDetails ? 'detail' : 'summary'} AS data${prepareDossiers && !exportDetails ? ',detail' : ''} ${source} ORDER BY ${newest}${exportDetails ? '' : ' LIMIT 8 OFFSET ?'}`,
      )
      .all(...args, ...(exportDetails ? [] : [(page - 1) * 8]));
    const leads = rows.map(({ data }) => decorate(JSON.parse(data)));
    const facetRegions = filters.get('market')
      ? regionChoices(filters.get('market'), [])
      : this.facets.regions;
    return {
      ...this.metadata(),
      leads,
      ...(prepareDossiers && !exportDetails
        ? {
            dossiers: prepareDossiers(rows.map((row) => JSON.parse(row.detail))).map((lead, i) => ({
              lead: decorate(lead),
              version: leads[i].version,
            })),
          }
        : {}),
      total: this.facets.total,
      filteredTotal,
      page,
      facets: {
        ...this.facets,
        regions: facetRegions,
        regionKeywords: regionKeywords(facetRegions),
      },
    };
  }

  async all() {
    this.assertOpen();
    return this.snapshot(true);
  }

  previewLeads(category, after = '', id = '') {
    this.assertOpen();
    return this.db
      .prepare(
        `SELECT record_id AS id, detail FROM lead_library_customers
      WHERE scope=? AND ${eligible} AND record_id>? AND (?='' OR record_id=?)
      AND EXISTS (SELECT 1 FROM json_each(detail,'$.facts') f
        WHERE json_extract(f.value,'$.field') IN ('customer_type','customer_types')
        AND json_extract(f.value,'$.value')=?)
      ORDER BY record_id LIMIT 50`,
      )
      .all(this.scope, after, id, id, category)
      .map((row) => ({ id: row.id, lead: JSON.parse(row.detail) }));
  }

  async detail(id) {
    this.assertOpen();
    return this.localDetail(id);
  }

  localDetail(id) {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT detail,version FROM lead_library_customers WHERE scope=? AND record_id=?')
      .get(this.scope, id);
    if (!row) throw fail(404, '客户不存在，请刷新客户库');
    return { lead: JSON.parse(row.detail), version: row.version, ...this.metadata() };
  }

  upsert(patch, { mirror } = {}) {
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
    if (prior?.version === projection.version && !mirror) return lead;
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
      if (mirror)
        this.db
          .prepare('INSERT OR REPLACE INTO customer_archive_sync VALUES(?,?,?)')
          .run(this.scope, lead.id, JSON.stringify(mirror));
      this.db
        .prepare('INSERT OR REPLACE INTO lead_library_sync VALUES(?,?,?,?)')
        .run(this.scope, this.meta?.synced_at || '', this.meta?.refreshed_at || 0, revision);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.meta = { synced_at: '', refreshed_at: 0, ...this.meta, revision };
    return lead;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
