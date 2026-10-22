import { Link } from 'react-router-dom';
import type { AcquisitionJob } from '../domain/types';

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
export function BatchProgress({
  job,
  control,
  busy,
}: {
  job: AcquisitionJob;
  control: (action: 'stop' | 'resume') => void;
  busy: boolean;
}) {
  return (
    <section className="batch-progress" aria-label="批量任务进度">
      <div className="result-title">
        <strong>{states[job.status]}</strong>
        <span>{beijingTime(job.createdAt)}</span>
      </div>
      <div role="status" aria-live="polite">
        <h3>
          已新增 {job.inserted} / {job.target} 家
        </h3>
        <progress max={job.target} value={job.inserted} aria-label="客户收录进度" />
      </div>
      <p>{job.message}</p>
      <p className="muted">
        重复或既有 {job.skipped} · 待核实 {job.review || 0} · 不符合条件 {job.rejected} · 失败{' '}
        {job.failed} · 写入待确认 {job.pending}
      </p>
      <p className="muted">
        已搜索 {job.searches} 次 · 已研究 {job.researched} 家
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
                  <th>新增</th>
                  <th>评级</th>
                </tr>
              </thead>
              <tbody>
                {job.searchStats.map((metric) => (
                  <tr key={metric.id}>
                    <td>
                      {metric.query}
                      <small>
                        {metric.country} · {metricState[metric.status] || metric.status}
                        {metric.error ? ` · ${metric.error}` : ''}
                      </small>
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
                    <a href={row.source_url} target="_blank" rel="noreferrer">
                      {row.name || row.domain}
                    </a>
                    {row.reason && <small>{row.reason}</small>}
                    {row.search_query && <small>发现词：{row.search_query}</small>}
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
