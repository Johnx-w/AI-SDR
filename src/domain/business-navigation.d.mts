import type { OverviewRange } from './overview-rules.mjs';
export interface BusinessNavigation {
  tab: 'demands' | 'messages' | 'tasks';
  state: string;
  bucket: string;
  focusedId: string;
  range: OverviewRange;
  frozen: boolean;
}
export function businessNavigation(params: URLSearchParams, now?: number): BusinessNavigation;
export function matchesDemandNavigation(
  demand: { id: string; stage: string },
  navigation: BusinessNavigation,
): boolean;
export function matchesTaskNavigation(
  task: { id: string; status: string; dueAt: string },
  navigation: BusinessNavigation,
): boolean;
export function updateBusinessNavigation(
  params: URLSearchParams,
  key: string,
  value: string,
): URLSearchParams;
