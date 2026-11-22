import { useState } from 'react';
import { outreachApi } from '../outreachApi';
import { ReplySources } from './ReplyPreview';
import { mailConversationsApi, type MailConversationDetail } from '../services/mailConversations';

export function ReceptionControls({
  detail,
  onChange,
}: {
  detail: MailConversationDetail;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const r = detail.reception;
  if (!r || !detail.conversation.customerId) return null;
  async function update(action: string) {
    setBusy(true);
    setError('');
    try {
      let revision;
      if (action === 'regenerate') {
        const { draft } = await mailConversationsApi.draft(detail.conversation.id);
        if (
          draft &&
          (!draft.provenance || draft.edited) &&
          !window.confirm('用当前资料重新生成将替换已编辑的草稿，继续吗？')
        )
          return;
        revision = draft?.revision || 0;
      }
      await outreachApi(
        '/conversations/' +
          encodeURIComponent(detail.conversation.id) +
          (action === 'regenerate' ? '/regenerate' : '/ownership'),
        { method: 'POST', body: JSON.stringify({ action, sourceId: r?.sourceId, revision }) },
      );
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mail-reception-controls">
      <div>
        <strong>{r.stopped ? '客户已停止联系' : r.human ? '人工接管中' : '邮箱接待'}</strong>{' '}
        {r.owner}
        {r.reason && <p>{r.reason}</p>}
      </div>
      <div className="workbook-controls">
        {!r.stopped && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => void update(r.human ? 'resume' : 'takeover')}
          >
            {r.human ? '恢复邮箱接待' : '人工接管'}
          </button>
        )}
        {!r.human &&
          !r.stopped &&
          r.sourceId &&
          ['review', 'attention'].includes(r.state || '') && (
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => void update('regenerate')}
            >
              按当前资料重新生成
            </button>
          )}
      </div>
      {error && <p role="alert">{error}</p>}
      {detail.draft?.provenance && <ReplySources sources={detail.draft.provenance.sources} />}
    </div>
  );
}
