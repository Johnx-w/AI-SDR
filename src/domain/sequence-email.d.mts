export type CustomVariable = { key: string; label: string; instruction: string };
export type EmailTemplate = { subject: string; body: string; variables?: CustomVariable[] };
export const variableLabels: Record<string, string>;
export function defaultTemplate(first: boolean): EmailTemplate;
export function normalizeTemplate(
  value: EmailTemplate | undefined,
  first: boolean,
): EmailTemplate | undefined;
export function expandTemplate(text: string, variables: Record<string, string>): string;
export function mailVariables(input: {
  company: string;
  product: string;
  brand: string;
  subject: string;
  body: string;
}): Record<string, string>;
