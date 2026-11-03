import type { EmailPurpose } from './email-purpose.mjs';
export interface ContactPresentationRecord {
  label: string;
  value: string;
  quote: string;
  source_url: string;
}
export interface ContactPresentationValue {
  value: string;
  href?: string;
  purpose: EmailPurpose | { type: string; label: string; basis: string };
}
export interface ContactPresentationSocial {
  platform: string;
  url: string;
  href?: string;
  records: ContactPresentationRecord[];
}
export interface ContactPresentationEvidenceGroup {
  id: string;
  label: string;
  value: string;
  records: ContactPresentationRecord[];
}
export interface ContactPresentationLead {
  website?: string;
  email?: string;
  phone?: string;
  contactEvidence?: {
    kind?: string;
    value?: string;
    url?: string;
    normalized?: string;
    quote?: string;
    source_url?: string;
    method?: string;
    verification_status?: string;
  }[];
  social?: { platform?: string; url?: string; quote?: string; source_url?: string }[];
  locationEvidence?: {
    name?: string;
    street?: string;
    city?: string;
    region?: string;
    quote?: string;
    source_url?: string;
  }[];
}
export function buildContactPresentation(lead?: ContactPresentationLead | null): {
  emails: ContactPresentationValue[];
  phones: ContactPresentationValue[];
  social: ContactPresentationSocial[];
  evidenceGroups: ContactPresentationEvidenceGroup[];
};
