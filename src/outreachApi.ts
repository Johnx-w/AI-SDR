import type { MailSignatureDesign } from './domain/mail-signature.mjs';
import type { DeliveryGroup } from './domain/outreach-status.mjs';

export interface OutreachFact {
  id: string;
  kind: 'product' | 'price' | 'moq' | 'stock' | 'leadTime' | 'freight' | 'payment';
  text: string;
  conditions: string;
  validUntil: string | null;
}

export interface OutreachProduct {
  materialOnly?: boolean;
  id: string;
  label?: string;
  name?: string;
  category?: string;
  approved?: boolean;
  status?: string;
  version?: number;
  englishName?: string;
  outreachFacts?: OutreachFact[];
  brands?: string[];
  sourceUrl?: string;
}

export interface OutreachMailbox {
  id: string;
  email: string;
  website: string;
  brandName: string;
  displayName: string;
  signature: string;
  signatureDesign?: MailSignatureDesign | null;
  productIds: string[];
  businessNote?: string;
  knowledgeProductIds?: string[];
  owner?: string;
  replyMode?: 'manual' | 'review' | 'auto';
  draftPersona?: string;
  autoBusinessReplies?: boolean;
  priority: number;
  dailyLimit: number;
  intervalSeconds: number;
  paused: boolean;
  configured: boolean;
  smtpStatus: string;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  updatedAt?: string;
}

export interface OutreachCampaign {
  customerCount?: number;
  followUpEnabled?: boolean;
  followUpPaused?: boolean;
  id: string;
  name: string;
  mode: 'internal_test' | 'production';
  status: 'draft' | 'preparing' | 'ready' | 'active' | 'paused' | 'completed' | 'cancelled';
  revision: number;
  targetCount: number | null;
  acquisitionSource?: { jobId: string; scheduleId?: string; roundId: string };
  customerIds?: string[];
  filters?: { markets: string[]; grades: string[]; products: string[]; categories?: string[] };
  mailboxIds: string[];
  includeExisting: boolean;
  continuous: boolean;
  intervalSeconds: number;
  createdAt: string;
  cancelledAt?: string;
  lastError?: string;
  approvedRevision: number | null;
  productScopes?: { productId: string; name: string; englishName: string }[];
  deliveryGroups: Record<DeliveryGroup, number>;
  stats: {
    draft?: number;
    queued: number;
    accepted: number;
    failed: number;
    unknown: number;
    blocked: number;
    skipped: number;
  };
}

export type OutreachDeliveryStatus =
  | 'queued'
  | 'draft'
  | 'sending'
  | 'accepted'
  | 'failed'
  | 'unknown'
  | 'blocked'
  | 'skipped'
  | 'cancelled';

export interface OutreachDelivery {
  campaignName?: string;
  id: string;
  campaignId: string;
  mode?: 'internal_test' | 'production';
  customerId?: string;
  companyName: string;
  to: string;
  mailboxId: string;
  from: string;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  status: OutreachDeliveryStatus;
  reason?: string | null;
  matchReason?: string | null;
  createdAt: string;
  sentAt?: string | null;
  bouncedAt?: string;
  attemptedAt?: string | null;
  skippedAt?: string;
  messageId?: string | null;
  resolution?: {
    outcome: 'accepted' | 'failed';
    evidence: string;
    source: 'imap' | 'manual';
    at: string;
    operator?: string;
  };
  reconciliation?: {
    at: string;
    result: 'sent' | 'unconfirmed';
    evidence?: string;
  };
  receivedVerifiedAt?: string | null;
  recordError?: string | null;
  productClaimIds?: string[];
  materialVersion?: string;
  productFacts?: OutreachFact[];
}

export interface MailboxTag {
  id: string;
  name: string;
}

export interface MailboxTagState {
  tags: MailboxTag[];
  assignments: { mailboxId: string; tagId: string }[];
}

export interface OutreachState {
  reviewCount?: number;
  counts: { total: number; active: number };
  filtered: number;
  page: number;
  mailboxes: OutreachMailbox[];
  campaigns: OutreachCampaign[];
  deliveryStats: Record<OutreachDeliveryStatus | 'total', number>;
  deliveryGroups: Record<DeliveryGroup, number>;
  products: OutreachProduct[];
  readiness: { generatorConfigured: boolean };
}

export interface OutreachCampaignDetail {
  campaign: OutreachCampaign;
  deliveries: OutreachDelivery[];
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
