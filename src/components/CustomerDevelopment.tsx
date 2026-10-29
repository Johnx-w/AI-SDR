import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { Badge } from './ui';
import { formatBeijingTime } from '../domain/date-time.mjs';
import { customerDevelopmentApi, CustomerDevelopmentError } from '../services/customerDevelopment';
import type { CustomerDevelopmentSnapshot } from '../services/customerDevelopment';
import './CustomerDevelopment.css';

type Action = '' | 'pause' | 'review' | 'resume';
const actionLabels = { pause: '暂缓开发', review: '修改复查日期', resume: '恢复开发' };
const deliveryLabels: Record<string, string> = {
  received: '已收到',
  sent: '已发出',
  accepted: '服务商已接受',
  failed: '发送失败',
  unknown: '结果待核实',
  recorded: '已记录',
};
const emptyDraft = { reason: '', notes: '', reviewDate: '', resumeNotes: '', reviewed: false };
const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : '操作未完成，请刷新核对';
const beijingDay = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

export function CustomerDevelopment({ customerId }: { customerId: string }) {
  return <CustomerDevelopmentControl key={customerId} customerId={customerId} />;
}

export function CustomerDevelopmentControl({ customerId }: { customerId: string }) {
  const [snapshot, setSnapshot] = useState<CustomerDevelopmentSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<Action>('');
  const [draft, setDraft] = useState(emptyDraft);
  const active = useRef(true);
  const request = useRef(0);
  const reviewToken = useRef('');
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const current = ++request.current;
      setLoading(true);
      try {
        const value = await customerDevelopmentApi.get(customerId, signal);
        if (active.current && current === request.current) {
          if (reviewToken.current && reviewToken.current !== value.reviewToken)
            setDraft((current) => ({ ...current, reviewed: false }));
          reviewToken.current = value.reviewToken;
          setSnapshot(value);
          setError('');
        }
      } catch (reason) {
        if (active.current && current === request.current && !signal?.aborted)
          setError(errorText(reason));
      } finally {
        if (active.current && current === request.current) setLoading(false);
      }
    },
    [customerId],
  );
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ customerId: string }>).detail?.customerId === customerId)
        void load();
    };
    window.addEventListener('customer-development-changed', changed);
    return () => {
      active.current = false;
      request.current++;
      controller.abort();
      window.removeEventListener('customer-development-changed', changed);
    };
  }, [customerId, load]);
  const start = (next: Exclude<Action, ''>) => {
    setAction(next);
    setError('');
    setNotice('');
    setDraft({
      ...emptyDraft,
      reason: snapshot?.development.reason || '',
      notes: snapshot?.development.notes || '',
      reviewDate: snapshot?.development.reviewDate || '',
    });
    if (next === 'resume') void load();
  };
  const save = async () => {
    if (!snapshot || !action || saving) return;
    setSaving(true);
    setError('');
    request.current++;
    try {
      const value = await customerDevelopmentApi.act(customerId, {
        action,
        expectedVersion: snapshot.development.version,
        ...(action === 'pause'
          ? { reason: draft.reason, notes: draft.notes, reviewDate: draft.reviewDate }
          : {}),
        ...(action === 'review' ? { reviewDate: draft.reviewDate } : {}),
        ...(action === 'resume'
          ? {
              resumeNotes: draft.resumeNotes,
              reviewed: draft.reviewed,
              reviewToken: snapshot.reviewToken,
            }
          : {}),
      });
      if (!active.current) return;
      request.current++;
      reviewToken.current = value.reviewToken;
      setSnapshot(value);
      setAction('');
      setNotice(
        action === 'resume'
          ? '已解除本次暂缓，请按新安排核对草稿与任务后继续。'
          : action === 'review'
            ? '复查安排已更新，客户继续保持暂缓。'
            : '该客户的后续自动邮件已暂缓。',
      );
      window.dispatchEvent(
        new CustomEvent('customer-development-changed', { detail: { customerId } }),
      );
    } catch (reason) {
      if (!active.current) return;
      if (reason instanceof CustomerDevelopmentError && reason.status === 409) {
        setDraft((value) => ({ ...value, reviewed: false }));
        await load();
      }
      if (active.current) setError(errorText(reason));
    } finally {
      if (active.current) setSaving(false);
    }
  };
  const development = snapshot?.development;
  const restricted =
    snapshot?.doNotContact ||
    /暂不开发|暂缓开发|暂停开发|停止开发|拒绝联系|已退订/.test(snapshot?.sourceStatus || '');
  const locked = loading || saving;
  return (
    <section className="customer-development" aria-label="邮件开发管理" aria-busy={locked}>
      <div className="customer-development-heading">
        <h3>邮件开发</h3>
        {development && (
          <Badge tone={development.paused ? 'amber' : 'neutral'}>
            {development.paused ? '暂缓开发' : '未设置暂缓'}
          </Badge>
        )}
        {!action && development && (
          <div className="customer-development-actions">
            {development.paused ? (
              <>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={locked}
                  onClick={() => start('review')}
                >
                  修改复查日期
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={locked}
                  onClick={() => start('resume')}
                >
                  <Play size={14} />
                  恢复开发
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn secondary"
                disabled={locked}
                onClick={() => start('pause')}
              >
                <Pause size={14} />
                暂缓开发
              </button>
            )}
          </div>
        )}
      </div>
      {loading && <p role="status">正在核对邮件开发状态…</p>}
      {error && (
        <p role="alert" className="customer-development-error">
          {error}{' '}
          <button type="button" className="text-link" disabled={locked} onClick={() => void load()}>
            <RefreshCw size={12} />
            重新读取
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {(snapshot?.status || snapshot?.sourceStatus) && (
        <p className="customer-development-muted">
          当前开发状态：{snapshot.status || snapshot.sourceStatus}
        </p>
      )}
      {restricted && (
        <p className="customer-development-warning">
          档案原有联系限制仍然有效，恢复本次暂缓不会解除其他限制。
        </p>
      )}
      {development?.paused && (
        <div className="customer-development-current">
          <p>
            <strong>{development.reason}</strong>
            {development.notes && ` · ${development.notes}`}
          </p>
          <p>
            {development.reviewDate
              ? `${development.reviewDate} 复查（北京时间）${development.reviewDate <= beijingDay() ? ' · 已到期，请复查' : ''}`
              : '继续暂缓，未设置复查日期'}
          </p>
          <p className="customer-development-muted">
            正常收信，人工仍可回复；人工回复不会解除暂缓。已提交发送的邮件无法保证撤回。
          </p>
        </div>
      )}
      {action && snapshot && (
        <form
          className="customer-development-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h4>{actionLabels[action]}</h4>
          {action === 'pause' && (
            <>
              <p>暂缓该企业所有已关联联系人的自动邮件，并暂停相关系统跟进任务。</p>
              <label>
                暂缓原因
                <select
                  value={draft.reason}
                  required
                  disabled={locked}
                  onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
                >
                  <option value="">请选择原因</option>
                  {['客户要求稍后联系', '我方暂缓', '其他'].map((reason) => (
                    <option key={reason} value={reason}>
                      {reason}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                原因说明{draft.reason !== '其他' && '（可选）'}
                <textarea
                  value={draft.notes}
                  required={draft.reason === '其他'}
                  maxLength={2000}
                  rows={2}
                  disabled={locked}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </label>
            </>
          )}
          {action !== 'resume' && (
            <label>
              复查日期（可选，北京时间）
              <input
                type="date"
                min={beijingDay()}
                value={draft.reviewDate}
                disabled={locked}
                onChange={(event) => setDraft({ ...draft, reviewDate: event.target.value })}
              />
              <span>不设日期可持续暂缓；到期仅在通知铃铛提醒，不自动恢复或发信。</span>
            </label>
          )}
          {action === 'review' && (
            <button
              type="button"
              className="text-link"
              disabled={locked}
              onClick={() => setDraft({ ...draft, reviewDate: '' })}
            >
              继续暂缓，不设日期
            </button>
          )}
          {action === 'resume' && (
            <>
              <div className="customer-development-context">
                <h4>最近邮件</h4>
                {snapshot.messages.length ? (
                  snapshot.messages.map((mail) => (
                    <article key={mail.id}>
                      <strong>
                        {mail.direction === 'inbound' ? '收到' : '发出'} ·{' '}
                        {mail.subject || '（无主题）'}
                      </strong>
                      <small>
                        {formatBeijingTime(mail.occurredAt)} ·{' '}
                        {deliveryLabels[mail.deliveryStatus] || '待核对'}
                      </small>
                      <p>
                        {mail.body.slice(0, 180)}
                        {mail.body.length > 180 ? '…' : ''}
                      </p>
                    </article>
                  ))
                ) : (
                  <p>尚无已保存的真实往来邮件，请核对开发信计划与原邮箱。</p>
                )}
                {snapshot.tasks.length > 0 && (
                  <>
                    <h4>待处理跟进任务</h4>
                    <ul>
                      {snapshot.tasks.map((task) => (
                        <li key={task.id}>
                          {task.title} · {task.status === 'paused' ? '已暂停' : '待执行'}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <Link to="/inbox?tab=campaigns">查看开发信计划与草稿</Link>
              </div>
              <label>
                下一步发送安排
                <textarea
                  value={draft.resumeNotes}
                  required
                  maxLength={2000}
                  rows={3}
                  placeholder="例如：核对最新回复后修改草稿，下周一按计划时段发送。"
                  disabled={locked}
                  onChange={(event) => setDraft({ ...draft, resumeNotes: event.target.value })}
                />
              </label>
              <label className="customer-development-check">
                <input
                  type="checkbox"
                  checked={draft.reviewed}
                  required
                  disabled={locked}
                  onChange={(event) => setDraft({ ...draft, reviewed: event.target.checked })}
                />
                已核对最新沟通及原草稿，确认上述下一步安排
              </label>
              <p>
                恢复本次暂缓不会立即发信。旧草稿需要重新审核，原跟进任务需单独核对恢复；邮箱和计划各自的暂停继续有效。
              </p>
            </>
          )}
          <div className="customer-development-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={
                locked || (action === 'resume' && (!draft.reviewed || !draft.resumeNotes.trim()))
              }
            >
              {saving
                ? '正在保存…'
                : action === 'review'
                  ? '保存复查安排'
                  : action === 'resume'
                    ? '确认恢复开发'
                    : '确认暂缓开发'}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={saving}
              onClick={() => setAction('')}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {!!development?.audit.length && (
        <details className="customer-development-history">
          <summary>操作记录（{development.audit.length}）</summary>
          <ol>
            {[...development.audit].reverse().map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <strong>
                  {actionLabels[entry.action]} · {entry.actor}
                </strong>
                <small>{formatBeijingTime(entry.at)}</small>
                <p>
                  {entry.action === 'resume'
                    ? entry.resumeNotes
                    : [entry.reason, entry.notes].filter(Boolean).join(' · ')}
                  {entry.reviewDate
                    ? ` · ${entry.reviewDate} 复查`
                    : entry.action !== 'resume'
                      ? ' · 未设置复查日期'
                      : ''}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
