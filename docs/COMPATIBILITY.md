# 环境要求与兼容矩阵（docs/COMPATIBILITY.md）

> 适用版本：**dsh-drydock 1.0.4**。口径以 `package.json` 的 `version`、`engines.node`、`engines.dsh` 为准；本文是便于阅读的说明。

## 一、环境要求

- **平台**：Windows 10/11 · macOS · Linux（`/rescue` 与三个 bin 工具全平台可用；**开机自启管理目前为 Windows**，macOS / Linux 请用 `--supervise` 配合 systemd / launchd）。
- **Node.js**：`engines.node` 声明 **`>=18.0.0`**（本版**未收紧**，收紧排在 1.1.x）。但 Node 18 已 EOL、pnpm 11 也不再支持 18/20/21，**实际请在 Node 22 LTS 或更新上运行**。
- **DeepSeek Harness**：`dsh`（全局安装或 npx），引擎版本要求见下方矩阵。
- **pnpm**：`dsh plugin` 与更新功能依赖 pnpm（`dsh plugin add` 底层即 pnpm）。
- **本地回环端口**（均只监听 `127.0.0.1`）：

| 端口 | 归属 | 可覆盖 |
| --- | --- | --- |
| 3080 | 引擎主界面（`dsh web`） | `DSH_ENGINE_PORT` |
| 3081 | 启动器 open-boot：启动页 `/` · 兜底页 `/plugins` · 救援页 `/rescue` | `DSH_LAUNCHER_PORT` |
| 3082 | 备份救援守护（`npx dsh-drydock-rescue`） | `--port` |
| 4081 | 守护单实例锁（= 3081 + 1000） | 随 3081 推导 |

端口被别的进程占用时工具**明确报错、不静默换端口**；`--status` 会报告占用者 pid。

## 二、引擎兼容矩阵（引擎 × 管理器）

| 你的 DSH 引擎 | 本管理器版本 | 说明 |
| --- | --- | --- |
| **≥ 0.1.7-rc.2**（含 0.2.x，`<0.3.0-0`） | **1.0.4**（推荐）／ 1.0.3 / 1.0.2 / 1.0.1 / 1.0.0 | 独立插件页 + 兜底页 + 救援工具链全套；1.0.x 实测于 0.2.x 引擎（三分区 / 统一口径 / 事务卸载，隔离环境 + 主环境双验证） |
| 0.1.6 及以后 | **1.0.4** | 官方 0.1.6 起内置插件管理页，本包接管（停用 `ui-plugin-manager` + 用自己的行 id `drydock`）；0.1.6-alpha.x 未单独实测 |
| **0.1.7-rc.2 之前**（0.1.0-rc.6 ~ 0.1.5） | **不支持** | 1.0.x 的 `engines.dsh` 下界就是 `0.1.7-rc.2`；旧引擎请留在旧包名的历史版本（该包已挂弃用提示，包未删除） |

> **一句话**：引擎 ≥ 0.1.7-rc.2 用 1.0.4。1.0.x 之间回退同一包名：`dsh plugin --profile web add dsh-drydock@1.0.3`。

- `engines.dsh` = `>=0.1.7-rc.2 <0.3.0-0`（`package.json`）。
- 「已实测」记录来自彩排环境、干净环境装机报告与真机安装存档（`docs/releases/0.9.0-verify.md` 等）；开发工作区的 `upgrade-rehearsal/`、`audit/install-090/` 不进 npm 包。
- 测试数量的口径以 `node test-launcher.mjs --strict` 的输出为准（会随代码树变化，不在文档里写死数字）。

### 二之一、发布通道 × 宿主（2026-11-27 起）

同一个包、同一份产物，靠**运行期能力门控**适配不同宿主；通道只决定"从哪个 dist-tag 装"，不决定代码分支。口径见 [`版本与轨道.md`](版本与轨道.md)。

