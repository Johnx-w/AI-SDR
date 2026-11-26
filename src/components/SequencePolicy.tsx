import { useEffect, useState } from 'react';
import { Clock3, Mail, Pencil, Plus, Trash2 } from 'lucide-react';
import { outreachApi } from '../outreachApi';
import { Modal } from './ui';
import './sequence-policy.css';

import { SequenceEmailComposer } from './SequenceEmailComposer';
import {
  defaultTemplate,
  normalizeTemplate,
  type EmailTemplate,
} from '../domain/sequence-email.mjs';
import choices from '../domain/mail-writing-options.json';
type Writing = Partial<Record<keyof typeof choices, string>>;
interface Policy {
  firstTemplate?: EmailTemplate;
  firstWriting?: Writing;
  name: string;
  revision: number;
  firstInstruction: string;
  firstBodyInstruction: string;
  steps: { day: number; instruction: string; writing?: Writing; template?: EmailTemplate }[];
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
  const [active, setActive] = useState('first');
  const [customer, setCustomer] = useState('distributor');
  const [firstTemplate, setFirstTemplate] = useState(policy.firstTemplate ?? defaultTemplate(true));
  const [firstWriting, setFirstWriting] = useState<Writing>(policy.firstWriting ?? {});
  const [revision, setRevision] = useState(policy.revision);
  const [firstBodyInstruction, setFirstBodyInstruction] = useState(policy.firstBodyInstruction);
  const [firstInstruction, setFirstInstruction] = useState(policy.firstInstruction);
  const [name, setName] = useState(policy.name);
  const draftRows = (steps: Policy['steps']) =>
    steps.map((step) => ({ ...step, day: String(step.day), id: crypto.randomUUID() }));
  const [rows, setRows] = useState(() => draftRows(policy.steps));
  const chronologicalSteps = [...rows].sort((a, b) => Number(a.day) - Number(b.day));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const row = rows.find((r) => r.id === active);
  const writing = (row ? row.writing : firstWriting) ?? {};
  const changeRow = (patch: Partial<(typeof rows)[number]>) =>
    setRows(rows.map((r) => (r.id === active ? { ...r, ...patch } : r)));
  const n = row ? rows.indexOf(row) + 1 : 0;
  const [conflict, setConflict] = useState(false);
  async function reload() {
    setBusy(true);
    try {
      const current = await outreachApi<Policy>('/sequence-policy');
      setActive('first');
      setFirstTemplate(current.firstTemplate ?? defaultTemplate(true));
      setFirstWriting(current.firstWriting ?? {});
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
    try {
      normalizeTemplate(firstTemplate, true);
      for (const r of rows) {
        try {
          normalizeTemplate(r.template, false);
        } catch (e) {
          setActive(r.id);
          setError(issue(e));
          return;
        }
      }
    } catch (e) {
      setActive('first');
      setError(issue(e));
      return;
    }
    const invalid = rows.find(
      (r) =>
        !Number.isInteger(Number(r.day)) ||
        Number(r.day) < 1 ||
        Number(r.day) > 365 ||
        (!r.instruction.trim() &&
          !r.writing?.angle &&
          !r.writing?.reply &&
          !normalizeTemplate(r.template, false)),
    );
    if (invalid) {
      setActive(invalid.id);
      setError('请填写有效跟进日，并选择写法或填写写作要求。');
      return;
    }
    const steps = rows.map((row) => ({
      day: Number(row.day),
      instruction: row.instruction.trim(),
      writing: row.writing ?? {},
      template: row.template ?? defaultTemplate(false),
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
          firstWriting,
          firstTemplate,
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
    const id = crypto.randomUUID();
    setRows([...rows, { id, day: String(day), instruction: '' }]);
    setActive(id);
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
          <nav className="sequence-picker" aria-label="选择邮件">
            <button type="button" aria-pressed={!row} onClick={() => setActive('first')}>
              <Mail size={15} />
              首封开发信
            </button>
            {chronologicalSteps.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={r.id === active}
                onClick={() => setActive(r.id)}
              >
                <Clock3 size={15} />第 {r.day || '…'} 天跟进
              </button>
            ))}
            <button type="button" disabled={rows.length >= 12} onClick={add}>
              <Plus size={15} />
              添加步骤
            </button>
          </nav>

          {row && (
            <div className="sequence-edit-row">
              <label>
                首封后第几天
                <input
                  type="number"
                  aria-label={'跟进 ' + n + ' 天数'}
                  min={1}
                  max={365}
                  required
                  value={row.day}
                  onChange={(e) => changeRow({ day: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={'删除跟进 ' + n}
                onClick={() => {
                  setRows(rows.filter((r) => r.id !== active));
                  setActive('first');
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          )}
          <SequenceEmailComposer
            stepKey={active}
            first={!row}
            template={row ? (row.template ?? defaultTemplate(false)) : firstTemplate}
            onChange={(next) => (row ? changeRow({ template: next }) : setFirstTemplate(next))}
            library={[
              ...(firstTemplate.variables ?? []),
              ...rows.flatMap((r) => r.template?.variables ?? []),
            ]}
            customer={customer}
            onCustomer={setCustomer}
            previewInput={{
              step: row ? chronologicalSteps.indexOf(row) + 1 : 0,
              day: row ? Number(row.day) : undefined,
              instruction: row ? row.instruction : firstInstruction,
              firstBodyInstruction,
              firstInstruction,
              firstTemplate,
              firstWriting,
              priorSteps: chronologicalSteps.map((r) => ({ ...r, day: Number(r.day) })),
              writing,
            }}
            settings={
              <div className="sequence-fields">
                {(Object.keys(choices) as (keyof typeof choices)[]).map((k) => (
                  <label key={k}>
                    {k === 'angle'
                      ? row
                        ? '这次补充什么'
                        : '首封切入点'
                      : k === 'reply'
                        ? '希望客户回什么'
                        : '邮件口吻'}
                    <select
                      value={writing[k] || ''}
                      onChange={(e) => {
                        const next = { ...writing, [k]: e.target.value };
                        if (row) changeRow({ writing: next });
                        else setFirstWriting(next);
                      }}
                    >
                      <option value="">默认写法</option>
                      {Object.entries(choices[k]).map(([key, v]) => (
                        <option key={key} value={key}>
                          {v[0]}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                {row ? (
                  <label>
                    补充写作要求
                    <textarea
                      aria-label={'跟进 ' + n + ' 写作要求'}
                      rows={2}
                      maxLength={1200}
                      value={row.instruction}
                      onChange={(e) => changeRow({ instruction: e.target.value })}
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      主题与正文要求
                      <textarea
                        aria-label="首封主题与正文写作要求"
                        rows={2}
                        maxLength={1200}
                        value={firstBodyInstruction}
                        onChange={(e) => setFirstBodyInstruction(e.target.value)}
                      />
                    </label>
                    <label>
                      结尾要求
                      <textarea
                        aria-label="首封结尾写作要求"
                        rows={2}
                        maxLength={1200}
                        value={firstInstruction}
                        onChange={(e) => setFirstInstruction(e.target.value)}
                      />
                    </label>
                  </>
                )}
              </div>
            }
          />
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
                {(policy.firstTemplate || policy.firstBodyInstruction) && (
                  <p>{policy.firstTemplate?.subject || policy.firstBodyInstruction}</p>
                )}
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
                  <p>
                    {step.template?.body ||
                      step.instruction ||
                      Object.entries(step.writing ?? {})
                        .map(
                          ([k, v]) =>
                            Object.entries(choices[k as keyof typeof choices]).find(
                              ([key]) => key === v,
                            )?.[1][0],
                        )
                        .filter(Boolean)
                        .join(' · ')}
                  </p>
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
