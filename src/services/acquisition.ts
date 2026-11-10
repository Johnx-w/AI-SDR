import type {
  AcquisitionJob,
  IntegrationStatus,
  WorkflowInput,
  AcquisitionSchedule,
  ScheduleTiming,
  ConnectionSettings,
  ProductSelection,
  DiscoveryQuery,
} from '../domain/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/acquisition${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(125000),
  });
  const body = await response.json().catch(() => ({ error: '服务未返回有效 JSON' }));
  if (!response.ok)
    throw Object.assign(new Error(body.error || `请求失败 (${response.status})`), {
      status: response.status,
    });
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
  schedules: () => request<{ schedules: AcquisitionSchedule[] }>('/schedules'),
  setAutomaticFirstTouch: (kind: 'schedules' | 'jobs', id: string, enabled: boolean) =>
    request<AcquisitionSchedule | AcquisitionJob>(
      `/${kind}/${encodeURIComponent(id)}/auto-first-touch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
    ),
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
  ) =>
    request<AcquisitionSchedule>(`/schedules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, input: { ...input, target_count }, timing }),
    }),
  controlSchedule: (id: string, action: 'pause' | 'resume' | 'close') =>
    request<AcquisitionSchedule>(`/schedules/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
    }),
  jobs: () => request<{ jobs: AcquisitionJob[] }>('/jobs'),
  job: (id: string) => request<AcquisitionJob>(`/jobs/${encodeURIComponent(id)}`),
  reviewEvidence: (jobId: string, index: number) =>
    request<{
      resolution: AcquisitionJob['rows'][number]['review_resolution'] | null;
      evidence: {
        company_name: string | null;
        identity_status: string;
        product_match: string;
        products: string[];
        checked_urls: string[];
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
  controlJob: (id: string, action: 'stop' | 'resume') =>
    request<AcquisitionJob>(`/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
  status: () => request<IntegrationStatus>('/status'),
  locations: (country: string, region: string, signal?: AbortSignal) =>
    request<LocationOptions>(`/locations?${new URLSearchParams({ country, region })}`, { signal }),
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

export interface LocationOptions {
  markets: { value: string; label: string }[];
  countries: string[];
  country: string;
  region: string;
  regions: { name: string; code: string; label?: string }[];
}
