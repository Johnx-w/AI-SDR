import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Mail,
  RefreshCcw,
  Save,
  Search,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { Badge, Empty, Modal, SectionTitle } from '../components/ui';
import {
  clearMailOperatorToken,
  getMailOperatorToken,
  mailApi,
  setMailOperatorToken,
} from '../mailApi';
import type { MailConversation, MailConversationDetail, MailStatus } from '../mailApi';

type Confirmation = { kind: 'reply' | 'test' | 'sync'; key: string } | null;

function formatTime(value: string | null | undefined) {
  if (!value) return '尚无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(date);
}

function statusText(value: string | null | undefined) {
  if (!value) return '未知';
  const labels: Record<string, string> = {
    connected: '已连接',
    ready: '就绪',
    ok: '正常',
    idle: '空闲',
    running: '运行中',
    paused: '已暂停',
    disabled: '未启用',
    not_running: '未运行',
    not_checked: '尚未检查',
    unconfigured: '未配置',
    not_configured: '未配置',
    error: '异常',
    pending_review: '待人工审核',
    pending: '待处理',
    draft: '草稿',
    sent: '已发送',
    delivered: '已投递',
    received: '已收到',
    failed: '失败',
    bounced: '退信',
    unsubscribed: '已退订',
    hard_bounce: '硬退信',
    send_unknown: '发送结果待核实',
    waiting_reply: '等待测试回信',
    awaiting_review: '等待人工回复',
    awaiting_human: '等待人工',
    sending_test: '测试信发送中',
    sending_reply: '回信发送中',
    replied: '已回信',
    accepted: '邮箱服务器已接受',
    blocked: '已阻止',
    unknown: '待核实',
    handoff: '人工接管',
    active: '进行中',
  };
  return labels[value] ?? value;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : '邮件服务请求失败，请稍后重试。';
}

