import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import type { Lead } from '../domain/types';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Avatar({
  lead,
  small = false,
}: {
  lead: Pick<Lead, 'initials' | 'color'>;
  small?: boolean;
}) {
  return (
    <span className={`company-avatar ${lead.color} ${small ? 'small' : ''}`}>{lead.initials}</span>
  );
}
export function SectionTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span>↗</span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
export function ExternalLink({
  href,
  children,
  className = 'btn secondary',
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={15} />
    </a>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Sparkline({ variant = 0 }: { variant?: number }) {
  const paths = [
    'M0 35L12 31 24 33 36 22 48 25 60 13 72 16 84 7 96 9 112 0',
    'M0 34L12 31 24 32 36 27 48 23 60 25 72 14 84 17 96 6 112 2',
    'M0 37L12 36 24 25 36 28 48 23 60 14 72 18 84 7 96 12 112 1',
  ];
  return (
    <svg className="sparkline" viewBox="0 0 115 43" fill="none" aria-hidden="true">
      <path
        d={paths[variant % 3]}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
