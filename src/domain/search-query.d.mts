import type { WorkflowInput } from './types';
export const MAX_AUTO_SEARCH_QUERIES: number;
export function buildSearchQuery(input: Partial<WorkflowInput>): string;
export function automaticSearchPlan(
  input: Partial<WorkflowInput>,
  countries?: string[],
): { country: string; query: string }[];
