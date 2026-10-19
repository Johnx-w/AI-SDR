export function summarizeRunOutput(output) {
  const payload = Array.isArray(output) && output.length === 1 ? output[0] : output;
  if (
    payload == null ||
    (Array.isArray(payload) && payload.length === 0) ||
    (typeof payload === 'object' && Object.keys(payload).length === 0)
  )
    throw new Error('n8n 返回空结果，无法确认飞书写入。请查看执行记录，勿直接重复提交。');
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
      message: String(payload.reason || '请查看返回明细与 n8n 执行记录。'),
      inserted,
      updated,
      failed,
      review,
      executionId: String(payload.execution_id || ''),
    };
  }
  if (payload?.ok === false)
    return { outcome: 'failed', message: String(payload.reason || '工作流未获得可入库的客户。') };
  return { outcome: 'unconfirmed', message: '已收到工作流返回，飞书写入状态请查看返回明细。' };
}
