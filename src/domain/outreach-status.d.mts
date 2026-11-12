export type DeliveryGroup = 'pending' | 'sent' | 'attention' | 'skipped' | 'cancelled';
export const deliveryGroupLabels: Record<DeliveryGroup, string>;
export function deliveryGroup(delivery: { status: string; subject?: string }): DeliveryGroup;
