# dsh-plugin-manager-pro

DeepSeek Harness（DSH）本地插件管理器 —— 在 Web 界面「设置 → 插件」中提供可视化的插件管理页。

![badge](https://img.shields.io/badge/dsh-0.1.0--rc.6-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![version](https://img.shields.io/npm/v/dsh-plugin-manager-pro?color=orange) ![npm](https://img.shields.io/npm/dt/dsh-plugin-manager-pro)

> 社区/本地插件，非 DeepSeek Harness 官方包。npm：`dsh-plugin-manager-pro` · GitHub：[nonentity303/dsh-plugin-manager](https://github.com/nonentity303/dsh-plugin-manager) · 跨平台（Windows / macOS / Linux）

## 功能总览（v0.6.8）

### 📋 插件列表
- **分类折叠**：按必要程度收纳为 🔴 必须 / 🟡 推荐 / 🟢 可选 三个可折叠分组（头部显示启用计数与可更新角标，搜索自动展开）
- **来源分类（v0.6.2）**：区分**架构自带**（随 dsh 提供）与**用户安装**（`dsh plugin add` / 插件市场安装），顶部 chips 筛选（全部/架构自带/用户安装）+ 行徽标
- **每行显示**：启用状态（🔴 错误/需检查 · 🟡 需更新 · ⚪ 未启用 · 🟢 启用）、名称、功能简介、必要程度、已装→最新版本 + 来源、开关按键
- **简介自动提取（v0.6.5）**：内置中文目录优先；未收录的 mod 自动从包 `README.zh.md`（优先）/ `package.json.description` / `README.md` 提取一句话简介，不再显示"无简介"
- **架构保留/界面必需保护**：web 层刻意禁用的行（tool-fs 等）与界面骨架插件（ui-layout 等）禁止开关（🔒 标记 + 原因）

### 📥 更新与下载
- **更新源**：npm registry · **插件超市 dshfind**（GitHub dsh-plugin topic 聚合，默认启用）· GitHub 仓库 · 任意自定义 registry / 镜像
- **多源并行 + 权重一致（v0.6.7）**：所有启用源**并行查询**取最高版本；多个源版本并列时**随机挑选**（官方源权重一致，不偏列表顺序）；`updateSource` 显示提供最高版本的源
- **限流熔断（v0.6.8）**：GitHub API 403/429 后自动冷却 10 分钟（github 与 dshfind 共享配额），期间跳过该源不再空等；全量刷新 8 并发，网络正常约 13-20s 完成（冷缓存），二次刷新命中 30 分钟缓存瞬时返回
- **下载优先级**：① 浏览器原生下载（隐藏 iframe 触发，NDM 等扩展可捕获）→ ② 扩展下载软件（NDM/比特彗星等）→ ③ 内置下载器兜底（HTTP 直链 / aria2c / P2P magnet·torrent）
- **下载目录自动安装**：任何方式下载的 `.tgz` 放入 `$DSH_HOME\downloads` → 管理器自动拾取 `pnpm add` 安装
- 每行「更新」按钮 = 浏览器下载优先；「内置」小按钮 = 内置下载器

### 🛒 插件市场（v0.6）
- **dshfind 精选目录**：数据来自 awesome-dsh-plugin 官方收录池（1160+ 插件、14 个分类、本地化描述/星标/收录日期），host 10 分钟缓存；在线不可用时自动兜底 GitHub `topic:dsh-plugin` 搜索
- **本地即时过滤**：目录一次拉全量，搜索（名称/仓库/npm/描述）/ 分类 chips / 排序（星标·收录时间）/ 分页全部客户端本地完成，零网络往返
- **一键安装**：带 npm 包名的条目优先 **npm registry 直装**（预构建产物最可靠），GitHub 仓库走内置下载器（release .tgz → codeload）；两步确认防误触；已装条目显示 ✓ 徽标
- **装后防砖校验**：安装后自动验证 dsh 清单（`dsh.bundle` / `dsh.client`），缺失则自动卸载并提示，避免污染下次启动
- **pnpm 陷阱恢复**：hoist 漂移自动重建 modules 重试一次；`minimumReleaseAge` 新发布保护自动带 `--config.minimumReleaseAge=0` 重试一次

### 🛟 救砖
- **独立救援页 `/rescue`**：自包含 HTML，直连宿主网关，不依赖任何客户端插件/设置页——UI 全坏仍可诊断与恢复
- **浮动救援球**：右下角 🛟 按钮，设置页损坏时的入口
- **诊断/隔离/一键修复/重启引擎/卸载**：`diagnose` / `quarantine` / `repairHarness` / `restartHarness` / `uninstallPackages`（救援保护条目不可禁用）
- **自动隔离**：可选开关（默认关），加载失败的插件自动禁用
- **启动前自检**：`verifyProfile` / `fixProfile`——损坏的 bundle 会让引擎在启动阶段失败，管理器提供启动前检查与一键隔离修复；**桌面快捷方式已升级为救援启动**（双击 = 自检 + 启动）
- **加载优先级**：客户端 `immediately: true`；宿主仅依赖 loader 基础服务

### 🧰 独立救砖工具链（v0.7）

> 解决"救砖页与主引擎绑死"的单点故障：主引擎启动失败时，`/rescue`（由主引擎注册）会随之瘫痪。
> 以下工具**独立于主进程**运行，主引擎挂了依然可用。零新依赖（纯 Node + 项目已有 yaml）。

| 工具 | 用途 | 用法 |
|---|---|---|
| `bin/rescue-daemon.mjs` | **独立救砖守护**（默认端口 **3081**）：自包含中文救援页 + `verify/fix/start/stop/status` API，不依赖主引擎 | `node bin/rescue-daemon.mjs --profile <dir>` |
| `bin/open-boot.mjs` | **浏览器访问即自检启动**：打开 `http://127.0.0.1:3081/` → 自动 自检→修复→启动 → 跳转 3080。设为浏览器主页即可"打开即启动" | `node bin/open-boot.mjs --profile <dir>` |
| `bin/dsh-boot.mjs` / `.cmd` | **Steam 式启动序列**：verify → 自动隔离坏插件 → 启动 → 健康等待。`--repair-only` 供 watchdog 调用；退出码 0=就绪 / 1=启动失败 / 2=修复未完成 | `node bin/dsh-boot.mjs [--repair-only]` / 双击 `dsh-boot.cmd` |

- **公共模块**：`lib/preflight.mjs`（standalone 自检/修复：bundle 解析性 + patch 可解析性检查、坏 bundle 以 `disabled: true` 写入 patch 隔离、损坏补丁备份后重建，与 host 内 `verifyProfile/fixProfile` 同源逻辑）、`lib/enginectl.mjs`（引擎探测/拉起/停止/PID 管理）
- **故障排查**：引擎起不来 → ① 浏览器开 `http://127.0.0.1:3081/` 用救援页"运行检查→修复→启动"；② 或命令行 `node bin/dsh-boot.mjs --repair-only` 看隔离列表；③ 或双击 `bin/dsh-boot.cmd` 一键自检+启动

### 🧰 其他
- 远程调用超时（全量刷新放宽到 4 分钟）、组件级错误边界、宿主操作日志、中英文界面、搜索

## 环境要求

- Windows 10/11 · macOS · Linux（v0.6.6 起跨平台；脚本层如桌面救援快捷方式为 Windows 专属，macOS/Linux 直接 `dsh web` 启动即可）
- Node.js ≥ 18 · DeepSeek Harness `dsh`（全局安装或 npx）· `pnpm`（`dsh plugin` 与更新功能依赖）

## 安装

```sh
# 方式一：npm 一键安装（推荐）
dsh plugin --profile web add dsh-plugin-manager-pro

# 方式二：GitHub Release tarball 安装（离线/自建，推荐走 Release 页下载）
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.6.8.tgz

# 重启 web 生效
dsh web
```

打开浏览器：**设置 → 插件 → 插件管理**。右下角 🛟 打开救援中心；独立救援页 `http://127.0.0.1:3080/rescue`。

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-manager-pro
```

## 工作原理

- **宿主端**（`lib/index.js`）：读取 Cordis Loader 实时状态（启用/运行期阶段/错误），经 Typert 网关暴露远程方法（list/refresh/setSources/setEnabled/resetToggles/update/updateBrowser/marketCatalog/marketInstall/diagnose/quarantine/repairHarness/restartHarness/uninstallPackages/getRescueConfig/setRescueConfig/getDownloadConfig/checkDownloads/resolveDownloadUrl/verifyProfile/fixProfile）
- **开关持久化**：写入 profile 的 `cordis.patch.yml`（带 `Managed by dsh-plugin-manager-pro` 注释的行，不触碰用户自有补丁），Loader 热重载应用；运行期无法收敛返回「重启后生效」
- **更新源聚合**（`lib/aggregate.js` + `lib/compare-versions.js`）：多源**并行**查询 → 取最高版本 → 并列时**随机**挑选（官方源权重一致）；源级限流熔断（403/429 → 10 分钟冷却）；版本比较完整支持预发布段（`-rc.N` / `-alpha.N`）
- **下载器**（`lib/downloader.js`）：HTTP 直链 fetch 流式；magnet/.torrent 优先外部下载器（aria2c，跨平台 where/which 检测）→ 内置 webtorrent（可选）→ 提示用 NDM/比特彗星手动导入
- **下载目录**：`$DSH_HOME\downloads` 轮询拾取 `.tgz` 自动安装
- **跨平台**（`lib/platform.js`）：npm 全局根 Windows 用 `APPDATA\npm\node_modules`，macOS/Linux 用 `npm root -g` 探测 + 常见路径 + nvm 版本目录（10 分钟缓存）
- **浏览器端**（`src/client.jsx` → `lib/client.js`）：`window.__ModuleLoader__.load({id, factory})` 契约注册，设置页 tab + 浮动救援球
- **救援页**（`lib/rescue.js`）：`/rescue` 路由（`ctx.inject(["webServer"])` 等待服务就绪后注册）；网关调用使用完整命名空间端点（`pluginManagerPro/<method>`）
- **启动前自检**（`verifyProfile`）：bundle 解析性 + patch YAML 可解析性（`parseDocument`）；`fixProfile` 备份后隔离坏 bundle、仅当 patch 真的解析失败才还原
- **受保护条目**：管理器自身、loader 基础设施、webserver/web-runtime/connection/client-runtime 等——禁开关；救援保护集（RESCUE_NEVER）在救砖时同样不可触碰

## 开发

```sh
npm install        # 如遇 npm 拦截 esbuild 安装脚本：npm approve-scripts esbuild
npm run build      # esbuild 打包浏览器端 → lib/client.js（含 __ModuleLoader__ 包装）
node test-bundle.mjs   # 契约测试（bundle 契约 + 市场/来源/跨平台/require 回归断言）
node test-render.mjs   # 渲染测试（jsdom：搜索/开关/失败路径/来源筛选/市场面板）
npm pack           # 产出安装用 tarball
```

发布流程（v0.6.6 起）：本地与沙箱（独立 profile + 新端口）验证 → 打 tag 发 **GitHub Release**（附 tgz）→ 用户从 Release 下载安装；不在用户主环境直接改依赖。

## 常见问题（排错）

| 现象 | 原因与解决 |
|---|---|
| 点「检查更新」报操作超时 | v0.6.7 前全量刷新串行 + 30s 客户端超时；**升级 0.6.8**（并行 + 熔断 + 240s 超时，实测 13-20s 完成） |
| 版本来源总显示 npm | 旧版串行遍历、并列时先到先得；v0.6.7 起并行 + 并列随机（官方源权重一致） |
| 重启后插件没生效 | 插件行被标记 `disabled: true`：检查已安装的 `cordis.patch.yml` 内容与标志是否被外部工具改动过（PS5.1 无 BOM UTF-8 中文会按 GBK 解析成乱码）；ASCII 重写补丁后**升级版本号**重装 |
| `dsh plugin add` 报 "Already up to date" 不更新 | pnpm 按版本号缓存 tarball；**修改后必须升版本号**再 add |
| 引擎起不来（坏 bundle 进 package.json） | 双击桌面「DeepSeek Harness Web UI」（救援启动自动隔离坏包）；或在引擎可用时用救砖面板「启动前自检 → 修复引擎配置」 |
| 救砖页自检总报"patch 解析失败" / 点修复后 patch 被清空 | v0.6.4/v0.6.6 已修复（host 端 require 未定义导致的误判）；升级后不再误报、不再误清空 |
| 浏览器报 `waiting for service: remote.xxx` | 客户端 inject 不能包含自身挂载的 remote（死锁）；inject 只保留 `["slots","locale","remote"]` |
| 浏览器报 `loaded without registering ... __ModuleLoader__` | 客户端 bundle 缺少 `window.__ModuleLoader__.load({id, factory})` 包装 |
| P2P 磁力链接无法下载 | 安装 aria2c（自动启用）或装 webtorrent（`npm install webtorrent`），或用 NDM/比特彗星手动导入 |
| 测试/发布时 package.json 中文变 `????` | PS5.1 `Set-Content -Encoding ASCII` 会损坏中文；改 package.json 一律用 node 读写（UTF-8 无 BOM） |

## 许可证

MIT。补丁持久化机制借鉴 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)（MIT）。

---

## English

A local plugin manager for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): a "Plugin manager" tab under **Settings → Plugins** with collapsible necessity groups (🔴 essential / 🟡 recommended / 🟢 optional), **origin classification** (built-in vs user/agent-installed filter chips + badges, v0.6.2), status colors (red = error/check, yellow = update, grey = disabled, green = enabled), auto-extracted README intros for user mods (v0.6.5), version/source columns, and enable/disable toggles with UI-critical & architecture rows locked.

**Updates (v0.5→v0.6.8):** configurable sources (official npm, **dshfind market**, GitHub repos, mirrors) drive version checks — **all enabled sources are queried in parallel and the highest version wins; ties are picked at random so official sources carry equal weight (v0.6.7)**. A rate-limit circuit breaker cools down GitHub API sources for 10 minutes on 403/429 (v0.6.8). Download priority = browser native download (hidden iframe; NDM-style extensions can capture) → external downloaders (NDM/BitComet) → built-in fallback (HTTP/aria2c/P2P magnet·torrent, with cross-platform aria2c detection). Anything downloaded into `$DSH_HOME\downloads` is auto-installed.

**Market (v0.6):** a lightweight plugin market tab over the awesome-dsh-plugin curated catalog (1160+ plugins, 14 categories, localized descriptions, stars, added dates; 10-min host cache, GitHub `topic:dsh-plugin` search fallback). The catalog loads once, then search / category chips / sort (stars · added) / pagination all filter locally with zero network round-trips. One-click install prefers the **npm registry** when the entry declares an npm name (prebuilt), otherwise the built-in GitHub downloader (release .tgz → codeload). Two-step confirm, ✓ installed badges, post-install dsh-manifest validation (auto-removes packages that would brick the next boot), and pnpm trap recovery (hoist drift rebuild, `minimumReleaseAge` bypass).

**Rescue (v0.3/v0.5→v0.6.6):** standalone `/rescue` page (no UI dependencies), floating 🛟 button, diagnose/quarantine/one-click repair/engine restart/uninstall, optional auto-quarantine, and **pre-boot verify/fix** — the desktop shortcut doubles as a rescue launcher that quarantines broken bundles before boot. verifyProfile/fixProfile/checkDownloads crash fixes landed in v0.6.4/v0.6.6 (host-side `require` was undefined).

**Cross-platform (v0.6.6):** npm global roots resolve via `npm root -g` + common paths + nvm version dirs on macOS/Linux (Windows keeps `APPDATA\npm\node_modules`); external downloader detection branches `where`/`which`.

Install: `dsh plugin --profile web add dsh-plugin-manager-pro` (or the GitHub Release tgz) → restart `dsh web` → Settings → Plugins → Plugin manager. Releases are published on GitHub Releases; the main profile is never modified directly.