| 通道（dist-tag） | 宿主形态 | 状态 | 验证程度 |
| --- | --- | --- | --- |
| `latest` / `next` | 网页 / 引擎宿主（3080 + 3081 启动器） | ✅ 正式支持 | 真机 + 隔离环境 + CI 全量回归 |
| `desktop` | 官方桌面宿主（Windows / macOS，`dsh-app://app`） | ⚠️ 预发布通道 | **代码完成、真机未验收**（能力门控 / 离线诊断 / 救援 profile / CORS 均有测试，但未在真桌面运行时跑过完整链路） |
| `community` | 社区桌面发行版 | ⛔ **占位**（`enabled: false`） | 未定义形态；恢复前需先补宿主定义与核对表 |

**首启环境探测（1.1.0 起）**：装完第一次启动会把判定结果写进 `<DSH_HOME>/.drydock/host-profile.json`
（证据 + 能力表 id + TTL 30 天）。环境专属模块按能力表**惰性装载**，不适用的一律不 `import`；
`npx dsh-drydock-modules --audit` 打印"本环境永远不会执行的文件 + 行数"。
显式覆盖：`DSH_DRYDOCK_HOST=web|desktop`（测试/运维用）；关掉探测：`DSH_DRYDOCK_NO_HOST_PROBE=1`。
详见 [`环境自适应与剥离.md`](环境自适应与剥离.md)。

## 三、旧版本（0.9.1 之前）为什么不支持

- `dsh-plugin-manager-pro` 的 0.9.1 之前版本（含 `0.9.1-rc2`）**已淘汰**：存在已知供应链风险，且 Node < 22.14 加载即崩；npm 上已挂**强化弃用提示**（不删包，历史版本仍可安装，但不要用）。
- 升级路径：`dsh plugin --profile web remove dsh-plugin-manager-pro && dsh plugin --profile web add dsh-drydock@^1.0.4`，详见 [INSTALL.md](INSTALL.md) §10。
- 同一台机器上并存旧包与新包时，请只保留一个（旧包会与 1.0.x 抢同一个插件页入口）。

## 四、运行期依赖与体积

- 运行期依赖只有 **`yaml`** 与 **`zod`**（外加引擎提供的 `@deepseek-ai/*` peer，由 profile 的 pnpm 复用）。
- npm 包只含 `lib/*.js`、`lib/*.mjs`、`bin`、`cordis.patch.yml`、`README.md`、`LICENSE`；`docs/`、测试与开发脚本**不进包**。
- 构建产物 `lib/client.js` 由 `node build.mjs` 从 `src/client.jsx` 生成（可复现：连跑两次哈希相同）。

## 五、桌面 / 浏览器环境

- 管理台跟随 DSH 主题变量；3081 兜底页与救援页是自包含 HTML（内联脚本 / 样式），不依赖 CDN，离线可用。
- 浏览器主页设为 `http://127.0.0.1:3081/` 即「打开即启动」；`127.0.0.1` / `localhost` / `[::1]` 视为同源等价（端口必须一致）。
- 下载功能优先走浏览器原生下载（NDM 等下载扩展可捕获），其次外部下载器，最后内置下载器兜底。

## 六、升级引擎时的注意事项

1. 引擎升级会重装 `@deepseek-ai/*`，管理器本身不用动；升级后**重启一次 `dsh web`**。
2. 引擎跨大版本（如 0.2.x → 0.3.x）前先看 [releases/](releases/) 是否有对应说明；本包 1.0.x 的 `engines.dsh` 上界是 `<0.3.0-0`。
3. 升级前建议记一次 `npx dsh-drydock --status` 的输出（含最后一条 `health.log`），出问题时便于对比。
4. 引擎有内置插件管理器（≥0.1.6）；本包接管时靠 `cordis.patch.yml` 停用它。若引擎改了这个内部行 id，本包需要跟随发版——请先看发布说明再升级引擎。
