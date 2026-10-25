import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { acquisitionApi } from '../services/acquisition';
import { overviewApi } from '../services/overview';
import type { OverviewData } from '../services/overview';
import type { OverviewPeriod } from '../domain/overview-rules.mjs';
import { BatchProgress } from '../components/BatchProgress';
import { Badge, Empty } from '../components/ui';
import type { AcquisitionJob } from '../domain/types';
import {
  ALL_PRODUCTS_LABEL,
  environmentPreferenceLabels,
  isAllProductScope,
} from '../domain/acquisition-products.mjs';
import './ExecutionRecords.css';

const states: Record<string, string> = {
  running: '运行中',
  stopping: '正在停止',
  paused: '待核对',
  completed: '已完成',
  partial: '部分完成',
};
export function ExecutionRecords({ selectedId }: { selectedId?: string }) {
  const [params] = useSearchParams();
  return params.get('view') === 'captures' ? (
    <CapturedCompanies />
  ) : (
    <AcquisitionExecutionList selectedId={selectedId} />
  );
}

function CapturedCompanies() {
  const [params] = useSearchParams();
  const period: OverviewPeriod = ['today', '7d', '30d'].includes(params.get('period') || '')
    ? (params.get('period') as OverviewPeriod)
    : '7d';
  const requestedAt = params.get('asOf');
  const asOf = requestedAt && Number.isFinite(Date.parse(requestedAt)) ? requestedAt : undefined;
  const key = `${period}/${asOf || ''}`;
  const [result, setResult] = useState<{ key: string; data: OverviewData } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const data = result?.key === key ? result.data : null;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void overviewApi
      .get(period, controller.signal, asOf)
      .then((snapshot) => {
        if (controller.signal.aborted) return;
        if (snapshot.sources.acquisition.state === 'unavailable')
          throw new Error(snapshot.sources.acquisition.error || '新增收录记录暂时无法读取');
        setResult({ key, data: snapshot });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '新增收录记录读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [key, period, asOf, revision]);
  const dateText = (value: string) =>
    new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return (
    <section className="panel acq-captures">
      <div className="acq-list-toolbar">
        <div>
          <h2>实际新增企业明细</h2>
          <p className="muted">
            {data
              ? `${data.range.label} · ${dateText(data.range.start)} 至 ${dateText(data.range.end)}（北京时间）`
              : '正在核对统计范围'}
          </p>
        </div>
        <Link className="btn secondary" to="/automation?tab=runs">
          返回执行记录
        </Link>
        <button
          className="btn secondary"
          disabled={loading}
          onClick={() => setRevision((n) => n + 1)}
        >
          <RefreshCw size={15} />
          重新读取
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
          {data && '；以下保留上次成功读取的数据。'}
        </p>
      )}
      {loading && (
        <p className="muted" role="status">
          正在读取实际收录记录…
        </p>
      )}
      {data && (
        <>
          <p className="acq-capture-note">
            共 {data.metrics.newCompanies} 家 · {data.coverage.note}。
            每家企业按实际收录记录计数，后续更新和重复发现不计新增。
          </p>
          {data.sources.acquisition.state === 'stale' && (
            <p className="error-message" role="status">
              {data.sources.acquisition.error || '当前显示上次保存的新增记录，请稍后重新核对。'}
            </p>
          )}
          {data.captures.length ? (
            <div className="table-scroll">
              <table className="acq-capture-table">
                <thead>
                  <tr>
                    <th>企业</th>
                    <th>实际收录时间（北京时间）</th>
                    <th>来源执行</th>
                  </tr>
                </thead>
                <tbody>
                  {data.captures.map((capture) => (
                    <tr key={capture.customerId}>
                      <td>
                        {capture.available ? (
                          <Link to={`/leads?lead=${encodeURIComponent(capture.customerId)}`}>
                            {capture.name}
                          </Link>
                        ) : (
                          <strong>{capture.name}</strong>
                        )}
                        <small>{capture.domain}</small>
                        {!capture.available && (
                          <small>
                            {capture.available === null ||
                            data.sources.customers.state === 'unavailable'
                              ? '客户档案暂时无法核对，历史收录记录保留'
                              : '当前读取的客户库中未找到该档案，历史收录记录保留'}
                          </small>
                        )}
                      </td>
                      <td>
                        <time dateTime={capture.capturedAt}>{dateText(capture.capturedAt)}</time>
                      </td>
                      <td>
                        {capture.jobId ? (
                          <Link
                            className="text-link"
                            to={`/automation?tab=runs&job=${encodeURIComponent(capture.jobId)}`}
                          >
                            查看来源执行
                          </Link>
                        ) : (
                          '未记录来源执行'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !loading && (
              <Empty
                title="该期间没有已记录新增"
                detail="此处仅统计实际新增收录记录，未记录的历史不补为零。"
              />
            )
          )}
        </>
      )}
    </section>
  );
}

function AcquisitionExecutionList({ selectedId }: { selectedId?: string }) {
  const scrolledTo = useRef('');
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
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await acquisitionApi.jobs();
        let selectedError = '';
        if (selectedId && !data.jobs.some((job) => job.id === selectedId)) {
          try {
            const selected = await acquisitionApi.job(selectedId);
            data.jobs = [selected, ...data.jobs];
          } catch (cause) {
            selectedError = cause instanceof Error ? cause.message : '指定执行记录无法读取';
          }
        }
        if (alive) {
          setJobs(data.jobs);
          setError(selectedError);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [revision, selectedId]);
  useEffect(() => {
    if (!selectedId) scrolledTo.current = '';
    if (!loading && selectedId && scrolledTo.current !== selectedId) {
      const record = document.getElementById(`acquisition-record-${selectedId}`);
      if (record) {
        record.scrollIntoView({ block: 'start', behavior: 'smooth' });
        scrolledTo.current = selectedId;
      }
    }
  }, [loading, selectedId, jobs]);
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
        <section
          className="panel acq-execution-card"
          key={job.id}
          id={`acquisition-record-${job.id}`}
        >
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
