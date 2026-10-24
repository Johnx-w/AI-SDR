export type SupplementCategory = 'assessment' | 'legal_name' | 'purchase_need' | 'profile';
export type SupplementDimension = 'P' | 'R' | 'D' | 'V';
export type SupplementDirection = 'finished' | 'materials' | 'samples';

export interface SupplementContext {
  category: SupplementCategory;
  dimension?: SupplementDimension;
  pendingItem?: string;
  product?: string;
  direction?: string;
}

export interface SupplementAssessment {
  id: string;
  product?: string;
  direction?: string;
  opportunities?: { product: string; direction: string }[];
}

export interface SupplementInput {
  expectedAssessmentId: string | null;
  category: SupplementCategory;
  dimension?: SupplementDimension;
  product?: string;
  direction?: SupplementDirection;
  content: string;
  evidence: string;
  sourceUrl?: string;
  confirmedBy: string;
  facts?: { kind: string; value: string }[];
  pendingItem?: string;
  sourceMessageId?: string;
}

export interface ManualConfirmation extends Omit<SupplementInput, 'expectedAssessmentId'> {
  id: string;
  confirmedAt: string;
}

export class LeadSupplementRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function pendingLeadSupplement(
  leadId: string,
  signal?: AbortSignal,
): Promise<{ pending: { input: SupplementInput; key: string } | null }> {
  const response = await fetch(`/api/v1/leads/real/${encodeURIComponent(leadId)}/supplements`, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new LeadSupplementRequestError(
      response.status === 404
        ? '页面与后台版本不一致，请更新并重启后台服务后重试。'
        : result?.error || `上次保存状态读取失败（${response.status}）`,
      response.status,
    );
  if (!result || !Object.hasOwn(result, 'pending'))
    throw new Error('未收到上次保存状态，请重试核对');
  return result;
}

export async function saveLeadSupplement<TLead>(
  leadId: string,
  input: SupplementInput,
  key: string,
): Promise<{ lead: TLead; confirmation: ManualConfirmation }> {
  const response = await fetch(`/api/v1/leads/real/${encodeURIComponent(leadId)}/supplements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new LeadSupplementRequestError(
      response.status === 404
        ? '页面与后台版本不一致，请更新并重启后台服务后重试。'
        : result?.error || `补充资料保存失败（${response.status}）`,
      response.status,
    );
  if (!result?.lead || !result?.confirmation)
    throw new Error('未收到完整保存结果，请保留内容并重试核对');
  return result;
}
