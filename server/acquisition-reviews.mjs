import { createHash } from 'node:crypto';
import { domainKey } from './website-identity.mjs';

const fail = (message) => Object.assign(new Error(message), { status: 409 });

// Review attempts live beside jobs, but never rewrite a completed job's counts.
export class AcquisitionReviews {
  constructor(db, scope) {
    this.db = db;
    this.scope = scope;
    db.exec(`CREATE TABLE IF NOT EXISTS acquisition_reviews (
      scope TEXT NOT NULL, job_id TEXT NOT NULL, row_index INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(scope,job_id,row_index)
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
  save(jobId, index, value) {
    this.db
      .prepare(
        `INSERT INTO acquisition_reviews(scope,job_id,row_index,data) VALUES(?,?,?,?)
        ON CONFLICT(scope,job_id,row_index) DO UPDATE SET data=excluded.data`,
      )
      .run(this.scope, jobId, index, JSON.stringify(value));
    return value;
  }
  begin(jobId, index, key, sourceUrl) {
    const prior = this.get(jobId, index);
    if (prior?.key === key) {
      if (prior.source_url !== sourceUrl) throw fail('同一核实编号不能更换官网网址');
      return prior;
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
    return this.save(jobId, index, {
      key,
      source_url: sourceUrl,
      operation_id: operationId,
      status: 'pending',
      updated_at: new Date().toISOString(),
    });
  }
  settle(jobId, index, output) {
    const prior = this.get(jobId, index);
    if (!prior) throw fail('核实操作记录不存在');
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
    return this.save(jobId, index, {
      ...prior,
      status,
      record_id: row?.record_id || null,
      reason: output?.reason || '',
      updated_at: new Date().toISOString(),
    });
  }
  uncertain(jobId, index) {
    const prior = this.get(jobId, index);
    return this.save(jobId, index, {
      ...prior,
      status: 'uncertain',
      reason: '核实结果待确认，请使用原核实编号重试',
      updated_at: new Date().toISOString(),
    });
  }
}
