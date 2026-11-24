import { useEffect, useState } from 'react';
import { Clock3, Mail, Pencil, Plus, Trash2 } from 'lucide-react';
import { outreachApi } from '../outreachApi';
import { Modal } from './ui';
import './sequence-policy.css';

interface Policy {
  name: string;
  revision: number;
  firstInstruction: string;
  firstBodyInstruction: string;
  steps: { day: number; instruction: string }[];
}
const issue = (error: unknown) =>
  error instanceof Error ? error.message : '读取或保存失败，请重试。';

function TemplatePreview({
  step,
  day,
  instruction,
  firstBodyInstruction,
}: {
  step: number;
  day?: number;
  instruction: string;
  firstBodyInstruction?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  async function generate() {
    setError('');
    setBusy(true);
    try {
      setPreview(
        await outreachApi('/sequence-policy/preview', {
          method: 'POST',
          body: JSON.stringify({ step, day, instruction, firstBodyInstruction }),
        }),
      );
    } catch (e) {
      setError(issue(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="template-preview">
      <button
        type="button"
        className="btn secondary"
        disabled={busy || (step > 0 && !instruction.trim())}
        onClick={() => void generate()}
      >
        {busy ? '正在生成…' : '预览示例邮件'}
      </button>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <article aria-live="polite">
          <strong>{preview.subject}</strong>
          <p>{preview.body}</p>
        </article>
      )}
    </div>
  );
}

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
  const [firstBodyInstruction, setFirstBodyInstruction] = useState(policy.firstBodyInstruction);
  const [firstInstruction, setFirstInstruction] = useState(policy.firstInstruction);
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
      setFirstInstruction(current.firstInstruction);
      setFirstBodyInstruction(current.firstBodyInstruction);
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
        body: JSON.stringify({
          name: name.trim(),
          revision,
          firstInstruction,
          firstBodyInstruction,
          steps,
        }),
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
      title="编辑邮件模板与跟进序列"
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
          <p>
            预览使用示例客户 Example Dealer
            和卷帘产品。正式草稿读取客户及已审核产品事实，由负责邮箱添加称呼和签名，并执行发送限制。
          </p>
          <fieldset>
            <legend>首封开发信</legend>
            <label>
              首封主题与正文写作要求
              <textarea
                rows={2}
                maxLength={1200}
                value={firstBodyInstruction}
                onChange={(e) => setFirstBodyInstruction(e.target.value)}
                placeholder="默认先写一条有依据的客户观察，再介绍品牌和供货产品。"
              />
            </label>
            <label>
              首封结尾写作要求
              <textarea
                rows={2}
                maxLength={1200}
                value={firstInstruction}
                onChange={(e) => setFirstInstruction(e.target.value)}
                placeholder="默认询问是否需要简短产品介绍。可填写新的写作要求或建议问句。"
              />
            </label>
            <TemplatePreview
              key={JSON.stringify([firstBodyInstruction, firstInstruction])}
              firstBodyInstruction={firstBodyInstruction}
              step={0}
              instruction={firstInstruction}
            />
          </fieldset>
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
              <TemplatePreview
                key={JSON.stringify([row.day, row.instruction, index])}
                step={index + 1}
                day={Number(row.day)}
                instruction={row.instruction}
              />
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
              <p>首封模板用于新生成的草稿。启用跟进时，按首封提交时的规则排期。</p>
            </div>
            <button
              className="btn primary"
              onClick={() => {
                setDraft(policy);
                setSaved(false);
              }}
            >
              <Pencil size={15} /> 编辑邮件模板
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
                <p>{policy.firstInstruction || '询问对方是否需要简短的产品介绍。'}</p>
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
