import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Filter,
  Globe2,
  Mail,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useWorkspace } from '../app/WorkspaceProvider';
import { PageHeading } from '../components/PageHeading';
import { Avatar, Badge, Empty, Modal } from '../components/ui';
import type { Grade, Lead, LeadStatus, Market } from '../domain/types';
import { exportCsv } from '../services/workspace';

export function Leads() {
  const { data, update, notify } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || '');
  const [market, setMarket] = useState('全部市场');
  const [grade, setGrade] = useState('全部等级');
  const [status, setStatus] = useState('全部状态');
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [page, setPage] = useState(1);
  if (!data) return null;
  const effectiveQuery = params.get('q') || query;
  const filtered = data.leads.filter(
    (lead) =>
      (market === '全部市场' || lead.market === market) &&
      (grade === '全部等级' || lead.grade === grade) &&
      (status === '全部状态' || lead.status === status) &&
      `${lead.name} ${lead.city} ${lead.contact} ${lead.product}`
        .toLowerCase()
        .includes(effectiveQuery.toLowerCase()),
  );
  const viewed = data.leads.find((lead) => lead.id === params.get('lead'));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 6));
  const currentPage = Math.min(page, pageCount);
  const rows = filtered.slice((currentPage - 1) * 6, currentPage * 6);
  const showLead = (id: string) => setParams({ lead: id });
  function download() {
    const rows = selected.length ? filtered.filter((lead) => selected.includes(lead.id)) : filtered;
    exportCsv(
      rows.map((lead) => ({
        公司: lead.name,
        市场: lead.market,
        城市: lead.city,
        产品: lead.product,
        等级: lead.grade,
        评分: lead.score,
        邮箱: lead.email,
        状态: lead.status,
      })),
      'ShadeFlow-客户线索.csv',
    );
    notify(`已导出 ${rows.length} 条客户线索`);
  }
  return (
    <>
      <PageHeading
        eyebrow="PROSPECTS"
        title="找到对的客户，开启新的生意。"
        description="汇集线索、研究画像，让每一次开发都有据可依。"
      >
        <button className="btn secondary" onClick={download}>
          <ArrowDownToLine size={15} />
          导出线索
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={16} />
          添加客户
        </button>
      </PageHeading>
      <div className="mini-metrics">
        <div>
          <span>全部线索</span>
          <strong>{data.leads.length}</strong>
        </div>
        <div>
          <span>A 级高适配</span>
          <strong>{data.leads.filter((lead) => lead.grade === 'A').length}</strong>
        </div>
        <div>
          <span>待开发</span>
          <strong>{data.leads.filter((lead) => lead.status === '待开发').length}</strong>
        </div>
        <div>
          <span>已经回复</span>
          <strong>{data.leads.filter((lead) => lead.status === '已回复').length}</strong>
        </div>
      </div>
      <section className="panel">
        <div className="lead-tabs">
          <button
            className={status === '全部状态' ? 'selected' : ''}
            onClick={() => {
              setStatus('全部状态');
              setPage(1);
            }}
          >
            全部客户<Badge>{data.leads.length}</Badge>
          </button>
          <button
            className={status === '待开发' ? 'selected' : ''}
            onClick={() => {
              setStatus('待开发');
              setPage(1);
            }}
          >
            待开发
          </button>
          <button
            className={status === '跟进中' ? 'selected' : ''}
            onClick={() => {
              setStatus('跟进中');
              setPage(1);
            }}
          >
            跟进中
          </button>
          <button
            className={status === '已回复' ? 'selected' : ''}
            onClick={() => {
              setStatus('已回复');
              setPage(1);
            }}
          >
            已回复
          </button>
        </div>
        <div className="filter-toolbar">
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="筛选客户"
              value={effectiveQuery}
              placeholder="搜索公司、联系人、城市…"
              onChange={(event) => {
                setQuery(event.target.value);
                setParams({});
                setPage(1);
              }}
            />
          </div>
          <select
            aria-label="目标市场"
            value={market}
            onChange={(event) => {
              setMarket(event.target.value);
              setPage(1);
            }}
          >
            {['全部市场', '美国', '澳大利亚'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            aria-label="适配等级"
            value={grade}
            onChange={(event) => {
              setGrade(event.target.value);
              setPage(1);
            }}
          >
            <option>全部等级</option>
            {['A', 'B', 'C'].map((value) => (
              <option key={value} value={value}>
                {value} 级
              </option>
            ))}
          </select>
          <button
            className="btn subtle"
            onClick={() => {
              setMarket('全部市场');
              setGrade('全部等级');
              setStatus('全部状态');
              setQuery('');
              setParams({});
              setPage(1);
              setSelected([]);
            }}
          >
            <Filter size={14} />
            重置筛选
          </button>
        </div>
        {selected.length > 0 && (
          <div className="selection-bar">
            <Check size={15} />
            已选择 {selected.length} 位客户
            <button
              onClick={() => {
                update((current) => ({
                  ...current,
                  leads: current.leads.map((lead) =>
                    selected.includes(lead.id) ? { ...lead, status: '跟进中' } : lead,
                  ),
                }));
                setSelected([]);
                notify('所选客户已标记为跟进中');
              }}
            >
              标记为跟进中
              <ArrowRight size={13} />
            </button>
            <button onClick={download}>导出所选</button>
          </div>
        )}
        <div className="table-scroll">
          <table className="lead-table">
            <thead>
              <tr>
                <th>
                  <input
                    aria-label="选择当前页客户"
                    type="checkbox"
                    checked={rows.length > 0 && rows.every((lead) => selected.includes(lead.id))}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...new Set([...selected, ...rows.map((lead) => lead.id)])]
                          : selected.filter((id) => !rows.some((lead) => lead.id === id)),
                      )
                    }
                  />
                </th>
                <th>公司 / 客户</th>
                <th>市场 / 城市</th>
                <th>适配等级</th>
                <th>开发状态</th>
                <th>来源</th>
                <th>最近动态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${lead.name}`}
                      checked={selected.includes(lead.id)}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, lead.id]
                            : selected.filter((id) => id !== lead.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <button className="company-cell" onClick={() => showLead(lead.id)}>
                      <Avatar lead={lead} />
                      <span>
                        <strong>{lead.name}</strong>
                        <small>
                          {lead.type} · {lead.product}
                        </small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="market-cell">
                      {lead.market === '美国' ? '🇺🇸' : '🇦🇺'} {lead.market}
                    </span>
                    <small className="cell-secondary">
                      {lead.city}, {lead.region}
                    </small>
                  </td>
                  <td>
                    <Badge
                      tone={lead.grade === 'A' ? 'green' : lead.grade === 'B' ? 'amber' : 'neutral'}
                    >
                      {lead.grade} 级 · {lead.score}
                    </Badge>
                  </td>
                  <td>
                    <span
                      className={`status-label ${lead.status === '已回复' ? 'green-text' : ''}`}
                    >
                      <i />
                      {lead.status}
                    </span>
                  </td>
                  <td>
                    <span className="muted">{lead.source}</span>
                  </td>
                  <td className="muted">{lead.lastActivity}</td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`打开 ${lead.name} 详情`}
                      onClick={() => showLead(lead.id)}
                    >
                      <ArrowUpRight size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <Empty title="没有找到匹配客户" detail="试着调整搜索词，或清除市场和等级筛选。" />
        )}
        <div className="table-bottom">
          <span>共 {filtered.length} 条线索 · 演示数据</span>
          <div className="pagination">
            <button
              aria-label="上一页"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft size={14} />
            </button>
            <span>
              {currentPage} / {pageCount}
            </span>
            <button
              aria-label="下一页"
              disabled={currentPage === pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </section>
      <div className="info-callout">
        <ShieldCheck size={18} />
        <p>适配评分基于示例业务画像。真实采购量、预算与决策人信息，需要在沟通中逐项确认。</p>
      </div>
      {viewed && (
        <div className="drawer-backdrop" onClick={() => setParams({})}>
          <aside
            className="lead-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="客户详情"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="drawer-heading">
              <span className="eyebrow">CUSTOMER PROFILE</span>
              <button
                className="icon-button"
                aria-label="关闭客户详情"
                onClick={() => setParams({})}
              >
                <X size={20} />
              </button>
            </div>
            <Avatar lead={viewed} />
            <h2>{viewed.name}</h2>
            <p className="muted">
              {viewed.city}, {viewed.region} · {viewed.market}
            </p>
            <div className="drawer-badges">
              <Badge tone="green">
                {viewed.grade} 级 · {viewed.score} 分
              </Badge>
              <Badge>{viewed.type}</Badge>
              <Badge>{viewed.product}</Badge>
            </div>
            <div className="profile-section">
              <h3>
                <Sparkles size={16} />
                客户研究
              </h3>
              <p>{viewed.evidence}</p>
              <div className="evidence-note">演示资料 · 非真实官网抓取</div>
            </div>
            <div className="profile-section">
              <h3>联系信息</h3>
              <dl>
                <dt>联系人</dt>
                <dd>{viewed.contact}</dd>
                <dt>
                  <Mail size={13} /> 邮箱
                </dt>
                <dd>{viewed.email}</dd>
                <dt>
                  <Globe2 size={13} /> 网站
                </dt>
                <dd>{viewed.website}</dd>
              </dl>
            </div>
            <div className="profile-section">
              <h3>意向与待确认事项</h3>
              <p>{viewed.intent}</p>
            </div>
            <div className="profile-section">
              <h3>开发状态</h3>
              <select
                aria-label="修改客户状态"
                value={viewed.status}
                onChange={(event) => {
                  const status = event.target.value as LeadStatus;
                  update((current) => ({
                    ...current,
                    leads: current.leads.map((lead) =>
                      lead.id === viewed.id ? { ...lead, status } : lead,
                    ),
                  }));
                  notify('客户状态已更新');
                }}
              >
                {['待开发', '跟进中', '已回复', '暂缓开发'].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </div>
            <button
              className="btn primary full-width"
              onClick={() => {
                update((current) => ({
                  ...current,
                  tasks: [
                    ...current.tasks,
                    {
                      id: crypto.randomUUID(),
                      title: `跟进 ${viewed.name}`,
                      detail: '核实采购需求与产品适配度',
                      time: '待安排',
                      kind: '跟进',
                      done: false,
                    },
                  ],
                }));
                notify('已添加到首页待办');
              }}
            >
              创建跟进待办
              <Plus size={15} />
            </button>
          </aside>
        </div>
      )}
      {adding && (
        <Modal title="添加演示客户" onClose={() => setAdding(false)}>
          <form
            className="modal-body form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const name = String(form.get('name')).trim();
              const email = String(form.get('email')).trim();
              if (!name) return;
              const lead: Lead = {
                id: crypto.randomUUID(),
                name,
                initials: name.slice(0, 2).toUpperCase(),
                color: 'sage',
                market: form.get('market') as Market,
                region: '待确认',
                city: String(form.get('city')),
                type: '待确认',
                product: String(form.get('product')),
                grade: form.get('grade') as Grade,
                score: 0,
                status: '待开发',
                source: '手动录入',
                contact: String(form.get('contact')),
                email,
                website: '待补充',
                lastActivity: '刚刚',
                evidence: '手动录入的演示客户，尚未完成研究。',
                intent: '尚未确认采购意向。',
              };
              update((current) => ({ ...current, leads: [lead, ...current.leads] }));
              setAdding(false);
              notify('演示客户已添加');
            }}
          >
            <label className="span-2">
              公司名称
              <input
                name="name"
                required
                maxLength={100}
                placeholder="例如 Example Shading Studio"
              />
            </label>
            <label>
              目标市场
              <select name="market">
                <option>澳大利亚</option>
                <option>美国</option>
              </select>
            </label>
            <label>
              城市
              <input name="city" required placeholder="Sydney" />
            </label>
            <label>
              联系人
              <input name="contact" placeholder="待确认" />
            </label>
            <label>
              邮箱
              <input name="email" type="email" placeholder="name@company.example" />
            </label>
            <label>
              产品
              <input name="product" defaultValue="防风卷帘" />
            </label>
            <label>
              初始等级
              <select name="grade">
                <option>C</option>
                <option>B</option>
                <option>A</option>
              </select>
            </label>
            <p className="muted span-2">初始评分为 0，手动等级不代表已完成真实评估。</p>
            <button className="btn primary span-2" type="submit">
              保存客户
              <Check size={16} />
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
