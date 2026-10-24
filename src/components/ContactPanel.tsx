import { useState } from 'react';
import { ArrowUpRight, Mail, Pencil, Phone, Save } from 'lucide-react';
import { buildContactPresentation } from '../domain/contact-presentation.mjs';
import type { ContactPresentationRecord } from '../domain/contact-presentation.mjs';
import { formatBeijingText } from '../domain/date-time.mjs';
import './ContactPanel.css';

interface Contact {
  kind: string;
  value: string;
  normalized?: string;
  quote: string;
  source_url: string;
  method?: string;
}
interface ContactLead {
  id: string;
  name: string;
  contact: string;
  email: string;
  phone: string;
  website: string;
  contactEvidence: Contact[];
  address?: string;
  serviceAreas?: string;
  social?: { platform: string; url: string; quote: string; source_url: string }[];
  locationEvidence?: {
    name?: string;
    street?: string;
    city?: string;
    region?: string;
    quote: string;
    source_url: string;
  }[];
}
const webUrl = (s: string) => {
  try {
    const u = new URL(s);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
};
type ContactValues = Pick<ContactLead, 'contact' | 'email' | 'phone'>;
function sourceRecords(records: ContactPresentationRecord[]) {
  const citations = new Map<string, ContactPresentationRecord & { values: string[] }>();
  for (const record of records) {
    const key = JSON.stringify([record.label.toLowerCase(), record.quote, record.source_url]);
    const saved = citations.get(key);
    if (saved) {
      if (!saved.values.includes(record.value)) saved.values.push(record.value);
    } else citations.set(key, { ...record, values: [record.value] });
  }
  return [...citations.values()];
}
export function ContactPanel({
  lead,
  onSaved,
}: {
  lead: ContactLead;
  onSaved?: (saved: ContactValues & { fields: Record<string, string> }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ContactValues>({
    contact: lead.contact,
    email: lead.email,
    phone: lead.phone,
  });
  const [expected, setExpected] = useState(draft);
  const changed = (Object.keys(draft) as (keyof ContactValues)[]).some(
    (key) => draft[key] !== expected[key],
  );
  const startEditing = () => {
    const current = { contact: lead.contact, email: lead.email, phone: lead.phone };
    setDraft(current);
    setExpected(current);
    setError('');
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const contacts = Object.fromEntries(
        Object.entries(draft).filter(
          ([key, value]) => value !== expected[key as keyof ContactValues],
        ),
      );
      const response = await fetch(`/api/v1/leads/real/${encodeURIComponent(lead.id)}/contacts`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts, expected }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '联系方式保存失败');
      onSaved?.({ ...data.contacts, fields: data.lead.fields });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const presentation = buildContactPresentation(lead);
  const hasSecondary =
    (!editing && lead.contact) || lead.address || lead.serviceAreas || presentation.social.length;
  return (
    <section className="contact-panel" aria-label="联系方式">
      <div className="contact-panel-toolbar">
        <h3>联系方式</h3>
        {onSaved && !editing && (
          <button className="btn secondary" onClick={startEditing}>
            <Pencil size={14} /> 修改联系方式
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="contact-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            邮箱
            <textarea
              value={draft.email}
              rows={2}
              maxLength={5000}
              disabled={saving}
              placeholder="每行一个邮箱"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />
          </label>
          <label>
            电话
            <textarea
              value={draft.phone}
              rows={2}
              maxLength={5000}
              disabled={saving}
              placeholder="每行一个号码，含国际区号"
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            />
          </label>
          <label>
            联系人
            <input
              value={draft.contact}
              maxLength={200}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, contact: e.target.value })}
            />
          </label>
          {error && (
            <p className="contact-edit-error" role="alert">
              {error}
            </p>
          )}
          <div className="contact-edit-actions">
            <button
              type="button"
              className="btn secondary"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
            <button type="submit" className="btn primary" disabled={saving || !changed}>
              <Save size={14} /> {saving ? '正在保存…' : '保存修改'}
            </button>
          </div>
        </form>
      ) : (
        <div className="contact-primary-grid">
          {[
            {
              label: '邮箱',
              icon: <Mail size={16} />,
              values: presentation.emails,
              empty: '未记录邮箱',
            },
            {
              label: '电话',
              icon: <Phone size={16} />,
              values: presentation.phones,
              empty: '未记录电话',
            },
          ].map((channel) => (
            <section
              className="contact-primary-card"
              aria-label={channel.label}
              key={channel.label}
            >
              <h4>
                {channel.icon}
                {channel.label}
              </h4>
              {channel.values.length ? (
                <div className="contact-primary-values">
                  {channel.values.map((item) =>
                    item.href ? (
                      <a href={item.href} key={item.value}>
                        {item.value}
                      </a>
                    ) : (
                      <span key={item.value}>{item.value}</span>
                    ),
                  )}
                </div>
              ) : (
                <p className="contact-not-recorded">{channel.empty}</p>
              )}
            </section>
          ))}
        </div>
      )}
      {Boolean(hasSecondary) && (
        <section className="contact-secondary" aria-label="其他联系资料">
          <h3>其他联系资料</h3>
          <dl className="contact-secondary-fields">
            {!editing && lead.contact && (
              <div>
                <dt>联系人</dt>
                <dd>{lead.contact}</dd>
              </div>
            )}
            {lead.address && (
              <div>
                <dt>企业地址</dt>
                <dd>{lead.address}</dd>
              </div>
            )}
            {lead.serviceAreas && (
              <div>
                <dt>服务地区</dt>
                <dd>{lead.serviceAreas}</dd>
              </div>
            )}
            {presentation.social.map((social) => (
              <div key={social.platform + social.url}>
                <dt>{social.platform}</dt>
                <dd>
                  {social.href ? (
                    <a href={social.href} target="_blank" rel="noopener noreferrer">
                      {social.url} <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    social.url
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {presentation.evidenceGroups.length > 0 && (
        <details className="contact-source-evidence">
          <summary>来源证据（{presentation.evidenceGroups.length} 项）</summary>
          <div className="contact-evidence-groups">
            {presentation.evidenceGroups.map((group) => (
              <section className="contact-evidence-group" key={group.id}>
                <h4>{group.label}</h4>
                <p className="contact-evidence-value">{group.value}</p>
                {sourceRecords(group.records).map((record, index) => (
                  <article className="contact-source-record" key={index}>
                    {record.label !== group.label && <span>{record.label}</span>}
                    {record.values
                      .filter((value) => value && value !== group.value)
                      .map((value) => (
                        <p key={value}>{value}</p>
                      ))}
                    <blockquote>{formatBeijingText(record.quote || '原文未保存')}</blockquote>
                    {webUrl(record.source_url) ? (
                      <a href={webUrl(record.source_url)} target="_blank" rel="noopener noreferrer">
                        {record.source_url} <ArrowUpRight size={12} />
                      </a>
                    ) : (
                      <span className="contact-source-missing">
                        {record.source_url
                          ? record.source_url + '（链接不可打开）'
                          : '来源链接未记录'}
                      </span>
                    )}
                  </article>
                ))}
              </section>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
