import type { ProductSelection, WorkflowInput } from './types';
type ProductTarget = Partial<Pick<WorkflowInput, 'product_scope' | 'product' | 'products'>>;
export const directionLabels: Record<ProductSelection['direction'], string>;
export const MAX_SELECTED_PRODUCTS: number;
export const MAX_SELECTED_PRODUCT_CHARACTERS: number;
export const ALL_PRODUCTS_LABEL: string;
export const ALL_PRODUCTS_VALUE: string;
export const environmentPreferenceLabels: Record<
  NonNullable<WorkflowInput['environment_preference']>,
  string
>;
export const builtinProducts: ProductSelection[];
export function isAllProductScope(target?: ProductTarget): boolean;
export function validateProduct(value: unknown): ProductSelection;
export function productTerms(target: ProductTarget): string[];
