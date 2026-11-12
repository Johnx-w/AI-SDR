import { useEffect, useRef, useState } from 'react';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { ProductPicker } from '../components/ProductPicker';
import { useWorkspace } from '../app/WorkspaceProvider';
import { acquisitionApi } from '../services/acquisition';
import type { LocationOptions } from '../services/acquisition';
import type {
  AcquisitionJob,
  AcquisitionSchedule,
  DiscoveryQuery,
  IntegrationStatus,
  ProductSelection,
  ScheduleTiming,
  WorkflowInput,
} from '../domain/types';
import {
  ALL_PRODUCTS_LABEL,
  ALL_PRODUCTS_VALUE,
  builtinProducts,
  directionLabels,
  isAllProductScope,
} from '../domain/acquisition-products.mjs';
import acquisition from '../data/acquisition.json' with { type: 'json' };
import {
  weekdays,
  scheduleRepeatLabel,
  validateTiming,
  nextOccurrence,
} from '../domain/schedule-timing.mjs';
import { formatBeijingTime } from '../domain/date-time.mjs';
import { ScheduledAcquisition } from './ScheduledAcquisition';
import { ExecutionRecords } from './ExecutionRecords';

type Submission = {
  key: string;
  input: WorkflowInput;
  target: number;
  mode: string;
  name: string;
  timing: ScheduleTiming;
};
const submissionStorage = 'shadeflow:pending-acquisition-v2';
const dateInBeijing = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const initialInput: WorkflowInput = {
  query_mode: 'auto',
  auto_first_touch: false,
  customer_types: [],
  country: 'United States',
  region: '',
  product_scope: 'all',
  environment_preference: 'all',
  product: ALL_PRODUCTS_VALUE,
  products: [],
  acquisition_channel: 'web',
  search_query: '',
};
function readSubmission(): Submission | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(submissionStorage) || 'null');
    return value &&
      typeof value.key === 'string' &&
      value.input &&
      ['web', 'tavily_web'].includes(value.input.acquisition_channel) &&
      typeof value.target === 'number' &&
      ['now', 'scheduled'].includes(value.mode) &&
      value.timing
      ? value
      : null;
  } catch {
    return null;
  }
}
function remember(value: Submission | null) {
  try {
    if (value) sessionStorage.setItem(submissionStorage, JSON.stringify(value));
    else sessionStorage.removeItem(submissionStorage);
  } catch {
    /* Restricted browsers retain pending requests in memory. */
  }
}
export function Automation() {
  const { notify } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const editId = params.get('edit');
  const tab =
    params.get('tab') === 'schedules' ? 'schedules' : params.get('tab') === 'runs' ? 'runs' : 'new';
  const [restored] = useState(readSubmission);
  const [input, setInput] = useState<WorkflowInput>({
    ...initialInput,
    ...(restored?.input || {}),
  });
  const [runMode, setRunMode] = useState(
    restored?.mode || (params.get('mode') === 'scheduled' ? 'scheduled' : 'now'),
  );
  const [targetCount, setTargetCount] = useState(restored?.target || 20);
  const [name, setName] = useState<string | null>(restored?.name ?? null);
  const [timing, setTiming] = useState<ScheduleTiming>(
    restored?.timing || {
      repeat: 'weekly',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      startDate: dateInBeijing(),
      times: ['09:00'],
      timezone: 'Asia/Shanghai',
    },
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const [catalog, setCatalog] = useState<ProductSelection[]>(builtinProducts);
  const [catalogError, setCatalogError] = useState('');
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [locations, setLocations] = useState<LocationOptions | null>(null);
  const [locationError, setLocationError] = useState('');
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<DiscoveryQuery[]>([]);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [active, setActive] = useState<AcquisitionJob | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<Submission | null>(restored);
  const [editing, setEditing] = useState<AcquisitionSchedule | null>(null);
  const [editError, setEditError] = useState('');
  const editPlan = editing?.id === editId ? editing : null;
  const previousEditId = useRef<string | null>(null);
  const locked = submitting || (!!pending && !editId);
  const submissionRef = useRef(false);
  const specificProductsRef = useRef(restored?.input.products || []);
  const patch = (changes: Partial<WorkflowInput>) =>
    setInput((current) => ({ ...current, ...changes }));
  const allProductScope = isAllProductScope(input);
  const selected = input.products || [];
  const hasProductSelection =
    allProductScope ||
    selected.length > 0 ||
    (input.product_scope === undefined && !!input.product.trim());
  const environmentPreference = input.environment_preference || 'all';
  const environmentLabels = {
    all: '室内室外均可',
    indoor: '优先室内窗饰',
    outdoor: '优先室外遮阳',
  };
  useEffect(() => {
    if (!pending && params.get('mode') === 'scheduled') setRunMode('scheduled');
  }, [params.get('mode'), pending]);
  useEffect(() => {
    if (!editId) {
      if (previousEditId.current) {
        setInput({ ...initialInput, ...(restored?.input || {}) });
        setTargetCount(restored?.target || 20);
        setName(restored?.name ?? null);
        setTiming(
          restored?.timing || {
            repeat: 'weekly',
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            startDate: dateInBeijing(),
            times: ['09:00'],
            timezone: 'Asia/Shanghai',
          },
        );
        setRunMode(restored?.mode || 'now');
        specificProductsRef.current = restored?.input.products || [];
        setError('');
      }
      previousEditId.current = null;
      setEditing(null);
      return;
    }
    previousEditId.current = editId;
    let alive = true;
    setEditError('');
    acquisitionApi
      .schedules()
      .then(({ schedules }) => {
        if (!alive) return;
        const plan = schedules.find((item) => item.id === editId);
        if (!plan || !['enabled', 'paused'].includes(plan.status))
          throw new Error('该计划已结束或不存在');
        setEditing(plan);
        setInput(plan.input);
        setTargetCount(plan.input.target_count);
        setName(plan.name);
        setTiming(plan.timing);
        setRunMode('scheduled');
        specificProductsRef.current = plan.input.products || [];
      })
      .catch((cause) => {
        if (alive) setEditError(cause instanceof Error ? cause.message : '读取计划失败');
      });
    return () => {
      alive = false;
    };
  }, [editId]);
  useEffect(() => {
    let alive = true;
    acquisitionApi
      .status()
      .then((s) => {
        if (alive) {
          setStatus(s);
          setStatusError('');
        }
      })
      .catch((e) => {
        if (alive) setStatusError(e.message);
      });
    acquisitionApi
      .products()
      .then((data) => {
        if (alive) {
          setCatalog(data.products);
          setCatalogError('');
        }
      })
      .catch((e) => {
        if (alive) setCatalogError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      acquisitionApi
        .jobs()
        .then((data) => {
          if (alive)
            setActive(
              data.jobs.find((j) => ['running', 'stopping', 'paused'].includes(j.status)) || null,
            );
        })
        .catch(() => {});
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLocationsLoading(true);
    setLocationError('');
    acquisitionApi
      .locations(input.country, input.region, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setLocations(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setLocationError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLocationsLoading(false);
      });
    return () => controller.abort();
  }, [input.country, input.region, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setPreview([]);
    setPreviewError('');
    if (!hasProductSelection) {
      setPreviewLoading(false);
      return () => controller.abort();
    }
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      acquisitionApi
        .searchPreview(input, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setPreview(data.queries);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setPreviewError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [JSON.stringify(input), revision]);
  const scheduleName =
    name?.trim() ??
    `${input.country} · ${allProductScope ? ALL_PRODUCTS_LABEL : selected[0]?.label || input.product}`.slice(
      0,
      80,
    );
  const marketLabel =
    locations?.markets.find((m) => m.value === input.country)?.label || input.country;
  const selectedRegion =
    locations?.country === input.country
      ? locations.regions.find((region) => region.name === input.region)
      : undefined;
  const regionLabel = selectedRegion?.label
    ? `${selectedRegion.label} · ${selectedRegion.name}`
    : input.region;
  let timingError = '';
  let nextRunAt: string | null = null;
  const effectiveTiming =
    editPlan || timing.repeat === 'once' ? timing : { ...timing, startDate: dateInBeijing() };
  if (runMode === 'scheduled') {
    try {
      nextRunAt = nextOccurrence(validateTiming(effectiveTiming, now), now);
    } catch (error) {
      timingError = (error as Error).message;
    }
  }
  const weeklyRuns = (timing.weekdays?.length ?? 0) * timing.times.length;
  const canSubmit =
    status?.configured &&
    !statusError &&
    !locationError &&
    !locationsLoading &&
    !previewError &&
    !previewLoading &&
    hasProductSelection &&
    Number.isInteger(targetCount) &&
    targetCount >= 1 &&
    targetCount <= 200 &&
    !timingError &&
    (runMode !== 'scheduled' || !!scheduleName) &&
    !(runMode === 'now' && active) &&
    (!editId || (!!editPlan && !editError));
  async function submit(retry = false) {
    if (submissionRef.current || (!retry && (!canSubmit || locked))) return;
    const request = retry
      ? pending
      : {
          key: crypto.randomUUID(),
          input,
          target: targetCount,
          mode: runMode,
          name: scheduleName,
          timing: effectiveTiming,
        };
    if (!request) return;
    if (!retry && request.mode === 'scheduled') {
      try {
        validateTiming(request.timing, Date.now());
      } catch (error) {
        setNow(Date.now());
        setError((error as Error).message);
        return;
      }
    }
    submissionRef.current = true;
    setSubmitting(true);
    setError('');
    if (!editPlan) {
      setPending(request);
      remember(request);
    }
    try {
      if (editPlan) {
        await acquisitionApi.updateSchedule(
          editPlan.id,
          request.name,
          request.input,
          request.target,
          request.timing,
        );
        notify('定时计划已更新');
        setParams({ tab: 'schedules' });
      } else if (request.mode === 'scheduled') {
        await acquisitionApi.createSchedule(
          request.name,
          request.input,
          request.target,
          request.timing,
          request.key,
        );
        setPending(null);
        remember(null);
        notify('定时计划已创建并启用');
        setParams({ tab: 'schedules' });
      } else {
        const job = await acquisitionApi.createJob(request.input, request.target, request.key);
        setPending(null);
        remember(null);
        setActive(job);
        notify('获客任务已开始');
        setParams({ tab: 'runs', job: job.id });
      }
    } catch (e) {
      const problem = e as Error & { status?: number };
      if (
        !editPlan &&
        problem.status &&
        [400, 403, 404, 409, 413, 415, 429, 503].includes(problem.status)
      ) {
        setPending(null);
        remember(null);
      }
      setError(problem.message || '提交结果待核对');
    } finally {
      setSubmitting(false);
      submissionRef.current = false;
    }
  }
  const summary = (
    <aside className="panel acq-summary" aria-label="任务摘要">
      <div className="acq-summary-heading">
        <span className="acq-step-number">
          <CheckCircle2 size={17} />
        </span>
        <div>
          <h2>任务摘要</h2>
          <p>确认这次要寻找的企业</p>
        </div>
      </div>
      <div className="acq-summary-block">
        <h3>目标客户</h3>
        <p>
          <strong>{marketLabel}</strong>
          <small>{regionLabel || '全部地区'}</small>
        </p>
        {allProductScope ? (
          <p>
            {ALL_PRODUCTS_LABEL}
            <small>{environmentLabels[environmentPreference]}</small>
          </p>
        ) : selected.length ? (
          <div className="acq-summary-products">
            {selected.slice(0, 3).map((p) => (
              <span key={p.value}>
                {p.label}
                <small>{directionLabels[p.direction]}</small>
              </span>
            ))}
            {selected.length > 3 && (
              <details>
                <summary>
                  共 {selected.length} 项产品 · 展开其余 {selected.length - 3} 项
                </summary>
                {selected.slice(3).map((p) => (
                  <span key={p.value}>
                    {p.label}
                    <small>{directionLabels[p.direction]}</small>
                  </span>
                ))}
              </details>
            )}
          </div>
        ) : (
          <p>{input.product || '尚未选择产品'}</p>
        )}
        <p>
          {input.customer_types?.length
            ? acquisition.customerTypes
                .filter((t) => input.customer_types!.includes(t.value))
                .map((t) => t.label)
                .join('、')
            : '不限客户类型'}
        </p>
      </div>
      <div className="acq-summary-block">
        <h3>执行安排</h3>
        <p>
          每轮新增目标{' '}
          <strong className="acq-summary-count">
            {Number.isFinite(targetCount) ? targetCount : '—'}
          </strong>{' '}
          家
        </p>
        {runMode === 'now' ? (
          <p>
            立即执行一轮<small>离开页面后，服务端继续运行</small>
          </p>
        ) : (
          <>
            <p>
              {scheduleRepeatLabel(timing)} · {timing.times.join('、')}
              <small>{timing.repeat === 'once' ? `${timing.startDate} · ` : ''}北京时间</small>
            </p>
            {timing.repeat !== 'once' && !timingError && (
              <p>
                完整一周 {weeklyRuns} 轮
                <small>
                  新增目标合计 {Number.isFinite(targetCount) ? weeklyRuns * targetCount : '—'}{' '}
                  家；实际收录可能少于目标
                </small>
              </p>
            )}
            <p>
              <small>下次执行（北京时间）</small>
              {timingError ? '请完善定时设置' : formatBeijingTime(nextRunAt)}
            </p>
            {timing.repeat !== 'once' && <small>持续执行，直到暂停或关闭</small>}
            <small>错过的时点跳过，不补跑</small>
          </>
        )}
      </div>
      <div className="acq-summary-block">
        <h3>获客后处理</h3>
        <p className={input.auto_first_touch ? 'acq-summary-sending' : ''}>
          <strong>{input.auto_first_touch ? '获客后自动首发' : '仅获客'}</strong>
          <small>
            {input.auto_first_touch
              ? '符合条件的未首发客户自动发送；无可用商务邮箱跳过本次'
              : '仅收录客户和研究资料'}
          </small>
          {input.auto_first_touch && input.auto_follow_up && (
            <small>首封未回复：第 3 天、第 7 天各自动跟进一次</small>
          )}
        </p>
      </div>
      <button
        className="btn primary acq-submit"
        form="acquisition-create"
        type="submit"
        disabled={!canSubmit || locked}
      >
        {submitting ? (
          <LoaderCircle className="spin" size={17} />
        ) : runMode === 'scheduled' ? (
          <CalendarDays size={17} />
        ) : (
          <Play size={17} />
        )}
        {submitting
          ? '正在提交…'
          : editPlan
            ? '保存计划修改'
            : runMode === 'scheduled'
              ? '创建并启用计划'
              : '开始获客'}
        <ArrowRight size={16} />
      </button>
      {active && (
        <Link className="acq-active-link" to={'/automation?tab=runs&job=' + active.id}>
          已有任务{active.status === 'paused' ? '待核对' : '进行中'} · 查看进度{' '}
          <ArrowRight size={14} />
        </Link>
      )}
    </aside>
  );
  return (
    <div className="acq-page">
      <PageHeading eyebrow="ACQUISITION" title="获客任务">
        <button className="btn secondary" onClick={() => setRevision((n) => n + 1)}>
          <RefreshCw size={15} />
          刷新
        </button>
      </PageHeading>
      <div className="acq-topline">
        <p>设置目标企业，让系统完成发现与研究。</p>
      </div>
      <nav className="acq-page-tabs" aria-label="获客任务页面">
        {[
          ['new', editPlan ? '编辑计划' : '新建任务'],
          ['schedules', '定时计划'],
          ['runs', '执行记录'],
        ].map(([value, label]) => (
          <button
            key={value}
            aria-current={tab === value ? 'page' : undefined}
            className={tab === value ? 'selected' : ''}
            onClick={() => setParams(value === 'new' ? {} : { tab: value })}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'schedules' ? (
        <ScheduledAcquisition />
      ) : tab === 'runs' ? (
        <ExecutionRecords selectedId={params.get('job') || undefined} />
      ) : (
        <>
          {(statusError || (status && !status.configured)) && (
            <div className="acq-notice" role="status">
              <strong>{statusError || '请先配置获客服务连接'}</strong>
              <Link to="/settings">
                前往API连接 <ArrowRight size={14} />
              </Link>
            </div>
          )}
          {catalogError && !allProductScope && (
            <div className="acq-notice">
              常用产品目录读取失败，当前可使用内置产品。
              <button type="button" onClick={() => setRevision((n) => n + 1)}>
                重新读取
              </button>
            </div>
          )}
          {editId && (editing?.id !== editId || editError) ? (
            <div className="acq-notice" role="status">
              {editError || '正在读取计划…'}
              {editError && <Link to="/automation?tab=schedules">返回定时计划</Link>}
            </div>
          ) : null}
          {editPlan && (
            <div className="acq-notice" role="status">
              正在编辑“{editPlan.name}”。修改将在后续轮次生效，已开始的任务沿用原设置。
              <Link to="/automation?tab=schedules">取消编辑</Link>
            </div>
          )}
          {!editPlan && pending && !submitting && (
            <div className="acq-notice" role="status">
              <span>上次提交结果待核对，配置已保留。</span>
              <button className="btn secondary" onClick={() => void submit(true)}>
                核对本次提交
              </button>
            </div>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <div
            className="acq-create-layout"
            style={editId && !editPlan ? { display: 'none' } : undefined}
          >
            <form
              id="acquisition-create"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <fieldset className="acq-form-fields" disabled={locked}>
                <section className="panel acq-config-section">
                  <header>
                    <span className="acq-step-number">01</span>
                    <div>
                      <h2>目标客户</h2>
                      <p>选择市场、产品和企业经营角色</p>
                    </div>
                  </header>
                  <div className="acq-form-grid">
                    <label>
                      目标国家／市场
                      <select
                        aria-label="任务国家"
                        value={input.country}
                        onChange={(e) => patch({ country: e.target.value, region: '' })}
                      >
                        {(
                          locations?.markets || [
                            { value: 'United States', label: '美国 · United States' },
                            { value: 'Australia', label: '澳大利亚 · Australia' },
                          ]
                        ).map((m) => (
                          <option value={m.value} key={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      州／地区
                      <select
                        aria-label="州 / 地区"
                        value={input.region}
                        disabled={locationsLoading || !!locationError}
                        onChange={(e) => patch({ region: e.target.value })}
                      >
                        <option value="">全部州／地区</option>
                        {(locations?.country === input.country ? locations.regions : []).map(
                          (r) => (
                            <option key={r.code} value={r.name}>
                              {r.label ? r.label + ' · ' : ''}
                              {r.name}
                            </option>
                          ),
                        )}
                      </select>
                      {locationsLoading && <small>正在读取地区…</small>}
                    </label>
                  </div>
                  {locationError && (
                    <p className="error-message" role="alert">
                      {locationError}
                      <button type="button" onClick={() => setRevision((n) => n + 1)}>
                        重新读取
                      </button>
                    </p>
                  )}
                  <div className="acq-field-label">产品范围</div>
                  <div className="acq-scope-options" role="radiogroup" aria-label="产品范围">
                    <label className={allProductScope ? 'selected' : ''}>
                      <input
                        type="radio"
                        name="product-scope"
                        value="all"
                        checked={allProductScope}
                        onChange={() => {
                          specificProductsRef.current = selected;
                          patch({
                            product_scope: 'all',
                            products: [],
                            product: ALL_PRODUCTS_VALUE,
                          });
                        }}
                      />
                      <span>
                        {ALL_PRODUCTS_LABEL}
                        <small>日常广泛获客，系统自动扩展相关品类</small>
                      </span>
                    </label>
                    <label className={!allProductScope ? 'selected' : ''}>
                      <input
                        type="radio"
                        name="product-scope"
                        value="specific"
                        checked={!allProductScope}
                        onChange={() => {
                          const products = specificProductsRef.current;
                          patch({
                            product_scope: 'specific',
                            products,
                            product: products.map((product) => product.value).join(', '),
                          });
                        }}
                      />
                      <span>
                        指定产品
                        <small>用于专项开发，已选产品会限制本次获客范围</small>
                      </span>
                    </label>
                  </div>
                  {!allProductScope && (
                    <>
                      <p className="acq-preference-help">
                        选择本次要开发的产品，满足其中任意一种即可；成品、材料配件均可选择。
                      </p>
                      <ProductPicker
                        catalog={catalog}
                        selected={selected}
                        disabled={locked}
                        onSaved={(product) =>
                          setCatalog((current) => [
                            ...current.filter(
                              (item) => item.value.toLowerCase() !== product.value.toLowerCase(),
                            ),
                            product,
                          ])
                        }
                        onChange={(products) => {
                          specificProductsRef.current = products;
                          patch({
                            product_scope: 'specific',
                            products,
                            product: products.map((product) => product.value).join(', '),
                          });
                        }}
                      />
                      {!hasProductSelection && (
                        <p className="acq-preference-help">请至少选择一个产品后开始获客。</p>
                      )}
                    </>
                  )}
                  {allProductScope && (
                    <>
                      <div className="acq-field-label">
                        产品偏好<span>选填 · 调整寻找重点</span>
                      </div>
                      <div
                        className="acq-environment-options"
                        role="radiogroup"
                        aria-label="产品偏好"
                      >
                        {(['all', 'indoor', 'outdoor'] as const).map((value) => (
                          <label
                            key={value}
                            className={environmentPreference === value ? 'selected' : ''}
                          >
                            <input
                              type="radio"
                              name="environment-preference"
                              value={value}
                              checked={environmentPreference === value}
                              onChange={() => patch({ environment_preference: value })}
                            />
                            {environmentLabels[value]}
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="acq-field-label">
                    客户类型<span>可多选，满足任意一种即可；不选则不限</span>
                  </div>
                  <div className="acq-role-options">
                    {acquisition.customerTypes
                      .filter((t) => t.value !== 'other')
                      .map((type) => (
                        <label
                          className={input.customer_types?.includes(type.value) ? 'selected' : ''}
                          key={type.value}
                        >
                          <input
                            type="checkbox"
                            value={type.value}
                            checked={!!input.customer_types?.includes(type.value)}
                            onChange={(e) =>
                              patch({
                                customer_types: e.target.checked
                                  ? [...(input.customer_types || []), type.value]
                                  : input.customer_types?.filter((v) => v !== type.value),
                              })
                            }
                          />
                          {type.label}
                        </label>
                      ))}
                  </div>
                </section>
                <section className="panel acq-config-section">
                  <header>
                    <span className="acq-step-number">02</span>
                    <div>
                      <h2>执行安排</h2>
                      <p>确定每轮数量，以及何时开始运行</p>
                    </div>
                  </header>
                  <label className="acq-block-label">
                    每轮新增企业目标
                    <div className="acq-quantity">
                      <input
                        aria-label="本次新增客户目标"
                        type="number"
                        min={1}
                        max={200}
                        step={1}
                        required
                        value={Number.isNaN(targetCount) ? '' : targetCount}
                        onChange={(e) => setTargetCount(e.target.valueAsNumber)}
                      />
                      <span>家</span>
                    </div>
                  </label>
                  <p className="acq-preference-help">
                    按去重后实际新增收录计数，每个执行时间点各运行一轮。
                  </p>
                  <div className="acq-quantity-presets">
                    {[5, 10, 20, 50, 100, 200].map((n) => (
                      <button
                        type="button"
                        className={targetCount === n ? 'selected' : ''}
                        key={n}
                        onClick={() => setTargetCount(n)}
                      >
                        {n} 家
                      </button>
                    ))}
                  </div>
                  {!editPlan && (
                    <div className="acq-run-mode" role="radiogroup" aria-label="执行方式">
                      {[
                        ['now', '立即获客'],
                        ['scheduled', '定时获客'],
                      ].map(([value, label]) => (
                        <label className={runMode === value ? 'selected' : ''} key={value}>
                          <input
                            type="radio"
                            name="run-mode"
                            value={value}
                            checked={runMode === value}
                            onChange={() => setRunMode(value)}
                          />
                          {value === 'now' ? <Play size={17} /> : <CalendarDays size={17} />}
                          {label}
                        </label>
                      ))}
                    </div>
                  )}
                  {runMode === 'scheduled' && (
                    <div className="acq-schedule-config">
                      <div className="acq-field-label">
                        <CalendarDays size={16} />
                        定时设置<span>北京时间</span>
                      </div>
                      <div className="acq-run-mode" role="radiogroup" aria-label="重复方式">
                        {(
                          [
                            ['once', '仅执行一次'],
                            ['weekly', '重复执行'],
                          ] as const
                        ).map(([value, label]) => (
                          <label className={timing.repeat === value ? 'selected' : ''} key={value}>
                            <input
                              type="radio"
                              name="schedule-repeat"
                              value={value}
                              checked={timing.repeat === value}
                              onChange={() =>
                                setTiming({
                                  ...timing,
                                  repeat: value,
                                  times: value === 'once' ? timing.times.slice(0, 1) : timing.times,
                                })
                              }
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      {timing.repeat !== 'once' && (
                        <div className="acq-weekday-field">
                          <div className="acq-field-label" id="acq-weekday-label">
                            每周执行日<span>可多选</span>
                          </div>
                          <ToggleGroup.Root
                            type="multiple"
                            className="acq-weekdays"
                            aria-labelledby="acq-weekday-label"
                            value={(timing.weekdays ?? []).map(String)}
                            disabled={locked}
                            onValueChange={(values) =>
                              setTiming({
                                ...timing,
                                repeat: 'weekly',
                                weekdays: values.map(Number).sort((a, b) => a - b),
                              })
                            }
                          >
                            {weekdays.map(({ value, label }) => (
                              <ToggleGroup.Item
                                key={value}
                                value={String(value)}
                                aria-label={label}
                              >
                                {label}
                              </ToggleGroup.Item>
                            ))}
                          </ToggleGroup.Root>
                        </div>
                      )}
                      {timing.repeat === 'once' && (
                        <label className="acq-block-label">
                          执行日期
                          <input
                            aria-label="执行日期"
                            type="date"
                            min={dateInBeijing()}
                            required
                            value={timing.startDate}
                            onChange={(e) => setTiming({ ...timing, startDate: e.target.value })}
                          />
                        </label>
                      )}
                      <div className="acq-time-list">
                        {timing.times.map((time, i) => (
                          <div key={i}>
                            <label>
                              {timing.repeat === 'once' ? '执行时间' : `执行时间 ${i + 1}`}
                              <input
                                aria-label={`执行时间 ${i + 1}（北京时间）`}
                                type="time"
                                required
                                value={time}
                                onChange={(e) =>
                                  setTiming({
                                    ...timing,
                                    times: timing.times.map((t, index) =>
                                      index === i ? e.target.value : t,
                                    ),
                                  })
                                }
                              />
                            </label>
                            {timing.repeat !== 'once' && (
                              <button
                                type="button"
                                aria-label={`删除执行时间 ${i + 1}`}
                                disabled={timing.times.length === 1}
                                onClick={() =>
                                  setTiming({
                                    ...timing,
                                    times: timing.times.filter((_, index) => index !== i),
                                  })
                                }
                              >
                                <X size={16} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {timing.repeat !== 'once' && (
                        <button
                          type="button"
                          className="acq-text-button"
                          disabled={timing.times.length >= 24}
                          onClick={() => {
                            const available = Array.from(
                              { length: 24 },
                              (_, h) => `${String(h).padStart(2, '0')}:00`,
                            ).find((t) => !timing.times.includes(t));
                            if (available)
                              setTiming({ ...timing, times: [...timing.times, available] });
                          }}
                        >
                          <Plus size={15} />
                          添加执行时间
                        </button>
                      )}
                      <label className="acq-block-label">
                        计划名称
                        <input
                          aria-label="计划名称"
                          maxLength={80}
                          required
                          value={name ?? scheduleName}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </label>
                      {timingError && (
                        <p className="error-message" role="alert">
                          {timingError}
                        </p>
                      )}
                    </div>
                  )}
                </section>
                <section className="panel acq-config-section">
                  <header>
                    <span className="acq-step-number">03</span>
                    <div>
                      <h2>获客后处理</h2>
                      <p>明确本次是否会自动向客户发送邮件</p>
                    </div>
                  </header>
                  <div className="acq-followup-options" role="radiogroup" aria-label="获客后处理">
                    <label className={!input.auto_first_touch ? 'selected' : ''}>
                      <input
                        type="radio"
                        name="acquisition-followup"
                        checked={!input.auto_first_touch}
                        onChange={() => patch({ auto_first_touch: false })}
                      />
                      <span>
                        <strong>仅获客</strong>
                        <small>收录企业和研究资料，由你后续处理。</small>
                      </span>
                    </label>
                    <label className={input.auto_first_touch ? 'selected' : ''}>
                      <input
                        type="radio"
                        name="acquisition-followup"
                        checked={input.auto_first_touch === true}
                        onChange={() => patch({ auto_first_touch: true })}
                      />
                      <span>
                        <strong>获客后自动首发</strong>
                        <small>
                          符合条件、尚未首发的客户自动发送；无可用商务邮箱跳过本次，其他缺项保留原因。
                        </small>
                      </span>
                    </label>
                  </div>
                  {input.auto_first_touch && (
                    <label>
                      <input
                        type="checkbox"
                        checked={input.auto_follow_up === true}
                        onChange={(event) => patch({ auto_follow_up: event.target.checked })}
                      />
                      首封未回复自动跟进（第3天、第7天，定时计划用于后续轮次）
                    </label>
                  )}
                  {input.auto_first_touch && (
                    <p className="acq-preference-help">
                      根据客户经营证据匹配最新已审核产品和可用邮箱。同一企业只安排一封首信。
                    </p>
                  )}
                </section>
              </fieldset>
              <section className="panel acq-search-strategy">
                <details>
                  <summary>
                    <span>
                      <Search size={17} />
                      搜索词与搜索策略
                    </span>
                    <span>
                      {previewLoading ? '正在生成…' : `${preview.length} 条查询`}
                      <ChevronDown size={15} />
                    </span>
                  </summary>
                  <p className="muted">
                    系统根据产品、市场和客户条件生成查询；执行后可在记录中查看实际产出。
                  </p>
                  {previewError && (
                    <p className="error-message" role="alert">
                      {previewError}
                    </p>
                  )}
                  <ol>
                    {preview.map((q, i) => (
                      <li key={`${q.country}:${q.query}`}>
                        <small>
                          {i + 1} · 官网搜索 · {q.country}
                        </small>
                        <span>{q.query}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              </section>
            </form>
            {summary}
          </div>
        </>
      )}
    </div>
  );
}
