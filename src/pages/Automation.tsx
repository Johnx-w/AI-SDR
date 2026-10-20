import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Code2,
  Facebook,
  Globe2,
  Instagram,
  KeyRound,
  LoaderCircle,
  Linkedin,
  MapPinned,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { useWorkspace } from '../app/WorkspaceProvider';
import { Badge, ExternalLink, SectionTitle } from '../components/ui';
import { n8nApi, WORKFLOW_URL } from '../services/n8n';
import type { LocationOptions } from '../services/n8n';
import type { IntegrationStatus, WorkflowInput, WorkflowRun } from '../domain/types';

const acquisitionChannels = [
  {
    id: 'tavily_web',
    name: 'Tavily 网页搜索',
    detail: '搜索公开网页，提取企业官网并研究入库',
    icon: Globe2,
    available: true,
  },
  {
    id: 'google_web',
    name: 'Google 网页搜索获客',
    detail: 'Google 搜索结果采集',
    icon: Search,
    available: false,
  },
  {
    id: 'google_maps',
    name: 'Google 地图商家挖掘',
    detail: '按地区发现地图商家',
    icon: MapPinned,
    available: false,
  },
  {
    id: 'linkedin',
    name: 'LinkedIn 企业 & 决策人挖掘',
    detail: '企业主页与决策人线索',
    icon: Linkedin,
    available: false,
  },
  {
    id: 'facebook',
    name: 'Facebook 商家主页挖掘',
    detail: '公开商家主页与经营信息',
    icon: Facebook,
    available: false,
  },
  {
    id: 'instagram',
    name: 'Instagram 商家主页挖掘',
    detail: '公开商家账号与产品内容',
    icon: Instagram,
    available: false,
  },
  {
    id: 'local_directories',
    name: '各国本地行业黄页',
    detail: '各国行业目录与企业名录',
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
const productGroups = [
  { name: 'Blindselements · 户外遮阳', url: 'https://blindselements.com', products: [['outdoor zip screens', '防风帘 / 户外拉链帘'], ['pergolas', '凉亭'], ['awnings', '天幕 / 遮阳篷']] },
  { name: 'Sampling Worldwide · 样品与面料', url: 'https://samplingworldwide.com', products: [['sample books', '样品册'], ['window fabrics', '窗饰面料']] },
  { name: 'Duraroll Blinds · 窗帘配件', url: 'https://durarollblinds.com', products: [['headrails', '制头 / 上轨'], ['bottom rails', '制尾 / 下轨'], ['springs', '弹簧'], ['motors', '电机'], ['installation brackets', '安装码'], ['end plugs', '尾塞'], ['aluminum profiles', '铝材']] },
  { name: 'Decormax Group · 室内窗饰', url: 'https://decormaxgroup.com', products: [['Roman blinds', '罗马帘'], ['zebra blinds', '斑马帘'], ['cellular blinds', '蜂巢帘'], ['Venetian blinds', '百叶帘'], ['shutters', 'Shutter 百叶窗 / 板式百叶'], ['fabric curtains', '布艺帘']] },
] as const;
const selectedProducts = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
const defaultInput: WorkflowInput = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
  search_query: 'outdoor zip screens Florida USA',
};
const basicQuery = (input: WorkflowInput) =>
  [input.product.trim(), input.region, input.country].filter(Boolean).join(' ');
export function Automation() {
  const { notify } = useWorkspace();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [input, setInput] = useState<WorkflowInput>(defaultInput);
  const [running, setRunning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [queryGenerated, setQueryGenerated] = useState(false);
  const [locations, setLocations] = useState<LocationOptions | null>(null);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [locationsError, setLocationsError] = useState('');
  const [locationAttempt, setLocationAttempt] = useState(0);
  const [result, setResult] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('发起任务');
  const [history, setHistory] = useState<
    { id: string; status: string; startedAt: string; stoppedAt: string | null }[]
  >([]);
  const [historyError, setHistoryError] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const loadStatus = () => {
    setStatusError('');
    n8nApi
      .status()
      .then(setStatus)
      .catch((error) => setStatusError(error.message || '服务端连接失败'));
  };
  useEffect(() => {
    loadStatus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLocationsLoading(true);
    setLocationsError('');
    n8nApi
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
      return { ...next, search_query: basicQuery(next) };
    });
    setQueryGenerated(false);
    setQueryError('');
  };
  const patch = (key: keyof WorkflowInput, value: string) => {
    if (key === 'search_query') {
      setInput((current) => ({ ...current, search_query: value }));
      setQueryGenerated(false);
    } else updateTarget({ [key]: value });
  };
  async function searchQuery() {
    if (generating || running) return;
    setGenerating(true);
    setQueryError('');
    setQueryGenerated(false);
    try {
      const response = await n8nApi.searchQuery(input);
      setInput((current) => ({ ...current, search_query: response.search_query }));
      setQueryGenerated(true);
      notify('DeepSeek 已生成搜索词，可编辑后运行');
    } catch (error) {
      setQueryError(error instanceof Error ? error.message : '搜索词生成失败，请稍后重试');
    } finally {
      setGenerating(false);
    }
  }
  async function run() {
    if (running || generating || !status?.configured) return;
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const response = await n8nApi.run(input, crypto.randomUUID());
      setResult(response);
      setTab('调用结果');
      notify(response.summary.message);
    } catch (error) {
      setError(error instanceof Error ? error.message : '调用失败，请检查服务端和 n8n 执行记录');
    } finally {
      setRunning(false);
    }
  }
  async function loadHistory() {
    setLoadingHistory(true);
    setHistoryError('');
    try {
      const response = await n8nApi.executions();
      setHistory(response.data);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '读取失败');
    } finally {
      setLoadingHistory(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="AUTOMATION STUDIO"
        title="自动获客"
      >
        <ExternalLink href={WORKFLOW_URL}>查看 n8n 工作流</ExternalLink>
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
                  {name === '调用结果' && result && <span className="status-dot" />}
                </button>
              ))}
            </div>
            {tab === '发起任务' ? (
              <form
                className="task-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run();
                }}
              >
                <fieldset className="form-grid target-fields" disabled={running || generating}>
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
                      <option value="United States">🇺🇸 美国 · United States</option>
                      <option value="Australia">🇦🇺 澳大利亚 · Australia</option>
                    </select>
                  </label>
                  <label>
                    州 / 地区（可选 / State or territory, optional）
                    <select
                      aria-label="州 / 地区"
                      value={input.region}
                      disabled={locationsLoading || Boolean(locationsError)}
                      onChange={(event) => updateTarget({ region: event.target.value })}
                    >
                      <option value="">全部州 / 地区 · 全国范围 / All states · Nationwide</option>
                      {(locations?.country === input.country ? locations.regions : []).map(
                        (region) => (
                          <option key={region.code} value={region.name}>
                            {(input.country === 'Australia' && region.code === 'WA'
                              ? '西澳大利亚州'
                              : input.country === 'United States' && region.code === 'WA'
                                ? '华盛顿州'
                                : regionNamesZh[region.code]) || '地区'}{' '}
                            · {region.name} ({region.code})
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <fieldset className="product-selector span-2">
                    <legend>目标产品（可多选）</legend>
                    <div className="product-group-grid">
                      {productGroups.map((group) => (
                        <section className="product-group" key={group.name}>
                          <h4><a href={group.url} target="_blank" rel="noreferrer">{group.name}</a></h4>
                          <div className="product-options">
                            {group.products.map(([product, label]) => {
                              const checked = selectedProducts(input.product).includes(product);
                              return (
                                <label className={checked ? 'selected' : ''} key={product}>
                                  <input type="checkbox" checked={checked} onChange={(event) => {
                                    const next = new Set(selectedProducts(input.product));
                                    if (event.target.checked) next.add(product);
                                    else next.delete(product);
                                    updateTarget({ product: [...next].join(', ') });
                                  }} />
                                  <span>{label}<small>{product}</small></span>
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
                    <p className="channel-help">
                      当前已接入 Tavily 网页搜索。以下六个渠道接入后即可选择。
                    </p>
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
                            title={
                              channel.available
                                ? '当前 n8n 使用 Tavily，未直连 Google 搜索'
                                : '尚未接入，暂不可选择'
                            }
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
                              <small>{channel.detail}</small>
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
                  <div className="search-scope span-2" aria-live="polite">
                    <Globe2 size={15} />
                    <span>
                      搜索范围：
                      {input.region
                          ? `${input.region} 全州 / 全地区`
                          : `${input.country === 'United States' ? '美国' : '澳大利亚'}全国`}
                    </span>
                    {locationsLoading && <small>正在读取地区选项…</small>}
                  </div>
                  <label className="span-2">
                    <span className="label-with-action">
                      搜索词
                      <button
                        type="button"
                        aria-label="用 DeepSeek 生成搜索词"
                        onClick={() => void searchQuery()}
                        disabled={
                          generating ||
                          running ||
                          !input.product.trim() ||
                          locationsLoading ||
                          Boolean(locationsError)
                        }
                      >
                        {generating ? (
                          <LoaderCircle className="spin" size={12} />
                        ) : (
                          <Sparkles size={12} />
                        )}
                        {generating ? 'DeepSeek 正在生成…' : 'DeepSeek 生成搜索词'}
                      </button>
                    </span>
                    <textarea
                      aria-label="搜索词"
                      required
                      maxLength={500}
                      rows={2}
                      value={input.search_query}
                      onChange={(event) => patch('search_query', event.target.value)}
                    />
                    <small className="query-help" aria-live="polite">
                      {queryGenerated
                        ? 'DeepSeek 已生成 · 可继续编辑'
                        : '按当前产品与地理范围生成；通过所选渠道搜索，可编辑后运行。'}
                    </small>
                  </label>
                </fieldset>
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
                {queryError && (
                  <div className="error-message" role="alert">
                    {queryError}
                  </div>
                )}
                <div className="request-preview">
                  <span>
                    <Code2 size={14} />
                    请求预览
                  </span>
                  <code>POST /api/v1/integrations/n8n/runs</code>
                  <small>JSON 参数 · 服务端转发 · Header Auth</small>
                </div>
                {(statusError || !status?.configured) && (
                  <div className="connection-notice">
                    <KeyRound size={18} />
                    <div>
                      <strong>
                        {statusError ? '本地 API 服务未连接' : '先完成 n8n Webhook 接入'}
                      </strong>
                      <p>
                        {statusError ||
                          'Webhook 的认证、发布与本地启用尚未全部完成。完成接入配置后，即可从这里运行。'}
                      </p>
                    </div>
                  </div>
                )}
                {error && (
                  <div className="error-message" role="alert">
                    {error}
                  </div>
                )}
                {result && (
                  <div className="success-message">
                    <CheckCircle2 size={17} />
                    <span>n8n 已返回真实结果。</span>
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
                      generating ||
                      locationsLoading ||
                      Boolean(locationsError)
                    }
                  >
                    {running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{' '}
                    {running ? 'n8n 正在执行…' : '运行工作流'}
                  </button>
                </div>
              </form>
            ) : tab === '调用结果' ? (
              <div className="result-pane">
                {result ? (
                  <>
                    <div className="result-title">
                      <Badge tone={result.summary.outcome === 'completed' ? 'green' : 'orange'}>
                        {result.summary.outcome === 'completed'
                          ? '飞书写入完成'
                          : result.summary.outcome === 'partial'
                            ? '部分客户已写入'
                            : result.summary.outcome === 'no_new_candidates'
                              ? '没有新的候选客户'
                              : result.summary.outcome === 'review'
                                ? '需要人工查重'
                                : result.summary.outcome === 'failed'
                                  ? '本次未能完成入库'
                                  : '写入状态待核实'}
                      </Badge>
                      <span>{new Date(result.completedAt).toLocaleString('zh-CN')}</span>
                      <button
                        className="btn subtle"
                        onClick={() => {
                          const url = URL.createObjectURL(
                            new Blob([JSON.stringify(result, null, 2)], {
                              type: 'application/json',
                            }),
                          );
                          const anchor = document.createElement('a');
                          anchor.href = url;
                          anchor.download = `n8n-${result.requestId}.json`;
                          anchor.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        }}
                      >
                        <ArrowDownToLine size={14} />
                        导出结果
                      </button>
                    </div>
                    <div className="result-summary">
                      <div>
                        <strong>{result.summary.message}</strong>
                        {result.summary.inserted !== undefined && (
                          <p>
                            新增 {result.summary.inserted} · 更新 {result.summary.updated} · 失败{' '}
                            {result.summary.failed} · 待查重 {result.summary.review}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="result-actions">
                      <Link className="btn secondary" to="/leads?dataset=real">
                        查看飞书真实客户
                        <ArrowRight size={14} />
                      </Link>
                      {result.summary.executionId && (
                        <ExternalLink
                          href={`${WORKFLOW_URL}/executions/${encodeURIComponent(result.summary.executionId)}`}
                        >
                          查看本次执行
                        </ExternalLink>
                      )}
                    </div>
                    <p className="muted">请求编号：{result.requestId}</p>
                    <pre>{JSON.stringify(result.result, null, 2)}</pre>
                    <p className="muted">返回数据独立展示，不自动混入本地演示客户列表。</p>
                  </>
                ) : (
                  <div className="empty-state">
                    <Code2 size={34} />
                    <h3>等待第一次真实返回</h3>
                    <p>成功提交并收到 n8n 响应后，结果会显示在这里。</p>
                    <button className="btn secondary" onClick={() => setTab('发起任务')}>
                      返回任务表单
                      <ArrowRight size={14} />
                    </button>
                  </div>
                )}
              </div>
            ) : tab === '运行记录' ? (
              <div className="history-pane">
                <SectionTitle
                  title="n8n 运行记录"
                  subtitle="从 Public API 读取，不用 mock 记录替代真实日志。"
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
                            <Badge tone={row.status === 'success' ? 'green' : 'neutral'}>
                              {row.status}
                            </Badge>
                          </td>
                          <td>{new Date(row.startedAt).toLocaleString('zh-CN')}</td>
                          <td>
                            <ExternalLink
                              href={`https://vynox.app.n8n.cloud/workflow/EycE9OmaPkRFUDSq/executions/${encodeURIComponent(row.id)}`}
                              className="text-link"
                            >
                              详情
                            </ExternalLink>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="empty-state">
                    <Workflow size={28} />
                    <h3>{loadingHistory ? '正在读取…' : '暂无执行记录'}</h3>
                    <p>也可以在 n8n 的 Executions 页面查看历史。</p>
                  </div>
                )}
                <ExternalLink href={WORKFLOW_URL}>在 n8n 查看</ExternalLink>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}
