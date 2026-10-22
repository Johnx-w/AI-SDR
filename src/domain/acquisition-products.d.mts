import type { ProductSelection } from './types';
export const directionLabels: Record<ProductSelection['direction'], string>;
export const builtinProducts: ProductSelection[];
export function validateProduct(value: unknown): ProductSelection;
export function productTerms(target: { product?: string; products?: ProductSelection[] }): string[];
