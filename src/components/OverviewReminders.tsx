import { ChevronRight } from 'lucide-react';
import type { OverviewData } from '../services/overview';

export function OverviewReminders({
  data,
  loading,
  error,
  onOpen,
}: {
  data: OverviewData | null;
  loading: boolean;
  error: string;
  onOpen: (to: string) => void;
}) {
  const items = data
    ? [
        { title: '逾期跟进', count: data.work.overdue, to: data.links.overdue },
        { title: '今日待跟进', count: data.work.today, to: data.links.today },
        { title: '暂停待核对', count: data.work.paused, to: data.links.paused },
        { title: '产品资料待审核', count: data.products.draft, to: data.products.to },
      ]
    : [];
  const ready = data?.sources.business.state === 'ready' && data.sources.products.state === 'ready';
  return (
    <div className="notification-panel">
      <h3>待处理提醒</h3>
      {loading && <p role="status">正在读取真实待办…</p>}
      {error && <p role="alert">{error}</p>}
      {data && (
        <p>
          {error ? '保留上次结果 · ' : '统计于 '}
          {new Date(data.asOf).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）
        </p>
      )}
      {data &&
        (['business', 'products'] as const).map(
          (key) =>
            data.sources[key].state !== 'ready' && (
              <p key={key} role="status">
                {key === 'business' ? '需求与跟进' : '产品资料'}
                {data.sources[key].state === 'stale'
                  ? '保留上次数据，当前状态需核对。'
                  : '暂时无法读取，请到对应页面核对。'}
              </p>
            ),
        )}
      {items
        .filter((item) => item.count !== null && item.count > 0)
        .map((item) => (
          <button key={item.title} onClick={() => onOpen(item.to)}>
            <span className="status-dot" />
            <div>
              <strong>{item.title}</strong>
              <small>{item.count} 项 · 查看对应明细</small>
            </div>
            <ChevronRight size={14} />
          </button>
        ))}
      {!loading && !error && ready && items.every((item) => item.count === 0) && (
        <p>当前没有到期或待核对事项。</p>
      )}
      {!loading && items.some((item) => item.count === null) && (
        <p>部分提醒暂时无法统计，请到对应页面核对。</p>
      )}
    </div>
  );
}
