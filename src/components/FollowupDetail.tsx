import type { ReactNode } from 'react';

export function FollowupDetail({
  id,
  title,
  subtitle,
  actions,
  events,
  children,
}: {
  id: string;
  title: string;
  subtitle?: ReactNode;
  actions: ReactNode;
  events: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="followup-detail" id={id} aria-label={title + ' 的跟进详情'}>
      <header>
        <div>
          <h2>{title}</h2>
          {subtitle}
        </div>
        <div className="followup-actions">{actions}</div>
      </header>
      <div className="followup-detail-grid">
        <div className="followup-letter">{children}</div>
        <aside className="followup-events">
          <h3>执行记录</h3>
          {events}
        </aside>
      </div>
    </section>
  );
}
