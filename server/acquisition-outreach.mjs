// Only read-back-confirmed records belong to automatic first outreach.
export function acquisitionOutreachSources(jobs, plans) {
  const schedules = new Map(plans.list().map((plan) => [plan.id, plan]));
  return jobs.outreachJobs().map((job) => {
    const plan = job.scheduleId ? schedules.get(job.scheduleId) : null;
    const cancelled =
      job.autoFirstTouchCancelled || (job.scheduleId && (!plan || plan.status === 'closed'));
    const paused =
      job.autoFirstTouchPaused ||
      (job.manualPaused && (!job.scheduleId || job.sourcePause?.outreachPlanId)) ||
      (plan && (plan.status === 'paused' || !plan.input.auto_first_touch));
    const superseded = plan?.lastJobId && plan.lastJobId !== job.id;
    const status = cancelled
      ? 'cancelled'
      : superseded
        ? 'completed'
        : paused
          ? 'paused'
          : 'active';
    return {
      jobId: job.id,
      generation: job.outreachGeneration || 0,
      followUpEnabled: Boolean((plan?.input || job.input).auto_follow_up),
      scheduleId: job.scheduleId,
      scope: job.scope,
      name: `${plan?.name || '立即获客'} · ${new Date(job.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · 自动首发`,
      status,
      followUpsAllowed: !cancelled && !paused,
      roundId: job.id,
      customerIds: [
        ...new Set(
          job.rows.filter((row) => row.stored && row.record_id).map((row) => row.record_id),
        ),
      ],
    };
  });
}
