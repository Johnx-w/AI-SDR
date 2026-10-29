import type { AssessmentSummary } from '../components/AssessmentPanel';
import type { CustomsBuyerEvidence } from '../domain/types';
import type { ManualConfirmation } from './leadSupplements';

export interface Prospect {
  id: string;
  name: string;
  companyIdentity?: {
    legal_name: string | null;
    website_name: string | null;
    aliases: string[];
    status: string;
    notes?: string[];
    evidence: { field: string; value: string; quote: string; source_url: string }[];
  } | null;
  domain: string;
  market: string;
  type: string;
  product: string;
  match: string;
  score: number | null;
  grade: string;
  ratingReason?: string;
  assessment?: AssessmentSummary | null;
  confirmations?: ManualConfirmation[];
  manualPurchaseNeed?: string;
  customsEvidence?: CustomsBuyerEvidence[];
  status: string;
  region: string;
  city: string;
  address?: string;
  serviceAreas?: string;
  mainProductPreference?: string;
  advertisingCodes?: string;
  demandProducts?: string;
  supplyOpportunity?: string;
  pendingQuestions?: string;
  industryProfile?: string;
  audience?: string;
  social?: { platform: string; url: string; quote: string; source_url: string }[];
  locationEvidence?: {
    name?: string;
    street?: string;
    city?: string;
    region?: string;
    quote: string;
    source_url: string;
  }[];
  contact: string;
  email: string;
  phone: string;
  website: string;
  source: string;
  evidence: string;
  facts: { field: string; value: string; quote: string; source_url?: string }[];
  contactEvidence: { kind: string; value: string; quote: string; source_url: string }[];
  createdAt?: number | null;
  updatedAt: string | number | null;
  fields: Record<string, string>;
}

export type LeadSummary = Pick<
  Prospect,
  | 'id'
  | 'name'
  | 'domain'
  | 'market'
  | 'type'
  | 'product'
  | 'score'
  | 'grade'
  | 'status'
  | 'city'
  | 'contact'
  | 'email'
  | 'phone'
  | 'website'
  | 'source'
  | 'createdAt'
  | 'updatedAt'
> & {
  version: string;
  companyIdentity?: Omit<NonNullable<Prospect['companyIdentity']>, 'evidence' | 'notes'> | null;
  ratingSummary: string;
  contactSummary: { label: string; detail: string };
  customsSummary: { recordCount: number; buyerCount: number; unverified: boolean };
};

export interface LeadMetadata {
  syncedAt: string | null;
  total: number;
  source: 'feishu';
  scope: string;
  sync: {
    refreshing: boolean;
    stale: boolean;
    error: string;
    lastAttemptAt: string | null;
    revision: number | string;
    mode?: 'active' | 'idle';
    intervalMs?: number;
    metrics?: {
      attempts: number;
      successes: number;
      failures: number;
      last: {
        at: string;
        status: string;
        durationMs: number;
        upstreamMs: number;
        writeMs: number;
        total: number;
        inserted: number;
        updated: number;
        deleted: number;
        unchanged: number;
        rowsWritten: number;
      } | null;
    };
  };
}
export interface LeadList extends LeadMetadata {
  leads: LeadSummary[];
}
interface LeadDetail extends LeadMetadata {
  lead: Prospect;
  version: string;
}

interface LibraryPollingOptions {
  read: () => Promise<unknown>;
  isRefreshing: () => boolean;
  visibility?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  setTimer?: (callback: () => void, delay: number) => number;
  clearTimer?: (timer: number) => void;
}

// Timers and visibility are explicit dependencies so the lifecycle can be
// exercised without rendering React or relying on browser timer throttling.
export function startLeadLibraryPolling({
  read,
  isRefreshing,
  visibility = document,
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (timer) => window.clearTimeout(timer),
}: LibraryPollingOptions) {
  let timer: number | undefined;
  let stopped = false;
  let running = false;
  let resumePending = false;
  const clear = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (!stopped && visibility.visibilityState === 'visible')
      timer = setTimer(() => void tick(), isRefreshing() ? 1000 : 60000);
  };
  const tick = async () => {
    if (stopped || running || visibility.visibilityState !== 'visible') return;
    running = true;
    try {
      await read();
    } catch {
      // The page presents read failures; keep the polling lifecycle independent.
    } finally {
      running = false;
      if (resumePending && !stopped && visibility.visibilityState === 'visible') {
        resumePending = false;
        void tick();
      } else schedule();
    }
  };
  const onVisibility = () => {
    clear();
    resumePending = running && visibility.visibilityState === 'visible';
    if (visibility.visibilityState === 'visible') void tick();
  };
  visibility.addEventListener('visibilitychange', onVisibility);
  void tick();
  return () => {
    stopped = true;
    clear();
    visibility.removeEventListener('visibilitychange', onVisibility);
  };
}

