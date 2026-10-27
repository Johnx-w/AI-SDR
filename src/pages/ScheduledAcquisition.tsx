import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Pause, Play, X } from 'lucide-react';
import { Badge, Empty } from '../components/ui';
import { BatchProgress } from '../components/BatchProgress';
import { acquisitionApi } from '../services/acquisition';
import type { AcquisitionSchedule } from '../domain/types';
import {
  ALL_PRODUCTS_LABEL,
  directionLabels,
  environmentPreferenceLabels,
  isAllProductScope,
} from '../domain/acquisition-products.mjs';

const names = { enabled: '已启用', paused: '已暂停', closed: '已关闭', completed: '已触发' };
const repeatNames = { once: '指定日期', daily: '每天', weekly: '每周' };
const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

export function ScheduledAcquisition() {
  const [plans, setPlans] = useState<AcquisitionSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('active');
  const [expanded, setExpanded] = useState('');
  async function load(background = false) {
    if (!background) setLoading(true);
    try {
      const response = await acquisitionApi.schedules();
      setPlans(response.schedules);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取定时计划失败');
    } finally {
      if (!background) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), 10000);
    return () => clearInterval(timer);
  }, []);
  async function control(plan: AcquisitionSchedule, action: 'pause' | 'resume' | 'close') {
    setBusy(plan.id);
    setError('');
    try {
      const updated = await acquisitionApi.controlSchedule(plan.id, action);
      setPlans((current) => current.map((p) => (p.id === plan.id ? updated : p)));
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy('');
    }
  }
  async function controlJob(id: string, action: 'stop' | 'resume') {
    setBusy(id);
    setError('');
    try {
      await acquisitionApi.controlJob(id, action);
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy('');
    }
  }
  const visible = plans.filter(
    (plan) =>
      filter === 'all' ||
      !['closed', 'completed'].includes(plan.status) ||
      Boolean(plan.lastJob && ['running', 'stopping', 'paused'].includes(plan.lastJob.status)),
  );
  return (
    <>
      <div className="acq-list-toolbar">
        <p className="muted">管理计划与查看最近一轮执行结果</p>
        <Link className="btn primary" to="/automation?mode=scheduled">
          新建定时计划
        </Link>
      </div>
      <p className="muted schedule-help">
        按北京时间执行，每个时间点各运行一次；上一轮未完成时按时间顺序排队。本机后端服务需保持启动。暂停或关闭计划会停止后续触发，本轮在当前企业处理结束后停止。
      </p>
      <div className="filter-chips">
        {[
          ['active', '进行中的计划'],
          ['all', '全部计划'],
        ].map(([value, label]) => (
          <button
            key={value}
            className={filter === value ? 'selected' : ''}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {loading && !plans.length ? (
        <p className="muted">正在读取计划…</p>
      ) : !visible.length && !error ? (
        <Empty
          title="暂无定时获客计划"
          detail="在获客任务页设置市场、客户条件及执行时间，保存后会显示在这里。"
        />
      ) : null}
      <div className="schedule-list">
        {visible.map((plan) => (
          <section className="panel schedule-card" key={plan.id}>
            <header>
              <div>
                <h2>
                  <CalendarDays size={20} />
                  {plan.name}
                </h2>
                <p>
                  {repeatNames[plan.timing.repeat]} · {plan.timing.startDate} 起 ·{' '}
                  {(plan.timing.times || [plan.timing.time]).filter(Boolean).join('、')}
                  （北京时间，每个时间点执行一次）
                </p>
              </div>
              <Badge tone={plan.status === 'enabled' ? 'green' : 'neutral'}>
                {names[plan.status]}
              </Badge>
            </header>
            <div className="schedule-target">
              <span>
                {plan.input.country}
                {plan.input.region ? ` / ${plan.input.region}` : ''}
              </span>
              <span>每次新增 {plan.input.target_count} 家</span>
              <p>
                {isAllProductScope(plan.input)
                  ? `${ALL_PRODUCTS_LABEL}（成品、半成品和零件）`
                  : plan.input.products?.length
                    ? plan.input.products
                        .map(
                          (product) => `${product.label}（${directionLabels[product.direction]}）`,
                        )
                        .join('、')
                    : plan.input.product}
                {plan.input.environment_preference &&
                  plan.input.environment_preference !== 'all' && (
                    <small>
                      {' '}
                      · {environmentPreferenceLabels[plan.input.environment_preference]}
                    </small>
                  )}
              </p>
            </div>
            <dl className="schedule-times">
              <div>
                <dt>下次执行</dt>
                <dd>{time(plan.nextRunAt)}</dd>
              </div>
              <div>
                <dt>上次触发</dt>
                <dd>{time(plan.lastRunAt)}</dd>
                {plan.lastScheduledAt && (
                  <small className="muted">计划时间：{time(plan.lastScheduledAt)}</small>
                )}
              </div>
              <div>
                <dt>已触发次数</dt>
                <dd>{plan.runs}</dd>
              </div>
            </dl>
            {plan.lastError && (
              <p className="schedule-wait" role="status">
                {plan.lastError}
              </p>
            )}
            <footer>
              {plan.status === 'enabled' && (
                <button
                  className="btn secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void control(plan, 'pause')}
                >
                  <Pause size={15} />
                  暂停计划
                </button>
              )}
              {plan.status === 'paused' && (
                <button
                  className="btn secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void control(plan, 'resume')}
                >
                  <Play size={15} />
                  恢复计划
                </button>
              )}
              {plan.status !== 'closed' && (
                <button
                  className="btn subtle"
                  disabled={Boolean(busy)}
                  onClick={() => void control(plan, 'close')}
                >
                  <X size={15} />
                  关闭计划
                </button>
              )}
              {plan.lastJob && (
                <button
                  className="text-link"
                  aria-expanded={expanded === plan.id}
                  onClick={() => setExpanded(expanded === plan.id ? '' : plan.id)}
                >
                  {expanded === plan.id
                    ? '收起本轮任务'
                    : `查看本轮任务 · 新增 ${plan.lastJob.inserted} 家`}
                </button>
              )}
            </footer>
            {expanded === plan.id && plan.lastJob && (
              <BatchProgress
                job={plan.lastJob}
                busy={Boolean(busy)}
                control={(action) => void controlJob(plan.lastJob!.id, action)}
              />
            )}
          </section>
        ))}
      </div>
    </>
  );
}
