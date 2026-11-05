import type { OverviewPeriod, OverviewRange } from '../domain/overview-rules.mjs';

export interface OverviewSource {
  state: 'ready' | 'stale' | 'unavailable';
  updatedAt: string | null;
  error: string;
}
export interface OverviewCapture {
  customerId: string;
  name: string;
  domain: string;
  capturedAt: string;
  jobId: string;
  available: boolean | null;
}
export interface OverviewData {
  asOf: string;
  timeZone: 'Asia/Shanghai';
  range: OverviewRange;
  sources: Record<'customers' | 'business' | 'acquisition' | 'products', OverviewSource>;
  metrics: {
    companies: number | null;
    newCompanies: number | null;
    activeDemands: number | null;
    dueTasks: number | null;
  };
  work: { overdue: number | null; today: number | null; paused: number | null };
  links: {
    companies: string;
    newCompanies: string;
    activeDemands: string;
    dueTasks: string;
    overdue: string;
    today: string;
    paused: string;
  };
  priority: {
    customerId: string;
    name: string;
    market: string;
    grade: string;
    reason: string;
    action: string;
    dueAt?: string;
    owner?: string;
    to: string;
  }[];
  jobs: {
    id: string;
    title: string;
    status: string;
    inserted: number;
    target: number;
    updated: number;
    pending: number;
    reason: string;
    createdAt: string;
    updatedAt?: string;
    to: string;
  }[];
  schedules: { id: string; name: string; status: string; nextRunAt: string | null; to: string }[];
  trend: { date: string; count: number | null }[];
  captures: OverviewCapture[];
  stages: { stage: string; label: string; count: number; to: string }[];
  products: { draft: number | null; to: string; syncIssues: number | null };
  coverage: { recordedOnly: true; note: string };
}

export const overviewApi = {
  async get(
    period: OverviewPeriod = '7d',
    signal?: AbortSignal,
    asOf?: string,
  ): Promise<OverviewData> {
    const params = new URLSearchParams({ period });
    if (asOf) params.set('asOf', asOf);
    const response = await fetch(`/api/v1/overview?${params}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw new Error(body?.error || '运营总览读取失败，请稍后重试');
    return body as OverviewData;
  },
};
