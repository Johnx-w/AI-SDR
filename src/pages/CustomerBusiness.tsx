import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { Badge, Empty, Modal } from '../components/ui';
import { BusinessRequestError, customerBusinessApi } from '../services/customerBusiness';
import type {
  BusinessChannel,
  BusinessConversation,
  BusinessDemand,
  BusinessEntity,
  BusinessMessage,
  BusinessPreflight,
  BusinessSaveResult,
  BusinessTask,
  BusinessWorkspace,
} from '../services/customerBusiness';
import './CustomerBusiness.css';

type Tab = 'demands' | 'messages' | 'tasks';
type FormValue = Record<string, string | string[] | boolean>;
type Action = 'complete' | 'pause' | 'resume' | 'cancel';
interface Editor {
  entity: BusinessEntity | 'action' | 'message-links';
  value: FormValue;
  id?: string;
  version?: number;
  key: string;
  task?: BusinessTask;
  message?: BusinessMessage;
}
const channels: Record<BusinessChannel, string> = {
  email: '邮件',
  whatsapp: 'WhatsApp',
  form: '网站留言',
  phone: '电话',
  other: '其他',
};
const categories = {
  ventilation: '透气窗',
  shutters: '百叶窗',
  indoor: '室内成品帘',
  outdoor: '户外遮阳',
  other: '其他',
};
const directions = { finished: '成品', materials: '材料配件', samples: '样本展示' };
const stages = {
  new: '新需求',
  clarifying: '确认规格',
  quoting: '报价中',
  sampling: '样品中',
  negotiating: '商务沟通',
  won: '已成交',
  lost: '未成交',
  closed: '已关闭',
};
const taskStates = {
  pending: '待执行',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
};
const taskKinds = {
  first_contact: '首次联系',
  clarify_specs: '补问规格',
  quote_followup: '报价跟进',
  sample: '样品推进',
  manual_review: '人工审核',
  other: '其他行动',
};
const ownership = { auto: '自动接待', human: '人工接管' };
const delivery = {
  received: '已收到',
  sent: '已发送',
  failed: '失败',
  unknown: '结果未知',
  recorded: '已记载',
};
const classifications = {
  normal: '正常沟通',
  auto_reply: '自动回复',
  unsubscribe: '拒绝联系',
  hard_bounce: '永久退信',
  complaint: '投诉',
};
const actionLabels: Record<Action, string> = {
  complete: '记录完成结果',
  pause: '暂停任务',
  resume: '恢复任务',
  cancel: '取消任务',
};
const tabLabels: Record<Tab, string> = {
  demands: '采购需求 T1',
  messages: '沟通记录 T3',
  tasks: '跟进任务 T4',
};
const emptyWorkspace: BusinessWorkspace = {
  customers: [],
  products: [],
  conversations: [],
  messages: [],
  demands: [],
  tasks: [],
  customerContexts: [],
};
const text = (value: FormValue, key: string) =>
  typeof value[key] === 'string' ? (value[key] as string) : '';
const list = (value: FormValue, key: string) =>
  Array.isArray(value[key]) ? (value[key] as string[]) : [];
const formFields = (value?: object): FormValue =>
  Object.fromEntries(
    Object.entries(value || {}).filter(
      ([, field]) =>
        typeof field === 'string' ||
        typeof field === 'boolean' ||
        (Array.isArray(field) && field.every((item) => typeof item === 'string')),
    ),
  );
const demandSource = (message: BusinessMessage) =>
  message.classification === 'normal' &&
  ((message.direction === 'inbound' && message.deliveryStatus === 'received') ||
    (message.direction === 'note' &&
      message.channel === 'phone' &&
      message.deliveryStatus === 'recorded' &&
      message.actualConfirmed === true));
const communicationTask = (task: BusinessTask) =>
  ['first_contact', 'clarify_specs', 'quote_followup'].includes(task.kind);
const linkToCustomer = (id: string) => `/leads?dataset=real&lead=${encodeURIComponent(id)}`;
const dateText = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : '未记录';
function inputDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(value))
    .replace(' ', 'T');
}
function isoDate(value: string) {
  if (!value) return '';
  const date = new Date(value + '+08:00');
  if (!Number.isFinite(date.getTime())) throw new Error('请填写有效的北京时间');
  return date.toISOString();
}
function safeHref(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
function MultiChoice({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div className="business-field business-full">
      <span>{label}</span>
      <div className="business-choices">
        {options.length ? (
          options.map((option) => (
            <label key={option.id}>
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.id]
                      : selected.filter((id) => id !== option.id),
                  )
                }
              />
              <span>{option.label}</span>
            </label>
          ))
        ) : (
          <small>暂无可关联记录，可稍后补充。</small>
        )}
      </div>
    </div>
  );
}

