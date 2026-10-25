export type OverviewPeriod = 'today' | '7d' | '30d';
export interface OverviewRange {
  period: OverviewPeriod;
  label: string;
  start: string;
  end: string;
  todayStart: string;
  todayEnd: string;
  asOf: string;
}
export function overviewRange(period?: string, at?: number | string): OverviewRange;
export function taskBucket(
  task: { status: string; dueAt: string },
  range: OverviewRange,
): 'overdue' | 'today' | 'paused' | '';
export function activeDemand(demand: { stage: string }): boolean;
