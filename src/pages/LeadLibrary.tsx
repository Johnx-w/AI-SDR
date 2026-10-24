import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { useWorkspace } from '../app/WorkspaceProvider';
import { Badge, Empty, Modal } from '../components/ui';
import { CompanyLogo } from '../components/CompanyLogo';
import { ContactPanel } from '../components/ContactPanel';
import { CustomerProfile } from '../components/CustomerProfile';
import { SupplementPanel } from '../components/SupplementPanel';
import type { ManualConfirmation, SupplementContext } from '../services/leadSupplements';
import { WebsiteEvidencePanel } from '../components/WebsiteEvidencePanel';
import { CustomerBusinessSummary } from '../components/CustomerBusinessSummary';
import { AssessmentPanel, CustomsEvidence } from '../components/AssessmentPanel';
import type { AssessmentSummary } from '../components/AssessmentPanel';
import type { CustomsBuyerEvidence } from '../domain/types';
import { exportCsv } from '../services/workspace';
import { formatBeijingText, formatBeijingTime } from '../domain/date-time.mjs';

interface Prospect {
  id: string;
  name: string;
  companyIdentity?: {
    legal_name: string | null;
    website_name: string | null;
    aliases: string[];
    status: string;
    notes?: string[];
    evidence: { field: string; value: string; quote: string; source_url: string }[];
  } | null;
  domain: string;
  market: string;
  type: string;
  product: string;
  match: string;
  score: number | null;
  grade: string;
  ratingReason?: string;
  assessment?: AssessmentSummary | null;
  confirmations?: ManualConfirmation[];
  manualPurchaseNeed?: string;
  customsEvidence?: CustomsBuyerEvidence[];
  status: string;
  region: string;
  city: string;
  address?: string;
  serviceAreas?: string;
  mainProductPreference?: string;
  advertisingCodes?: string;
  demandProducts?: string;
  supplyOpportunity?: string;
  pendingQuestions?: string;
  industryProfile?: string;
  audience?: string;
  social?: { platform: string; url: string; quote: string; source_url: string }[];
  locationEvidence?: {
    name?: string;
    street?: string;
    city?: string;
    region?: string;
    quote: string;
    source_url: string;
  }[];
  contact: string;
  email: string;
  phone: string;
  website: string;
  source: string;
  evidence: string;
  facts: { field: string; value: string; quote: string; source_url?: string }[];
  contactEvidence: { kind: string; value: string; quote: string; source_url: string }[];
  updatedAt: string | number | null;
  fields: Record<string, string>;
}
const typeNames: Record<string, string> = {
  supplier: '专业供应商',
  importer: '进口商',
  trader: '贸易商',
  brand: '品牌商',
  installer: '安装服务商',
  distributor: '批发／经销商',
  wholesaler: '批发商',
  retailer: '零售商',
  contractor: '工程承包商',
  manufacturer: '制造商',
  service_provider: '服务商',
  unknown: '待核实',
};
const marketNames: Record<string, string> = {
  'United States': '美国',
  Australia: '澳大利亚',
  'United Kingdom': '英国',
};
const marketLabel = (s: string) => marketNames[s] || s;
const safeUrl = (s: string) => {
  try {
    const u = new URL(s);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
};
const customsRecordCount = (lead: Prospect) =>
  new Set(
    (lead.customsEvidence || []).flatMap((buyer) =>
      (buyer.records || []).map((record) => `${record.provider || ''}:${record.id}`),
    ),
  ).size;
const shortRatingReason = (lead: Prospect) => {
  const lines = (lead.assessment?.evidenceReason || lead.ratingReason || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const pending = lines.find((line) => /^(待补充依据|待补充)[:：]/.test(line));
  const reason =
    (['待核实', '待补全', '未评级'].includes(lead.grade) ? pending : '') ||
    lines.find((line) => /^(主营产品|明确经营品类|专业供货角色|综合供货角色)[:：]/.test(line)) ||
    (['待核实', '待补全', '未评级'].includes(lead.grade) ? '关键依据待补充' : '查看评级依据');
  return reason.length > 46 ? reason.slice(0, 45) + '…' : reason;
};
const contactPreparation = (lead: Prospect) => {
  const count = (value: string) =>
    value
      .split(/\n|[、；;]/)
      .map((item) => item.trim())
      .filter(Boolean).length;
  if (lead.email && lead.phone)
    return {
      label: '邮箱与电话已记录',
      detail: `${count(lead.email)} 个邮箱 · ${count(lead.phone)} 个电话`,
    };
  if (lead.email) return { label: '已记录邮箱', detail: `${count(lead.email)} 个公开邮箱入口` };
  if (lead.phone) return { label: '已记录电话', detail: `${count(lead.phone)} 个公开电话入口` };
  const forms = lead.contactEvidence.filter((entry) => entry.kind === 'form');
  if (forms.length) return { label: '已有联系表单', detail: `${forms.length} 个官网表单` };
  return { label: '联系入口待补', detail: '未发现公开邮箱或办公电话' };
};
export function LeadLibrary() {
  const { notify } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [remote, setRemote] = useState<{ leads: Prospect[]; syncedAt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState(params.get('q') || '');
  const [market, setMarket] = useState('');
  const [grade, setGrade] = useState('');
  const [product, setProduct] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('客户画像');
  const [supplement, setSupplement] = useState<SupplementContext | undefined>(undefined);
  const detailBody = useRef<HTMLDivElement>(null);
  async function load(signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/v1/leads/real', { signal });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || '飞书客户读取失败');
      if (!signal?.aborted) setRemote(d);
    } catch (e) {
      if (!signal?.aborted) {
        setRemote(null);
        setError((e as Error).message);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, []);
  useEffect(() => {
    setQuery(params.get('q') || '');
  }, [params.get('q')]);
  useEffect(() => {
    setSupplement(undefined);
  }, [params.get('lead')]);
  const leads = remote?.leads || [];
  const filtered = leads.filter(
    (l) =>
      (!query ||
        `${l.name} ${(l.companyIdentity?.aliases || []).join(' ')} ${l.domain} ${l.contact} ${l.email} ${l.source}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (!market || marketLabel(l.market) === market) &&
      (!grade || l.grade === grade) &&
      (!product || l.product === product) &&
      (!status || l.status === status),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const current = Math.min(page, pages);
  const rows = filtered.slice((current - 1) * 8, current * 8);
  const viewed = leads.find((l) => l.id === params.get('lead'));
  useEffect(() => {
    const body = detailBody.current;
    if (body) body.scrollTop = 0;
    const dialog = body?.closest('dialog');
    if (dialog) dialog.scrollTop = 0;
  }, [supplement, tab, viewed?.id]);
  const open = (id: string, detailTab = '客户画像') => {
    setSupplement(undefined);
    setParams({ dataset: 'real', lead: id });
    setTab(detailTab);
  };
  const close = () => setParams({ dataset: 'real' });
  const download = () => {
    exportCsv(
      filtered.map((l) => ({
        公司名称: l.name,
        官网名称: l.companyIdentity?.website_name || '',
        公司别名: l.companyIdentity?.aliases.join('、') || '',
        市场: marketLabel(l.market),
        类型: typeNames[l.type] || l.type,
        产品: l.product,
        评分: l.score ?? '未评分',
        初评结果: l.grade,
        评级依据: l.ratingReason || '',
        开发状态: l.status,
        广告代码: l.advertisingCodes || '',
        企业经营产品: l.product,
        主营产品概况: l.mainProductPreference || '',
        公开采购需求: l.demandProducts || '',
        主要供货机会: l.supplyOpportunity || '',
        待确认事项: l.pendingQuestions || '',
        客户行业画像: l.industryProfile || '',
        邮箱: l.email,
        电话: l.phone,
        企业官网: l.website,
        来源链接: l.source,
      })),
      '飞书真实客户.csv',
    );
    notify(`已导出 ${filtered.length} 条真实客户`);
  };
  return (
    <>
      <PageHeading eyebrow="CUSTOMER LIBRARY" title="客户库">
        <button className="btn secondary" disabled={!filtered.length} onClick={download}>
          <ArrowDownToLine size={16} />
          导出客户
        </button>
        <button className="btn primary" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          {loading ? '正在读取' : '刷新飞书客户'}
        </button>
      </PageHeading>
      <div className="library-stats">
        {[
          { name: '全部客户', value: leads.length },
          {
            name: 'A 级客户',
            value: leads.filter((l) => l.grade === 'A').length,
          },
          {
            name: '待补资料',
            value: leads.filter((l) => ['未评级', '待核实', '待补全'].includes(l.grade)).length,
          },
          { name: '已记录邮箱', value: leads.filter((l) => l.email).length },
        ].map((x) => (
          <div key={x.name}>
            <span>{x.name}</span>
            <strong>{x.value.toString().padStart(2, '0')}</strong>
          </div>
        ))}
      </div>
      <section className="panel library-table-panel">
        <div className="library-toolbar">
          <div className="search-field">
            <Search size={17} />
            <input
              aria-label="搜索公司或域名"
              placeholder="搜索公司、姓名、邮箱或来源域名…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
                if (params.has('q')) {
                  const p = new URLSearchParams(params);
                  p.delete('q');
                  setParams(p);
                }
              }}
            />
          </div>
        </div>
        <div className="library-filters">
          {[
            {
              label: '市场',
              val: market,
              set: setMarket,
              options: [...new Set(leads.map((l) => marketLabel(l.market)))],
            },
            {
              label: '评级',
              val: grade,
              set: setGrade,
              options: [...new Set(leads.map((l) => l.grade))],
            },
            {
              label: '产品',
              val: product,
              set: setProduct,
              options: [...new Set(leads.map((l) => l.product))],
            },
            {
              label: '状态',
              val: status,
              set: setStatus,
              options: [...new Set(leads.map((l) => l.status))],
            },
          ].map((f) => (
            <select
              aria-label={f.label + '筛选'}
              key={f.label}
              value={f.val}
              onChange={(e) => {
                f.set(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部{f.label}</option>
              {f.options.map((o) => (
                <option value={o} key={o}>
                  {o.length > 25 ? o.slice(0, 25) + '…' : o}
                </option>
              ))}
            </select>
          ))}
          <button
            className="text-link"
            onClick={() => {
              setMarket('');
              setGrade('');
              setProduct('');
              setStatus('');
              setQuery('');
              setPage(1);
            }}
          >
            重置
          </button>
          <span>共 {filtered.length} 条线索</span>
        </div>
        {loading ? (
          <div className="library-loading">
            <RefreshCw className="spin" size={25} />
            <h3>正在读取飞书客户</h3>
            <p>加载客户画像与官网证据…</p>
          </div>
        ) : error ? (
          <div className="empty-state error-state">
            <h3>暂时无法读取飞书客户</h3>
            <p>{error}</p>
            <button className="btn secondary" onClick={() => void load()}>
              重新读取
            </button>
          </div>
        ) : rows.length ? (
          <div className="table-scroll">
            <table className="reference-lead-table">
              <thead>
                <tr>
                  <th>公司名称／来源</th>
                  <th>市场与客户类型</th>
                  <th>初评结果</th>
                  <th>联系准备</th>
                  <th>开发状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr
                    key={l.id}
                    tabIndex={0}
                    onClick={() => open(l.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) open(l.id);
                    }}
                  >
                    <td>
                      <div className="company-cell">
                        <CompanyLogo id={l.id} name={l.name} />
                        <div>
                          <strong>{l.name}</strong>
                          <span className="subtext">{l.domain || '域名待核实'}</span>
                          <span className="subtext">企业 · B端</span>
                          {customsRecordCount(l) ? (
                            <button
                              className="text-link"
                              aria-label={`查看 ${l.name} 的海关记录`}
                              onClick={(e) => {
                                e.stopPropagation();
                                open(l.id, '海关记录');
                              }}
                            >
                              海关记录 {customsRecordCount(l)} 条
                              {l.customsEvidence?.some(
                                (buyer) => buyer.match?.status !== 'verified',
                              )
                                ? ' · 身份待核实'
                                : ''}
                            </button>
                          ) : (
                            <span className="subtext">
                              {l.customsEvidence?.length ? '海关线索待补票据' : '海关记录未关联'}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span>
                        {marketLabel(l.market) === '澳大利亚'
                          ? '🇦🇺'
                          : marketLabel(l.market) === '美国'
                            ? '🇺🇸'
                            : marketLabel(l.market) === '英国'
                              ? '🇬🇧'
                              : marketLabel(l.market) === '阿联酋'
                                ? '🇦🇪'
                                : '◎'}{' '}
                        {marketLabel(l.market)}
                      </span>
                      <span className="subtext">
                        {typeNames[l.type] || l.type}
                        {l.city ? ' · ' + l.city : ''}
                      </span>
                    </td>
                    <td>
                      <div className="reference-score">
                        <span className={'grade-box grade-' + l.grade}>
                          {l.score === null || !['A', 'B', 'C'].includes(l.grade) ? '—' : l.grade}
                        </span>
                        <div>
                          <strong>
                            {l.grade}
                            <small>{l.score === null ? '' : ' · 已支持' + l.score + '分'}</small>
                          </strong>
                          {l.score !== null ? (
                            <div className="tiny-track">
                              <i style={{ width: l.score + '%' }} />
                            </div>
                          ) : (
                            <span className="subtext">
                              {l.grade === '未评级' ? '尚未自动评级' : '手工记录'}
                            </span>
                          )}
                          <button
                            className="rating-reason-short text-link"
                            aria-label={`查看 ${l.name} 的评级依据`}
                            onClick={(e) => {
                              e.stopPropagation();
                              open(l.id, '最新评估');
                            }}
                          >
                            {shortRatingReason(l)}
                          </button>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={l.email || l.phone ? 'green' : 'neutral'}>
                        {contactPreparation(l).label}
                      </Badge>
                      <span className="subtext">{contactPreparation(l).detail}</span>
                    </td>
                    <td>
                      <Badge>{l.status}</Badge>
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={'查看 ' + l.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          open(l.id);
                        }}
                      >
                        <ChevronRight size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="暂无匹配客户" detail="飞书暂无记录或当前筛选无匹配项。" />
        )}
        <footer className="table-bottom library-pagination-footer">
          <div className="pagination">
            <button
              aria-label="上一页"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {current} / {pages}
            </span>
            <button
              aria-label="下一页"
              disabled={current === pages}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </footer>
      </section>
      {viewed && (
        <Modal title="客户档案" wide onClose={close}>
          <div className="modal-body prospect-detail" ref={detailBody}>
            <div className="prospect-title">
              <CompanyLogo key={viewed.id} id={viewed.id} name={viewed.name} />
              <div>
                <h2>{viewed.name}</h2>
                <p>
                  {safeUrl(viewed.website) ? (
                    <a
                      className="prospect-website-link"
                      href={new URL(safeUrl(viewed.website)!).origin + '/'}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {viewed.domain || new URL(safeUrl(viewed.website)!).hostname}{' '}
                      <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    viewed.domain
                  )}{' '}
                  · {marketLabel(viewed.market)}
                </p>
              </div>
            </div>
            {supplement ? (
              <SupplementPanel<Prospect>
                key={
                  viewed.id +
                  ':' +
                  supplement.category +
                  ':' +
                  supplement.dimension +
                  ':' +
                  supplement.pendingItem
                }
                leadId={viewed.id}
                assessment={viewed.assessment}
                context={supplement}
                onCancel={() => setSupplement(undefined)}
                onSaved={(saved) => {
                  setRemote(
                    (data) =>
                      data && {
                        ...data,
                        leads: data.leads.map((lead) =>
                          lead.id === viewed.id ? { ...lead, ...saved } : lead,
                        ),
                      },
                  );
                  setSupplement(undefined);
                  notify(
                    saved.assessment
                      ? '补充资料已保存，档案与评级已更新'
                      : '补充资料已保存，档案已更新',
                  );
                }}
              />
            ) : (
              <>
                <div className="detail-tabs">
                  {[
                    '客户画像',
                    '海关记录',
                    '最新评估',
                    '官网证据',
                    '联系方式',
                    '沟通与跟进',
                    '原始字段',
                  ].map((t) => (
                    <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>
                      {t}
                    </button>
                  ))}
                </div>
                {tab === '客户画像' && (
                  <CustomerProfile
                    lead={viewed}
                    typeLabel={typeNames[viewed.type] || viewed.type}
                    onAssessment={() => setTab('最新评估')}
                    onSupplement={setSupplement}
                  />
                )}
                {tab === '海关记录' && <CustomsEvidence buyers={viewed.customsEvidence || []} />}
                {tab === '最新评估' && (
                  <AssessmentPanel
                    key={viewed.id}
                    assessment={viewed.assessment}
                    ratingReason={viewed.ratingReason}
                    researchAt={viewed.updatedAt}
                    onSupplement={setSupplement}
                  />
                )}
                {tab === '官网证据' && (
                  <WebsiteEvidencePanel
                    facts={viewed.facts}
                    identityEvidence={viewed.companyIdentity?.evidence}
                  />
                )}
                {tab === '联系方式' && (
                  <ContactPanel
                    key={viewed.id}
                    lead={viewed}
                    onSaved={(saved) => {
                      setRemote(
                        (data) =>
                          data && {
                            ...data,
                            leads: data.leads.map((lead) =>
                              lead.id === viewed.id ? { ...lead, ...saved } : lead,
                            ),
                          },
                      );
                      notify('联系方式已保存');
                    }}
                  />
                )}
                {tab === '沟通与跟进' && (
                  <CustomerBusinessSummary key={viewed.id} customerId={viewed.id} />
                )}
                {tab === '原始字段' &&
                  Object.entries(viewed.fields).map(([k, v]) => (
                    <details className="raw-field" key={k}>
                      <summary>{k}</summary>
                      <pre>
                        {v && /时间$/.test(k) && /^\d{13}$/.test(v)
                          ? formatBeijingTime(Number(v))
                          : formatBeijingText(v || '未提供')}
                      </pre>
                    </details>
                  ))}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
