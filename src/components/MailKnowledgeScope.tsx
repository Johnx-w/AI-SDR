import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { materialsRequest, messageOf } from '../services/materials';

type FileRow = {
  id: string;
  name: string;
  filename: string;
  status: string;
  effectiveDate: string | null;
  version: number;
};
type FilePage = { items: FileRow[]; total: number; page: number; pageSize: number };
export function MailKnowledgeScope({
  ids,
  onChange,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQuery] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: FilePage; error?: string } | null>(
    null,
  );
  const headerBox = useRef<HTMLInputElement>(null);
  const key = JSON.stringify({ q: q.trim(), page, ...(selectedOnly ? { ids } : {}) });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        materialsRequest<FilePage>('/reply-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: key,
          signal: controller.signal,
        })
          .then((data) => {
            if (controller.signal.aborted) return;
            setResult({ key, data });
            if (data.page !== page) setPage(data.page);
          })
          .catch((e) => {
            if (!controller.signal.aborted) setResult({ key, error: messageOf(e) });
          });
      },
      q.trim() ? 150 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, page, retry, q]);
  const data = result?.key === key ? result.data : undefined;
  const error = result?.key === key ? result.error : '';
  const selected = new Set(ids);
  const rows = data?.items || [];
  const checked = rows.filter((r) => selected.has(r.id)).length;
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = checked > 0 && checked < rows.length;
  }, [checked, rows.length]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  function toggle(fileIds: string[], add: boolean) {
    const next = new Set(ids);
    for (const id of fileIds) {
      if (add) next.add(id);
      else next.delete(id);
    }
    onChange([...next]);
  }
  return (
    <div className="mail-files">
      <div className="mail-files-tools">
        <div className="mail-files-search">
          <Search size={15} />
          <input
            type="search"
            aria-label="搜索文件名"
            maxLength={200}
            placeholder="搜索文件名"
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            value={q}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <label className="mail-files-filter">
          <input
            type="checkbox"
            checked={selectedOnly}
            onChange={(e) => {
              setSelectedOnly(e.target.checked);
              setPage(1);
            }}
          />
          只看已选（{ids.length}）
        </label>
      </div>
      <div className="mail-files-panel">
        <div className="mail-files-row mail-files-head">
          <input
            type="checkbox"
            aria-label="选择本页文件"
            ref={headerBox}
            disabled={!rows.length}
            checked={rows.length > 0 && checked === rows.length}
            onChange={(e) =>
              toggle(
                rows.map((r) => r.id),
                e.target.checked,
              )
            }
          />
          <span>文件名称</span>
          <span>状态</span>
        </div>
        <div className="mail-files-scroll" aria-busy={!data && !error} key={data?.page || page}>
          {rows.map((f) => {
            const status =
              f.status === 'archived'
                ? '已归档'
                : f.status !== 'approved'
                  ? '待审核'
                  : f.effectiveDate && f.effectiveDate > today
                    ? '待生效'
                    : '已审核';
            return (
              <label className="mail-files-row" key={f.id}>
                <input
                  type="checkbox"
                  aria-label={'选择 ' + f.name}
                  checked={selected.has(f.id)}
                  onChange={(e) => toggle([f.id], e.target.checked)}
                />
                <span
                  className="mail-file-title"
                  title={[f.name, f.filename].filter(Boolean).join(' · ')}
                >
                  <strong>{f.name}</strong>
                  <small>
                    {f.filename && f.filename !== f.name ? f.filename + ' · ' : ''}v{f.version}
                  </small>
                </span>
                <small className="mail-file-status">{status}</small>
              </label>
            );
          })}
          {!rows.length && (
            <p className="mail-files-empty" role={error ? 'alert' : 'status'}>
              {error ||
                (!data
                  ? '正在读取文件…'
                  : q
                    ? '没有匹配的文件'
                    : selectedOnly
                      ? '此邮箱尚未选择文件'
                      : '素材库暂无导入文件')}
              {error && (
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    setRetry((v) => v + 1);
                  }}
                >
                  重试
                </button>
              )}
            </p>
          )}
        </div>
      </div>
      <div className="mail-files-footer">
        <small>{data ? '共 ' + data.total + ' 份文件' : '文件清单'}</small>
        {data && pages > 1 && (
          <div>
            <button
              type="button"
              aria-label="上一页文件"
              disabled={data.page <= 1}
              onClick={() => setPage(data.page - 1)}
            >
              <ChevronLeft size={15} />
            </button>
            <small>
              {data.page} / {pages}
            </small>
            <button
              type="button"
              aria-label="下一页文件"
              disabled={data.page >= pages}
              onClick={() => setPage(data.page + 1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>
      <small className="mail-files-help">
        勾选的文件用于此邮箱的回信。审核通过且生效后可引用。
      </small>
      <Link to="/materials">
        管理素材库 <ChevronRight size={13} />
      </Link>
    </div>
  );
}
