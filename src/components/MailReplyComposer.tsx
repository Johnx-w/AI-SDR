import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Paperclip, Send, Trash2, Type, X } from 'lucide-react';
import type {
  MailConversationDetail,
  MailDraftContent,
  MailReplyAttachment,
  MailReplyDraft,
  MailReplyRecord,
} from '../services/mailConversations';
import { mailConversationsApi } from '../services/mailConversations';
import { plainTextHtml, replyRecipient, validateMailAttachments } from '../services/mailHtml';
import { MailRichEditor } from './MailRichEditor';

const contentKey = (draft: MailDraftContent) => JSON.stringify(draft);
const textError = (error: unknown) =>
  error instanceof Error ? error.message : '操作未完成，请重试。';
const sizeLabel = (size: number) =>
  size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(size / 1024))} KB`;
function fileData(file: File): Promise<MailReplyAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取附件“${file.name}”。`));
    reader.onload = () =>
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        contentBase64: String(reader.result).split(',')[1] || '',
      });
    reader.readAsDataURL(file);
  });
}

export function MailReplyResult({ reply }: { reply: MailReplyRecord }) {
  const labels = {
    accepted: '服务商已接受回复',
    failed: '回复发送失败',
    unknown: '回复结果待核实',
    sending: '回复正在提交',
  };
  return (
    <div className={`mail-reply-result ${reply.status}`} role="status">
      <strong>{labels[reply.status]}</strong>
      <span>
        {reply.reason ||
          reply.error ||
          (reply.status === 'accepted'
            ? '邮件已提交，不代表对方已经收到或阅读。'
            : reply.status === 'unknown'
              ? '请先核对发送结果，系统不会自动重发。'
              : reply.status === 'sending'
                ? '稍后刷新会话查看结果，请勿重复提交。'
                : '请检查原因后再决定是否发送。')}
      </span>
      {reply.archiveStatus && reply.archiveStatus !== 'not_requested' && (
        <small>
          {['accepted', 'saved', 'archived', 'confirmed'].includes(reply.archiveStatus)
            ? '已保存到原邮箱已发送'
            : '原邮箱已发送副本待核对；不会因此重新发送邮件。'}
          {reply.archiveReason || reply.archiveError
            ? ` ${reply.archiveReason || reply.archiveError}`
            : ''}
        </small>
      )}
      {(reply.businessError || reply.recordError) && (
        <small>客户沟通记录待同步：{reply.businessError || reply.recordError}</small>
      )}
    </div>
  );
}

