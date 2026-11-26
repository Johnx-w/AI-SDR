import { ModelPictures } from './MaterialModels';
import { useEffect, useState } from 'react';

export interface CellEdit {
  documentId: string;
  sheet: string;
  ref: string;
  value: string;
}
interface Cell {
  ref: string;
  field: string;
  value: string;
}
interface Page {
  rows: { number: number; cells: Cell[] }[];
  total: number;
  pageSize: number;
}
export function WorkbookPreview({
  url,
  id,
  sheets,
  edits,
  onEdit,
  linked,
  onToggle,
  file,
}: {
  url: string;
  id: string;
  sheets: { name: string; rows: number }[];
  edits: CellEdit[];
  onEdit: (edit: CellEdit, original: string) => void;
  linked: boolean;
  onToggle?: () => void;
  file: string;
}) {
  const [expanded, setExpanded] = useState(''),
    [editing, setEditing] = useState('');
  const [sheet, setSheet] = useState(sheets[0]?.name || ''),
    [page, setPage] = useState(1),
    [q, setQ] = useState('');
  const [result, setResult] = useState<Page | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setError('');
    const params = new URLSearchParams({ sheet, q, page: String(page) });
    fetch(url + '/rows?' + params, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '工作表读取失败');
        if (!controller.signal.aborted) setResult(data);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, [url, sheet, page, q]);
  return (
    <div className="workbook-preview">
      <div className="workbook-controls">
        <label>
          工作表
          <select
            aria-label="工作表"
            value={sheet}
            onChange={(e) => {
              setSheet(e.target.value);
              setPage(1);
            }}
          >
            {sheets.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}（{s.rows} 行）
              </option>
            ))}
          </select>
        </label>
        <label>
          查找型号或主题
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </label>
        {onToggle && (
          <button className="btn secondary" type="button" onClick={onToggle}>
            {linked ? '移除此文件关联' : '关联工作簿并校对'}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <div className="workbook-grid">
            {result.rows.map((row) => (
              <details key={sheet + row.number} open={expanded === sheet + '!' + row.number}>
                <summary
                  onClick={(e) => {
                    e.preventDefault();
                    const key = sheet + '!' + row.number;
                    setEditing('');
                    setExpanded(expanded === key ? '' : key);
                  }}
                >
                  {row.number} · {row.cells[0]?.value}
                </summary>
                {expanded === sheet + '!' + row.number && (
                  <>
                    <ModelPictures
                      url={url}
                      sheet={sheet}
                      item={row.cells[0].value}
                      row={row.number}
                    />
                    <p className="model-origin">
                      {file} · {sheet} · 第 {row.number} 行
                    </p>
                    {editing !== expanded && (
                      <dl className="model-properties">
                        {row.cells.map((cell) => {
                          const corrected = edits.find(
                            (e) => e.documentId === id && e.sheet === sheet && e.ref === cell.ref,
                          );
                          return (
                            <div key={cell.ref}>
                              <dt>{cell.field}</dt>
                              <dd>{corrected?.value ?? cell.value}</dd>
                              <small>
                                {sheet}!{cell.ref}
                              </small>
                            </div>
                          );
                        })}
                      </dl>
                    )}
                    {linked && (
                      <button
                        className="kb-text"
                        type="button"
                        onClick={() => setEditing(editing === expanded ? '' : expanded)}
                      >
                        {editing === expanded ? '查看字段' : '校对单元格'}
                      </button>
                    )}
                    {editing === expanded && (
                      <div>
                        {row.cells.map((cell) => {
                          const edit = edits.find(
                            (v) => v.documentId === id && v.sheet === sheet && v.ref === cell.ref,
                          );
                          return (
                            <label key={cell.ref}>
                              {cell.ref} · {cell.field}
                              <input
                                aria-label={sheet + '!' + cell.ref}
                                value={edit?.value ?? cell.value}
                                readOnly={!linked}
                                onChange={(e) =>
                                  onEdit(
                                    { documentId: id, sheet, ref: cell.ref, value: e.target.value },
                                    cell.value,
                                  )
                                }
                              />
                              {edit && <small>原值 {cell.value}</small>}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </details>
            ))}
          </div>
          <div className="workbook-controls">
            <button
              type="button"
              className="btn secondary"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <span>
              {page} / {Math.max(1, Math.ceil(result.total / result.pageSize))} · {result.total} 行
            </span>
            <button
              type="button"
              className="btn secondary"
              disabled={page * result.pageSize >= result.total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  );
}
