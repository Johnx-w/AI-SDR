export type Market = '美国' | '澳大利亚' | '英国' | '阿联酋';
export type Grade = 'A' | 'B' | 'C';
export type LeadStatus = '待开发' | '跟进中' | '已回复' | '暂缓开发';
export interface Lead {
  id: string;
  name: string;
  initials: string;
  color: string;
  market: Market;
  region: string;
  city: string;
  type: string;
  product: string;
  grade: Grade;
  score: number;
  status: LeadStatus;
  source: string;
  contact: string;
  email: string;
  website: string;
  lastActivity: string;
  evidence: string;
  intent: string;
}
export interface Campaign {
  id: string;
  name: string;
  market: Market;
  channel: string;
  status: '运行中' | '已暂停' | '草稿';
  total: number;
  sent: number;
  replies: number;
  steps: string[];
}
export interface Conversation {
  id: string;
  leadId: string;
  subject: string;
  preview: string;
  body: string;
  time: string;
  unread: boolean;
  channel: string;
  draft: string;
  reviewed?: boolean;
  attachments?: string[];
  classification?: '真人回复' | '自动回复' | '联系方式失效' | '拒绝联系';
}
export interface Task {
  id: string;
  title: string;
  detail: string;
  time: string;
  done: boolean;
  kind: '跟进' | '研究' | '审核';
}
export interface Preferences {
  timezone: string;
  market: Market;
  reviewBeforeSend: boolean;
  dailyLimit: number;
  cooldownHours?: number;
}
export interface Workspace {
  schemaVersion: 1;
  leads: Lead[];
  campaigns: Campaign[];
  conversations: Conversation[];
  tasks: Task[];
  preferences: Preferences;
}
export interface WorkspaceRepository {
  load(): Promise<Workspace>;
  save(data: Workspace): Promise<void>;
  reset(): Promise<Workspace>;
}
export interface WorkflowInput {
  audience: 'B' | 'C' | 'BC';
  customer_type?: string;
  customer_profile?: string;
  country: string;
  region: string;
  product: string;
  acquisition_channel: 'tavily_web';
  search_query: string;
}
export interface IntegrationStatus {
  configured: boolean;
  provider?: 'n8n' | 'native';
  nativeReady?: boolean;
  missing?: string[];
  workflowId: string;
  editorUrl: string;
  transport: 'webhook' | 'direct';
  note: string;
}
export interface WorkflowRun {
  requestId: string;
  status: 'completed';
  summary: {
    outcome: 'completed' | 'partial' | 'failed' | 'review' | 'no_new_candidates' | 'unconfirmed';
    message: string;
    inserted?: number;
    updated?: number;
    failed?: number;
    review?: number;
    executionId?: string;
  };
  result: unknown;
  completedAt: string;
}

export interface AcquisitionJob {
  input: WorkflowInput & { target_count: number };
  id: string;
  status: 'running' | 'stopping' | 'paused' | 'completed' | 'partial';
  target: number;
  inserted: number;
  updated: number;
  skipped: number;
  rejected: number;
  failed: number;
  pending: number;
  searches: number;
  researched: number;
  message: string;
  createdAt: string;
  completedAt?: string;
  rows: {
    domain: string;
    source_url: string;
    result: string;
    name?: string;
    reason?: string;
    record_id?: string;
    executionId?: string;
  }[];
}
