export const deliveryGroupLabels = {
  pending: '待发送',
  sent: '已发送',
  attention: '需处理',
  skipped: '已跳过',
  cancelled: '已取消',
};

export function deliveryGroup({ status, subject }) {
  if (status === 'accepted') return 'sent';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'skipped') return 'skipped';
  if (status === 'queued' || status === 'sending' || (status === 'draft' && !subject))
    return 'pending';
  return 'attention';
}
