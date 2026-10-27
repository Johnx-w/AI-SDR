import { outreachApi } from '../outreachApi';

export interface MailThread {
  id: string;
  mailboxId: string;
  account: string;
  participant: string;
  subject: string;
  updatedAt: string;
  unread: boolean;
  messageCount: number;
  preview: string;
  customerId?: string;
  companyName?: string;
  recordError?: string;
}

export interface MailMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  bodyFormatVersion?: number;
  inlineImages?: MailInlineImage[];
  replyTo?: string[];
  toAddresses?: string[];
  cc?: string[];
  inReplyTo?: string;
  references?: string[];
  bodyUnavailable?: 'too_large' | 'unsupported';
  attachments?: { name: string; contentType: string; size: number | null }[];
  occurredAt: string;
  deliveryStatus: 'received' | 'sent' | 'accepted' | 'unknown' | 'failed' | 'sending';
  messageId?: string;
  source: 'imap' | 'outreach' | 'manual';
}

export interface MailInlineImage {
  cid: string;
  contentType: string;
  contentBase64: string;
}
export interface MailReplyAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBase64: string;
}
export interface MailDraftContent {
  replyToMessageId: string;
  bodyHtml: string;
  bodyText: string;
  attachments: MailReplyAttachment[];
}
export interface MailReplyDraft extends MailDraftContent {
  revision: number;
  updatedAt?: string;
}
export interface MailReplyRecord {
  id: string;
  status: 'accepted' | 'failed' | 'unknown' | 'sending';
  reason?: string;
  error?: string | null;
  archiveStatus?: string;
  archiveReason?: string;
  archiveError?: string;
  businessError?: string;
  recordError?: string;
  businessStatus?: string;
  idempotencyKey?: string;
}
export interface MailReplyContext {
  mailboxId: string;
  from: string;
  to: string;
  signature: string;
  signatureHtml?: string;
  canReply: boolean;
  canSend?: boolean;
  reason?: string;
  replyToMessageId: string;
}

export interface MailboxSyncStatus {
  mailboxId: string;
  email: string;
  lastSyncAt: string | null;
  error: string | null;
  syncing?: boolean;
  hasMore?: boolean;
  folders?: string[];
}

export interface MailConversationList {
  items: MailThread[];
  mailboxes: MailboxSyncStatus[];
  total?: number;
  hasMore?: boolean;
}

export interface MailConversationDetail {
  conversation: MailThread;
  messages: MailMessage[];
  draft?: MailReplyDraft | null;
  replies?: MailReplyRecord[];
  replyContext?: MailReplyContext;
}

export const mailConversationsApi = {
  list(filters: { mailboxId: string; q: string; unread: boolean }, signal?: AbortSignal) {
    const params = new URLSearchParams({ mailboxId: filters.mailboxId });
    if (filters.q.trim()) params.set('q', filters.q.trim());
    if (filters.unread) params.set('unread', '1');
    return outreachApi<MailConversationList>(`/conversations?${params}`, { signal });
  },
  detail(id: string, signal?: AbortSignal) {
    return outreachApi<MailConversationDetail>(`/conversations/${encodeURIComponent(id)}`, {
      signal,
    });
  },
  sync(mailboxId: string) {
    return outreachApi<{ imported: number; mailboxes: MailboxSyncStatus[] }>(
      '/conversations/sync',
      {
        method: 'POST',
        body: JSON.stringify({ mailboxId }),
      },
    );
  },
  markRead(id: string) {
    return outreachApi<{ conversation: MailThread }>(
      `/conversations/${encodeURIComponent(id)}/read`,
      { method: 'POST', body: JSON.stringify({ unread: false }) },
    );
  },
  draft(id: string, signal?: AbortSignal) {
    return outreachApi<{ draft: MailReplyDraft | null }>(
      `/conversations/${encodeURIComponent(id)}/draft`,
      { signal },
    );
  },
  saveDraft(id: string, draft: MailDraftContent & { revision?: number }) {
    return outreachApi<{ draft: MailReplyDraft }>(
      `/conversations/${encodeURIComponent(id)}/draft`,
      { method: 'PUT', body: JSON.stringify(draft) },
    );
  },
  deleteDraft(id: string, revision: number) {
    return outreachApi<{ draft: null }>(`/conversations/${encodeURIComponent(id)}/draft`, {
      method: 'DELETE',
      body: JSON.stringify({ revision }),
    });
  },
  reply(id: string, value: MailDraftContent & { draftRevision?: number; idempotencyKey: string }) {
    return outreachApi<MailConversationDetail & { reply: MailReplyRecord }>(
      `/conversations/${encodeURIComponent(id)}/reply`,
      { method: 'POST', body: JSON.stringify(value) },
    );
  },
};
