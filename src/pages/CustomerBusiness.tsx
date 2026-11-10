import {
  businessNavigation,
  matchesTaskNavigation,
  updateBusinessNavigation,
} from '../domain/business-navigation.mjs';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { customerBusinessApi } from '../services/customerBusiness';
import type { BusinessWorkspace } from '../services/customerBusiness';
import { formatBeijingTime } from '../domain/date-time.mjs';
import './CustomerBusiness.css';

const statusNames = { pending: '待执行', completed: '已完成', skipped: '跳过', cancelled: '终止' };
export function CustomerBusiness() {
  const [params, setParams] = useSearchParams();
  const navigation = businessNavigation(params);
  const customerId = params.get('customerId') || '';
  const [data, setData] = useState<BusinessWorkspace | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const status = navigation.state;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const result = await customerBusinessApi.workspace(
          { customerId: customerId || undefined },
          signal,
        );
        if (!signal?.aborted) {
          setData(result);
          setError('');
        }
      } catch (cause) {
        if (!signal?.aborted) setError(cause instanceof Error ? cause.message : '任务读取失败');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [customerId],
  );
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void load(controller.signal);
    const timer = setInterval(() => {
      if (!document.hidden) void load(controller.signal);
    }, 30000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);
  const names = new Map(data?.customers.map((c) => [c.id, c.name]));
  const tasks = (data?.tasks || [])
    .filter(
      (task) =>
        task.origin === 'automatic-followup' &&
        matchesTaskNavigation(task, navigation) &&
        (!query ||
          [names.get(task.customerId), task.title, task.notes]
            .join(' ')
            .toLowerCase()
            .includes(query.toLowerCase())),
    )
    .sort((a, b) => b.dueAt.localeCompare(a.dueAt));
  return (
    <div className="business-page">
      <PageHeading
        eyebrow="AUTOMATIC FOLLOW-UP"
        title="跟进任务"
        description="查看系统安排的后续追信和真实结果。暂停、恢复或关闭请进入所属发送计划。"
      >
        <button className="btn secondary" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={16} />
          刷新
        </button>
      </PageHeading>
      {error && <p role="alert">{error}</p>}
      {data?.feishu?.error && <p role="status">飞书同步待处理：{data.feishu.error}</p>}
      <div className="business-filters">
        <label>
          搜索客户或任务
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          状态
          <select
            value={status}
            onChange={(e) => setParams(updateBusinessNavigation(params, 'state', e.target.value))}
          >
            <option value="all">全部</option>
            {Object.entries(statusNames).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {navigation.bucket && (
          <p>
            当前筛选：到期跟进（北京时间）{' '}
            <Link
              to={
                customerId ? '/business?customerId=' + encodeURIComponent(customerId) : '/business'
              }
            >
              清除筛选
            </Link>
          </p>
        )}
        {customerId && <Link to="/business">查看全部客户</Link>}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>客户</th>
              <th>跟进安排</th>
              <th>计划时间（北京）</th>
              <th>状态</th>
              <th>执行说明</th>
              <th>所属计划</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <Link
                    to={
                      '/outreach?tab=conversations&customerId=' +
                      encodeURIComponent(task.customerId)
                    }
                  >
                    {names.get(task.customerId) || task.customerId}
                  </Link>
                </td>
                <td>
                  {task.title}
                  {task.displayId && <small> · {task.displayId}</small>}
                </td>
                <td>{formatBeijingTime(task.dueAt)}</td>
                <td>{statusNames[task.status]}</td>
                <td>{task.notes || task.completionNotes || '按计划等待执行'}</td>
                <td>
                  <Link
                    to={
                      '/outreach?tab=campaigns&campaignId=' +
                      encodeURIComponent(task.campaignId || '')
                    }
                  >
                    查看计划
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!tasks.length && (
        <p role="status">
          {loading
            ? '正在读取任务…'
            : '暂无符合条件的自动追信任务。首封发送和即时回复不计入跟进任务。'}
        </p>
      )}
    </div>
  );
}
