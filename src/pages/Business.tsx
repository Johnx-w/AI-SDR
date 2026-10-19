import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  FileText,
  Mail,
  MessageCircle,
  Pause,
  Play,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Workflow,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { useWorkspace } from '../app/WorkspaceProvider';
import { Avatar, Badge, Empty, ExternalLink, Modal, SectionTitle } from '../components/ui';
import type { Campaign, Market } from '../domain/types';
import { exportCsv } from '../services/workspace';
import { WORKFLOW_URL } from '../services/n8n';
import { TrendChart } from './Overview';

export function Campaigns() {
  const { data, update, notify } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('全部计划');
  const [viewing, setViewing] = useState<Campaign | null>(null);
  if (!data) return null;
  const campaigns = data.campaigns.filter(
    (campaign) => filter === '全部计划' || campaign.status === filter,
  );
  return (
    <>
      <PageHeading
        eyebrow="MULTICHANNEL OUTREACH"
        title="恰当的时机，合适的沟通。"
        description="规划邮件与 WhatsApp 触达节奏，持续积累客户关系。"
      >
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={16} />
          创建触达计划
        </button>
      </PageHeading>
      <div className="info-callout">
        <ShieldCheck size={18} />
        <p>当前计划为演示，操作仅保存在本地；发送前审核、渠道授权与真实调度在后续服务端接入。</p>
      </div>
      <div className="filter-chips">
        {['全部计划', '运行中', '已暂停', '草稿'].map((value) => (
          <button
            className={filter === value ? 'selected' : ''}
            key={value}
            onClick={() => setFilter(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="campaign-grid">
        {campaigns.map((campaign) => (
          <section className="panel campaign-card" key={campaign.id}>
            <div className="campaign-card-top">
              <span className="channel-icon">
                {campaign.channel === '邮件' ? <Mail size={22} /> : <MessageCircle size={22} />}
              </span>
              <Badge
                tone={
                  campaign.status === '运行中'
                    ? 'green'
                    : campaign.status === '草稿'
                      ? 'neutral'
                      : 'amber'
                }
              >
                {campaign.status} · 演示
              </Badge>
            </div>
            <h3>{campaign.name}</h3>
            <p>
              {campaign.market === '美国' ? '🇺🇸' : '🇦🇺'} {campaign.market}
              <span>·</span>
              {campaign.channel}
            </p>
            <div className="campaign-stats">
              <div>
                <strong>{campaign.total}</strong>
                <span>目标客户</span>
              </div>
              <div>
                <strong>{campaign.sent}</strong>
                <span>模拟触达</span>
              </div>
              <div>
                <strong>{campaign.replies}</strong>
                <span>模拟回复</span>
              </div>
            </div>
            <div className="progress-track">
              <span
                style={{ width: `${campaign.total ? (campaign.sent / campaign.total) * 100 : 0}%` }}
              />
            </div>
            <div className="campaign-progress">
              <span>演示计划进度</span>
              <b>{campaign.total ? Math.round((campaign.sent / campaign.total) * 100) : 0}%</b>
            </div>
            <div className="sequence-mini">
              {campaign.steps.map((step, index) => (
                <div key={step}>
                  <span>{index + 1}</span>
                  <p>
                    {step.split(' · ')[0]}
                    <small>{step.split(' · ')[1]}</small>
                  </p>
                  {index < campaign.steps.length - 1 && <ChevronRight size={14} />}
                </div>
              ))}
            </div>
            <div className="campaign-actions">
              <button
                className="btn subtle"
                onClick={() => {
                  update((current) => ({
                    ...current,
                    campaigns: current.campaigns.map((item) =>
                      item.id === campaign.id
                        ? { ...item, status: item.status === '运行中' ? '已暂停' : '运行中' }
                        : item,
                    ),
                  }));
                  notify(
                    campaign.status === '运行中'
                      ? '演示计划已暂停'
                      : '演示计划已启用，不会实际外发',
                  );
                }}
              >
                {campaign.status === '运行中' ? <Pause size={14} /> : <Play size={14} />}{' '}
                {campaign.status === '运行中' ? '暂停计划' : '启用演示'}
              </button>
              <button className="text-link" onClick={() => setViewing(campaign)}>
                查看详情
                <ArrowRight size={14} />
              </button>
            </div>
          </section>
        ))}
      </div>
      {!campaigns.length && (
        <Empty title="暂无此状态的计划" detail="创建一个新的触达计划，或切换到全部计划。" />
      )}
      <div className="soft-banner">
        <Sparkles size={23} />
        <div>
          <strong>好的开发信，从理解客户开始。</strong>
          <p>先核实企业画像与产品需求，再组织相关且简洁的首封沟通。</p>
        </div>
        <Link to="/leads">
          去研究客户
          <ArrowUpRight size={15} />
        </Link>
      </div>
      {adding && (
        <Modal title="创建演示触达计划" onClose={() => setAdding(false)}>
          <form
            className="modal-body form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const campaign: Campaign = {
                id: crypto.randomUUID(),
                name: String(form.get('name')).trim(),
                market: form.get('market') as Market,
                channel: String(form.get('channel')),
                status: '草稿',
                total: Number(form.get('total')),
                sent: 0,
                replies: 0,
                steps: [
                  'Day 1 · 首次接洽',
                  'Day 3 · 产品资料',
                  'Day 5 · 需求深挖',
                  'Day 7 · 进度确认',
                  'Day 14 · 长线唤醒',
                ],
              };
              update((current) => ({ ...current, campaigns: [campaign, ...current.campaigns] }));
              setAdding(false);
              notify('触达计划已保存为演示草稿');
            }}
          >
            <label className="span-2">
              计划名称
              <input
                name="name"
                required
                maxLength={80}
                placeholder="例如：澳洲安装商 · 首次开发"
              />
            </label>
            <label>
              市场
              <select name="market">
                <option>澳大利亚</option>
                <option>美国</option>
              </select>
            </label>
            <label>
              渠道
              <select name="channel">
                <option>邮件</option>
                <option>WhatsApp</option>
                <option>邮件 + WhatsApp</option>
              </select>
            </label>
            <label className="span-2">
              演示目标人数
              <input type="number" name="total" min="1" max="10000" defaultValue="50" required />
            </label>
            <p className="muted span-2">
              默认跟进节点为第 1 / 3 / 5 / 7 / 14 天，当前演示不执行真实发送。
            </p>
            <button type="submit" className="btn primary span-2">
              <Save size={16} />
              保存为草稿
            </button>
          </form>
        </Modal>
      )}
      {viewing && (
        <Modal title={viewing.name} onClose={() => setViewing(null)}>
          <div className="modal-body">
            <Badge tone="green">演示计划</Badge>
            <p className="muted">
              {viewing.market} · {viewing.channel} · 目标 {viewing.total} 人
            </p>
            <div className="vertical-sequence">
              {viewing.steps.map((step, index) => (
                <div key={step}>
                  <b>{index + 1}</b>
                  <span>
                    <strong>{step}</strong>
                    <p>人工审核后再交由渠道适配器执行；本阶段只演示步骤。</p>
                  </span>
                </div>
              ))}
            </div>
            <div className="info-callout">
              <ShieldCheck size={17} />
              <p>客户回复、拒绝或退订后应停止后续跟进，真实服务端需实现此规则。</p>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function Inbox() {
  const { data, update, notify } = useWorkspace();
  const [active, setActive] = useState('m1');
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  if (!data) return null;
  const message = data.conversations.find((item) => item.id === active);
  const lead = data.leads.find((item) => item.id === message?.leadId);
  const conversations = data.conversations.filter(
    (item) =>
      (!unreadOnly || item.unread) &&
      `${item.subject} ${data.leads.find((lead) => lead.id === item.leadId)?.name}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  function saveDraft(value: string) {
    update((current) => ({
      ...current,
      conversations: current.conversations.map((item) =>
        item.id === active ? { ...item, draft: value } : item,
      ),
    }));
  }
  return (
    <>
      <PageHeading
        eyebrow="UNIFIED INBOX"
        title="每一次回应，都值得认真对待。"
        description="在一个工作台里查看消息，整理需求，准备下一步沟通。"
      >
        <Badge tone="green">
          {data.conversations.filter((item) => item.unread).length} 条未读 · 演示
        </Badge>
      </PageHeading>
      <div className="inbox-layout panel">
        <aside className="conversation-list">
          <div className="conversation-list-head">
            <h3>客户对话</h3>
            <button
              className={`btn subtle ${unreadOnly ? 'green-text' : ''}`}
              onClick={() => setUnreadOnly(!unreadOnly)}
            >
              {unreadOnly ? '显示全部' : '只看未读'}
            </button>
          </div>
          <div className="search-field">
            <Search size={15} />
            <input
              aria-label="搜索对话"
              placeholder="搜索对话…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {conversations.map((item) => {
            const customer = data.leads.find((lead) => lead.id === item.leadId)!;
            return (
              <button
                key={item.id}
                className={`conversation-preview ${active === item.id ? 'selected' : ''}`}
                onClick={() => {
                  setActive(item.id);
                  update((current) => ({
                    ...current,
                    conversations: current.conversations.map((message) =>
                      message.id === item.id ? { ...message, unread: false } : message,
                    ),
                  }));
                }}
              >
                <Avatar lead={customer} small />
                <div>
                  <div>
                    <strong>{customer.name}</strong>
                    <time>{item.time}</time>
                  </div>
                  <p>{item.subject}</p>
                  <small>{item.preview}</small>
                  <span>
                    <Mail size={11} />
                    {item.channel}
                    {item.unread && <i />}
                  </span>
                </div>
              </button>
            );
          })}
          {!conversations.length && (
            <Empty title="没有匹配的对话" detail="调整搜索条件或查看全部消息。" />
          )}
        </aside>
        {message && lead ? (
          <div className="message-pane">
            <div className="message-header">
              <div>
                <h3>{message.subject}</h3>
                <p>
                  {lead.contact}
                  <span>·</span>
                  {lead.email}
                </p>
              </div>
              <Badge>演示来信</Badge>
            </div>
            <div className="message-body">
              <div className="message-author">
                <Avatar lead={lead} small />
                <strong>{lead.contact}</strong>
                <time>{message.time}</time>
              </div>
              <div className="email-content">{message.body}</div>
            </div>
            <div className="reply-box">
              <div>
                <span>
                  <FileText size={15} />
                  回复草稿
                </span>
                <button
                  className="text-link"
                  onClick={() => {
                    saveDraft(
                      `Hi ${lead.contact.split(' ')[0]},\n\nThank you for your interest in our shading solutions. I would be happy to share the relevant product information. Could you let us know the product dimensions and motor specifications required for your project?\n\nBest regards,\nJohnson`,
                    );
                    notify('已填入英文示例模板，请核对产品信息');
                  }}
                >
                  <Sparkles size={14} />
                  使用示例模板
                </button>
              </div>
              <textarea
                aria-label="回复草稿"
                placeholder="在这里准备回复，草稿会自动保存在当前浏览器…"
                value={message.draft}
                onChange={(event) => saveDraft(event.target.value)}
              />
              <div className="reply-footer">
                <span>
                  <ShieldCheck size={13} />
                  当前仅保存草稿，不发送消息
                </span>
                <button
                  className="btn primary"
                  onClick={() =>
                    notify(message.draft.trim() ? '草稿已保存在当前浏览器' : '请先填写回复内容')
                  }
                >
                  <Save size={14} />
                  保存草稿
                </button>
              </div>
            </div>
          </div>
        ) : (
          <Empty title="请选择一条对话" detail="查看来信并准备回复草稿。" />
        )}
        <aside className="inbox-profile">
          {lead && (
            <>
              <Avatar lead={lead} />
              <h3>{lead.name}</h3>
              <p>
                {lead.market} · {lead.city}
              </p>
              <Badge tone="green">
                {lead.grade} 级 · {lead.score} 分
              </Badge>
              <hr />
              <span className="tiny-label">客户画像</span>
              <p>
                {lead.type} / {lead.product}
              </p>
              <span className="tiny-label">当前意向</span>
              <p>{lead.intent}</p>
              <Link className="btn secondary full-width" to={`/leads?lead=${lead.id}`}>
                查看完整画像
                <ArrowUpRight size={14} />
              </Link>
            </>
          )}
        </aside>
      </div>
    </>
  );
}

export function Reports() {
  const { data } = useWorkspace();
  const [period, setPeriod] = useState('14');
  if (!data) return null;
  const sources = ['Google 搜索', '行业目录', '官网研究', '相似客户', '手动录入'].map((source) => ({
    source,
    count: data.leads.filter((lead) => lead.source === source).length,
  }));
  const marketRows = ['美国', '澳大利亚'].map((market) => ({
    market,
    count: data.leads.filter((lead) => lead.market === market).length,
    a: data.leads.filter((lead) => lead.market === market && lead.grade === 'A').length,
    replies: data.leads.filter((lead) => lead.market === market && lead.status === '已回复').length,
  }));
  return (
    <>
      <PageHeading
        eyebrow="GROWTH INSIGHTS"
        title="看见数据背后的下一步。"
        description="比较市场与线索来源，找到值得继续投入的方向。"
      >
        <button
          className="btn secondary"
          onClick={() =>
            exportCsv(
              marketRows.map((row) => ({
                市场: row.market,
                客户数: row.count,
                A级数: row.a,
                模拟回复: row.replies,
              })),
              'ShadeFlow-市场分析.csv',
            )
          }
        >
          <ArrowDownToLine size={15} />
          导出分析
        </button>
      </PageHeading>
      <div className="insight-banner">
        <TrendingUp size={26} />
        <div>
          <span className="eyebrow">WORKSPACE INSIGHT</span>
          <h2>用证据理解客户，用反馈优化开发。</h2>
          <p>
            当前 {data.leads.length} 条演示线索，覆盖 2
            个市场。真实获客效果需要积累实际运行与跟进数据。
          </p>
        </div>
      </div>
      <div className="reports-grid">
        <section className="panel">
          <SectionTitle
            title="线索发现趋势"
            subtitle="独立的历史聚合演示样本"
            action={
              <select
                aria-label="分析周期"
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
              >
                <option value="7">最近 7 天</option>
                <option value="14">最近 14 天</option>
                <option value="30">最近 30 天</option>
              </select>
            }
          />
          <TrendChart period={period} />
        </section>
        <section className="panel sources-panel">
          <SectionTitle title="线索来源分布" subtitle="根据当前演示客户计算" />
          {sources.map((row) => (
            <div className="source-row" key={row.source}>
              <div>
                <span>{row.source}</span>
                <b>{row.count}</b>
              </div>
              <div className="progress-track">
                <span style={{ width: `${(row.count / data.leads.length) * 100}%` }} />
              </div>
            </div>
          ))}
        </section>
      </div>
      <section className="panel">
        <SectionTitle title="市场表现" subtitle="客户适配度与意向分开统计" />
        <table className="lead-table">
          <thead>
            <tr>
              <th>目标市场</th>
              <th>客户线索</th>
              <th>A 级客户</th>
              <th>A 级占比</th>
              <th>模拟回复</th>
              <th>采购意向</th>
            </tr>
          </thead>
          <tbody>
            {marketRows.map((row) => (
              <tr key={row.market}>
                <td>
                  <span className="market-cell">
                    {row.market === '美国' ? '🇺🇸' : '🇦🇺'} {row.market}
                  </span>
                </td>
                <td>{row.count}</td>
                <td>{row.a}</td>
                <td>
                  <Badge tone="green">
                    {row.count ? Math.round((row.a / row.count) * 100) : 0}%
                  </Badge>
                </td>
                <td>{row.replies}</td>
                <td className="muted">需沟通确认</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="info-callout">
        <ShieldCheck size={18} />
        <p>
          当前没有真实成交样本，不计算成交率或投资回报。上述数量与占比来自本地演示客户，趋势图另为历史样本。
        </p>
      </div>
    </>
  );
}

export function Settings() {
  const { data, update, reset, notify } = useWorkspace();
  const [tab, setTab] = useState('工作区偏好');
  const [resetting, setResetting] = useState(false);
  if (!data) return null;
  return (
    <>
      <PageHeading
        eyebrow="WORKSPACE SETTINGS"
        title="策略设置"
        description="管理目标市场、触达节奏、发送审核与服务集成。"
      />
      <div className="settings-layout">
        <div className="settings-nav">
          {['工作区偏好', '服务集成', '数据管理'].map((name) => (
            <button
              key={name}
              className={tab === name ? 'selected' : ''}
              onClick={() => setTab(name)}
            >
              {name}
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
        <section className="panel settings-panel">
          {tab === '工作区偏好' ? (
            <>
              <SectionTitle
                title="工作区偏好"
                subtitle="偏好保存在当前浏览器，真实调度规则需在服务端实现。"
              />
              <form
                className="settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  update((current) => ({
                    ...current,
                    preferences: {
                      timezone: String(form.get('timezone')),
                      market: form.get('market') as Market,
                      reviewBeforeSend: form.get('review') === 'on',
                      dailyLimit: Number(form.get('limit')),
                      cooldownHours: Number(form.get('cooldown')),
                    },
                  }));
                  notify('工作区偏好已保存');
                }}
              >
                <label>
                  工作空间名称
                  <input disabled value="窗饰出海事业部" />
                </label>
                <label>
                  默认市场
                  <select name="market" defaultValue={data.preferences.market}>
                    <option>澳大利亚</option>
                    <option>美国</option>
                    <option>英国</option>
                    <option>阿联酋</option>
                  </select>
                </label>
                <label>
                  工作区时区
                  <select name="timezone" defaultValue={data.preferences.timezone}>
                    <option value="Asia/Shanghai">Asia/Shanghai · 北京时间</option>
                    <option value="Australia/Sydney">Australia/Sydney · 悉尼</option>
                    <option value="America/New_York">America/New_York · 纽约</option>
                  </select>
                </label>
                <label>
                  每日触达限额（演示偏好）
                  <input
                    type="number"
                    name="limit"
                    required
                    min="1"
                    max="500"
                    defaultValue={data.preferences.dailyLimit}
                  />
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    name="review"
                    defaultChecked={data.preferences.reviewBeforeSend}
                  />
                  发送前人工审核（偏好占位，尚未接入实际渠道）
                </label>
                <label>
                  跨渠道冷却间隔（小时 · 演示偏好）
                  <input
                    type="number"
                    name="cooldown"
                    required
                    min="24"
                    max="720"
                    defaultValue={data.preferences.cooldownHours || 72}
                  />
                </label>
                <div className="info-callout">
                  <ShieldCheck size={17} />
                  <p>
                    跟进节点：第 1／3／5／7 天，第 14
                    天长线唤醒。真人回复暂停原序列；无效联系人进入重搜；拒绝联系后停止全部渠道。
                  </p>
                </div>
                <button className="btn primary" type="submit">
                  <Save size={15} />
                  保存设置
                </button>
              </form>
            </>
          ) : tab === '服务集成' ? (
            <>
              <SectionTitle title="服务集成" subtitle="开发工具授权与业务系统运行凭证相互独立。" />
              {[
                {
                  name: 'n8n 工作流',
                  icon: Workflow,
                  description: '真实工作流已指定，运行需配置受认证的 Webhook。',
                  status: '查看配置',
                  href: '/automation',
                },
                {
                  name: 'Tavily / Dify / 飞书',
                  icon: Sparkles,
                  description: '由你的 n8n 工作流编排，本应用不保存这些平台的密钥。',
                  status: '由 n8n 管理',
                  href: null,
                },
                {
                  name: '邮件 / WhatsApp',
                  icon: Mail,
                  description: '当前为 mock 适配层，尚未接入真实收发渠道。',
                  status: '演示模式',
                  href: null,
                },
              ].map((item) => (
                <div className="integration-row" key={item.name}>
                  <span className="integration-icon">
                    <item.icon size={23} />
                  </span>
                  <div>
                    <h3>{item.name}</h3>
                    <p>{item.description}</p>
                  </div>
                  {item.href ? (
                    <Link className="btn secondary" to={item.href}>
                      {item.status}
                      <ArrowRight size={14} />
                    </Link>
                  ) : (
                    <Badge>{item.status}</Badge>
                  )}
                </div>
              ))}
              <ExternalLink href={WORKFLOW_URL}>打开 n8n 工作流</ExternalLink>
            </>
          ) : (
            <>
              <SectionTitle
                title="演示数据管理"
                subtitle="当前浏览器独立保存，不上传到外部服务。"
              />
              <div className="data-summary">
                <div>
                  <strong>{data.leads.length}</strong>
                  <span>客户线索</span>
                </div>
                <div>
                  <strong>{data.campaigns.length}</strong>
                  <span>触达计划</span>
                </div>
                <div>
                  <strong>{data.conversations.length}</strong>
                  <span>客户对话</span>
                </div>
              </div>
              <div className="settings-data-action">
                <h3>导出客户清单</h3>
                <p>将当前浏览器中的客户导出为 CSV。</p>
                <button
                  className="btn secondary"
                  onClick={() =>
                    exportCsv(
                      data.leads.map((lead) => ({
                        名称: lead.name,
                        市场: lead.market,
                        联系人: lead.contact,
                        邮箱: lead.email,
                        状态: lead.status,
                      })),
                      'ShadeFlow-客户备份.csv',
                    )
                  }
                >
                  <ArrowDownToLine size={15} />
                  导出 CSV
                </button>
              </div>
              <div className="settings-data-action">
                <h3>恢复初始演示数据</h3>
                <p>会覆盖本浏览器的新增客户、状态修改、草稿与偏好。</p>
                <button className="btn danger" onClick={() => setResetting(true)}>
                  重置演示数据
                </button>
              </div>
            </>
          )}
        </section>
      </div>
      {resetting && (
        <Modal title="恢复初始演示数据？" onClose={() => setResetting(false)}>
          <div className="modal-body">
            <p>本浏览器的演示修改将被初始样本覆盖。此操作不修改 n8n 或飞书。</p>
            <div className="modal-actions">
              <button className="btn secondary" onClick={() => setResetting(false)}>
                保留修改
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  void reset();
                  setResetting(false);
                }}
              >
                恢复初始样本
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
