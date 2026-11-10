export type BusinessChannel = 'email' | 'whatsapp' | 'form' | 'phone' | 'other';
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
  direction: '' | 'finished' | 'materials' | 'samples';
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
  origin?: string;
  campaignId?: string;
  deliveryStatus?: string;
  displayId?: string;
  ownerIds: string[];
  templateIds: string[];
  conversationId?: string;
  demandIds: string[];
  messageIds: string[];
  productIds: string[];
  productVersions?: Record<string, number>;
  title: string;
  kind:
    | 'follow_up'
    | 'first_contact'
    | 'clarify_specs'
    | 'quote_followup'
    | 'sample'
    | 'manual_review'
    | 'other';
  executionMode?: 'manual' | 'automatic';
  channel: BusinessChannel;
  dueAt: string;
  status: 'pending' | 'completed' | 'skipped' | 'cancelled';
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
  tasksOnly?: boolean;
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
export const customerBusinessApi = {
  workspace: (filter: { customerId?: string; productId?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (filter.customerId) query.set('customerId', filter.customerId);
    if (filter.productId) query.set('productId', filter.productId);
    return request<BusinessWorkspace>(query.size ? '?' + query : '', { signal });
  },
  sync: () => request<{ feishu?: BusinessFeishu; status?: string }>('/sync', { method: 'POST' }),
};