// Shared across route changes. Requests belong to this cache, rather than to a
// mounted page, so StrictMode and quick navigation can share the same work.
export class LeadLibraryClient {
  private snapshot: LeadList | null = null;
  private listeners = new Set<() => void>();
  private details = new Map<string, Prospect>();
  private detailVersions = new Map<string, string | null>();
  private detailRequests = new Map<
    string,
    { version: string | null; mutation: number; promise: Promise<Prospect> }
  >();
  private listRequest: Promise<LeadList> | null = null;
  private refreshRequest: Promise<LeadList> | null = null;
  private sequence = 0;
  private acceptedSequence = 0;
  private mutations = new Map<string, number>();
  private mutationSequence = 0;
  private epoch = 0;

  constructor(
    private fetchImpl: typeof fetch = (...args) => fetch(...args),
    private isActive = () =>
      typeof document !== 'undefined' && document.visibilityState === 'visible',
  ) {}

  cachedList() {
    return this.snapshot;
  }
  cachedDetail(id: string | null) {
    return id ? this.details.get(id) || null : null;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  reset() {
    this.epoch++;
    this.acceptedSequence = ++this.sequence;
    this.mutationSequence = this.acceptedSequence;
    this.snapshot = null;
    this.details.clear();
    this.detailVersions.clear();
    this.mutations.clear();
    this.detailRequests.clear();
    this.listRequest = null;
    this.refreshRequest = null;
    this.emit();
  }
  private emit() {
    this.listeners.forEach((listener) => listener());
  }
  private async request<T>(path: string, method = 'GET', active = false): Promise<T> {
    const response = await this.fetchImpl(path, {
      method,
      cache: 'no-store',
      ...(active ? { headers: { 'X-Lead-Library-Activity': 'active' } } : {}),
      signal: AbortSignal.timeout(45000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || '客户数据读取失败，请重试');
    if (!data || typeof data.scope !== 'string' || !data.sync)
      throw new Error('客户数据格式异常，请更新页面后重试');
    return data;
  }
  private versionFor(id: string, snapshot = this.snapshot) {
    const summary = snapshot?.leads.find((lead) => lead.id === id);
    if (!summary) return null;
    return summary.version || `revision:${snapshot!.sync.revision}`;
  }
  private freshDetail(id: string) {
    const value = this.cachedDetail(id);
    return value && this.detailVersions.get(id) === this.versionFor(id) ? value : null;
  }
  private acceptList(data: LeadList, sequence: number) {
    if (!Array.isArray(data.leads)) throw new Error('客户列表数据不完整，请重试');
    const sameScope = this.snapshot?.scope === data.scope;
    const revision = Number(data.sync.revision);
    const currentRevision = Number(this.snapshot?.sync.revision);
    const comparable = sameScope && Number.isFinite(revision) && Number.isFinite(currentRevision);
    if (
      sequence < this.mutationSequence ||
      (comparable && revision < currentRevision) ||
      (sequence < this.acceptedSequence && !(comparable && revision > currentRevision))
    ) {
      if (this.snapshot) return this.snapshot;
      throw new Error('客户连接已变更，请重新读取列表');
    }
    this.acceptedSequence = Math.max(sequence, this.acceptedSequence);
    if (!sameScope || this.snapshot?.sync.revision !== data.sync.revision) {
      // Keep a displayed dossier during same-table revalidation. Clearing it
      // would unmount edit forms and discard drafts on every background sync.
      if (!sameScope) {
        if (this.snapshot) this.epoch++;
        this.details.clear();
        this.detailVersions.clear();
        this.mutations.clear();
      } else {
        const ids = new Set(data.leads.map((lead) => lead.id));
        for (const id of this.details.keys()) {
          if (!ids.has(id)) {
            this.details.delete(id);
            this.detailVersions.delete(id);
          }
        }
      }
      for (const [id, request] of this.detailRequests) {
        if (!sameScope || request.version !== this.versionFor(id, data))
          this.detailRequests.delete(id);
      }
    }
    this.snapshot = data;
    this.emit();
    return data;
  }
  list(): Promise<LeadList> {
    if (this.listRequest) return this.listRequest;
    const sequence = ++this.sequence;
    const epoch = this.epoch;
    const request = this.request<LeadList>('/api/v1/leads/real/list', 'GET', this.isActive()).then(
      (data) => {
        if (epoch !== this.epoch) throw new Error('客户连接已变更，请重新读取列表');
        return this.acceptList(data, sequence);
      },
    );
    this.listRequest = request;
    void request
      .finally(() => {
        if (this.listRequest === request) this.listRequest = null;
      })
      .catch(() => {});
    return request;
  }
  async revalidateList(): Promise<LeadList> {
    if (this.listRequest) await this.listRequest.catch(() => {});
    return this.list();
  }
  refresh(): Promise<LeadList> {
    if (this.refreshRequest) return this.refreshRequest;
    const sequence = ++this.sequence;
    const epoch = this.epoch;
    const request = this.request<LeadList>('/api/v1/leads/real/refresh', 'POST').then((data) => {
      if (epoch !== this.epoch) throw new Error('客户连接已变更，请重新读取列表');
      return this.acceptList(data, sequence);
    });
    this.refreshRequest = request;
    void request
      .finally(() => {
        if (this.refreshRequest === request) this.refreshRequest = null;
      })
      .catch(() => {});
    return request;
  }
  detail(id: string): Promise<Prospect> {
    const cached = this.freshDetail(id);
    if (cached) return Promise.resolve(cached);
    const version = this.versionFor(id);
    const mutation = this.mutations.get(id) || 0;
    const existing = this.detailRequests.get(id);
    if (existing && existing.version === version && existing.mutation === mutation)
      return existing.promise;
    const epoch = this.epoch;
    const scope = this.snapshot?.scope;
    const request = this.request<LeadDetail>('/api/v1/leads/real/' + encodeURIComponent(id)).then(
      (data) => {
        if (!data.lead || data.lead.id !== id) throw new Error('未收到完整客户档案，请重试');
        if (epoch !== this.epoch || mutation !== (this.mutations.get(id) || 0)) {
          const current = this.freshDetail(id);
          if (current) return current;
          throw new Error('客户资料已更新，请重新读取档案');
        }
        if (
          (scope && data.scope !== scope) ||
          (this.snapshot && data.scope !== this.snapshot.scope)
        ) {
          // If this request preceded the first list, the current list already
          // identifies the right scope. Never clear it for an older reply.
          if (scope === this.snapshot?.scope) {
            this.reset();
            void this.list().catch(() => {});
          }
          throw new Error('客户连接已变更，正在重新加载列表');
        }
        // A background sync may finish between the list and detail requests.
        // Revalidate the list instead of associating a new detail with old rows.
        const responseVersion = data.version || `revision:${data.sync.revision}`;
        if (this.snapshot && responseVersion !== this.versionFor(id)) {
          const current = this.freshDetail(id);
          if (current) return current;
          void this.list().catch(() => {});
          throw new Error('客户资料已更新，请重试打开档案');
        }
        this.details.set(id, data.lead);
        this.detailVersions.set(id, responseVersion);
        this.emit();
        return data.lead;
      },
    );
    this.detailRequests.set(id, { version, mutation, promise: request });
    void request
      .finally(() => {
        if (this.detailRequests.get(id)?.promise === request) this.detailRequests.delete(id);
      })
      .catch(() => {});
    return request;
  }
  updateDetail(id: string, saved: Partial<Prospect>) {
    this.mutations.set(id, (this.mutations.get(id) || 0) + 1);
    this.acceptedSequence = ++this.sequence;
    this.mutationSequence = this.acceptedSequence;
    this.listRequest = null;
    const current = this.details.get(id);
    if (current) {
      this.details.set(id, { ...current, ...saved });
      this.detailVersions.set(id, this.versionFor(id));
    }
    this.detailRequests.delete(id);
    this.emit();
  }
  async exportDetails(): Promise<Prospect[]> {
    const scope = this.snapshot?.scope;
    const epoch = this.epoch;
    const data = await this.request<LeadList & { leads: Prospect[] }>('/api/v1/leads/real');
    if (epoch !== this.epoch || (scope && data.scope !== scope))
      throw new Error('客户连接已变更，请刷新列表后重新导出');
    if (!Array.isArray(data.leads)) throw new Error('客户导出数据不完整，请重试');
    return data.leads;
  }
}

export const leadLibrary = new LeadLibraryClient();
