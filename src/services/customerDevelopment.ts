import type { BusinessMessage, BusinessTask } from './customerBusiness';

export interface CustomerDevelopmentState {
  version: number;
  paused: boolean;
  reason: string;
  notes: string;
  reviewDate: string;
  pausedAt: string;
  updatedAt: string;
  resumeNotes: string;
  audit: {
    action: 'pause' | 'review' | 'resume';
    at: string;
    actor: '人工操作';
    reason: string;
    notes: string;
    reviewDate: string;
    resumeNotes?: string;
  }[];
}

export interface CustomerDevelopmentSnapshot {
  customerId: string;
  development: CustomerDevelopmentState;
  messages: BusinessMessage[];
  tasks: BusinessTask[];
  doNotContact: boolean;
  fixedEmail: string;
  sourceStatus: string;
  reviewToken: string;
}

export interface CustomerDevelopmentAction {
  action: 'pause' | 'review' | 'resume';
  expectedVersion: number;
  reason?: string;
  notes?: string;
  reviewDate?: string;
  resumeNotes?: string;
  reviewed?: boolean;
  reviewToken?: string;
}

export class CustomerDevelopmentError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request(
  customerId: string,
  init: RequestInit,
): Promise<CustomerDevelopmentSnapshot> {
  const response = await fetch(
    `/api/v1/business/customers/${encodeURIComponent(customerId)}/development`,
    {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body)
    throw new CustomerDevelopmentError(
      body?.error || '邮件开发状态读取或保存失败，请刷新核对',
      response.status,
    );
  return body as CustomerDevelopmentSnapshot;
}

export const customerDevelopmentApi = {
  get: (customerId: string, signal?: AbortSignal) => request(customerId, { signal }),
  act: (customerId: string, value: CustomerDevelopmentAction) =>
    request(customerId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    }),
};
