import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CalendarDays,
  Facebook,
  Globe2,
  Instagram,
  KeyRound,
  LoaderCircle,
  Linkedin,
  MapPinned,
  Play,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { useWorkspace } from '../app/WorkspaceProvider';
import { Badge, ExternalLink, SectionTitle } from '../components/ui';
import { acquisitionApi, WORKFLOW_URL } from '../services/acquisition';
import type { LocationOptions } from '../services/acquisition';
import type { IntegrationStatus, WorkflowInput } from '../domain/types';
import type { AcquisitionJob } from '../domain/types';
import type { ScheduleTiming } from '../domain/types';
import { BatchProgress } from '../components/BatchProgress';
import acquisition from '../data/acquisition.json' with { type: 'json' };
import { buildSearchQuery } from '../domain/search-query.mjs';
const { productGroups, customerTypes, profiles } = acquisition;

const acquisitionChannels = [
  {
    id: 'tavily_web',
    name: '网页搜索',
    icon: Globe2,
    available: true,
  },
  {
    id: 'google_maps',
    name: 'Google 地图商家挖掘',
    icon: MapPinned,
    available: false,
  },
  {
    id: 'linkedin',
    name: 'LinkedIn 企业 & 决策人挖掘',
    icon: Linkedin,
    available: false,
  },
  {
    id: 'facebook',
    name: 'Facebook 商家主页挖掘',
    icon: Facebook,
    available: false,
  },
  {
    id: 'instagram',
    name: 'Instagram 商家主页挖掘',
    icon: Instagram,
    available: false,
  },
  {
    id: 'local_directories',
    name: '各国本地行业黄页',
    icon: BookOpen,
    available: false,
  },
] as const;
const regionNamesZh: Record<string, string> = {
  AL: '阿拉巴马州',
  AK: '阿拉斯加州',
  AZ: '亚利桑那州',
  AR: '阿肯色州',
  CA: '加利福尼亚州',
  CO: '科罗拉多州',
  CT: '康涅狄格州',
  DE: '特拉华州',
  FL: '佛罗里达州',
  GA: '佐治亚州',
  HI: '夏威夷州',
  ID: '爱达荷州',
  IL: '伊利诺伊州',
  IN: '印第安纳州',
  IA: '艾奥瓦州',
  KS: '堪萨斯州',
  KY: '肯塔基州',
  LA: '路易斯安那州',
  ME: '缅因州',
  MD: '马里兰州',
  MA: '马萨诸塞州',
  MI: '密歇根州',
  MN: '明尼苏达州',
  MS: '密西西比州',
  MO: '密苏里州',
  MT: '蒙大拿州',
  NE: '内布拉斯加州',
  NV: '内华达州',
  NH: '新罕布什尔州',
  NJ: '新泽西州',
  NM: '新墨西哥州',
  NY: '纽约州',
  NC: '北卡罗来纳州',
  ND: '北达科他州',
  OH: '俄亥俄州',
  OK: '俄克拉何马州',
  OR: '俄勒冈州',
  PA: '宾夕法尼亚州',
  RI: '罗得岛州',
  SC: '南卡罗来纳州',
  SD: '南达科他州',
  TN: '田纳西州',
  TX: '得克萨斯州',
  UT: '犹他州',
  VT: '佛蒙特州',
  VA: '弗吉尼亚州',
  WV: '西弗吉尼亚州',
  WI: '威斯康星州',
  WY: '怀俄明州',
  DC: '哥伦比亚特区',
  ACT: '澳大利亚首都领地',
  NSW: '新南威尔士州',
  NT: '北领地',
  QLD: '昆士兰州',
  SA: '南澳大利亚州',
  TAS: '塔斯马尼亚州',
  VIC: '维多利亚州',
};
const selectedProducts = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const defaultInput: WorkflowInput = {
  audience: 'BC',
  customer_type: '',
  customer_profile: 'all',
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
  search_query: 'outdoor zip screens Florida USA',
};
defaultInput.search_query = buildSearchQuery(defaultInput);
export function Automation() {
  const { notify } = useWorkspace();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [runMode, setRunMode] = useState(params.get('mode') === 'scheduled' ? 'scheduled' : 'now');
  const [scheduleName, setScheduleName] = useState('');
  const [timing, setTiming] = useState<ScheduleTiming>({
    repeat: 'daily',
    startDate: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    times: ['09:00'],
    timezone: 'Asia/Shanghai',
  });
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [input, setInput] = useState<WorkflowInput>(defaultInput);
  const [running, setRunning] = useState(false);
  const [job, setJob] = useState<AcquisitionJob | null>(null);
  const [targetCount, setTargetCount] = useState(20);
  const [quantityChoice, setQuantityChoice] = useState('20');
  const [controlBusy, setControlBusy] = useState(false);
  const [submissionKey, setSubmissionKey] = useState<string | null>(null);
  const [locations, setLocations] = useState<LocationOptions | null>(null);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [locationsError, setLocationsError] = useState('');
  const [locationAttempt, setLocationAttempt] = useState(0);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('发起任务');
  const [history, setHistory] = useState<AcquisitionJob[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const loadStatus = () => {
    setStatusError('');
    acquisitionApi
      .status()
      .then(setStatus)
      .catch((error) => setStatusError(error.message || '服务端连接失败'));
  };
  useEffect(() => {
    loadStatus();
    acquisitionApi
      .jobs()
      .then((data) => {
        const latest =
          data.jobs.find((j) => ['running', 'stopping', 'paused'].includes(j.status)) ||
          data.jobs[0];
        if (latest) {
          setJob(latest);
          if (['running', 'stopping', 'paused'].includes(latest.status)) {
            setInput(latest.input);
            setTargetCount(latest.target);
            setQuantityChoice(
              [5, 10, 20, 50, 100, 200].includes(latest.target) ? String(latest.target) : 'custom',
            );
          }
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!job || !['running', 'stopping'].includes(job.status)) return;
    const timer = setInterval(
      () =>
        acquisitionApi
          .job(job.id)
          .then(setJob)
          .catch((e) => setError(e.message)),
      5000,
    );
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  const taskActive =
    running || Boolean(job && ['running', 'stopping', 'paused'].includes(job.status));
  async function controlJob(action: 'stop' | 'resume') {
    if (!job || controlBusy) return;
    setControlBusy(true);
    setError('');
    try {
      setJob(await acquisitionApi.controlJob(job.id, action));
    } catch (e) {
      setError(e instanceof Error ? e.message : '任务操作失败');
    } finally {
      setControlBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLocationsLoading(true);
    setLocationsError('');
    acquisitionApi
      .locations(input.country, input.region, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setLocations(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLocationsError(error.message || '地区选项读取失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLocationsLoading(false);
      });
    return () => controller.abort();
  }, [input.country, input.region, locationAttempt]);
  const updateTarget = (changes: Partial<WorkflowInput>) => {
    setInput((current) => {
      const next = { ...current, ...changes };
      return { ...next, search_query: buildSearchQuery(next) };
    });
  };
  const patch = (key: keyof WorkflowInput, value: string) => {
    if (key === 'search_query') {
      setInput((current) => ({ ...current, search_query: value }));
    } else updateTarget({ [key]: value });
  };
  async function run() {
    if (running || (runMode === 'now' && taskActive) || !status?.configured) return;
    setRunning(true);
    setError('');
    try {
      const key = submissionKey || crypto.randomUUID();
      setSubmissionKey(key);
      if (runMode === 'scheduled') {
        await acquisitionApi.createSchedule(
          scheduleName.trim() || `${input.country} · ${input.product.split(',')[0]}`.slice(0, 80),
          input,
          targetCount,
          timing,
          key,
        );
        setSubmissionKey(null);
        notify('定时计划已保存，可在自动获客页面管理');
        navigate('/tasks');
        return;
      }
      const response = await acquisitionApi.createJob(input, targetCount, key);
      setJob(response);
      setSubmissionKey(null);
      notify('批量任务已开始，可离开页面后返回查看进度');
    } catch (error) {
      setError(error instanceof Error ? error.message : '调用失败，请检查服务端和任务记录');
    } finally {
      setRunning(false);
    }
  }
  async function loadHistory() {
    setLoadingHistory(true);
    setHistoryError('');
    try {
      const response = await acquisitionApi.jobs();
      setHistory(response.jobs);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '读取失败');
    } finally {
      setLoadingHistory(false);
    }
  }
  return (
    <>
      <PageHeading eyebrow="ACQUISITION TASKS" title="获客任务">
        {status?.provider === 'n8n' && (
          <ExternalLink href={WORKFLOW_URL}>查看 n8n 工作流</ExternalLink>
        )}
        <button className="btn secondary" onClick={loadStatus}>
          <RefreshCw size={15} />
          刷新连接
        </button>
      </PageHeading>
      <div className="automation-layout">
        <div className="automation-main">
          <section className="panel task-panel">
            <div className="lead-tabs">
              {['发起任务', '调用结果', '运行记录'].map((name) => (
                <button
                  key={name}
                  className={tab === name ? 'selected' : ''}
                  onClick={() => {
                    setTab(name);
                    if (name === '运行记录') void loadHistory();
                  }}
                >
                  {name}
                  {name === '调用结果' && job && <span className="status-dot" />}
                </button>
              ))}
            </div>
            {tab !== '发起任务' && error && (
              <div className="error-message" role="alert">
                {error}
              </div>
            )}
            {tab === '发起任务' ? (
              <form
                className="task-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run();
                }}
              >
                <fieldset className="run-mode-selector" disabled={running}>
                  <legend>执行方式</legend>
                  <label>
                    <input
                      type="radio"
                      name="run-mode"
                      value="now"
                      checked={runMode === 'now'}
                      onChange={() => setRunMode('now')}
                    />
                    立即获客
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="run-mode"
                      value="scheduled"
                      checked={runMode === 'scheduled'}
                      onChange={() => setRunMode('scheduled')}
                    />
                    定时自动获客
                  </label>
                </fieldset>
                <fieldset
                  className="form-grid target-fields"
                  disabled={running || (taskActive && runMode === 'now')}
                >
                  <label className="span-2 batch-quantity">
                    本次新增客户目标
                    <select
                      aria-label="本次新增客户目标"
                      value={quantityChoice}
                      onChange={(event) => {
                        setQuantityChoice(event.target.value);
                        if (event.target.value !== 'custom')
                          setTargetCount(Number(event.target.value));
                      }}
                    >
                      {[5, 10, 20, 50, 100, 200].map((n) => (
                        <option key={n} value={n}>
                          {n} 家
                        </option>
                      ))}
                      <option value="custom">自定义</option>
                    </select>
                    {quantityChoice === 'custom' && (
                      <input
                        aria-label="自定义客户数量"
                        type="number"
                        required
                        min={1}
                        max={200}
                        step={1}
                        value={Number.isNaN(targetCount) ? '' : targetCount}
                        onChange={(event) => setTargetCount(event.target.valueAsNumber)}
                      />
                    )}
                  </label>
                  <label>
                    目标国家
                    <select
                      aria-label="任务国家"
                      value={input.country}
                      onChange={(event) => {
                        updateTarget({
                          country: event.target.value,
                          region: '',
                        });
                      }}
                    >
                      {(
                        locations?.markets || [
                          { value: 'United States', label: '🇺🇸 美国 · United States' },
                          { value: 'Australia', label: '🇦🇺 澳大利亚 · Australia' },
                        ]
                      ).map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    州 / 地区
                    <select
                      aria-label="州 / 地区"
                      value={input.region}
                      disabled={
                        locationsLoading || Boolean(locationsError) || !locations?.regions.length
                      }
                      onChange={(event) => updateTarget({ region: event.target.value })}
                    >
                      <option value="">全部州 / 地区</option>
                      {(locations?.country === input.country ? locations.regions : []).map(
                        (region) => (
                          <option key={region.code} value={region.name}>
                            {region.label ||
                              (input.country === 'Australia' && region.code === 'WA'
                                ? '西澳大利亚州'
                                : input.country === 'United States' && region.code === 'WA'
                                  ? '华盛顿州'
                                  : regionNamesZh[region.code]) ||
                              '地区'}{' '}
                            · {region.name} ({region.code})
                          </option>
                        ),
                      )}
                    </select>
                    {locationsLoading && <small>正在读取地区选项…</small>}
                  </label>
                  <label className="span-2">
                    目标企业服务客群
                    <select
                      aria-label="目标企业服务客群"
                      value={input.audience}
                      onChange={(event) =>
                        updateTarget({ audience: event.target.value as WorkflowInput['audience'] })
                      }
                    >
                      <option value="BC">B+C · 不限客群</option>
                      <option value="B">B 端 · 面向企业 / 经销商</option>
                      <option value="C">C 端 · 面向家庭消费者</option>
                    </select>
                  </label>
                  <label>
                    客户类型
                    <select
                      aria-label="客户类型"
                      value={input.customer_type || ''}
                      onChange={(event) => updateTarget({ customer_type: event.target.value })}
                    >
                      <option value="">全部客户类型</option>
                      {customerTypes.map((type) => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    客户画像
                    <select
                      aria-label="客户画像"
                      value={input.customer_profile || 'all'}
                      onChange={(event) => updateTarget({ customer_profile: event.target.value })}
                    >
                      {profiles.map((profile) => (
                        <option key={profile.value} value={profile.value}>
                          {profile.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset className="product-selector span-2">
                    <legend>目标产品</legend>
                    <div className="product-group-grid">
                      {productGroups.map((group) => (
                        <section className="product-group" key={group.name}>
                          <h4>{group.name}</h4>
                          <div className="product-options">
                            {group.selectAll && (
                              <label
                                className={
                                  group.products.every(([value]) =>
                                    selectedProducts(input.product).includes(value),
                                  )
                                    ? 'selected'
                                    : ''
                                }
                              >
                                <input
                                  type="checkbox"
                                  aria-label={group.name + '全部'}
                                  checked={group.products.every(([value]) =>
                                    selectedProducts(input.product).includes(value),
                                  )}
                                  onChange={(event) => {
                                    const next = new Set(selectedProducts(input.product));
                                    group.products.forEach(([value]) =>
                                      event.target.checked ? next.add(value) : next.delete(value),
                                    );
                                    updateTarget({ product: [...next].join(', ') });
                                  }}
                                />
                                <span>全部</span>
                              </label>
                            )}
                            {group.products.map(([product, label]) => {
                              const checked = selectedProducts(input.product).includes(product);
                              return (
                                <label className={checked ? 'selected' : ''} key={product}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(event) => {
                                      const next = new Set(selectedProducts(input.product));
                                      if (event.target.checked) next.add(product);
                                      else next.delete(product);
                                      updateTarget({ product: [...next].join(', ') });
                                    }}
                                  />
                                  <span>
                                    {label}
                                    <small>{product}</small>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </section>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="acquisition-channels span-2">
                    <legend>获客渠道</legend>
                    <div className="channel-options" role="radiogroup" aria-label="获客渠道">
                      {acquisitionChannels.map((channel) => {
                        const Icon = channel.icon;
                        const selected = input.acquisition_channel === channel.id;
                        return (
                          <button
                            key={channel.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={`channel-option ${selected ? 'selected' : ''}`}
                            disabled={!channel.available}
                            onClick={() => {
                              if (channel.available)
                                updateTarget({ acquisition_channel: channel.id });
                            }}
                          >
                            <span className="channel-icon">
                              <Icon size={19} />
                            </span>
                            <span className="channel-copy">
                              <strong>{channel.name}</strong>
                            </span>
                            <span className="channel-state">
                              {selected ? (
                                <>
                                  <CheckCircle2 size={13} /> 当前渠道
                                </>
                              ) : (
                                '未接入'
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                  <label className="span-2">
                    搜索词
                    <textarea
                      aria-label="搜索词"
                      required
                      maxLength={500}
                      rows={2}
                      value={input.search_query}
                      onChange={(event) => patch('search_query', event.target.value)}
                    />
                  </label>
                </fieldset>
                {runMode === 'scheduled' && (
                  <fieldset className="form-grid schedule-fields" disabled={running}>
                    <legend>
                      <CalendarDays size={17} />
                      定时设置 · 北京时间
                    </legend>
                    <label className="span-2">
                      计划名称
                      <input
                        aria-label="计划名称"
                        maxLength={80}
                        value={scheduleName}
                        placeholder={`${input.country} · ${input.product.split(',')[0]}`}
                        onChange={(event) => setScheduleName(event.target.value)}
                      />
                    </label>
                    <label>
                      执行周期
                      <select
                        aria-label="执行周期"
                        value={timing.repeat}
                        onChange={(event) =>
                          setTiming((current) => ({
                            ...current,
                            repeat: event.target.value as ScheduleTiming['repeat'],
                          }))
                        }
                      >
                        <option value="once">指定日期（不重复）</option>
                        <option value="daily">每天</option>
                        <option value="weekly">每周（与开始日期同一天）</option>
                      </select>
                    </label>
                    <label>
                      开始日期
                      <input
                        aria-label="开始日期"
                        type="date"
                        required
                        value={timing.startDate}
                        min={new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)}
                        onChange={(event) =>
                          setTiming((current) => ({ ...current, startDate: event.target.value }))
                        }
                      />
                    </label>
                    <fieldset className="schedule-time-selector span-2">
                      <legend>执行时间</legend>
                      <div className="schedule-time-list">
                        {timing.times.map((value, index) => (
                          <div className="schedule-time-row" key={index}>
                            <label>
                              时间 {index + 1}
                              <input
                                aria-label={`执行时间 ${index + 1}（北京时间）`}
                                type="time"
                                step={60}
                                required
                                value={value}
                                onChange={(event) =>
                                  setTiming((current) => ({
                                    ...current,
                                    times: current.times.map((time, position) =>
                                      position === index ? event.target.value : time,
                                    ),
                                  }))
                                }
                              />
                            </label>
                            <button
                              type="button"
                              className="btn subtle"
                              aria-label={`删除执行时间 ${index + 1}`}
                              disabled={timing.times.length === 1}
                              onClick={() =>
                                setTiming((current) => ({
                                  ...current,
                                  times: current.times.filter((_, position) => position !== index),
                                }))
                              }
                            >
                              删除
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={timing.times.length >= 24}
                        onClick={() =>
                          setTiming((current) => {
                            const [hours, minutes] = (current.times.at(-1) || '08:00')
                              .split(':')
                              .map(Number);
                            let next = '09:00';
                            for (let offset = 1; offset <= 24; offset++) {
                              const candidate = `${String((hours + offset) % 24).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
                              if (!current.times.includes(candidate)) {
                                next = candidate;
                                break;
                              }
                            }
                            return { ...current, times: [...current.times, next] };
                          })
                        }
                      >
                        添加执行时间
                      </button>
                      <small>最多 24 个时间点</small>
                    </fieldset>
                    <p className="muted span-2">
                      本机服务需持续运行；任务冲突时顺序排队，暂停期间不补跑。
                    </p>
                  </fieldset>
                )}
                {locationsError && (
                  <div className="error-message" role="alert">
                    {locationsError}{' '}
                    <button
                      className="btn subtle"
                      type="button"
                      onClick={() => setLocationAttempt((value) => value + 1)}
                    >
                      重新读取地区
                    </button>
                  </div>
                )}
                {(statusError || !status?.configured) && (
                  <div className="connection-notice">
                    <KeyRound size={18} />
                    <div>
                      <strong>{statusError ? 'API 服务未连接' : '请先配置 API 连接'}</strong>
                      {statusError && <p>{statusError}</p>}
                      <Link className="text-link" to="/settings">
                        填写 API 连接配置
                      </Link>
                    </div>
                  </div>
                )}
                {error && (
                  <div className="error-message" role="alert">
                    {error}
                  </div>
                )}
                {runMode === 'now' && job?.status === 'completed' && (
                  <div className="success-message">
                    <CheckCircle2 size={17} />
                    <span>客户入库结果已核实。</span>
                    <button type="button" onClick={() => setTab('调用结果')}>
                      查看结果
                      <ArrowRight size={13} />
                    </button>
                  </div>
                )}
                <div className="task-form-footer">
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={
                      !status?.configured ||
                      running ||
                      (runMode === 'now' && taskActive) ||
                      locationsLoading ||
                      Boolean(locationsError)
                    }
                  >
                    {running ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : runMode === 'scheduled' ? (
                      <CalendarDays size={15} />
                    ) : (
                      <Play size={15} />
                    )}{' '}
                    {running ? '正在提交…' : runMode === 'scheduled' ? '保存定时计划' : '开始获客'}
                  </button>
                </div>
              </form>
            ) : tab === '调用结果' ? (
              <div className="result-pane">
                {job ? (
                  <>
                    <BatchProgress
                      job={job}
                      control={(action) => void controlJob(action)}
                      busy={controlBusy}
                    />
                    <button
                      className="btn secondary"
                      onClick={() => {
                        const url = URL.createObjectURL(
                          new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' }),
                        );
                        const anchor = document.createElement('a');
                        anchor.href = url;
                        anchor.download = `acquisition-${job.id}.json`;
                        anchor.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      <ArrowDownToLine size={14} />
                      导出任务结果
                    </button>
                  </>
                ) : (
                  <div className="empty-state">
                    <Workflow size={28} />
                    <h3>暂无任务结果</h3>
                  </div>
                )}
              </div>
            ) : tab === '运行记录' ? (
              <div className="history-pane">
                <SectionTitle
                  title="批量收录记录"
                  action={
                    <button
                      className="btn subtle"
                      onClick={() => void loadHistory()}
                      disabled={loadingHistory}
                    >
                      <RefreshCw size={14} className={loadingHistory ? 'spin' : ''} />
                      刷新
                    </button>
                  }
                />
                {historyError ? (
                  <div className="connection-notice">
                    <KeyRound size={17} />
                    <p>{historyError}</p>
                  </div>
                ) : history.length ? (
                  <table className="lead-table">
                    <thead>
                      <tr>
                        <th>执行编号</th>
                        <th>状态</th>
                        <th>开始时间</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((row) => (
                        <tr key={row.id}>
                          <td>#{row.id}</td>
                          <td>
                            <Badge tone={row.status === 'completed' ? 'green' : 'neutral'}>
                              {
                                {
                                  running: '正在收录',
                                  stopping: '正在停止',
                                  paused: '已暂停',
                                  completed: '已完成',
                                  partial: '部分完成',
                                }[row.status]
                              }{' '}
                              · {row.inserted}/{row.target}
                            </Badge>
                          </td>
                          <td>{new Date(row.createdAt).toLocaleString('zh-CN')}</td>
                          <td>
                            <button
                              className="text-link"
                              disabled={taskActive && row.id !== job?.id}
                              onClick={() => {
                                setJob(row);
                                setTab('调用结果');
                              }}
                            >
                              详情
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="empty-state">
                    <Workflow size={28} />
                    <h3>{loadingHistory ? '正在读取…' : '暂无执行记录'}</h3>
                  </div>
                )}
                {status?.provider !== 'native' && (
                  <ExternalLink href={WORKFLOW_URL}>在 n8n 查看</ExternalLink>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}
