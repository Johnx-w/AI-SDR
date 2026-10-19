import { useEffect, useState } from 'react';
import { ArrowUpRight, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge } from './ui';

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
}
interface WebsiteContacts {
  contacts: Contact[];
  checkedAt: string;
  checkedUrls: string[];
  failures: { url: string; reason: string }[];
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
const methodNames: Record<string, string> = {
  tel_link: '电话链接',
  mailto_link: '邮件链接',
  json_ld: '网站结构化数据',
  protected_email: '公开邮件保护编码',
  visible_text: '网页可见正文',
  markdown_link: '网页链接',
};

export function ContactPanel({ lead, real }: { lead: ContactLead; real: boolean }) {
  const [result, setResult] = useState<WebsiteContacts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!real) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch(
      '/api/v1/leads/real/' +
        encodeURIComponent(lead.id) +
        '/contacts' +
        (refresh ? '?refresh=1' : ''),
      { signal: controller.signal },
    )
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || '官网联系方式读取失败');
        if (!Array.isArray(body.contacts)) throw new Error('官网返回的联系方式结构异常');
        if (!controller.signal.aborted) setResult(body);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [lead.id, real, refresh]);
  const contacts = result?.contacts || [];
  const values = (kind: string, existing: string) => [
    ...new Set([
      ...existing.split('\n').filter(Boolean),
      ...contacts.filter((c) => c.kind === kind).map((c) => c.value),
    ]),
  ];
  const email = values('email', lead.email);
  const phone = values('phone', lead.phone);
  return (
    <>
      <div className="info-callout">
        <ShieldCheck size={18} />
        <p>
          {real
            ? '公开发现的联系方式尚未验证投递；电话号码不等于已授权的 WhatsApp 账号。'
            : '以下为虚构联系方式，用于演示。'}
        </p>
      </div>
      {real && (
        <div className="contact-research-bar">
          <div>
            <strong>官网联系方式核实</strong>
            <p>
              {loading
                ? '正在检查当前页面、首页与站内联系页…'
                : result
                  ? '官网补全于 ' +
                    new Date(result.checkedAt).toLocaleString('zh-CN') +
                    ' · 未写回飞书'
                  : '保留飞书已有记录，补充官网公开联系方式'}
            </p>
          </div>
          <button
            className="btn secondary"
            disabled={loading}
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            {loading ? '正在读取' : '重新读取官网'}
          </button>
        </div>
      )}
      {error && (
        <p className="contact-research-error" role="alert">
          {error} 原有飞书记录已保留。
        </p>
      )}
      <div className="detail-contact">
        <span>联系人</span>
        <strong>{lead.contact || '未提供'}</strong>
      </div>
      <div className="detail-contact">
        <span>邮箱</span>
        <strong>
          {email.length
            ? email.map((v) => (
                <a className="contact-value-link" href={'mailto:' + v} key={v}>
                  {v}
                </a>
              ))
            : loading
              ? '正在核实官网…'
              : '未发现公开邮箱'}
        </strong>
      </div>
      <div className="detail-contact">
        <span>电话</span>
        <strong>
          {phone.length
            ? phone.map((v) => (
                <a
                  className="contact-value-link"
                  href={
                    'tel:' +
                    (contacts.find((c) => c.kind === 'phone' && c.value === v)?.normalized ||
                      v.replace(/[^+\d]/g, ''))
                  }
                  key={v}
                >
                  {v}
                </a>
              ))
            : loading
              ? '正在核实官网…'
              : '未发现公开电话'}
        </strong>
      </div>
      <div className="detail-contact">
        <span>来源链接</span>
        <strong>
          {webUrl(lead.website) ? (
            <a
              className="contact-value-link"
              href={webUrl(lead.website)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {lead.website} <ArrowUpRight size={13} />
            </a>
          ) : (
            lead.website || '未提供'
          )}
        </strong>
      </div>
      {contacts.length > 0 && (
        <div className="contact-evidence-heading">
          <h3>本次官网发现</h3>
          <Badge tone="green">{contacts.length} 条 · 公开未验证</Badge>
        </div>
      )}
      {contacts.map((c, i) => (
        <article className="evidence-fact" key={c.kind + ':' + (c.normalized || c.value) + ':' + i}>
          <Badge>{c.kind === 'phone' ? '电话' : '邮箱'}</Badge>
          <strong>{c.value}</strong>
          <span className="contact-method">{methodNames[c.method || ''] || '公开网页'}</span>
          <blockquote>{c.quote}</blockquote>
          {webUrl(c.source_url) && (
            <a href={webUrl(c.source_url)} target="_blank" rel="noopener noreferrer">
              查看来源 <ArrowUpRight size={14} />
            </a>
          )}
        </article>
      ))}
      {result && contacts.length === 0 && !loading && (
        <p className="muted">本次已读取的页面未发现可识别的公开联系方式。</p>
      )}
      {result && result.checkedUrls.length > 0 && (
        <details className="contact-checked-pages">
          <summary>本次检查的页面（{result.checkedUrls.length}）</summary>
          {result.checkedUrls.map((url) => (
            <a href={webUrl(url)} target="_blank" rel="noopener noreferrer" key={url}>
              {url}
            </a>
          ))}
        </details>
      )}
      {result?.failures?.length ? (
        <p className="contact-research-error">部分页面未能读取，以上结果仅覆盖已成功检查的页面。</p>
      ) : null}
      {lead.contactEvidence.length > 0 && (
        <h3 className="contact-history-heading">飞书已有联系证据</h3>
      )}
      {lead.contactEvidence.map((c, i) => (
        <article className="evidence-fact" key={'saved-' + i}>
          <Badge>{c.kind === 'phone' ? '电话' : c.kind === 'email' ? '邮箱' : c.kind}</Badge>
          <strong>{c.value}</strong>
          <blockquote>{c.quote}</blockquote>
          {webUrl(c.source_url) && (
            <a href={webUrl(c.source_url)} target="_blank" rel="noopener noreferrer">
              原始来源 <ArrowUpRight size={14} />
            </a>
          )}
        </article>
      ))}
    </>
  );
}
