import type {
  AcquisitionJob,
  IntegrationStatus,
  WorkflowInput,
  AcquisitionSchedule,
  ScheduleTiming,
  ConnectionSettings,
  ProductSelection,
  DiscoveryQuery,
  WebsiteCollectionAttempt,
} from '../domain/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/acquisition${path}`, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(125000)])
      : AbortSignal.timeout(125000),
  });
  const body = await response.json().catch(() => {
    throw new Error('服务未返回有效 JSON，请重试');
  });
  if (!response.ok)
    throw Object.assign(new Error(body?.error || `请求失败 (${response.status})`), {
      status: response.status,
    });
  return body as T;
}
async function list<T>(name: 'jobs' | 'schedules'): Promise<T> {
  const body = await request<Record<string, unknown>>(`/${name}?summary=1`);
  if (!Array.isArray(body?.[name])) throw new Error('服务返回的列表格式不正确，请重试');
  return body as T;
}
export const acquisitionApi = {
  products: () => request<{ products: ProductSelection[] }>('/products'),
  saveProduct: (product: ProductSelection) =>
    request<ProductSelection>('/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(product),
    }),
  searchPreview: (input: WorkflowInput, signal?: AbortSignal) =>
    request<{ queries: DiscoveryQuery[] }>('/search-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    }),
  schedules: () => list<{ schedules: AcquisitionSchedule[] }>('schedules'),
  setAutomaticFirstTouch: (
    kind: 'schedules' | 'jobs',
    id: string,
    enabled: boolean,
    sourceControlRevision?: number,
  ) =>
    request<AcquisitionSchedule | AcquisitionJob>(
      `/${kind}/${encodeURIComponent(id)}/auto-first-touch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, sourceControlRevision }),
      },
    ),
  cancelAutomaticFirstTouch: (id: string) =>
    request<AcquisitionJob>(`/jobs/${encodeURIComponent(id)}/auto-first-touch/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    }),
  createSchedule: (
    name: string,
    input: WorkflowInput,
    target_count: number,
    timing: ScheduleTiming,
    key: string,
  ) =>
    request<AcquisitionSchedule>('/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ name, input: { ...input, target_count }, timing }),
    }),
  updateSchedule: (
    id: string,
    name: string,
    input: WorkflowInput,
    target_count: number,
    timing: ScheduleTiming,
    sourceControlRevision?: number,
  ) =>
    request<AcquisitionSchedule>(`/schedules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        input: { ...input, target_count },
        timing,
        sourceControlRevision,
      }),
    }),
  controlSchedule: (
    id: string,
    action: 'pause' | 'resume' | 'close' | 'delete',
    sourceControlRevision?: number,
  ) =>
    request<AcquisitionSchedule>(`/schedules/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceControlRevision }),
    }),
  jobs: () => list<{ jobs: AcquisitionJob[] }>('jobs'),
  job: (id: string, signal?: AbortSignal) =>
    request<AcquisitionJob>(`/jobs/${encodeURIComponent(id)}`, { signal }),
  reviewEvidence: (jobId: string, index: number) =>
    request<{
      resolution: AcquisitionJob['rows'][number]['review_resolution'] | null;
      evidence: {
        company_name: string | null;
        identity_status: string;
        product_match: string;
        products: string[];
        checked_urls: string[];
        collection_attempts?: WebsiteCollectionAttempt[];
        facts: { field: string; value: string; quote: string; source_url: string }[];
      } | null;
    }>(`/jobs/${encodeURIComponent(jobId)}/reviews/${index}`),
  reviewCandidate: (jobId: string, index: number, sourceUrl: string, key: string) =>
    request<{ resolution: NonNullable<AcquisitionJob['rows'][number]['review_resolution']> }>(
      `/jobs/${encodeURIComponent(jobId)}/reviews/${index}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ source_url: sourceUrl }),
      },
    ),
  createJob: (input: WorkflowInput, target_count: number, requestId: string) =>
    request<AcquisitionJob>('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
      body: JSON.stringify({ ...input, target_count }),
    }),
  controlJob: (
    id: string,
    action: 'stop' | 'resume' | 'pause' | 'delete',
    sourceControlRevision?: number,
  ) =>
    request<AcquisitionJob>(`/jobs/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceControlRevision }),
    }),
  status: () => request<IntegrationStatus>('/status'),
};

async function connectionsRequest(init?: RequestInit): Promise<ConnectionSettings> {
  const response = await fetch('/api/v1/connections', {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({ error: '服务未返回有效 JSON' }));
  if (!response.ok) throw new Error(body.error || '连接设置读取失败');
  return body;
}
export const connectionsApi = {
  get: () => connectionsRequest(),
  save: (values: Record<string, string>, clear: string[]) =>
    connectionsRequest({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values, clear }),
    }),
};
