import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  Inbox,
  Mail,
  Play,
  Save,
  MessageSquareText,
  ShieldCheck,
  Workflow,
  SlidersHorizontal,
} from 'lucide-react';
import { outreachApi, type OutreachMailbox, type OutreachProduct } from '../outreachApi';
import { siteAllowsProduct } from '../domain/mail-site.mjs';
import { ReplySources, type ReplySource } from './ReplyPreview';
import { mailConversationsApi, type MailThread } from '../services/mailConversations';

type Mode = 'manual' | 'review' | 'auto' | 'business';
const modes: [Mode, string][] = [
  ['manual', '业务员手动回复'],
  ['review', '生成草稿，逐封审核'],
  ['auto', '自动回复已核实的产品问题'],
  ['business', '自动回复常规业务与已核实的产品问题'],
];
type Result = { body: string; reason: string; decision: string; sources: ReplySource[] };
export function MailReplySettings({
  box,
  boxes,
  products,
  onSaved,
}: {
  box: OutreachMailbox;
  boxes: OutreachMailbox[];
  products: OutreachProduct[];
  onSaved: () => Promise<unknown>;
}) {
  const [query, setQuery] = useSearchParams();
  const testing = query.get('step') === 'test';
  function switchView(test: boolean) {
    const next = new URLSearchParams(query);
    if (test) next.set('step', 'test');
    else next.delete('step');
    setQuery(next);
  }
  const [mode, setMode] = useState<Mode>(
    box.autoBusinessReplies ? 'business' : box.replyMode || 'manual',
  );
  const [persona, setPersona] = useState(box.draftPersona || ''),
    [ids, setIds] = useState(box.knowledgeProductIds || []);
  const [subject, setSubject] = useState(''),
    [body, setBody] = useState(''),
    [result, setResult] = useState<Result | null>(null);
  const [threads, setThreads] = useState<MailThread[] | null>(null);
  const [mailLoading, setMailLoading] = useState(false);
  async function chooseMail(id?: string) {
    if (mailLoading) return;
    setMailLoading(true);
    setError('');
    try {
      if (!id) {
        const list = await mailConversationsApi.list({
          mailboxId: box.id,
          page: 1,
          pageSize: 20,
          unread: false,
          q: '',
          hasReply: true,
        });
        setThreads(list.items);
        return;
      }
      const detail = await mailConversationsApi.detail(id);
      if (detail.conversation.mailboxId !== box.id) throw Error('来信不属于当前邮箱');
      const email = [...detail.messages]
        .reverse()
        .find(
          (m) =>
            m.direction === 'inbound' &&
            m.classification === 'normal' &&
            !m.bodyUnavailable &&
            m.bodyText.trim(),
        );
      if (!email) throw Error('这个会话没有可预览的客户正文。');
      setSubject(email.subject.slice(0, 500));
      setBody(email.bodyText.slice(0, 4000));
      setThreads(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '来信读取失败');
    } finally {
      setMailLoading(false);
    }
  }
  const [pending, setPending] = useState(''),
    [error, setError] = useState(''),
    [note, setNote] = useState('');
  const available = products.filter(
    (p) => (p.status === 'approved' || p.approved) && siteAllowsProduct(p, box, true),
  );
  const unavailable = ids.filter((id) => !available.some((p) => p.id === id));
  const active = useRef<AbortController | null>(null);
  const settings = {
    replyMode: mode === 'business' ? 'auto' : mode,
    autoBusinessReplies: mode === 'business',
    draftPersona: persona,
    knowledgeProductIds: ids,
  };
  const stateKey = JSON.stringify([settings, subject, body]);
  useEffect(() => {
    setResult(null);
    setError('');
    setNote('');
    return () => active.current?.abort();
  }, [stateKey]);
  async function run(save: boolean) {
    if (pending) return;
    const ctl = new AbortController();
    active.current = ctl;
    setPending(save ? 'save' : 'preview');
    setError('');
    setNote('');
    try {
      if (save) {
        await outreachApi('/mailboxes/' + box.id + '/reply-settings', {
          method: 'PATCH',
          body: JSON.stringify(settings),
        });
        await onSaved();
        setNote('设置已保存');
      } else {
        setResult(null);
        const data = await outreachApi<Result>('/mailboxes/' + box.id + '/preview', {
          method: 'POST',
          signal: ctl.signal,
          body: JSON.stringify({ question: body, subject, settings }),
        });
        if (!ctl.signal.aborted) setResult(data);
      }
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : '操作失败，请重试');
    } finally {
      setPending('');
    }
  }
  return (
    <div className="reply-studio">
      <header className="fin-heading page-heading">
        <h1>自动回复</h1>
        <button className="btn primary" disabled={!!pending} onClick={() => void run(true)}>
          <Save size={15} />
          {pending === 'save' ? '保存中…' : '保存设置'}
        </button>
      </header>
      <div className="fin-studio-content">
        <div className="fin-channel">
          <div className="fin-mail-icon">
            <Mail size={27} strokeWidth={1.6} />
          </div>
          <div>
            <h2>邮件接待</h2>
            <select
              aria-label="当前邮箱"
              value={box.id}
              onChange={(e) => {
                const next = new URLSearchParams(query);
                next.set('replySettings', e.target.value);
                setQuery(next);
              }}
            >
              {boxes.map((b) => (
                <option value={b.id} key={b.id}>
                  {b.email}
                </option>
              ))}
            </select>
          </div>
          <Link to="/inbox?tab=mailboxes">
            <ArrowLeft size={14} />
            邮箱管理
          </Link>
        </div>
        <div className="fin-studio-tabs">
          <button aria-pressed={!testing} onClick={() => switchView(false)}>
            接待设置
          </button>
          <button aria-pressed={testing} onClick={() => switchView(true)}>
            <Play size={13} />
            试运行
          </button>
        </div>
        {(error || note) && (
          <p role={error ? 'alert' : 'status'} className={error ? 'studio-error' : 'studio-note'}>
            {error || note}
          </p>
        )}
        {!testing ? (
          <section className="studio-config" inert={pending === 'save'}>
            <details className="fin-rule" open>
              <summary>
                <Workflow />
                <strong>接待范围</strong>
                <small>{modes.find(([v]) => v === mode)?.[1]}</small>
                <ChevronRight />
              </summary>
              <div className="fin-rule-body">
                <label>
                  接待方式
                  <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
                    {modes.map(([v, t]) => (
                      <option key={v} value={v}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </details>
            <details className="fin-rule">
              <summary>
                <MessageSquareText />
                <strong>身份与语气</strong>
                <small>{persona.trim() ? '已自定义' : '默认'}</small>
                <ChevronRight />
              </summary>
              <div className="fin-rule-body">
                <label>
                  AI 起草身份与语气
                  <textarea
                    rows={4}
                    maxLength={2000}
                    aria-label="AI 起草身份与语气"
                    value={persona}
                    onChange={(e) => setPersona(e.target.value)}
                    placeholder="例如：以本品牌外贸业务员的身份，用简洁、正式的英文回复。"
                  />
                </label>
              </div>
            </details>
            <details className="fin-rule">
              <summary>
                <BookOpen />
                <strong>引用资料</strong>
                <small>{ids.length - unavailable.length} 项可引用</small>
                <ChevronRight />
              </summary>
              <div className="fin-rule-body studio-materials">
                {available.length ? (
                  available.map((p) => (
                    <label key={p.id}>
                      <input
                        type="checkbox"
                        checked={ids.includes(p.id)}
                        onChange={(e) =>
                          setIds(e.target.checked ? [...ids, p.id] : ids.filter((v) => v !== p.id))
                        }
                      />
                      <span>{p.label || p.name}</span>
                    </label>
                  ))
                ) : (
                  <p>此邮箱官网暂无已审核资料。</p>
                )}
                {unavailable.length > 0 && (
                  <details className="studio-unavailable">
                    <summary>已关联但暂不可引用 · {unavailable.length}</summary>
                    {unavailable.map((id) => {
                      const p = products.find(
                        (p) => p.id === id && siteAllowsProduct(p, box, true),
                      );
                      return (
                        <p key={id}>
                          {p?.label || p?.name || '资料已移除或不在当前官网范围'}{' '}
                          <small>{p ? '待审核' : ''}</small>
                        </p>
                      );
                    })}
                  </details>
                )}
                <Link to="/materials">
                  打开素材库 <ChevronRight size={14} />
                </Link>
              </div>
            </details>
            <details className="fin-rule">
              <summary>
                <ShieldCheck />
                <strong>转人工与审核</strong>
                <ChevronRight />
              </summary>
              <div className="fin-rule-body">
                <p>
                  产品资料无法核实的问题交由业务员确认。逐封审核模式下，生成的回复会进入待审草稿。
                </p>
              </div>
            </details>
          </section>
        ) : (
          <section className="studio-preview">
            <div className="studio-panel-title">
              <h2>
                <Inbox />
                模拟客户来信
              </h2>
              <span>仅预览</span>
            </div>
            <button
              type="button"
              className="studio-import-mail"
              disabled={mailLoading || !!pending}
              onClick={() => (threads ? setThreads(null) : void chooseMail())}
            >
              {mailLoading ? '正在读取…' : threads ? '收起来信列表' : '从此邮箱选取客户来信'}
            </button>
            {threads && (
              <div className="studio-thread-list">
                {threads.length ? (
                  threads.map((t) => (
                    <button key={t.id} disabled={mailLoading} onClick={() => void chooseMail(t.id)}>
                      {t.subject || '无主题'}
                      <small>{t.participantName || t.participant}</small>
                    </button>
                  ))
                ) : (
                  <small>当前邮箱暂无已归类的客户回复。</small>
                )}
              </div>
            )}
            <label>
              主题
              <input
                maxLength={500}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="例如：Product specifications"
              />
            </label>
            <label>
              客户来信
              <textarea
                rows={4}
                aria-label="客户来信"
                value={body}
                maxLength={4000}
                onChange={(e) => setBody(e.target.value)}
                placeholder="输入客户的问题，查看当前设置会如何回复。"
              />
            </label>
            <button
              className="btn primary"
              disabled={!!pending || !body.trim()}
              onClick={() => void run(false)}
            >
              <Play size={14} />
              {pending === 'preview' ? '生成中…' : '预览回复'}
            </button>
            <div className="studio-output" aria-live="polite">
              <h3>
                <Mail size={16} />
                回复预览
              </h3>
              {result ? (
                <>
                  <p className="studio-decision">
                    <Check size={15} />
                    {result.decision}
                  </p>
                  <p className="studio-mail">{result.body}</p>
                  <p>{result.reason}</p>
                  <ReplySources sources={result.sources} />
                </>
              ) : (
                <p className="studio-empty">
                  <SlidersHorizontal size={18} />
                  点击预览后，由起草模型生成示例邮件，仅在本页显示。
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
