import { Link } from 'react-router-dom';
import type { AcquisitionJob, CustomsBuyerEvidence } from '../domain/types';

const states = {
  running: '正在收录',
  stopping: '正在停止',
  paused: '已暂停 · 待核对',
  completed: '目标已完成',
  partial: '部分完成',
};
const resultNames: Record<string, string> = {
  inserted: '已新增',
  duplicate: '重复或既有',
  rejected: '不符合条件',
  review: '待核实',
  failed: '失败',
};
const metricState: Record<string, string> = {
  running: '处理中',
  completed: '搜索完成',
  failed: '搜索失败',
  interrupted: '服务中断',
};
const beijingTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const sourceName = (value?: string) => (value === 'customs' ? '海关逐票' : '官网搜索');
function safeUrl(value?: string | null) {
  try {
    const url = new URL(value || '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
function CargoDetails({ buyer }: { buyer: CustomsBuyerEvidence }) {
  const verified = buyer.match?.status === 'verified';
  return (
    <details>
      <summary>
        海关货物证据（{buyer.metrics?.record_count ?? buyer.records?.length ?? 0} 条记录）
      </summary>
      <p className="muted">
        {verified ? '买方身份关联已核实' : '买方与官网身份关联尚未确认'}
        {buyer.match?.reason ? ` · ${buyer.match.reason}` : ''}
      </p>
      <p className="muted">
        去重提单 {buyer.metrics?.bill_of_lading_count ?? '未知'} · 缺少提单号{' '}
        {buyer.metrics?.unnumbered_record_count ?? '未知'} · 最近日期{' '}
        {buyer.metrics?.last_event_date || '未知'}。记录与提单不等于采购订单，不加入初步评分。
      </p>
      <ul>
        {(buyer.records || []).map((record, index) => (
          <li key={`${record.id}:${index}`}>
            <small>
              {record.date || '日期未知'} · B/L：{record.bill_of_lading_number || '未提供提单号'}
            </small>
            <p>{record.description || '未提供货物描述'}</p>
            {safeUrl(record.source_url) ? (
              <a href={safeUrl(record.source_url)} target="_blank" rel="noopener noreferrer">
                原始来源
              </a>
            ) : (
              <small>无原始来源链接 · 记录 ID：{record.id || '未知'}</small>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
export function BatchProgress({
  job,
  control,
  busy,
}: {
  job: AcquisitionJob;
  control: (action: 'stop' | 'resume') => void;
  busy: boolean;
}) {
  const customsMetrics = (job.searchStats || []).filter(
    (metric) => metric.source_kind === 'customs',
  );
  const usesCustoms = ['customs', 'dual'].includes(job.input.acquisition_channel);
  const latestCustomsMetric = customsMetrics.at(-1);
  const reservedRecords = latestCustomsMetric ? latestCustomsMetric.usage?.run_reserved_records : 0;
  const cacheHits = customsMetrics.reduce(
    (total, metric) => total + (metric.usage?.cache_hits || 0),
    0,
  );
  return (
    <section className="batch-progress" aria-label="批量任务进度">
      <div className="result-title">
        <strong>{states[job.status]}</strong>
        <span>{beijingTime(job.createdAt)}</span>
      </div>
      <div role="status" aria-live="polite">
        <h3>
          去重后新增收录 {job.inserted} / {job.target} 家
        </h3>
        <progress max={job.target} value={job.inserted} aria-label="去重后新增收录进度" />
      </div>
      <p>{job.message}</p>
      {job.countPolicy === 'sales-handoff-v1' && (
        <p className="muted">
          历史任务按原交接口径结束；此处保留实际新增档案数，企业最新初评级见客户库。
        </p>
      )}
      <p className="muted">
        新增入库 {job.inserted} · 更新 {job.updated} · 重复或既有 {job.skipped} · 待核实{' '}
        {job.review || 0} · 不符合条件 {job.rejected} · 失败 {job.failed} · 写入待确认 {job.pending}
      </p>
      <p className="muted">
        已搜索 {job.searches} 次 · 已研究 {job.researched} 家
      </p>
      {job.researchUsage && (
        <p className="muted" title="模型请求按尝试统计；Token 仅累计供应商返回值。">
          模型请求 {job.researchUsage.model_calls} 次 · 结果复用 {job.researchUsage.cache_hits} 次
          {(job.researchUsage.input_tokens !== undefined ||
            job.researchUsage.output_tokens !== undefined) && (
            <>
              {' '}
              · Token 输入 {job.researchUsage.input_tokens ?? '未返回'} / 输出{' '}
              {job.researchUsage.output_tokens ?? '未返回'}
            </>
          )}
        </p>
      )}
      <p className="muted">
        发现来源：
        {job.input.acquisition_channel === 'dual'
          ? '海关逐票 + 官网搜索'
          : sourceName(usesCustoms ? 'customs' : 'web')}
        {(usesCustoms || customsMetrics.length > 0) && (
          <>
            {' '}
            · 海关已读取 {job.customsUsedRecords ?? '未知'} /{' '}
            {job.input.customs_record_budget ?? 300} 条（非缓存） · 缓存命中 {cacheHits} 次 ·
            预留待核对 {reservedRecords ?? '未知'} 条
          </>
        )}
      </p>
      <div className="result-actions">
        {job.status === 'running' && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => control('stop')}
          >
            停止任务
          </button>
        )}
        {job.status === 'paused' && (
          <>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => control('resume')}
            >
              核对并继续
            </button>
            <button
              type="button"
              className="btn subtle"
              disabled={busy}
              onClick={() => control('stop')}
            >
              结束任务
            </button>
          </>
        )}
        <Link className="btn secondary" to="/leads?dataset=real">
          查看客户库
        </Link>
      </div>
      {!!job.searchStats?.length && (
        <details className="batch-details" open={job.status !== 'running'}>
          <summary>查看实际搜索词与产出（{job.searchStats.length} 次）</summary>
          <div className="table-scroll">
            <table className="keyword-effect-table">
              <thead>
                <tr>
                  <th>实际搜索词</th>
                  <th>发现</th>
                  <th>重复</th>
                  <th>已研究</th>
                  <th>新增收录数</th>
                  <th>评级</th>
                </tr>
              </thead>
              <tbody>
                {job.searchStats.map((metric) => (
                  <tr key={metric.id}>
                    <td>
                      {metric.query}
                      <small>
                        {sourceName(metric.source_kind)} · {metric.country} ·{' '}
                        {metricState[metric.status] || metric.status}
                        {metric.error ? ` · ${metric.error}` : ''}
                      </small>
                      {metric.source_kind === 'customs' && (
                        <small>
                          返回 {metric.usage?.returned_records ?? '未知'} 条 · 本次非缓存读取{' '}
                          {metric.usage?.charged_records ?? '未知'} 条 · 缓存命中{' '}
                          {metric.usage?.cache_hits ?? '未知'} 次 · Credits{' '}
                          {metric.usage?.credits ?? '未知'}
                        </small>
                      )}
                    </td>
                    <td>{metric.discovered}</td>
                    <td>{metric.duplicates}</td>
                    <td>
                      {metric.researched} / {metric.queued}
                      <small>
                        待核实 {metric.review} · 排除 {metric.rejected} · 失败 {metric.failed}
                      </small>
                    </td>
                    <td>{metric.inserted}</td>
                    <td>
                      A {metric.ratings.A || 0} · B {metric.ratings.B || 0} · C{' '}
                      {metric.ratings.C || 0}
                      <small>未定级 {metric.ratings.unrated || 0}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            企业归入第一次发现它的搜索词；后续再次发现计入重复。尚未研究完的候选不参与评级效果判断。
          </p>
          <p className="muted">
            新增目标只统计去重后实际写入并由飞书读回确认的企业。A/B/C
            是初始开发优先级，不表示企业已采购、会回复或资料完整。
          </p>
        </details>
      )}
      {job.rows.length > 0 && (
        <details className="batch-details">
          <summary>查看客户明细（{job.rows.length}）</summary>
          <table className="lead-table">
            <thead>
              <tr>
                <th>企业 / 官网</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {job.rows.map((row, index) => (
                <tr key={`${row.domain}-${index}`}>
                  <td>
                    {safeUrl(row.source_url) ? (
                      <a href={safeUrl(row.source_url)} target="_blank" rel="noopener noreferrer">
                        {row.name || row.domain || row.customs_evidence?.name || '待核实企业'}
                      </a>
                    ) : (
                      <span>
                        {row.name || row.domain || row.customs_evidence?.name || '待核实企业'}
                      </span>
                    )}
                    {!safeUrl(row.source_url) && row.customs_evidence && (
                      <small>尚未关联可核实官网</small>
                    )}
                    {row.reason && <small>{row.reason}</small>}
                    {row.qualification_retraction ? (
                      <small>交接已撤销：{row.qualification_retraction.reason}</small>
                    ) : (
                      row.handoff && (
                        <small>
                          {row.handoff.contact_verified
                            ? '已找到有来源的公司级联系入口'
                            : '本轮未找到官网公司级联系入口，可后续补充'}
                        </small>
                      )
                    )}
                    {row.search_query && <small>发现词：{row.search_query}</small>}
                    {row.handoff?.contacts?.map(
                      (contact, i) =>
                        safeUrl(contact.source_url) && (
                          <small key={`handoff-contact-${i}`}>
                            <a
                              href={safeUrl(contact.source_url)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {contact.kind === 'form'
                                ? '业务联系表单'
                                : `${contact.kind === 'email' ? '邮箱' : '电话'}：${contact.value}`}
                            </a>
                          </small>
                        ),
                    )}
                    {row.customs_evidence && <CargoDetails buyer={row.customs_evidence} />}
                    {!!row.requirementChecks?.length && (
                      <small>
                        必需条件：
                        {row.requirementChecks
                          .map(
                            (check) =>
                              `${check.condition}（${
                                check.verdict === 'matched'
                                  ? '符合'
                                  : check.verdict === 'not_matched'
                                    ? '不符合'
                                    : '待核实'
                              }）`,
                          )
                          .join('；')}
                      </small>
                    )}
                  </td>
                  <td>
                    {resultNames[row.result] || row.result}
                    {row.assessment && (
                      <small>
                        {row.assessment.grade || row.assessment.status || '未定级'} · 已支持
                        {row.assessment.score}分
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
