export interface AssessmentDimensionFact {
  kind: string;
  value: string;
  quote: string;
  source_url: string;
  origin?: string;
  confirmationId?: string;
  confirmedBy?: string;
  confirmedAt?: string;
}
export interface PresentedAssessmentDimension {
  key: string;
  name: string;
  score: number | null;
  maximum: number;
  conclusion: string;
  basis: string[];
  facts: AssessmentDimensionFact[];
  missing: string;
  conflict?: boolean;
}
interface DimensionInput {
  score: number | null;
  maximum: number;
  missing?: string;
  conflict?: boolean;
  facts?: {
    kind?: string;
    value?: unknown;
    quote?: string;
    source_url?: string;
    origin?: string;
    confirmationId?: string;
    confirmedBy?: string;
    confirmedAt?: string;
  }[];
}
export function buildAssessmentDimensions(
  assessment?: {
    product?: string | null;
    direction?: string | null;
    evidenceReason?: string;
    dimensions?: Record<string, DimensionInput>;
  } | null,
  ratingReason?: string,
): PresentedAssessmentDimension[];
