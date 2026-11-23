import { useState, type ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from 'lucide-react';
import './SectionWorkspace.css';

type SectionGroup = {
  group?: string;
  items: { id: string; label: string; icon: LucideIcon; count?: number | null }[];
};

export function SectionWorkspace({
  title,
  icon: Icon,
  sections,
  selected,
  onSelect,
  children,
  sidebarExtra,
  className = '',
  panelPrefix,
  collapsible = false,
}: {
  title: string;
  icon: LucideIcon;
  sections: SectionGroup[];
  selected: string;
  onSelect: (id: string) => void;
  children: ReactNode;
  sidebarExtra?: ReactNode;
  className?: string;
  panelPrefix?: string;
  collapsible?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(collapsible);
  const compact = collapsible && collapsed;
  return (
    <div className={`section-workspace ${className}${compact ? ' section-compact' : ''}`}>
      <aside className="section-nav" aria-label={title + '导航'}>
        <div className="section-nav-title">
          {!compact && (
            <>
              <span>
                <Icon size={19} />
              </span>
              <strong>{title}</strong>
            </>
          )}
          {collapsible && (
            <button
              type="button"
              className="section-toggle"
              aria-expanded={!compact}
              aria-label={compact ? '展开栏目导航' : '收起栏目导航'}
              title={compact ? '展开栏目导航' : '收起栏目导航'}
              onClick={() => setCollapsed(!collapsed)}
            >
              {compact ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          )}
        </div>
        {!compact && (
          <>
            <nav
              className="section-nav-groups"
              role={panelPrefix ? 'tablist' : undefined}
              aria-label={title + '栏目'}
            >
              {sections.map((group) => (
                <div key={group.group ?? title} className="section-nav-group">
                  {group.group && <div className="section-caption">{group.group}</div>}
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role={panelPrefix ? 'tab' : undefined}
                      aria-current={!panelPrefix && selected === item.id ? 'page' : undefined}
                      aria-selected={panelPrefix ? selected === item.id : undefined}
                      id={panelPrefix ? panelPrefix + item.id : undefined}
                      onClick={() => onSelect(item.id)}
                    >
                      <item.icon size={16} />
                      <span>{item.label}</span>
                      {item.count != null && <small>{item.count}</small>}
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            {sidebarExtra}
          </>
        )}
      </aside>
      <div className="section-content">{children}</div>
    </div>
  );
}