export function CustomerBusiness() {
  const [params, setParams] = useSearchParams();
  const customerId = params.get('customerId') || '';
  const productId = params.get('productId') || '';
  const tab: Tab = ['demands', 'messages', 'tasks'].includes(params.get('tab') || '')
    ? (params.get('tab') as Tab)
    : 'demands';
  const [data, setData] = useState<BusinessWorkspace>(emptyWorkspace);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [state, setState] = useState('all');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [formError, setFormError] = useState('');
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [selectedQuote, setSelectedQuote] = useState('');
  const [check, setCheck] = useState<{ task: BusinessTask; result: BusinessPreflight } | null>(
    null,
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        setData(await customerBusinessApi.workspace({ customerId, productId }, signal));
      } catch (cause) {
        if (!signal?.aborted) setError(cause instanceof Error ? cause.message : '无法读取客户业务');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [customerId, productId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    setState('all');
  }, [tab]);
  const customerName = (id: string) =>
    data.customers.find((customer) => customer.id === id)?.name || id;
  const conversationName = (id?: string) =>
    data.conversations.find((conversation) => conversation.id === id)?.title || '未关联会话';
  const productName = (id: string) =>
    data.products.find((product) => product.id === id)?.name || id;
  const productWarning = (id: string, versions?: Record<string, number>) => {
    const product = data.products.find((item) => item.id === id);
    if (!product) return '资料待核对';
    if (product.status !== 'approved')
      return product.status === 'archived' ? '资料已归档' : '资料待审核';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
      new Date(),
    );
    if (product.effectiveDate && product.effectiveDate > today) return '资料尚未生效';
    return versions && versions[id] !== product.version ? '资料版本已更新，需核对' : '';
  };
  const term = query.trim().toLowerCase();
  const matches = (values: string[]) => !term || values.join(' ').toLowerCase().includes(term);
  const demands = data.demands.filter(
    (demand) =>
      (state === 'all' || demand.stage === state) &&
      matches([
        demand.title,
        demand.productText,
        demand.evidenceQuote,
        customerName(demand.customerId),
      ]),
  );
  const messages = data.messages
    .filter(
      (message) =>
        (state === 'all' || message.direction === state) &&
        matches([
          message.subject,
          message.body,
          message.from,
          message.to,
          customerName(message.customerId),
        ]),
    )
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const tasks = data.tasks
    .filter(
      (task) =>
        (state === 'all' || task.status === state) &&
        matches([task.title, task.owner, task.notes, customerName(task.customerId)]),
    )
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const selectedCustomer = data.customers.find((customer) => customer.id === customerId);
  const selectedContext = data.customerContexts.find(
    (context) => context.customerId === customerId,
  );

  function filter(key: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }
  function newEditor(
    entity: BusinessEntity,
    record?: BusinessConversation | BusinessDemand | BusinessTask,
    seed: FormValue = {},
  ) {
    const baseCustomer = record?.customerId || customerId || '';
    let value: FormValue;
    if (entity === 'conversations') {
      const conversation = record as BusinessConversation | undefined;
      value = {
        customerId: baseCustomer,
        title: '',
        channel: 'email',
        account:
          data.customerContexts.find((context) => context.customerId === baseCustomer)
            ?.fixedEmail || '',
        participant: '',
        ownership: 'human',
        owner: '',
        status: 'active',
        ...formFields(conversation),
        ...seed,
      };
    } else if (entity === 'messages') {
      value = {
        customerId: baseCustomer,
        conversationId: '',
        channel: 'email',
        direction: 'inbound',
        subject: '',
        body: '',
        from: '',
        to: '',
        account: '',
        occurredAt: '',
        deliveryStatus: 'received',
        classification: 'normal',
        externalId: '',
        attachmentsText: '',
        demandIds: [],
        actualConfirmed: false,
        ...seed,
      };
    } else if (entity === 'demands') {
      const demand = record as BusinessDemand | undefined;
      value = {
        customerId: baseCustomer,
        sourceMessageId: '',
        conversationId: '',
        title: '',
        category: 'other',
        direction: 'finished',
        productText: '',
        productIds: productId ? [productId] : [],
        specifications: '',
        quantity: '',
        unit: '',
        stage: 'new',
        owner: '',
        ownership: 'human',
        evidenceQuote: '',
        ...formFields(demand),
        ...seed,
      };
    } else {
      const task = record as BusinessTask | undefined;
      value = {
        customerId: baseCustomer,
        conversationId: '',
        title: '',
        kind: 'other',
        executionMode: 'manual',
        channel: 'email',
        dueAt: '',
        status: 'pending',
        owner: '',
        notes: '',
        demandIds: [],
        messageIds: [],
        productIds: productId ? [productId] : [],
        basisMessageId: '',
        ...formFields(task),
        ...(task ? { dueAt: inputDate(task.dueAt) } : {}),
        ...seed,
      };
    }
    setEditor({
      entity,
      value,
      id: record?.id,
      version: record?.version,
      key: crypto.randomUUID(),
    });
    setFormError('');
    setRefreshRequired(false);
    setSelectedQuote('');
  }
  function change(key: string, value: string | string[] | boolean) {
    setEditor((current) => current && { ...current, value: { ...current.value, [key]: value } });
  }
  function chooseCustomer(id: string) {
    setEditor(
      (current) =>
        current && {
          ...current,
          value: {
            ...current.value,
            customerId: id,
            conversationId: '',
            sourceMessageId: '',
            demandIds: [],
            messageIds: [],
            basisMessageId: '',
            ...(current.entity === 'conversations' && text(current.value, 'channel') === 'email'
              ? {
                  account:
                    data.customerContexts.find((context) => context.customerId === id)
                      ?.fixedEmail || '',
                }
              : {}),
          },
        },
    );
  }
  function chooseConversation(id: string) {
    if (!editor) return;
    if (!id) {
      setEditor({
        ...editor,
        value: {
          ...editor.value,
          conversationId: '',
          account: '',
          from: '',
          to: '',
          demandIds: [],
          messageIds: [],
          basisMessageId: '',
        },
      });
      return;
    }
    const conversation = data.conversations.find((item) => item.id === id);
    if (!conversation) return;
    setEditor({
      ...editor,
      value: {
        ...editor.value,
        conversationId: id,
        customerId: conversation.customerId,
        channel: conversation.channel,
        account: conversation.account,
        from:
          text(editor.value, 'direction') === 'outbound'
            ? conversation.account
            : conversation.participant,
        to:
          text(editor.value, 'direction') === 'outbound'
            ? conversation.participant
            : conversation.account,
        demandIds: [],
        messageIds: [],
        basisMessageId: '',
      },
    });
  }
  function chooseSource(id: string) {
    if (!editor) return;
    if (!id) {
      setEditor({
        ...editor,
        value: { ...editor.value, sourceMessageId: '', conversationId: '', evidenceQuote: '' },
      });
      setSelectedQuote('');
      return;
    }
    const message = data.messages.find((item) => item.id === id);
    if (!message) return;
    setEditor({
      ...editor,
      value: {
        ...editor.value,
        sourceMessageId: id,
        customerId: message.customerId,
        conversationId: message.conversationId,
        title: text(editor.value, 'title') || message.subject,
        evidenceQuote: message.body.length <= 5000 ? message.body : '',
      },
    });
    setSelectedQuote('');
  }
  function fromMessage(message: BusinessMessage) {
    newEditor('demands', undefined, {
      customerId: message.customerId,
      conversationId: message.conversationId,
      sourceMessageId: message.id,
      title: message.subject,
      evidenceQuote: message.body.length <= 5000 ? message.body : '',
    });
  }
  function taskForDemand(demand: BusinessDemand) {
    newEditor('tasks', undefined, {
      customerId: demand.customerId,
      conversationId: demand.conversationId,
      demandIds: [demand.id],
      productIds: demand.productIds,
      messageIds: [demand.sourceMessageId],
      basisMessageId: demand.sourceMessageId,
      title: `推进：${demand.title}`,
      kind: 'clarify_specs',
      channel:
        data.conversations.find((item) => item.id === demand.conversationId)?.channel || 'email',
    });
  }
  function editMessageLinks(message: BusinessMessage) {
    setEditor({
      entity: 'message-links',
      id: message.id,
      version: message.version,
      key: crypto.randomUUID(),
      message,
      value: {
        customerId: message.customerId,
        conversationId: message.conversationId,
        demandIds: message.demandIds,
        notes: message.notes || '',
      },
    });
    setFormError('');
    setRefreshRequired(false);
  }
  function action(task: BusinessTask, kind: Action) {
    setEditor({
      entity: 'action',
      task,
      id: task.id,
      version: task.version,
      key: crypto.randomUUID(),
      value: { action: kind, notes: '', resultMessageId: '' },
    });
    setFormError('');
    setRefreshRequired(false);
  }
  function saved(result: BusinessSaveResult) {
    setNotice(
      result.feishu?.status === 'synced'
        ? '业务记录已保存并同步到飞书。'
        : result.feishu?.status === 'pending'
          ? `业务记录已保存，飞书同步待核对。${result.feishu.error || ''}`
          : '业务记录已保存。',
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || saving || refreshRequired) return;
    setSaving(true);
    setFormError('');
    try {
      const value = editor.value;
      const pick = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, value[key]]));
      let result: BusinessSaveResult;
      if (editor.entity === 'action')
        result = await customerBusinessApi.taskAction(editor.id!, {
          action: text(value, 'action') as Action,
          expectedVersion: editor.version!,
          notes: text(value, 'notes'),
          resultMessageId: text(value, 'resultMessageId') || undefined,
        });
      else if (editor.entity === 'message-links')
        result = await customerBusinessApi.save(
          'messages',
          { ...editor.message, demandIds: list(value, 'demandIds'), notes: text(value, 'notes') },
          { id: editor.id, version: editor.version, key: editor.key },
        );
      else {
        let payload: Record<string, unknown>;
        if (editor.entity === 'conversations')
          payload = pick(
            'customerId',
            'title',
            'channel',
            'account',
            'participant',
            'ownership',
            'owner',
            'status',
          );
        else if (editor.entity === 'messages')
          payload = {
            ...pick(
              'customerId',
              'conversationId',
              'channel',
              'direction',
              'subject',
              'body',
              'from',
              'to',
              'account',
              'deliveryStatus',
              'classification',
              'externalId',
              'demandIds',
              'actualConfirmed',
            ),
            occurredAt: isoDate(text(value, 'occurredAt')),
            attachments: text(value, 'attachmentsText')
              .split('\n')
              .map((item) => item.trim())
              .filter(Boolean),
            origin: 'manual',
          };
        else if (editor.entity === 'demands')
          payload = pick(
            'customerId',
            'conversationId',
            'sourceMessageId',
            'title',
            'category',
            'direction',
            'productText',
            'productIds',
            'specifications',
            'quantity',
            'unit',
            'stage',
            'owner',
            'ownership',
            'evidenceQuote',
          );
        else
          payload = {
            ...pick(
              'customerId',
              'conversationId',
              'title',
              'kind',
              'executionMode',
              'channel',
              'owner',
              'notes',
              'demandIds',
              'messageIds',
              'productIds',
              'basisMessageId',
            ),
            dueAt: isoDate(text(value, 'dueAt')),
            status: text(value, 'status') || 'pending',
          };
        result = await customerBusinessApi.save(editor.entity, payload, {
          id: editor.id,
          version: editor.version,
          key: editor.key,
        });
      }
      saved(result);
      setEditor(null);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存失败';
      const uncertain =
        !(cause instanceof BusinessRequestError) || cause.status === 409 || cause.status >= 500;
      setRefreshRequired(uncertain);
      setFormError(uncertain ? `${message}。请关闭并刷新核对当前记录，再继续操作。` : message);
    } finally {
      setSaving(false);
    }
  }
  function closeEditor() {
    if (!saving) {
      setEditor(null);
      if (refreshRequired) void load();
    }
  }
  async function preflight(task: BusinessTask) {
    setSaving(true);
    setError('');
    try {
      setCheck({ task, result: await customerBusinessApi.preflight(task.id) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '核验失败');
    } finally {
      setSaving(false);
    }
  }
  async function sync() {
    setSaving(true);
    setError('');
    try {
      const result = await customerBusinessApi.sync();
      setNotice(
        result.feishu?.status === 'pending' || result.status === 'pending'
          ? '已核对同步状态，仍有记录待处理。'
          : '已核对业务表同步结果。',
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '业务表同步失败');
    } finally {
      setSaving(false);
    }
  }

  const formCustomer = editor ? text(editor.value, 'customerId') : '';
  const formConversation = editor ? text(editor.value, 'conversationId') : '';
  const eligibleConversations = data.conversations.filter(
    (conversation) => !formCustomer || conversation.customerId === formCustomer,
  );
  const eligibleDemands = data.demands.filter(
    (demand) =>
      demand.customerId === formCustomer &&
      !!formConversation &&
      demand.conversationId === formConversation,
  );
  const eligibleMessages = data.messages.filter(
    (message) =>
      message.customerId === formCustomer &&
      !!formConversation &&
      message.conversationId === formConversation,
  );
  const selectedSource =
    editor && data.messages.find((message) => message.id === text(editor.value, 'sourceMessageId'));
  const sourceMessages = data.messages.filter(
    (message) => demandSource(message) && (!formCustomer || message.customerId === formCustomer),
  );
  const stateOptions =
    tab === 'demands'
      ? stages
      : tab === 'tasks'
        ? taskStates
        : { inbound: '收到', outbound: '发出', note: '纪要' };
  const title =
    editor?.entity === 'action'
      ? actionLabels[text(editor.value, 'action') as Action]
      : editor?.entity === 'message-links'
        ? '沟通关联与备注'
        : editor?.entity === 'conversations'
          ? '客户会话'
          : editor?.entity === 'messages'
            ? '录入实际沟通'
            : editor?.entity === 'demands'
              ? '采购需求'
              : '跟进任务';
  const field = (
    key: string,
    label: string,
    options: {
      required?: boolean;
      type?: string;
      multiline?: boolean;
      full?: boolean;
      hint?: string;
      readOnly?: boolean;
      maxLength?: number;
    } = {},
  ) =>
    editor && (
      <label className={options.full ? 'business-field business-full' : 'business-field'}>
        {label}
        {options.multiline ? (
          <textarea
            rows={key === 'body' ? 7 : 3}
            required={options.required}
            value={text(editor.value, key)}
            readOnly={options.readOnly}
            maxLength={options.maxLength}
            placeholder={options.hint}
            onChange={(event) => change(key, event.target.value)}
          />
        ) : (
          <input
            type={options.type || 'text'}
            required={options.required}
            value={text(editor.value, key)}
            readOnly={options.readOnly}
            maxLength={options.maxLength}
            placeholder={options.hint}
            onChange={(event) => change(key, event.target.value)}
          />
        )}
      </label>
    );
  const select = (key: string, label: string, options: Record<string, string>, optional = false) =>
    editor && (
      <label className="business-field">
        {label}
        <select
          value={text(editor.value, key)}
          required={!optional}
          onChange={(event) => change(key, event.target.value)}
        >
          {optional && <option value="">暂不关联</option>}
          {Object.entries(options).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
    );
  const productChoices = editor && (
    <MultiChoice
      label="关联产品资料（T5）"
      options={data.products
        .filter(
          (product) =>
            product.status !== 'archived' || list(editor.value, 'productIds').includes(product.id),
        )
        .map((product) => ({
          id: product.id,
          label: `${product.name} · 第${product.version}版${product.status === 'approved' ? '（已审核）' : '（待审核或已归档）'}`,
        }))}
      selected={list(editor.value, 'productIds')}
      onChange={(value) => change('productIds', value)}
    />
  );

  return (
    <div className="customer-business">
      <PageHeading
        eyebrow="CUSTOMER OPERATIONS"
        title="客户业务"
        description="围绕同一家企业维护真实沟通、采购需求和下一步行动"
      >
        <button className="btn secondary" disabled={loading || saving} onClick={() => void load()}>
          <RefreshCw size={15} />
          刷新
        </button>
        <button className="btn secondary" disabled={loading || saving} onClick={() => void sync()}>
          核对飞书同步
        </button>
      </PageHeading>
      <div className="business-overview panel">
        <ClipboardList size={23} />
        <div>
          <strong>客户档案、沟通和需求相互关联</strong>
          <p>先建立会话，录入实际沟通，再依据客户原文整理采购需求并安排跟进。</p>
          <small>
            {data.feishu?.error ||
              (data.feishu?.configured
                ? '业务记录在本页维护，飞书同步供团队查看。'
                : '业务记录保存在后台，飞书业务表同步待配置。')}
          </small>
        </div>
      </div>
      {error && (
        <div className="business-alert error" role="alert">
          {error}
        </div>
      )}
      {data.customerError && (
        <div className="business-alert error" role="alert">
          {data.customerError}
        </div>
      )}
      {selectedContext?.fixedEmail && (
        <div className="business-alert">客户固定邮箱：{selectedContext.fixedEmail}</div>
      )}
      {selectedContext?.doNotContact && (
        <div className="business-alert error" role="alert">
          该客户已标记拒绝联系，请核对联系限制后处理相关任务。
        </div>
      )}
      {notice && (
        <div className="business-alert" role="status">
          {notice}
        </div>
      )}
      <div className="business-filters panel">
        <label>
          客户
          <select
            aria-label="选择业务客户"
            value={customerId}
            onChange={(event) => filter('customerId', event.target.value)}
          >
            <option value="">全部客户</option>
            {data.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          产品资料
          <select
            aria-label="按产品资料筛选"
            value={productId}
            onChange={(event) => filter('productId', event.target.value)}
          >
            <option value="">全部产品</option>
            {data.products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
                {product.status !== 'approved' ? '（待审核或已归档）' : ''}
              </option>
            ))}
          </select>
        </label>
        {selectedCustomer && (
          <Link className="text-link" to={linkToCustomer(selectedCustomer.id)}>
            查看企业档案
            <ExternalLink size={13} />
          </Link>
        )}
        {productId && (
          <Link className="text-link" to={`/materials?product=${encodeURIComponent(productId)}`}>
            查看产品资料
            <ExternalLink size={13} />
          </Link>
        )}
      </div>
      <section className="panel business-content">
        <div className="business-tabs" role="tablist" aria-label="客户业务表">
          {(['demands', 'messages', 'tasks'] as Tab[]).map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={tab === name}
              className={tab === name ? 'active' : ''}
              onClick={() => filter('tab', name)}
            >
              {tabLabels[name]}
              <span>{data[name].length}</span>
            </button>
          ))}
        </div>
        <div className="business-toolbar">
          <div className="search-field">
            <Search size={15} />
            <input
              aria-label="搜索客户业务记录"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题、正文、客户或负责人"
            />
          </div>
          <select
            aria-label="业务记录状态"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="all">全部状态</option>
            {Object.entries(stateOptions).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <button
            className="btn secondary"
            disabled={
              loading || saving || !!error || !!data.customerError || !data.customers.length
            }
            onClick={() => newEditor('conversations')}
          >
            <Plus size={14} />
            新建会话
          </button>
          <button
            className="btn primary"
            disabled={
              loading || saving || !!error || !!data.customerError || !data.customers.length
            }
            onClick={() => newEditor(tab)}
          >
            <Plus size={15} />
            {tab === 'demands'
              ? '整理采购需求'
              : tab === 'messages'
                ? '录入实际沟通'
                : '创建跟进任务'}
          </button>
        </div>
        {loading ? (
          <p className="business-loading" role="status">
            正在读取客户业务…
          </p>
        ) : (
          <>
            {tab === 'messages' && (
              <div className="business-conversations">
                <strong>会话</strong>
                {data.conversations.length ? (
                  data.conversations.map((conversation) => (
                    <button
                      key={conversation.id}
                      className="business-conversation"
                      onClick={() => newEditor('conversations', conversation)}
                    >
                      <MessageSquare size={15} />
                      <span>
                        {conversation.title}
                        <small>
                          {customerName(conversation.customerId)} · {channels[conversation.channel]}{' '}
                          · {conversation.account || '账号待补充'}
                        </small>
                      </span>
                      <Badge>
                        {conversation.status === 'closed'
                          ? '已关闭'
                          : ownership[conversation.ownership]}
                      </Badge>
                    </button>
                  ))
                ) : (
                  <p>尚未建立会话。请先选择客户并新建一个会话。</p>
                )}
              </div>
            )}
            {tab === 'demands' &&
              (demands.length ? (
                <div className="table-scroll">
                  <table className="business-table">
                    <thead>
                      <tr>
                        <th>需求与客户</th>
                        <th>品类与产品</th>
                        <th>客户表达依据</th>
                        <th>阶段与负责</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {demands.map((demand) => (
                        <tr key={demand.id}>
                          <td>
                            <strong>{demand.title}</strong>
                            <Link to={linkToCustomer(demand.customerId)}>
                              {customerName(demand.customerId)}
                            </Link>
                            <small>{conversationName(demand.conversationId)}</small>
                          </td>
                          <td>
                            {categories[demand.category]} · {directions[demand.direction]}
                            <span>{demand.productText || '产品细节待明确'}</span>
                            {demand.productIds.map((id) => (
                              <Link key={id} to={`/materials?product=${encodeURIComponent(id)}`}>
                                {productName(id)}
                                {productWarning(id, demand.productVersions) &&
                                  `（${productWarning(id, demand.productVersions)}）`}
                              </Link>
                            ))}
                            <small>
                              {demand.quantity
                                ? `数量：${demand.quantity} ${demand.unit}`
                                : '数量待确认'}
                            </small>
                          </td>
                          <td className="business-quote">
                            {demand.evidenceQuote}
                            <small>
                              来源：
                              {data.messages.find(
                                (message) => message.id === demand.sourceMessageId,
                              )?.subject || '实际沟通记录'}
                            </small>
                          </td>
                          <td>
                            <Badge>{stages[demand.stage]}</Badge>
                            <small>
                              {ownership[demand.ownership]} · {demand.owner || '负责人待分配'}
                            </small>
                          </td>
                          <td>
                            <div className="business-row-actions">
                              <button
                                className="btn secondary small"
                                disabled={saving}
                                onClick={() => newEditor('demands', demand)}
                              >
                                查看 / 编辑
                              </button>
                              <button
                                className="btn secondary small"
                                disabled={saving}
                                onClick={() => taskForDemand(demand)}
                              >
                                安排下一步
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="暂无采购需求"
                  detail="录入客户实际来信、留言或已核实通话纪要后，引用依据整理需求。同一条沟通可以关联多项采购需求。"
                />
              ))}
            {tab === 'messages' &&
              (messages.length ? (
                <div className="business-message-list">
                  {messages.map((message) => (
                    <article className="business-message" key={message.id}>
                      <header>
                        <div>
                          <Badge tone={message.direction === 'inbound' ? 'success' : 'neutral'}>
                            {{ inbound: '收到', outbound: '发出', note: '纪要' }[message.direction]}
                          </Badge>
                          <Badge>{channels[message.channel]}</Badge>
                          <Badge>{delivery[message.deliveryStatus]}</Badge>
                          {message.classification !== 'normal' && (
                            <Badge>{classifications[message.classification]}</Badge>
                          )}
                        </div>
                        <time>{dateText(message.occurredAt)}</time>
                      </header>
                      <h3>{message.subject || '无主题沟通'}</h3>
                      <p className="business-message-meta">
                        <Link to={linkToCustomer(message.customerId)}>
                          {customerName(message.customerId)}
                        </Link>{' '}
                        · {conversationName(message.conversationId)}
                        <br />
                        {message.from || '未记录发起方'} → {message.to || '未记录接收方'} ·
                        我方账号：{message.account || '未记录'}
                      </p>
                      <pre>{message.body}</pre>
                      {message.notes && (
                        <p className="business-message-meta">补充备注：{message.notes}</p>
                      )}
                      {message.attachments?.filter(safeHref).map((url, index) => (
                        <a
                          key={url}
                          className="text-link business-attachment"
                          href={safeHref(url)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          附件 {index + 1}
                          <ExternalLink size={12} />
                        </a>
                      ))}
                      <footer>
                        <span>
                          {data.demands
                            .filter(
                              (demand) =>
                                demand.sourceMessageId === message.id ||
                                message.demandIds?.includes(demand.id),
                            )
                            .map((demand) => demand.title)
                            .join('；') || '尚未关联采购需求'}
                        </span>
                        <button
                          className="btn secondary small"
                          disabled={saving}
                          onClick={() => editMessageLinks(message)}
                        >
                          补充需求关联与备注
                        </button>
                        {demandSource(message) && (
                          <button
                            className="btn secondary small"
                            disabled={saving}
                            onClick={() => fromMessage(message)}
                          >
                            根据本条记录整理需求
                          </button>
                        )}
                      </footer>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  title="暂无实际沟通记录"
                  detail="这里记录已发生的邮件、WhatsApp、网站留言和通话纪要，保存后保留原文及实际收发状态。"
                />
              ))}
            {tab === 'tasks' &&
              (tasks.length ? (
                <div className="table-scroll">
                  <table className="business-table">
                    <thead>
                      <tr>
                        <th>任务与客户</th>
                        <th>下一步行动</th>
                        <th>执行时间与状态</th>
                        <th>关联与结果</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((task) => (
                        <tr key={task.id}>
                          <td>
                            <strong>{task.title}</strong>
                            <Link to={linkToCustomer(task.customerId)}>
                              {customerName(task.customerId)}
                            </Link>
                            <small>{task.owner || '负责人待分配'}</small>
                          </td>
                          <td>
                            {taskKinds[task.kind]} · {channels[task.channel]}
                            <span>
                              <Badge>
                                {task.executionMode === 'automatic' ? '系统计划' : '人工执行'}
                              </Badge>
                            </span>
                            <span>{task.notes || '尚无执行说明'}</span>
                          </td>
                          <td>
                            {dateText(task.dueAt)}
                            <span>
                              <Badge>{taskStates[task.status]}</Badge>
                            </span>
                          </td>
                          <td>
                            <small>
                              {task.demandIds
                                .map(
                                  (id) =>
                                    data.demands.find((demand) => demand.id === id)?.title || id,
                                )
                                .join('；') || '企业级跟进'}
                            </small>
                            {task.productIds.map((id) => (
                              <Link key={id} to={`/materials?product=${encodeURIComponent(id)}`}>
                                {productName(id)}
                                {productWarning(id, task.productVersions) &&
                                  `（${productWarning(id, task.productVersions)}）`}
                              </Link>
                            ))}
                            {task.resultMessageId && <small>已关联实际沟通结果</small>}
                            {task.completionNotes && <small>{task.completionNotes}</small>}
                            {!!task.audit?.length && (
                              <details className="business-audit">
                                <summary>执行留痕（{task.audit.length}）</summary>
                                <ol>
                                  {task.audit.map((event, index) => (
                                    <li key={index}>
                                      {actionLabels[event.action as Action] || event.action} ·{' '}
                                      {dateText(event.at)}
                                      {event.notes && <span>{event.notes}</span>}
                                    </li>
                                  ))}
                                </ol>
                              </details>
                            )}
                          </td>
                          <td>
                            <div className="business-row-actions">
                              {!['completed', 'cancelled'].includes(task.status) && (
                                <>
                                  <button
                                    className="btn secondary small"
                                    disabled={saving}
                                    onClick={() => newEditor('tasks', task)}
                                  >
                                    编辑任务
                                  </button>
                                  <button
                                    className="btn secondary small"
                                    disabled={saving}
                                    onClick={() => void preflight(task)}
                                  >
                                    执行前核验
                                  </button>
                                  <button
                                    className="btn secondary small"
                                    disabled={saving}
                                    onClick={() => action(task, 'complete')}
                                  >
                                    记录完成结果
                                  </button>
                                  <button
                                    className="btn secondary small"
                                    disabled={saving}
                                    onClick={() =>
                                      action(task, task.status === 'paused' ? 'resume' : 'pause')
                                    }
                                  >
                                    {task.status === 'paused' ? '恢复' : '暂停'}
                                  </button>
                                  <button
                                    className="btn secondary small"
                                    disabled={saving}
                                    onClick={() => action(task, 'cancel')}
                                  >
                                    取消任务
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="暂无跟进任务"
                  detail="从企业或具体采购需求安排下一步行动，并明确执行时间、负责人和实际结果。"
                />
              ))}
          </>
        )}
      </section>
      {editor && (
        <Modal
          wide
          title={(editor.id && editor.entity !== 'action' ? '编辑' : '') + title}
          onClose={closeEditor}
        >
          <form className="modal-body business-form" onSubmit={(event) => void save(event)}>
            {editor.id && (
              <p className="business-form-meta">
                记录 {editor.id} · 第 {editor.version} 版
              </p>
            )}
            {formError && (
              <p className="business-alert error" role="alert">
                {formError}
              </p>
            )}
            <fieldset disabled={saving || refreshRequired}>
              <div className="business-fields">
                {editor.entity !== 'action' && editor.entity !== 'message-links' && (
                  <label className="business-field">
                    客户 *
                    <select
                      required
                      value={text(editor.value, 'customerId')}
                      disabled={
                        !!editor.id ||
                        (['messages', 'demands'].includes(editor.entity) &&
                          !!text(
                            editor.value,
                            editor.entity === 'messages' ? 'conversationId' : 'sourceMessageId',
                          ))
                      }
                      onChange={(event) => chooseCustomer(event.target.value)}
                    >
                      <option value="">请选择企业档案</option>
                      {data.customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {editor.entity === 'conversations' && (
                  <>
                    {field('title', '会话标题 *', { required: true })}
                    {select('channel', '沟通渠道', channels)}
                    {field('account', '我方账号 / 对外邮箱', { hint: '填写真实使用的邮箱或号码' })}
                    {field('participant', '客户联系入口', { hint: '客户邮箱、号码或联系人' })}
                    {field('owner', '负责人')}
                    {select('ownership', '接待归属', ownership)}
                    {select('status', '会话状态', { active: '进行中', closed: '已关闭' })}
                    <p className="business-form-note business-full">
                      已确认收发的邮件会绑定客户固定邮箱，后续品类变化沿用该邮箱。人工接管与单封商务邮件审核分别处理。
                    </p>
                  </>
                )}
                {editor.entity === 'messages' && (
                  <>
                    <label className="business-field">
                      会话 *
                      <select
                        required
                        value={formConversation}
                        onChange={(event) => chooseConversation(event.target.value)}
                      >
                        <option value="">请选择已建立的会话</option>
                        {eligibleConversations.map((conversation) => (
                          <option key={conversation.id} value={conversation.id}>
                            {conversation.title} ·{' '}
                            {conversation.account || channels[conversation.channel]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {field('account', '我方账号', { readOnly: true })}
                    <label className="business-field">
                      沟通方向
                      <select
                        value={text(editor.value, 'direction')}
                        onChange={(event) => {
                          const direction = event.target.value;
                          const conversation = data.conversations.find(
                            (item) => item.id === formConversation,
                          );
                          setEditor({
                            ...editor,
                            value: {
                              ...editor.value,
                              direction,
                              deliveryStatus:
                                direction === 'inbound'
                                  ? 'received'
                                  : direction === 'outbound'
                                    ? 'sent'
                                    : 'recorded',
                              from:
                                direction === 'outbound'
                                  ? conversation?.account || ''
                                  : conversation?.participant || '',
                              to:
                                direction === 'outbound'
                                  ? conversation?.participant || ''
                                  : conversation?.account || '',
                            },
                          });
                        }}
                      >
                        <option value="inbound">实际收到</option>
                        <option value="outbound">实际发出</option>
                        <option value="note">沟通纪要</option>
                      </select>
                    </label>
                    {field('from', '发起方')}
                    {field('to', '接收方')}
                    {field('occurredAt', '发生时间（北京时间） *', {
                      type: 'datetime-local',
                      required: true,
                    })}
                    {select(
                      'deliveryStatus',
                      '实际收发结果',
                      text(editor.value, 'direction') === 'note'
                        ? { recorded: '已记载' }
                        : text(editor.value, 'direction') === 'inbound'
                          ? { received: '已收到' }
                          : { sent: '已发送', failed: '失败', unknown: '结果未知' },
                    )}
                    {select('classification', '消息类型', classifications)}
                    {field('externalId', '原渠道消息编号', {
                      hint: '已有消息编号时填写，用于核对重复记录',
                    })}
                    {field('subject', '主题 / 纪要标题', { full: true })}
                    {field('body', '实际原文 / 通话纪要 *', {
                      multiline: true,
                      full: true,
                      required: true,
                      maxLength: 20000,
                      hint: '保留客户原文；通话纪要请清楚注明纪要内容',
                    })}
                    {field('attachmentsText', '附件链接（每行一个）', {
                      multiline: true,
                      full: true,
                    })}
                    <MultiChoice
                      label="关联已有采购需求"
                      options={eligibleDemands.map((demand) => ({
                        id: demand.id,
                        label: demand.title,
                      }))}
                      selected={list(editor.value, 'demandIds')}
                      onChange={(value) => change('demandIds', value)}
                    />
                    <label className="business-confirm business-full">
                      <input
                        type="checkbox"
                        required
                        checked={editor.value.actualConfirmed === true}
                        onChange={(event) => change('actualConfirmed', event.target.checked)}
                      />
                      我确认这是已发生的沟通，原文和收发状态已核对。
                    </label>
                    <p className="business-form-note business-full">
                      保存为实际沟通记录，原文保存后不可改写。需要补充或纠正时另记说明。
                    </p>
                  </>
                )}
                {editor.entity === 'demands' && (
                  <>
                    <label className="business-field business-full">
                      客户表达的来源沟通 *
                      <select
                        required
                        value={text(editor.value, 'sourceMessageId')}
                        disabled={!!editor.id}
                        onChange={(event) => chooseSource(event.target.value)}
                      >
                        <option value="">请选择实际收到的沟通或已核实通话纪要</option>
                        {sourceMessages.map((message) => (
                          <option key={message.id} value={message.id}>
                            {customerName(message.customerId)} · {message.subject || '无主题'} ·{' '}
                            {dateText(message.occurredAt)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedSource && (
                      <div className="business-source business-full">
                        <strong>
                          {selectedSource.direction === 'note' ? '通话纪要' : '客户原文'}
                        </strong>
                        <textarea
                          readOnly
                          rows={5}
                          value={selectedSource.body}
                          onSelect={(event) => {
                            const target = event.currentTarget;
                            const quote = target.value.slice(
                              target.selectionStart,
                              target.selectionEnd,
                            );
                            if (quote) setSelectedQuote(quote);
                          }}
                        />
                        <button
                          type="button"
                          className="btn secondary small"
                          disabled={!selectedQuote || selectedQuote.length > 5000}
                          onClick={() => change('evidenceQuote', selectedQuote)}
                        >
                          引用选中的内容
                        </button>
                        {selectedQuote.length > 5000 && (
                          <p className="business-form-note">引文最多 5000 字，请缩小所选片段。</p>
                        )}
                      </div>
                    )}
                    {field('title', '采购 / 咨询需求标题 *', { required: true, full: true })}
                    {select('category', '品类', categories)}
                    {select('direction', '供货方向', directions)}
                    {field('productText', '客户表达的产品', { hint: '保留客户原始产品描述' })}
                    {select('stage', '需求阶段', stages)}
                    {field('quantity', '数量', { hint: '未知留空' })}
                    {field('unit', '数量单位')}
                    {field('specifications', '客户要求的规格', { full: true, multiline: true })}
                    {productChoices}
                    {field('evidenceQuote', '客户原文 / 纪要摘录 *', {
                      full: true,
                      multiline: true,
                      required: true,
                      maxLength: 5000,
                      hint: '必须是所选消息正文或通话纪要中的连续摘录',
                    })}
                    {field('owner', '负责人')}
                    {select('ownership', '接待归属', ownership)}
                    <p className="business-form-note business-full">
                      关联待审核产品资料可先推进需求确认；对客户承诺供货规格前仍须核实适用资料。
                    </p>
                  </>
                )}
                {editor.entity === 'message-links' && editor.message && (
                  <>
                    <div className="business-source business-full">
                      <strong>{editor.message.subject || '无主题沟通'}</strong>
                      <p>
                        {customerName(editor.message.customerId)} ·{' '}
                        {conversationName(editor.message.conversationId)}
                      </p>
                      <pre>{editor.message.body}</pre>
                    </div>
                    <MultiChoice
                      label="关联采购需求"
                      options={eligibleDemands.map((demand) => ({
                        id: demand.id,
                        label: demand.title,
                      }))}
                      selected={list(editor.value, 'demandIds')}
                      onChange={(value) =>
                        change('demandIds', [
                          ...new Set([
                            ...value,
                            ...data.demands
                              .filter((demand) => demand.sourceMessageId === editor.message!.id)
                              .map((demand) => demand.id),
                          ]),
                        ])
                      }
                    />
                    {field('notes', '补充备注', { full: true, multiline: true })}
                    <p className="business-form-note business-full">
                      原文和实际收发事实保留；作为需求来源的消息关联会继续保留。
                    </p>
                  </>
                )}
                {editor.entity === 'tasks' && (
                  <>
                    {field('title', '下一步行动 *', { required: true })}
                    {select('kind', '行动类型', taskKinds)}
                    <label className="business-field">
                      执行方式
                      <input
                        readOnly
                        value={
                          text(editor.value, 'executionMode') === 'automatic'
                            ? '系统计划'
                            : '人工执行'
                        }
                      />
                    </label>
                    {select('channel', '执行渠道', channels)}
                    <label className="business-field">
                      关联会话
                      <select
                        value={formConversation}
                        onChange={(event) => {
                          if (event.target.value) chooseConversation(event.target.value);
                          else change('conversationId', '');
                        }}
                      >
                        <option value="">企业级行动，暂不关联会话</option>
                        {eligibleConversations.map((conversation) => (
                          <option key={conversation.id} value={conversation.id}>
                            {conversation.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    {field('dueAt', '执行时间（北京时间） *', {
                      type: 'datetime-local',
                      required: true,
                    })}
                    {field('owner', '负责人')}
                    {field('notes', '行动说明', { multiline: true, full: true })}
                    <MultiChoice
                      label="关联采购需求"
                      options={eligibleDemands.map((demand) => ({
                        id: demand.id,
                        label: demand.title,
                      }))}
                      selected={list(editor.value, 'demandIds')}
                      onChange={(value) => change('demandIds', value)}
                    />
                    {productChoices}
                    <MultiChoice
                      label="关联沟通记录"
                      options={eligibleMessages.map((message) => ({
                        id: message.id,
                        label: `${message.subject || '无主题'} · ${dateText(message.occurredAt)}`,
                      }))}
                      selected={list(editor.value, 'messageIds')}
                      onChange={(value) => change('messageIds', value)}
                    />
                    <label className="business-field business-full">
                      安排任务的依据消息
                      <select
                        value={text(editor.value, 'basisMessageId')}
                        onChange={(event) => change('basisMessageId', event.target.value)}
                      >
                        <option value="">暂不关联</option>
                        {eligibleMessages.map((message) => (
                          <option key={message.id} value={message.id}>
                            {message.subject || '无主题'} · {dateText(message.occurredAt)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="business-form-note business-full">
                      按实际需要选择执行时间。执行前可核验客户回复、拒绝联系、人工接管和产品资料状态。
                    </p>
                  </>
                )}
                {editor.entity === 'action' && editor.task && (
                  <>
                    <p className="business-full business-action-title">
                      {editor.task.title} · {customerName(editor.task.customerId)}
                    </p>
                    {text(editor.value, 'action') === 'complete' &&
                      communicationTask(editor.task) && (
                        <label className="business-field business-full">
                          实际已发出的结果消息 *
                          <select
                            required
                            value={text(editor.value, 'resultMessageId')}
                            onChange={(event) => change('resultMessageId', event.target.value)}
                          >
                            <option value="">请选择实际发送成功的消息</option>
                            {data.messages
                              .filter(
                                (message) =>
                                  message.customerId === editor.task!.customerId &&
                                  (!editor.task!.conversationId ||
                                    message.conversationId === editor.task!.conversationId) &&
                                  message.direction === 'outbound' &&
                                  message.deliveryStatus === 'sent',
                              )
                              .map((message) => (
                                <option key={message.id} value={message.id}>
                                  {message.subject || '无主题'} · {dateText(message.occurredAt)}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                    {field(
                      'notes',
                      text(editor.value, 'action') === 'complete' ? '实际执行说明' : '操作原因',
                      {
                        multiline: true,
                        full: true,
                        required:
                          text(editor.value, 'action') === 'complete' &&
                          !communicationTask(editor.task),
                        hint:
                          text(editor.value, 'action') === 'complete'
                            ? '记录实际完成的行动与结果'
                            : '说明本次状态调整的原因',
                      },
                    )}
                    <p className="business-form-note business-full">
                      任务完成记录实际执行结果；具体报价或商务邮件仍按对应审核流程处理。
                    </p>
                  </>
                )}
              </div>
            </fieldset>
            <div className="modal-actions">
              <button
                type="button"
                className="btn secondary"
                disabled={saving}
                onClick={closeEditor}
              >
                {refreshRequired ? '关闭并刷新核对' : '取消'}
              </button>
              <button className="btn primary" type="submit" disabled={saving || refreshRequired}>
                {saving
                  ? '正在保存…'
                  : editor.entity === 'action'
                    ? actionLabels[text(editor.value, 'action') as Action]
                    : '保存记录'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {check && (
        <Modal title="任务执行前核验" onClose={() => setCheck(null)}>
          <div className="modal-body business-preflight">
            <h3>{check.task.title}</h3>
            <Badge tone={check.result.ready ? 'success' : 'neutral'}>
              {check.result.ready ? '通过当前核验' : '有事项待处理'}
            </Badge>
            <p>{check.result.message}</p>
            {check.result.reasons?.length ? (
              <ul>
                {check.result.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p>当前未发现阻止此项任务继续处理的事项。</p>
            )}
            <p className="business-form-note">
              核验供人工执行参考。完成实际行动后，请录入沟通结果或执行说明。
            </p>
            <button className="btn primary" onClick={() => setCheck(null)}>
              <CheckCircle2 size={15} />
              已查看
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
