export const BUSINESS_REPLY_LABELS: Readonly<
  Record<
    'positive' | 'refusal' | 'referral' | 'notification' | 'bounce' | 'unverified' | 'other',
    string
  >
>;
export const POSITIVE_REQUEST_LABELS: Readonly<Record<'quote' | 'catalog' | 'meeting', string>>;
export function emptyBusinessCounts(): Record<keyof typeof BUSINESS_REPLY_LABELS, number>;
