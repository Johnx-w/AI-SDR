export const pagedMaterialTypes: Record<'pdf' | 'docx' | 'pptx', string>;
export function isPagedMaterial(type: string | undefined): boolean;
export const documentLimitMiB: number;
export const videoLimitMiB: number;
export const videoTypes: Record<string, string>;
export function checkMaterialSize(name: string, bytes: number): void;
export const materialPartBytes: number;
