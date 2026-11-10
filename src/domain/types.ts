export interface WorkflowInput {
  auto_first_touch?: boolean;
  auto_follow_up?: boolean;
  query_mode?: 'auto';
  product_scope?: 'all' | 'specific';
  environment_preference?: 'all' | 'indoor' | 'outdoor';
  products?: ProductSelection[];
  customer_types?: string[];
  customer_type?: string;
  customer_profile?: string;
  country: string;
  region: string;
  product: string;
  acquisition_channel: 'web' | 'tavily_web';
  research_budget?: number;
  search_query: string;
}
export interface ProductSelection {
  id?: string;
  value: string;
  label: string;
  direction: 'finished' | 'materials' | 'samples';
  group: string;
  selectAll?: boolean;
  aliases: string[];
}
export interface SearchMetric {
  id: string;
  query: string;
  country: string;
  status: string;
  error?: string;
  discovered: number;
  filtered?: number;
  filterReasons?: Record<string, number>;
  duplicates: number;
  queued: number;
  researched: number;
  inserted: number;
  updated: number;
  rejected: number;
  review: number;
  failed: number;
  ratings: Record<string, number>;
  source_kind?: 'web';
  family?: string;
  usage?: {
    returned_records?: number;
    charged_records?: number;
    cache_hits?: number;
    run_reserved_records?: number;
    credits?: number | null;
  } | null;
}
export interface DiscoveryQuery {
  country: string;
  query: string;
  source_kind?: 'web';
  family?: string;
}
export interface IntegrationStatus {
  configured: boolean;
  provider?: 'native';
  nativeReady?: boolean;
  missing?: string[];
  transport: 'direct';
  note: string;
  webProvider?: string;
  modelProvider?: string;
}
export interface AcquisitionJob {
  summary?: boolean;
  updatedAt?: string;
  scheduleId?: string;
  autoFirstTouchPaused?: boolean;
  autoFirstTouchCancelled?: boolean;
  input: WorkflowInput & { target_count: number };
  id: string;
  status: 'running' | 'stopping' | 'paused' | 'completed' | 'partial';
  target: number;
  countPolicy?: string;
  inserted: number;
  updated: number;
  skipped: number;
  rejected: number;
  failed: number;
  pending: number;
  searches: number;
  researched: number;
  review?: number;
  researchUsage?: ResearchUsage;
  searchStats?: SearchMetric[];
  queryPlan?: DiscoveryQuery[];
  message: string;
  createdAt: string;
  completedAt?: string;
  rows: {
    domain?: string;
    source_url?: string;
    source_kind?: 'web';
    result: string;
    name?: string;
    reason?: string;
    record_id?: string;
    executionId?: string;
    search_id?: string;
    search_query?: string;
    assessment?: { grade?: string | null; score: number; status: string } | null;
    handoff?: {
      ready: boolean;
      reasons: string[];
      contact_verified?: boolean;
      contacts?: { kind: string; value: string; source_url: string; quote: string }[];
    };
    review_resolution?: {
      key: string;
      source_url: string;
      operation_id: string;
      status: 'pending' | 'uncertain' | 'inserted' | 'updated' | 'duplicate' | 'review' | 'failed';
      record_id?: string | null;
      reason?: string;
      updated_at: string;
    };
  }[];
}
export interface ResearchUsage {
  model_calls: number;
  cache_hits: number;
  input_chars: number;
  input_tokens?: number;
  output_tokens?: number;
  omitted_pages?: number;
  truncated_pages?: number;
}

export interface ConnectionSettings {
  provider: string;
  ready: boolean;
  fields: {
    key: string;
    label: string;
    secret: boolean;
    configured: boolean;
    value: string;
    maskedValue?: string;
    effectiveValue?: string;
    required?: boolean;
    description?: string;
  }[];
}

export interface ScheduleTiming {
  repeat: 'once' | 'weekly';
  weekdays?: number[];
  startDate: string;
  times: string[];
  timezone: 'Asia/Shanghai';
}

export interface AcquisitionSchedule {
  id: string;
  name: string;
  input: WorkflowInput & { target_count: number };
  timing: ScheduleTiming;
  status: 'enabled' | 'paused' | 'closed' | 'completed';
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastScheduledAt?: string | null;
  lastJobId: string | null;
  lastJob: AcquisitionJob | null;
  lastError: string;
  createdAt: string;
  runs: number;
}
