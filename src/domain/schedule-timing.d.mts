import type { ScheduleTiming } from './types';
export const weekdays: { value: number; label: string }[];
export function scheduleWeekdays(timing: ScheduleTiming): number[];
export function scheduleRepeatLabel(timing: ScheduleTiming): string;
export function validateTiming(timing: ScheduleTiming, now?: number): ScheduleTiming;
export function nextOccurrence(timing: ScheduleTiming, after: number): string | null;
