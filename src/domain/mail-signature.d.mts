export const MAX_SIGNATURE_LOGO_BYTES: number;
export interface MailSignatureDesign {
  closing: string;
  companyName: string;
  address: string;
  website: string;
  logo: {
    name: string;
    contentType: 'image/png' | 'image/jpeg';
    contentBase64: string;
  } | null;
  logoWidth: number;
}
export function signaturePlainTextHtml(value: string): string;
export function renderMailboxSignature(mailbox: {
  displayName?: string;
  email?: string;
  signature?: string;
  signatureDesign?: MailSignatureDesign | null;
}): { text: string; html: string };
