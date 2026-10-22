import { useEffect, useRef, useState } from 'react';
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
  audience: 'BC',
  customer_types: [],
  preferred_requirements: '',
  required_requirements: [],
  country: 'United States',
  region: '',
  product_scope: 'all',
  environment_preference: 'all',
  product: ALL_PRODUCTS_VALUE,
  products: [],
  acquisition_channel: 'tavily_web',
  search_query: '',
};
function readSubmission(): Submission | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(submissionStorage) || 'null');
    return value &&
      typeof value.key === 'string' &&
      value.input &&
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
  const tab =
    params.get('tab') === 'schedules' ? 'schedules' : params.get('tab') === 'runs' ? 'runs' : 'new';
  const [restored] = useState(readSubmission);
  const [input, setInput] = useState<WorkflowInput>(restored?.input || initialInput);
  const [requiredText, setRequiredText] = useState(
    (restored?.input.required_requirements || []).join('\n'),
  );
  const [runMode, setRunMode] = useState(
    restored?.mode || (params.get('mode') === 'scheduled' ? 'scheduled' : 'now'),
  );
  const [targetCount, setTargetCount] = useState(restored?.target || 20);
  const [name, setName] = useState(restored?.name || '');
  const [timing, setTiming] = useState<ScheduleTiming>(
    restored?.timing || {
      repeat: 'daily',
      startDate: dateInBeijing(),
      times: ['09:00'],
      timezone: 'Asia/Shanghai',
    },
  );
  const [catalog, setCatalog] = useState<ProductSelection[]>(builtinProducts);
  const [catalogError, setCatalogError] = useState('');
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [locations, setLocations] = useState<LocationOptions | null>(null);
  const [locationError, setLocationError] = useState('');
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<{ country: string; query: string }[]>([]);
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [active, setActive] = useState<AcquisitionJob | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<Submission | null>(restored);
  const locked = submitting || !!pending;
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
  const required = input.required_requirements || [];
  const scheduleName =
    name.trim() ||
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
    !(runMode === 'now' && active);
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
          timing,
        };
    if (!request) return;
    submissionRef.current = true;
    setSubmitting(true);
    setError('');
    setPending(request);
    remember(request);
    try {
      if (request.mode === 'scheduled') {
        await acquisitionApi.createSchedule(
          request.name,
          request.input,
          request.target,
          request.timing,
          request.key,
        );
        setPending(null);
        remember(null);
        notify('定时计划已保存');
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
      if (problem.status && [400, 403, 404, 409, 413, 415, 429, 503].includes(problem.status)) {
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
      <dl>
        <div>
          <dt>目标市场</dt>
          <dd>
            {marketLabel}
            {input.region && <small>{regionLabel}</small>}
          </dd>
        </div>
        <div>
          <dt>业务范围</dt>
          <dd>
            {allProductScope ? (
              <>
                {ALL_PRODUCTS_LABEL}
                <small>成品、半成品、材料与零件</small>
              </>
            ) : selected.length ? (
              selected.map((p) => (
                <span className="acq-summary-product" key={p.value}>
                  {p.label}
                  <small>{directionLabels[p.direction]}</small>
                </span>
              ))
            ) : (
              input.product || '尚未选择'
            )}
          </dd>
        </div>
        <div>
          <dt>产品偏好</dt>
          <dd>
            {environmentLabels[environmentPreference]}
            {environmentPreference !== 'all' && <small>优先寻找，兼顾另一方向</small>}
          </dd>
        </div>
        <div>
          <dt>客户类型</dt>
          <dd>
            {input.customer_types?.length
              ? acquisition.customerTypes
                  .filter((t) => input.customer_types!.includes(t.value))
                  .map((t) => t.label)
                  .join('、')
              : '不限类型'}
          </dd>
        </div>
        {input.preferred_requirements && (
          <div>
            <dt>优先偏好</dt>
            <dd>{input.preferred_requirements}</dd>
          </div>
        )}
        {!!required.length && (
          <div>
            <dt>必须满足</dt>
            <dd>
              {required.map((s, i) => (
                <span key={i}>{s}</span>
              ))}
            </dd>
          </div>
        )}
        <div>
          <dt>每轮目标</dt>
          <dd>
            <b>{Number.isFinite(targetCount) ? targetCount : '—'}</b> 家新增企业
          </dd>
        </div>
        <div>
          <dt>执行安排</dt>
          <dd>
            {runMode === 'now'
              ? '立即开始'
              : `${{ once: '指定日期', daily: '每天', weekly: '每周' }[timing.repeat]} · ${timing.times.join('、')}`}
            <small>
              {runMode === 'scheduled'
                ? timing.startDate + ' 起 · 北京时间'
                : '离开页面后，服务端继续运行'}
            </small>
          </dd>
        </div>
        <div>
          <dt>搜索策略</dt>
          <dd>
            系统自动生成
            <small>{previewLoading ? '正在生成预览…' : `${preview.length} 条拟用查询`}</small>
          </dd>
        </div>
      </dl>
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
        {submitting ? '正在提交…' : runMode === 'scheduled' ? '保存定时计划' : '开始获客'}
        <ArrowRight size={16} />
      </button>
      <p className="acq-summary-note">
        按去重后的新增入库企业计数；研究受限或达到运行上限时，保留已完成结果并说明原因。
      </p>
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
          ['new', '新建任务'],
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
        <ScheduledAcquisition embedded />
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
          {pending && !submitting && (
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
          <div className="acq-create-layout">
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
                      <h2>目标范围</h2>
                      <p>选择希望向哪类市场销售什么产品</p>
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
                  <div className="acq-field-label">业务范围</div>
                  <div className="acq-business-scope" role="status">
                    <CheckCircle2 size={19} />
                    <div>
                      <strong>{allProductScope ? ALL_PRODUCTS_LABEL : '指定产品'}</strong>
                      <p>
                        {allProductScope
                          ? '覆盖窗饰成品、半成品、材料与零件，由系统识别客户实际经营产品和可匹配的供货方向。'
                          : '本次仅寻找与指定产品相关的企业，可在高级产品设置中调整。'}
                      </p>
                    </div>
                  </div>
                  <div className="acq-field-label">
                    产品偏好<span>选填 · 调整寻找重点</span>
                  </div>
                  <div className="acq-environment-options" role="radiogroup" aria-label="产品偏好">
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
                  <details className="acq-advanced acq-product-advanced">
                    <summary>
                      <span>高级产品设置</span>
                      <span>
                        {allProductScope
                          ? '全部业务'
                          : hasProductSelection
                            ? '已指定产品'
                            : '待选产品'}{' '}
                        <ChevronDown size={14} />
                      </span>
                    </summary>
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
                  </details>
                </section>
                <section className="panel acq-config-section">
                  <header>
                    <span className="acq-step-number">02</span>
                    <div>
                      <h2>客户条件</h2>
                      <p>选择经营角色，补充值得优先寻找的特征</p>
                    </div>
                  </header>
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
                  <label className="acq-block-label">
                    补充要求 <span>选填 · 优先偏好</span>
                    <textarea
                      maxLength={600}
                      rows={3}
                      value={input.preferred_requirements}
                      placeholder="例如：优先经营电动卷帘，有酒店工程经验"
                      onChange={(e) => patch({ preferred_requirements: e.target.value })}
                    />
                    <small>缺少这些特征的证据不会单独排除企业。</small>
                  </label>
                  <details className="acq-advanced">
                    <summary>
                      必需条件与更多筛选 <ChevronDown size={14} />
                    </summary>
                    <label className="acq-block-label">
                      必须满足的条件
                      <textarea
                        rows={3}
                        maxLength={966}
                        value={requiredText}
                        placeholder="每行一条，最多6条。只有明确不能接受的条件才填在这里。"
                        onChange={(e) => {
                          setRequiredText(e.target.value);
                          patch({
                            required_requirements: e.target.value
                              .split('\n')
                              .map((value) => value.trim())
                              .filter(Boolean),
                          });
                        }}
                      />
                      <small>有明确相反证据则排除；未查清则列为待核实。</small>
                    </label>
                    <label className="acq-block-label">
                      目标企业服务的客群
                      <select
                        value={input.audience}
                        onChange={(e) =>
                          patch({ audience: e.target.value as WorkflowInput['audience'] })
                        }
                      >
                        <option value="BC">不限服务客群</option>
                        <option value="B">面向企业、经销商或商用项目</option>
                        <option value="C">面向家庭消费者</option>
                      </select>
                      <small>这些选项描述目标企业服务谁；被寻找的对象仍是经营企业。</small>
                    </label>
                  </details>
                </section>
                <section className="panel acq-config-section">
                  <header>
                    <span className="acq-step-number">03</span>
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
                  <div className="acq-run-mode" role="radiogroup" aria-label="执行方式">
                    {[
                      ['now', '立即获客'],
                      ['scheduled', '定时自动获客'],
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
                  {runMode === 'scheduled' && (
                    <div className="acq-schedule-config">
                      <div className="acq-field-label">
                        <CalendarDays size={16} />
                        定时设置<span>北京时间</span>
                      </div>
                      <div className="acq-form-grid">
                        <label className="acq-span-2">
                          计划名称
                          <input
                            maxLength={80}
                            value={name}
                            placeholder={scheduleName}
                            onChange={(e) => setName(e.target.value)}
                          />
                        </label>
                        <label>
                          执行周期
                          <select
                            aria-label="执行周期"
                            value={timing.repeat}
                            onChange={(e) =>
                              setTiming({
                                ...timing,
                                repeat: e.target.value as ScheduleTiming['repeat'],
                              })
                            }
                          >
                            <option value="once">指定日期，不重复</option>
                            <option value="daily">每天</option>
                            <option value="weekly">每周，与开始日期同一天</option>
                          </select>
                        </label>
                        <label>
                          开始日期
                          <input
                            aria-label="开始日期"
                            type="date"
                            min={dateInBeijing()}
                            required
                            value={timing.startDate}
                            onChange={(e) => setTiming({ ...timing, startDate: e.target.value })}
                          />
                        </label>
                      </div>
                      <div className="acq-time-list">
                        {timing.times.map((time, i) => (
                          <div key={i}>
                            <label>
                              执行时间 {i + 1}
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
                          </div>
                        ))}
                      </div>
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
                      <p className="muted">
                        每个时间点触发一轮。服务端需持续运行，冲突任务顺序排队。
                      </p>
                    </div>
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
                    系统根据产品、市场和客户条件生成词组。执行后可在记录中查看实际使用的词及产出。
                  </p>
                  {previewError && (
                    <p className="error-message" role="alert">
                      {previewError}
                    </p>
                  )}
                  <ol>
                    {preview.map((q, i) => (
                      <li key={q.query}>
                        <small>
                          {i + 1} · {q.country}
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
