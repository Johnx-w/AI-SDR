# 采集开发验证

适用对象是已发现的候选官网。直接读取缺少必要页面内容时，可以在独立浏览器渲染后从同一站点补取。每次试验保留请求和最终 URL、时间、采集方式、状态、触发原因、渲染原文、未渲染原文和内容摘要。链接与网页文字作为待核验输入，主体、经营事实及新增归属仍由获客流程核对。

## 开发环境与复跑

- Windows 实测和 Linux CI 使用 Python 3.12.16，依赖锁在 [requirements.txt](../../server/scrapling/requirements.txt)。Scrapling 0.5.1 负责 DOM 解析。Playwright 1.65.2 选用它的 Chrome Headless Shell 159.0.8154.6（修订 1255）。Playwright 标注的 Linux 支持范围包括 Ubuntu 22.04。[系统要求](https://playwright.dev/python/docs/intro#system-requirements)
- 先建独立虚拟环境，再按锁定文件安装。Windows 用虚拟环境的 `Scripts/python.exe`，Linux 用 `bin/python`。Linux 在隔离验证机执行下面的 `--with-deps` 安装步骤并检查实际系统包，浏览器以非 root 用户和 Chromium 沙箱启动。

```sh
python3.12 -m venv .codex-tmp/scrapling-venv
.codex-tmp/scrapling-venv/bin/python -m pip install -r server/scrapling/requirements.txt
export SCRAPLING_PYTHON="$PWD/.codex-tmp/scrapling-venv/bin/python"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.codex-tmp/browsers"
"$SCRAPLING_PYTHON" -m playwright install --with-deps --only-shell chromium
node --test tests/scrapling-collector.test.mjs tests/acquisition-evidence-selection.test.mjs
```

Windows 用同一个 Playwright 命令并省去 `--with-deps`。本地安装的 Windows 浏览器来自 [Chrome for Testing 官方存储](https://storage.googleapis.com/chrome-for-testing-public/159.0.8154.6/win64/chrome-headless-shell-win64.zip)，SHA-256 为 `5db6a6948e6d1299ea3bc87c420d467bf343feae186a316921c930ce02056af5`。Linux CI release 作业创建单独虚拟环境，运行安装、依赖检查、沙箱启动和固定页面检查。目标机的实际运行用户、系统依赖及正常业务负载仍需实测。没有随版本安装的运行时且未设置 `SCRAPLING_PYTHON` 时返回采集不可用。

正式打包从通过 CI 的同一次运行取得 Docling 和 Scrapling 运行时。采集包随发布携带内置 Python 的 PEX 工作进程和压缩的固定 Chromium。手工发布和 CD 均先检查合包小于 512 MiB。新版本在独立目录安装时，由运行用户解包并通过同一采集接口渲染固定页面，校验两种工具及浏览器和 Python 版本。系统共享依赖由目标机提供，缺依赖或沙箱启动失败会在切换前暴露。旧版本回退使用自己的发布目录和运行时。开发环境可指定 `SCRAPLING_PYTHON`，带离线包的 Linux 发布目录默认使用随版本交付的运行时。暂存安装的离线包探测输出 `archive_only`，用于核对包、依赖及沙箱；生产资源隔离另在受委托单元中核对。

### Ubuntu 26.04 浏览器沙箱

目标机已读回 Ubuntu 26.04、AppArmor 启用及 `kernel.apparmor_restrict_unprivileged_userns=1`。以 `shadeflow` 运行的普通 `unshare -Ur true` 被拒绝。浏览器保持 Chromium 沙箱启用，由管理员通过 AppArmor 只授权锁定二进制使用用户命名空间。[Ubuntu AppArmor 策略说明](https://canonical.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces) · [Chromium 沙箱说明](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)

从相同 CI 的 `scrapling-runtime` 提取完整的 `chromium_headless_shell-1255` 版本目录，安装至 `/opt/shadeflow/chromium`。路径、二进制及随附库和其他资源由 root 所有，且无组或其他用户写权限。可将版本目录限制为 `root:shadeflow` 的 `0750`。AppArmor 仅匹配以下实际可执行文件的绝对路径。发布目录由应用账号持有，AppArmor 权限不随发布目录或 `current` 的路径变化。

```text
abi <abi/4.0>,
include <tunables/global>
profile shadeflow-chromium-1255 /opt/shadeflow/chromium/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell flags=(default_allow) {
  userns,
}
```

管理员确认根目录和完整树权限、当前版本及共享库后单独加载该 profile，保持全局命名空间策略不变。Ubuntu 26.04 的依赖按 Playwright 1.65.2 的发行版清单核对，使用 `ldd` 对照缺失库。部署前在独立暂存目录以服务账号执行 `node scripts/check-scrapling.mjs`。探测会逐文件比对该版本目录与当次发布包的 SHA-256，再渲染固定页面并报告所选目录。另用普通 `unshare -Ur true` 复查服务账号仍受全局限制。从 `systemctl show` 核对服务的 `RestrictNamespaces` 等设置，必要时在等效隔离环境启动同一离线探测。目标环境验收以实际沙箱启动和页面结果为准。

没有该系统目录的 CI 和开发环境可以使用包内浏览器。已配置该系统目录时，缺少当前修订或文件与发布包有差异会阻断安装。升级浏览器时另建受 root 管理的版本目录和精确路径 profile，回退期间保留仍可回退版本对应的目录和 profile。

每次只打开一个新页面和独立上下文。浏览器的网络请求由本机网关按允许的资源类型返回，网关只向校验后的同站公网 HTTPS 地址发 GET 请求，连接固定到已核验的 DNS 地址。拒绝跨域跳转、跨域资源、私网、图片、媒体、字体、额外页面和 WebSocket。跨站 CDN 托管的脚本可能影响渲染结果，记录为此路径仍缺证。直接请求和浏览器请求共用同一套 HTTPS 地址和代理校验。

直接读取与浏览器网关共用 gzip 正文解码，分别限制压缩和展开后的字节数。遇到损坏或未知编码时记录采集失败。澳大利亚 ONESOLOMON 实测在请求原文时仍返回声明为 gzip 的响应，解码后可以读取官网正文。

浏览器成功状态要求渲染后的页面有正文文本。对 `7baefea` 现场快照的字节回放显示，Cameron 和 Clearview 只渲染出页头，Empire 只出现标题和 Trustindex 评分组件。修复后这三份渲染快照均保持采集失败，原始 HTML 里的正文仍可识别，快照均保留。固定浏览器回归同时确认实际短正文仍可成功返回。

### 进程隔离和故障探测

采集在全局队列中一次派一个页面。系统可用内存低于 1 GiB 时等待。单页导航和等待约 20 秒，派入后的整次请求含启动最多 30 秒，随后等待进程树清理。本机 Windows 用 Job Object 回收后代，非委托的 Linux 开发按独立进程组回收后代。开发进程每 100 毫秒采样 Python 与子进程 RSS 之和及整机使用量，RSS 之和会重复计入共享页。

生产 Linux 要求 cgroup v2。管理员将 [单元片段](../../scripts/systemd/shadeflow-scrapling.conf) 安装为 `/etc/systemd/system/shadeflow.service.d/scrapling.conf` 并运行 `systemctl daemon-reload`，在标准发布的受控重启时生效。Node 应位于 `/system.slice/shadeflow.service/app`。采集请求在同级 `scrapling-worker` 下设置并读回 `memory.max=1073741824`、`memory.swap.max=0` 和 `memory.oom.group=1`。启动器在执行 Python 前加入该组，Chromium 后代继承同一限制。完成、崩溃、超时和取消都回收该组，并在释放队列前确认无活动进程。服务停止由 systemd 回收整个单元。无法建立该限制时记录 `worker_isolation_unavailable`，获客继续走原回退路径。内存超限依据内核计数归为 `memory_limit`，报告进程组峰值。采集状态和阶段原因用于补证和回退。

在 Ubuntu 26.04 目标机的独立暂存目录运行下面的固定页面探测。使用包中的工作进程和已核对的 Chromium，期待 `delegated`、1 GiB 上限和非零内存峰值。命令不接触业务库。

```sh
sudo systemd-run --unit=shadeflow-scrapling-probe --wait --collect --pipe \
  --uid=shadeflow --property=Delegate=memory --property=DelegateSubgroup=app \
  --property=OOMPolicy=continue --property=KillMode=control-group \
  --working-directory="$PWD" /usr/local/bin/node scripts/check-scrapling.mjs --require-isolation
```

同一个固定名的暂存单元可执行内核回归测试。按 [开发环境](#开发环境与复跑) 安装测试用 Python，先将上述命令的最后一行替换为下列参数。夹具读回 1 GiB 再将自己的测试叶组降至 32 MiB，由测试子进程触发真正的内核 OOM，检查父子进程、叶组清理与 Node 所在组。

```sh
  --working-directory="$PWD" --setenv=SCRAPLING_CGROUP_TEST=1 \
  --setenv=SCRAPLING_PYTHON="$SCRAPLING_PYTHON" /usr/local/bin/node --test \
  --test-name-pattern="Linux cgroup OOM" tests/scrapling-collector.test.mjs
```

## 固定快照

`tests/acquisition-evidence-selection.test.mjs` 从三个预标 HTML 比较相同的现有正文清理、预算及新证据选择。样本包含完整成品自产加工、自产与他牌经销并存、酒店定制、否定采购、用途否定及第三方展商归属。现有位置截取保留中部预标事实 0/10，新选择保留 10/10；三页均在每页 16,000 字符上限内并保留同一来源 URL。该组数据用于定位中部证据丢失。固定模型对同一输入的判断、入库与人工回读由正常任务入口验收。

`tests/scrapling-collector.test.mjs` 使用两家可区分的动态官网、一家空壳和控制请求演练采集，页面及子资源用固定替身供给，可在 CI 运行，无需目标站点。Windows 的锁定版本完成了两家渲染和空壳对照，进程退出后没有新增 `chrome-headless-shell.exe` PID。现场遇到有正文页面被慢脚本拖到超时，固定五个慢脚本的原场景从 `timeout` 修复为 `ok`，已显示的原文仍可读回。

## 现场配对入口

```sh
mkdir -p artifacts
node scripts/compare-acquisition-collectors.mjs samples.json artifacts/acquisition-pair-01
```

输入为 JSON 数组。每条包含 `market`、`group`、唯一官网 `url`，以及可选的预先独立标注原文 `facts`。同样 URL 两次运行 Node 直读和受限 Chromium 渲染，交叉顺序。试验目录保存原始样本、各次时延和结果、按 SHA-256 去重的压缩快照以及分组统计。采集器在每次写入后验证快照可以按该摘要回读。两次未渲染 HTML 哈希差异单独列为网页变化线索。文本匹配用于发现证据缺失，主体归属和采购判断仍需核查原文。

此入口测量单页采集和正文保留。完整业务路径的外部提取回退、模型费用、企业全文证据齐备率和主库新增由统一验收取得。四家合作校准单列。跨市场代表性和生产运行负载仍待验证。

## 2026-11-27 锁定版本初试

在 Windows x64、Node 24.22.2 上运行 `204cb71`。按[样本清单](collection-pilot.json)先从官网公开版本标注可逐字核对的事实，再执行现场采集。三家美国、三家澳大利亚企业各测同一页面；加拿大和美国各两家合作样本另列。每条路径各 20 次读取，共 40 次。合作样本只作经营模式校准。

| 样本          | Node 正文成功 | 强制浏览器正文成功 | Node 预标事实齐备 | 强制浏览器预标事实齐备 |
| ------------- | ------------: | -----------------: | ----------------: | ---------------------: |
| 美国 3 家     |           2/6 |                2/6 |               2/6 |                    2/6 |
| 澳大利亚 3 家 |           6/6 |                6/6 |               6/6 |                    4/6 |
| 合作 4 家     |           6/8 |                6/8 |               4/4 |                    2/4 |
| 合计          |         14/20 |              14/20 |             12/16 |                   8/16 |

预标事实齐备指一次读页保留该页的全部标注，分母只含有标注的页面读取。Clearview 和 Builders Supply 各两次保留于原始 HTML 的事实在渲染 DOM 中缺失，导致四次齐备指标下降。这两例支持直接读取后按缺口补抓和保留原始 HTML。The Shade Store、ShadeMonster FAQ 的浏览器路径返回阻断；Smart Shades Utah 两路均未得到正文。各路径分别有两个目标的重复原始 HTML 哈希发生变化，仍保留两次快照。

两路单页耗时中位数及 P95 分别为 Node 2.112／3.134 秒，强制浏览器 8.235／15.895 秒。采样所得 Python 和子进程 RSS 之和峰值约 532 MiB，最多 6 个进程；Windows 整机用量峰值 14.47 GiB。22 份按摘要去重的压缩快照共 1,178,907 字节，已由入口逐次按 SHA-256 回读校验。本地证据目录位于 `artifacts/collection-pilot-locked-20261127`，含原始样本、代码版本、逐次结果和快照。

样本来自静态页面及合作校准。扩大验证已覆盖美国和澳大利亚各 30 家，包含静态、前端框架标记及既往失败三层，并在修复后复跑四个诊断站点。现场单页验证只读取公开网页。完整业务路径的模型、外部提取及读回结果见统一验收。[扩大现场配对和修复复测](collection-field-results.md) · [统一验收记录](acceptance.md)
