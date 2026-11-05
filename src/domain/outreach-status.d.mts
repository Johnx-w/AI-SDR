export type DeliveryGroup = 'pending' | 'sent' | 'attention' | 'cancelled';
export const deliveryGroupLabels: Record<DeliveryGroup, string>;
export function deliveryGroup(delivery: { status: string; subject?: string }): DeliveryGroup;
