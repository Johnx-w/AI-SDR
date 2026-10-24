import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { Empty } from './ui';
import { groupWebsiteEvidence, websiteEvidenceFieldLabel } from '../domain/website-evidence.mjs';
import { formatBeijingText } from '../domain/date-time.mjs';
import './WebsiteEvidencePanel.css';

interface EvidenceFact {
  field?: string;
  kind?: string;
  value?: unknown;
  quote?: string;
  source_url?: string;
}
const safeSource = (value: string) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

function summaryRows(groups: ReturnType<typeof groupWebsiteEvidence>) {
  const collections = new Set(['经营产品', '制造产品', '客户类型', '业务特征', '服务范围']);
  const rows: (ReturnType<typeof groupWebsiteEvidence>[number] & { parts: string[] })[] = [];
  const byCategory = new Map<string, (typeof rows)[number]>();
  for (const group of groups) {
    const prefix = [group.category + '：', group.category + ':'].find((value) =>
      group.summary.startsWith(value),
    );
    const text = prefix ? group.summary.slice(prefix.length).trimStart() : group.summary;
    const existing = collections.has(group.category) && byCategory.get(group.category);
    if (existing) {
      if (!existing.parts.includes(text)) existing.parts.push(text);
      existing.records.push(...group.records);
    } else {
      const row = { ...group, records: [...group.records], parts: [text] };
      rows.push(row);
      if (collections.has(group.category)) byCategory.set(group.category, row);
    }
  }
  return rows.map((row) => {
    const visible = row.parts.slice(0, 3).join('、');
    const summary = visible + (row.parts.length > 3 ? `等 ${row.parts.length} 项` : '');
    return { ...row, summary: summary.length > 90 ? summary.slice(0, 89) + '…' : summary };
  });
}

export function WebsiteEvidencePanel({
  facts,
  identityEvidence = [],
}: {
  facts: EvidenceFact[];
  identityEvidence?: EvidenceFact[];
}) {
  const groups = summaryRows(groupWebsiteEvidence(facts, identityEvidence));
  if (!groups.length)
    return <Empty title="尚无官网证据" detail="企业研究完成后会显示已记录的事实与来源。" />;
  return (
    <section className="website-evidence-panel" aria-label="官网证据">
      <div className="website-evidence-toolbar">
        <span>点击摘要查看原文与来源</span>
        <span>共 {groups.length} 条摘要</span>
      </div>
      <div className="website-evidence-list">
        {groups.map((group) => {
          const citations = new Map<
            string,
            { fields: string[]; value: string; quote: string; source_url: string }
          >();
          for (const record of group.records) {
            const key = JSON.stringify([record.value, record.quote, record.source_url]);
            const existing = citations.get(key);
            const label = websiteEvidenceFieldLabel(record.field);
            if (existing) {
              if (!existing.fields.includes(label)) existing.fields.push(label);
            } else citations.set(key, { ...record, fields: [label] });
          }
          const records = [...citations.values()];
          return (
            <details className="website-evidence-item" key={group.id}>
              <summary>
                <ChevronRight size={14} className="website-evidence-chevron" aria-hidden="true" />
                <span className="website-evidence-category">{group.category}</span>
                <span className="website-evidence-summary">{formatBeijingText(group.summary)}</span>
                <span className="website-evidence-count">{records.length} 条记录</span>
              </summary>
              <div className="website-evidence-originals">
                {records.map((record, index) => (
                  <article className="website-evidence-original" key={index}>
                    <div className="website-evidence-record-type">{record.fields.join('、')}</div>
                    {record.value && (
                      <p className="website-evidence-value">{formatBeijingText(record.value)}</p>
                    )}
                    <blockquote>{formatBeijingText(record.quote || '原文未保存')}</blockquote>
                    {safeSource(record.source_url) ? (
                      <a
                        href={safeSource(record.source_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {record.source_url} <ArrowUpRight size={12} />
                      </a>
                    ) : (
                      <span className="website-evidence-source-missing">
                        {record.source_url
                          ? record.source_url + '（链接不可打开）'
                          : '来源链接未记录'}
                      </span>
                    )}
                  </article>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
