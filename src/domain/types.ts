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
export interface AcquisitionDiscoverySource {
  kind: 'web' | 'maps';
  source_url?: string;
  provider?: string;
  reference?: string;
  mentioned_company?: string;
  job_id: string;
  discovered_at: string;
}
export interface SearchMetric {
  id: string;
  query: string;
  country: string;
  language?: string;
  batch?: number;
  status: string;
  error?: string;
  discovered: number;
  filtered?: number;
  filterReasons?: Record<string, number>;
  filteredSources?: { domain: string; reason: string }[];
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
  maps?: {
    status: string;
    reason?: string;
    attempts: number;
    returned: number;
    resolved: number;
    usage?: { credits: number };
  };
}
export interface DiscoveryQuery {
  country: string;
  query: string;
  language?: string;
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
export interface WebsiteCollectionAttempt {
  snapshot_id: string;
  requested_url: string;
  final_url?: string | null;
  acquired_at: string;
  method: string;
  status: string;
  reason: string;
  failure_reason?: string;
  reused?: boolean;
  resource_wait?: { reason: string; wait_ms: number; end?: string };
}
export interface AcquisitionReviewDecision {
  source_url: string;
  company_name: string;
  identity_quote: string;
  operating_quote: string;
  product: string;
  admission_fact: string;
  reason: string;
}
export interface AcquisitionPaidRequest {
  id: string;
  kind: string;
  provider: string;
  status: 'pending' | 'completed' | 'failed' | 'unknown';
  started_at: string;
  usage?: { credits: number };
}
export interface AcquisitionCurrentProgress {
  id: string;
  stage: string;
  collection_attempts: WebsiteCollectionAttempt[];
  requests: AcquisitionPaidRequest[];
  research_usage?: ResearchUsage;
  web_usage?: { web_extract_calls: number; web_extract_credits?: number };
}
export interface AcquisitionJob {
  manualPaused?: boolean;
  sourcePause?: { outreachPlanId?: string; reason: string };
  sourceControlRevision?: number;
  sourceDeletedAt?: string;
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
  admissionVersion?: string;
  identityVersion?: string;
  executionVersion?: string;
  batch?: { number: number; previousBoundary?: string };
  coverage?: { countries: string[]; languages: string[] };
  remainingTarget?: number;
  insertedPerHour?: number | null;
  collectionWait?: { reason: string; url: string };
  currentProgress?: AcquisitionCurrentProgress;
  inserted: number;
  manualInserted?: number;
  confirmedInserted?: number;
  updated: number;
  skipped: number;
  rejected: number;
  failed: number;
  pending: number;
  searches: number;
  carriedCandidates?: number;
  researched: number;
  review?: number;
  researchUsage?: ResearchUsage;
  searchStats?: SearchMetric[];
  mapComparison?: {
    pausedReason?: string;
    qualifiedNew: {
      websiteOnly: number;
      mapsOnly: number;
      both: number;
      mapsAndScrapling: number;
      scraplingOnly: number;
    };
    maps: { calls: number; reportedSearches: number; reportedCredits: number };
    website: { reportedSearches: number; reportedCredits: number };
  };
  queryPlan?: DiscoveryQuery[];
  message: string;
  createdAt: string;
  completedAt?: string;
  rows: {
    domain?: string;
    source_url?: string;
    source_kind?: 'web' | 'maps';
    discovery_sources?: AcquisitionDiscoverySource[];
    unverified_map_sources?: AcquisitionDiscoverySource[];
    result: string;
    name?: string;
    reason?: string;
    record_id?: string;
    executionId?: string;
    search_id?: string;
    search_query?: string;
    collection_attempts?: WebsiteCollectionAttempt[];
    paid_requests?: AcquisitionPaidRequest[];
    web_usage?: { web_extract_calls: number; web_extract_credits?: number };
    assessment?: { grade?: string | null; score: number; status: string } | null;
    handoff?: {
      ready: boolean;
      reasons: string[];
      contact_verified?: boolean;
      contacts?: {
        kind: string;
        value: string;
        source_url: string;
        quote: string;
        form_id?: string;
      }[];
    };
    review_resolution?: {
      key: string;
      source_url: string;
      operation_id: string;
      status: 'pending' | 'uncertain' | 'inserted' | 'updated' | 'duplicate' | 'review' | 'failed';
      record_id?: string | null;
      reason?: string;
      updated_at: string;
      actor?: string;
      submitted_at?: string;
      decided_at?: string;
      decision?: AcquisitionReviewDecision;
    };
  }[];
}
export interface ResearchUsage {
  model_calls: number;
  repeat_model_calls?: number;
  cache_hits: number;
  input_chars: number;
  input_tokens?: number;
  input_cached_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
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
  timezone: string;
  waitForPrevious?: boolean;
}

export interface AcquisitionSchedule {
  sourcePause?: { outreachPlanId?: string; reason: string };
  sourceControlRevision?: number;
  sourceDeletedAt?: string;
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
