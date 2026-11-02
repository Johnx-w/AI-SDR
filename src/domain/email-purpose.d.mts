export interface EmailPurpose {
  type: string;
  label: string;
  basis: string;
  inferred: boolean;
  eligible: boolean;
  priority: number;
  quote: string;
  sourceUrl: string;
  supplierEntry: boolean;
  namedBuyer: boolean;
  productScope: string;
  marketScope: string;
}
export function emailPurpose(
  address: string,
  evidence?: {
    kind?: string;
    value?: string;
    quote?: string;
    source_url?: string;
    sourceUrl?: string;
    method?: string;
    verification_status?: string;
  }[],
  website?: string,
): EmailPurpose;
