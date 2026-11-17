export type DeliveryGroup = 'pending' | 'sent' | 'attention' | 'resolved' | 'skipped' | 'cancelled';
export const deliveryGroupLabels: Record<DeliveryGroup, string>;
export function deliveryGroup(delivery: {
  status: string;
  subject?: string;
  resolution?: { outcome?: string };
}): DeliveryGroup;
