import type {
  AcquisitionJob,
  IntegrationStatus,
  WorkflowInput,
  WorkflowRun,
} from '../domain/types';

export const WORKFLOW_URL = 'https://vynox.app.n8n.cloud/workflow/EycE9OmaPkRFUDSq';
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/integrations/n8n${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(125000),
  });
  const body = await response.json().catch(() => ({ error: '服务未返回有效 JSON' }));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body as T;
}
export const n8nApi = {
  jobs: () => request<{ jobs: AcquisitionJob[] }>('/jobs'),
  job: (id: string) => request<AcquisitionJob>(`/jobs/${encodeURIComponent(id)}`),
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
  searchQuery: (input: WorkflowInput) =>
    request<{ search_query: string; provider: string; model: string }>('/search-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(40000),
    }),
  run: (input: WorkflowInput, requestId: string) =>
    request<WorkflowRun>('/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
      body: JSON.stringify(input),
    }),
  executions: () =>
    request<{
      data: { id: string; status: string; startedAt: string; stoppedAt: string | null }[];
    }>('/executions'),
};

export interface LocationOptions {
  markets: { value: string; label: string }[];
  countries: string[];
  country: string;
  region: string;
  regions: { name: string; code: string; label?: string }[];
}
