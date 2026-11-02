export function summarizeRunOutput(output) {
  const payload = output;
  if (
    payload == null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length === 0
  )
    throw new Error(
      '获客返回空结果或业务结果格式无效，无法确认客户保存。请查看执行记录，勿直接重复提交。',
    );
  if (payload?.outcome) {
    const inserted = Number(payload['新增']) || 0;
    const updated = Number(payload['更新']) || 0;
    const failed = Number(payload['失败']) || 0;
    const review = Number(payload['待人工查重']) || 0;
    const outcome = ['completed', 'partial', 'failed', 'review', 'no_new_candidates'].includes(
      payload.outcome,
    )
      ? payload.outcome
      : 'unconfirmed';
    return {
      outcome,
      message: String(payload.reason || '请查看获客明细与执行记录。'),
      inserted,
      updated,
      failed,
      review,
      executionId: String(payload.execution_id || ''),
    };
  }
  return { outcome: 'unconfirmed', message: '已收到获客返回，客户保存状态请查看明细。' };
}
