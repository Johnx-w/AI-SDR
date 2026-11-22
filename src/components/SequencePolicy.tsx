import { useEffect, useState } from 'react';
import { Clock3, Mail, Pencil, Plus, Trash2 } from 'lucide-react';
import { outreachApi } from '../outreachApi';
import { Modal } from './ui';
import './sequence-policy.css';

interface Policy {
  name: string;
  revision: number;
  steps: { day: number; instruction: string }[];
}
const issue = (error: unknown) =>
  error instanceof Error ? error.message : '读取或保存失败，请重试。';

function PolicyEditor({
  policy,
  close,
  onSave,
}: {
  policy: Policy;
  close: () => void;
  onSave: (next: Policy) => void;
}) {
  const [revision, setRevision] = useState(policy.revision);
  const [name, setName] = useState(policy.name);
  const draftRows = (steps: Policy['steps']) =>
    steps.map((step) => ({ ...step, day: String(step.day), id: crypto.randomUUID() }));
  const [rows, setRows] = useState(() => draftRows(policy.steps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  async function reload() {
    setBusy(true);
    try {
      const current = await outreachApi<Policy>('/sequence-policy');
      setName(current.name);
      setRows(draftRows(current.steps));
      setRevision(current.revision);
      setError('');
      setConflict(false);
    } catch (e) {
      setError(issue(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const steps = rows.map((row) => ({
      day: Number(row.day),
      instruction: row.instruction.trim(),
    }));
    if (new Set(steps.map((step) => step.day)).size !== steps.length) {
      setError('同一天只能安排一封跟进信，请修改跟进日。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await outreachApi<Policy>('/sequence-policy', {
        method: 'PUT',
        body: JSON.stringify({ name: name.trim(), revision, steps }),
      });
      onSave(next);
    } catch (e) {
      setError(issue(e));
      setConflict((e as { status?: number })?.status === 409);
    } finally {
      setBusy(false);
    }
  }
  function add() {
    const days = rows.map((row) => Number(row.day));
    let day = Math.max(0, ...days) + 3;
    if (day > 365) {
      day = 1;
      while (days.includes(day)) day++;
    }
    setRows([...rows, { id: crypto.randomUUID(), day: String(day), instruction: '' }]);
  }
  return (
    <Modal
      title="编辑跟进序列"
      wide
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form className="sequence-form" onSubmit={save}>
        <div className="modal-body sequence-form-body">
          <label>
            序列名称
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p>跟进日从首封实际发送算起。保存时按天数排序，写作要求会用于生成对应步骤的邮件。</p>
          {rows.map((row, index) => (
            <fieldset key={row.id}>
              <legend>跟进 {index + 1}</legend>
              <div className="sequence-edit-row">
                <label>
                  首封后第几天
                  <input
                    aria-label={'跟进 ' + (index + 1) + ' 天数'}
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    required
                    value={row.day}
                    onChange={(e) =>
                      setRows(
                        rows.map((r) => (r.id === row.id ? { ...r, day: e.target.value } : r)),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={'删除跟进 ' + (index + 1)}
                  onClick={() => setRows(rows.filter((r) => r.id !== row.id))}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <label>
                AI 写作要求
                <textarea
                  aria-label={'跟进 ' + (index + 1) + ' 写作要求'}
                  rows={2}
                  required
                  maxLength={1200}
                  value={row.instruction}
                  placeholder="例如，询问客户是否需要轨道样品。"
                  onChange={(e) =>
                    setRows(
                      rows.map((r) =>
                        r.id === row.id ? { ...r, instruction: e.target.value } : r,
                      ),
                    )
                  }
                />
              </label>
            </fieldset>
          ))}
          {!rows.length && <p>当前仅发首封。添加步骤后，未回复的客户可继续收到跟进信。</p>}
          <button
            type="button"
            className="btn secondary"
            disabled={rows.length >= 12}
            onClick={add}
          >
            <Plus size={15} /> 添加步骤
          </button>
          {error && (
            <div className="outreach-alert error" role="alert">
              {error}
              {conflict && (
                <button
                  type="button"
                  className="text-link"
                  disabled={busy}
                  onClick={() => void reload()}
                >
                  载入最新规则
                </button>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy || conflict}>
            {busy ? '请稍候…' : '保存序列'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SequencePolicyPanel({ refreshToken }: { refreshToken: number }) {
  const [policy, setPolicy] = useState<Policy | null>(null),
    [draft, setDraft] = useState<Policy | null>(null);
  const [retry, setRetry] = useState(0),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    outreachApi<Policy>('/sequence-policy', { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setPolicy(next);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(issue(e));
      });
    return () => controller.abort();
  }, [refreshToken, retry]);
  return (
    <section className="panel sequence-policy" aria-label="未回复跟进规则">
      {error && (
        <div role="alert" className="outreach-alert error">
          {error}
          <button className="text-link" onClick={() => setRetry((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
      {policy ? (
        <>
          <header>
            <div>
              <h3>{policy.name}</h3>
              <p>
                启用自动跟进的计划共用此序列。修改对之后提交的首封生效，已排期的邮件按原安排执行。
              </p>
            </div>
            <button
              className="btn primary"
              onClick={() => {
                setDraft(policy);
                setSaved(false);
              }}
            >
              <Pencil size={15} /> 编辑序列
            </button>
          </header>
          <ol>
            <li>
              <span className="sequence-marker">
                <Mail size={16} />
              </span>
              <div>
                <small>起点</small>
                <strong>首封开发信</strong>
                <p>负责邮箱发出首封后开始计时。</p>
              </div>
            </li>
            {policy.steps.map((step, i) => (
              <li key={step.day}>
                <span className="sequence-marker">
                  <Clock3 size={16} />
                </span>
                <div>
                  <small>首封后第 {step.day} 天</small>
                  <strong>跟进 {i + 1}</strong>
                  <p>{step.instruction}</p>
                </div>
              </li>
            ))}
          </ol>
          <footer>
            <p>
              {policy.steps.length
                ? '在同一邮件线程跟进。客户回信、退订或人工接管时停止。'
                : '仅发首封，当前序列没有后续跟进。'}
            </p>
            {saved && <span role="status">序列已保存</span>}
          </footer>
        </>
      ) : (
        !error && <p role="status">正在读取规则…</p>
      )}
      {draft && (
        <PolicyEditor
          policy={draft}
          close={() => setDraft(null)}
          onSave={(next) => {
            setPolicy(next);
            setDraft(null);
            setSaved(true);
          }}
        />
      )}
    </section>
  );
}
