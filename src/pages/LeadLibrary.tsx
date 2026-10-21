import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Plus,
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
import { exportCsv } from '../services/workspace';
import type { Lead, Market } from '../domain/types';

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
  facts: { field: string; value: string; quote: string }[];
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
function fromMock(l: Lead): Prospect {
  return {
    ...l,
    domain: l.website.replace(/^https?:\/\//, ''),
    match: '',
    phone: '',
    facts: [{ field: '客户研究', value: l.type, quote: l.evidence }],
    contactEvidence: [],
    updatedAt: null,
    fields: {
      公司: l.name,
      市场: l.market,
      产品: l.product,
      联系人: l.contact,
      邮箱: l.email,
      适配说明: l.evidence,
    },
  };
}
export function LeadLibrary() {
  const { data, update, notify } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const real = true;
  const [remote, setRemote] = useState<{ leads: Prospect[]; syncedAt: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState(params.get('q') || '');
  const [market, setMarket] = useState('');
  const [grade, setGrade] = useState('');
  const [product, setProduct] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('客户画像');
  const [adding, setAdding] = useState(false);
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
    if (!real) return;
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [real]);
  useEffect(() => {
    setQuery(params.get('q') || '');
  }, [params.get('q')]);
  if (!data) return null;
  const leads = real ? remote?.leads || [] : data.leads.map(fromMock);
  const filtered = leads.filter(
    (l) =>
      (!query ||
        `${l.name} ${l.domain} ${l.contact} ${l.email} ${l.source}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (!market || marketLabel(l.market) === market) &&
      (!grade || l.grade === grade) &&
      (!product || l.product === product) &&
      (!status || l.status === status) &&
      (!source || l.source === source) &&
      true,
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const current = Math.min(page, pages);
  const rows = filtered.slice((current - 1) * 8, current * 8);
  const viewed = leads.find((l) => l.id === params.get('lead'));
  const open = (id: string) => {
    setParams(real ? { dataset: 'real', lead: id } : { lead: id });
    setTab('客户画像');
  };
  const close = () => setParams(real ? { dataset: 'real' } : {});
  const download = () => {
    exportCsv(
      filtered.map((l) => ({
        客户: l.name,
        市场: marketLabel(l.market),
        类型: typeNames[l.type] || l.type,
        产品: l.product,
        评分: l.score ?? '未评分',
        评级: l.grade,
        客户等级: l.grade,
        广告代码: l.advertisingCodes || '',
        需求产品: l.demandProducts || '',
        客户行业画像: l.industryProfile || '',
        邮箱: l.email,
        电话: l.phone,
        来源: l.website,
      })),
      real ? '飞书真实客户.csv' : '演示客户.csv',
    );
    notify(`已导出 ${filtered.length} 条${real ? '真实' : '演示'}客户`);
  };
  return (
    <>
      <PageHeading eyebrow="CUSTOMER LIBRARY" title="客户库">
        <button className="btn secondary" disabled={!filtered.length} onClick={download}>
          <ArrowDownToLine size={16} />
          导出客户
        </button>
        {real ? (
          <button className="btn primary" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            {loading ? '正在读取' : '刷新飞书客户'}
          </button>
        ) : (
          <button className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={16} />
            手工录入
          </button>
        )}
      </PageHeading>
      {params.has('duplicates') && !real && (
        <div className="info-callout">
          <ShieldCheck size={18} />
          <p>
            去重核对演示：Alder Shade Co. 与别名 Alder Shade
            使用同一示例域名，已汇总为当前唯一客户。可打开客户查看原始信息。
          </p>
        </div>
      )}
      <div className="library-stats">
        {[
          { name: '全部客户', value: leads.length },
          {
            name: 'A 级客户',
            value: leads.filter((l) => l.grade === 'A').length,
          },
          {
            name: real ? '未评级' : '跟进中',
            value: leads.filter((l) => (real ? l.grade === '未评级' : l.status === '跟进中'))
              .length,
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
            ...(!real
              ? [
                  {
                    label: '来源',
                    val: source,
                    set: setSource,
                    options: [...new Set(leads.map((l) => l.source))],
                  },
                ]
              : []),
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
              setSource('');
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
                  <th>客户等级</th>
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
                        <CompanyLogo id={l.id} name={l.name} real={real} />
                        <div>
                          <strong>{l.name}</strong>
                          <span className="subtext">{l.domain || '域名待核实'}</span>
                          <span className="subtext">企业 · B端 {real ? '' : '· 演示样本'}</span>
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
                            {real ? l.grade : l.score === null ? '未评分' : l.score}
                            <small>{l.score === null ? '' : ' / 100'}</small>
                          </strong>
                          {l.score !== null ? (
                            <div className="tiny-track">
                              <i style={{ width: l.score + '%' }} />
                            </div>
                          ) : (
                            <span className="subtext">{real ? '人工评级' : '原始数据未提供'}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={l.grade === 'A' ? 'green' : 'neutral'}>
                        {real ? l.grade : '示例证据'}
                      </Badge>
                      <span className="subtext">
                        {real ? `${l.facts.length} 条官网事实` : '演示画像'}
                      </span>
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
          <Empty
            title="暂无匹配客户"
            detail={
              real ? '飞书暂无记录或当前筛选无匹配项。' : '请调整筛选条件，或手工添加演示客户。'
            }
          />
        )}
        <footer className="table-bottom">
          <span>
            共 {filtered.length} 条 · {real ? '飞书真实数据' : '演示数据'}
          </span>
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
              <CompanyLogo key={viewed.id} id={viewed.id} name={viewed.name} real={real} />
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
              <Badge tone={real ? 'green' : 'neutral'}>{real ? '飞书真实客户' : '演示客户'}</Badge>
            </div>
            <div className="detail-tabs">
              {['客户画像', '官网证据', '联系方式', '沟通与跟进', '原始字段'].map((t) => (
                <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>
                  {t}
                </button>
              ))}
            </div>
            {tab === '客户画像' && (
              <>
                <div className="profile-kv">
                  {[
                    ['客户等级', viewed.grade],
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
                      viewed.score === null ? '未评分' : viewed.grade + '级 · ' + viewed.score,
                    ],
                    [
                      '最近研究',
                      viewed.updatedAt
                        ? new Date(viewed.updatedAt).toLocaleString('zh-CN')
                        : '演示资料',
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
                {!real && (
                  <label className="profile-status">
                    开发状态
                    <select
                      aria-label="更新演示客户状态"
                      value={viewed.status}
                      onChange={(e) => {
                        const status = e.target.value as Lead['status'];
                        update((d) => ({
                          ...d,
                          leads: d.leads.map((l) => (l.id === viewed.id ? { ...l, status } : l)),
                        }));
                      }}
                    >
                      {['待开发', '跟进中', '已回复', '暂缓开发'].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
            {tab === '官网证据' && (
              <>
                <div className="info-callout">
                  <ShieldCheck size={18} />
                  <p>
                    {real
                      ? '以下为原始记录累积的官网事实。记录未提供逐条来源，链接仅指向最近研究页，历史引文需逐项核对。'
                      : '以下为虚构的演示证据。'}
                  </p>
                </div>
                {viewed.facts.map((f, i) => (
                  <article className="evidence-fact" key={i}>
                    <Badge>{f.field}</Badge>
                    <strong>{f.value}</strong>
                    <blockquote>{f.quote}</blockquote>
                    {safeUrl(viewed.website) && (
                      <a href={safeUrl(viewed.website)} target="_blank" rel="noreferrer">
                        最近研究页 <ArrowUpRight size={14} />
                      </a>
                    )}
                  </article>
                ))}
                {!viewed.facts.length && (
                  <Empty title="尚无官网证据" detail="请通过原有获客流程补充研究资料。" />
                )}
              </>
            )}
            {tab === '联系方式' && <ContactPanel key={viewed.id} lead={viewed} real={real} />}
            {tab === '沟通与跟进' &&
              (real ? (
                <Empty
                  title="尚未接入真实沟通记录"
                  detail="当前只读客户主表；原有 n8n 获客和飞书写入链路保持可用。"
                />
              ) : (
                <>
                  <h3>最近会话</h3>
                  {data.conversations
                    .filter((c) => c.leadId === viewed.id)
                    .map((c) => (
                      <div className="evidence-fact" key={c.id}>
                        <Badge>{c.channel}</Badge>
                        <strong>{c.subject}</strong>
                        <p>{c.preview}</p>
                        <Badge tone="amber">{c.reviewed ? '演示已审核' : '原自动跟进已暂停'}</Badge>
                      </div>
                    ))}
                  <Link className="btn primary" to={'/inbox?lead=' + viewed.id}>
                    前往沟通中心 <ArrowUpRight size={15} />
                  </Link>
                  <Link className="btn secondary" to="/followups">
                    查看跟进计划
                  </Link>
                </>
              ))}
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
      {adding && (
        <Modal title="手工录入演示客户" onClose={() => setAdding(false)}>
          <form
            className="modal-body form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const name = String(f.get('name')).trim();
              if (!name) return;
              const l: Lead = {
                id: crypto.randomUUID(),
                name,
                initials: name.slice(0, 2).toUpperCase(),
                color: 'sage',
                market: f.get('market') as Market,
                region: '待补充',
                city: '待补充',
                type: String(f.get('type')),
                product: String(f.get('product')),
                grade: 'C',
                score: 0,
                status: '待开发',
                source: '手动录入',
                contact: String(f.get('contact')),
                email: String(f.get('email')),
                website: '',
                lastActivity: '刚刚',
                evidence: '手工录入演示客户，待补充官网研究。',
                intent: '采购需求待确认',
              };
              update((d) => ({ ...d, leads: [l, ...d.leads] }));
              setAdding(false);
              notify('演示客户已保存');
            }}
          >
            <label className="span-2">
              公司名称
              <input name="name" required maxLength={100} />
            </label>
            <label>
              市场
              <select name="market">
                {['英国', '澳大利亚', '美国', '阿联酋'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              客户类型
              <select name="type">
                <option>窗饰经销商</option>
                <option>安装服务商</option>
                <option>工程承包商</option>
              </select>
            </label>
            <label>
              产品
              <input name="product" required />
            </label>
            <label>
              联系人
              <input name="contact" />
            </label>
            <label className="span-2">
              示例邮箱
              <input name="email" type="email" placeholder="name@company.example" />
            </label>
            <p className="muted span-2">仅保存至演示客户库。</p>
            <button className="btn primary span-2">
              <CheckCircle2 size={16} />
              保存演示客户
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
