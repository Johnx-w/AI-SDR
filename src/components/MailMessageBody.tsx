import { useEffect, useMemo, useRef, useState } from 'react';
import { Code2, Image, LayoutTemplate } from 'lucide-react';
import type { MailMessage } from '../services/mailConversations';
import { makeMailFrame } from '../services/mailHtml';

export function MailMessageBody({
  message,
}: {
  message: Pick<
    MailMessage,
    | 'subject'
    | 'bodyText'
    | 'bodyHtml'
    | 'inlineImages'
    | 'bodyUnavailable'
    | 'bodyFormatVersion'
    | 'source'
  >;
}) {
  const [mode, setMode] = useState<'html' | 'text'>(message.bodyHtml ? 'html' : 'text');
  const [externalImages, setExternalImages] = useState(false);
  const [height, setHeight] = useState(180);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const content = useMemo(
    () =>
      message.bodyHtml
        ? makeMailFrame(message.bodyHtml, message.inlineImages, externalImages)
        : null,
    [message.bodyHtml, message.inlineImages, externalImages],
  );
  function measure() {
    const frame = frameRef.current;
    if (!frame?.contentDocument) return;
    const doc = frame.contentDocument;
    const body = doc.body;
    if (!body) return;
    body.style.transform = '';
    body.style.width = 'auto';
    const naturalWidth = Math.max(body.scrollWidth, frame.clientWidth);
    const scale = Math.min(1, frame.clientWidth / Math.max(1, naturalWidth));
    if (scale < 0.99) {
      body.style.width = `${naturalWidth}px`;
      body.style.transform = `scale(${scale})`;
      body.style.transformOrigin = 'top left';
    }
    doc.documentElement.style.overflow = 'hidden';
    setHeight(
      Math.max(
        80,
        Math.min(16000, Math.ceil(Math.max(body.scrollHeight, body.offsetHeight) * scale) + 12),
      ),
    );
  }
  function loaded() {
    observer.current?.disconnect();
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    measure();
    observer.current = new ResizeObserver(measure);
    if (doc.body) observer.current.observe(doc.body);
    if (frameRef.current) observer.current.observe(frameRef.current);
    doc
      .querySelectorAll('img')
      .forEach((image) => image.addEventListener('load', measure, { once: true }));
  }
  useEffect(() => () => observer.current?.disconnect(), []);
  return (
    <div className="mail-body-viewer">
      {!!message.bodyHtml && (
        <div className="mail-body-toolbar" role="group" aria-label="邮件正文显示方式">
          <button type="button" aria-pressed={mode === 'html'} onClick={() => setMode('html')}>
            <LayoutTemplate size={13} />
            原邮件
          </button>
          <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>
            <Code2 size={13} />
            纯文本
          </button>
        </div>
      )}
      {mode === 'html' && content ? (
        <>
          {content.remoteImages > 0 && !externalImages && (
            <div className="mail-remote-images">
              <span>
                <Image size={15} />
                这封邮件包含外链图片
              </span>
              <button type="button" onClick={() => setExternalImages(true)}>
                加载图片
              </button>
            </div>
          )}
          <iframe
            ref={frameRef}
            className="mail-html-frame"
            title={`邮件正文：${message.subject || '无主题'}`}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            srcDoc={content.srcDoc}
            onLoad={loaded}
            style={{ height }}
          />
        </>
      ) : (
        <div className="mail-conversation-body">
          {message.bodyUnavailable === 'too_large'
            ? '正文超过读取大小限制，请在原邮箱查看完整内容。'
            : message.bodyText || '此邮件没有可显示的文本正文。'}
        </div>
      )}
      {!message.bodyHtml && !message.bodyFormatVersion && message.source === 'imap' && (
        <p className="mail-old-cache-note">
          当前保存的是文本版本。同步邮件后可查看可用的原始排版。
        </p>
      )}
    </div>
  );
}
