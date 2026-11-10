import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { customerBusinessApi } from '../services/customerBusiness';
import type { BusinessWorkspace } from '../services/customerBusiness';
import './CustomerBusinessSummary.css';

export function CustomerBusinessSummary({ customerId }: { customerId: string }) {
  const [data, setData] = useState<BusinessWorkspace | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    void customerBusinessApi
      .workspace({ customerId }, controller.signal)
      .then(setData)
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '业务记录暂时无法读取');
      });
    return () => controller.abort();
  }, [customerId]);
  const link = (tab: string) => '/business?' + new URLSearchParams({ customerId, tab });
  const context = data?.customerContexts.find((row) => row.customerId === customerId);
  return (
    <div className="customer-business-summary">
      {context?.fixedEmail && <p>固定对外邮箱：{context.fixedEmail}</p>}
      {context?.doNotContact && <p role="alert">客户已明确拒绝联系。</p>}
      <div className="business-summary-links">
        <Link
          className="btn secondary"
          to={'/outreach?tab=conversations&customerId=' + encodeURIComponent(customerId)}
        >
          客户邮件
        </Link>
        <Link className="btn secondary" to={link('tasks')}>
          自动跟进任务
        </Link>
      </div>
      {error && <p role="alert">{error}。可以进入跟进任务页刷新核对。</p>}
      {!data && !error && <p>正在读取已关联的业务记录…</p>}
      {data && (
        <>
          <h3>下一步行动</h3>
          {data.tasks
            .filter((row) => row.status === 'pending')
            .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
            .slice(0, 3)
            .map((row) => (
              <div className="business-summary-row" key={row.id}>
                <strong>{row.title}</strong>
                <span>
                  {new Date(row.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ·{' '}
                  {row.notes || '系统自动执行'}
                </span>
                <Link to={link('tasks')}>核对任务与执行结果</Link>
              </div>
            ))}
          {!data.tasks.some((row) => row.status === 'pending') && <p>暂无待执行跟进任务。</p>}
        </>
      )}
    </div>
  );
}
