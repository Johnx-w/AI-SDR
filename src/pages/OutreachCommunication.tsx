import { SectionWorkspace } from '../components/SectionWorkspace';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { InitialPage } from '../app/initialPage';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Eye,
  FileText,
  Globe2,
  Inbox,
  LoaderCircle,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Upload,
  X,
} from 'lucide-react';
import { Bot, ChevronRight, MessagesSquare } from 'lucide-react';
import './FinCenter.css';
import { SalesInbox, type InboxView } from '../components/SalesInbox';
import { FollowUpSequences, CampaignFollowUps } from '../components/FollowUpSequences';
import { MailboxLabels } from '../components/MailboxLabels';
import { MailReplySettings } from '../components/MailReplySettings';
import { MailMessageBody } from '../components/MailMessageBody';
import { MailSignatureFields, defaultSignatureDesign } from '../components/MailSignatureFields';
import { renderMailboxSignature } from '../domain/mail-signature.mjs';
import { MailKnowledgeScope } from '../components/MailKnowledgeScope';
import { siteBrand } from '../domain/mail-site.mjs';
import { deliveryGroup, deliveryGroupLabels } from '../domain/outreach-status.mjs';
import type { MailSignatureDesign } from '../domain/mail-signature.mjs';
import { SearchableLocation } from '../components/SearchableLocation';
import { countryFor, outreachMarkets } from '../domain/country-catalog';
import { Badge, Empty, Modal } from '../components/ui';
import { outreachApi } from '../outreachApi';
import type {
  OutreachCampaign,
  OutreachCampaignDetail,
  OutreachDelivery,
  OutreachMailbox,
  OutreachProduct,
  MailboxTagState,
  OutreachState,
} from '../outreachApi';
import '../outreach.css';

type Tab = 'mailboxes' | 'campaigns' | 'inbox' | 'sequences';
type MailboxInput = Omit<
  OutreachMailbox,
  'id' | 'configured' | 'smtpStatus' | 'lastCheckedAt' | 'lastError' | 'signature' | 'productIds'
> & { signature?: string; clientPassword?: string };
type CampaignInput = Pick<
  OutreachCampaign,
  | 'name'
  | 'targetCount'
  | 'filters'
  | 'mailboxIds'
  | 'includeExisting'
  | 'continuous'
  | 'followUpEnabled'
  | 'intervalSeconds'
> & { mode: 'production' };

const labels: Record<string, string> = {
  draft: '待发送',
  preparing: '正在生成',
  ready: '已就绪',
  active: '运行中',
  paused: '已暂停',
  completed: '已完成',
  queued: '待发送',
  sending: '提交中',
  accepted: '服务商已接受',
  failed: '发送失败',
  unknown: '结果待核实',
  blocked: '待处理',
  skipped: '已跳过',
  cancelled: '已取消',
  connected: '连接正常',
  verified: '连接正常',
  ok: '连接正常',
  not_checked: '待验证',
  unconfigured: '待配置',
  not_configured: '待配置',
  error: '连接异常',
};
const statusLabel = (value: string) => labels[value] || value || '待配置';
const deliveryDetailLabel = (delivery: OutreachDelivery) =>
  delivery.status === 'failed' && delivery.resolution?.outcome === 'failed'
    ? '已核实未发出'
    : delivery.status === 'draft' && !delivery.subject
      ? '正在生成'
      : statusLabel(delivery.status);
const campaignStatusLabel = (campaign: OutreachCampaign) =>
  campaign.status === 'ready' &&
  !campaign.stats?.draft &&
  !campaign.stats?.queued &&
  !campaign.stats?.accepted
    ? campaign.stats?.skipped && !campaign.stats?.blocked
      ? '本次客户已跳过'
      : '待补齐条件'
    : campaign.status === 'draft'
      ? '未启动'
      : campaign.status === 'preparing'
        ? '正在生成'
        : statusLabel(campaign.status);
const productName = (product: OutreachProduct) => product.label || product.name || product.id;
const productApproved = (product: OutreachProduct) =>
  product.status === 'approved' || product.approved === true;
const mailboxProductNames = (mailbox: OutreachMailbox, products: OutreachProduct[]) =>
  (mailbox.productIds || []).map((id) => {
    const product = products.find((item) => item.id === id);
    return product ? productName(product) : `未找到产品（${id}）`;
  });
const productCategories = [
  { id: 'ventilation', label: '透气窗' },
  { id: 'shutters', label: '百叶窗' },
  { id: 'indoor', label: '室内成品帘' },
  { id: 'outdoor', label: '户外遮阳' },
];
const priorityGrades = ['A', 'B', 'C'];
const message = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请稍后重试。';
const formatTime = (value?: string | null) => {
  if (!value) return '—';
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? '—'
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(time);
};
const tone = (status: string) =>
  ['accepted', 'sent', 'connected', 'completed', 'active', 'ready'].includes(status)
    ? 'green'
    : ['failed', 'error'].includes(status)
      ? 'red'
      : ['unknown', 'blocked', 'attention', 'paused'].includes(status)
        ? 'amber'
        : 'neutral';
