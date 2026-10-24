export interface MailStatus {
  mode: string;
  mailbox: {
    address: string;
    configured: boolean;
    imapStatus: string;
    smtpStatus: string;
    lastSyncAt: string | null;
    lastError: string | null;
  };
  agent: {
    status: string;
    lastActivityAt: string | null;
    pendingReviews: number;
    pausedReason: string | null;
  };
}

export interface MailConversation {
  id: string;
  subject: string;
  participant: string;
  updatedAt: string;
  unread: boolean;
  status: string;
  agentStatus: string;
}

export interface MailMessage {
  id: string;
  direction: string;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  occurredAt: string;
  deliveryStatus: string;
}

export interface MailDraft {
  bodyText: string;
  revision: number;
  status: string;
}

export interface MailConversationDetail {
  conversation: MailConversation;
  messages: MailMessage[];
  draft: MailDraft | null;
}

const operatorTokenKey = 'shadeflow.mailOperatorToken';

export function getMailOperatorToken() {
  try {
    return window.sessionStorage.getItem(operatorTokenKey);
  } catch {
    return null;
  }
}

export function setMailOperatorToken(value: string) {
  window.sessionStorage.setItem(operatorTokenKey, value);
}

export function clearMailOperatorToken() {
  try {
    window.sessionStorage.removeItem(operatorTokenKey);
  } catch {
    // The next request still has no usable session token.
  }
}

export class MailUnauthorizedError extends Error {}

export async function mailApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const operatorToken = getMailOperatorToken();
  if (!operatorToken) throw new MailUnauthorizedError('请先解锁沟通中心。');
  const response = await fetch(`/api/v1/mail${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'X-Mail-Operator-Token': operatorToken,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401) {
    clearMailOperatorToken();
    window.dispatchEvent(new Event('mail-operator-unauthorized'));
    throw new MailUnauthorizedError('操作者口令无效或已失效，请重新解锁。');
  }
  const raw = await response.text();
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('邮件服务没有返回有效 JSON，请确认后端已启动。');
  }
  if (!response.ok) {
    const error = value as { error?: unknown; message?: unknown };
    const message =
      (typeof error?.message === 'string' && error.message) ||
      (typeof error?.error === 'string' && error.error) ||
      `邮件服务请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return value as T;
}
