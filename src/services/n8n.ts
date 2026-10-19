import type { IntegrationStatus, WorkflowInput, WorkflowRun } from '../domain/types';

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
  country: string;
  region: string;
  regions: { name: string; code: string }[];
  cities: string[];
}