const pathFor = (kind: string, id: string, action?: string) =>
  `/${kind}/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
const canCancelCampaign = (campaign: OutreachCampaign) =>
  !campaign.acquisitionSource && !['completed', 'cancelled'].includes(campaign.status);

function InlineError({ value }: { value: string | null }) {
  return value ? (
    <div className="outreach-alert error" role="alert">
      {value}
    </div>
  ) : null;
}

function BusyIcon({ busy, children }: { busy: boolean; children: ReactNode }) {
  return busy ? <LoaderCircle size={15} className="outreach-spin" /> : children;
}

function ProductOptions({
  products,
  selected,
  onChange,
  approvedOnly = false,
  emptyText = '尚无可选产品资料。请先在产品资料中添加并审核，用于匹配客户和生成开发信。',
}: {
  products: OutreachProduct[];
  selected: string[];
  onChange: (ids: string[]) => void;
  approvedOnly?: boolean;
  emptyText?: string;
}) {
  if (!products.length) return <p className="outreach-hint">{emptyText}</p>;
  return (
    <div className="outreach-choices">
      {products.map((product) => (
        <label
          className={`outreach-choice ${selected.includes(product.id) ? 'selected' : ''}`}
          key={product.id}
        >
          <input
            type="checkbox"
            checked={selected.includes(product.id)}
            disabled={approvedOnly && !productApproved(product) && !selected.includes(product.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, product.id]
                  : selected.filter((id) => id !== product.id),
              )
            }
          />
          <span>
            {productName(product)}
            {!productApproved(product) && <small>待审核</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

function MailboxEditor({
  mailbox,
  onClose,
  onSave,
}: {
  mailbox: OutreachMailbox | null;
  onClose: () => void;
  onSave: (input: Partial<MailboxInput> | null, businessNote?: string) => Promise<void>;
}) {
  const [businessNote, setBusinessNote] = useState(mailbox?.businessNote || '');
  const initialSettings = useRef<MailboxInput | null>(null);
  const [fileIds, setFileIds] = useState<string[]>(mailbox?.knowledgeProductIds ?? []);
  const [site, setSite] = useState(mailbox?.website || '');
  const [brand, setBrand] = useState(mailbox?.brandName || '');
  const [replyMode, setReplyMode] = useState<
    NonNullable<OutreachMailbox['replyMode']> | 'business'
  >(mailbox?.autoBusinessReplies ? 'business' : mailbox?.replyMode || 'manual');
  const [email, setEmail] = useState(mailbox?.email || '');
  const domain = email.split('@')[1] || '';
  const website = site || (domain ? 'https://' + domain : '');
  const identity = { website, email, brandName: brand || siteBrand(website) || domain };
  const [displayName, setDisplayName] = useState(mailbox?.displayName || '');
  const [signature, setSignature] = useState(mailbox?.signature || '');
  const [signatureDesign, setSignatureDesign] = useState<MailSignatureDesign | null>(
    mailbox?.signatureDesign ||
      (mailbox?.signature ? null : defaultSignatureDesign(mailbox?.brandName, mailbox?.website)),
  );
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function readSettings(element: HTMLFormElement): MailboxInput {
    const form = new FormData(element);
    const password = String(form.get('password') || '');
    const address = String(form.get('email')).trim();
    const displayName = String(form.get('displayName')).trim();
    return {
      email: address,
      website,
      brandName: identity.brandName,
      owner: String(form.get('owner') || displayName),
      replyMode: replyMode === 'business' ? 'auto' : replyMode,
      autoBusinessReplies: replyMode === 'business',
      draftPersona: String(form.get('draftPersona') || '').trim(),
      knowledgeProductIds: fileIds,
      displayName,
      ...(signatureDesign ? { signatureDesign } : { signature }),
      priority: mailbox?.priority ?? 100,
      dailyLimit: Number(form.get('dailyLimit')),
      intervalSeconds: Number(form.get('intervalSeconds')),
      paused: mailbox?.paused ?? false,
      ...(password ? { clientPassword: password } : {}),
    };
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uploadingLogo) return;
    const input = readSettings(event.currentTarget);
    const changed =
      mailbox && initialSettings.current
        ? Object.fromEntries(
            Object.entries(input).filter(
              ([key, value]) =>
                JSON.stringify(value) !==
                JSON.stringify(initialSettings.current?.[key as keyof MailboxInput]),
            ),
          )
        : input;
    const edits = Object.keys(changed);
    if (
      edits.some((key) => !['draftPersona', 'knowledgeProductIds'].includes(key)) &&
      !event.currentTarget.reportValidity()
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const note = businessNote.trim();
      await onSave(
        edits.length ? changed : null,
        note === (mailbox?.businessNote || '') ? undefined : note,
      );
      onClose();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={mailbox ? '邮箱设置' : '添加邮箱'}
      onClose={() => {
        if (!busy && !uploadingLogo) onClose();
      }}
    >
      <form
        className="modal-body outreach-form"
        ref={(element) => {
          if (element && initialSettings.current === null)
            initialSettings.current = readSettings(element);
        }}
        onSubmit={(event) => void save(event)}
        noValidate
        autoComplete="off"
      >
        <InlineError value={error} />
        <div className="outreach-form-section">
          <h3>发件账号</h3>
          <p>邮件使用此账号的准确地址、名称和固定签名。</p>
        </div>
        <div className="outreach-form-grid">
          <label>
            发件邮箱
            <input
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              placeholder="sales@example.com"
              autoComplete="off"
            />
          </label>
          <label>
            业务员姓名 / 发件人名称
            <input
              name="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              placeholder="例如 Alice，客户看到的姓名"
              maxLength={160}
            />
          </label>
          <label className="outreach-full">
            产品官网
            <input
              type="url"
              value={website}
              onChange={(event) => setSite(event.target.value)}
              placeholder="https://company.com"
              required
            />
          </label>
          <label>
            官网品牌
            <input
              value={brand || siteBrand(website)}
              onChange={(event) => setBrand(event.target.value)}
              placeholder={domain}
            />
          </label>
          <label>
            负责人
            <input
              name="owner"
              defaultValue={mailbox?.owner || mailbox?.displayName}
              placeholder="默认使用业务员姓名"
            />
          </label>
          <label className="outreach-full">
            第三方客户端密码
            <input
              name="password"
              type="password"
              required={!mailbox?.configured}
              autoComplete="new-password"
              placeholder={
                mailbox?.configured ? '已保存；留空保留现有密码' : '粘贴此邮箱的第三方客户端密码'
              }
            />
            <small>仅提交到服务器，不保存在浏览器本地。</small>
          </label>
        </div>
        <div className="outreach-form-section">
          <label>
            业务备注
            <textarea
              aria-label="业务备注"
              value={businessNote}
              onChange={(event) => setBusinessNote(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="记录此邮箱的客户分工或团队交接事项"
            />
          </label>
          {!mailbox ? (
            <>
              <h3>客户回信</h3>
              <label>
                接待方式
                <select
                  value={replyMode}
                  onChange={(e) => setReplyMode(e.target.value as typeof replyMode)}
                >
                  <option value="manual">业务员手动回复</option>
                  <option value="review">生成草稿，逐封审核</option>
                  <option value="business">自动回复常规业务与已核实的产品问题</option>
                  <option value="auto">仅自动回复已核实的产品问题</option>
                </select>
              </label>
              <label>
                AI起草身份与语气
                <textarea
                  name="draftPersona"
                  rows={3}
                  maxLength={2000}
                  placeholder="例如：你是本品牌的工程项目销售。先回应客户当前项目，再提出方便采购团队执行的下一步。"
                />
                <small>留空时按本品牌外贸业务员的身份撰写正式邮件。</small>
              </label>
              <h4>回复可用资料</h4>
              <MailKnowledgeScope ids={fileIds} onChange={setFileIds} />
            </>
          ) : (
            <Link to={'/inbox?tab=mailboxes&replySettings=' + mailbox.id} onClick={onClose}>
              自动回复设置
            </Link>
          )}
          <small>已开启的未回复跟进会沿用首封邮件线程，客户回信后停止。</small>
        </div>
        <div className="outreach-form-section">
          <h3>邮件签名</h3>
          <p>填写公司资料，自动排版为此邮箱的专属签名。</p>
        </div>
        <MailSignatureFields
          email={email}
          displayName={displayName}
          signature={signature}
          design={signatureDesign}
          defaultCompany={mailbox?.brandName || ''}
          defaultWebsite={mailbox?.website || ''}
          disabled={busy || uploadingLogo}
          onChange={setSignatureDesign}
          onLegacyChange={setSignature}
          onUploadingChange={setUploadingLogo}
        />
        <div className="outreach-form-grid">
          <label>
            每日发送上限
            <input
              name="dailyLimit"
              type="number"
              min="1"
              max="500"
              defaultValue={mailbox?.dailyLimit ?? 50}
              required
            />
            <small>本系统的控制值。</small>
          </label>
          <label>
            发送间隔（秒）
            <input
              name="intervalSeconds"
              type="number"
              min="5"
              max="86400"
              defaultValue={mailbox?.intervalSeconds ?? 180}
              required
            />
          </label>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn secondary"
            disabled={busy || uploadingLogo}
            onClick={onClose}
          >
            取消
          </button>
          <button className="btn primary" disabled={busy || uploadingLogo}>
            <BusyIcon busy={busy}>
              <Check size={15} />
            </BusyIcon>
            保存邮箱
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MailboxImport({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (items: Record<string, unknown>[]) => Promise<void>;
}) {
  const [rows, setRows] = useState([crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const items = rows
      .map((id) => ({
        email: String(form.get(`${id}-email`) || '').trim(),
        displayName: String(form.get(`${id}-displayName`) || '').trim(),
        clientPassword: String(form.get(`${id}-password`) || ''),
      }))
      .filter((item) => item.email || item.displayName || item.clientPassword);
    if (!items.length) {
      setError('请至少填写一个邮箱。');
      return;
    }
    if (items.some((item) => !item.email || !item.clientPassword)) {
      setError('每一行请完整填写邮箱和第三方密码。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(
        items.map((item) => {
          const domain = item.email.split('@').at(-1)?.toLowerCase() || '';
          return {
            ...item,
            displayName: item.displayName || item.email.split('@')[0],
            website: `https://${domain}`,
            brandName: domain,
            priority: 100,
          };
        }),
      );
      onClose();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title="批量导入邮箱"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="modal-body outreach-form"
        autoComplete="off"
        onSubmit={(event) => void save(event)}
      >
        <p className="outreach-hint">
          导入后按邮箱官网匹配已审核产品。完善邮件签名并验证连接后，即可加入触达计划。
        </p>
        <InlineError value={error} />
        <div className="outreach-import-rows">
          {rows.map((id, index) => (
            <fieldset key={id} className="outreach-import-row">
              <legend>邮箱 {index + 1}</legend>
              <div className="outreach-form-grid">
                <label>
                  邮箱
                  <input name={`${id}-email`} type="email" placeholder="sales@example.com" />
                </label>
                <label>
                  发件人名称（选填）
                  <input name={`${id}-displayName`} placeholder="客户看到的发件人名称" />
                </label>
                <label>
                  第三方密码
                  <input name={`${id}-password`} type="password" autoComplete="new-password" />
                </label>
              </div>
              {rows.length > 1 && (
                <button
                  className="text-link"
                  type="button"
                  disabled={busy}
                  onClick={() => setRows(rows.filter((row) => row !== id))}
                >
                  移除此行
                </button>
              )}
            </fieldset>
          ))}
        </div>
        <button
          type="button"
          className="btn secondary"
          disabled={busy || rows.length >= 30}
          onClick={() => setRows([...rows, crypto.randomUUID()])}
        >
          <Plus size={15} />
          添加一行
        </button>
        <div className="modal-actions">
          <button type="button" className="btn secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy}>
            <BusyIcon busy={busy}>
              <Upload size={15} />
            </BusyIcon>
            导入邮箱
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CampaignEditor({
  campaign,
  mailboxes,
  products,
  onClose,
  onSave,
}: {
  campaign: OutreachCampaign | null;
  mailboxes: OutreachMailbox[];
  products: OutreachProduct[];
  onClose: () => void;
  onSave: (input: CampaignInput) => Promise<void>;
}) {
  const [selectedMailboxes, setSelectedMailboxes] = useState(
    campaign?.mailboxIds || mailboxes.map((item) => item.id),
  );
  const [selectedProducts, setSelectedProducts] = useState(campaign?.filters?.products || []);
  const [selectedCategories, setSelectedCategories] = useState(campaign?.filters?.categories || []);
  const [markets, setMarkets] = useState(() => [
    ...new Set(
      (campaign?.filters?.markets || []).map((market) => {
        const code = countryFor(market)?.code;
        return outreachMarkets.find((option) => option.value === code)?.value ?? market;
      }),
    ),
  ]);
  const [grades, setGrades] = useState(campaign?.filters?.grades || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const coveredProductIds = new Set(
    mailboxes
      .filter((mailbox) => selectedMailboxes.includes(mailbox.id))
      .flatMap((mailbox) => mailbox.productIds || []),
  );
  const categoryProducts = products.filter(
    (product) =>
      coveredProductIds.has(product.id) &&
      (!selectedCategories.length || selectedCategories.includes(product.category || '')),
  );
  const unavailableSelections = selectedProducts.filter(
    (id) => !categoryProducts.some((product) => product.id === id && productApproved(product)),
  );
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMailboxes.length) {
      setError('请至少选择一个发件邮箱。');
      return;
    }
    if (unavailableSelections.length) {
      setError('请先移除超出邮箱负责范围、品类范围或尚未审核的产品选择。');
      return;
    }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: String(form.get('name')).trim(),
        mode: 'production',
        targetCount: Number(form.get('targetCount')),
        filters: {
          markets,
          grades,
          products: selectedProducts.filter((id) =>
            categoryProducts.some((product) => product.id === id && productApproved(product)),
          ),
          categories: selectedCategories,
        },
        mailboxIds: selectedMailboxes,
        includeExisting: form.get('includeExisting') === 'on',
        continuous: form.get('continuous') === 'on',
        followUpEnabled: form.get('followUpEnabled') === 'on',
        intervalSeconds: Number(form.get('intervalSeconds')),
      });
      onClose();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={campaign ? '编辑触达计划' : '新建触达计划'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="modal-body outreach-form" onSubmit={(event) => void save(event)}>
        <InlineError value={error} />
        <div className="outreach-form-grid">
          <label className="outreach-full">
            计划名称
            <input
              name="name"
              required
              maxLength={120}
              defaultValue={campaign?.name}
              placeholder="例如：窗饰渠道客户 · 首次开发"
            />
          </label>
          <label>
            目标首封数量
            <input
              name="targetCount"
              type="number"
              min="1"
              max="1000"
              required
              defaultValue={campaign?.targetCount ?? 150}
            />
            <small>达到目标后停止新增发送。</small>
          </label>
          <label>
            发送间隔（秒）
            <input
              name="intervalSeconds"
              type="number"
              min="5"
              max="86400"
              required
              defaultValue={campaign?.intervalSeconds ?? 180}
            />
          </label>
          <div className="outreach-full outreach-market-field">
            <label htmlFor="campaign-markets">目标市场</label>
            <SearchableLocation
              id="campaign-markets"
              label="目标市场"
              multiple
              options={outreachMarkets}
              value={markets}
              onChange={setMarkets}
            />
            <small>可多选获客范围内的国家，支持搜索国家名称或代码。留空表示全部市场。</small>
          </div>
        </div>
        <div className="outreach-form-section">
          <h3>客户范围</h3>
          <p>只进入尚未开发、具备可用商务邮箱及匹配依据的企业。</p>
        </div>
        <span className="outreach-field-label">客户评级 · 不选表示不限制评级</span>
        <div className="outreach-choices">
          {priorityGrades.map((grade) => (
            <label
              className={`outreach-choice ${grades.includes(grade) ? 'selected' : ''}`}
              key={grade}
            >
              <input
                type="checkbox"
                checked={grades.includes(grade)}
                onChange={(event) =>
                  setGrades(
                    event.target.checked
                      ? [...grades, grade]
                      : grades.filter((item) => item !== grade),
                  )
                }
              />
              {grade}
            </label>
          ))}
        </div>
        <div className="outreach-form-section">
          <h3>发件邮箱与产品范围</h3>
          <p>先按客户产品选择对应邮箱；同一产品由多个邮箱负责时，再按连接、额度和间隔安排。</p>
        </div>
        <div className="outreach-mailbox-options">
          {mailboxes.map((mailbox) => (
            <label
              key={mailbox.id}
              className={`outreach-choice ${selectedMailboxes.includes(mailbox.id) ? 'selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedMailboxes.includes(mailbox.id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selectedMailboxes, mailbox.id]
                    : selectedMailboxes.filter((id) => id !== mailbox.id);
                  const nextCoverage = new Set(
                    mailboxes
                      .filter((item) => next.includes(item.id))
                      .flatMap((item) => item.productIds || []),
                  );
                  setSelectedMailboxes(next);
                  setSelectedProducts(selectedProducts.filter((id) => nextCoverage.has(id)));
                }}
              />
              <span>
                <strong>{mailbox.email}</strong>
                <small>
                  {mailbox.displayName || '待设置发件人名称'}
                  {!mailbox.configured ? ' · 待配置' : mailbox.paused ? ' · 已暂停' : ''}
                </small>
                <small>{mailboxProductNames(mailbox, products).join('、') || '暂无匹配产品'}</small>
              </span>
            </label>
          ))}
        </div>
        {!mailboxes.length && <p className="outreach-hint">请先在邮箱管理中添加邮箱。</p>}
        <span className="outreach-field-label">产品品类 · 不选则在所选邮箱负责范围内匹配</span>
        <div className="outreach-choices">
          {productCategories.map((category) => (
            <label
              key={category.id}
              className={`outreach-choice ${selectedCategories.includes(category.id) ? 'selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedCategories.includes(category.id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selectedCategories, category.id]
                    : selectedCategories.filter((id) => id !== category.id);
                  setSelectedCategories(next);
                  setSelectedProducts(
                    selectedProducts.filter(
                      (id) =>
                        !next.length ||
                        products.some(
                          (product) => product.id === id && next.includes(product.category || ''),
                        ),
                    ),
                  );
                }}
              />
              {category.label}
            </label>
          ))}
        </div>
        <span className="outreach-field-label">
          供货产品 · 仅显示所选邮箱负责的产品，不选则匹配其中已审核的产品
        </span>
        <ProductOptions
          products={categoryProducts}
          selected={selectedProducts}
          onChange={setSelectedProducts}
          approvedOnly
          emptyText="所选邮箱与品类范围内暂无匹配的已审核产品，请核对产品官网或调整选择。"
        />
        {unavailableSelections.length > 0 && (
          <div className="outreach-alert">
            <span>原计划有 {unavailableSelections.length} 项产品已不在当前可用范围内。</span>
            <button
              className="text-link"
              type="button"
              onClick={() =>
                setSelectedProducts(
                  selectedProducts.filter((id) => !unavailableSelections.includes(id)),
                )
              }
            >
              移除不可用产品选择
            </button>
          </div>
        )}
        <div className="outreach-check-stack">
          <label>
            <input
              name="includeExisting"
              type="checkbox"
              defaultChecked={campaign?.includeExisting ?? true}
            />
            <span>包含现有符合条件的未开发客户</span>
          </label>
          <label>
            <input
              name="continuous"
              type="checkbox"
              defaultChecked={campaign?.continuous ?? true}
            />
            <span>自动加入后续新发现的符合条件客户</span>
          </label>
          <label>
            <input
              type="checkbox"
              name="followUpEnabled"
              defaultChecked={campaign ? campaign.followUpEnabled === true : true}
            />
            按沟通中心的跟进序列自动跟进未回复客户
          </label>
        </div>
        <p className="outreach-hint">
          启动后，LLM 根据客户资料和匹配产品生成开发信，附上对应邮箱的固定签名并自动发送。
        </p>
        <div className="modal-actions">
          <button type="button" className="btn secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy}>
            <BusyIcon busy={busy}>
              <FileText size={15} />
            </BusyIcon>
            保存计划草稿
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeliveryBadge({ delivery }: { delivery: OutreachDelivery }) {
  const group = deliveryGroup(delivery);
  return (
    <Badge tone={delivery.bouncedAt ? 'red' : tone(group)}>
      {delivery.bouncedAt ? '投递失败' : deliveryGroupLabels[group]}
    </Badge>
  );
}

function MessagePreview({
  delivery,
  campaignName,
  onSuppress,
  onReconcile,
  onResolve,
  verifying = false,
  loadingBody = false,
}: {
  delivery: OutreachDelivery;
  campaignName?: string;
  onSuppress?: (delivery: OutreachDelivery) => void;
  onReconcile?: (delivery: OutreachDelivery) => void;
  onResolve?: (delivery: OutreachDelivery) => void;
  verifying?: boolean;
  loadingBody?: boolean;
}) {
  const customerLink = delivery.customerId
    ? `/leads?${new URLSearchParams({ lead: delivery.customerId })}`
    : null;
  if (delivery.status === 'skipped')
    return (
      <article className="outreach-message">
        <div className="outreach-message-top">
          <Badge tone="neutral">已跳过</Badge>
          <span>{formatTime(delivery.skippedAt || delivery.createdAt)}</span>
        </div>
        <h3>{delivery.companyName}</h3>
        <p>所属计划：{campaignName || delivery.campaignId}</p>
        <p>跳过原因：{delivery.reason || '首发条件未满足'}</p>
        <p className="outreach-hint">本次首发已结束，旧计划不会恢复发送。新一轮获客可重新评估。</p>
        {customerLink && <Link to={customerLink}>查看客户资料</Link>}
      </article>
    );
  return (
    <article className="outreach-message">
      <div className="outreach-message-top">
        <DeliveryBadge delivery={delivery} />
        <span>{formatTime(delivery.sentAt || delivery.createdAt)}</span>
      </div>
      <p className="outreach-hint">
        {delivery.bouncedAt
          ? `邮件提交后原发件邮箱收到退信 · ${formatTime(delivery.bouncedAt)}`
          : deliveryDetailLabel(delivery)}
        {delivery.status === 'accepted' && !delivery.bouncedAt && '；尚未确认客户收件或阅读。'}
        {delivery.status === 'unknown' && '；请先核对原邮箱，系统不会自动重发。'}
      </p>
      {delivery.bounce && (
        <p className="outreach-hint">
          {delivery.bounce.action} · {delivery.bounce.diagnostic}
        </p>
      )}
      {delivery.status === 'unknown' && (
        <p className="outreach-hint">结果待核实期间不会重复首发；请依据原邮箱或服务商记录确认。</p>
      )}
      <dl>
        <div>
          <dt>发件人</dt>
          <dd>{delivery.from || '尚未分配'}</dd>
        </div>
        <div>
          <dt>收件人</dt>
          <dd>{delivery.to || '待补充'}</dd>
        </div>
        <div>
          <dt>企业</dt>
          <dd>{delivery.companyName || '公司自有测试邮箱'}</dd>
        </div>
      </dl>
      {customerLink && <Link to={customerLink}>查看客户资料</Link>}
      {!!delivery.productFacts?.length && (
        <details className="outreach-hint">
          <summary>引用的供货资料 · {delivery.productFacts.length} 条</summary>
          {delivery.productFacts.map((fact) => (
            <div key={fact.id}>
              <p>{fact.text}</p>
              {fact.conditions && <p>适用条件：{fact.conditions}</p>}
              {fact.validUntil && <small>有效至：{formatTime(fact.validUntil)}</small>}
            </div>
          ))}
        </details>
      )}
      {delivery.matchReason && (
        <div className="outreach-match">
          <Globe2 size={15} />
          <span>{delivery.matchReason}</span>
        </div>
      )}
      {(delivery.subject || delivery.bodyText || delivery.bodyHtml) && (
        <>
          <h3>{delivery.subject || '尚未生成主题'}</h3>
          {delivery.bodyText || delivery.bodyHtml ? (
            <MailMessageBody
              message={{ ...delivery, bodyText: delivery.bodyText || '', source: 'outreach' }}
            />
          ) : (
            <div className="outreach-message-body">
              {loadingBody ? '正在读取邮件正文…' : '邮件内容尚未生成。'}
            </div>
          )}
        </>
      )}
      {delivery.reason && <div className="outreach-alert">{delivery.reason}</div>}
      {delivery.mode === 'internal_test' && delivery.receivedVerifiedAt && (
        <div className="outreach-alert success">
          <CheckCircle2 size={16} />
          <span>已核对测试收件 · {formatTime(delivery.receivedVerifiedAt)}</span>
        </div>
      )}
      {delivery.recordError && <div className="outreach-alert">{delivery.recordError}</div>}
      {delivery.messageId && <p className="outreach-message-id">邮件编号：{delivery.messageId}</p>}
      {delivery.attemptedAt && <p>尝试提交：{formatTime(delivery.attemptedAt)}</p>}
      {delivery.reconciliation && (
        <p className="outreach-hint">
          最近核实：{formatTime(delivery.reconciliation.at)} ·{' '}
          {delivery.reconciliation.result === 'sent' ? '找到原邮箱已发送证据' : '仍无法确认'}
          {delivery.reconciliation.evidence && ` · ${delivery.reconciliation.evidence}`}
        </p>
      )}
      {delivery.resolution && (
        <p className="outreach-hint">
          核实结论：{delivery.resolution.outcome === 'accepted' ? '已提交成功' : '未成功提交'}
          {delivery.resolution.source === 'manual' ? '（人工确认）' : '（邮箱证据）'} ·{' '}
          {delivery.resolution.evidence} · {formatTime(delivery.resolution.at)}
          {delivery.resolution.operator && ` · ${delivery.resolution.operator}`}
        </p>
      )}
      {delivery.status === 'unknown' && (
        <div className="outreach-actions">
          {onReconcile && (
            <button
              type="button"
              className="btn secondary"
              disabled={verifying}
              onClick={() => onReconcile(delivery)}
            >
              <BusyIcon busy={verifying}>
                <RefreshCw size={15} />
              </BusyIcon>
              {verifying ? '正在核实…' : '核实发送结果'}
            </button>
          )}
          {onResolve && (
            <button
              type="button"
              className="text-link"
              disabled={verifying}
              onClick={() => onResolve(delivery)}
            >
              人工记录核实结论
            </button>
          )}
        </div>
      )}
      {delivery.mode === 'production' && onSuppress && (
        <button
          type="button"
          className="text-link outreach-suppress"
          onClick={() => onSuppress(delivery)}
        >
          标记不再联系
        </button>
      )}
    </article>
  );
}

export function OutreachCommunication({
  initial,
  pages,
}: { initial?: InitialPage; pages?: Pick<InitialPage, 'outreach'> } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab: Tab = ['mailboxes', 'campaigns', 'inbox', 'sequences'].includes(requestedTab || '')
    ? (requestedTab as Tab)
    : 'mailboxes';
  const conversationMailboxId = searchParams.get('mailboxId') || 'all';
  function setTab(nextTab: Tab) {
    setSearchParams({ tab: nextTab });
  }
  const requestedFolder = searchParams.get('folder');
  const inboxView: InboxView =
    requestedFolder === 'later' || requestedFolder === 'done'
      ? requestedFolder
      : searchParams.get('hasReply') === '1'
        ? 'hasReply'
        : searchParams.get('unread') === '1'
          ? 'unread'
          : 'all';
  function inboxListParams(query: string) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'inbox');
    next.delete('thread');
    if (query.trim()) next.set('q', query.trim());
    else next.delete('q');
    return next;
  }
  function openMailboxConversations(mailboxId: string, query = '') {
    const next = tab === 'inbox' ? inboxListParams(query) : new URLSearchParams({ tab: 'inbox' });
    next.set('mailboxId', mailboxId);
    setSearchParams(next);
  }
  function changeInboxView(view: InboxView, query: string) {
    const next = inboxListParams(query);
    for (const filter of ['folder', 'unread', 'hasReply']) next.delete(filter);
    if (view === 'later' || view === 'done') next.set('folder', view);
    else if (view !== 'all') next.set(view, '1');
    setSearchParams(next);
  }
  const [received, setState] = useState<(OutreachState & { viewKey: string }) | null>(
    initial?.outreach ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mailboxEditor, setMailboxEditor] = useState<{ value: OutreachMailbox | null } | null>(
    null,
  );
  const [campaignEditor, setCampaignEditor] = useState<{ value: OutreachCampaign | null } | null>(
    null,
  );
  const [cancelTarget, setCancelTarget] = useState<OutreachCampaign | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const [tagState, setTagState] = useState<MailboxTagState | null>(null);
  const [tagError, setTagError] = useState('');
  const [tagRefresh, setTagRefresh] = useState(0);
  const tagGeneration = useRef(0);
  useEffect(() => {
    if (tab !== 'mailboxes') return;
    const controller = new AbortController();
    const generation = ++tagGeneration.current;
    setTagError('');
    outreachApi<MailboxTagState>('/mailbox-tags', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted && tagGeneration.current === generation) setTagState(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setTagError(message(e));
      });
    return () => controller.abort();
  }, [tab, tagRefresh]);
  const openedBox = useRef('');
  const requestedBox = tab === 'mailboxes' ? searchParams.get('mailboxId') || '' : '';
  useEffect(() => {
    if (!requestedBox) {
      openedBox.current = '';
      return;
    }
    if (openedBox.current === requestedBox) return;
    openedBox.current = requestedBox;
    const controller = new AbortController();
    outreachApi<OutreachMailbox>(pathFor('mailboxes', requestedBox), { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setMailboxEditor({ value });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(message(e));
      });
    return () => {
      controller.abort();
      openedBox.current = '';
      setMailboxEditor((current) => (current?.value?.id === requestedBox ? null : current));
    };
  }, [requestedBox]);
  const [mailFilter, setMailFilter] = useState('');
  const [inboxRefresh, setInboxRefresh] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testMailboxes, setTestMailboxes] = useState<OutreachMailbox[]>([]);
  const campaignTab = searchParams.get('campaignTab') === 'followups' ? 'followups' : 'overview';
  const detailId = tab === 'campaigns' ? searchParams.get('campaignId') : null;
  function setDetailId(id: string | null) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      if (id) params.set('campaignId', id);
      else params.delete('campaignId');
      params.delete('campaignTab');
      return params;
    });
  }
  const [detail, setDetail] = useState<OutreachCampaignDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [sampleBody, setSampleBody] = useState<{
    key: string;
    delivery?: OutreachDelivery;
    error?: string;
  } | null>(null);
  const [sampleRetry, setSampleRetry] = useState(0);
  const [resolutionTarget, setResolutionTarget] = useState<OutreachDelivery | null>(null);
  const [resolutionOutcome, setResolutionOutcome] = useState<'accepted' | 'failed'>('accepted');
  const [resolutionEvidence, setResolutionEvidence] = useState('');
  const [resolutionOperator, setResolutionOperator] = useState('');
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [suppressionTarget, setSuppressionTarget] = useState<OutreachDelivery | null>(null);
  const [suppressionReason, setSuppressionReason] = useState('人工标记不再联系');
  const [signatureMailboxes, setSignatureMailboxes] = useState<Record<string, OutreachMailbox>>({});
  const [signatureRefresh, setSignatureRefresh] = useState(0);
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [campaignQuery, setCampaignQuery] = useState('');
  const [campaignView, setCampaignView] = useState('current');
  const [campaignStatus, setCampaignStatus] = useState('all');
  const [campaignPage, setCampaignPage] = useState(1);
  const [campaignPageSize, setCampaignPageSize] = useState(20);
  const viewKey = new URLSearchParams(
    tab === 'campaigns'
      ? {
          view: campaignView,
          status: campaignStatus,
          q: campaignQuery.trim(),
          page: String(campaignPage),
          pageSize: String(campaignPageSize),
        }
      : { view: tab },
  ).toString();
  const state =
    received?.viewKey !== viewKey && pages?.outreach?.viewKey === viewKey
      ? pages.outreach
      : received;
  const signatureKey = JSON.stringify(
    state?.mailboxes.map(({ id, signature, updatedAt }) => [id, signature, updatedAt]) || [],
  );
  useEffect(() => {
    if (pages && received?.viewKey.startsWith('view=current&')) pages.outreach = received;
  }, [pages, received]);
  const request = useRef(0);
  const seededState = useRef(initial?.outreach?.viewKey);
  const pendingState = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const detailStatus = useRef<string | null>(null);
  const internalTestKey = useRef<string | null>(null);

  useEffect(() => {
    if (tab !== 'mailboxes') return;
    let active = true;
    const controller = new AbortController();
    setSignatureMailboxes({});
    setSignatureError(null);
    const mailboxes: [string, ...unknown[]][] = JSON.parse(signatureKey);
    for (const [id] of mailboxes) {
      void outreachApi<OutreachMailbox>(pathFor('mailboxes', id), { signal: controller.signal })
        .then((mailbox) => {
          if (active) setSignatureMailboxes((current) => ({ ...current, [id]: mailbox }));
        })
        .catch((reason: unknown) => {
          if (active) setSignatureError(`完整签名读取失败：${message(reason)} 请点击刷新重试。`);
        });
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [tab, signatureKey, signatureRefresh]);
  const refresh = useCallback(
    async (poll = false) => {
      const pending = pendingState.current;
      if (pending?.key === viewKey) {
        if (poll) return pending.promise;
        const generation = request.current;
        await pending.promise.catch(() => {});
        if (generation !== request.current) return;
      }
      const current = ++request.current;
      const promise = outreachApi<OutreachState>('/state?' + viewKey)
        .then((result) => {
          if (current === request.current) setState({ ...result, viewKey });
        })
        .finally(() => {
          if (pendingState.current?.promise === promise) pendingState.current = null;
        });
      pendingState.current = { key: viewKey, promise };
      return promise;
    },
    [viewKey],
  );
  const refreshDetail = useCallback(async (id: string) => {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setDetailError(null);
    try {
      const result = await outreachApi<OutreachCampaignDetail>(
        `${pathFor('campaigns', id)}?summary=1`,
        {
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted) {
        detailStatus.current = result.campaign.status;
        setDetail(result);
        setDetailError(null);
      }
    } catch (reason) {
      if (!controller.signal.aborted) setDetailError(message(reason));
    } finally {
      if (detailController.current === controller) detailController.current = null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (seededState.current !== viewKey) {
      setLoading(true);
      void refresh(true)
        .catch((reason: unknown) => {
          if (active) setError(message(reason));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    seededState.current = undefined;
    const interval = window.setInterval(() => {
      if (!document.hidden)
        void refresh(true).catch((reason: unknown) => {
          if (active) setError(message(reason));
        });
    }, 10000);
    return () => {
      window.clearInterval(interval);
      active = false;
      pendingState.current = null;
      request.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setSampleId(null);
    detailStatus.current = null;
    if (detailId) void refreshDetail(detailId);
    const interval = detailId
      ? window.setInterval(() => {
          if (
            !document.hidden &&
            !detailController.current &&
            !['completed', 'cancelled'].includes(detailStatus.current || '')
          )
            void refreshDetail(detailId);
        }, 5000)
      : null;
    return () => {
      if (interval) window.clearInterval(interval);
      detailController.current?.abort();
      detailController.current = null;
    };
  }, [detailId, refreshDetail]);

  async function act(
    key: string,
    path: string,
    body: unknown = {},
    success = '已保存',
    method = 'POST',
    headers?: HeadersInit,
  ) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await outreachApi(path, { method, body: JSON.stringify(body), headers });
      await refresh();
      if (detailId) await refreshDetail(detailId);
      setNotice(success);
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setBusy(null);
    }
  }
  async function saveMailbox(input: Partial<MailboxInput> | null, businessNote?: string) {
    const mailbox = mailboxEditor?.value;
    const path = mailbox ? pathFor('mailboxes', mailbox.id) : '/mailboxes';
    if (input) {
      const writingOnly =
        mailbox &&
        Object.keys(input).every((key) => ['draftPersona', 'knowledgeProductIds'].includes(key));
      await outreachApi(writingOnly ? path + '/writing' : path, {
        method: writingOnly ? 'PATCH' : mailbox ? 'PUT' : 'POST',
        body: JSON.stringify({ ...input, businessNote }),
      });
      setSignatureRefresh((current) => current + 1);
    } else if (mailbox && businessNote !== undefined) {
      await outreachApi(path + '/note', {
        method: 'PATCH',
        body: JSON.stringify({ businessNote }),
      });
    } else return;
    await refresh();
    setNotice(input ? '邮箱设置已保存。' : '业务备注已保存。');
  }
  async function editMailbox(id: string) {
    setBusy(`mailbox-${id}`);
    setError(null);
    try {
      const mailbox = await outreachApi<OutreachMailbox>(pathFor('mailboxes', id));
      setMailboxEditor({ value: mailbox });
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(null);
    }
  }
  async function saveCampaign(input: CampaignInput) {
    await outreachApi(
      campaignEditor?.value ? pathFor('campaigns', campaignEditor.value.id) : '/campaigns',
      {
        method: campaignEditor?.value ? 'PUT' : 'POST',
        body: JSON.stringify({
          ...input,
          ...(campaignEditor?.value ? { revision: campaignEditor.value.revision } : {}),
        }),
      },
    );
    await refresh();
    setNotice('计划已保存为草稿，可生成并检查样稿。');
  }
  function confirmCancellation(campaign: OutreachCampaign) {
    setError(null);
    setCancelTarget(campaign);
  }
  const mailboxes = state?.mailboxes || [];
  const filteredMailboxes = mailFilter
    ? mailboxes.filter((m) =>
        tagState?.assignments.some((a) => a.mailboxId === m.id && a.tagId === mailFilter),
      )
    : mailboxes;
  const campaigns = state?.campaigns || [];
  const visibleCampaigns = state?.viewKey === viewKey ? campaigns : [];
  const filteredCount = state?.viewKey === viewKey ? state.filtered : 0;
  const campaignTotalPages = Math.max(1, Math.ceil(filteredCount / campaignPageSize));
  const currentCampaignPage = state?.viewKey === viewKey ? state.page : 1;
  const deliveryStats = state?.deliveryStats;
  const products = state?.products || [];
  const connected = mailboxes.filter(
    (mailbox) => mailbox.configured && mailbox.smtpStatus === 'connected' && !mailbox.paused,
  );
  const testRingChanged =
    JSON.stringify(testMailboxes.map((mailbox) => [mailbox.id, mailbox.email])) !==
    JSON.stringify(connected.map((mailbox) => [mailbox.id, mailbox.email]));
  const shownDetail = detail?.campaign.id === detailId ? detail : null;
  const sample =
    shownDetail?.deliveries.find((delivery) => delivery.id === sampleId) ||
    shownDetail?.deliveries.find((delivery) => delivery.status === 'draft') ||
    shownDetail?.deliveries.find((delivery) => delivery.status !== 'cancelled') ||
    shownDetail?.deliveries[0];
  const sampleKey = sample ? JSON.stringify(sample) : '';
  useEffect(() => {
    setSampleBody(null);
    if (!sampleKey) return;
    const controller = new AbortController();
    const selected: OutreachDelivery = JSON.parse(sampleKey);
    void outreachApi<OutreachDelivery>(pathFor('deliveries', selected.id), {
      signal: controller.signal,
    })
      .then((delivery) => {
        if (!controller.signal.aborted) setSampleBody({ key: sampleKey, delivery });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setSampleBody({ key: sampleKey, error: message(reason) });
      });
    return () => controller.abort();
  }, [sampleKey, sampleRetry]);
  const samplePreview = sampleBody?.key === sampleKey ? sampleBody : null;
  async function verifyDelivery(
    delivery: OutreachDelivery,
    outcome?: 'accepted' | 'failed',
    evidence?: string,
    operator?: string,
  ) {
    const key = `verify-${delivery.id}`;
    setBusy(key);
    setVerificationError(null);
    try {
      const result = await outreachApi<OutreachDelivery>(
        pathFor('deliveries', delivery.id, outcome ? 'resolve' : 'reconcile'),
        {
          method: 'POST',
          body: JSON.stringify(outcome ? { outcome, evidence, operator } : {}),
        },
      );

      if (sampleBody?.delivery?.id === result.id)
        setSampleBody({ key: sampleBody.key, delivery: result });

      if (detailId) await refreshDetail(detailId);
      await refresh();
      setNotice(
        result.status === 'unknown'
          ? '仍无法确认发送结果，请核对原邮箱或服务商日志。'
          : '发送结果已记录。',
      );
      if (outcome) setResolutionTarget(null);
    } catch (reason) {
      setVerificationError(message(reason));
    } finally {
      setBusy(null);
    }
  }

  const settingsId = tab === 'mailboxes' && searchParams.get('replySettings');
  const settingsBox = mailboxes.find((m) => m.id === settingsId);
  const review = tab === 'inbox' && requestedFolder === 'review';
  const sections = [
    {
      group: '会话',
      items: [
        { id: 'inbox', label: '收件箱', icon: Inbox },
        { id: 'review', label: '待审草稿', icon: FileText, count: state?.reviewCount },
      ],
    },
    {
      group: '邮件渠道',
      items: [
        { id: 'mailboxes', label: '邮箱管理', icon: Mail },
        { id: 'agent', label: '自动回复', icon: Bot },
      ],
    },
    {
      group: '外联',
      items: [
        { id: 'campaigns', label: '触达计划', icon: Send },
        { id: 'sequences', label: '跟进序列', icon: Clock3 },
      ],
    },
  ];
  const selected = settingsId ? 'agent' : review ? 'review' : tab;
  const section = sections.find((group) => group.items.some((item) => item.id === selected))!;
  const title = section.items.find((item) => item.id === selected)!.label;
  const refreshButton = (
    <button
      className={tab === 'inbox' ? 'inbox-refresh' : 'btn secondary'}
      disabled={!!busy || loading}
      onClick={() => {
        setError(null);
        setLoading(true);
        setSignatureRefresh((current) => current + 1);
        setInboxRefresh((value) => value + 1);
        setTagRefresh((v) => v + 1);
        void refresh()
          .catch((reason: unknown) => setError(message(reason)))
          .finally(() => setLoading(false));
      }}
    >
      <RefreshCw size={15} className={loading ? 'outreach-spin' : ''} />
      刷新
    </button>
  );
  function openSection(id: string) {
    if (id === 'review') setSearchParams({ tab: 'inbox', folder: 'review' });
    else if (id === 'agent')
      setSearchParams({ tab: 'mailboxes', replySettings: mailboxes[0]?.id || 'select' });
    else setTab(id as Tab);
  }
  return (
    <SectionWorkspace
      title="沟通中心"
      icon={MessagesSquare}
      sections={sections}
      selected={selected}
      onSelect={openSection}
      className="fin-center"
      panelPrefix="outreach-tab-"
      sidebarExtra={
        mailboxes.length > 0 && (
          <div className="fin-accounts">
            <div className="section-caption">按邮箱查看</div>
            {mailboxes.map((box, i) => (
              <button
                key={box.id}
                title={box.email}
                onClick={() => openMailboxConversations(box.id)}
                aria-pressed={tab === 'inbox' && conversationMailboxId === box.id}
              >
                <i className={`fin-dot tone-${i % 3}`} />
                <span>{box.email}</span>
              </button>
            ))}
          </div>
        )
      }
    >
      <div
        className={tab === 'inbox' ? 'outreach-page fin-body fin-inbox' : 'outreach-page fin-body'}
      >
        {tab !== 'inbox' && (
          <div className="fin-crumb">
            {section.group}
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
        )}
        {settingsId ? (
          settingsBox ? (
            <MailReplySettings
              key={settingsBox.id}
              box={settingsBox}
              boxes={mailboxes}
              onSaved={() => refresh()}
            />
          ) : (
            <section className="fin-missing">
              <h1>自动回复</h1>
              <p>{error || (loading ? '正在读取邮箱…' : '请选择已配置的邮箱。')}</p>
              <Link to="/inbox?tab=mailboxes">返回邮箱管理</Link>
            </section>
          )
        ) : (
          <>
            {tab !== 'inbox' && (
              <header className="fin-heading page-heading">
                <h1>{title}</h1>
                <div className="fin-actions">
                  {refreshButton}
                  {tab === 'mailboxes' && (
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => setShowLabels(true)}
                    >
                      邮箱标签
                    </button>
                  )}
                  {['mailboxes', 'campaigns'].includes(tab) && (
                    <button
                      className="btn primary"
                      disabled={!!busy}
                      onClick={() =>
                        tab === 'mailboxes'
                          ? setMailboxEditor({ value: null })
                          : setCampaignEditor({ value: null })
                      }
                    >
                      <Plus size={16} />
                      {tab === 'mailboxes' ? '添加邮箱' : '新建计划'}
                    </button>
                  )}
                </div>
              </header>
            )}
            {tab === 'inbox' && !state && !loading && refreshButton}
            <InlineError value={error} />
            {notice && (
              <div className="outreach-alert success" role="status">
                <CheckCircle2 size={17} />
                <span>{notice}</span>
                <button
                  className="icon-button"
                  aria-label="关闭提示"
                  onClick={() => setNotice(null)}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {!state && loading ? (
              <div className="outreach-loading">
                <LoaderCircle size={22} className="outreach-spin" />
                正在读取邮箱和计划…
              </div>
            ) : (
              state && (
                <div
                  role="tabpanel"
                  id={`outreach-panel-${tab}`}
                  aria-labelledby={`outreach-tab-${selected}`}
                >
                  {tab === 'inbox' && (
                    <SalesInbox
                      refreshButton={refreshButton}
                      key={JSON.stringify([
                        conversationMailboxId,
                        searchParams.get('thread'),
                        searchParams.get('customerId'),
                        searchParams.get('inboundOnly'),
                        requestedFolder === 'review',
                      ])}
                      view={inboxView}
                      initialQuery={searchParams.get('q') || ''}
                      onViewChange={changeInboxView}
                      initialThread={searchParams.get('thread') || ''}
                      customerId={searchParams.get('customerId') || ''}
                      inboundOnly={searchParams.get('inboundOnly') === '1'}
                      mailboxId={conversationMailboxId}
                      mailboxes={mailboxes}
                      onMailboxChange={openMailboxConversations}
                      review={searchParams.get('folder') === 'review'}
                      reviewCount={state.reviewCount}
                      refreshToken={inboxRefresh}
                      onExitReview={() => setSearchParams({ tab: 'inbox' })}
                    />
                  )}
                  {tab === 'sequences' && <FollowUpSequences refreshToken={inboxRefresh} />}
                  {tab === 'campaigns' && state && (
                    <>
                      <div className="outreach-metrics">
                        {[
                          {
                            label: '可用发件邮箱',
                            value: connected.length,
                            detail: `共 ${mailboxes.length} 个邮箱`,
                            icon: Mail,
                          },
                          {
                            label: '已发送',
                            value: deliveryStats?.accepted || 0,
                            detail: '含公司试发及已核实发送',
                            icon: CheckCircle2,
                          },
                          {
                            label: '待发送',
                            value: state.deliveryGroups?.pending || 0,
                            detail: '按计划节奏执行',
                            icon: Clock3,
                          },
                          {
                            label: '需处理',
                            value: state.deliveryGroups?.attention || 0,
                            detail: '查看具体原因',
                            icon: FileText,
                          },
                        ].map((metric) => (
                          <div className="panel outreach-metric" key={metric.label}>
                            <div>
                              <span>{metric.label}</span>
                              <metric.icon size={17} />
                            </div>
                            <strong>{metric.value}</strong>
                            <small>{metric.detail}</small>
                          </div>
                        ))}
                      </div>
                      <section className="outreach-test-strip">
                        <span className="outreach-feature-icon">
                          <Send size={22} />
                        </span>
                        <div>
                          <h3>公司邮箱发送测试</h3>
                          <p>测试邮件仅发送到已配置的公司邮箱，使用带标记的固定测试内容。</p>
                        </div>
                        <div className="outreach-strip-actions">
                          <button
                            className="btn secondary"
                            disabled={!!busy || connected.length < 2}
                            onClick={() => {
                              internalTestKey.current = crypto.randomUUID();
                              setTestMailboxes(connected);
                              setTestOpen(true);
                            }}
                          >
                            公司邮箱试发
                            <ArrowRight size={15} />
                          </button>
                        </div>
                      </section>
                      {!state.readiness.generatorConfigured && (
                        <div className="outreach-alert">
                          邮件生成服务尚未配置。可以先完成邮箱配置和计划草稿。
                        </div>
                      )}
                      <div className="outreach-section-heading">
                        <div>
                          <h2>触达计划</h2>
                          <p>选择客户范围，启动后自动生成开发信并按规则发送。</p>
                        </div>
                        <span>{state.counts.active} 个运行中</span>
                      </div>
                      <section className="panel outreach-records">
                        <div className="outreach-campaign-views" aria-label="计划视图">
                          {[
                            ['current', '当前计划'],
                            ['history', '历史计划'],
                            ['tests', '公司试发'],
                          ].map(([value, label]) => (
                            <button
                              key={value}
                              className="btn secondary"
                              aria-pressed={campaignView === value}
                              onClick={() => {
                                setCampaignView(value);
                                setCampaignStatus('all');
                                setCampaignPage(1);
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="outreach-record-toolbar">
                          <label className="outreach-search">
                            <Search size={16} />
                            <input
                              aria-label="搜索计划名称"
                              placeholder="搜索计划名称"
                              value={campaignQuery}
                              onChange={(event) => {
                                setCampaignQuery(event.target.value);
                                setCampaignPage(1);
                              }}
                            />
                          </label>
                          <select
                            aria-label="按计划状态筛选"
                            value={campaignStatus}
                            onChange={(event) => {
                              setCampaignStatus(event.target.value);
                              setCampaignPage(1);
                            }}
                          >
                            <option value="all">全部状态</option>
                            <option value="attention">需处理</option>
                            {(campaignView === 'history'
                              ? ['completed', 'cancelled']
                              : campaignView === 'current'
                                ? ['draft', 'preparing', 'ready', 'active', 'paused']
                                : [
                                    'draft',
                                    'preparing',
                                    'ready',
                                    'active',
                                    'paused',
                                    'completed',
                                    'cancelled',
                                  ]
                            ).map((status) => (
                              <option key={status} value={status}>
                                {status === 'draft'
                                  ? '未启动'
                                  : status === 'preparing'
                                    ? '准备中'
                                    : statusLabel(status)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <nav className="outreach-record-pagination" aria-label="触达计划分页">
                          <span aria-live="polite">共 {filteredCount} 个计划</span>
                          <label>
                            每页
                            <select
                              aria-label="每页计划条数"
                              value={campaignPageSize}
                              onChange={(event) => {
                                setCampaignPageSize(Number(event.target.value));
                                setCampaignPage(1);
                              }}
                            >
                              {[10, 20, 50, 100].map((size) => (
                                <option key={size} value={size}>
                                  {size} 条
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="outreach-record-page-actions">
                            <button
                              className="btn secondary"
                              disabled={currentCampaignPage <= 1}
                              onClick={() => setCampaignPage(currentCampaignPage - 1)}
                            >
                              上一页
                            </button>
                            <span>
                              第 {currentCampaignPage} / {campaignTotalPages} 页
                            </span>
                            <button
                              className="btn secondary"
                              disabled={currentCampaignPage >= campaignTotalPages}
                              onClick={() => setCampaignPage(currentCampaignPage + 1)}
                            >
                              下一页
                            </button>
                          </div>
                        </nav>
                        {visibleCampaigns.length ? (
                          <div className="outreach-table-wrap">
                            <table className="outreach-table outreach-campaign-table">
                              <thead>
                                <tr>
                                  <th>计划名称</th>
                                  <th>状态</th>
                                  <th>已发送 / 目标</th>
                                  <th>需处理</th>
                                  <th>创建时间</th>
                                  <th>操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {visibleCampaigns.map((campaign) => (
                                  <tr key={campaign.id} onClick={() => setDetailId(campaign.id)}>
                                    <td className="outreach-campaign-name">
                                      <strong>{campaign.name}</strong>
                                      {campaign.acquisitionSource && <small>获客后自动首发</small>}
                                      {campaign.lastError && (
                                        <small className="outreach-row-error">
                                          {campaign.lastError}
                                        </small>
                                      )}
                                    </td>
                                    <td>
                                      <Badge tone={tone(campaign.status)}>
                                        {campaignStatusLabel(campaign)}
                                      </Badge>
                                    </td>
                                    <td className="outreach-campaign-progress-cell">
                                      <strong>
                                        {campaign.stats?.accepted || 0} /{' '}
                                        {campaign.acquisitionSource
                                          ? campaign.customerCount || 0
                                          : campaign.targetCount}
                                      </strong>
                                      {campaign.acquisitionSource && (
                                        <small>已发送 / 本轮收录客户</small>
                                      )}
                                      {!!campaign.stats?.skipped && (
                                        <small>已跳过 {campaign.stats.skipped} 家</small>
                                      )}
                                      <div className="outreach-progress-track" aria-hidden="true">
                                        <span
                                          style={{
                                            width: `${Math.min(100, ((campaign.stats?.accepted || 0) / Math.max(1, campaign.acquisitionSource ? campaign.customerCount || 0 : campaign.targetCount || 0)) * 100)}%`,
                                          }}
                                        />
                                      </div>
                                    </td>
                                    <td>
                                      <Badge
                                        tone={
                                          campaign.deliveryGroups?.attention ? 'amber' : 'neutral'
                                        }
                                      >
                                        {campaign.deliveryGroups?.attention || 0}
                                      </Badge>
                                    </td>
                                    <td className="outreach-time-cell">
                                      {formatTime(campaign.createdAt)}
                                    </td>
                                    <td onClick={(event) => event.stopPropagation()}>
                                      <div className="outreach-card-actions">
                                        <button
                                          className="btn secondary"
                                          disabled={!!busy}
                                          onClick={() => setDetailId(campaign.id)}
                                        >
                                          <Eye size={15} />
                                          执行详情
                                        </button>
                                        {campaign.acquisitionSource && (
                                          <Link
                                            className="btn secondary"
                                            to={
                                              campaign.acquisitionSource.scheduleId
                                                ? '/automation?tab=schedules'
                                                : `/automation?tab=runs&job=${campaign.acquisitionSource.jobId}`
                                            }
                                          >
                                            管理获客与自动首发
                                          </Link>
                                        )}
                                        {!campaign.acquisitionSource &&
                                          campaign.status === 'active' && (
                                            <button
                                              className="btn secondary"
                                              disabled={!!busy}
                                              onClick={() =>
                                                void act(
                                                  `pause-${campaign.id}`,
                                                  pathFor('campaigns', campaign.id, 'pause'),
                                                  {},
                                                  '计划已暂停。',
                                                )
                                              }
                                            >
                                              <Pause size={15} />
                                              暂停计划
                                            </button>
                                          )}
                                        {canCancelCampaign(campaign) && (
                                          <details className="outreach-campaign-more">
                                            <summary>更多</summary>
                                            <div className="outreach-card-actions">
                                              {campaign.mode === 'production' &&
                                                !['active', 'preparing'].includes(
                                                  campaign.status,
                                                ) && (
                                                  <button
                                                    className="btn subtle"
                                                    disabled={!!busy}
                                                    onClick={() =>
                                                      setCampaignEditor({ value: campaign })
                                                    }
                                                  >
                                                    编辑
                                                  </button>
                                                )}
                                              <button
                                                className="btn danger"
                                                disabled={!!busy}
                                                onClick={() => confirmCancellation(campaign)}
                                              >
                                                取消计划
                                              </button>
                                            </div>
                                          </details>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : state?.viewKey !== viewKey && !error ? (
                          <p role="status">正在读取触达计划…</p>
                        ) : (
                          <Empty
                            title={
                              campaignQuery.trim() || campaignStatus !== 'all'
                                ? '没有符合筛选条件的计划'
                                : campaignView === 'current'
                                  ? '暂无当前正式计划'
                                  : campaignView === 'history'
                                    ? '暂无历史计划'
                                    : '暂无公司试发计划'
                            }
                            detail={
                              campaignView === 'current'
                                ? '新建计划开始开发，或切换到历史计划、公司试发查看已有记录。'
                                : '可调整搜索词或状态筛选。'
                            }
                          />
                        )}
                      </section>
                    </>
                  )}
                  {tab === 'mailboxes' && (
                    <>
                      <div className="outreach-section-heading">
                        <div>
                          <h2>发件邮箱</h2>
                        </div>
                        <button
                          className="btn secondary"
                          disabled={!!busy}
                          onClick={() => setImportOpen(true)}
                        >
                          <Upload size={15} />
                          批量导入
                        </button>
                      </div>
                      {!!tagState?.tags.length && (
                        <label className="mail-tag-filter">
                          邮箱标签{' '}
                          <select
                            aria-label="邮箱标签"
                            value={mailFilter}
                            onChange={(e) => setMailFilter(e.target.value)}
                          >
                            <option value="">全部标签</option>
                            {tagState.tags.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <InlineError value={tagError || signatureError} />
                      {mailboxes.length ? (
                        <div className="outreach-mailbox-grid">
                          {!filteredMailboxes.length && (
                            <Empty
                              title="没有使用此标签的邮箱"
                              detail="选择其他标签，或在邮箱标签中分配邮箱。"
                            />
                          )}
                          {filteredMailboxes.map((mailbox, index) => (
                            <section className="panel outreach-mailbox-card" key={mailbox.id}>
                              <div className="outreach-card-heading">
                                <span className={`outreach-brand-mark mark-${index % 3}`}>
                                  <Mail size={23} />
                                </span>
                                <div>
                                  <h3>{mailbox.email}</h3>
                                  <p>
                                    {mailbox.owner || mailbox.displayName || '待设置负责人'} ·{' '}
                                    {mailbox.replyMode === 'auto'
                                      ? '自动接待'
                                      : mailbox.replyMode === 'review'
                                        ? '逐封审核'
                                        : '手动接待'}
                                  </p>
                                </div>
                                <Badge tone={mailbox.paused ? 'amber' : tone(mailbox.smtpStatus)}>
                                  {mailbox.paused
                                    ? '已暂停'
                                    : mailbox.configured
                                      ? statusLabel(mailbox.smtpStatus)
                                      : '待配置密码'}
                                </Badge>
                              </div>
                              {tagState && (
                                <div className="outreach-product-tags">
                                  {tagState.tags
                                    .filter((t) =>
                                      tagState.assignments.some(
                                        (a) => a.mailboxId === mailbox.id && a.tagId === t.id,
                                      ),
                                    )
                                    .map((t) => (
                                      <span key={t.id}>{t.name}</span>
                                    ))}
                                </div>
                              )}
                              <div className="outreach-mailbox-coverage">
                                {mailbox.businessNote && (
                                  <>
                                    <span>业务备注</span>
                                    <p className="outreach-business-note">{mailbox.businessNote}</p>
                                  </>
                                )}
                                {mailbox.replyMode && mailbox.replyMode !== 'manual' && (
                                  <Link
                                    to={
                                      '/inbox?tab=mailboxes&replySettings=' +
                                      mailbox.id +
                                      '&section=knowledge'
                                    }
                                  >
                                    回复资料 · 已选 {mailbox.knowledgeProductIds?.length || 0}{' '}
                                    份文件
                                  </Link>
                                )}
                              </div>
                              <details className="fin-channel-details">
                                <summary>签名与发送限制</summary>
                                <div className="outreach-mailbox-signature">
                                  <span>邮件签名</span>
                                  {mailbox.signature ? (
                                    <div
                                      className="mail-signature-card-preview"
                                      dangerouslySetInnerHTML={{
                                        __html: renderMailboxSignature(
                                          signatureMailboxes[mailbox.id] || mailbox,
                                        ).html,
                                      }}
                                    />
                                  ) : (
                                    <p>尚未填写；请点击配置完善。</p>
                                  )}
                                </div>
                                <div className="outreach-mailbox-numbers">
                                  <div>
                                    <strong>
                                      {mailbox.dailyLimit}
                                      <small>封</small>
                                    </strong>
                                    <span>每日上限</span>
                                  </div>
                                  <div>
                                    <strong>
                                      {mailbox.intervalSeconds}
                                      <small>秒</small>
                                    </strong>
                                    <span>发送间隔</span>
                                  </div>
                                </div>
                              </details>
                              {mailbox.lastError && (
                                <div className="outreach-alert error">{mailbox.lastError}</div>
                              )}
                              <p className="outreach-last-check">
                                最近验证 {formatTime(mailbox.lastCheckedAt)}
                              </p>
                              <div className="outreach-card-actions">
                                {' '}
                                <Link to={'/inbox?tab=mailboxes&replySettings=' + mailbox.id}>
                                  <Settings2 size={14} /> 自动回复设置
                                </Link>
                                <button
                                  className="btn subtle"
                                  onClick={() => openMailboxConversations(mailbox.id)}
                                >
                                  <Inbox size={15} />
                                  查看邮件
                                </button>
                                <button
                                  className="btn secondary"
                                  disabled={!!busy}
                                  onClick={() => void editMailbox(mailbox.id)}
                                >
                                  <Settings2 size={15} />
                                  {mailbox.configured === false ? '连接邮箱' : '配置'}
                                </button>
                                <button
                                  className="btn subtle"
                                  disabled={!!busy || !mailbox.configured}
                                  onClick={() =>
                                    void act(
                                      `verify-${mailbox.id}`,
                                      pathFor('mailboxes', mailbox.id, 'verify') + '?check=both',
                                      {},
                                      'SMTP 发件与 IMAP 收件、已发送文件夹均已验证。',
                                    )
                                  }
                                >
                                  <BusyIcon busy={busy === `verify-${mailbox.id}`}>
                                    <RefreshCw size={15} />
                                  </BusyIcon>
                                  验证连接
                                </button>
                                <button
                                  className="outreach-icon-action"
                                  disabled={!!busy}
                                  aria-label={`${mailbox.paused ? '恢复' : '暂停'} ${mailbox.email}`}
                                  title={mailbox.paused ? '恢复此邮箱' : '暂停此邮箱'}
                                  onClick={() =>
                                    void act(
                                      `toggle-${mailbox.id}`,
                                      pathFor('mailboxes', mailbox.id),
                                      { paused: !mailbox.paused },
                                      mailbox.paused ? '邮箱已恢复。' : '邮箱已暂停。',
                                      'PUT',
                                    )
                                  }
                                >
                                  {mailbox.paused ? <Play size={16} /> : <Pause size={16} />}
                                </button>
                              </div>
                            </section>
                          ))}
                        </div>
                      ) : (
                        <section className="panel">
                          <Empty
                            title="接入公司发件邮箱"
                            detail="填写邮箱、第三方密码、发件人名称和签名，验证后加入发送池。"
                          />
                          <div className="outreach-empty-action">
                            <button
                              className="btn primary"
                              onClick={() => setMailboxEditor({ value: null })}
                            >
                              <Plus size={16} />
                              添加邮箱
                            </button>
                          </div>
                        </section>
                      )}
                    </>
                  )}
                </div>
              )
            )}
            {showLabels && (
              <MailboxLabels
                mailboxes={mailboxes}
                state={tagState}
                loadError={tagError}
                onRetry={() => setTagRefresh((v) => v + 1)}
                onClose={() => setShowLabels(false)}
                onChange={(value) => {
                  ++tagGeneration.current;
                  setTagState(value);
                  setMailFilter('');
                }}
              />
            )}
            {mailboxEditor && (
              <MailboxEditor
                mailbox={mailboxEditor.value}
                onClose={() => {
                  setMailboxEditor(null);
                  if (requestedBox) setTab('mailboxes');
                }}
                onSave={saveMailbox}
              />
            )}
            {importOpen && (
              <MailboxImport
                onClose={() => setImportOpen(false)}
                onSave={async (items) => {
                  await outreachApi('/mailboxes/import', {
                    method: 'POST',
                    body: JSON.stringify({ items }),
                  });
                  await refresh();
                  setNotice('邮箱已导入，请完善签名并验证连接。');
                }}
              />
            )}
            {campaignEditor && (
              <CampaignEditor
                campaign={campaignEditor.value}
                mailboxes={mailboxes}
                products={products}
                onClose={() => setCampaignEditor(null)}
                onSave={saveCampaign}
              />
            )}
            {detailId && (
              <Modal
                wide
                title={shownDetail?.campaign.name || '计划详情'}
                onClose={() => {
                  if (!busy) setDetailId(null);
                }}
              >
                <div className="modal-body outreach-detail">
                  <InlineError value={detailError} />
                  <InlineError value={error} />
                  {!shownDetail ? (
                    detailError ? (
                      <button
                        className="btn secondary"
                        onClick={() => void refreshDetail(detailId)}
                      >
                        重试读取计划
                      </button>
                    ) : (
                      <div className="outreach-loading" role="status">
                        <LoaderCircle className="outreach-spin" size={20} />
                        正在读取计划…
                      </div>
                    )
                  ) : (
                    <>
                      <div className="outreach-detail-summary">
                        <Badge tone={tone(shownDetail.campaign.status)}>
                          {campaignStatusLabel(shownDetail.campaign)}
                        </Badge>
                        <span>
                          {shownDetail.campaign.acquisitionSource
                            ? `本轮收录 ${shownDetail.campaign.customerIds?.length || 0} 家`
                            : `目标 ${shownDetail.campaign.targetCount} 封`}
                        </span>
                        <span>
                          已发送 {shownDetail.campaign.stats?.accepted || 0} 家 · 已跳过{' '}
                          {shownDetail.campaign.stats?.skipped || 0} 家
                        </span>
                        <span>版本 {shownDetail.campaign.revision}</span>
                        <span>LLM 自动生成 · 固定签名</span>
                      </div>
                      <InlineError value={shownDetail.campaign.lastError || null} />
                      {shownDetail.campaign.mode === 'production' &&
                        shownDetail.campaign.status !== 'cancelled' && (
                          <div className="outreach-plan-rules">
                            <p>
                              首封未回复跟进：
                              {shownDetail.campaign.followUpEnabled
                                ? shownDetail.campaign.followUpPaused
                                  ? '已暂停'
                                  : '已开启'
                                : '未开启'}
                              。开启后成功发送的首封将采用当时的跟进序列，在客户回信时停止。
                            </p>
                            <button
                              className="btn secondary"
                              disabled={!!busy}
                              onClick={() =>
                                void act(
                                  'follow-up',
                                  `/campaigns/${shownDetail.campaign.id}/follow-ups`,
                                  {
                                    action: shownDetail.campaign.followUpEnabled
                                      ? 'disable'
                                      : 'enable',
                                  },
                                )
                              }
                            >
                              {shownDetail.campaign.followUpEnabled
                                ? '关闭剩余追信'
                                : '开启后续首封的自动追信'}
                            </button>
                            {shownDetail.campaign.followUpEnabled && (
                              <>
                                <button
                                  className="btn secondary"
                                  disabled={!!busy}
                                  onClick={() =>
                                    void act(
                                      'follow-up',
                                      `/campaigns/${shownDetail.campaign.id}/follow-ups`,
                                      { action: 'pause' },
                                    )
                                  }
                                >
                                  暂停追信
                                </button>
                                <button
                                  className="btn secondary"
                                  disabled={!!busy}
                                  onClick={() =>
                                    void act(
                                      'follow-up',
                                      `/campaigns/${shownDetail.campaign.id}/follow-ups`,
                                      { action: 'resume' },
                                    )
                                  }
                                >
                                  已核对来信，恢复追信
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      {shownDetail.campaign.mode === 'production' && (
                        <nav className="sequence-picker" aria-label="计划详情页签">
                          {(
                            [
                              ['overview', '计划概况'],
                              ['followups', '客户跟进'],
                            ] as const
                          ).map(([key, label]) => (
                            <button
                              key={key}
                              type="button"
                              aria-pressed={campaignTab === key}
                              onClick={() =>
                                setSearchParams((current) => {
                                  const params = new URLSearchParams(current);
                                  params.set('campaignTab', key);
                                  return params;
                                })
                              }
                            >
                              {label}
                            </button>
                          ))}
                        </nav>
                      )}
                      {shownDetail.campaign.mode === 'production' && campaignTab === 'followups' ? (
                        <CampaignFollowUps
                          key={shownDetail.campaign.id}
                          id={shownDetail.campaign.id}
                          refreshToken={
                            inboxRefresh +
                            (shownDetail.campaign.followUpPaused ? 1 : 0) +
                            (shownDetail.campaign.followUpEnabled ? 2 : 0)
                          }
                          mailboxes={mailboxes}
                        />
                      ) : (
                        <>
                          {shownDetail.campaign.status === 'cancelled' && (
                            <p className="outreach-hint" role="status">
                              此计划已取消
                              {shownDetail.campaign.cancelledAt
                                ? `（${formatTime(shownDetail.campaign.cancelledAt)}）`
                                : ''}
                              ，不会继续准备邮件或安排发送。已提交的邮件及其实际结果保留在计划详情。
                            </p>
                          )}
                          {shownDetail.campaign.mode === 'production' && (
                            <>
                              {canCancelCampaign(shownDetail.campaign) && (
                                <p className="outreach-hint">
                                  启动后，系统从客户库筛选合适客户，生成开发信、附上固定签名并自动发送。可在此查看实际邮件与执行结果。
                                </p>
                              )}
                              <details className="outreach-plan-rules" open>
                                <summary>本次计划的客户范围与产品内容</summary>
                                <dl>
                                  <div>
                                    <dt>市场</dt>
                                    <dd>
                                      {shownDetail.campaign.filters?.markets
                                        .map((market) => countryFor(market)?.zh || market)
                                        .join('、') || '全部市场'}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>客户评级</dt>
                                    <dd>
                                      {shownDetail.campaign.filters?.grades.join('、') ||
                                        '不限制优先级，仍须具备匹配与联系依据'}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>产品品类</dt>
                                    <dd>
                                      {shownDetail.campaign.filters?.categories?.length
                                        ? shownDetail.campaign.filters.categories
                                            .map(
                                              (id) =>
                                                productCategories.find(
                                                  (category) => category.id === id,
                                                )?.label || id,
                                            )
                                            .join('、')
                                        : '在所选邮箱负责的产品范围内按客户情况匹配'}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>客户来源</dt>
                                    <dd>
                                      {shownDetail.campaign.acquisitionSource
                                        ? '仅本轮新增和更新的未首发客户'
                                        : shownDetail.campaign.includeExisting
                                          ? '包含现有未开发客户'
                                          : '仅计划创建后新增客户'}
                                      {shownDetail.campaign.acquisitionSource
                                        ? '；客户首发条件不足时跳过本次，旧计划不恢复发送'
                                        : shownDetail.campaign.continuous
                                          ? '；持续加入符合条件的新客户'
                                          : '；固定批次'}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>发件邮箱</dt>
                                    <dd>
                                      {shownDetail.campaign.mailboxIds
                                        .map(
                                          (id) =>
                                            mailboxes.find((mailbox) => mailbox.id === id)?.email ||
                                            id,
                                        )
                                        .join('、')}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>分配方式</dt>
                                    <dd>
                                      先按客户产品匹配负责邮箱，同产品范围内再按连接状态、额度和间隔安排
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>发送节奏</dt>
                                    <dd>
                                      间隔 {shownDetail.campaign.intervalSeconds}{' '}
                                      秒，同时遵守各邮箱每日上限
                                    </dd>
                                  </div>
                                </dl>
                                <p className="outreach-hint">
                                  根据客户资料和邮箱负责的已确认产品范围生成基础介绍，使用该邮箱的固定签名。
                                </p>
                              </details>
                            </>
                          )}
                          {shownDetail.deliveries.length ? (
                            <div className="outreach-preview-layout">
                              <div className="outreach-preview-list">
                                {shownDetail.deliveries.map((delivery) => (
                                  <button
                                    key={delivery.id}
                                    className={sample?.id === delivery.id ? 'selected' : ''}
                                    onClick={() => setSampleId(delivery.id)}
                                  >
                                    <strong>{delivery.companyName || delivery.to}</strong>
                                    <span>
                                      {delivery.status === 'skipped'
                                        ? delivery.reason
                                        : delivery.subject || '尚未生成'}
                                    </span>
                                    <small>{deliveryDetailLabel(delivery)}</small>
                                  </button>
                                ))}
                              </div>
                              {samplePreview?.delivery ? (
                                <>
                                  <InlineError value={verificationError} />
                                  <MessagePreview
                                    key={samplePreview.delivery.id}
                                    delivery={samplePreview.delivery}
                                    campaignName={shownDetail.campaign.name}
                                    onReconcile={(delivery) => void verifyDelivery(delivery)}
                                    onResolve={(delivery) => {
                                      setResolutionTarget(delivery);
                                      setResolutionOutcome('accepted');
                                      setResolutionEvidence('');
                                      setResolutionOperator('');
                                      setVerificationError(null);
                                    }}
                                    verifying={busy === `verify-${samplePreview.delivery.id}`}
                                    onSuppress={(delivery) => {
                                      setSuppressionReason('人工标记不再联系');
                                      setSuppressionTarget(delivery);
                                    }}
                                  />
                                </>
                              ) : samplePreview?.error ? (
                                <div>
                                  <InlineError value={samplePreview.error} />
                                  <button
                                    className="btn secondary"
                                    onClick={() => setSampleRetry((value) => value + 1)}
                                  >
                                    重试读取正文
                                  </button>
                                </div>
                              ) : (
                                <div className="outreach-loading" role="status">
                                  <LoaderCircle className="outreach-spin" size={20} />
                                  正在读取邮件正文…
                                </div>
                              )}
                            </div>
                          ) : (
                            <Empty
                              title="还没有执行邮件"
                              detail={
                                shownDetail.campaign.status === 'cancelled'
                                  ? '此计划已取消，不会再生成样稿或发送邮件。'
                                  : '启动计划后自动生成并发送，可在此查看执行结果。'
                              }
                            />
                          )}
                        </>
                      )}
                      <div className="outreach-detail-actions">
                        {shownDetail.campaign.acquisitionSource && (
                          <Link
                            className="btn secondary"
                            to={
                              shownDetail.campaign.acquisitionSource.scheduleId
                                ? '/automation?tab=schedules'
                                : `/automation?tab=runs&job=${shownDetail.campaign.acquisitionSource.jobId}`
                            }
                          >
                            管理获客与自动首发
                          </Link>
                        )}
                        {shownDetail.campaign.mode === 'production' &&
                          canCancelCampaign(shownDetail.campaign) && (
                            <>
                              {shownDetail.campaign.status === 'active' ? (
                                <button
                                  className="btn secondary"
                                  disabled={!!busy}
                                  onClick={() =>
                                    void act(
                                      'pause',
                                      pathFor('campaigns', shownDetail.campaign.id, 'pause'),
                                      {},
                                      '计划已暂停。',
                                    )
                                  }
                                >
                                  <Pause size={15} />
                                  暂停
                                </button>
                              ) : (
                                <button
                                  className="btn primary"
                                  disabled={
                                    !!busy ||
                                    !['draft', 'ready', 'paused'].includes(
                                      shownDetail.campaign.status,
                                    )
                                  }
                                  onClick={() =>
                                    void act(
                                      'start',
                                      pathFor('campaigns', shownDetail.campaign.id, 'start'),
                                      { revision: shownDetail.campaign.revision },
                                      '计划已启动，按设定节奏自动发送。',
                                    )
                                  }
                                >
                                  <Play size={15} />
                                  {shownDetail.campaign.status === 'paused'
                                    ? '恢复计划'
                                    : '启动自动发送'}
                                </button>
                              )}
                            </>
                          )}
                        {canCancelCampaign(shownDetail.campaign) && (
                          <button
                            className="btn danger"
                            disabled={!!busy}
                            onClick={() => confirmCancellation(shownDetail.campaign)}
                          >
                            <X size={15} />
                            取消计划
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </Modal>
            )}
            {cancelTarget && (
              <Modal
                title="取消触达计划"
                onClose={() => {
                  if (!busy) setCancelTarget(null);
                }}
              >
                <div className="modal-body outreach-form">
                  <p>
                    确认取消 <strong>{cancelTarget.name}</strong>？
                  </p>
                  <p>
                    取消后将停止准备邮件和后续发送，未发送任务会取消，已发送记录与计划详情会保留。此计划不能恢复，需要再次开发时请新建计划。
                  </p>
                  <p className="outreach-hint">
                    已提交到邮件服务商的邮件无法撤回，正在提交的邮件仍会记录实际发送结果。
                  </p>
                  <InlineError value={error} />
                  <div className="modal-actions">
                    <button
                      className="btn secondary"
                      disabled={!!busy}
                      onClick={() => setCancelTarget(null)}
                    >
                      保留计划
                    </button>
                    <button
                      className="btn danger"
                      disabled={!!busy}
                      onClick={() => {
                        void act(
                          `cancel-${cancelTarget.id}`,
                          pathFor('campaigns', cancelTarget.id, 'cancel'),
                          { revision: cancelTarget.revision, confirmed: true },
                          '计划已取消，后续发送已停止，已有记录已保留。',
                        ).then((ok) => {
                          if (ok) setCancelTarget(null);
                        });
                      }}
                    >
                      <BusyIcon busy={busy === `cancel-${cancelTarget.id}`}>
                        <X size={15} />
                      </BusyIcon>
                      {busy === `cancel-${cancelTarget.id}` ? '正在取消…' : '确认取消计划'}
                    </button>
                  </div>
                </div>
              </Modal>
            )}
            {resolutionTarget && (
              <Modal
                title="记录发送核实结论"
                onClose={() => {
                  if (!busy) setResolutionTarget(null);
                }}
              >
                <form
                  className="modal-body outreach-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void verifyDelivery(
                      resolutionTarget,
                      resolutionOutcome,
                      resolutionEvidence.trim(),
                      resolutionOperator.trim(),
                    );
                  }}
                >
                  <p>请依据原发件邮箱或服务商日志核实。未找到已发送邮件，不能证明邮件没有发出。</p>
                  <label>
                    核实结论
                    <select
                      value={resolutionOutcome}
                      onChange={(event) =>
                        setResolutionOutcome(event.target.value as 'accepted' | 'failed')
                      }
                    >
                      <option value="accepted">确认服务商已接受发送</option>
                      <option value="failed">确认未成功提交</option>
                    </select>
                  </label>
                  <label>
                    操作人（请填写姓名或标识）
                    <input
                      value={resolutionOperator}
                      onChange={(event) => setResolutionOperator(event.target.value)}
                      maxLength={100}
                      required
                    />
                  </label>
                  <label>
                    证据说明
                    <textarea
                      value={resolutionEvidence}
                      onChange={(event) => setResolutionEvidence(event.target.value)}
                      rows={4}
                      maxLength={1000}
                      required
                      placeholder="例如原邮箱已发送记录的邮件编号、服务商日志的查询时间与结果"
                    />
                  </label>
                  <InlineError value={verificationError} />
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={!!busy || !resolutionEvidence.trim() || !resolutionOperator.trim()}
                  >
                    <BusyIcon busy={busy === `verify-${resolutionTarget.id}`}>
                      <Check size={15} />
                    </BusyIcon>
                    保存核实结论
                  </button>
                </form>
              </Modal>
            )}
            {suppressionTarget && (
              <Modal
                title="标记不再联系"
                onClose={() => {
                  if (!busy) setSuppressionTarget(null);
                }}
              >
                <form
                  className="modal-body outreach-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(
                      'suppress',
                      '/suppress',
                      {
                        customerId: suppressionTarget.customerId,
                        email: suppressionTarget.to,
                        reason: suppressionReason.trim(),
                      },
                      '已标记不再联系，后续发送将排除此客户。',
                    ).then((ok) => {
                      if (ok) setSuppressionTarget(null);
                    });
                  }}
                >
                  <p>
                    从后续发送中排除{' '}
                    <strong>{suppressionTarget.companyName || suppressionTarget.to}</strong>
                    ，保留已有记录。
                  </p>
                  <label>
                    标记原因
                    <textarea
                      value={suppressionReason}
                      onChange={(event) => setSuppressionReason(event.target.value)}
                      rows={3}
                      maxLength={200}
                      required
                      placeholder="例如：已由业务员联系，或客户明确要求停止联系"
                    />
                  </label>
                  <InlineError value={error} />
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={!!busy}
                      onClick={() => setSuppressionTarget(null)}
                    >
                      取消
                    </button>
                    <button className="btn primary" disabled={!!busy || !suppressionReason.trim()}>
                      确认标记
                    </button>
                  </div>
                </form>
              </Modal>
            )}
            {testOpen && (
              <Modal
                title="确认公司邮箱试发"
                onClose={() => {
                  if (!busy) setTestOpen(false);
                }}
              >
                <div className="modal-body outreach-form">
                  <p>
                    将发送 {testMailboxes.length} 封带测试标记的固定测试信，确认各邮箱的发送链路。
                  </p>
                  <div className="outreach-ring">
                    {testMailboxes.map((mailbox, index) => (
                      <div key={mailbox.id}>
                        <span>{mailbox.email}</span>
                        <ArrowRight size={16} />
                        <strong>{testMailboxes[(index + 1) % testMailboxes.length]?.email}</strong>
                      </div>
                    ))}
                  </div>
                  <InlineError value={error} />
                  {testRingChanged && (
                    <div className="outreach-alert">
                      邮箱列表已变化，请关闭此窗口后重新确认试发对象。
                    </div>
                  )}
                  <div className="modal-actions">
                    <button
                      className="btn secondary"
                      disabled={!!busy}
                      onClick={() => setTestOpen(false)}
                    >
                      取消
                    </button>
                    <button
                      className="btn primary"
                      disabled={!!busy || testMailboxes.length < 2 || testRingChanged}
                      onClick={() => {
                        void act(
                          'test',
                          '/internal-test',
                          {
                            confirmed: true,
                            expectedMailboxIds: testMailboxes.map((mailbox) => mailbox.id),
                            expectedMailboxEmails: testMailboxes.map((mailbox) => mailbox.email),
                          },
                          '公司试发已创建，请在公司试发计划中查看结果。',
                          'POST',
                          {
                            'Idempotency-Key':
                              internalTestKey.current ||
                              (internalTestKey.current = crypto.randomUUID()),
                          },
                        ).then((ok) => {
                          if (ok) setTestOpen(false);
                        });
                      }}
                    >
                      <BusyIcon busy={busy === 'test'}>
                        <Send size={15} />
                      </BusyIcon>
                      发送这 {testMailboxes.length} 封测试信
                    </button>
                  </div>
                </div>
              </Modal>
            )}
          </>
        )}
      </div>
    </SectionWorkspace>
  );
}
