import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  FileText,
  Globe2,
  Inbox,
  LoaderCircle,
  Mail,
  MessageSquare,
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
import { PageHeading } from '../components/PageHeading';
import { MailConversations } from '../components/MailConversations';
import { MailMessageBody } from '../components/MailMessageBody';
import { MailSignatureFields, defaultSignatureDesign } from '../components/MailSignatureFields';
import { renderMailboxSignature } from '../domain/mail-signature.mjs';
import type { MailSignatureDesign } from '../domain/mail-signature.mjs';
import { Badge, Empty, Modal } from '../components/ui';
import { outreachApi } from '../outreachApi';
import type {
  OutreachCampaign,
  OutreachCampaignDetail,
  OutreachDelivery,
  OutreachDeliveryPage,
  OutreachMailbox,
  OutreachProduct,
  OutreachState,
} from '../outreachApi';
import '../outreach.css';

type Tab = 'mailboxes' | 'campaigns' | 'deliveries' | 'conversations';
type MailboxInput = Omit<
  OutreachMailbox,
  'id' | 'configured' | 'smtpStatus' | 'lastCheckedAt' | 'lastError' | 'signature'
> & { signature?: string; clientPassword?: string };
type CampaignInput = Pick<
  OutreachCampaign,
  | 'name'
  | 'targetCount'
  | 'filters'
  | 'mailboxIds'
  | 'includeExisting'
  | 'continuous'
  | 'intervalSeconds'
  | 'outreachClaims'
> & { mode: 'production' };

