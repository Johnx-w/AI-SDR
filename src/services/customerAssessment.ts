import type { AssessmentDimensionFact } from '../domain/assessment-dimensions.mjs';

export type AssessmentFact = AssessmentDimensionFact;
export interface AssessmentDimension {
  score: number | null;
  maximum: number;
  missing?: string;
  conflict?: boolean;
  facts?: AssessmentFact[];
}
export interface AssessmentOpportunity {
  direction?: string;
  product?: string;
  grade?: string | null;
  status?: string;
  matchLevel?: string;
  relationship?: string;
  basisProduct?: string;
  targetProduct?: string;
  prioritySignals?: { kind: string; label: string; quote: string; source_url: string }[];
  facts?: AssessmentFact[];
  dimensions?: Record<string, AssessmentDimension>;
  missing?: string[];
}
export interface AssessmentSummary extends AssessmentOpportunity {
  id: string;
  score: number;
  complete: boolean;
  ruleVersion: string;
  evaluatedAt?: string;
  evidenceReason?: string;
  incompleteReason?: string | null;
  manualOverride?: boolean;
  opportunities?: (AssessmentOpportunity & { direction: string; product: string })[];
  supplyOpportunity?: { targetProduct?: string; procurementStatus?: string; note?: string } | null;
}
