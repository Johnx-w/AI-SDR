export type Layout = {
  kind: 'quote' | 'knowledge' | 'table';
  headers: string[];
  fields: Partial<
    Record<
      'model' | 'price' | 'topic' | 'answer' | 'source' | 'unit' | 'currency' | 'photo',
      string
    >
  >;
};
export function sheetLayout(values: unknown[]): Layout;
export function workbookHeader(data: unknown[][]): number;
export function layoutKey(headers: string[]): string;
