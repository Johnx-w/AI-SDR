import { createHash } from 'node:crypto';
import { domainKey } from './website-identity.mjs';
import { websiteScope } from './website-metadata.mjs';
import { canonicalJson } from './research-reuse.mjs';

const fail = (message) => Object.assign(new Error(message), { status: 409 });
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

export function acquisitionReviewSubmission(body, website) {
  const actor = typeof body.actor === 'string' ? body.actor.trim() : '';
  if (actor.length > 100 || (body.actor !== undefined && !actor))
    throw invalid('请填写核实操作者姓名');
  if (body.decision === undefined) return actor ? { actor } : {};
  const raw = body.decision;
  const source = websiteScope(raw?.source_url);
  if (!actor || !source || source.domain !== website.domain)
    throw invalid('人工裁定需要操作者和同一企业官网的证据网址');
  const decision = { source_url: source.url };
  for (const [field, max] of Object.entries({
    company_name: 200,
    identity_quote: 1500,
    operating_quote: 1500,
    product: 300,
    reason: 500,
  })) {
    const value = typeof raw[field] === 'string' ? raw[field].trim() : '';
    if (!value || value.length > max) throw invalid('请填写完整的人工裁定依据');
    decision[field] = value;
  }
  if (
    !['complete_supply', 'component_resale', 'commercial_custom_supply'].includes(
      raw.admission_fact,
    )
  )
    throw invalid('请选择有原文支持的供货方式');
  decision.admission_fact = raw.admission_fact;
  return { actor, decision };
}

// Review attempts live beside jobs, but never rewrite a completed job's counts.
export class AcquisitionReviews {
  constructor(db, scope) {
    this.db = db;
    this.scope = scope;
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_reviews (
      scope TEXT NOT NULL, job_id TEXT NOT NULL, row_index INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(scope,job_id,row_index)
    ); CREATE TABLE IF NOT EXISTS acquisition_review_attempts (
      scope TEXT NOT NULL, job_id TEXT NOT NULL, row_index INTEGER NOT NULL,
      request_key TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(scope,job_id,row_index,request_key)
    )`);
  }
  get(jobId, index) {
    const row = this.db
      .prepare('SELECT data FROM acquisition_reviews WHERE scope=? AND job_id=? AND row_index=?')
      .get(this.scope, jobId, index);
    return row ? JSON.parse(row.data) : null;
  }
  forJob(jobId) {
    return new Map(
      this.db
        .prepare('SELECT row_index,data FROM acquisition_reviews WHERE scope=? AND job_id=?')
        .all(this.scope, jobId)
        .map((row) => [row.row_index, JSON.parse(row.data)]),
    );
  }
  attempt(jobId, index, key) {
    const row = this.db
      .prepare(
        `SELECT data FROM acquisition_review_attempts
      WHERE scope=? AND job_id=? AND row_index=? AND request_key=?`,
      )
      .get(this.scope, jobId, index, key);
    if (row) return JSON.parse(row.data);
    const latest = this.get(jobId, index);
    return latest?.key === key ? latest : null;
  }
  attempts(jobId, index) {
    return this.db
      .prepare(
        `SELECT data FROM acquisition_review_attempts
      WHERE scope=? AND job_id=? AND row_index=? ORDER BY rowid`,
      )
      .all(this.scope, jobId, index)
      .map(({ data }) => JSON.parse(data));
  }
  manualCount(jobId) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM acquisition_reviews
      WHERE scope=? AND job_id=? AND json_extract(data,'$.capture.mode')='manual'`,
      )
      .get(this.scope, jobId).total;
  }
  save(jobId, index, value) {
    const data = JSON.stringify(value);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO acquisition_reviews(scope,job_id,row_index,data) VALUES(?,?,?,?)
        ON CONFLICT(scope,job_id,row_index) DO UPDATE SET data=excluded.data`,
        )
        .run(this.scope, jobId, index, data);
      if (value.key)
        this.db
          .prepare(
            `INSERT INTO acquisition_review_attempts VALUES(?,?,?,?,?)
          ON CONFLICT(scope,job_id,row_index,request_key) DO UPDATE SET data=excluded.data`,
          )
          .run(this.scope, jobId, index, value.key, data);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return value;
  }
  begin(jobId, index, key, sourceUrl, submission, originalSourceUrl) {
    const prior = this.get(jobId, index);
    const existing = this.attempt(jobId, index, key);
    if (existing) {
      if (
        existing.source_url !== sourceUrl ||
        (existing.actor !== undefined && existing.actor !== (submission.actor || '未署名')) ||
        canonicalJson(existing.decision || null) !== canonicalJson(submission.decision || null)
      )
        throw fail('同一核实编号不能更换官网、操作者或裁定依据');
      return existing;
    }
    if (prior && ['pending', 'uncertain'].includes(prior.status))
      throw fail('上次核实结果待确认，请使用原核实编号重试');
    if (prior && ['inserted', 'updated', 'duplicate'].includes(prior.status))
      throw fail('该企业已录入客户库，请刷新记录');
    const operationId =
      'review-' +
      createHash('sha256')
        .update(JSON.stringify([this.scope, jobId, index, key, sourceUrl]))
        .digest('hex');
    const now = new Date().toISOString();
    return this.save(jobId, index, {
      key,
      source_url: sourceUrl,
      original_source_url: originalSourceUrl || null,
      actor: submission.actor || '未署名',
      ...(submission.decision ? { decision: submission.decision } : {}),
      operation_id: operationId,
      status: 'pending',
      submitted_at: now,
      updated_at: now,
    });
  }
  settle(jobId, index, output) {
    const prior = this.get(jobId, index);
    if (!prior) throw fail('核实操作记录不存在');
    if (!['pending', 'uncertain'].includes(prior.status)) return prior;
    const row = (output?.明细 || []).find(
      (item) => domainKey(item.source_url) === domainKey(prior.source_url),
    );
    const status =
      row?.result === 'inserted' && row.record_id
        ? 'inserted'
        : row?.result === 'updated' && row.record_id
          ? 'updated'
          : output?.skipped_existing_count > 0 || output?.outcome === 'no_new_candidates'
            ? 'duplicate'
            : output?.outcome === 'review' || output?.research?.review_required
              ? 'review'
              : 'failed';
    const now = new Date().toISOString();
    return this.save(jobId, index, {
      ...prior,
      status,
      record_id: row?.record_id || null,
      reason: output?.reason || '',
      ...(row?.capture?.mode === 'manual' &&
      row.capture.operation_id === prior.operation_id &&
      row.capture.job_id === jobId
        ? { capture: row.capture }
        : {}),
      decided_at: now,
      updated_at: now,
    });
  }
  uncertain(jobId, index) {
    const prior = this.get(jobId, index);
    if (!['pending', 'uncertain'].includes(prior?.status)) return prior;
    return this.save(jobId, index, {
      ...prior,
      status: 'uncertain',
      reason: '核实结果待确认，请使用原核实编号重试',
      updated_at: new Date().toISOString(),
    });
  }
}