const labels: Record<string, string> = {
  draft: '待审核',
  preparing: '正在准备样稿',
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
const message = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请稍后重试。';
const split = (value: string) => [
  ...new Set(
    value
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];
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
  ['accepted', 'connected', 'completed', 'active', 'ready'].includes(status)
    ? 'green'
    : ['failed', 'error'].includes(status)
      ? 'red'
      : ['unknown', 'blocked', 'paused'].includes(status)
        ? 'amber'
        : 'neutral';
const pathFor = (kind: string, id: string, action?: string) =>
  `/${kind}/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
const canCancelCampaign = (campaign: OutreachCampaign) =>
  !['completed', 'cancelled'].includes(campaign.status);

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
  products,
  onClose,
  onSave,
}: {
  mailbox: OutreachMailbox | null;
  products: OutreachProduct[];
  onClose: () => void;
  onSave: (input: MailboxInput) => Promise<void>;
}) {
  const [selectedProducts, setSelectedProducts] = useState(mailbox?.productIds || []);
  const [email, setEmail] = useState(mailbox?.email || '');
  const [displayName, setDisplayName] = useState(mailbox?.displayName || '');
  const [signature, setSignature] = useState(mailbox?.signature || '');
  const [signatureDesign, setSignatureDesign] = useState<MailSignatureDesign | null>(
    mailbox?.signatureDesign ||
      (mailbox?.signature ? null : defaultSignatureDesign(mailbox?.brandName, mailbox?.website)),
  );
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uploadingLogo) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') || '');
    const address = String(form.get('email')).trim();
    const domain = address.split('@').at(-1)?.toLowerCase() || '';
    const displayName = String(form.get('displayName')).trim();
    setBusy(true);
    setError(null);
    try {
      await onSave({
        email: address,
        website:
          mailbox?.email === address && mailbox.website ? mailbox.website : `https://${domain}`,
        brandName: mailbox?.brandName || displayName || domain,
        displayName,
        ...(signatureDesign ? { signatureDesign } : { signature }),
        productIds: selectedProducts,
        priority: mailbox?.priority ?? 100,
        dailyLimit: Number(form.get('dailyLimit')),
        intervalSeconds: Number(form.get('intervalSeconds')),
        paused: mailbox?.paused ?? false,
        ...(password ? { clientPassword: password } : {}),
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
      title={mailbox ? '邮箱设置' : '添加邮箱'}
      onClose={() => {
        if (!busy && !uploadingLogo) onClose();
      }}
    >
      <form
        className="modal-body outreach-form"
        onSubmit={(event) => void save(event)}
        autoComplete="off"
      >
        <InlineError value={error} />
        <div className="outreach-form-section">
          <h3>此邮箱负责的产品</h3>
          <p>先按客户产品匹配邮箱。以确认的供货范围配置，无需等待官网可访问。</p>
        </div>
        <ProductOptions
          products={products}
          selected={selectedProducts}
          onChange={setSelectedProducts}
        />
        {selectedProducts.some((id) => !products.some((product) => product.id === id)) && (
          <div className="outreach-alert">
            <span>以下已配置产品不在当前资料库中，正式计划不会使用：</span>
            {selectedProducts
              .filter((id) => !products.some((product) => product.id === id))
              .map((id) => (
                <button
                  key={id}
                  className="text-link"
                  type="button"
                  onClick={() =>
                    setSelectedProducts(selectedProducts.filter((item) => item !== id))
                  }
                >
                  移除 {id}
                </button>
              ))}
          </div>
        )}
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
              min="30"
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

function MailboxSignatureEditor({
  mailbox,
  onClose,
  onSave,
}: {
  mailbox: OutreachMailbox;
  onClose: () => void;
  onSave: (input: {
    displayName: string;
    signatureDesign?: MailSignatureDesign;
    signature?: string;
  }) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(mailbox.displayName);
  const [signature, setSignature] = useState(mailbox.signature);
  const [design, setDesign] = useState<MailSignatureDesign | null>(
    mailbox.signatureDesign ||
      (mailbox.signature ? null : defaultSignatureDesign(mailbox.brandName, mailbox.website)),
  );
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uploadingLogo) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        displayName: displayName.trim(),
        ...(design ? { signatureDesign: design } : { signature }),
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
      title="业务员与邮件签名"
      onClose={() => {
        if (!busy && !uploadingLogo) onClose();
      }}
    >
      <form className="modal-body outreach-form" onSubmit={(event) => void save(event)}>
        <InlineError value={error} />
        <div className="outreach-form-grid">
          <label>
            业务员姓名 / 发件人名称
            <input
              required
              value={displayName}
              maxLength={160}
              disabled={busy}
              placeholder="例如 Alice"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label>
            发件邮箱
            <input value={mailbox.email} readOnly />
          </label>
        </div>
        <MailSignatureFields
          email={mailbox.email}
          displayName={displayName}
          signature={signature}
          design={design}
          defaultCompany={mailbox.brandName}
          defaultWebsite={mailbox.website}
          disabled={busy || uploadingLogo}
          onChange={setDesign}
          onLegacyChange={setSignature}
          onUploadingChange={setUploadingLogo}
        />
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
            保存签名
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
            productIds: [],
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
          导入后为每个邮箱配置负责产品、邮件签名并验证连接，再加入对应产品的触达计划。
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
  const [grades, setGrades] = useState(campaign?.filters?.grades || []);
  const [claims, setClaims] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (campaign?.outreachClaims || []).map((claim) => [claim.productId, claim.text]),
    ),
  );
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
  const claimProducts = categoryProducts.filter(
    (product) =>
      productApproved(product) &&
      (!selectedProducts.length || selectedProducts.includes(product.id)),
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
          markets: split(String(form.get('markets') || '')),
          grades,
          products: selectedProducts.filter((id) =>
            categoryProducts.some((product) => product.id === id && productApproved(product)),
          ),
          categories: selectedCategories,
        },
        mailboxIds: selectedMailboxes,
        includeExisting: form.get('includeExisting') === 'on',
        continuous: form.get('continuous') === 'on',
        intervalSeconds: Number(form.get('intervalSeconds')),
        outreachClaims: claimProducts
          .filter((product) => claims[product.id]?.trim())
          .map((product) => ({
            productId: product.id,
            productVersion: product.version ?? 1,
            text: claims[product.id].trim(),
          })),
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
              min="30"
              max="86400"
              required
              defaultValue={campaign?.intervalSeconds ?? 180}
            />
          </label>
          <label className="outreach-full">
            目标市场
            <input
              name="markets"
              defaultValue={campaign?.filters?.markets.join('，')}
              placeholder="不限制市场；或填写 US、AU，以逗号分隔"
            />
            <small>使用客户资料中的国家代码；留空表示全部市场。</small>
          </label>
        </div>
        <div className="outreach-form-section">
          <h3>客户范围</h3>
          <p>只进入尚未开发、具备可用商务邮箱及匹配依据的企业。</p>
        </div>
        <span className="outreach-field-label">客户评级 · 不选表示不限制评级</span>
        <div className="outreach-choices">
          {['A', 'B', 'C', '待核实', '待补全'].map((grade) => (
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
                <small>
                  {mailboxProductNames(mailbox, products).join('、') || '尚未配置负责产品'}
                </small>
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
          供货产品 · 仅显示所选邮箱负责的产品，不选则使用其中已填写介绍内容的产品
        </span>
        <ProductOptions
          products={categoryProducts}
          selected={selectedProducts}
          onChange={setSelectedProducts}
          approvedOnly
          emptyText="所选邮箱与品类范围内暂无可选产品，请调整选择或先配置邮箱负责产品。"
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
        </div>
        <div className="outreach-form-section">
          <h3>本次允许介绍的产品内容</h3>
          <p>仅使用所选邮箱负责范围内的已审核产品。审核计划后，系统结合客户信息撰写首封邮件。</p>
        </div>
        {claimProducts.length ? (
          claimProducts.map((product) => (
            <label key={product.id}>
              {productName(product)}
              <textarea
                rows={3}
                value={claims[product.id] || ''}
                onChange={(event) => setClaims({ ...claims, [product.id]: event.target.value })}
                placeholder="例如：可提供 PVC shutters 成品及对应型材配件，支持按已确认的产品配置组织供货。"
              />
              <small>产品资料版本 {product.version ?? 1} · 留空时不使用此产品生成开发信。</small>
            </label>
          ))
        ) : (
          <p className="outreach-hint">
            当前邮箱及品类范围内尚无已审核产品。请检查邮箱负责产品，或先保存草稿再补齐资料。
          </p>
        )}
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

function MessagePreview({
  delivery,
  onSuppress,
}: {
  delivery: OutreachDelivery;
  onSuppress?: (delivery: OutreachDelivery) => void;
}) {
  return (
    <article className="outreach-message">
      <div className="outreach-message-top">
        <Badge tone={tone(delivery.status)}>{statusLabel(delivery.status)}</Badge>
        <span>{formatTime(delivery.sentAt || delivery.createdAt)}</span>
      </div>
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
      {delivery.matchReason && (
        <div className="outreach-match">
          <Globe2 size={15} />
          <span>{delivery.matchReason}</span>
        </div>
      )}
      <h3>{delivery.subject || '尚未生成主题'}</h3>
      {delivery.bodyText || delivery.bodyHtml ? (
        <MailMessageBody message={{ ...delivery, source: 'outreach' }} />
      ) : (
        <div className="outreach-message-body">邮件内容尚未生成。</div>
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

export function OutreachCommunication() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab: Tab = ['mailboxes', 'campaigns', 'deliveries', 'conversations'].includes(
    requestedTab || '',
  )
    ? (requestedTab as Tab)
    : 'campaigns';
  const conversationMailboxId = searchParams.get('mailboxId') || 'all';
  function setTab(nextTab: Tab) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('tab', nextTab);
      return next;
    });
  }
  function openMailboxConversations(mailboxId: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('tab', 'conversations');
      next.set('mailboxId', mailboxId);
      return next;
    });
  }
  const [state, setState] = useState<OutreachState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mailboxEditor, setMailboxEditor] = useState<{ value: OutreachMailbox | null } | null>(
    null,
  );
  const [signatureEditor, setSignatureEditor] = useState<OutreachMailbox | null>(null);
  const [campaignEditor, setCampaignEditor] = useState<{ value: OutreachCampaign | null } | null>(
    null,
  );
  const [cancelTarget, setCancelTarget] = useState<OutreachCampaign | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testMailboxes, setTestMailboxes] = useState<OutreachMailbox[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewChecked, setReviewChecked] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OutreachCampaignDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [deliveryPreview, setDeliveryPreview] = useState<OutreachDelivery | null>(null);
  const [suppressionTarget, setSuppressionTarget] = useState<OutreachDelivery | null>(null);
  const [suppressionReason, setSuppressionReason] = useState('人工标记不再联系');
  const [query, setQuery] = useState('');
  const [recordStatus, setRecordStatus] = useState('all');
  const [recordCampaign, setRecordCampaign] = useState('all');
  const [recordPage, setRecordPage] = useState(1);
  const [recordPageSize, setRecordPageSize] = useState(20);
  const [recordResult, setRecordResult] = useState<{
    key: string;
    data: OutreachDeliveryPage;
  } | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const recordKey = new URLSearchParams({
    page: String(recordPage),
    pageSize: String(recordPageSize),
    campaignId: recordCampaign,
    status: recordStatus,
    q: query.trim(),
  }).toString();
  const request = useRef(0);
  const detailRequest = useRef(0);
  const internalTestKey = useRef<string | null>(null);

  useEffect(() => {
    if (tab !== 'deliveries') return;
    let active = true;
    const controller = new AbortController();
    setRecordsLoading(true);
    setRecordError(null);
    void outreachApi<OutreachDeliveryPage>(`/deliveries?${recordKey}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (active) setRecordResult({ key: recordKey, data });
      })
      .catch((reason: unknown) => {
        if (active) setRecordError(message(reason));
      })
      .finally(() => {
        if (active) setRecordsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [tab, recordKey, state]);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    const result = await outreachApi<OutreachState>('/state');
    if (current === request.current) setState(result);
  }, []);
  const refreshDetail = useCallback(async (id: string) => {
    const current = ++detailRequest.current;
    try {
      const result = await outreachApi<OutreachCampaignDetail>(pathFor('campaigns', id));
      if (current === detailRequest.current) {
        setDetail(result);
        setDetailError(null);
      }
    } catch (reason) {
      if (current === detailRequest.current) setDetailError(message(reason));
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh()
      .catch((reason: unknown) => setError(message(reason)))
      .finally(() => setLoading(false));
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh().catch((reason: unknown) => setError(message(reason)));
    }, 10000);
    return () => {
      window.clearInterval(interval);
      request.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setSampleId(null);
    if (detailId) void refreshDetail(detailId);
    const interval = detailId
      ? window.setInterval(() => {
          if (!document.hidden) void refreshDetail(detailId);
        }, 5000)
      : null;
    return () => {
      if (interval) window.clearInterval(interval);
      detailRequest.current += 1;
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
  async function saveMailbox(input: MailboxInput) {
    await outreachApi(
      mailboxEditor?.value ? pathFor('mailboxes', mailboxEditor.value.id) : '/mailboxes',
      { method: mailboxEditor?.value ? 'PUT' : 'POST', body: JSON.stringify(input) },
    );
    await refresh();
    setNotice('邮箱设置已保存，请验证连接。');
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
  const campaigns = state?.campaigns || [];
  const deliveries = state?.deliveries || [];
  const products = state?.products || [];
  const connected = mailboxes.filter(
    (mailbox) => mailbox.configured && mailbox.smtpStatus === 'connected' && !mailbox.paused,
  );
  const testRingChanged =
    JSON.stringify(testMailboxes.map((mailbox) => [mailbox.id, mailbox.email])) !==
    JSON.stringify(connected.map((mailbox) => [mailbox.id, mailbox.email]));
  const recordData = recordResult?.key === recordKey ? recordResult.data : null;
  const paginationData = recordData || recordResult?.data;
  const visibleRecords = recordData?.items || [];
  const shownDetail = detail?.campaign.id === detailId ? detail : null;
  const sample =
    shownDetail?.deliveries.find((delivery) => delivery.id === sampleId) ||
    shownDetail?.deliveries.find((delivery) => delivery.status === 'draft') ||
    shownDetail?.deliveries.find((delivery) => delivery.status !== 'cancelled') ||
    shownDetail?.deliveries[0];
  const needsReview = state?.review.internalTestPassed && !state.review.productionApproved;
  const currentDeliveryPreview = deliveryPreview
    ? deliveries.find((delivery) => delivery.id === deliveryPreview.id) || deliveryPreview
    : null;

  return (
    <div className="outreach-page">
      <PageHeading
        eyebrow="COMMUNICATION CENTER"
        title="沟通中心"
        description="查看邮箱往来，按客户实际情况匹配产品和发件邮箱，管理首封开发计划。"
      >
        <button
          className="btn secondary"
          disabled={!!busy || loading}
          onClick={() => {
            setError(null);
            setLoading(true);
            void refresh()
              .catch((reason: unknown) => setError(message(reason)))
              .finally(() => setLoading(false));
          }}
        >
          <RefreshCw size={15} className={loading ? 'outreach-spin' : ''} />
          刷新
        </button>
        {tab !== 'conversations' && (
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
      </PageHeading>
      <InlineError value={error} />
      {notice && (
        <div className="outreach-alert success" role="status">
          <CheckCircle2 size={17} />
          <span>{notice}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            <X size={15} />
          </button>
        </div>
      )}
      <div className="outreach-tabs" role="tablist" aria-label="沟通中心栏目">
        {(
          [
            { id: 'mailboxes', label: '邮箱管理', icon: Mail, count: mailboxes.length },
            { id: 'campaigns', label: '触达计划', icon: Send, count: campaigns.length },
            { id: 'deliveries', label: '发送记录', icon: Inbox, count: deliveries.length },
            { id: 'conversations', label: '邮件会话', icon: MessageSquare, count: null },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`outreach-panel-${item.id}`}
            id={`outreach-tab-${item.id}`}
            className={tab === item.id ? 'selected' : ''}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={17} />
            {item.label}
            {item.count !== null && <span>{item.count}</span>}
          </button>
        ))}
      </div>
      {!state && loading ? (
        <div className="outreach-loading">
          <LoaderCircle size={22} className="outreach-spin" />
          正在读取邮箱和计划…
        </div>
      ) : (
        state && (
          <div role="tabpanel" id={`outreach-panel-${tab}`} aria-labelledby={`outreach-tab-${tab}`}>
            {tab === 'conversations' && (
              <MailConversations
                mailboxes={mailboxes}
                mailboxId={conversationMailboxId}
                onMailboxChange={openMailboxConversations}
              />
            )}
            {tab === 'campaigns' && (
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
                      label: '服务商已接受',
                      value: deliveries.filter((item) => item.status === 'accepted').length,
                      detail: '含公司试发 · 提交结果',
                      icon: CheckCircle2,
                    },
                    {
                      label: '待发送',
                      value: deliveries.filter((item) =>
                        ['queued', 'sending'].includes(item.status),
                      ).length,
                      detail: '按计划节奏执行',
                      icon: Clock3,
                    },
                    {
                      label: '待处理',
                      value: deliveries.filter((item) =>
                        ['blocked', 'failed', 'unknown'].includes(item.status),
                      ).length,
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
                    <h3>
                      {state.review.productionApproved
                        ? '公司试发已检查，正式计划可独立启用'
                        : needsReview
                          ? '公司试发已完成，等待检查邮件效果'
                          : '先通过公司邮箱检查发送链路'}
                    </h3>
                    <p>
                      {needsReview
                        ? '在公司邮箱查看实际收到的测试信，再确认是否进入正式计划。'
                        : '测试邮件仅发送到已配置的公司邮箱，使用带标记的固定测试内容。'}
                    </p>
                  </div>
                  <div className="outreach-strip-actions">
                    {needsReview && (
                      <button
                        className="btn primary"
                        onClick={() => {
                          setReviewChecked(false);
                          setReviewOpen(true);
                        }}
                      >
                        检查试发结果
                        <ChevronRight size={15} />
                      </button>
                    )}
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
                    <p>确认客户范围与样稿，启动后按规则自动执行。</p>
                  </div>
                  <span>
                    {campaigns.filter((item) => item.status === 'active').length} 个运行中
                  </span>
                </div>
                {campaigns.length ? (
                  <div className="outreach-campaign-list">
                    {campaigns.map((campaign) => (
                      <section className="panel outreach-campaign" key={campaign.id}>
                        <div className="outreach-card-heading">
                          <span
                            className={`outreach-campaign-icon ${campaign.mode === 'internal_test' ? 'test' : ''}`}
                          >
                            <Send size={21} />
                          </span>
                          <div>
                            <h3>{campaign.name}</h3>
                            <p>
                              {campaign.mode === 'internal_test' ? '公司内部试发' : '首次邮件开发'}
                              <span>·</span>
                              {formatTime(campaign.createdAt)}
                            </p>
                          </div>
                          <Badge tone={tone(campaign.status)}>{statusLabel(campaign.status)}</Badge>
                        </div>
                        <div className="outreach-campaign-progress">
                          <div>
                            <strong>
                              {campaign.stats?.accepted || 0}
                              <small> / {campaign.targetCount}</small>
                            </strong>
                            <span>服务商已接受 / 目标</span>
                          </div>
                          <div className="outreach-progress-track">
                            <span
                              style={{
                                width: `${Math.min(100, ((campaign.stats?.accepted || 0) / Math.max(1, campaign.targetCount)) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                        <div className="outreach-campaign-meta">
                          <span>
                            <Mail size={14} />
                            {campaign.mailboxIds.length} 个邮箱
                          </span>
                          <span>
                            <Clock3 size={14} />
                            {campaign.continuous ? '持续加入新客户' : '固定客户批次'}
                          </span>
                          <span>
                            {campaign.mode === 'internal_test'
                              ? '仅公司自有邮箱'
                              : campaign.includeExisting
                                ? '含现有未开发客户'
                                : '仅新增客户'}
                          </span>
                        </div>
                        <div className="outreach-campaign-stats">
                          <span>
                            待发送 <b>{campaign.stats?.queued || 0}</b>
                          </span>
                          <span>
                            失败 <b>{campaign.stats?.failed || 0}</b>
                          </span>
                          <span>
                            待核实 <b>{campaign.stats?.unknown || 0}</b>
                          </span>
                          <span>
                            待处理 <b>{campaign.stats?.blocked || 0}</b>
                          </span>
                        </div>
                        {campaign.lastError && (
                          <div className="outreach-alert error">{campaign.lastError}</div>
                        )}
                        <div className="outreach-card-actions">
                          <button
                            className="btn secondary"
                            disabled={!!busy}
                            onClick={() => setDetailId(campaign.id)}
                          >
                            <Eye size={15} />
                            样稿与详情
                          </button>
                          {campaign.mode === 'production' &&
                            campaign.status !== 'active' &&
                            campaign.status !== 'preparing' &&
                            canCancelCampaign(campaign) && (
                              <button
                                className="btn subtle"
                                disabled={!!busy}
                                onClick={() => setCampaignEditor({ value: campaign })}
                              >
                                <Settings2 size={15} />
                                编辑
                              </button>
                            )}
                          {campaign.status === 'active' && (
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
                            <button
                              className="btn danger"
                              disabled={!!busy}
                              onClick={() => confirmCancellation(campaign)}
                            >
                              <X size={15} />
                              取消计划
                            </button>
                          )}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <section className="panel">
                    <Empty
                      title="建立第一个触达计划"
                      detail="选择客户范围、产品和对应邮箱，系统会准备个性化首封邮件。"
                    />
                    <div className="outreach-empty-action">
                      <button
                        className="btn primary"
                        onClick={() => setCampaignEditor({ value: null })}
                      >
                        <Plus size={16} />
                        新建触达计划
                      </button>
                    </div>
                  </section>
                )}
              </>
            )}
            {tab === 'mailboxes' && (
              <>
                <div className="outreach-section-heading">
                  <div>
                    <h2>发件邮箱与负责产品</h2>
                    <p>客户产品决定发件身份；仅在负责同一产品的邮箱之间按可用额度安排发送。</p>
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
                {mailboxes.length ? (
                  <div className="outreach-mailbox-grid">
                    {mailboxes.map((mailbox, index) => (
                      <section className="panel outreach-mailbox-card" key={mailbox.id}>
                        <div className="outreach-card-heading">
                          <span className={`outreach-brand-mark mark-${index % 3}`}>
                            <Mail size={23} />
                          </span>
                          <div>
                            <h3>{mailbox.email}</h3>
                            <p>业务员：{mailbox.displayName || '待设置'}</p>
                          </div>
                          <Badge tone={mailbox.paused ? 'amber' : tone(mailbox.smtpStatus)}>
                            {mailbox.paused
                              ? '已暂停'
                              : mailbox.configured
                                ? statusLabel(mailbox.smtpStatus)
                                : '待配置密码'}
                          </Badge>
                        </div>
                        <div className="outreach-mailbox-coverage">
                          <span>负责产品</span>
                          <div className="outreach-product-tags">
                            {mailbox.productIds?.length ? (
                              mailbox.productIds.map((id) => {
                                const product = products.find((item) => item.id === id);
                                return (
                                  <span key={id}>
                                    {product ? productName(product) : `未找到产品（${id}）`}
                                    {product && !productApproved(product) ? ' · 待审核' : ''}
                                  </span>
                                );
                              })
                            ) : (
                              <span className="outreach-tag-empty">
                                尚未配置，请在邮箱设置中选择
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="outreach-mailbox-signature">
                          <span>邮件签名</span>
                          {mailbox.signature ? (
                            <div
                              className="mail-signature-card-preview"
                              dangerouslySetInnerHTML={{
                                __html: renderMailboxSignature(mailbox).html,
                              }}
                            />
                          ) : (
                            <p>尚未填写；请点击编辑签名完善。</p>
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
                        {mailbox.lastError && (
                          <div className="outreach-alert error">{mailbox.lastError}</div>
                        )}
                        <p className="outreach-last-check">
                          最近验证 {formatTime(mailbox.lastCheckedAt)}
                        </p>
                        <div className="outreach-card-actions">
                          <button
                            className="btn secondary"
                            disabled={!!busy}
                            onClick={() => setSignatureEditor(mailbox)}
                          >
                            <FileText size={15} />
                            编辑签名
                          </button>
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
                            onClick={() => setMailboxEditor({ value: mailbox })}
                          >
                            <Settings2 size={15} />
                            配置
                          </button>
                          <button
                            className="btn subtle"
                            disabled={!!busy || !mailbox.configured}
                            onClick={() =>
                              void act(
                                `verify-${mailbox.id}`,
                                pathFor('mailboxes', mailbox.id, 'verify'),
                                {},
                                '邮箱连接检查已完成。',
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
            {tab === 'deliveries' && (
              <>
                <div className="outreach-section-heading">
                  <div>
                    <h2>每封邮件的发送记录</h2>
                    <p>
                      包含待审核、待发送及已取消记录；记录条数不等于实际发送数。服务商已接受表示已接收发送请求，不代表客户已收信或阅读。
                    </p>
                  </div>
                  <span>{recordData ? `${recordData.total} 条记录` : '正在读取…'}</span>
                </div>
                <section className="panel outreach-records">
                  <div className="outreach-record-toolbar">
                    <label className="outreach-search">
                      <Search size={17} />
                      <input
                        aria-label="搜索发送记录"
                        placeholder="搜索公司、邮箱或主题"
                        value={query}
                        onChange={(event) => {
                          setQuery(event.target.value);
                          setRecordPage(1);
                        }}
                      />
                    </label>
                    <select
                      aria-label="按计划筛选"
                      value={recordCampaign}
                      onChange={(event) => {
                        setRecordCampaign(event.target.value);
                        setRecordPage(1);
                      }}
                    >
                      <option value="all">全部计划</option>
                      {campaigns.map((campaign) => (
                        <option key={campaign.id} value={campaign.id}>
                          {campaign.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="按发送状态筛选"
                      value={recordStatus}
                      onChange={(event) => {
                        setRecordStatus(event.target.value);
                        setRecordPage(1);
                      }}
                    >
                      <option value="all">全部状态</option>
                      {[
                        'draft',
                        'queued',
                        'sending',
                        'accepted',
                        'failed',
                        'unknown',
                        'blocked',
                        'cancelled',
                      ].map((status) => (
                        <option value={status} key={status}>
                          {statusLabel(status)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <InlineError value={recordError} />
                  {paginationData && (
                    <nav
                      className="outreach-record-pagination"
                      aria-label="发送记录分页"
                      aria-busy={recordsLoading || !recordData}
                    >
                      <span aria-live="polite">
                        共 {paginationData.total} 条 · 第{' '}
                        {paginationData.total
                          ? (paginationData.page - 1) * paginationData.pageSize + 1
                          : 0}
                        –
                        {Math.min(
                          paginationData.page * paginationData.pageSize,
                          paginationData.total,
                        )}{' '}
                        条
                      </span>
                      <label>
                        每页
                        <select
                          aria-label="每页发送记录条数"
                          value={recordPageSize}
                          onChange={(event) => {
                            setRecordPageSize(Number(event.target.value));
                            setRecordPage(1);
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
                          disabled={recordsLoading || !recordData || paginationData.page <= 1}
                          onClick={() => setRecordPage(paginationData.page - 1)}
                        >
                          上一页
                        </button>
                        <span>
                          第 {paginationData.page} / {paginationData.totalPages} 页
                        </span>
                        <button
                          className="btn secondary"
                          disabled={
                            recordsLoading ||
                            !recordData ||
                            paginationData.page >= paginationData.totalPages
                          }
                          onClick={() => setRecordPage(paginationData.page + 1)}
                        >
                          下一页
                        </button>
                      </div>
                    </nav>
                  )}
                  {!recordData ? (
                    <div className="outreach-loading" role="status">
                      {recordError ? '发送记录读取失败，请点击刷新重试。' : '正在读取发送记录…'}
                    </div>
                  ) : visibleRecords.length ? (
                    <div className="outreach-table-wrap">
                      <table className="outreach-table">
                        <thead>
                          <tr>
                            <th>客户与收件邮箱</th>
                            <th>发件邮箱</th>
                            <th>主题</th>
                            <th>状态</th>
                            <th>发送 / 创建时间</th>
                            <th>
                              <span className="outreach-sr-only">详情</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleRecords.map((delivery) => (
                            <tr key={delivery.id}>
                              <td>
                                <strong>{delivery.companyName || '公司自有测试邮箱'}</strong>
                                <small>{delivery.to}</small>
                              </td>
                              <td>{delivery.from || '待分配'}</td>
                              <td className="outreach-subject-cell">
                                {delivery.subject || '尚未生成'}
                                {delivery.reason && <small>{delivery.reason}</small>}
                              </td>
                              <td>
                                <Badge tone={tone(delivery.status)}>
                                  {statusLabel(delivery.status)}
                                </Badge>
                                {delivery.mode === 'internal_test' &&
                                  delivery.receivedVerifiedAt && (
                                    <small className="outreach-receipt-verified">
                                      已核对测试收件
                                    </small>
                                  )}
                                {delivery.recordError && <small>{delivery.recordError}</small>}
                              </td>
                              <td className="outreach-time-cell">
                                {formatTime(delivery.sentAt || delivery.createdAt)}
                              </td>
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={`查看 ${delivery.companyName || delivery.to} 的邮件`}
                                  onClick={() => setDeliveryPreview(delivery)}
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
                      title={
                        query.trim() || recordStatus !== 'all' || recordCampaign !== 'all'
                          ? '没有符合筛选条件的记录'
                          : '暂无发送记录'
                      }
                      detail={
                        query.trim() || recordStatus !== 'all' || recordCampaign !== 'all'
                          ? '请调整搜索词、计划或发送状态。'
                          : '准备计划样稿或进行公司邮箱试发后，邮件会显示在这里。'
                      }
                    />
                  )}
                </section>
              </>
            )}
          </div>
        )
      )}
      {mailboxEditor && (
        <MailboxEditor
          mailbox={mailboxEditor.value}
          products={products}
          onClose={() => setMailboxEditor(null)}
          onSave={saveMailbox}
        />
      )}
      {signatureEditor && (
        <MailboxSignatureEditor
          mailbox={signatureEditor}
          onClose={() => setSignatureEditor(null)}
          onSave={async (input) => {
            await outreachApi(pathFor('mailboxes', signatureEditor.id), {
              method: 'PUT',
              body: JSON.stringify(input),
            });
            await refresh();
            setNotice('业务员与签名已保存，待发送样稿请重新准备并核对。');
          }}
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
            setNotice('邮箱已导入，请配置负责产品、完善签名并验证连接。');
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
              <div className="outreach-loading">
                <LoaderCircle className="outreach-spin" size={20} />
                正在读取计划…
              </div>
            ) : (
              <>
                <div className="outreach-detail-summary">
                  <Badge tone={tone(shownDetail.campaign.status)}>
                    {statusLabel(shownDetail.campaign.status)}
                  </Badge>
                  <span>目标 {shownDetail.campaign.targetCount} 封</span>
                  <span>版本 {shownDetail.campaign.revision}</span>
                  {shownDetail.campaign.status !== 'cancelled' && (
                    <span>
                      {shownDetail.campaign.approvedRevision === shownDetail.campaign.revision
                        ? '当前版本已审核'
                        : '当前版本待审核'}
                    </span>
                  )}
                </div>
                <InlineError value={shownDetail.campaign.lastError || null} />
                {shownDetail.campaign.status === 'cancelled' && (
                  <p className="outreach-hint" role="status">
                    此计划已取消
                    {shownDetail.campaign.cancelledAt
                      ? `（${formatTime(shownDetail.campaign.cancelledAt)}）`
                      : ''}
                    ，不会继续准备邮件或安排发送。已提交的邮件及其实际结果保留，可在发送记录中查看。
                  </p>
                )}
                {shownDetail.campaign.mode === 'production' && (
                  <>
                    {canCancelCampaign(shownDetail.campaign) && (
                      <p className="outreach-hint">
                        检查客户范围、产品与发件邮箱的对应关系和邮件样稿。批准当前计划后，系统按相同规则生成首封邮件，使用负责对应产品的邮箱发送。
                      </p>
                    )}
                    <details className="outreach-plan-rules" open>
                      <summary>本次计划的客户范围与产品内容</summary>
                      <dl>
                        <div>
                          <dt>市场</dt>
                          <dd>{shownDetail.campaign.filters?.markets.join('、') || '全部市场'}</dd>
                        </div>
                        <div>
                          <dt>评级</dt>
                          <dd>
                            {shownDetail.campaign.filters?.grades.join('、') ||
                              '不限制评级，仍须具备匹配与联系依据'}
                          </dd>
                        </div>
                        <div>
                          <dt>产品品类</dt>
                          <dd>
                            {shownDetail.campaign.filters?.categories?.length
                              ? shownDetail.campaign.filters.categories
                                  .map(
                                    (id) =>
                                      productCategories.find((category) => category.id === id)
                                        ?.label || id,
                                  )
                                  .join('、')
                              : '在所选邮箱负责的产品范围内按客户情况匹配'}
                          </dd>
                        </div>
                        <div>
                          <dt>客户来源</dt>
                          <dd>
                            {shownDetail.campaign.includeExisting
                              ? '包含现有未开发客户'
                              : '仅计划创建后新增客户'}
                            {shownDetail.campaign.continuous
                              ? '；持续加入符合条件的新客户'
                              : '；固定批次'}
                          </dd>
                        </div>
                        <div>
                          <dt>发件邮箱</dt>
                          <dd>
                            {shownDetail.campaign.mailboxIds
                              .map(
                                (id) => mailboxes.find((mailbox) => mailbox.id === id)?.email || id,
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
                            间隔 {shownDetail.campaign.intervalSeconds} 秒，同时遵守各邮箱每日上限
                          </dd>
                        </div>
                      </dl>
                      {(shownDetail.campaign.outreachClaims || []).map((claim) => (
                        <div className="outreach-approved-claim" key={claim.productId}>
                          <strong>
                            {products.find((product) => product.id === claim.productId)?.name ||
                              claim.productId}
                            <small>版本 {claim.productVersion}</small>
                          </strong>
                          <p>{claim.text}</p>
                        </div>
                      ))}
                      {!shownDetail.campaign.outreachClaims?.length && (
                        <p className="outreach-hint">尚未填写可用于首次开发信的产品内容。</p>
                      )}
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
                          <span>{delivery.subject || '尚未生成'}</span>
                          <small>{statusLabel(delivery.status)}</small>
                        </button>
                      ))}
                    </div>
                    {sample && (
                      <MessagePreview
                        delivery={sample}
                        onSuppress={(delivery) => {
                          setSuppressionReason('人工标记不再联系');
                          setSuppressionTarget(delivery);
                        }}
                      />
                    )}
                  </div>
                ) : (
                  <Empty
                    title="还没有邮件样稿"
                    detail={
                      shownDetail.campaign.status === 'cancelled'
                        ? '此计划已取消，不会再生成样稿或发送邮件。'
                        : '点击准备样稿，系统会检查客户范围、匹配邮箱并生成首封邮件。此步骤不会发信。'
                    }
                  />
                )}
                <div className="outreach-detail-actions">
                  {shownDetail.campaign.mode === 'production' &&
                    canCancelCampaign(shownDetail.campaign) && (
                      <>
                        <button
                          className="btn secondary"
                          disabled={
                            !!busy ||
                            shownDetail.campaign.status === 'active' ||
                            shownDetail.campaign.status === 'preparing' ||
                            !state?.readiness.generatorConfigured
                          }
                          onClick={() =>
                            void act(
                              'prepare',
                              pathFor('campaigns', shownDetail.campaign.id, 'prepare'),
                              {},
                              '正在准备样稿，完成后可检查。',
                            )
                          }
                        >
                          <BusyIcon busy={busy === 'prepare'}>
                            <FileText size={15} />
                          </BusyIcon>
                          {busy === 'prepare' || shownDetail.campaign.status === 'preparing'
                            ? '正在准备样稿…'
                            : '准备样稿'}
                        </button>
                        {shownDetail.campaign.approvedRevision !==
                          shownDetail.campaign.revision && (
                          <button
                            className="btn secondary"
                            disabled={
                              !!busy ||
                              shownDetail.campaign.status !== 'ready' ||
                              !shownDetail.deliveries.some(
                                (delivery) =>
                                  delivery.status === 'draft' &&
                                  delivery.subject &&
                                  delivery.bodyText &&
                                  !['blocked', 'failed', 'unknown', 'cancelled'].includes(
                                    delivery.status,
                                  ),
                              )
                            }
                            onClick={() =>
                              void act(
                                'approve',
                                pathFor('campaigns', shownDetail.campaign.id, 'approve'),
                                { revision: shownDetail.campaign.revision },
                                '当前计划版本已审核，尚未启动发送。',
                              )
                            }
                          >
                            <Check size={15} />
                            批准此版本与样稿
                          </button>
                        )}
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
                              !['ready', 'paused'].includes(shownDetail.campaign.status) ||
                              shownDetail.campaign.approvedRevision !==
                                shownDetail.campaign.revision ||
                              !state?.review.productionApproved
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
                            {shownDetail.campaign.status === 'paused' ? '恢复计划' : '启动自动发送'}
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
                {shownDetail.campaign.mode === 'production' &&
                  canCancelCampaign(shownDetail.campaign) &&
                  !state?.review.productionApproved && (
                    <p className="outreach-hint">公司试发结果检查完成后，才能启动正式计划。</p>
                  )}
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
      {currentDeliveryPreview && (
        <Modal wide title="邮件详情" onClose={() => setDeliveryPreview(null)}>
          <div className="modal-body">
            <MessagePreview
              delivery={currentDeliveryPreview}
              onSuppress={(delivery) => {
                setSuppressionReason('人工标记不再联系');
                setSuppressionTarget(delivery);
              }}
            />
          </div>
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
            <p>将发送 {testMailboxes.length} 封带测试标记的固定测试信，确认各邮箱的发送链路。</p>
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
              <div className="outreach-alert">邮箱列表已变化，请关闭此窗口后重新确认试发对象。</div>
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
                    '公司试发已创建，请查看发送记录和实际测试邮件。',
                    'POST',
                    {
                      'Idempotency-Key':
                        internalTestKey.current || (internalTestKey.current = crypto.randomUUID()),
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
      {reviewOpen && (
        <Modal
          title="检查公司试发结果"
          onClose={() => {
            if (!busy) setReviewOpen(false);
          }}
        >
          <div className="modal-body outreach-form">
            <p>请在公司邮箱中确认实际收到的测试信，检查发件地址、显示名称与邮件内容。</p>
            <label className="outreach-review-check">
              <input
                type="checkbox"
                checked={reviewChecked}
                onChange={(event) => setReviewChecked(event.target.checked)}
              />
              <span>我已检查测试邮件，允许准备正式计划。</span>
            </label>
            <p className="outreach-hint">正式计划仍需要检查样稿并单独点击启动。</p>
            <InlineError value={error} />
            <div className="modal-actions">
              <button
                className="btn secondary"
                disabled={!!busy}
                onClick={() => setReviewOpen(false)}
              >
                稍后检查
              </button>
              <button
                className="btn primary"
                disabled={!!busy || !reviewChecked || !state?.review.internalTestPassed}
                onClick={() => {
                  void act(
                    'review',
                    '/review',
                    { approved: true },
                    '试发检查已确认。正式计划可审核后单独启动。',
                  ).then((ok) => {
                    if (ok) setReviewOpen(false);
                  });
                }}
              >
                <CheckCircle2 size={15} />
                确认检查结果
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
