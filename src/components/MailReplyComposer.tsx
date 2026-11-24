import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, Paperclip, Send, Sparkles, Trash2, Type, X } from 'lucide-react';
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
import { ReplyPhotoPicker } from './ReplyPhotoPicker';
import { outreachApi } from '../outreachApi';
import { ReplySources } from './ReplyPreview';

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
  expanded = false,
  actionHost,
  targetMessageId,
  replyRequest,
  onCompleted,
}: {
  detail: MailConversationDetail;
  expanded?: boolean;
  actionHost?: HTMLElement | null;
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
  const previewDialog = useRef<HTMLDialogElement>(null);
  const [previewPhoto, setPreviewPhoto] = useState<MailReplyAttachment>();
  const [generating, setGenerating] = useState(false);
  const generationLock = useRef(false);
  const [provenance, setProvenance] = useState<MailReplyDraft['provenance']>();
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
  saveOnLeave.current =
    !loading && !readFailed && !uncertain && !sending && !discarding && !generating;
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
  const adoptDraft = useCallback((draft: MailReplyDraft) => {
    const value = {
      replyToMessageId: draft.replyToMessageId,
      bodyHtml: draft.bodyHtml,
      bodyText: draft.bodyText,
      attachments: draft.attachments || [],
    };
    appendSignature.current = false;
    revision.current = draft.revision;
    savedKey.current = contentKey(value);
    contentRef.current = value;
    setContent(value);
    setEditorHtml(value.bodyHtml);
    setEditorReset((n) => n + 1);
    setProvenance(draft.provenance);
    setSaveState('saved');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setReadFailed(false);
    void mailConversationsApi
      .draft(conversation.id, controller.signal)
      .then(({ draft }) => {
        if (controller.signal.aborted) return;
        if (draft) adoptDraft(draft);
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
  }, [conversation.id, draftRetry, adoptDraft]);

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
          if (mounted.current) {
            setProvenance(draft.provenance);
            setSaveState(contentKey(contentRef.current) === savedKey.current ? 'saved' : 'changed');
          }
          return draft;
        });
      saving.current = operation;
      return operation;
    },
    [conversation.id],
  );
  useEffect(() => {
    if (loading || readFailed || !canReply || sending || discarding || uncertain || generating)
      return;
    if (contentKey(content) === savedKey.current) return;
    const timeout = window.setTimeout(() => {
      void persist(content).catch((reason: unknown) => {
        if (mounted.current) {
          setSaveState('error');
          setError(`草稿未保存：${textError(reason)}`);
        }
      });
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [content, loading, readFailed, canReply, sending, discarding, uncertain, generating, persist]);
  // Finish queued changes when switching conversations; this only saves a draft.
  useEffect(
    () => () => {
      if (saveOnLeave.current && contentKey(contentRef.current) !== savedKey.current)
        void persist(contentRef.current).catch(() => {});
    },
    [persist],
  );
  useEffect(() => {
    if (!targetMessageId || loading || generationLock.current) return;
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
    if (generationLock.current) return;
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
      setProvenance(undefined);
      setSaveState('saved');
    } catch (reason) {
      if (mounted.current) setError(textError(reason));
    } finally {
      if (mounted.current) setDiscarding(false);
    }
  }
  async function send() {
    if (sending || !canSend || readFailed || uncertain || readingFiles || generationLock.current)
      return;
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
      if (
        snapshot.attachments.some(
          (a) => a.id.startsWith('kbphoto_') || a.id.startsWith('attachment_'),
        )
      )
        await outreachApi('/conversations/' + encodeURIComponent(conversation.id) + '/photo-check');
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
        setProvenance(undefined);
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
  const hasDraft = !!(
    content.bodyText.trim() ||
    content.attachments.length ||
    /<img\b/i.test(content.bodyHtml)
  );
  const latestCustomerMail = [...detail.messages]
    .reverse()
    .find(
      (message) =>
        message.direction === 'inbound' &&
        message.source === 'imap' &&
        message.classification === 'normal',
    );
  const draftState =
    saveState === 'saved' && contentKey(content) !== savedKey.current ? 'changed' : saveState;
  const sourceEligible =
    !!targetMessage &&
    targetMessage.id === latestCustomerMail?.id &&
    !targetMessage.bodyUnavailable &&
    !!targetMessage.bodyText.trim();
  let generateReason = '';
  if (!sourceEligible || !canReply || detail.reception?.stopped)
    generateReason = '请选择可回复的最新客户来信';
  else if (hasDraft) generateReason = '已有草稿，正文及附件会保留';
  else if (!replyContext?.draftModel) generateReason = '请先在 API 连接中配置起草模型';
  const busy =
    loading || readFailed || sending || discarding || readingFiles || !!uncertain || !!pendingReply;
  async function generateDraft() {
    if (generateReason || busy || generationLock.current) return;
    generationLock.current = true;
    setGenerating(true);
    setError('');
    try {
      await saving.current.catch(() => null);
      if (!mounted.current) return;
      const { draft } = await mailConversationsApi.generateDraft(
        conversation.id,
        contentRef.current.replyToMessageId,
        revision.current || 0,
      );
      if (mounted.current) adoptDraft(draft);
    } catch (reason) {
      if (!mounted.current) return;
      const status = (reason as { status?: number })?.status;
      if (status === 409 || !status) {
        const current = await mailConversationsApi.draft(conversation.id).catch(() => null);
        if (mounted.current && current?.draft) adoptDraft(current.draft);
      }
      if (mounted.current) setError(textError(reason));
    } finally {
      generationLock.current = false;
      if (mounted.current) setGenerating(false);
    }
  }
  return (
    <section
      ref={panel}
      className="mail-reply-panel"
      aria-label="回复邮件"
      data-empty={
        !expanded &&
        canReply &&
        !hasDraft &&
        revision.current === undefined &&
        !provenance &&
        draftState === 'saved' &&
        !generating &&
        !sending &&
        !formatting &&
        !loading &&
        !error
          ? true
          : undefined
      }
    >
      {actionHost &&
        createPortal(
          <button
            type="button"
            className="inbox-draft-assist"
            title={generateReason || '按本邮箱身份、邮件往来和可用资料起草正式回信'}
            disabled={!!generateReason || busy || generating}
            aria-busy={generating}
            onClick={() => void generateDraft()}
          >
            {generating ? (
              <LoaderCircle size={14} className="outreach-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            <span>AI起草</span>
          </button>,
          actionHost,
        )}
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
            {provenance && (
              <b role="status">
                {provenance.generator === 'model' ? 'AI草稿 · 待审核' : '待审核回复'}
              </b>
            )}
            <span className={'mail-draft-state ' + draftState}>
              {sending
                ? '正在发送…'
                : draftState === 'saving'
                  ? '正在保存草稿…'
                  : draftState === 'changed'
                    ? '草稿待保存'
                    : saveState === 'error'
                      ? '草稿尚未保存'
                      : revision.current !== undefined
                        ? '草稿已保存'
                        : ''}
            </span>
          </div>
          {provenance?.photoNote && (
            <p role="status" className="mail-source-reason">
              {provenance.photoNote}
            </p>
          )}
          {provenance && <ReplySources sources={provenance.sources} reason={provenance.reason} />}
          <MailRichEditor
            key={editorReset}
            formatting={formatting}
            initialHtml={editorHtml}
            disabled={!canReply || sending || generating || !!uncertain || !!pendingReply}
            onChange={(value) => {
              if (generationLock.current) return;
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
          {sourceEligible && canReply && (
            <ReplyPhotoPicker
              key={content.replyToMessageId}
              conversation={conversation.id}
              source={content.replyToMessageId}
              attachments={content.attachments}
              disabled={busy || generating}
              onAdd={(photo) => {
                const current = contentRef.current;
                if (
                  current.replyToMessageId !== content.replyToMessageId ||
                  !mounted.current ||
                  generationLock.current ||
                  current.attachments.some(
                    (a) =>
                      a.id === photo.id ||
                      (a.name === photo.name && a.contentBase64 === photo.contentBase64),
                  )
                )
                  return;
                const issue = validateMailAttachments([...current.attachments, photo]);
                if (issue) {
                  setError(issue);
                  return;
                }
                setContent({ ...current, attachments: [...current.attachments, photo] });
              }}
            />
          )}
          <dialog
            className="reply-photo-dialog"
            aria-label="草稿图片预览"
            ref={previewDialog}
            onClose={() => setPreviewPhoto(undefined)}
          >
            {previewPhoto && (
              <>
                <img
                  src={'data:image/jpeg;base64,' + previewPhoto.contentBase64}
                  alt={previewPhoto.name + ' 大图'}
                />
                <p>{previewPhoto.name}</p>
              </>
            )}
            <button type="button" onClick={() => previewDialog.current?.close()}>
              关闭预览
            </button>
          </dialog>
          {!!content.attachments.length && (
            <div className="mail-reply-attachments">
              {content.attachments.map((attachment) => (
                <span key={attachment.id}>
                  {attachment.contentType === 'image/jpeg' ? (
                    <button
                      className="reply-photo-thumb"
                      type="button"
                      aria-label={'预览 ' + attachment.name}
                      onClick={() => {
                        setPreviewPhoto(attachment);
                        previewDialog.current?.showModal();
                      }}
                    >
                      <img
                        width={64}
                        height={48}
                        style={{ objectFit: 'contain' }}
                        src={'data:image/jpeg;base64,' + attachment.contentBase64}
                        alt={attachment.name}
                      />
                    </button>
                  ) : (
                    <Paperclip size={14} />
                  )}
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
                generating ||
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
              {sending ? '正在发送…' : provenance ? '批准发送' : '发送回复'}
            </button>
            <button
              type="button"
              className="btn subtle"
              disabled={
                !canReply || sending || generating || readingFiles || !!uncertain || !!pendingReply
              }
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
                generating ||
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
