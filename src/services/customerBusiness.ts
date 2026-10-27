export type BusinessChannel = 'email' | 'whatsapp' | 'form' | 'phone' | 'other';
export type BusinessEntity = 'conversations' | 'messages' | 'demands' | 'tasks';
export interface BusinessCustomer {
  id: string;
  name: string;
  website?: string;
  grade?: string;
  status?: string;
}
export interface BusinessProduct {
  id: string;
  name: string;
  englishName?: string;
  status: 'draft' | 'approved' | 'archived';
  version: number;
  effectiveDate?: string;
}
export interface BusinessRecord {
  id: string;
  version: number;
  customerId: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface BusinessConversation extends BusinessRecord {
  title: string;
  channel: BusinessChannel;
  account: string;
  participant: string;
  ownership: 'auto' | 'human';
  owner: string;
  status: 'active' | 'closed';
}
export interface BusinessMessage extends BusinessRecord {
  conversationId: string;
  channel: BusinessChannel;
  direction: 'inbound' | 'outbound' | 'note';
  subject: string;
  body: string;
  from: string;
  to: string;
  account: string;
  occurredAt: string;
  deliveryStatus: 'received' | 'sent' | 'accepted' | 'failed' | 'unknown' | 'recorded';
  classification: 'normal' | 'auto_reply' | 'unsubscribe' | 'hard_bounce' | 'complaint';
  externalId: string;
  attachments: string[];
  demandIds: string[];
  actualConfirmed?: boolean;
  origin?: string;
  notes?: string;
}
export interface BusinessDemand extends BusinessRecord {
  sourceMessageId: string;
  conversationId: string;
  title: string;
  category: 'ventilation' | 'shutters' | 'indoor' | 'outdoor' | 'other';
  direction: 'finished' | 'materials' | 'samples';
  productText: string;
  productIds: string[];
  productVersions?: Record<string, number>;
  productReadiness?: 'unlinked' | 'ready' | 'pending';
  specifications: string;
  quantity: string;
  unit: string;
  stage: 'new' | 'clarifying' | 'quoting' | 'sampling' | 'negotiating' | 'won' | 'lost' | 'closed';
  owner: string;
  ownership: 'auto' | 'human';
  evidenceQuote: string;
}
export interface BusinessTask extends BusinessRecord {
  conversationId?: string;
  demandIds: string[];
  messageIds: string[];
  productIds: string[];
  productVersions?: Record<string, number>;
  title: string;
  kind: 'first_contact' | 'clarify_specs' | 'quote_followup' | 'sample' | 'manual_review' | 'other';
  executionMode?: 'manual' | 'automatic';
  channel: BusinessChannel;
  dueAt: string;
  status: 'pending' | 'paused' | 'completed' | 'cancelled';
  owner: string;
  notes: string;
  basisMessageId?: string;
  resultMessageId?: string;
  completionNotes?: string;
  audit?: { action: string; at: string; notes?: string; resultMessageId?: string }[];
}
export interface BusinessFeishu {
  status?: string;
  configured?: boolean;
  error?: string;
  tables?: Record<string, unknown>;
}
export interface BusinessWorkspace {
  customers: BusinessCustomer[];
  products: BusinessProduct[];
  conversations: BusinessConversation[];
  messages: BusinessMessage[];
  demands: BusinessDemand[];
  tasks: BusinessTask[];
  customerContexts: { customerId: string; fixedEmail?: string; doNotContact?: boolean }[];
  customerError?: string;
  feishu?: BusinessFeishu;
}
export interface BusinessSaveResult {
  record: BusinessRecord;
  feishu?: BusinessFeishu;
}
export interface BusinessPreflight {
  ready: boolean;
  reasons: string[];
  message: string;
  automaticSend: false;
}
export class BusinessRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const base = '/api/v1/business';
async function request<T>(path = '', options: RequestInit = {}): Promise<T> {
  const response = await fetch(base + path, {
    ...options,
    signal: options.signal || AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new BusinessRequestError(
      body?.error || `客户业务操作失败（${response.status}）`,
      response.status,
    );
  if (!body) throw new Error('服务未返回有效结果，请刷新核对');
  return body as T;
}
const json = (body: object, key?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
});
export const customerBusinessApi = {
  workspace: (filter: { customerId?: string; productId?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (filter.customerId) query.set('customerId', filter.customerId);
    if (filter.productId) query.set('productId', filter.productId);
    return request<BusinessWorkspace>(query.size ? '?' + query : '', { signal });
  },
  save: (
    entity: BusinessEntity,
    value: Record<string, unknown>,
    options: { id?: string; version?: number; key: string },
  ) =>
    request<BusinessSaveResult>('/' + entity, {
      ...json(
        { ...value, ...(options.id ? { id: options.id, expectedVersion: options.version } : {}) },
        options.key,
      ),
      method: options.id ? 'PUT' : 'POST',
    }),
  taskAction: (
    id: string,
    value: {
      action: 'complete' | 'pause' | 'resume' | 'cancel';
      expectedVersion: number;
      resultMessageId?: string;
      notes?: string;
    },
  ) => request<BusinessSaveResult>(`/tasks/${encodeURIComponent(id)}/action`, json(value)),
  preflight: (id: string) =>
    request<BusinessPreflight>(`/tasks/${encodeURIComponent(id)}/preflight`, { method: 'POST' }),
  sync: () => request<{ feishu?: BusinessFeishu; status?: string }>('/sync', { method: 'POST' }),
};
