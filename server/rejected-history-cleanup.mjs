import { isDeepStrictEqual } from 'node:util';
import { calculateHandoffReadiness } from './handoff-readiness.mjs';

const usageKeys = [
  'model_calls',
  'cache_hits',
  'input_chars',
  'input_tokens',
  'output_tokens',
  'omitted_pages',
  'truncated_pages',
  'original_chars',
  'compacted_chars',
];
const fixedReasons = new Set([
  '官网主体不是经营企业',
  '官网产品与本次目标不相关',
  '官网所在国家与目标市场不符',
  '官网服务客群与本次筛选不符',
  '官网客户类型与本次筛选不符',
  '官网业务画像与本次筛选不符',
  '不符合本次必需条件',
  '官网经营资格与本次目标不符',
  '官网内容与目标产品不相关，已预筛排除',
]);

function usage(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const picked = Object.fromEntries(
    keys
      .filter((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
      .map((key) => [key, value[key]]),
  );
  if (value.cache_unavailable === true && keys === usageKeys) picked.cache_unavailable = true;
  return Object.keys(picked).length ? picked : undefined;
}

function fixedReason(operation) {
  const research = operation.research || operation.output?.research || {};
  if (research.entity_type === 'individual') return '官网主体不是经营企业';
  if (research.product_match === 'not_matched') return '官网产品与本次目标不相关';
  if (research.country_match === 'not_matched') return '官网所在国家与目标市场不符';
  if (research.audience_match === 'not_matched') return '官网服务客群与本次筛选不符';
  if (research.customer_type_match === 'not_matched') return '官网客户类型与本次筛选不符';
  if (research.profile_match === 'not_matched') return '官网业务画像与本次筛选不符';
  if (research.required_match === 'not_matched') return '不符合本次必需条件';
  if (research.eligibility?.status === 'rejected') return '官网经营资格与本次目标不符';
  return fixedReasons.has(operation.output?.reason)
    ? operation.output.reason
    : '不符合本次筛选条件';
}

function eligible(operation) {
  return (
    operation?.state === 'completed' &&
    operation.output?.outcome === 'rejected' &&
    !operation.recordId &&
    !operation.recordVerifiedAt &&
    !operation.action &&
    !operation.fields &&
    !operation.assessment &&
    !operation.output.assessment &&
    !operation.target_record_id &&
    !operation.input?.target_record_id &&
    !operation.input?.item?.target_record_id &&
    !operation.output.target_record_id &&
    operation.output.新增 === 0 &&
    operation.output.更新 === 0 &&
    operation.output.失败 === 0 &&
    operation.output.待人工查重 === 0 &&
    operation.output.skipped_existing_count === 0 &&
    (!Array.isArray(operation.output.skipped_existing) ||
      operation.output.skipped_existing.length === 0) &&
    (!Array.isArray(operation.output.明细) || operation.output.明细.length === 0)
  );
}

function redactedOperation(operation, reason) {
  const researchUsage = usage(
    operation.research_usage || operation.output.research_usage,
    usageKeys,
  );
  const webUsage = usage(operation.web_usage, ['web_extract_calls', 'web_extract_credits']);
  const handoff = calculateHandoffReadiness({ research: { ok: false } });
  const output = {
    outcome: 'rejected',
    execution_id: 'native-' + operation.id,
    新增: 0,
    更新: 0,
    失败: 0,
    待人工查重: 0,
    stage: operation.stage,
    reason,
    skipped_existing_count: 0,
    skipped_existing: [],
    research: { ok: false, reason },
    handoff,
    assessment: null,
    checked_urls: [],
    ...(researchUsage ? { research_usage: researchUsage } : {}),
    明细: [],
  };
  return {
    id: operation.id,
    scope: operation.scope,
    stage: operation.stage,
    createdAt: operation.createdAt,
    ...(researchUsage ? { research_usage: researchUsage } : {}),
    ...(webUsage ? { web_usage: webUsage } : {}),
    handoff,
    state: 'completed',
    output,
    updatedAt: operation.updatedAt,
  };
}

export function cleanupRejectedHistory(db, { apply = false, clearModelCache = false } = {}) {
  if (typeof apply !== 'boolean' || typeof clearModelCache !== 'boolean')
    throw new TypeError('apply 和 clearModelCache 必须为布尔值');
  if (apply) db.exec('BEGIN IMMEDIATE');
  try {
    const jobs = db
      .prepare('SELECT id,data FROM jobs')
      .all()
      .map((row) => ({
        id: row.id,
        value: JSON.parse(row.data),
      }));
    const activeOperations = new Set(
      jobs
        .filter(({ value }) => ['running', 'stopping', 'paused'].includes(value.status))
        .map(({ value }) => value.current?.operation_id)
        .filter(Boolean),
    );
    const replacements = new Map();
    const operationUpdates = [];
    const jobUpdates = [];
    const report = {
      applied: apply,
      rejectedOperations: 0,
      unsafeOperations: 0,
      deferredActiveOperations: 0,
      operationsToRedact: 0,
      terminalJobs: 0,
      jobsToClean: 0,
      rejectedRowsToRedact: 0,
      unlinkedRejectedRows: 0,
      cacheEntries: db.prepare('SELECT COUNT(*) AS count FROM research_model_responses').get()
        .count,
      cacheToClear: 0,
    };
    const operations = db.prepare('SELECT id,data FROM acquisition_operations').all();
    for (const { id, data } of operations) {
      const operation = JSON.parse(data);
      if (operation.output?.outcome !== 'rejected') continue;
      report.rejectedOperations++;
      if (!eligible(operation)) {
        report.unsafeOperations++;
        continue;
      }
      if (activeOperations.has(id)) {
        report.deferredActiveOperations++;
        continue;
      }
      const reason = fixedReason(operation);
      const replacement = redactedOperation(operation, reason);
      replacements.set(id, { reason, replacement });
      if (!isDeepStrictEqual(operation, replacement)) {
        report.operationsToRedact++;
        operationUpdates.push([id, replacement]);
      }
    }
    for (const { id, value: job } of jobs) {
      if (!['completed', 'partial'].includes(job.status)) continue;
      report.terminalJobs++;
      const cleaned = {
        ...job,
        rows: (job.rows || []).map((row) => {
          if (row.result !== 'rejected') return row;
          const matched = replacements.get(row.operation_id);
          if (!matched) {
            report.unlinkedRejectedRows++;
            return row;
          }
          const rowUsage = usage(row.research_usage, usageKeys);
          const minimal = {
            search_id: row.search_id,
            operation_id: row.operation_id,
            result: 'rejected',
            reason: matched.reason,
            ...(rowUsage ? { research_usage: rowUsage } : {}),
          };
          if (!isDeepStrictEqual(row, minimal)) report.rejectedRowsToRedact++;
          return minimal;
        }),
        queue: [],
        seen: [],
        skippedDomains: [],
        searchSignatures: [],
        pendingSearch: null,
        current: null,
      };
      if (!isDeepStrictEqual(job, cleaned)) {
        report.jobsToClean++;
        jobUpdates.push([id, cleaned]);
      }
    }
    if (clearModelCache) {
      report.cacheToClear = report.cacheEntries;
    }
    if (apply) {
      if (report.unlinkedRejectedRows) throw new Error('存在无法核对的历史淘汰明细，未修改数据库');
      const writeOperation = db.prepare('UPDATE acquisition_operations SET data=? WHERE id=?');
      const writeJob = db.prepare('UPDATE jobs SET data=? WHERE id=?');
      for (const [id, operation] of operationUpdates)
        writeOperation.run(JSON.stringify(operation), id);
      for (const [id, job] of jobUpdates) writeJob.run(JSON.stringify(job), id);
      if (clearModelCache) db.exec('DELETE FROM research_model_responses');
    }
    if (apply) db.exec('COMMIT');
    return report;
  } catch (error) {
    if (apply) db.exec('ROLLBACK');
    throw error;
  }
}
