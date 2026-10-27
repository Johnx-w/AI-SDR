export interface OutreachProduct {
  id: string;
  label?: string;
  name?: string;
  category?: string;
  approved?: boolean;
  status?: string;
  version?: number;
  englishName?: string;
}

export interface OutreachMailbox {
  id: string;
  email: string;
  website: string;
  brandName: string;
  displayName: string;
  signature: string;
  productIds: string[];
  priority: number;
  dailyLimit: number;
  intervalSeconds: number;
  paused: boolean;
  configured: boolean;
  smtpStatus: string;
  lastCheckedAt?: string | null;
  lastError?: string | null;
}

export interface OutreachCampaign {
  id: string;
  name: string;
  mode: 'internal_test' | 'production';
  status: 'draft' | 'preparing' | 'ready' | 'active' | 'paused' | 'completed' | 'cancelled';
  revision: number;
  targetCount: number;
  filters?: { markets: string[]; grades: string[]; products: string[]; categories?: string[] };
  mailboxIds: string[];
  includeExisting: boolean;
  continuous: boolean;
  intervalSeconds: number;
  createdAt: string;
  cancelledAt?: string;
  lastError?: string;
  approvedRevision: number | null;
  outreachClaims?: { productId: string; productVersion: number; text: string }[];
  stats: { queued: number; accepted: number; failed: number; unknown: number; blocked: number };
}

export type OutreachDeliveryStatus =
  | 'queued'
  | 'draft'
  | 'sending'
  | 'accepted'
  | 'failed'
  | 'unknown'
  | 'blocked'
  | 'cancelled';

export interface OutreachDelivery {
  id: string;
  campaignId: string;
  mode?: 'internal_test' | 'production';
  customerId?: string;
  companyName: string;
  to: string;
  mailboxId: string;
  from: string;
  subject: string;
  bodyText: string;
  status: OutreachDeliveryStatus;
  reason?: string | null;
  matchReason?: string | null;
  createdAt: string;
  sentAt?: string | null;
  messageId?: string | null;
  receivedVerifiedAt?: string | null;
  recordError?: string | null;
}

export interface OutreachState {
  mailboxes: OutreachMailbox[];
  campaigns: OutreachCampaign[];
  deliveries: OutreachDelivery[];
  products: OutreachProduct[];
  readiness: { generatorConfigured: boolean };
  review: {
    internalTestPassed: boolean;
    productionApproved: boolean;
    internalReceiptVerified?: boolean;
  };
}

export interface OutreachCampaignDetail {
  campaign: OutreachCampaign;
  deliveries: OutreachDelivery[];
}

export interface OutreachDeliveryPage {
  items: OutreachDelivery[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function outreachApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/outreach${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const raw = await response.text();
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('沟通中心暂时无法读取服务数据，请确认服务已启动。');
  }
  if (!response.ok) {
    const error = value as { message?: unknown; error?: unknown };
    throw Object.assign(
      new Error(
        (typeof error.message === 'string' && error.message) ||
          (typeof error.error === 'string' && error.error) ||
          `请求未完成（${response.status}），请稍后重试。`,
      ),
      { status: response.status },
    );
  }
  return value as T;
}
