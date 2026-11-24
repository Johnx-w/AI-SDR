import { useEffect, useState } from 'react';
import { outreachApi } from '../outreachApi';
import { messageOf, sourceUrl } from '../services/materials';
import type { MailReplyAttachment } from '../services/mailConversations';
import { PhotoPreview, type ProductPhoto } from './WorkbookPhotos';
interface Model {
  documentId: string;
  sheet: string;
  item: string;
  ambiguous: boolean;
  photos: (ProductPhoto & { productId: string })[];
}
export function ReplyPhotoPicker({
  conversation,
  source,
  attachments,
  disabled,
  onAdd,
}: {
  conversation: string;
  source: string;
  attachments: MailReplyAttachment[];
  disabled: boolean;
  onAdd: (photo: MailReplyAttachment) => void;
}) {
  const [open, setOpen] = useState(false),
    [models, setModels] = useState<Model[] | null>(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState('');
  const base =
    '/conversations/' +
    encodeURIComponent(conversation) +
    '/photo-options?source=' +
    encodeURIComponent(source);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    setModels(null);
    setError('');
    outreachApi<Model[]>(base, { signal: c.signal })
      .then((v) => {
        if (!c.signal.aborted) setModels(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(messageOf(e));
      });
    return () => c.abort();
  }, [open, base]);
  return (
    <div>
      <button
        className="photo-open"
        type="button"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        从该型号选图
      </button>
      {open && (
        <section className="reply-photo-picker" aria-label="型号配图">
          {error && <p role="alert">{error}</p>}
          {models === null && !error && <small>正在读取产品图片…</small>}
          {models?.length === 0 && (
            <small>当前邮箱引用的已审核资料中，没有找到来信所指的型号。</small>
          )}
          {models?.map((m) => (
            <div key={JSON.stringify([m.documentId, m.sheet, m.item])}>
              <strong>
                {m.sheet} · {m.item}
              </strong>
              {m.ambiguous && <small>同名型号有多条记录，请核对品类后选择。</small>}
              {!m.photos.length && <small>该型号尚未维护图片。</small>}
              {m.photos.map((p) => {
                const added = attachments.some((a) => a.id === p.id);
                return (
                  <div className="photo-candidate" key={p.id}>
                    <PhotoPreview
                      url={sourceUrl(p.productId, p.documentId) + '/photos/' + p.id}
                      label={p.item + ' ' + p.slot}
                    />
                    <span>
                      {p.slot}
                      <small>{p.origin}</small>
                    </span>
                    <button
                      type="button"
                      disabled={disabled || added || !!pending || attachments.length >= 10}
                      onClick={async () => {
                        setPending(p.id);
                        setError('');
                        try {
                          const photo = await outreachApi<MailReplyAttachment>(
                            base + '&image=' + p.id,
                          );
                          onAdd(photo);
                        } catch (e) {
                          setError(messageOf(e));
                        } finally {
                          setPending('');
                        }
                      }}
                    >
                      {added ? '已添加' : pending === p.id ? '添加中…' : '加入草稿'}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
