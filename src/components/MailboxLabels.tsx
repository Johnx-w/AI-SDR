import { useState } from 'react';
import { Modal } from './ui';
import { outreachApi, type MailboxTagState, type OutreachMailbox } from '../outreachApi';

export function MailboxLabels({
  state,
  mailboxes,
  loadError,
  onRetry,
  onClose,
  onChange,
}: {
  state: MailboxTagState | null;
  mailboxes: OutreachMailbox[];
  loadError: string;
  onRetry: () => void;
  onClose: () => void;
  onChange: (v: MailboxTagState) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [name, setName] = useState(''),
    [target, setTarget] = useState('');
  const [mode, setMode] = useState<'create' | 'rename' | 'merge' | 'delete'>('create');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const current = state?.tags.find((tag) => tag.id === active);
  function select(id: string) {
    setActive(id);
    setMode('create');
    setName('');
    setTarget('');
    setError('');
    setNotice('');
  }
  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await outreachApi<MailboxTagState>('/mailbox-tags' + path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      onChange(next);
      if (!next.tags.some((t) => t.id === active)) setActive('');
      if (mode === 'create' && path === '')
        setActive(next.tags.find((t) => t.name === name.normalize('NFKC').trim())?.id || '');
      setMode('create');
      setName('');
      setTarget('');
      setNotice('标签设置已保存。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '标签保存失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="邮箱标签"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body mailbox-labels">
        {loadError && (
          <div role="alert" className="outreach-alert error">
            {loadError}
            <button className="btn secondary" onClick={onRetry}>
              重试
            </button>
          </div>
        )}
        {!state && !loadError && <p role="status">正在读取标签…</p>}
        {state && (
          <fieldset disabled={busy}>
            <legend>标签管理</legend>
            <div className="label-choices">
              {state.tags.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={'btn ' + (active === t.id ? 'primary' : 'secondary')}
                  onClick={() => select(t.id)}
                >
                  {t.name} <small>{state.assignments.filter((a) => a.tagId === t.id).length}</small>
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (mode === 'merge' && current && target)
                  void mutate('/' + encodeURIComponent(current.id) + '/merge', 'POST', {
                    targetId: target,
                  });
                else if (mode === 'delete' && current)
                  void mutate('/' + encodeURIComponent(current.id), 'DELETE');
                else if (name.trim())
                  void mutate(
                    mode === 'rename' && current ? '/' + encodeURIComponent(current.id) : '',
                    mode === 'rename' ? 'PATCH' : 'POST',
                    { name: name.trim() },
                  );
              }}
            >
              {mode === 'create' || mode === 'rename' ? (
                <label>
                  {mode === 'rename' ? '修改名称' : '新标签'}
                  <input
                    required
                    name="tagName"
                    maxLength={64}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              ) : mode === 'merge' ? (
                <label>
                  合并到
                  <select
                    aria-label="合并到"
                    required
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">选择目标标签</option>
                    {state.tags
                      .filter((t) => t.id !== active)
                      .map((t) => (
                        <option value={t.id} key={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <span>从所有邮箱移除「{current?.name}」？</span>
              )}
              <button type="submit" className={'btn ' + (mode === 'delete' ? 'danger' : 'primary')}>
                {
                  { create: '新增标签', rename: '保存名称', merge: '确认合并', delete: '确认删除' }[
                    mode
                  ]
                }
              </button>
              {mode !== 'create' && (
                <button type="button" className="btn subtle" onClick={() => select(active)}>
                  取消
                </button>
              )}
            </form>
            {current && (
              <div className="label-choices">
                <strong>{current.name}</strong>
                <button
                  className="btn subtle"
                  onClick={() => {
                    setMode('rename');
                    setName(current.name);
                  }}
                >
                  改名
                </button>
                <button
                  className="btn subtle"
                  disabled={state.tags.length < 2}
                  onClick={() => {
                    setMode('merge');
                    setTarget('');
                  }}
                >
                  合并
                </button>
                <button className="btn subtle" onClick={() => setMode('delete')}>
                  删除
                </button>
              </div>
            )}
            <table className="outreach-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="选择全部邮箱"
                      checked={!!mailboxes.length && selected.length === mailboxes.length}
                      onChange={(e) =>
                        setSelected(e.target.checked ? mailboxes.map((m) => m.id) : [])
                      }
                    />
                  </th>
                  <th>邮箱</th>
                  <th>标签</th>
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={'选择 ' + m.email}
                        checked={selected.includes(m.id)}
                        onChange={(e) =>
                          setSelected((ids) =>
                            e.target.checked ? [...ids, m.id] : ids.filter((id) => id !== m.id),
                          )
                        }
                      />
                    </td>
                    <td>{m.email}</td>
                    <td>
                      {state.tags
                        .filter((t) =>
                          state.assignments.some((a) => a.mailboxId === m.id && a.tagId === t.id),
                        )
                        .map((t) => t.name)
                        .join('、') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="modal-actions">
              {(['remove', 'add'] as const).map((action) => (
                <button
                  key={action}
                  className={'btn ' + (action === 'add' ? 'primary' : 'secondary')}
                  disabled={!current || !selected.length}
                  onClick={() =>
                    void mutate('/assign', 'POST', {
                      mailboxIds: selected,
                      tagIds: [active],
                      action,
                    })
                  }
                >
                  {action === 'add' ? '添加' : '移除'}所选标签
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="outreach-alert error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    </Modal>
  );
}
