import { ArrowUpRight } from 'lucide-react';
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
export function ContactPanel({ lead }: { lead: ContactLead }) {
  const values = (text: string) => [
    ...new Set(
      text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const email = values(lead.email);
  const phone = values(lead.phone);
  return (
    <>
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
                  href={'tel:' + v.replace(/ ext\. (\d+)$/, ';ext=$1').replace(/ /g, '')}
                  key={v}
                >
                  {v}
                </a>
              ))
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
      <div className="detail-contact">
        <span>企业实际地址</span>
        <strong>{lead.address || '未确认'}</strong>
      </div>
      <div className="detail-contact">
        <span>服务地区</span>
        <strong>{lead.serviceAreas || '未确认'}</strong>
      </div>
      {(lead.social || []).map((s) => (
        <div className="detail-contact" key={s.platform + s.url}>
          <span>{s.platform}</span>
          <strong>
            {webUrl(s.url) ? (
              <a
                className="contact-value-link"
                href={webUrl(s.url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {s.url} <ArrowUpRight size={13} />
              </a>
            ) : (
              s.url
            )}
          </strong>
        </div>
      ))}
      {[...(lead.locationEvidence || []), ...(lead.social || [])].map((e, i) => (
        <article className="evidence-fact" key={'metadata-' + i}>
          <strong>
            {'platform' in e
              ? e.platform
              : e.name || [e.street, e.city, e.region].filter(Boolean).join(', ')}
          </strong>
          <blockquote>{e.quote}</blockquote>
          {webUrl(e.source_url) && (
            <a href={webUrl(e.source_url)} target="_blank" rel="noopener noreferrer">
              原始来源 <ArrowUpRight size={14} />
            </a>
          )}
        </article>
      ))}
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
