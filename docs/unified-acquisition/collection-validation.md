# 采集开发验证

适用对象是已发现的候选官网。直接读取缺少必要页面内容时，可以在独立浏览器渲染后从同一站点补取。每次试验保留请求和最终 URL、时间、采集方式、状态、触发原因、渲染原文、未渲染原文和内容摘要。链接与网页文字作为待核验输入，主体、经营事实及新增归属仍由获客流程核对。

## 开发环境与复跑

- Python 3.12，依赖锁在 [requirements.txt](../../server/scrapling/requirements.txt)。Scrapling 0.5.1 负责 DOM 解析。Playwright 1.65.2 选用它的 Chrome Headless Shell 159.0.8154.6（修订 1255）。
- 先建独立虚拟环境，再按锁定文件安装。Windows 用虚拟环境的 `Scripts/python.exe`，Linux 用 `bin/python`。Linux 在隔离验证机执行下面的 `--with-deps` 安装步骤并检查实际系统包，浏览器以非 root 用户和 Chromium 沙箱启动。

```sh
python3.12 -m venv .codex-tmp/scrapling-venv
.codex-tmp/scrapling-venv/bin/python -m pip install -r server/scrapling/requirements.txt
export SCRAPLING_PYTHON="$PWD/.codex-tmp/scrapling-venv/bin/python"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.codex-tmp/browsers"
"$SCRAPLING_PYTHON" -m playwright install --with-deps --only-shell chromium
node --test tests/scrapling-collector.test.mjs tests/acquisition-evidence-selection.test.mjs
```

Windows 用同一个 Playwright 命令并省去 `--with-deps`。Linux 依赖安装和浏览器验证须在目标发行版和运行用户下复验。未配置 `SCRAPLING_PYTHON` 时返回采集不可用。

每次只打开一个新页面和独立上下文。浏览器的网络请求由本机网关按允许的资源类型返回，网关只向校验后的同站公网 HTTPS 地址发 GET 请求，连接固定到已核验的 DNS 地址。拒绝跨域跳转、跨域资源、私网、图片、媒体、字体、额外页面和 WebSocket。跨站 CDN 托管的脚本可能影响渲染结果，记录为此路径仍缺证。直接请求和浏览器请求共用同一套 HTTPS 地址和代理校验。

开发限制为 20 秒内页面导航和等待、30 秒采集硬超时、系统剩余内存 1 GiB 时停止派单。每 100 毫秒采样 Python 与子进程的 RSS 之和和整机内存使用量；RSS 之和会重复计入共享页。进程树 RSS 超过 1 GiB 时中断，Linux 的进程清理和目标机资源上限仍需实测。

## 固定快照

`tests/acquisition-evidence-selection.test.mjs` 从三个预标 HTML 比较相同的现有正文清理、预算及新证据选择。样本包含完整成品自产加工、自产与他牌经销并存、酒店定制、否定采购、用途否定及第三方展商归属。现有位置截取保留中部预标事实 0/10，新选择保留 10/10；三页均在每页 16,000 字符上限内并保留同一来源 URL。该组数据用于定位中部证据丢失。固定模型对同一输入的判断、入库与人工回读由正常任务入口验收。

`tests/scrapling-collector.test.mjs` 使用两家可区分的动态官网、一家空壳和控制请求演练采集，页面及子资源用固定替身供给，可在 CI 运行，无需目标站点。

## 现场配对入口

```sh
mkdir -p artifacts
node scripts/compare-acquisition-collectors.mjs samples.json artifacts/acquisition-pair-01
```

输入为 JSON 数组。每条包含 `market`、`group`、唯一官网 `url`，以及可选的预先独立标注原文 `facts`。同样 URL 两次运行 Node 直读和受限 Chromium 渲染，交叉顺序。试验目录保存原始样本、各次时延和结果、按 SHA-256 去重的压缩快照以及分组统计。采集器在每次写入后验证快照可以按该摘要回读。两次未渲染 HTML 哈希差异单独列为网页变化线索。文本匹配用于发现证据缺失，主体归属和采购判断仍需核查原文。

此入口测量单页采集和正文保留。完整业务路径的外部提取回退、模型费用、企业全文证据齐备率和主库新增由统一验收取得。四家合作校准单列。跨市场代表性和生产运行负载仍待验证。
