import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { acquisitionApi } from '../services/acquisition';
import { BatchProgress } from '../components/BatchProgress';
import { Badge, Empty } from '../components/ui';
import type { AcquisitionJob } from '../domain/types';
import {
  ALL_PRODUCTS_LABEL,
  environmentPreferenceLabels,
  isAllProductScope,
} from '../domain/acquisition-products.mjs';

const states: Record<string, string> = {
  running: '运行中',
  stopping: '正在停止',
  paused: '待核对',
  completed: '已完成',
  partial: '部分完成',
};
export function ExecutionRecords({ selectedId }: { selectedId?: string }) {
  const [jobs, setJobs] = useState<AcquisitionJob[]>([]);
  const [expanded, setExpanded] = useState(selectedId || '');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (selectedId) setExpanded(selectedId);
  }, [selectedId]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await acquisitionApi.jobs();
        if (alive) {
          setJobs(data.jobs);
          setError('');
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [revision]);
  async function control(id: string, action: 'stop' | 'resume') {
    setBusy(id);
    try {
      const job = await acquisitionApi.controlJob(id, action);
      setJobs((current) => current.map((j) => (j.id === id ? job : j)));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="acq-executions">
      <div className="acq-list-toolbar">
        <p className="muted">查看实际执行进度、企业结果与搜索词产出</p>
        <button className="btn secondary" onClick={() => setRevision((n) => n + 1)}>
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="muted">正在读取执行记录…</p>}
      {!loading && !jobs.length && !error && (
        <Empty title="暂无执行记录" detail="开始获客或定时计划触发后，可在这里查看进度。" />
      )}
      {jobs.map((job) => (
        <section className="panel acq-execution-card" key={job.id}>
          <button
            className="acq-execution-heading"
            aria-expanded={expanded === job.id}
            onClick={() => setExpanded(expanded === job.id ? '' : job.id)}
          >
            <span>
              <strong>
                {job.input.country}
                {job.input.region ? ' · ' + job.input.region : ''}
              </strong>
              <small>
                {isAllProductScope(job.input)
                  ? `${ALL_PRODUCTS_LABEL}（成品、半成品和零件）`
                  : job.input.products?.map((p) => p.label).join('、') || job.input.product}
                {job.input.environment_preference &&
                  job.input.environment_preference !== 'all' &&
                  ` · ${environmentPreferenceLabels[job.input.environment_preference]}`}
              </small>
              <small>
                {new Date(job.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                （北京时间）
              </small>
            </span>
            <span>
              <Badge tone={job.status === 'completed' ? 'green' : 'neutral'}>
                {states[job.status]}
              </Badge>
              <strong>
                新增收录 {job.inserted} / {job.target} 家
              </strong>
              <small>{expanded === job.id ? '收起详情' : '查看详情'}</small>
            </span>
          </button>
          {expanded === job.id && (
            <BatchProgress
              job={job}
              busy={busy === job.id}
              control={(action) => void control(job.id, action)}
            />
          )}
        </section>
      ))}
    </div>
  );
}