export function MailReplyComposer({
  detail,
  targetMessageId,
  replyRequest,
  onCompleted,
}: {
  detail: MailConversationDetail;
  targetMessageId?: string | null;
  replyRequest?: number;
  onCompleted: (detail: MailConversationDetail) => void;
}) {
  const { conversation, replyContext } = detail;
  const latestInbound = [...detail.messages].reverse().find((item) => item.direction === 'inbound');
  const initialTarget = replyContext?.replyToMessageId || latestInbound?.id || '';
  const signature = useRef({
    text: replyContext?.signature || '',
    html: replyContext?.signatureHtml || plainTextHtml(replyContext?.signature || ''),
  });
  const appendSignature = useRef(true);
  const [formatting, setFormatting] = useState(false);
  const [editorReset, setEditorReset] = useState(0);
  const seed = useCallback(
    (target = initialTarget): MailDraftContent => ({
      replyToMessageId: target,
      bodyHtml: '',
      bodyText: '',
      attachments: [],
    }),
    [initialTarget],
  );
  const [loading, setLoading] = useState(true);
  const [draftRetry, setDraftRetry] = useState(0);
  const [readFailed, setReadFailed] = useState(false);
  const [content, setContent] = useState<MailDraftContent>(() => seed());
  const [editorHtml, setEditorHtml] = useState(content.bodyHtml);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'changed' | 'error'>('saved');
  const [sending, setSending] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const [result, setResult] = useState<MailReplyRecord | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const mounted = useRef(true);
  const contentRef = useRef(content);
  const revision = useRef<number | undefined>(undefined);
  const savedKey = useRef(contentKey(content));
  const saving = useRef<Promise<MailReplyDraft | null>>(Promise.resolve(null));
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const saveOnLeave = useRef(false);
  contentRef.current = content;
  const uncertain = result?.status === 'unknown' || result?.status === 'sending';
  saveOnLeave.current = !loading && !readFailed && !uncertain && !sending && !discarding;
  const targetMessage = detail.messages.find((item) => item.id === content.replyToMessageId);
  const recipient = replyContext ? replyRecipient(targetMessage, replyContext) : '';
  const recipientName =
    recipient && targetMessage?.from.toLowerCase() === recipient.toLowerCase()
      ? targetMessage.fromName
      : undefined;
  const canReply = !!replyContext?.canReply && !!content.replyToMessageId;
  const canSend = canReply && replyContext?.canSend !== false;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setReadFailed(false);
    void mailConversationsApi
      .draft(conversation.id, controller.signal)
      .then(({ draft }) => {
        if (controller.signal.aborted) return;
        if (draft) {
          const { revision: version, ...next } = draft;
          const value = {
            replyToMessageId: next.replyToMessageId,
            bodyHtml: next.bodyHtml,
            bodyText: next.bodyText,
            attachments: next.attachments || [],
          };
          appendSignature.current = false;
          revision.current = version;
          savedKey.current = contentKey(value);
          contentRef.current = value;
          setContent(value);
          setEditorHtml(value.bodyHtml);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setReadFailed(true);
          setError(`草稿读取失败：${textError(reason)}`);
          setSaveState('error');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [conversation.id, draftRetry]);

  const persist = useCallback(
    (value: MailDraftContent) => {
      const operation = saving.current
        .catch(() => null)
        .then(async () => {
          if (contentKey(value) === savedKey.current) return null;
          if (mounted.current) setSaveState('saving');
          const { draft } = await mailConversationsApi.saveDraft(conversation.id, {
            ...value,
            ...(revision.current !== undefined ? { revision: revision.current } : {}),
          });
          revision.current = draft.revision;
          savedKey.current = contentKey(value);
          if (mounted.current)
            setSaveState(contentKey(contentRef.current) === savedKey.current ? 'saved' : 'changed');
          return draft;
        });
      saving.current = operation;
      return operation;
    },
    [conversation.id],
  );
  useEffect(() => {
    if (loading || readFailed || !canReply || sending || discarding || uncertain) return;
    if (contentKey(content) === savedKey.current) return;
    setSaveState('changed');
    const timeout = window.setTimeout(() => {
      void persist(content).catch((reason: unknown) => {
        if (mounted.current) {
          setSaveState('error');
          setError(`草稿未保存：${textError(reason)}`);
        }
      });
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [content, loading, readFailed, canReply, sending, discarding, uncertain, persist]);
  // Finish queued changes when switching conversations; this only saves a draft.
  useEffect(
    () => () => {
      if (saveOnLeave.current && contentKey(contentRef.current) !== savedKey.current)
        void persist(contentRef.current).catch(() => {});
    },
    [persist],
  );
  useEffect(() => {
    if (!targetMessageId || loading) return;
    setContent((current) => ({ ...current, replyToMessageId: targetMessageId }));
    const frame = window.requestAnimationFrame(() =>
      panel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [targetMessageId, replyRequest, loading]);

  async function addFiles(files: File[]) {
    const invalid = validateMailAttachments([...contentRef.current.attachments, ...files]);
    if (invalid) {
      setError(invalid);
      return;
    }
    setReadingFiles(true);
    setError('');
    try {
      const attachments = await Promise.all(files.map(fileData));
      if (mounted.current)
        setContent((value) => ({ ...value, attachments: [...value.attachments, ...attachments] }));
    } catch (reason) {
      if (mounted.current) setError(textError(reason));
    } finally {
      if (mounted.current) setReadingFiles(false);
    }
  }
  async function discard() {
    setDiscarding(true);
    setError('');
    try {
      await saving.current.catch(() => null);
      await mailConversationsApi.deleteDraft(conversation.id, revision.current || 0);
      if (!mounted.current) return;
      const value = seed();
      revision.current = undefined;
      savedKey.current = contentKey(value);
      contentRef.current = value;
      setContent(value);
      setEditorHtml(value.bodyHtml);
      setEditorReset((n) => n + 1);
      appendSignature.current = true;
      setSaveState('saved');
    } catch (reason) {
      if (mounted.current) setError(textError(reason));
    } finally {
      if (mounted.current) setDiscarding(false);
    }
  }
  async function send() {
    if (sending || !canSend || readFailed || uncertain || readingFiles) return;
    if (!content.bodyText.trim() || content.bodyText.trim() === replyContext?.signature?.trim()) {
      setError('请填写回复内容。');
      return;
    }
    const snapshot = contentRef.current;
    setSending(true);
    setError('');
    setResult(null);
    try {
      await persist(snapshot);
      const fingerprint = contentKey(snapshot);
      if (!attempt.current || attempt.current.fingerprint !== fingerprint)
        attempt.current = { key: crypto.randomUUID(), fingerprint };
      const response = await mailConversationsApi.reply(conversation.id, {
        ...snapshot,
        draftRevision: revision.current,
        idempotencyKey: attempt.current.key,
      });
      if (!mounted.current) return;
      setResult(response.reply);
      if (response.conversation && response.messages) {
        onCompleted({
          ...detail,
          ...response,
          draft: response.reply.status === 'accepted' ? null : detail.draft,
          replies: [
            response.reply,
            ...(detail.replies || []).filter((item) => item.id !== response.reply.id),
          ],
        });
        void mailConversationsApi
          .detail(conversation.id)
          .then((value) => {
            if (mounted.current) onCompleted(value);
          })
          .catch(() => {});
      }
      if (response.reply.status === 'accepted') {
        revision.current = undefined;
        const value = seed();
        savedKey.current = contentKey(value);
        contentRef.current = value;
        setContent(value);
        setEditorHtml(value.bodyHtml);
        setEditorReset((n) => n + 1);
        appendSignature.current = true;
        attempt.current = null;
      } else if (response.reply.status === 'failed') attempt.current = null;
    } catch (reason) {
      if (mounted.current) {
        setError(textError(reason));
        const status = (reason as { status?: number })?.status;
        if (status && status >= 400 && status < 500) {
          attempt.current = null;
          setSaveState('error');
        } else if (attempt.current)
          setResult({
            id: attempt.current.key,
            status: 'unknown',
            reason: '发送请求的结果尚未核实，请刷新会话确认，勿重复发送。',
          });
        else setSaveState('error');
      }
    } finally {
      if (mounted.current) setSending(false);
    }
  }
  const pendingReply = detail.replies?.find((item) => ['unknown', 'sending'].includes(item.status));
  const latestReply = detail.replies?.[0];
  return (
    <section
      ref={panel}
      className="mail-reply-panel"
      aria-label="回复邮件"
      data-empty={
        canReply &&
        !content.bodyText.trim() &&
        !content.attachments.length &&
        !formatting &&
        !loading &&
        !error
          ? true
          : undefined
      }
    >
      {result && <MailReplyResult reply={result} />}
      {!result && latestReply && <MailReplyResult reply={latestReply} />}
      {loading ? (
        <p className="mail-reply-loading">正在读取草稿…</p>
      ) : readFailed ? (
        <p className="mail-reply-error" role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              setError('');
              setDraftRetry((n) => n + 1);
            }}
          >
            重试读取草稿
          </button>
        </p>
      ) : (
        <>
          <div className="inbox-draft-meta">
            <span
              title={`发件人 ${replyContext?.from || conversation.account} · 收件人 ${recipient || '待核实'}`}
            >
              收件人 {recipientName ? `${recipientName} <${recipient}>` : recipient || '待核实'}
            </span>
            {detail.draft?.provenance && <b>待审核回复</b>}
            <span className={'mail-draft-state ' + saveState}>
              {sending
                ? '正在发送…'
                : saveState === 'saving'
                  ? '正在保存草稿…'
                  : saveState === 'changed'
                    ? '草稿待保存'
                    : saveState === 'error'
                      ? '草稿尚未保存'
                      : revision.current !== undefined
                        ? '草稿已保存'
                        : ''}
            </span>
          </div>
          <MailRichEditor
            key={editorReset}
            formatting={formatting}
            initialHtml={editorHtml}
            disabled={!canReply || sending || !!uncertain || !!pendingReply}
            onChange={(value) => {
              const sig =
                appendSignature.current && value.bodyText.trim() && signature.current.text
                  ? signature.current
                  : null;
              setContent((current) => ({
                ...current,
                bodyHtml: sig ? value.bodyHtml + '<br><br>' + sig.html : value.bodyHtml,
                bodyText: sig ? value.bodyText.trimEnd() + '\n\n' + sig.text : value.bodyText,
              }));
              setError('');
            }}
          />
          {!!content.attachments.length && (
            <div className="mail-reply-attachments">
              {content.attachments.map((attachment) => (
                <span key={attachment.id}>
                  <Paperclip size={14} />
                  <span>
                    {attachment.name}
                    <small>{sizeLabel(attachment.size)}</small>
                  </span>
                  <button
                    type="button"
                    aria-label={`移除附件 ${attachment.name}`}
                    disabled={sending || !!uncertain || !!pendingReply}
                    onClick={() =>
                      setContent((current) => ({
                        ...current,
                        attachments: current.attachments.filter(
                          (item) => item.id !== attachment.id,
                        ),
                      }))
                    }
                  >
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {error && (
            <div className="mail-reply-error" role="alert">
              {error}
              {saveState === 'error' && !uncertain && (
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    void persist(contentRef.current).catch((reason: unknown) =>
                      setError(textError(reason)),
                    );
                  }}
                >
                  重试保存草稿
                </button>
              )}
            </div>
          )}
          <footer className="mail-reply-actions">
            {!canSend && (
              <small className="inbox-send-status">
                {replyContext?.reason || '当前会话暂不可回复。'}
              </small>
            )}
            <button
              type="button"
              className="inbox-icon"
              aria-label="正文格式"
              title="正文格式"
              aria-pressed={formatting}
              onClick={() => setFormatting(!formatting)}
            >
              <Type size={15} />
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={
                sending ||
                loading ||
                !canSend ||
                !content.bodyText.trim() ||
                content.bodyText.trim() === replyContext?.signature?.trim() ||
                !!uncertain ||
                !!pendingReply ||
                readingFiles ||
                discarding
              }
              onClick={() => void send()}
            >
              {sending ? <LoaderCircle size={15} className="outreach-spin" /> : <Send size={15} />}
              {sending ? '正在发送…' : detail.draft?.provenance ? '批准发送' : '发送回复'}
            </button>
            <button
              type="button"
              className="btn subtle"
              disabled={!canReply || sending || readingFiles || !!uncertain || !!pendingReply}
              title="添加附件（最多 10 个，共 10 MB）"
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={15} />
              {readingFiles ? '读取附件…' : '添加附件'}
            </button>
            <input
              ref={fileInput}
              className="mail-file-input"
              type="file"
              multiple
              aria-label="上传回复附件"
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = '';
                void addFiles(files);
              }}
            />
            <button
              type="button"
              className="icon-button mail-discard-draft"
              title="丢弃草稿"
              aria-label="丢弃草稿"
              disabled={
                (!revision.current && contentKey(content) === savedKey.current) ||
                sending ||
                discarding ||
                !!uncertain ||
                !!pendingReply
              }
              onClick={() => void discard()}
            >
              <Trash2 size={15} />
            </button>
          </footer>
        </>
      )}
      {(uncertain || pendingReply) && (
        <button
          type="button"
          className="btn subtle mail-reply-check-result"
          onClick={() => {
            void mailConversationsApi
              .detail(conversation.id)
              .then((value) => {
                onCompleted(value);
                const current = value.replies?.find(
                  (item) =>
                    item.id === result?.id ||
                    (!!attempt.current && item.idempotencyKey === attempt.current.key),
                );
                if (current) setResult(current);
              })
              .catch((reason: unknown) => setError(textError(reason)));
          }}
        >
          刷新会话核实结果
        </button>
      )}
    </section>
  );
}
