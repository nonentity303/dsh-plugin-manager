# dsh-plugin-manager-pro

> 本地插件管理器 —— 为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 提供**独立插件页**（可视化插件管理）+ **独立救砖工具链**。

![badge](https://img.shields.io/badge/dsh-0.1.7-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![version](https://img.shields.io/npm/v/dsh-plugin-manager-pro?color=orange) ![npm](https://img.shields.io/npm/dt/dsh-plugin-manager-pro)

> 社区/本地插件，非 DSH 官方包。npm：`dsh-plugin-manager-pro` · GitHub：[nonentity303/dsh-plugin-manager](https://github.com/nonentity303/dsh-plugin-manager) · 跨平台（Windows / macOS / Linux）
>
> **当前版本 0.9.0**，npm 与 GitHub Release 双通道分发（npm：`dsh-plugin-manager-pro`）。
> ⚠️ 刚发布的版本会被 pnpm 的 24 小时冷静期（`minimumReleaseAge`）挡住，装不到时请**显式写版本号**（见下文"安装"）。

---

## ✨ 亮点

- **独立插件页**（v0.9.0）：插件管理不再挤在设置页里，而是侧边栏一级入口「插件管理」——在一个页面里完成看插件、装插件、**配插件**、卸插件、救引擎，5 个分区：**官方内置（可选）· 全部插件 · 插件市场 · 操作与场景 · 维护**
- **第三方配置入口有落点**（v0.9.0）：接管内置插件页后，第三方插件注册的配置入口照样可用——插件行内显示一行摘要、展开即是它自己的完整配置卡片
- **事务化卸载**（v0.8）：卸载前**影响预览**（依赖它的插件/条目/开关行）→ 备份 → 删除 → 启动前自检 → **失败自动回滚**；卸载后可**一键撤销**
- **操作历史 + 场景方案**（v0.8）：最近 20 次操作留痕可撤销；把插件组合保存为命名场景，一键切换（应用前展示变更预览）
- **救砖能力彻底解耦**（v0.7+）：主引擎挂了，**独立守护服务（3081 端口）照样能自检、修复、拉起**——不再依赖主进程
- **浏览器即启动器**：把主页设为 `http://127.0.0.1:3081/`，打开浏览器 = 自动自检 → 修复 → 启动 → 跳转主界面
- **多源更新聚合**：npm registry / 插件超市 dshfind / GitHub / 自定义镜像并行查询，限流熔断，公平取最高版本

---

## 📋 功能总览（v0.9.0）

### 插件页（侧边栏「插件管理」）

页面按用途分成 5 个分区，切换分区不会丢滚动位置：

| 分区 | 内容 |
|---|---|
| **官方内置（可选）** | 引擎自带、默认未启用的组合包（一键启用/停用）+ 自带配置页的官方插件 + 版本豁免 |
| **全部插件** | 插件清单：搜索、分类折叠、来源筛选、启停开关、行内配置、行内卸载、版本与来源、来源人工修正 |
| **插件市场** | dshfind 精选目录（1160+ 插件、14 分类）一键安装，在线不可用自动兜底 GitHub 搜索 |
| **操作与场景** | 事务化卸载与影响预览、操作历史一键撤销、场景方案 |
| **维护** | 更新源与刷新、启动前自检、救援中心入口、下载目录 |

### 插件列表

- **分类折叠**：按必要程度收纳为 🔴 必须 / 🟡 推荐 / 🟢 可选 三组可折叠分组（头部显示启用计数与可更新角标，搜索自动展开）
- **来源分类**：区分**架构自带**（随 dsh 提供）与**用户安装**（`dsh plugin add` / 市场安装），顶部 chips 筛选 + 行徽标
- **来源人工修正**：自动判定来源标签（npm / GitHub / 本地 / 内置），每行可手动覆盖并持久化
- **状态一目了然**：启用状态（🔴 错误/需检查 · 🟡 需更新 · ⚪ 未启用 · 🟢 启用）、名称、功能简介、必要程度、已装→最新版本 + 来源、开关按键
- **简介自动提取**：内置中文目录优先；未收录的 mod 自动从 `README.zh.md`（优先）/ `package.json.description` / `README.md` 提取一句话简介
- **架构保护**：web 层刻意禁用的行（tool-fs 等）与界面骨架插件（ui-layout 等）禁止开关（🔒 标记 + 原因）
- **第三方配置卡片**（v0.9.0）：插件行内直接出现它的配置入口——第三方通过 `plugins.row.config`（行级）与 `plugins.bundle.config`（包级）注册的配置页都有真实落点；没注册配置的插件不会出现空按钮

### 🔐 事务化卸载、历史与场景

- **卸载影响预览**：卸载前展示「影响范围」——依赖该包的已安装插件（`dependencies` / `peerDependencies` 反向图）、将移除的插件条目、将清理的开关行、bundles 声明
- **事务化卸载**：备份 `package.json` + `cordis.patch.yml`（`.rescue-bak-*`）→ `pnpm remove` + 移除 bundles/开关行 → 启动前自检 → **任何失败自动回滚**（恢复备份 + 重装依赖）；Windows 文件锁残留目录登记 `pendingRemovals`，下次启动自动清理
- **卸载报告**：自检结果、清理开关行数、级联卸载包、残留列表；支持级联卸载依赖它的可卸载包
- **操作历史**：最近 20 次操作（卸载/启停/隔离/场景应用/重置开关），一键撤销，侧车持久化跨重启
- **场景方案**：把当前启停状态保存为命名场景（如「办公/写作/演示」），一键应用——先展示**变更预览**，确认后切换；可更新、删除
- **依赖安装提示**：市场安装后自动检测 `dependencies` / `peerDependencies`（可选 `dsh.recommendedDeps`）中缺失的包并提示

### 📥 更新与下载

- **多源并行 + 权重一致**：所有启用源并行查询取最高版本；并列时随机挑选
- **限流熔断**：GitHub API 403/429 自动冷却 10 分钟；全量刷新 8 并发（冷缓存约 13-20s，二次刷新命中 30 分钟缓存瞬时返回）
- **下载优先级**：① 浏览器原生下载（隐藏 iframe，NDM 等扩展可捕获）→ ② 外部下载软件 → ③ 内置下载器兜底（HTTP 直链 / aria2c / P2P magnet·torrent）
- **下载目录自动安装**：`.tgz` / `.tar.gz` 放入 `$DSH_HOME\downloads` → 自动拾取安装；**安装前做清单校验 + 启动前自检，失败自动回滚并标记 `.failed`（不再反复重试）**

### 🛒 插件市场

- **dshfind 精选目录**：awesome-dsh-plugin 官方收录池（1160+ 插件、14 分类、本地化描述/星标/收录日期），host 10 分钟缓存；在线不可用自动兜底 GitHub `topic:dsh-plugin` 搜索
- **零往返过滤**：目录一次拉全量，搜索 / 分类 chips / 排序 / 分页全部客户端本地完成
- **一键安装**：带 npm 名的条目优先 **npm registry 直装**；GitHub 仓库走内置下载器；两步确认防误触；已装 ✓ 徽标
- **装后防砖校验**：自动验证 `dsh.bundle` / `dsh.client` 清单，缺失自动卸载；pnpm hoist 漂移 / `minimumReleaseAge` 陷阱自动恢复

### 🛟 救砖

- **独立救援页 `/rescue`**：自包含 HTML 直连宿主网关，UI 全坏仍可诊断/隔离/一键修复/重启/卸载
- **浮动救援球**：右下角 🛟 按钮，设置页损坏时的入口
- **自动隔离**：可选开关（**默认关**），且只隔离**连续失败达阈值**的插件；界面骨架与基础设施条目在保护集内，永不自动禁用
- **启动前自检**：`verifyProfile` / `fixProfile`——坏 bundle 会在启动阶段拖垮引擎，管理器提供一键检查与隔离修复
- **运行期失败条目自动隔离**：插件与引擎不兼容时 loader 会拖垮整棵树启动（静态自检查不出来）——open-boot / rescue-daemon / dsh-boot 启动失败后自动**解析启动日志 → 隔离失败条目 → 重试**，隔离行带备份可逆

### 🧰 独立救砖工具链（核心亮点）

> 传统救砖页由主引擎注册——**主引擎挂了，救砖页也跟着瘫**。v0.7 起救砖能力独立于主进程运行，主引擎宕机依然可用。零新依赖（纯 Node + 项目已有 yaml）。

| 工具 | 用途 | 用法 |
|---|---|---|
| `bin/rescue-daemon.mjs` | **独立救砖守护**（默认端口 **3081**）：自包含中文救援页 + `verify/fix/start/stop/status` API，不依赖主引擎。`stop` 会先校验 PID 与端口归属（可用 `{"force":true}` 强制）。**与 open-boot 抢 3081 时直接报错退出**（不静默漂移） | `npx dsh-pm-rescue --port 3082` |
| `bin/open-boot.mjs` | **网页启动器 + 常驻守护**：打开 `http://127.0.0.1:3081/` → 自动 自检 → 修复 → 启动 → 跳转 3080。设为浏览器主页即"打开即启动"。**平时完全隐藏，只有引擎真的需要被拉起时才弹出一个可见的启动窗口显示进度**（`--no-window` 可关闭）。健康判定为 **HTTP 握手 + 身份指纹**；`--status` 可随时查启动器/守护/引擎状态 | `npx dsh-pm-launcher` |
| `bin/dsh-boot.mjs` / `.cmd` | **Steam 式启动序列**：verify → 自动隔离坏插件 → 启动 → 健康等待。`--repair-only` 供外部调用（**只自检+修复，不启动引擎**）；`--pause` 结束时等按键；`--help` 查看用法；退出码 0=就绪 / 1=启动失败 / 2=修复未完成。启动即失败（坏命令/端口冲突）会**立即返回**并把日志绝对路径打印出来 | `npx dsh-pm-boot` / `node bin/dsh-boot.mjs`（Windows 双击等价物：`bin\dsh-boot.cmd`） |

#### 启动器常驻与开机自启

| 命令 | 作用 |
|---|---|
| `npx dsh-pm-launcher --supervise [--interval 60] [--heartbeat-min 10]` | **常驻守护**：静默确保 3081 有服务；锁端口（`port+1000`）保证同机只有一个守护，重复启动会自行退出；**只有 HTTP 握手失败**才拉起，绝不误杀健康实例。守护会写「状态变化」「心跳」「退出」「未捕获异常」四类日志到 `profile/open-boot-supervisor.log`，重启时若发现上一次没有正常退出记录会明确提示 |
| `npx dsh-pm-launcher --ensure` | 一次性确保 3081（桌面快捷方式用，退出码 0/1） |
| `npx dsh-pm-launcher --status` | **状态自检**：启动器（HTTP 握手 + 身份）/ 守护（锁端口归属）/ 引擎（3080 HTTP 握手）/ PID 文件 / cwd / 日志与最后一次心跳；退出码 0=启动器健康。3081 被别的进程占用时会明确报出占用者 pid |
| `npx dsh-pm-launcher --install-autostart` | **写开机自启**（Windows）：HKCU Run + 生成 `open-boot-autostart.vbs`（登录静默常驻）与 `open-boot-ui.vbs`（确保 3081 后开浏览器）。包装脚本正文**纯 ASCII**（路径运行时由 `WScript.ScriptFullName` 自解析）并做回读校验，**中文用户名/含空格 profile 路径不会再乱码** |
| `npx dsh-pm-launcher --uninstall-autostart` / `--autostart-status` | 移除自启 / 查看状态（含包装脚本是否存在、守护是否存活、3081 上是不是本启动器） |
| `npx dsh-pm-launcher --help` / `npx dsh-pm-boot --help` | 显示用法（参数不再被静默忽略；无法识别的参数会告警） |

安装后三个命令由 `package.json` 的 `bin` 字段提供（`dsh-pm-launcher` / `dsh-pm-boot` / `dsh-pm-rescue`），也可用 `npx` 免装调用，或直接跑包内文件（路径与 cwd 无关）：

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-plugin-manager-pro/bin/open-boot.mjs" --status
```

开机自启（Windows）只由**包内** `--install-autostart` 写入 `HKCU\...\Run\DSHWebFront`；卸载插件后请执行 `npx dsh-pm-launcher --uninstall-autostart` 清理注册表项与 profile 内的 `open-boot-*.vbs`（否则自启项会指向已删除的包）。

- **公共模块**：`lib/preflight.mjs`（standalone 自检/修复，与 host 内 `verifyProfile/fixProfile` 同源）、`lib/enginectl.mjs`（引擎探测/拉起/停止/PID 管理）
- **故障排查**：引擎起不来 → ① 浏览器开 `http://127.0.0.1:3081/` →"运行检查 → 修复 → 启动"；② `npx dsh-pm-boot --repair-only` 看自检与隔离列表；③ `npx dsh-pm-launcher --status` 看启动器/守护/引擎各自的真实状态；④ 需要交互式启动时 `npx dsh-pm-boot`（Windows 也可双击 `bin\dsh-boot.cmd`，失败信息里会带引擎日志绝对路径）

> **健康判定与"停引擎"的安全性**：引擎/启动器就绪 = **HTTP 握手成功且响应带 dsh 身份指纹**（裸 TCP 监听器一律判不健康）。因此：3080 或 3081 被别的进程占用时，工具会**明确报错并拒绝把端口当"已就绪"**，也不会静默换端口。引擎 `stopEngine()` 前会做三重校验（pid 存活 / 进程镜像为 node·dsh / 端口占用者与记录 pid 一致），校验不过一律拒绝并在救援页给出原因，需要时可在救援页点"强制停止"（或 `POST /api/stop {"force":true}`）。PID 文件（`profile/.rescue-daemon.pid`）是 JSON，含 `app/pid/port/dshCmd/cwd/startedAt`。
>
> **工作目录**：引擎与启动器统一使用**稳定 cwd**（默认用户主目录，可用 `--cwd <dir>` 或环境变量 `DSH_ENGINE_CWD` 覆盖）。早期版本会把 cwd 落在 `node_modules/dsh-plugin-manager-pro/bin`，导致插件自我更新/卸载时目录被占用（`ERR_PNPM_EPERM`）。
>
> ⚠️ **实现注意**：自启包装脚本一律是「wscript → node」，**不使用隐藏 PowerShell**——`powershell -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden ..."` 这类形态会被部分杀软（如火绒的 AMSI 提供者）判定为恶意并**直接删除脚本文件**。同理，守护拉起服务进程时刻意**不加 `windowsHide`**：libuv 的 `windowsHide` 会被子进程继承，导致"拉起引擎时弹窗"也变成隐藏窗口。

---

## 环境要求

- Windows 10/11 · macOS · Linux（`/rescue` 与三个 bin 工具全平台可用；**开机自启管理 `--install-autostart` 目前为 Windows**，macOS/Linux 可用 `--supervise` 自行加入系统自启）
- Node.js ≥ 18 · DeepSeek Harness `dsh`（全局安装或 npx）· `pnpm`（`dsh plugin` 与更新功能依赖）
- **引擎版本决定你该装哪一版**（见下表）——**装错版本 = 插件页不出现、甚至 profile 起不来**

### 引擎版本 ↔ 插件版本对照

| 你的 DSH 引擎 | 装哪个版本 | 原因 |
|---|---|---|
| **0.1.6-alpha.2 及以上**（含 0.1.7-rc.2，本机实测） | **0.9.0**（推荐） | 官方在 0.1.6 起把插件管理升成侧边栏一级页并新增 `id: plugin-manager` 行；0.9.0 用 `cordis.patch.yml` 关掉内置页 + 声明同名子槽位的方式接管，已实测在 0.1.7-rc.2 上零告警 |
| **0.1.0-rc.6 ~ 0.1.5**（更早的引擎） | **0.8.2** | 0.8.x 走的是「设置 → 插件」里的设置页 tab 路线，按旧槽位开发 |
| 0.1.6 之前且已装 0.9.0 导致起不来 | 回退：`dsh plugin --profile web add dsh-plugin-manager-pro@0.8.2` | 见下文"安装"里的回退命令 |

> ⚠️ **反向不兼容已经实测确认**：0.8.2 的 `dsh.client.inject` 里有 `@deepseek-ai/dsh-client-runtime`，而 **0.1.7 的引擎已不带这个包**（继任者是 `dsh-client-ui-renderer`）——所以在 0.1.7 上装 0.8.2 会加载失败。
> 也就是说：**引擎越新越要 0.9.0；引擎很老才需要 0.8.2**。表里 0.1.6 这条分界线是唯一确定的那条，中间的 0.1.6-alpha.x 过渡版本未逐一实测。

## 安装

> **推荐从 npm 安装**（`dsh plugin … add` 底层是 pnpm，会自动用引擎自带的 `@deepseek-ai/*`）。

```sh
# 方式一（推荐，引擎 ≥ 0.1.6）：npm
dsh plugin --profile web add dsh-plugin-manager-pro

# 方式二：刚发版时（或在 24 小时冷静期内）——显式写版本号，最可靠
dsh plugin --profile web add dsh-plugin-manager-pro@0.9.0

# 方式三：离线 tgz（GitHub Release 页下载，或 npm pack 自建）
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.9.0.tgz

# 老引擎（0.1.0-rc.6 ~ 0.1.5）或 0.9.0 装上去不生效时，回退到旧 UI 版
dsh plugin --profile web add dsh-plugin-manager-pro@0.8.2

# 重启 web 生效（客户端 bundle 在引擎启动时加载，装完必须重启）
dsh web
```

> **装不到 / 装完还是旧版？** 两种常见原因：① 引擎在**启动时**加载客户端 bundle——装完**必须重启** `dsh web`；
> ② pnpm 11 起有 **24 小时冷静期**（`minimumReleaseAge` 默认 1440 分钟），**当天刚发布的版本不带版本号会解析到旧版**——
> 用上面"方式二"的显式版本号即可绕过（也可把 `dsh-plugin-manager-pro@0.9.0` 加进 profile 的 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`）。

装好后：侧边栏出现一级入口 **「插件管理」**（内置插件页已由本包的 patch 停用并接管）。右下角 🛟 打开救援中心；独立救援页 `http://127.0.0.1:3080/rescue`。

> ### 为什么用 `dsh plugin --profile web add` 而不是在目录里 `npm install`？
>
> - 这是 **DSH 引擎的插件**，运行时要用引擎提供的模块（`@deepseek-ai/*`）。`dsh plugin add` 底层是 **pnpm**，
>   并且 profile 关闭了 `autoInstallPeers` —— 引擎自带的那一份会被复用，不会被重复安装。
> - 引擎自带的 `@deepseek-ai/*`（如 `@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-home-paths`）在 npm registry 上
>   都是**预发布版本**（`-rc.*` / `-alpha.*`），版本历史也比较杂（例如 `dsh-home-paths` 的 `latest` 标签停在 `0.0.1-rc.3`，
>   而引擎实际用的是 `0.1.7-rc.2`）。用 **npm** 在 profile 或任意干净工程里直接安装本包时，npm 会按它自己的 peer 规则去
>   registry 解析这些预发布范围；不同 npm 版本表现不一（可能只是告警，也可能直接 `ERESOLVE` 失败）。
>   **这属于引擎侧包的版本事实，不是本插件的依赖缺陷** —— 本插件自身的运行时依赖只有 `yaml` 与 `zod`。
> - 本包只声明 `@deepseek-ai/dsh-typert-protocol` 一个 peer（由引擎提供）。若你的 npm 配置对预发布 peer 特别严格，
>   加 `--legacy-peer-deps` 可以绕过。
> - 结论：**装进 profile 一律用 `dsh plugin … add`**；`npm install` 只适用于开发本仓库时安装 devDependencies（见文末"开发与测试"）。

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-manager-pro
npx dsh-pm-launcher --uninstall-autostart   # Windows：清理开机自启
```

## 救砖入口速查

| 场景 | 怎么做 |
|---|---|
| 引擎正常，UI 坏了 | `http://127.0.0.1:3080/rescue`（救援页 / 右下角 🛟） |
| 引擎起不来 | `http://127.0.0.1:3081/`（独立守护）→ 运行检查 → 修复 → 启动 |
| 想要"打开即启动" | 浏览器主页设为 `http://127.0.0.1:3081/`；常驻+开机自启用 `npx dsh-pm-launcher --install-autostart` |
| 想要 3081 常驻但不想看窗口 | `npx dsh-pm-launcher --supervise`（守护静默；只有拉起引擎时才弹可见窗口，`--no-window` 可连窗口也关掉） |
| 想知道 3080/3081/4081 到底什么状态 | `npx dsh-pm-launcher --status`（启动器身份 / 守护锁归属 / 引擎 HTTP 握手 / PID 文件 / 最后心跳） |
| 3081 打开的是别人的页面 | 端口被非本工具进程占用：`--status` 会报出占用者 pid；结束它，或用 `--port` 换端口并同步改浏览器主页（工具**不会**静默漂移端口） |
| 命令行一键自检+启动 | `npx dsh-pm-boot`（启动）或 `npx dsh-pm-boot --repair-only`（只自检+修复）；Windows 双击等价物 `bin\dsh-boot.cmd` |
| 装完界面还是旧的 | 引擎在**启动时**加载客户端 bundle——安装后必须重启 `dsh web`（或让启动器重新拉起引擎） |
| 启停插件后状态没变 | 引擎在启动时套用条目：启停会立即写入配置，但**生效需重启引擎**（0.9.0 会在界面提示需要重启的场景） |

---

## 工作原理

- **宿主端**（`lib/index.js`）：读取 Cordis Loader 实时状态（启用/运行期阶段/错误），经 Typert 网关暴露远程方法（list/setEnabled/update/verifyProfile/fixProfile/marketCatalog/…）。收敛判定基于引擎真实字段（`Entry.disabled` / `_initTask` / `fiber.state`），**不收敛时如实提示需要重启，不再谎报**
- **运行期错误**：从 cordis 的 `fiber._error` 取真实错误文本（诊断与救援页因此能看到失败原因）
- **插件页接管**（`src/client.jsx` + `cordis.patch.yml`）：客户端注册进 `main`（key=`plugins`）与 `sidebar.panellist`（id=`plugins`），包内 patch 先停用内置的 `ui-plugin-manager`；注册时声明内置插件页原有的 7 个 `plugins.*` 子槽位，其中第三方真正使用的三个（`plugins.row.config` / `plugins.bundle.config` / `plugins.item`）给出真实渲染出口——**未注册的键不会生成空按钮**
- **开关持久化**：写入 profile 的 `cordis.patch.yml`（带 `Managed by dsh-plugin-manager-pro` 注释行，不触碰用户自有补丁）
- **更新源聚合**（`lib/aggregate.js` + `compare-versions.js`）：多源并行 → 最高版本 → 并列随机；源级熔断（403/429 → 10 分钟冷却）；完整支持预发布段
- **下载器**（`lib/downloader.js`）：HTTP 直链流式；magnet/.torrent 优先外部下载器（跨平台 where/which 检测）→ 内置 webtorrent → 提示手动导入
- **跨平台**（`lib/platform.js`）：npm 全局根 Windows 用 `APPDATA\npm\node_modules`，macOS/Linux 用 `npm root -g` + 常见路径 + nvm 目录（10 分钟缓存）
- **独立救砖**（`lib/preflight.mjs` + `lib/enginectl.mjs`）：纯 Node 自检/修复 + 引擎生命周期，被三个 bin 工具复用；与 host 方法同源逻辑
- **受保护条目**：管理器自身、loader 基础设施、webserver/connection/ui-layout 等禁开关；救援 `RESCUE_NEVER` 与自动隔离的**保护集**同源，自动隔离还需连续失败达阈值

---

## 开发与测试

```sh
npm install                                  # 如遇 npm 拦截 esbuild 安装脚本：npm approve-scripts esbuild
npm run build                                # esbuild 打包浏览器端 → lib/client.js
npm test                                     # build + bundle + render + integration + launcher 全套
node test-launcher.mjs --strict               # 启动器单测（72 断言，随机端口 + 临时 profile）
node tools/test-host-fixes.mjs                # 宿主侧修复的回归断言
npm run check:vendor                          # 迁移件内容级校验（tgz 内文件 sha256 == 工作树）
npm run pack                                  # build + npm pack（产出安装用 tarball）
```

发布流程见 `docs/RELEASING.md`：本地验证 → bump 版本 → **在最后一轮改动之后再打包**（并用内容级 `check:vendor` 校验）→ 打 tag 发 **GitHub Release**（附 tgz）。发布说明在 `docs/releases/`。

## 常见问题（排错）

| 现象 | 原因与解决 |
|---|---|
| 装完界面还是旧的 / 新页面不出现 | 客户端 bundle 在引擎启动时加载：**必须重启 `dsh web`**（或让启动器重新拉起引擎） |
| 启停插件后列表状态没变 | 引擎在启动时套用条目：配置已写入，**重启引擎后生效**（界面会在需要重启时提示） |
| `dsh plugin add` 报 "Already up to date" 不更新 | pnpm 按版本号缓存 tarball；**修改后必须升版本号**再 add |
| 引擎起不来（坏 bundle 进 package.json） | 开 `http://127.0.0.1:3081/` 独立救援 → 运行检查 → 修复 → 启动；或 `npx dsh-pm-boot --repair-only` |
| 救砖页自检总报"patch 解析失败" | 已修复：注释开头的合法 patch 不再被误判损坏；升级插件即可 |
| 修复 `cordis.patch.yml` 被误判、日志误报 | 自检逻辑与宿主 `verifyProfile` 同源（`lib/preflight.mjs`），升级后回溯修复均为可逆备份 |
| 浏览器报 `waiting for service: remote.xxx` | 客户端 inject 不能包含自身挂载的 remote（死锁）；inject 只保留 `["slots","locale","remote"]` |
| 第三方插件没有 ⚙ 配置入口 | 0.9.0 起会为它注册的槽位生成入口；若该插件尚未适配 0.1.7 的槽位，请向插件作者反馈 |
| P2P 磁力链接无法下载 | 安装 aria2c（自动启用）或装 webtorrent，或用 NDM/比特彗星手动导入 |

## 许可证

MIT。补丁持久化机制借鉴 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)（MIT）。

---

## English

A local plugin manager for DeepSeek Harness. Since **0.9.0** the manager is a **standalone page** (sidebar entry "Plugin manager") instead of a tab inside Settings: five sections — **Official built-ins (optional) · All plugins · Market · Operations & scenarios · Maintenance** — with collapsible necessity groups, origin classification (built-in vs user-installed), status/version/source columns, enable/disable toggles, **third-party config entries rendered inline**, a plugin market over the awesome-dsh-plugin catalog, transactional uninstall with rollback, operation history/undo and named scenarios. It also ships a **standalone brick-rescue toolchain** (v0.7+): `rescue-daemon` (works when the engine is down), `open-boot` (browser-triggered self-check/repair/start, HTTP-handshake + identity health check), and `dsh-boot` (Steam-style boot sequence with exit codes). Cross-platform, zero new runtime dependencies.

Install: `dsh plugin --profile web add dsh-plugin-manager-pro` (pin `@0.9.0` if the release is less than 24 h old — pnpm's `minimumReleaseAge` default blocks brand-new versions) → restart `dsh web` → open the sidebar "Plugin manager". A prebuilt tarball is also attached to each GitHub Release.
