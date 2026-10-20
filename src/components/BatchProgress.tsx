import { Link } from 'react-router-dom';
import type { AcquisitionJob } from '../domain/types';

const states = {
  running: '正在收录',
  stopping: '正在停止',
  paused: '已暂停 · 待核对',
  completed: '目标已完成',
  partial: '部分完成',
};
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
        <span>{new Date(job.createdAt).toLocaleString('zh-CN')}</span>
      </div>
      <div role="status" aria-live="polite">
        <h3>
          已新增 {job.inserted} / {job.target} 家
        </h3>
        <progress max={job.target} value={job.inserted} aria-label="客户收录进度" />
      </div>
      <p>{job.message}</p>
      <p className="muted">
        重复跳过 {job.skipped} · 不符合条件 {job.rejected} · 失败 {job.failed} · 待确认{' '}
        {job.pending}
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
              {job.rows.map((row) => (
                <tr key={row.domain}>
                  <td>
                    <a href={row.source_url} target="_blank" rel="noreferrer">
                      {row.name || row.domain}
                    </a>
                    {row.reason && <small>{row.reason}</small>}
                  </td>
                  <td>
                    {{
                      inserted: '已新增',
                      duplicate: '重复跳过',
                      rejected: '不符合条件',
                      failed: '失败',
                    }[row.result] || row.result}
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
