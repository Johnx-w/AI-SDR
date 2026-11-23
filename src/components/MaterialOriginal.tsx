import { useState, useEffect } from 'react';
import { messageOf, type StoredDocument } from '../services/materials';
function PdfOriginal({ name, url, page }: { name: string; url: string; page: number }) {
  const [inlineUrl, setInlineUrl] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { headers: { Range: 'bytes=0-0' }, signal: controller.signal })
      .then(async (response) => {
        await response.body?.cancel();
        if (
          !controller.signal.aborted &&
          response.ok &&
          !/deny/i.test(response.headers.get('X-Frame-Options') || '')
        )
          setInlineUrl(url);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [url]);
  const target = url + '#page=' + page;
  return inlineUrl === url ? (
    <>
      <iframe key={target} title={name} src={url + '#toolbar=0&navpanes=0&page=' + page} />
      <a className="kb-enlarge" href={target} target="_blank" rel="noopener noreferrer">
        放大查看第 {page} 页
      </a>
    </>
  ) : (
    <a href={target} target="_blank" rel="noopener noreferrer">
      在新窗口查看 PDF 原件
    </a>
  );
}
function TextOriginal({ url, size }: { url: string; size: number }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const limit = 64 * 1024;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, {
      headers: { Range: 'bytes=0-' + (Math.min(size, limit) - 1) },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('原文读取失败，请下载原件核对。');
        const bytes = await response.arrayBuffer();
        if (!controller.signal.aborted)
          setText(new TextDecoder().decode(bytes, { stream: size > limit }));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      });
    return () => controller.abort();
  }, [url, size]);
  return error ? (
    <p role="alert">{error}</p>
  ) : (
    <>
      {size > limit && <small>显示原件前 64 KiB，可下载全文。</small>}
      <pre className="kb-raw-text">{text ?? '正在读取原件…'}</pre>
    </>
  );
}

export function MaterialOriginal({
  doc,
  url,
  page,
}: {
  doc: StoredDocument;
  url: string;
  page: number;
}) {
  if (doc.contentType.startsWith('image/')) return <img src={url} alt={doc.name} />;
  if (doc.contentType.startsWith('video/')) return <video src={url} controls preload="metadata" />;
  if (doc.contentType === 'application/pdf')
    return <PdfOriginal name={doc.name} url={url} page={page} />;
  if (doc.contentType.startsWith('text/'))
    return <TextOriginal key={url} url={url} size={doc.size} />;
  return (
    <a href={url + '?download=1'} download>
      下载原件核对
    </a>
  );
}
