import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  AcquisitionJob,
  AcquisitionPaidRequest,
  AcquisitionReviewDecision,
  WebsiteCollectionAttempt,
} from '../domain/types';
import { countryFor, WORLDWIDE_COUNTRY, WORLDWIDE_LABEL } from '../domain/country-catalog';
import { acquisitionApi } from '../services/acquisition';
import { Modal } from './ui';

const states = {
  running: '正在收录',
  stopping: '正在停止',
  paused: '已暂停 · 执行结果待确认',
  completed: '目标已完成',
  partial: '部分完成',
};
const resultNames: Record<string, string> = {
  inserted: '已新增',
  duplicate: '重复或既有',
  rejected: '不符合条件',
  review: '待核实',
  failed: '失败',
};
const metricState: Record<string, string> = {
  running: '处理中',
  completed: '搜索完成',
  failed: '搜索失败',
  interrupted: '服务中断',
  uncertain: '供应商请求待核对',
};
const mapsStates: Record<string, string> = {
  running: '查询中',
  completed: '已查询',
  identifiers_only: '仅地点编号',
  unavailable: '不可用',
  paused: '已暂停',
  failed: '失败',
  rate_limited: '限流',
  deferred: '已延后',
  budget_limit: '已达对照上限',
};
const mapsReasons: Record<string, string> = {
  credentials_missing: '缺少 Places 凭据',
  website_mapping_unavailable: '官网定位未开放',
  binding_mismatch: '地图地点与官网主体不符',
  conflicting_reference: '同一地点编号对应冲突信息',
  permission_denied: '权限不足',
  provider_busy: '供应商请求处理中',
  provider_cooldown: '等待供应商恢复',
  retry_deferred: '已延后重试',
  request_unknown: '请求结果待核对',
  invalid_response: '供应商响应异常',
  provider_failed: '供应商请求失败',
};
const beijingTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
function safeUrl(value?: string | null) {
  try {
    const url = new URL(value || '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
type ReviewRow = AcquisitionJob['rows'][number];
type ReviewResolution = NonNullable<ReviewRow['review_resolution']>;
type HandoffContact = NonNullable<NonNullable<ReviewRow['handoff']>['contacts']>[number];
function HandoffContacts({ contacts = [] }: { contacts?: HandoffContact[] }) {
  const presented: { contact: HandoffContact; href: string }[] = [];
  const forms = new Map<string, { id?: string; sources: Set<string> }>();
  for (const contact of contacts) {
    const href = safeUrl(contact.source_url);
    if (!href) continue;
    if (contact.kind !== 'form') {
      presented.push({ contact, href });
      continue;
    }
    const key = contact.form_id ? new URL(href).origin + ':' + contact.form_id : 'legacy';
    const group = forms.get(key) || { id: contact.form_id, sources: new Set<string>() };
    group.sources.add(href);
    forms.set(key, group);
  }
  return (
    <>
      {presented.map(({ contact, href }, index) => (
        <small key={`${contact.kind}-${contact.value}-${index}`}>
          <a href={href} target="_blank" rel="noopener noreferrer">
            {contact.kind === 'email' ? '邮箱' : '电话'}：{contact.value}
          </a>
        </small>
      ))}
      {forms.size > 0 && (
        <details className="handoff-forms">
          <summary>业务联系表单</summary>
          {[...forms.values()].map((group, index) => (
            <div key={index}>
              <small>{group.id ? `表单编号 ${group.id}` : '来源页（未保存表单编号）'}</small>
              {[...group.sources].map((href) => (
                <small key={href}>
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {new URL(href).hostname}
                    {new URL(href).pathname}
                    {new URL(href).search}
                    {new URL(href).hash}
                  </a>
                </small>
              ))}
            </div>
          ))}
        </details>
      )}
    </>
  );
}
const collectionMethods: Record<string, string> = {
  node: '官网直读',
  scrapling: '浏览器补抓',
  external: '外部提取',
};
const collectionStatuses: Record<string, string> = {
  ok: '已取得正文',
  empty: '无有效正文',
  blocked: '已拦截',
  unavailable: '暂不可用',
  deferred: '已延后',
  timeout: '超时',
  memory_limit: '已达内存上限',
  unknown: '供应商结果待核对',
  failed: '读取失败',
};
const collectionReasons: Record<string, string> = {
  off_site_redirect: '跨站跳转',
  non_public_source: '非公网来源',
  missing_page_body: '补正文',
  missing_company_identity: '补主体证据',
  missing_operating_evidence: '补经营证据',
};
const collectionWaitReasons: Record<string, string> = {
  browser_busy: '等待其他任务释放浏览器',
  low_memory: '等待可用内存恢复',
  queue_full: '浏览器队列已满',
  queue_timeout: '等待超时',
  aborted: '等待已取消',
};
const collectionFailures: Record<string, string> = {
  ...collectionWaitReasons,
  worker_crashed: '浏览器工作进程退出',
  worker_failed: '浏览器工作进程失败',
  worker_timeout: '工作进程响应超时',
  page_timeout: '单页超时',
  worker_memory_limit: '内存超限',
  worker_isolation_unavailable: '资源隔离暂不可用',
  provider_request_unknown: '外部提取结果待核对',
  provider_extract_failed: '外部提取失败',
  snapshot_capacity: '快照存储空间不足',
};
const acquisitionStages: Record<string, string> = {
  select: '搜索或准备候选',
  extract: '采集官网',
  research: '研究及核对官网证据',
  prepare: '核对主体并准备保存',
  persist: '保存客户档案并读回',
  assessment: '保存并核对评估',
};
const paidKinds: Record<string, string> = {
  web_search: '官网搜索',
  web_extract: '外部提取',
  model_extraction: '模型取证',
  model_activity: '模型复核经营证据',
};
const paidStatuses = {
  pending: '等待应答',
  completed: '已取得应答',
  failed: '已确认失败',
  unknown: '结果待供应商核对',
};
const batchBoundaries: Record<string, string> = {
  batch_capacity: '上一批已新增 200 家',
  time_limit: '上一批运行已满 6 小时',
  research_limit: '上一批已达到研究次数上限',
  search_limit: '上一批已达到搜索次数上限',
};
const languageNames = new Intl.DisplayNames('zh-CN', { type: 'language' });
function CollectionAttempts({ attempts }: { attempts?: WebsiteCollectionAttempt[] }) {
  if (!attempts?.length) return null;
  return (
    <details>
      <summary>官网采集记录（{attempts.length}）</summary>
      {attempts.map((attempt, index) => (
        <small key={attempt.snapshot_id + index}>
          {collectionMethods[attempt.method] || attempt.method} ·{' '}
          {collectionStatuses[attempt.status] || attempt.status}
          {attempt.reused ? ' · 已复用' : ''}
          {collectionReasons[attempt.reason] ? ' · ' + collectionReasons[attempt.reason] : ''}
          {attempt.failure_reason && collectionFailures[attempt.failure_reason]
            ? ' · ' + collectionFailures[attempt.failure_reason]
            : ''}
          {attempt.resource_wait && (
            <>
              {' '}
              · {collectionWaitReasons[attempt.resource_wait.reason]} · 等待{' '}
              {(attempt.resource_wait.wait_ms / 1000).toFixed(1)} 秒
              {attempt.resource_wait.end && (
                <> · {collectionWaitReasons[attempt.resource_wait.end]}</>
              )}
            </>
          )}
          {' · ' + beijingTime(attempt.acquired_at) + ' · '}
          {safeUrl(attempt.final_url || attempt.requested_url) ? (
            <a
              href={safeUrl(attempt.final_url || attempt.requested_url)}
              target="_blank"
              rel="noopener noreferrer"
            >
              来源
            </a>
          ) : (
            '来源不可打开'
          )}
        </small>
      ))}
    </details>
  );
}
function PaidRequests({ requests }: { requests?: AcquisitionPaidRequest[] }) {
  if (!requests?.length) return null;
  return (
    <details>
      <summary>供应商请求（{requests.length}）</summary>
      {requests.map(({ id, kind, provider, status, usage }) => (
        <small key={id}>
          {paidKinds[kind] || kind} · {provider} · {paidStatuses[status]}
          {usage && <> · {usage.credits} 额度</>} · <code>{id}</code>
        </small>
      ))}
    </details>
  );
}
function ReviewAction({
  jobId,
  index,
  row,
  onResolved,
}: {
  jobId: string;
  index: number;
  row: ReviewRow;
  onResolved: (index: number, resolution: ReviewResolution) => void;
}) {
  const [sourceUrl, setSourceUrl] = useState(
    row.review_resolution?.source_url || row.source_url || '',
  );
  const [resolution, setResolution] = useState(row.review_resolution);
  const [evidence, setEvidence] =
    useState<Awaited<ReturnType<typeof acquisitionApi.reviewEvidence>>['evidence']>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const key = useRef(row.review_resolution?.key || '');
  useEffect(() => {
    if (!row.review_resolution) return;
    setResolution(row.review_resolution);
    key.current = row.review_resolution.key;
    setSourceUrl(row.review_resolution.source_url);
  }, [
    row.review_resolution?.key,
    row.review_resolution?.status,
    row.review_resolution?.updated_at,
  ]);
  const uncertain = resolution?.status === 'pending' || resolution?.status === 'uncertain';
  const recorded = ['inserted', 'updated', 'duplicate'].includes(resolution?.status || '');
  async function loadEvidence() {
    if (evidence || busy) return;
    try {
      const result = await acquisitionApi.reviewEvidence(jobId, index);
      setEvidence(result.evidence);
      if (result.resolution) {
        setResolution(result.resolution);
        key.current = result.resolution.key;
        setSourceUrl(result.resolution.source_url);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '核实依据读取失败');
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || recorded) return;
    setBusy(true);
    setError('');
    if (!uncertain) key.current = crypto.randomUUID();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const field = (name: string) => String(form.get(name) || '').trim();
    const actor = uncertain ? resolution?.actor : field('actor');
    const decision: AcquisitionReviewDecision | undefined = uncertain
      ? resolution?.decision
      : manual
        ? {
            source_url: field('evidence_url') || sourceUrl,
            company_name: field('company_name'),
            identity_quote: field('identity_quote'),
            operating_quote: field('operating_quote'),
            product: field('product'),
            admission_fact: field('admission_fact'),
            reason: field('reason'),
          }
        : undefined;
    try {
      const result = await acquisitionApi.reviewCandidate(
        jobId,
        index,
        uncertain ? resolution!.source_url : sourceUrl,
        key.current,
        actor,
        decision,
      );
      setResolution(result.resolution);
      onResolved(index, result.resolution);
      const latest = await acquisitionApi.reviewEvidence(jobId, index).catch(() => null);
      if (latest) setEvidence(latest.evidence);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '核实失败');
      const latest = await acquisitionApi.reviewEvidence(jobId, index).catch(() => null);
      if (latest?.resolution) {
        setResolution(latest.resolution);
        key.current = latest.resolution.key;
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <details onToggle={(event) => event.currentTarget.open && void loadEvidence()}>
      <summary>{recorded ? '核实结果' : '更正企业官网并重新核实'}</summary>
      {evidence ? (
        <div>
          <small>
            官网名称：{evidence.company_name || '未核实'} · 身份：{evidence.identity_status}
          </small>
          <small>
            窗饰产品：{evidence.product_match} · {evidence.products.join('、') || '未核实'}
          </small>
          {evidence.facts.map((fact, i) => (
            <small key={`${fact.field}-${i}`}>
              {fact.field === 'products'
                ? `产品依据${fact.value ? `（${fact.value}）` : ''}：`
                : `${fact.field === 'admission_facts' ? '经营准入' : ['company_name', 'legal_company_name'].includes(fact.field) ? '名称' : '主体'}依据：`}
              {fact.quote}（
              {safeUrl(fact.source_url) ? (
                <a href={safeUrl(fact.source_url)} target="_blank" rel="noopener noreferrer">
                  来源
                </a>
              ) : (
                '来源不可打开'
              )}
              ）
            </small>
          ))}
          {resolution && <CollectionAttempts attempts={evidence.collection_attempts} />}
        </div>
      ) : (
        <small>
          第三方平台或目录页请替换为企业独立官网；无已保存证据时重新采集。本操作独立补录，不改变原任务统计。
        </small>
      )}
      {resolution?.reason && <small>{resolution.reason}</small>}
      {resolution?.actor && (
        <small>
          操作者 {resolution.actor} ·{' '}
          {resolution.decided_at
            ? new Date(resolution.decided_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
            : '结果待确认'}
        </small>
      )}
      {resolution?.decision && <small>人工依据 {resolution.decision.reason}</small>}
      {recorded ? (
        <small>
          {resolution?.record_id ? (
            <Link to={`/leads?lead=${encodeURIComponent(resolution.record_id)}`}>查看客户档案</Link>
          ) : (
            '该企业已在客户库，可按官网查找档案'
          )}
        </small>
      ) : (
        <form className="website-correction-form" onSubmit={(event) => void submit(event)}>
          <label>
            企业独立官网
            <input
              type="url"
              required
              value={uncertain ? resolution!.source_url : sourceUrl}
              disabled={busy || uncertain}
              placeholder="https://企业官网/"
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </label>
          {!uncertain && (
            <>
              <label>
                操作者
                <input
                  name="actor"
                  required
                  maxLength={100}
                  defaultValue={resolution?.actor === '未署名' ? '' : resolution?.actor}
                />
              </label>
              <label>
                <span>
                  <input
                    type="checkbox"
                    checked={manual}
                    onChange={(event) => setManual(event.target.checked)}
                  />{' '}
                  提交人工裁定依据
                </span>
              </label>
              {manual && (
                <fieldset className="acquisition-review-evidence">
                  <legend>官网原文</legend>
                  <label>
                    证据页面（留空使用企业官网）
                    <input type="url" name="evidence_url" />
                  </label>
                  <label>
                    经营主体名称
                    <input name="company_name" required maxLength={200} />
                  </label>
                  <label>
                    经营主体原文
                    <textarea name="identity_quote" required maxLength={1500} />
                  </label>
                  <label>
                    窗饰产品
                    <input name="product" required maxLength={300} />
                  </label>
                  <label>
                    主营供货原文
                    <textarea name="operating_quote" required maxLength={1500} />
                  </label>
                  <label>
                    供货方式
                    <select name="admission_fact">
                      <option value="complete_supply">经营合格完整窗饰或户外遮阳</option>
                      <option value="component_resale">经销窗饰专用配件或面料</option>
                      <option value="commercial_custom_supply">承接商业窗饰定制供货</option>
                    </select>
                  </label>
                  <label>
                    裁定理由
                    <textarea name="reason" required maxLength={500} />
                  </label>
                </fieldset>
              )}
            </>
          )}
          <button type="submit" className="btn secondary" disabled={busy}>
            {busy ? '核实中…' : uncertain ? '核对上次结果' : '核实并尝试入库'}
          </button>
        </form>
      )}
      {error && (
        <small role="alert" className="error-message">
          {error}
        </small>
      )}
    </details>
  );
}
function DetailRows({
  rows,
  allRows,
  jobId,
  onResolved,
}: {
  rows: AcquisitionJob['rows'];
  allRows: AcquisitionJob['rows'];
  jobId: string;
  onResolved: (index: number, resolution: ReviewResolution) => void;
}) {
  return (
    <table className="lead-table">
      <thead>
        <tr>
          <th>企业 / 官网</th>
          <th>结果</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.domain}-${index}`}>
            <td>
              {safeUrl(row.source_url) ? (
                <a href={safeUrl(row.source_url)} target="_blank" rel="noopener noreferrer">
                  {row.name || row.domain || '待核实企业'}
                </a>
              ) : (
                <span>{row.name || row.domain || '待核实企业'}</span>
              )}
              {row.reason && <small>{row.reason}</small>}
              {row.discovery_sources?.some(({ kind }) => kind === 'maps') && (
                <small>
                  {row.discovery_sources.some(({ kind }) => kind === 'web') && '官网搜索 · '}
                  地图地点{' '}
                  {row.discovery_sources.flatMap(({ reference }) => reference || []).join('、')}
                </small>
              )}
              {!!row.unverified_map_sources?.length && (
                <small>
                  待核实的地图地点{' '}
                  {row.unverified_map_sources.map(({ reference }) => reference).join('、')}
                </small>
              )}
              {row.handoff && (
                <small>
                  {row.handoff.contact_verified
                    ? '已找到有来源的公司级联系入口'
                    : '本轮未找到官网公司级联系入口，暂不能邮件联系'}
                </small>
              )}
              {row.search_query && <small>发现词：{row.search_query}</small>}
              <HandoffContacts contacts={row.handoff?.contacts} />
              <CollectionAttempts attempts={row.collection_attempts} />
              <PaidRequests requests={row.paid_requests} />
              {row.result === 'review' && (
                <ReviewAction
                  jobId={jobId}
                  index={allRows.indexOf(row)}
                  row={row}
                  onResolved={onResolved}
                />
              )}
            </td>
            <td>
              {row.review_resolution?.status === 'inserted' ||
              row.review_resolution?.status === 'updated'
                ? '核实后已入库'
                : row.review_resolution?.status === 'duplicate'
                  ? '已在客户库'
                  : resultNames[row.result] || row.result}
              {row.assessment && (
                <small>{row.assessment.grade || row.assessment.status || '未定级'}</small>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function AutomaticFirstTouchProgress({ job }: { job: AcquisitionJob }) {
  const [paused, setPaused] = useState(job.autoFirstTouchPaused === true);
  const [cancelled, setCancelled] = useState(job.autoFirstTouchCancelled === true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setPaused(job.autoFirstTouchPaused === true), [job.id, job.autoFirstTouchPaused]);
  useEffect(
    () => setCancelled(job.autoFirstTouchCancelled === true),
    [job.id, job.autoFirstTouchCancelled],
  );
  async function toggle() {
    setBusy(true);
    setError('');
    try {
      const updated = (await acquisitionApi.setAutomaticFirstTouch(
        'jobs',
        job.id,
        paused,
      )) as AcquisitionJob;
      setPaused(updated.autoFirstTouchPaused === true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '自动首发设置失败');
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError('');
    try {
      const updated = await acquisitionApi.cancelAutomaticFirstTouch(job.id);
      setCancelled(updated.autoFirstTouchCancelled === true);
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '自动首发取消失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="result-actions">
      <span>
        获客后自动首发{cancelled ? ' · 已取消' : !job.scheduleId && paused ? ' · 已暂停' : ''}
      </span>
      <Link to={`/inbox?tab=campaigns&campaignId=acquisition-${job.id}`}>查看首发进度与缺项</Link>
      {job.scheduleId ? (
        <Link to="/automation?tab=schedules">管理获客计划</Link>
      ) : !cancelled ? (
        <>
          <button className="btn secondary" disabled={busy} onClick={() => void toggle()}>
            {paused ? '恢复自动首发' : '暂停自动首发'}
          </button>
          <button className="btn danger" disabled={busy} onClick={() => setConfirming(true)}>
            取消自动首发
          </button>
        </>
      ) : null}
      {confirming && (
        <Modal title="取消本轮自动首发" onClose={() => !busy && setConfirming(false)}>
          <div className="modal-body">
            <p>
              确认永久取消本轮自动首发？未发送安排和后续追信会停止；已发送记录保留，取消后不能恢复。
            </p>
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
            <div className="result-actions">
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                保留自动首发
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void cancel()}>
                {busy ? '正在取消…' : '确认取消自动首发'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {error && !confirming && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </div>
  );
}

function SourceFirstTouchAuthorization({ job }: { job: AcquisitionJob }) {
  const [enabled, setEnabled] = useState(job.input.auto_first_touch === true);
  const [saved, setSaved] = useState(job);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setSaved(job);
    setEnabled(job.input.auto_first_touch === true);
  }, [job.id, job.sourceControlRevision]);
  async function save() {
    setBusy(true);
    setError('');
    try {
      setSaved(
        (await acquisitionApi.setAutomaticFirstTouch(
          'jobs',
          job.id,
          enabled,
          saved.sourceControlRevision || 0,
        )) as AcquisitionJob,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || !!job.sourceDeletedAt || !!job.scheduleId}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        获客后自动首发
      </label>
      {!job.scheduleId && (
        <button
          className="btn secondary"
          disabled={
            busy || !!job.sourceDeletedAt || enabled === (saved.input.auto_first_touch === true)
          }
          onClick={() => void save()}
        >
          保存自动首发设置
        </button>
      )}
      <p className="muted">
        直接继续仅获客。重新勾选并保存后建立新触达安排；来源暂停时等待人工继续。
        {job.scheduleId ? '请在所属定时计划中保存授权。' : ''}
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

type BatchProgressProps = {
  job: AcquisitionJob;
  control: (action: 'stop' | 'resume' | 'pause' | 'delete') => void;
  busy: boolean;
};

export function BatchProgress(props: BatchProgressProps) {
  const { job } = props;
  const [detail, setDetail] = useState<AcquisitionJob | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!job.summary) return;
    let alive = true;
    const controller = new AbortController();
    void acquisitionApi.job(job.id, controller.signal).then(
      (value) => {
        if (alive) {
          setDetail(value);
          setError('');
        }
      },
      (cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : '读取执行详情失败');
      },
    );
    return () => {
      alive = false;
      controller.abort();
    };
  }, [job.id, job.updatedAt, job.summary, revision]);
  const value = job.summary ? (detail?.id === job.id ? detail : null) : job;
  return (
    <>
      {error && job.summary && (
        <p className="error-message" role="alert">
          {error}
          <button className="btn secondary" onClick={() => setRevision((n) => n + 1)}>
            重新读取详情
          </button>
        </p>
      )}
      {value ? (
        <BatchProgressDetail {...props} job={value} />
      ) : !error ? (
        <p className="muted" role="status">
          正在读取执行详情…
        </p>
      ) : null}
    </>
  );
}

function BatchProgressDetail({ job: snapshot, control, busy }: BatchProgressProps) {
  const [reviewedJob, setReviewedJob] = useState<AcquisitionJob | null>(null);
  const job =
    reviewedJob?.id === snapshot.id && (reviewedJob.updatedAt || '') >= (snapshot.updatedAt || '')
      ? reviewedJob
      : snapshot;
  function refreshReview(index: number, resolution: ReviewResolution) {
    setReviewedJob({
      ...job,
      rows: job.rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, review_resolution: resolution } : row,
      ),
    });
    void acquisitionApi.job(job.id).then(setReviewedJob, () => {});
  }
  const filteredPlatforms = (job.searchStats || []).flatMap((metric) =>
    (metric.filteredSources || [])
      .filter((source) => source.reason === '第三方平台或目录')
      .map((source) => ({ ...source, query: metric.query })),
  );
  const usage = job.researchUsage;
  const progress = job.currentProgress;
  const reportedTokens =
    usage?.total_tokens ??
    (!job.executionVersion && usage?.input_tokens !== undefined && usage.output_tokens !== undefined
      ? usage.input_tokens + usage.output_tokens
      : undefined);
  return (
    <section className="batch-progress" aria-label="批量任务进度">
      <div className="result-title">
        <strong>
          {job.sourceDeletedAt
            ? '来源已删除'
            : job.manualPaused && job.status === 'paused'
              ? '已人工暂停'
              : states[job.status]}
        </strong>
        <span>{beijingTime(job.createdAt)}</span>
      </div>
      <div role="status" aria-live="polite">
        <h3>
          去重后新增收录 {job.inserted} / {job.target} 家
        </h3>
        <progress max={job.target} value={job.inserted} aria-label="去重后新增收录进度" />
      </div>
      <p>{job.message}</p>
      {job.collectionWait && (
        <p role="status">{collectionWaitReasons[job.collectionWait.reason]}</p>
      )}
      {progress && (
        <div>
          <p className="muted">
            当前步骤 · {acquisitionStages[progress.stage] || progress.stage}
            {!!progress.research_usage?.model_calls && (
              <> · 模型请求 {progress.research_usage.model_calls} 次</>
            )}
            {!!progress.web_usage?.web_extract_calls && (
              <> · 外部提取 {progress.web_usage.web_extract_calls} 次</>
            )}
          </p>
          <CollectionAttempts attempts={progress.collection_attempts} />
          <PaidRequests requests={progress.requests} />
        </div>
      )}
      {job.sourcePause && (
        <p role="status">
          {job.sourcePause.reason}。当前企业完成保存或核对后暂停，剩余队列与进度保留。
          {job.sourcePause.outreachPlanId && (
            <Link
              to={`/inbox?tab=campaigns&campaignId=${encodeURIComponent(job.sourcePause.outreachPlanId)}`}
            >
              查看原触达计划
            </Link>
          )}
        </p>
      )}
      {job.sourcePause?.outreachPlanId && <SourceFirstTouchAuthorization job={job} />}
      {job.input.auto_first_touch && <AutomaticFirstTouchProgress job={job} />}
      {job.countPolicy === 'sales-handoff-v1' && (
        <p className="muted">
          历史任务按原交接口径结束；此处保留实际新增档案数，企业最新初评级见客户库。
        </p>
      )}
      <p className="muted">
        自动新增 {job.inserted} · 人工补录新增 {job.manualInserted || 0} · 确认新增合计{' '}
        {job.confirmedInserted ?? job.inserted} · 更新 {job.updated} · 重复或既有 {job.skipped} ·
        待核实 {job.review || 0} · 不符合条件 {job.rejected} · 失败 {job.failed} ·{' '}
        {job.batch ? '执行待确认' : '写入待确认'} {job.pending}
      </p>
      <p className="muted">
        已搜索 {job.searches} 次 · 已研究 {job.researched} 家
        {!!job.carriedCandidates && <> · 承接往轮候选 {job.carriedCandidates} 家</>}
      </p>
      {job.batch && (
        <p className="muted">
          剩余 {job.remainingTarget} 家 · 已执行至第 {job.batch.number} 批
          {job.insertedPerHour != null && (
            <>
              {' '}
              · 平均{' '}
              {job.insertedPerHour.toLocaleString('zh-CN', {
                maximumFractionDigits: 1,
              })}{' '}
              家/小时
            </>
          )}
          {job.batch.previousBoundary && <> · {batchBoundaries[job.batch.previousBoundary]}</>}
        </p>
      )}
      {!!job.coverage?.languages.length && (
        <p className="muted">
          实际搜索语言 {job.coverage.languages.map((lang) => languageNames.of(lang)).join('、')}
          {!!job.coverage.countries.length && (
            <>
              {' '}
              · 检索地区{' '}
              {job.coverage.countries
                .map((country) => countryFor(country)?.zh || country)
                .join('、')}
            </>
          )}
        </p>
      )}
      {job.researchUsage && (
        <p className="muted" title="模型请求按尝试统计；Token 仅累计供应商返回值。">
          模型请求 {job.researchUsage.model_calls} 次 · 结果复用 {job.researchUsage.cache_hits} 次
          {job.researchUsage.repeat_model_calls !== undefined && (
            <> · 同条件同域名再次请求 {job.researchUsage.repeat_model_calls} 次</>
          )}
          {(job.researchUsage.input_tokens !== undefined ||
            job.researchUsage.output_tokens !== undefined ||
            job.researchUsage.total_tokens !== undefined ||
            job.researchUsage.input_cached_tokens !== undefined) && (
            <>
              {' '}
              · Token 输入 {job.researchUsage.input_tokens ?? '未返回'} / 输出{' '}
              {job.researchUsage.output_tokens ?? '未返回'}
              {job.researchUsage.input_cached_tokens !== undefined && (
                <> · 服务商缓存命中 {job.researchUsage.input_cached_tokens} token</>
              )}
              {reportedTokens !== undefined && <> · 总计 {reportedTokens} token</>}
              {job.inserted > 0 && reportedTokens !== undefined && (
                <>
                  {' '}
                  · 每新增一家已报告 {Math.round(
                    reportedTokens / job.inserted,
                  ).toLocaleString()}{' '}
                  token
                </>
              )}
            </>
          )}
        </p>
      )}
      {job.mapComparison ? (
        <p className="muted">
          {job.searchStats?.some(({ maps }) => maps?.status === 'completed') ? (
            <>
              确认新增 · 官网独有 {job.mapComparison.qualifiedNew.websiteOnly} · 地图独有{' '}
              {job.mapComparison.qualifiedNew.mapsOnly} · 共同发现{' '}
              {job.mapComparison.qualifiedNew.both}
              {' · '}地图独有中引用 Scrapling 证据 {job.mapComparison.qualifiedNew.mapsAndScrapling}
            </>
          ) : (
            '发现以官网搜索为主'
          )}
          {job.mapComparison.pausedReason &&
            ` · 地图已暂停（${mapsReasons[job.mapComparison.pausedReason] || '待核对'}）`}
        </p>
      ) : (
        <p className="muted">发现来源：官网搜索</p>
      )}
      <div className="result-actions">
        {!job.scheduleId &&
          !job.sourceDeletedAt &&
          ['completed', 'partial'].includes(job.status) && (
            <Link className="btn secondary" to={`/automation?rerun=${encodeURIComponent(job.id)}`}>
              重新执行
            </Link>
          )}
        {job.status === 'running' && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => control('pause')}
          >
            暂停并保留进度
          </button>
        )}
        {job.status === 'running' && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => control('stop')}
          >
            停止任务
          </button>
        )}
        {job.status === 'paused' && !job.sourceDeletedAt && (
          <>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => control('resume')}
            >
              {job.manualPaused ? '继续获客' : '确认执行结果并继续'}
            </button>
            <button
              type="button"
              className="btn subtle"
              disabled={busy}
              onClick={() => control('stop')}
            >
              结束任务
            </button>
          </>
        )}
        {!job.sourceDeletedAt && (
          <button
            type="button"
            className="btn subtle"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm('删除来源任务将结束后续执行并关闭自动首发，执行历史保留。确认删除？')
              )
                control('delete');
            }}
          >
            删除来源任务
          </button>
        )}
        <Link className="btn secondary" to="/leads?dataset=real">
          查看客户库
        </Link>
      </div>
      {!!job.searchStats?.length && (
        <details className="batch-details" open={job.status !== 'running'}>
          <summary>查看实际搜索词与产出（{job.searchStats.length} 次）</summary>
          <div className="table-scroll">
            <table className="keyword-effect-table">
              <thead>
                <tr>
                  <th>实际搜索词</th>
                  <th>发现</th>
                  <th>重复</th>
                  <th>已研究</th>
                  <th>新增收录数</th>
                  <th>开发优先级</th>
                </tr>
              </thead>
              <tbody>
                {job.searchStats.map((metric) => (
                  <tr key={metric.id}>
                    <td>
                      {metric.query}
                      <small>
                        官网搜索 ·{' '}
                        {metric.country ||
                          (job.input.country === WORLDWIDE_COUNTRY
                            ? WORLDWIDE_LABEL
                            : job.input.country)}{' '}
                        · {metricState[metric.status] || metric.status}
                        {metric.language && <> · {languageNames.of(metric.language)}</>}
                        {metric.batch && <> · 第 {metric.batch} 批</>}
                        {metric.error ? ` · ${metric.error}` : ''}
                      </small>
                      {metric.maps && (
                        <small>
                          地图 {mapsStates[metric.maps.status] || metric.maps.status}
                          {metric.maps.reason &&
                            ` · ${mapsReasons[metric.maps.reason] || '待核对'}`}
                          {!!metric.maps.attempts &&
                            ` · ${metric.maps.attempts} 次调用 · ${metric.maps.returned} 个地点`}
                          {metric.maps.usage && ` · ${metric.maps.usage.credits} 额度`}
                        </small>
                      )}
                    </td>
                    <td>
                      {metric.discovered}
                      {!!metric.filtered && (
                        <small>
                          来源过滤 {metric.filtered} ·{' '}
                          {Object.entries(metric.filterReasons || {})
                            .map(([reason, count]) => `${reason} ${count}`)
                            .join(' · ')}
                        </small>
                      )}
                    </td>
                    <td>{metric.duplicates}</td>
                    <td>
                      {metric.researched} / {metric.queued}
                      <small>
                        待核实 {metric.review} · 排除 {metric.rejected} · 失败 {metric.failed}
                      </small>
                    </td>
                    <td>{metric.inserted}</td>
                    <td>
                      A {metric.ratings.A || 0} · B {metric.ratings.B || 0} · C{' '}
                      {metric.ratings.C || 0}
                      <small>未定级 {metric.ratings.unrated || 0}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            企业归入第一次发现它的搜索词；后续再次发现计入重复。尚未研究完的候选不参与评级效果判断。
          </p>
          <p className="muted">
            新增目标只统计去重后实际写入并由客户主库读回确认的企业。A/B/C 表示初始开发顺序，
            不表示企业已采购、会回复或资料完整。
          </p>
        </details>
      )}
      {filteredPlatforms.length > 0 && (
        <details className="batch-details">
          <summary>第三方平台已过滤 {filteredPlatforms.length} 条</summary>
          <div className="table-scroll" role="region" aria-label="第三方平台过滤明细" tabIndex={0}>
            <table className="keyword-effect-table">
              <thead>
                <tr>
                  <th>域名</th>
                  <th>搜索词</th>
                  <th>过滤原因</th>
                </tr>
              </thead>
              <tbody>
                {filteredPlatforms.map((source, index) => (
                  <tr key={`${source.domain}-${source.query}-${index}`}>
                    <td>{source.domain}</td>
                    <td>{source.query}</td>
                    <td>{source.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {(() => {
        const insertedRows = job.rows.filter((row) => row.result === 'inserted');
        const otherRows = job.rows.filter((row) => row.result !== 'inserted');
        return (
          <>
            {insertedRows.length > 0 && (
              <details className="batch-details batch-result-details" open>
                <summary>本轮新增（{insertedRows.length}）</summary>
                <div
                  className="batch-result-list"
                  role="region"
                  aria-label="本轮新增结果列表"
                  tabIndex={0}
                >
                  <DetailRows
                    rows={insertedRows}
                    allRows={job.rows}
                    jobId={job.id}
                    onResolved={refreshReview}
                  />
                </div>
              </details>
            )}
            {otherRows.length > 0 && (
              <details className="batch-details batch-result-details">
                <summary>其他处理结果（{otherRows.length}）</summary>
                <div
                  className="batch-result-list"
                  role="region"
                  aria-label="其他处理结果列表"
                  tabIndex={0}
                >
                  <DetailRows
                    rows={otherRows}
                    allRows={job.rows}
                    jobId={job.id}
                    onResolved={refreshReview}
                  />
                </div>
              </details>
            )}
          </>
        );
      })()}
    </section>
  );
}
