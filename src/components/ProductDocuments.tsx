import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { WorkbookPreview, type CellEdit } from './WorkbookPreview';

interface ProductDocument {
  id: string;
  name: string;
  size: number;
  sha256: string;
  createdAt: string;
  extraction: null | {
    facts: { text: string; page: number; location: string }[];
    warnings: string[];
    model: string;
    extractedAt: string;
    sheets?: { name: string; rows: number }[];
  };
}

async function request<T>(
  url: string,
  method = 'GET',
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(body
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
    signal: signal || AbortSignal.timeout(190000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result)
    throw new Error(result?.error || '文件操作失败，请重新读取文件列表核对');
  return result;
}

export function ProductDocuments({
  productId,
  documentIds,
  disabled,
  onUse,
  cellEdits,
  onEdit,
  onRemove,
}: {
  productId?: string;
  documentIds: string[];
  disabled: boolean;
  onUse: (id: string, specifications: string) => void;
  cellEdits: CellEdit[];
  onEdit: (edit: CellEdit, original: string) => void;
  onRemove: (id: string) => void;
}) {
  const [documents, setDocuments] = useState<ProductDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<Record<string, string>>({});
  const base = `/api/v1/products/knowledge/${productId}/documents`;

  function accept(document: ProductDocument) {
    setDocuments((current) => [...current.filter((item) => item.id !== document.id), document]);
    if (document.extraction)
      setCandidates((current) => ({
        ...current,
        [document.id]: document
          .extraction!.facts.map(
            (fact) => `${fact.text}\n依据：${document.name}，第 ${fact.page} 页，${fact.location}`,
          )
          .join('\n\n'),
      }));
  }
  useEffect(() => {
    if (!productId) return;
    const controller = new AbortController();
    setBusy(true);
    request<{ documents: ProductDocument[] }>(base, 'GET', undefined, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) result.documents.forEach(accept);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [base, productId]);

  async function upload(file?: File) {
    if (!file || busy || disabled) return;
    setError('');
    if (
      !/\.(xlsx|pdf|png|jpe?g)$/iu.test(file.name) ||
      file.size === 0 ||
      file.size > 10 * 1024 * 1024
    ) {
      setError('请选择不超过 10 MB 的 XLSX、PDF、PNG 或 JPG 文件');
      return;
    }
    setBusy(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取所选文件'));
        reader.readAsDataURL(file);
      });
      const contentType = /\.xlsx$/iu.test(file.name)
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : /\.pdf$/iu.test(file.name)
          ? 'application/pdf'
          : /\.png$/iu.test(file.name)
            ? 'image/png'
            : 'image/jpeg';
      const result = await request<{ document: ProductDocument }>(base, 'POST', {
        name: file.name,
        contentType,
        contentBase64,
      });
      accept(result.document);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败');
    } finally {
      setBusy(false);
    }
  }
  async function extract(document: ProductDocument) {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      const result = await request<{ document: ProductDocument }>(
        `${base}/${document.id}/extract`,
        'POST',
      );
      accept(result.document);
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : '提取失败'}。原文件已保留；可重新打开产品查看结果或重试。`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset disabled={disabled || busy} className="knowledge-documents">
      <legend>产品原文件</legend>
      {!productId ? (
        <p className="knowledge-form-note">先保存产品草稿，再上传 Excel 工作簿、PDF 或图片。</p>
      ) : (
        <>
          <label className="knowledge-upload">
            选择原文件（单个不超过 10 MB，每个产品最多 20 份）
            <input
              type="file"
              accept=".xlsx,.pdf,.png,.jpg,.jpeg"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void upload(file);
              }}
            />
          </label>
          <p className="knowledge-form-note">
            Excel 在本地解析，保留工作表和单元格。图片和 PDF 使用{' '}
            <Link to="/settings">资料识别服务</Link>。
          </p>
          {busy && <p role="status">正在处理文件，请稍候…</p>}
          {error && (
            <p className="knowledge-alert error" role="alert">
              {error}
            </p>
          )}
          {documents.map((document) => (
            <div className="knowledge-document" key={document.id}>
              <div className="knowledge-document-heading">
                <a href={`${base}/${document.id}/file`} className="text-link" download>
                  {document.name} · 下载原文件
                </a>
                <span>
                  {(document.size / 1024 / 1024).toFixed(2)} MB ·{' '}
                  {documentIds.includes(document.id) ? '已关联本次产品资料' : '尚未关联产品资料'}
                </span>
              </div>
              <details>
                <summary>文件版本依据</summary>
                <p className="knowledge-editor-meta">
                  SHA-256：{document.sha256}
                  <br />
                  上传时间：
                  {new Date(document.createdAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}
                </p>
              </details>
              {!document.extraction ? (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => void extract(document)}
                >
                  {/\.xlsx$/iu.test(document.name) ? '解析工作簿' : 'AI 提取'} · {document.name}
                </button>
              ) : document.extraction.sheets ? (
                <WorkbookPreview
                  url={base + '/' + document.id}
                  id={document.id}
                  sheets={document.extraction.sheets}
                  edits={cellEdits}
                  onEdit={onEdit}
                  linked={documentIds.includes(document.id)}
                  onToggle={() =>
                    documentIds.includes(document.id)
                      ? onRemove(document.id)
                      : onUse(document.id, '')
                  }
                />
              ) : (
                <>
                  <p className="knowledge-form-note">
                    AI 候选信息 · 尚未经人工核实。请编辑下方内容，删除不适用于当前产品的条目。
                  </p>
                  {document.extraction.warnings.length > 0 && (
                    <ul className="knowledge-extraction-warnings">
                      {document.extraction.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  <label className="knowledge-candidate">
                    {document.name} · 待审核参数
                    <textarea
                      rows={7}
                      value={candidates[document.id] || ''}
                      maxLength={12000}
                      onChange={(event) =>
                        setCandidates((current) => ({
                          ...current,
                          [document.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={!candidates[document.id]?.trim() || documentIds.includes(document.id)}
                    onClick={() => onUse(document.id, candidates[document.id].trim())}
                  >
                    {documentIds.includes(document.id)
                      ? '已加入，请在产品参数中核对修改'
                      : '加入待审核参数'}
                  </button>
                </>
              )}
            </div>
          ))}
        </>
      )}
    </fieldset>
  );
}
