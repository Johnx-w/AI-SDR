import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { useWorkspace } from '../app/WorkspaceProvider';
import { Badge, Empty, Modal } from '../components/ui';
import { CompanyLogo } from '../components/CompanyLogo';
import { ContactPanel } from '../components/ContactPanel';
import { AssessmentPanel } from '../components/AssessmentPanel';
import type { AssessmentSummary } from '../components/AssessmentPanel';
import { exportCsv } from '../services/workspace';

interface Prospect {
  id: string;
  name: string;
  domain: string;
  market: string;
  type: string;
  product: string;
  match: string;
  score: number | null;
  grade: string;
  ratingReason?: string;
  assessment?: AssessmentSummary | null;
  status: string;
  region: string;
  city: string;
  address?: string;
  serviceAreas?: string;
  mainProductPreference?: string;
  advertisingCodes?: string;
  demandProducts?: string;
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
  updatedAt: number | null;
  fields: Record<string, string>;
}
const typeNames: Record<string, string> = {
  installer: '安装服务商',
  distributor: '批发／经销商',
  retailer: '零售商',
  contractor: '工程承包商',
  manufacturer: '制造商',
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
  const leads = remote?.leads || [];
  const filtered = leads.filter(
    (l) =>
      (!query ||
        `${l.name} ${l.domain} ${l.contact} ${l.email} ${l.source}`
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
  const open = (id: string) => {
    setParams({ dataset: 'real', lead: id });
    setTab('客户画像');
  };
  const close = () => setParams({ dataset: 'real' });
  const download = () => {
    exportCsv(
      filtered.map((l) => ({
        客户: l.name,
        市场: marketLabel(l.market),
        类型: typeNames[l.type] || l.type,
        产品: l.product,
        评分: l.score ?? '未评分',
        用户评级: l.grade,
        评级依据: l.ratingReason || '',
        开发状态: l.status,
        广告代码: l.advertisingCodes || '',
        需求产品: l.demandProducts || '',
        客户行业画像: l.industryProfile || '',
        邮箱: l.email,
        电话: l.phone,
        来源: l.website,
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
            name: '未评级',
            value: leads.filter((l) => l.grade === '未评级').length,
          },
          { name: '可用邮箱记录', value: leads.filter((l) => l.email).length },
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
                  <th>客户／来源</th>
                  <th>市场与客户类型</th>
                  <th>用户评级</th>
                  <th>证据状态</th>
                  <th>联系状态</th>
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
                      if (e.key === 'Enter') open(l.id);
                    }}
                  >
                    <td>
                      <div className="company-cell">
                        <CompanyLogo id={l.id} name={l.name} />
                        <div>
                          <strong>{l.name}</strong>
                          <span className="subtext">{l.domain || '域名待核实'}</span>
                          <span className="subtext">企业 · B端</span>
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
                          {l.score === null ? '—' : l.grade}
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
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={l.grade === 'A' ? 'green' : 'neutral'}>{l.grade}</Badge>
                      <span className="subtext">{`${l.facts.length} 条官网事实`}</span>
                    </td>
                    <td>
                      <Badge>{l.status}</Badge>
                      <span className="subtext">{l.email ? '已发现邮箱' : '待补充联系人'}</span>
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
        <Modal title={viewed.name} wide onClose={close}>
          <div className="modal-body prospect-detail">
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
              <Badge tone="green">飞书真实客户</Badge>
            </div>
            <div className="detail-tabs">
              {['客户画像', '评分与历史', '官网证据', '联系方式', '沟通与跟进', '原始字段'].map(
                (t) => (
                  <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>
                    {t}
                  </button>
                ),
              )}
            </div>
            {tab === '客户画像' && (
              <>
                <div className="profile-kv">
                  {[
                    ['用户评级', viewed.grade],
                    ['评级依据', viewed.ratingReason || '尚无评级依据'],
                    ['客户类型', typeNames[viewed.type] || viewed.type],
                    ['相关产品', viewed.product],
                    ['主营产品偏好', viewed.mainProductPreference || '尚未分析'],
                    ['需求产品', viewed.demandProducts || '未发现公开采购需求'],
                    ['客户行业画像', viewed.industryProfile || '尚未分析'],
                    ['广告代码', viewed.advertisingCodes || '未检出公开广告代码'],
                    ['服务客群', viewed.audience || '待核实'],
                    [
                      '企业实际地址',
                      viewed.address ||
                        [viewed.city, viewed.region, viewed.market].filter(Boolean).join(', '),
                    ],
                    ['服务地区', viewed.serviceAreas || '未确认'],
                    [
                      '评分',
                      viewed.score === null
                        ? '未评分'
                        : '已支持' + viewed.score + '/100 · ' + viewed.grade,
                    ],
                    [
                      '最近研究',
                      viewed.updatedAt
                        ? new Date(viewed.updatedAt).toLocaleString('zh-CN')
                        : '尚无研究时间',
                    ],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <span>{k}</span>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </div>
                <div className="profile-reason">
                  <Sparkles size={18} />
                  <div>
                    <h3>主营产品分析</h3>
                    <p>{viewed.evidence}</p>
                  </div>
                </div>
              </>
            )}
            {tab === '评分与历史' && (
              <AssessmentPanel
                key={viewed.id}
                recordId={viewed.id}
                country={viewed.market}
                product={viewed.product}
                assessment={viewed.assessment}
                onChanged={() => load()}
              />
            )}
            {tab === '官网证据' && (
              <>
                <div className="info-callout">
                  <ShieldCheck size={18} />
                  <p>
                    以下为已有官网研究事实。自动评估保留逐条引文和来源；旧记录缺少逐条来源时，链接指向最近研究页，需结合原文核对。
                  </p>
                </div>
                {viewed.facts.map((f, i) => (
                  <article className="evidence-fact" key={i}>
                    <Badge>{f.field}</Badge>
                    <strong>{f.value}</strong>
                    <blockquote>{f.quote}</blockquote>
                    {safeUrl(f.source_url || viewed.website) && (
                      <a
                        href={safeUrl(f.source_url || viewed.website)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        证据来源 <ArrowUpRight size={14} />
                      </a>
                    )}
                  </article>
                ))}
                {!viewed.facts.length && (
                  <Empty title="尚无官网证据" detail="请通过原有获客流程补充研究资料。" />
                )}
              </>
            )}
            {tab === '联系方式' && <ContactPanel key={viewed.id} lead={viewed} />}
            {tab === '沟通与跟进' && (
              <Empty
                title="尚未接入真实沟通记录"
                detail="当前只读客户主表；沟通与跟进功能尚待接入。"
              />
            )}
            {tab === '原始字段' &&
              Object.entries(viewed.fields).map(([k, v]) => (
                <details className="raw-field" key={k}>
                  <summary>{k}</summary>
                  <pre>{v || '未提供'}</pre>
                </details>
              ))}
          </div>
        </Modal>
      )}
    </>
  );
}
