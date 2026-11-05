export const deliveryGroupLabels = {
  pending: '待发送',
  sent: '已发送',
  attention: '需处理',
  cancelled: '已取消',
};

export function deliveryGroup({ status, subject }) {
  if (status === 'accepted') return 'sent';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'queued' || status === 'sending' || (status === 'draft' && !subject))
    return 'pending';
  return 'attention';
}
