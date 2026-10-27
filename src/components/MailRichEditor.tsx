import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Link2, List, ListOrdered, X } from 'lucide-react';
import { safeMailLink, sanitizeReplyHtml } from '../services/mailHtml';

export function MailRichEditor({
  initialHtml,
  disabled,
  onChange,
}: {
  initialHtml: string;
  disabled?: boolean;
  onChange: (value: { bodyHtml: string; bodyText: string }) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const selection = useRef<Range | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('https://');
  const [linkError, setLinkError] = useState('');
  useEffect(() => {
    if (editor.current) editor.current.innerHTML = sanitizeReplyHtml(initialHtml);
  }, [initialHtml]);
  function changed() {
    if (editor.current)
      onChange({
        bodyHtml: sanitizeReplyHtml(editor.current.innerHTML),
        bodyText: editor.current.innerText.replace(/\u00a0/g, ' '),
      });
  }
  function rememberSelection() {
    const current = window.getSelection();
    if (current?.rangeCount && editor.current?.contains(current.anchorNode))
      selection.current = current.getRangeAt(0).cloneRange();
  }
  function command(value: string, argument?: string) {
    editor.current?.focus();
    if (selection.current && editor.current?.contains(selection.current.commonAncestorContainer)) {
      const current = window.getSelection();
      current?.removeAllRanges();
      current?.addRange(selection.current);
    }
    document.execCommand(value, false, argument);
    rememberSelection();
    changed();
  }
  return (
    <div className={`mail-rich-editor ${disabled ? 'disabled' : ''}`}>
      <div className="mail-editor-tools" role="toolbar" aria-label="回复正文格式">
        {[
          { command: 'bold', label: '加粗', Icon: Bold },
          { command: 'italic', label: '斜体', Icon: Italic },
          { command: 'insertUnorderedList', label: '项目列表', Icon: List },
          { command: 'insertOrderedList', label: '编号列表', Icon: ListOrdered },
        ].map(({ command: action, label, Icon }) => (
          <button
            type="button"
            key={action}
            disabled={disabled}
            title={label}
            aria-label={label}
            onMouseDown={(event) => {
              event.preventDefault();
              rememberSelection();
            }}
            onClick={() => command(action)}
          >
            <Icon size={16} />
          </button>
        ))}
        <span className="mail-editor-tool-divider" />
        <button
          type="button"
          disabled={disabled}
          title="插入链接"
          aria-label="插入链接"
          onMouseDown={(event) => {
            event.preventDefault();
            rememberSelection();
          }}
          onClick={() => {
            setLinkOpen((value) => !value);
            setLinkError('');
          }}
        >
          <Link2 size={16} />
        </button>
        <span className="mail-editor-tool-hint">基础富文本</span>
      </div>
      {linkOpen && (
        <div className="mail-editor-link-entry">
          <input
            autoFocus
            aria-label="链接地址"
            placeholder="https://example.com"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setLinkOpen(false);
            }}
          />
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              const href = safeMailLink(link);
              if (!href) {
                setLinkError('请输入有效的网页或邮件链接。');
                return;
              }
              command('createLink', href);
              setLinkOpen(false);
            }}
          >
            插入
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="取消插入链接"
            onClick={() => setLinkOpen(false)}
          >
            <X size={14} />
          </button>
          {linkError && <span role="alert">{linkError}</span>}
        </div>
      )}
      <div
        ref={editor}
        className="mail-editor-content"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-label="回复正文"
        aria-multiline="true"
        aria-disabled={disabled}
        data-placeholder="写下你的回复…"
        onInput={changed}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) event.preventDefault();
        }}
        onPaste={(event) => {
          event.preventDefault();
          const html = event.clipboardData.getData('text/html');
          const text = event.clipboardData.getData('text/plain');
          if (html) document.execCommand('insertHTML', false, sanitizeReplyHtml(html));
          else document.execCommand('insertText', false, text);
          changed();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (disabled) return;
          const html = event.dataTransfer.getData('text/html');
          const text = event.dataTransfer.getData('text/plain');
          if (html) document.execCommand('insertHTML', false, sanitizeReplyHtml(html));
          else if (text) document.execCommand('insertText', false, text);
          changed();
        }}
      />
    </div>
  );
}
