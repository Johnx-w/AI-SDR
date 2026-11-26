export type ParseMode = 'rich_layout_recognition' | 'text_recognition' | 'model_parameters';
import { checkMaterialSize, materialPartBytes } from '../domain/material-upload.mjs';

export const materialFormats = [
  'PDF',
  'Word',
  'PowerPoint',
  'Markdown',
  'TXT',
  'Excel',
  '图片',
  '视频',
];
export const acceptMaterials =
  '.pdf,.docx,.pptx,.xlsx,.md,.markdown,.txt,.jpg,.jpeg,.png,.gif,.webp,.mp4,.webm,.mov';
export type Site = { site: string; brand: string };
export type Reference = { documentId: string; location: string; text: string };
export type Correction = { documentId: string; sheet: string; ref: string; value: string };
export type Material = {
  id: string;
  name: string;
  version: number;
  status: string;
  updatedAt: string;
  category: string;
  keywords: string[];
  sites: string[];
  documentId: string | null;
  contentType: string | null;
  size: number;
  format: string;
  parseMode?: ParseMode;
  extractionStatus: 'pending' | 'processing' | 'ready' | 'failed' | 'manual';
  extractionCount: number;
};
export type MaterialList = {
  items: Material[];
  total: number;
  page: number;
  pageSize: number;
  sites: Site[];
  categories: string[];
};
export type ModelParameter = {
  key: string;
  item: string;
  field: string;
  value: string;
  conditions?: string;
  quote: string;
  issue?: string;
  origin?: string;
  page?: number;
  sheet?: string;
  ref: string;
  box?: number[];
  upstream?: { documentId: string; file: string; page: number };
};
export type ProductField = {
  item: string;
  field: string;
  value: string;
  ref: string;
  sheet?: string;
  ownerRef?: string;
};
export type StoredDocument = {
  referencePages?: number;
  id: string;
  name: string;
  size: number;
  contentType: string;
  sha256: string;
  parseMode?: ParseMode;
  createdAt: string;
  extraction: null | {
    photoCount?: number;
    productFields?: ProductField[];
    parameters?: ModelParameter[];
    facts: { text: string; page: number; location: string }[];
    warnings: string[];
    sheets?: { name: string; rows: number }[];
    model: string;
    pageCount?: number;
    mode?: ParseMode;
    extractedAt?: string;
  };
};
export type Product = {
  parameterSet?: string;
  materialOnly?: boolean;
  id: string;
  version: number;
  status: string;
  name: string;
  materialCategory?: string;
  keywords?: string[];
  cellEdits?: Correction[];
  sourceFacts?: Reference[];
  approvedBy: string;
  specifications: string;
  sourceUrl: string;
  documentIds?: string[];
  attachments: string[];
};
export type MaterialDetail = {
  product: Product;
  confirmedParameters?: ModelParameter[];
  documents: StoredDocument[];
  history: number[];
  sites: string[];
  siteOptions: Site[];
  currentVersion: number;
};
export const materialApi = '/api/v1/materials';
export const sourceUrl = (id: string, document: string) =>
  materialApi + '/' + id + '/document/' + document;
type ExtractionProgress = (page: number, total: number) => void;
export async function materialsRequest<T>(
  path: string,
  init: RequestInit = {},
  onPage?: ExtractionProgress,
): Promise<T> {
  let response = await fetch(materialApi + path, init);
  while (true) {
    const data = await response.json().catch(() => null);
    if (!response.ok || !data)
      throw new Error(
        data?.error ||
          (response.status === 413
            ? '上传请求超过网关上限，请联系管理员检查素材上传配置'
            : '素材操作失败，请刷新后重试'),
      );
    if (response.status !== 202 || !data.processingId) return data as T;
    if (data.page) onPage?.(data.page, data.total);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response = await fetch(materialApi + '/processing/' + data.processingId, {
      signal: init.signal,
      cache: 'no-store',
    });
  }
}
export const sendJson = <T>(path: string, method: string, body: unknown) =>
  materialsRequest<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
export async function uploadMaterial(
  file: File,
  options: { site?: string; category?: string; id?: string; version?: number; mode?: ParseMode },
  key: string,
  onPage?: ExtractionProgress,
) {
  checkMaterialSize(file.name, file.size);
  const q = new URLSearchParams({ name: file.name });
  const paged = /\.(?:pdf|docx|pptx)$/iu.test(file.name);
  const structured =
    options.mode === 'model_parameters' && !/\.(?:webm|mp4|mov)$/iu.test(file.name);
  const media = /\.(?:png|jpe?g|webp|gif|mp4|mov|webm)$/iu.test(file.name);
  if (
    (paged || structured || (media && options.mode === 'rich_layout_recognition')) &&
    options.mode
  )
    q.set('mode', options.mode);
  if (options.site) q.set('site', options.site);
  if (options.category) q.set('category', options.category);
  if (options.version) q.set('version', String(options.version));
  const path = options.id ? '/' + options.id + '/versions' : '';
  type Result = { id: string; documentId: string; warning: string; reused: boolean };
  return uploadBytes<Result>(file, path, q, key, paged || structured || media, onPage);
}
async function uploadBytes<Result>(
  file: File,
  path: string,
  q: URLSearchParams,
  key: string,
  asyncJob = false,
  onPage?: ExtractionProgress,
) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Idempotency-Key': key,
    ...(asyncJob ? { Prefer: 'respond-async' } : {}),
  };
  if (file.size <= materialPartBytes)
    return materialsRequest<Result>(
      path + '?' + q,
      { method: 'POST', headers, body: file },
      onPage,
    );
  const parts = path + '/parts?' + q;
  for (let start = 0; ; start += materialPartBytes) {
    const end = Math.min(file.size, start + materialPartBytes);
    const init = {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + file.size,
      },
      body: file.slice(start, end),
    };
    if (end === file.size) return materialsRequest<Result>(parts, init, onPage);
    const { received } = await materialsRequest<{ received: number }>(parts, init);
    if (received !== end) throw new Error('素材分段未完整接收，请重新上传');
  }
}
export async function attachParameterSource(id: string, version: number, file: File) {
  checkMaterialSize(file.name, file.size);
  return uploadBytes<{ version: number }>(
    file,
    '/' + id + '/evidence',
    new URLSearchParams({ name: file.name, version: String(version) }),
    crypto.randomUUID(),
  );
}
export const fileSize = (n: number) =>
  n >= 1048576
    ? (n / 1048576).toFixed(1) + ' MB'
    : n >= 1024
      ? (n / 1024).toFixed(1) + ' KB'
      : n + ' B';
export const statusName = (s: string) =>
  s === 'approved' ? '已审核' : s === 'archived' ? '已撤回' : '待审核';
export const messageOf = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');