export function RealCommunication() {
  const [locked, setLocked] = useState(() => !getMailOperatorToken());
  const [operatorInput, setOperatorInput] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [conversations, setConversations] = useState<MailConversation[]>([]);
  const [detail, setDetail] = useState<MailConversationDetail | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [draftText, setDraftText] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [busy, setBusy] = useState(false);
  const [detailTick, setDetailTick] = useState(0);
  const summaryRequest = useRef(0);
  const detailRequest = useRef(0);

  const refreshSummary = useCallback(async () => {
    if (!getMailOperatorToken()) {
      setLocked(true);
      setSummaryLoading(false);
      return;
    }
    const request = ++summaryRequest.current;
    setSummaryLoading(true);
    const [statusResult, listResult] = await Promise.allSettled([
      mailApi<MailStatus>('/status'),
      mailApi<{ items: MailConversation[] }>('/conversations'),
    ]);
    if (request !== summaryRequest.current) return;
    if (!getMailOperatorToken()) {
      setSummaryLoading(false);
      return;
    }
    if (statusResult.status === 'fulfilled') {
      setStatus(statusResult.value);
      setStatusError(null);
    } else {
      setStatusError(errorText(statusResult.reason));
    }
    if (listResult.status === 'fulfilled') {
      setConversations(Array.isArray(listResult.value.items) ? listResult.value.items : []);
      setListError(null);
    } else {
      setListError(errorText(listResult.reason));
    }
    setSummaryLoading(false);
  }, []);

  useEffect(() => {
    if (!locked) void refreshSummary();
    return () => {
      summaryRequest.current += 1;
    };
  }, [locked, refreshSummary]);

  useEffect(() => {
    const onUnauthorized = () => {
      setLocked(true);
      setStatus(null);
      setConversations([]);
      setDetail(null);
      setConfirmation(null);
      setSummaryLoading(false);
      setUnlockError('操作者口令无效或已失效，请重新解锁。');
    };
    window.addEventListener('mail-operator-unauthorized', onUnauthorized);
    return () => window.removeEventListener('mail-operator-unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    if (conversations.length === 0) {
      setActiveId(null);
    } else if (!activeId || !conversations.some((item) => item.id === activeId)) {
      setActiveId(conversations[0].id);
    }
  }, [activeId, conversations]);

  useEffect(() => {
    const request = ++detailRequest.current;
    if (!activeId) {
      setDetail(null);
      setDraftText('');
      setDetailError(null);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    void mailApi<MailConversationDetail>(`/conversations/${encodeURIComponent(activeId)}`)
      .then((value) => {
        if (request !== detailRequest.current || !getMailOperatorToken()) return;
        setDetail(value);
        setDraftText(value.draft?.bodyText ?? '');
      })
      .catch((error: unknown) => {
        if (request !== detailRequest.current || !getMailOperatorToken()) return;
        setDetailError(errorText(error));
      })
      .finally(() => {
        if (request === detailRequest.current) setDetailLoading(false);
      });
    return () => {
      detailRequest.current += 1;
    };
  }, [activeId, detailTick]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? conversations.filter((item) =>
          `${item.participant} ${item.subject}`.toLocaleLowerCase().includes(needle),
        )
      : conversations;
  }, [conversations, query]);
  const currentDetail = detail?.conversation.id === activeId ? detail : null;
  const selected =
    currentDetail?.conversation ?? conversations.find((item) => item.id === activeId);
  const dirty = draftText !== (currentDetail?.draft?.bodyText ?? '');
  const testMode = status?.mode === 'test_only';
  const configured = status?.mailbox.configured === true;
  const canWrite = testMode && configured && !statusError && !listError && !busy;
  const canSend =
    canWrite &&
    status?.mailbox.imapStatus === 'connected' &&
    status?.mailbox.smtpStatus === 'connected';
  const blockedConversation = [
    'unsubscribed',
    'bounced',
    'hard_bounce',
    'send_unknown',
    'handoff',
    'paused',
  ].includes(currentDetail?.conversation.status ?? '');
  const canReply =
    canSend &&
    !!currentDetail?.draft &&
    !!draftText.trim() &&
    !dirty &&
    !blockedConversation &&
    currentDetail.draft.status === 'pending_review';

  async function saveDraft() {
    if (!activeId || !currentDetail || !draftText.trim() || !canWrite) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await mailApi(`/conversations/${encodeURIComponent(activeId)}/draft`, {
        method: 'PUT',
        body: JSON.stringify({
          bodyText: draftText,
          expectedRevision: currentDetail.draft?.revision ?? 0,
        }),
      });
      setNotice('草稿已保存到邮件服务；尚未发送。');
      setDetailTick((value) => value + 1);
      await refreshSummary();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction() {
    if (!confirmation || (confirmation.kind === 'sync' ? !canWrite : !canSend)) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      if (confirmation.kind === 'reply') {
        if (!activeId || !currentDetail?.draft || dirty)
          throw new Error('草稿已变化，请先保存并重新审核。');
        await mailApi(`/conversations/${encodeURIComponent(activeId)}/reply`, {
          method: 'POST',
          headers: { 'Idempotency-Key': confirmation.key },
          body: JSON.stringify({ draftRevision: currentDetail.draft.revision, confirmed: true }),
        });
        setNotice('邮件服务已接受回信请求；请查看邮件时间线确认最终投递状态。');
        setDetailTick((value) => value + 1);
      } else if (confirmation.kind === 'test') {
        await mailApi('/test-send', {
          method: 'POST',
          headers: { 'Idempotency-Key': confirmation.key },
          body: JSON.stringify({ confirmed: true }),
        });
        setNotice('邮件服务已接受测试发送请求；请同步并检查测试线程。');
      } else {
        await mailApi('/sync', {
          method: 'POST',
          body: JSON.stringify({ confirmed: true }),
        });
        setNotice('测试邮箱同步完成。');
        setDetailTick((value) => value + 1);
      }
      setConfirmation(null);
      await refreshSummary();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function selectConversation(id: string) {
    if (id === activeId) return;
    if (dirty && !window.confirm('当前草稿尚未保存，确定切换会话并放弃修改吗？')) return;
    setActionError(null);
    setNotice(null);
    setDetail(null);
    setActiveId(id);
  }

  function openConfirmation(kind: 'reply' | 'test' | 'sync') {
    setActionError(null);
    setNotice(null);
    setConfirmation({ kind, key: crypto.randomUUID() });
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = operatorInput.trim();
    if (!value) {
      setUnlockError('请输入本机操作者口令。');
      return;
    }
    setUnlockBusy(true);
    setUnlockError(null);
    try {
      setMailOperatorToken(value);
      const currentStatus = await mailApi<MailStatus>('/status');
      setStatus(currentStatus);
      setOperatorInput('');
      setLocked(false);
    } catch (error) {
      clearMailOperatorToken();
      setUnlockError(errorText(error));
    } finally {
      setUnlockBusy(false);
    }
  }

  function lockCenter() {
    clearMailOperatorToken();
    setLocked(true);
    setStatus(null);
    setConversations([]);
    setDetail(null);
    setConfirmation(null);
    setOperatorInput('');
    setUnlockError(null);
  }

  if (locked) {
    return (
      <>
        <PageHeading eyebrow="COMMUNICATION" title="沟通中心" />
        <section className="panel mail-unlock">
          <ShieldCheck size={31} />
          <h2>解锁沟通中心</h2>
          <p>
            输入本机操作者口令以查看真实测试邮件。此口令与邮箱客户端密码不同，只保存在当前浏览器会话。
          </p>
          <form onSubmit={(event) => void unlock(event)}>
            <input
              aria-label="本机操作者口令"
              type="password"
              autoComplete="off"
              value={operatorInput}
              onChange={(event) => setOperatorInput(event.target.value)}
            />
            <button className="btn primary" type="submit" disabled={unlockBusy}>
              {unlockBusy ? '验证中…' : '解锁'}
            </button>
          </form>
          {unlockError && (
            <p className="mail-unlock-error" role="alert">
              {unlockError}
            </p>
          )}
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading eyebrow="COMMUNICATION" title="沟通中心" />
      <div className="mail-toolbar panel">
        <div className="mail-toolbar-warning">
          <ShieldCheck size={19} />
          <span>试点阶段不处理历史邮件或真实客户邮件，不自动发送开发信。</span>
        </div>
        <div className="mail-toolbar-actions">
          <button
            className="btn secondary"
            onClick={() => void refreshSummary()}
            disabled={summaryLoading}
          >
            <RefreshCcw size={16} /> 刷新状态
          </button>
          <button className="btn secondary" onClick={lockCenter}>
            锁定
          </button>
          <button
            className="btn secondary"
            onClick={() => openConfirmation('sync')}
            disabled={!canWrite}
          >
            <Mail size={16} /> 同步测试邮件
          </button>
          <button
            className="btn primary"
            onClick={() => openConfirmation('test')}
            disabled={!canSend}
          >
            <Send size={16} /> 发送技术测试信
          </button>
        </div>
      </div>
      {(statusError || listError || actionError || (status && !testMode)) && (
        <div className="mail-feedback error" role="alert">
          <AlertCircle size={18} />
          <span>
            {actionError || statusError || listError || '服务未报告测试模式，所有写入操作已禁用。'}
          </span>
        </div>
      )}
      {notice && (
        <div className="mail-feedback success" role="status">
          <CheckCircle2 size={18} />
          <span>{notice}</span>
        </div>
      )}
      <div className="communication-grid">
        <aside className="comm-list panel">
          <div className="mail-list-title">
            <strong>测试邮件会话</strong>
            <span>{summaryLoading ? '更新中' : `${conversations.length} 个`}</span>
          </div>
          <div className="comm-search search-field">
            <Search size={17} />
            <input
              aria-label="搜索测试邮件会话"
              placeholder="搜索地址或主题"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {filtered.map((item) => (
            <button
              key={item.id}
              className={'comm-preview ' + (activeId === item.id ? 'selected' : '')}
              onClick={() => selectConversation(item.id)}
            >
              <span className="company-avatar comm-mail-avatar">
                <Mail size={19} />
              </span>
              <div>
                <strong>{item.participant}</strong>
                <span>
                  {statusText(item.status)} · {statusText(item.agentStatus)}
                </span>
                <p>{item.subject || '（无主题）'}</p>
              </div>
              <time>{formatTime(item.updatedAt)}</time>
              {item.unread && <i aria-label="未读" />}
            </button>
          ))}
          {!summaryLoading && !listError && filtered.length === 0 && (
            <Empty
              title={query ? '没有匹配的测试会话' : '暂无测试邮件会话'}
              detail={
                query ? '试试其他地址或主题。' : '连接邮箱后可发送技术测试信，并同步测试邮箱。'
              }
            />
          )}
        </aside>
        <section className="comm-message panel">
          {detailLoading ? (
            <div className="mail-center-empty">正在读取真实邮件…</div>
          ) : detailError ? (
            <div className="mail-center-empty" role="alert">
              {detailError}
            </div>
          ) : currentDetail && selected ? (
            <>
              <div className="comm-header">
                <span className="company-avatar comm-mail-avatar">
                  <Mail size={20} />
                </span>
                <div>
                  <strong>{selected.subject || '（无主题）'}</strong>
                  <p>
                    {selected.participant} · 更新于 {formatTime(selected.updatedAt)}
                  </p>
                </div>
                <Badge tone={selected.status === 'active' ? 'green' : 'amber'}>
                  {statusText(selected.status)}
                </Badge>
              </div>
              <div className="comm-scroll">
                {currentDetail.messages.length === 0 ? (
                  <Empty title="线程内暂无邮件" detail="请同步测试邮箱后再查看。" />
                ) : (
                  currentDetail.messages.map((message) => (
                    <article className="received-mail mail-timeline-item" key={message.id}>
                      <div>
                        <strong>{message.direction === 'inbound' ? '收到' : '发出'}</strong>
                        <span>
                          {message.from} → {message.to}
                        </span>
                        <time>{formatTime(message.occurredAt)}</time>
                      </div>
                      <div className="mail-subject">
                        {message.subject || '（无主题）'} · {statusText(message.deliveryStatus)}
                      </div>
                      <p>{message.bodyText}</p>
                    </article>
                  ))
                )}
                <div className="ai-draft mail-reply-draft">
                  <header>
                    <Save size={18} />
                    <strong>人工审核回复草稿</strong>
                    <span>
                      {currentDetail.draft
                        ? `修订版 ${currentDetail.draft.revision} · ${statusText(currentDetail.draft.status)}`
                        : '尚未保存'}
                    </span>
                  </header>
                  <textarea
                    aria-label="编辑测试邮件回信草稿"
                    placeholder="在此编辑测试回信；保存后才能确认发送。"
                    value={draftText}
                    onChange={(event) => setDraftText(event.target.value)}
                    disabled={!canWrite || blockedConversation}
                  />
                </div>
              </div>
              <footer className="comm-actions">
                {blockedConversation && (
                  <span className="mail-action-note">该会话已暂停或抑制，不能回信。</span>
                )}
                {dirty && <span className="mail-action-note">有未保存的修改</span>}
                <button
                  className="btn secondary"
                  onClick={() => void saveDraft()}
                  disabled={!canWrite || blockedConversation || !draftText.trim() || !dirty}
                >
                  <Save size={16} /> 保存草稿
                </button>
                <button
                  className="btn primary"
                  onClick={() => openConfirmation('reply')}
                  disabled={!canReply}
                >
                  <Send size={17} /> 审核并回信
                </button>
              </footer>
            </>
          ) : (
            <div className="mail-center-empty">
              <Empty title="请选择测试邮件会话" detail="不会显示演示客户或历史邮箱邮件。" />
            </div>
          )}
        </section>
        <aside className="comm-summary panel mail-health">
          <SectionTitle title="邮箱与 Agent 状态" subtitle="来自邮件服务的实时报告" />
          {status ? (
            <>
              <section>
                <h3>试点邮箱</h3>
                <dl>
                  <dt>发件地址</dt>
                  <dd>{status.mailbox.address || '未配置'}</dd>
                  <dt>模式</dt>
                  <dd>{testMode ? '仅测试' : statusText(status.mode)}</dd>
                  <dt>配置</dt>
                  <dd>{configured ? '已配置' : '未配置'}</dd>
                  <dt>IMAP 收件</dt>
                  <dd>{statusText(status.mailbox.imapStatus)}</dd>
                  <dt>SMTP 发件</dt>
                  <dd>{statusText(status.mailbox.smtpStatus)}</dd>
                  <dt>最近同步</dt>
                  <dd>{formatTime(status.mailbox.lastSyncAt)}</dd>
                </dl>
                {status.mailbox.lastError && (
                  <p className="mail-health-error">{status.mailbox.lastError}</p>
                )}
              </section>
              <section>
                <h3>
                  <Bot size={17} /> Agent 工作状态
                </h3>
                <dl>
                  <dt>状态</dt>
                  <dd>{statusText(status.agent.status)}</dd>
                  <dt>待审核</dt>
                  <dd>{status.agent.pendingReviews}</dd>
                  <dt>最近活动</dt>
                  <dd>{formatTime(status.agent.lastActivityAt)}</dd>
                </dl>
                {status.agent.pausedReason && (
                  <p className="mail-health-error">暂停原因：{status.agent.pausedReason}</p>
                )}
                <p className="mail-health-note">
                  邮箱连接状态与 Agent 自动发信状态分别报告；此试点不对真实潜客发信。
                </p>
              </section>
            </>
          ) : (
            <section>
              <p className="mail-health-note">
                {summaryLoading
                  ? '正在检查邮件服务…'
                  : '尚未取得邮箱状态。请检查本机服务和安全配置。'}
              </p>
            </section>
          )}
        </aside>
      </div>
      {confirmation && (
        <Modal
          title={
            confirmation.kind === 'reply'
              ? '确认真实回信'
              : confirmation.kind === 'test'
                ? '确认技术测试信'
                : '确认同步测试邮件'
          }
          onClose={() => !busy && setConfirmation(null)}
        >
          <div className="modal-body">
            <Badge tone="amber">TEST ONLY</Badge>
            {confirmation.kind === 'reply' ? (
              <>
                <p>
                  收件人：{selected?.participant}
                  。点击确认后，邮件服务会尝试真实发信，此操作不能在页面中撤销。
                </p>
                <div className="review-preview">{currentDetail?.draft?.bodyText}</div>
              </>
            ) : confirmation.kind === 'test' ? (
              <p>
                将从试点邮箱向服务端预设的公司测试地址发送一封固定的非营销技术邮件。不会向真实潜客发信。
              </p>
            ) : (
              <p>只同步接通后产生、带测试标记的公司测试邮件线程；不会导入历史邮件。</p>
            )}
            <button
              className="btn primary"
              onClick={() => void confirmAction()}
              disabled={busy || (confirmation.kind === 'sync' ? !canWrite : !canSend)}
            >
              {busy ? '处理中…' : confirmation.kind === 'sync' ? '确认同步' : '确认真实发送'}
            </button>
            {actionError && (
              <p className="mail-unlock-error" role="alert">
                {actionError}
              </p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
