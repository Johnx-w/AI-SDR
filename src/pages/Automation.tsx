import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Code2,
  Database,
  FileText,
  Globe2,
  KeyRound,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { useWorkspace } from '../app/WorkspaceProvider';
import { Badge, ExternalLink, SectionTitle } from '../components/ui';
import { workflowStages } from '../data/workflow';
import { n8nApi, WORKFLOW_URL } from '../services/n8n';
import type { LocationOptions } from '../services/n8n';
import type { IntegrationStatus, WorkflowInput, WorkflowRun } from '../domain/types';

const stageIcons = [Settings2, Search, FileText, Sparkles, Database];
const defaultInput: WorkflowInput = {
  country: 'United States',
  region: 'Florida',
  city: 'Miami',
  product: 'outdoor zip screens',
  customer_types: ['installer', 'distributor'],
  search_query: 'outdoor zip screens Miami Florida USA',
};
const basicQuery = (input: WorkflowInput) =>
  [input.product.trim(), ...input.customer_types, input.city, input.region, input.country]
    .filter(Boolean)
    .join(' ');
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
  const [stage, setStage] = useState('discover');
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
  const activeStage = workflowStages.find((item) => item.id === stage)!;
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
        title="从一个目标，到完整获客闭环。"
        description="在这里提交业务参数，让 n8n 编排搜索、研究与客户入库。"
      >
        <ExternalLink href={WORKFLOW_URL}>查看 n8n 工作流</ExternalLink>
        <button className="btn secondary" onClick={loadStatus}>
          <RefreshCw size={15} />
          刷新连接
        </button>
      </PageHeading>
      <section className="workflow-hero">
        <div className="workflow-hero-logo">
          <Workflow size={30} />
        </div>
        <div>
          <div className="workflow-hero-eyebrow">
            YOUR CONNECTED WORKFLOW <span>n8n</span>
          </div>
          <h2>窗饰自动获客最小流程</h2>
          <p>
            Tavily Search / Extract<span>→</span>Dify Workflow<span>→</span>飞书客户库
          </p>
        </div>
        <div className="workflow-hero-status">
          <Badge tone={status?.configured ? 'green' : 'amber'}>
            <CircleDot size={12} />
            {status?.configured ? 'API 已配置，待运行验证' : '等待 Webhook 接入'}
          </Badge>
          <small>EycE9OmaPkRFUDSq</small>
        </div>
      </section>
      <div className="automation-layout">
        <div className="automation-main">
          <section className="panel workflow-panel">
            <SectionTitle
              title="你的业务流程"
              subtitle="依据指定工作流核对的结构概览 · 非实时执行状态"
              action={<Badge>5 个业务阶段</Badge>}
            />
            <div className="workflow-stages">
              {workflowStages.map((item, index) => {
                const Icon = stageIcons[index];
                return (
                  <div className="workflow-stage-wrap" key={item.id}>
                    <button
                      className={`workflow-stage ${stage === item.id ? 'selected' : ''}`}
                      onClick={() => setStage(item.id)}
                    >
                      <span className="stage-index">0{index + 1}</span>
                      <Icon size={23} />
                      <strong>{item.title}</strong>
                      <small>{item.en}</small>
                    </button>
                    {index < workflowStages.length - 1 && (
                      <ChevronRight className="workflow-arrow" size={17} />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="stage-description">
              <span className="stage-description-icon">
                <Workflow size={18} />
              </span>
              <div>
                <h4>{activeStage.title}</h4>
                <p>{activeStage.description}</p>
                <div className="node-chips">
                  {activeStage.nodes.map((node) => (
                    <span key={node}>{node}</span>
                  ))}
                </div>
              </div>
            </div>
          </section>
          <section className="panel task-panel">
            <div className="lead-tabs">
              {['发起任务', '调用结果', '运行记录', '接入说明'].map((name) => (
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
                <div className="task-form-title">
                  <span className="step-number">01</span>
                  <div>
                    <h3>定义这次想找的客户</h3>
                    <p>输入会按原工作流的字段格式发送到 n8n。</p>
                  </div>
                  <Badge>真实 API</Badge>
                </div>
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
                          city: '',
                        });
                      }}
                    >
                      <option value="United States">🇺🇸 美国 · United States</option>
                      <option value="Australia">🇦🇺 澳大利亚 · Australia</option>
                    </select>
                  </label>
                  <label>
                    州 / 地区（可选）
                    <select
                      aria-label="州 / 地区"
                      value={input.region}
                      disabled={locationsLoading || Boolean(locationsError)}
                      onChange={(event) => updateTarget({ region: event.target.value, city: '' })}
                    >
                      <option value="">全部州 / 地区 · 全国范围</option>
                      {(locations?.country === input.country ? locations.regions : []).map(
                        (region) => (
                          <option key={region.code} value={region.name}>
                            {region.name} · {region.code}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    城市（可选）
                    <select
                      aria-label="城市"
                      value={input.city}
                      disabled={!input.region || locationsLoading || Boolean(locationsError)}
                      onChange={(event) => patch('city', event.target.value)}
                    >
                      <option value="">
                        {!input.region ? '请先选择州 / 地区' : '全部城市 · 全州范围'}
                      </option>
                      {(locations?.country === input.country && locations.region === input.region
                        ? locations.cities
                        : []
                      ).map((city) => (
                        <option key={city} value={city}>
                          {city}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    目标产品
                    <input
                      required
                      maxLength={200}
                      value={input.product}
                      onChange={(event) => patch('product', event.target.value)}
                    />
                  </label>
                  <fieldset className="customer-types span-2">
                    <legend>目标客户类型</legend>
                    {[
                      { id: 'installer', name: '安装商' },
                      { id: 'distributor', name: '经销商' },
                      { id: 'retailer', name: '零售商' },
                      { id: 'contractor', name: '工程商' },
                    ].map((item) => (
                      <label
                        key={item.id}
                        className={input.customer_types.includes(item.id) ? 'selected' : ''}
                      >
                        <input
                          type="checkbox"
                          checked={input.customer_types.includes(item.id)}
                          onChange={(event) =>
                            updateTarget({
                              customer_types: event.target.checked
                                ? [...input.customer_types, item.id]
                                : input.customer_types.filter((id) => id !== item.id),
                            })
                          }
                        />
                        {item.name}
                      </label>
                    ))}
                  </fieldset>
                  <div className="search-scope span-2" aria-live="polite">
                    <Globe2 size={15} />
                    <span>
                      搜索范围：
                      {input.city
                        ? `${input.city} · ${input.region}`
                        : input.region
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
                          !input.customer_types.length ||
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
                        : '按当前产品、客群与地理范围生成，可编辑后运行。'}
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
                      <button type="button" onClick={() => setTab('接入说明')}>
                        查看接入步骤
                        <ArrowRight size={13} />
                      </button>
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
                  <p>
                    <ShieldCheck size={14} />
                    真实调用会运行搜索并按原逻辑写入飞书。
                  </p>
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={
                      !status?.configured ||
                      running ||
                      generating ||
                      locationsLoading ||
                      Boolean(locationsError) ||
                      input.customer_types.length === 0
                    }
                  >
                    {running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{' '}
                    {running ? 'n8n 正在执行…' : '运行真实工作流'}
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
            ) : (
              <div className="setup-pane">
                <SectionTitle
                  title="把工作流作为 API 提供给业务软件"
                  subtitle="前端只提交业务字段，所有调用凭证留在服务端。"
                />
                <div className="api-chain">
                  <span>网页表单</span>
                  <ArrowRight size={17} />
                  <span>本地服务端</span>
                  <ArrowRight size={17} />
                  <span>n8n Webhook</span>
                  <ArrowRight size={17} />
                  <span>JSON 结果</span>
                </div>
                <ol className="setup-steps">
                  <li>
                    <b>1</b>
                    <div>
                      <h4>为原流程添加 POST Webhook</h4>
                      <p>
                        选择 Header Auth，认证头名称为 <code>X-Shadeflow-Key</code>；响应模式选 When
                        Last Node Finishes。
                      </p>
                    </div>
                  </li>
                  <li>
                    <b>2</b>
                    <div>
                      <h4>让“配置搜索目标”读取请求体</h4>
                      <p>
                        JSON 参数改为表达式，读取 <code>$json.body</code>{' '}
                        的六个业务字段，同时保留手动触发时的默认值。具体表达式见项目文档。
                      </p>
                    </div>
                  </li>
                  <li>
                    <b>3</b>
                    <div>
                      <h4>发布工作流，配置本地 .env</h4>
                      <p>
                        填入生产 <code>N8N_WEBHOOK_URL</code> 和 <code>N8N_WEBHOOK_SECRET</code>
                        ，重启本地服务。测试链接不适合作为长期入口。
                      </p>
                    </div>
                  </li>
                  <li>
                    <b>4</b>
                    <div>
                      <h4>从网页发起一次小规模验证</h4>
                      <p>
                        核对搜索结果和飞书写入。若调用超时，先核对 n8n
                        历史，避免重新执行产生重复操作。
                      </p>
                    </div>
                  </li>
                </ol>
                <div className="info-callout">
                  <ShieldCheck size={18} />
                  <p>
                    Codex MCP OAuth 已连接的是开发工具；本网页使用独立 Webhook
                    凭证。读取历史记录另需可选的 Public API key。
                  </p>
                </div>
                <ExternalLink href="https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/">
                  n8n 官方 Webhook 文档
                </ExternalLink>
              </div>
            )}
          </section>
        </div>
        <aside className="automation-aside">
          <section className="panel integration-summary">
            <SectionTitle title="连接概览" />
            <div className="integration-summary-row">
              <span>工作流</span>
              <Badge tone="green">已指定真实流程</Badge>
            </div>
            <div className="integration-summary-row">
              <span>调用方式</span>
              <strong>POST Webhook</strong>
            </div>
            <div className="integration-summary-row">
              <span>认证</span>
              <strong>Header Auth</strong>
            </div>
            <div className="integration-summary-row">
              <span>运行配置</span>
              <Badge tone={status?.configured ? 'green' : 'amber'}>
                {status?.configured ? '已配置' : '待接入'}
              </Badge>
            </div>
            <div className="integration-summary-row">
              <span>真实联调</span>
              <strong>{result ? '已收到响应' : '待验证'}</strong>
            </div>
            <div className="summary-note">
              <KeyRound size={15} />
              <p>密钥只在本机服务端读取，浏览器中不包含 n8n API key。</p>
            </div>
          </section>
          <section className="panel automation-guide">
            <span className="guide-icon">
              <Globe2 size={21} />
            </span>
            <h3>输入目标，交给流程。</h3>
            <p>你负责选择市场和客户，n8n 负责把搜索、研究与数据同步串起来。</p>
            <ul>
              <li>
                <Check size={13} />
                复用现有 Tavily 与 Dify 节点
              </li>
              <li>
                <Check size={13} />
                沿用飞书去重与写入逻辑
              </li>
              <li>
                <Check size={13} />
                网页内查看结构化返回结果
              </li>
            </ul>
            <button className="text-link" onClick={() => setTab('接入说明')}>
              了解接入方式
              <ArrowRight size={13} />
            </button>
          </section>
          <div className="aside-note">
            <ShieldCheck size={15} />
            <span>客户、计划和收件箱使用演示数据。这里的任务提交接向真实 n8n。</span>
          </div>
        </aside>
      </div>
    </>
  );
}
