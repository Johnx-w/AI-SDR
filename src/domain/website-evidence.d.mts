export interface WebsiteEvidenceInput {
  field?: string;
  kind?: string;
  value?: unknown;
  quote?: string;
  source_url?: string;
}
export interface WebsiteEvidenceRecord {
  field: string;
  value: string;
  quote: string;
  source_url: string;
}
export interface WebsiteEvidenceGroup {
  id: string;
  category: string;
  summary: string;
  records: WebsiteEvidenceRecord[];
}
export function websiteEvidenceFieldLabel(field?: string | null): string;
export function groupWebsiteEvidence(
  facts?: WebsiteEvidenceInput[] | null,
  identityEvidence?: WebsiteEvidenceInput[] | null,
): WebsiteEvidenceGroup[];
