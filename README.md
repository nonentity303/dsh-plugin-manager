# dsh-plugin-manager-pro

DeepSeek Harness（DSH）本地插件管理器 —— 在 Web 界面「设置 → 插件」中提供可视化的插件管理页。

![badge](https://img.shields.io/badge/dsh-0.1.0--rc.6-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![version](https://img.shields.io/npm/v/dsh-plugin-manager-pro?color=orange) ![npm](https://img.shields.io/npm/dt/dsh-plugin-manager-pro)

> 社区/本地插件，非 DeepSeek Harness 官方包。npm：`dsh-plugin-manager-pro` · GitHub：[nonentity303/dsh-plugin-manager](https://github.com/nonentity303/dsh-plugin-manager)

> 社区/本地插件，非 DeepSeek Harness 官方包。

## 功能总览（v0.6.1）

### 📋 插件列表
- **分类折叠**：按必要程度收纳为 🔴 必须 / 🟡 推荐 / 🟢 可选 三个可折叠分组（头部显示启用计数与可更新角标，搜索自动展开）
- **每行显示**：启用状态（🔴 错误/需检查 · 🟡 需更新 · ⚪ 未启用 · 🟢 启用）、名称、功能简介（中文目录）、必要程度、已装→最新版本 + 来源、开关按键
- **架构保留/界面必需保护**：web 层刻意禁用的行（tool-fs 等）与界面骨架插件（ui-layout 等）禁止开关（🔒 标记 + 原因）

### 📥 更新与下载
- **更新源**：npm registry · **插件超市 dshfind**（GitHub dsh-plugin topic 聚合，默认启用）· GitHub 仓库 · 任意自定义 registry / 镜像
- **下载优先级**：① 浏览器原生下载（隐藏 iframe 触发，NDM 等扩展可捕获）→ ② 扩展下载软件（NDM/比特彗星等）→ ③ 内置下载器兜底（HTTP 直链 / aria2c / P2P magnet·torrent）
- **下载目录自动安装**：任何方式下载的 `.tgz` 放入 `$DSH_HOME\downloads` → 管理器自动拾取 `pnpm add` 安装（更新时自动轮询 2 分钟）
- 每行「更新」按钮 = 浏览器下载优先；「内置」小按钮 = 内置下载器

### 🛒 插件市场（v0.6）
- **dshfind 精选目录**：数据来自 awesome-dsh-plugin 官方收录池（1140+ 插件、14 个分类、本地化描述/星标/收录日期），host 10 分钟缓存；在线不可用时自动兜底 GitHub `topic:dsh-plugin` 搜索
- **本地即时过滤**：目录一次拉全量，搜索（名称/仓库/npm/描述）/ 分类 chips / 排序（星标·收录时间）/ 分页全部客户端本地完成，零网络往返
- **一键安装**：带 npm 包名的条目优先 **npm registry 直装**（预构建产物最可靠），GitHub 仓库走内置下载器（release .tgz → codeload）；两步确认防误触；已装条目显示 ✓ 徽标
- **装后防砖校验**：安装后自动验证 dsh 清单（`dsh.bundle` / `dsh.client`），缺失则自动卸载并提示，避免污染下次启动
- **pnpm 陷阱恢复**：hoist 漂移自动重建 modules 重试一次；`minimumReleaseAge` 新发布保护自动带 `--config.minimumReleaseAge=0` 重试一次

### 🛟 救砖
- **独立救援页 `/rescue`**：自包含 HTML，直连宿主网关，不依赖任何客户端插件/设置页——UI 全坏仍可诊断与恢复
- **浮动救援球**：右下角 🛟 按钮，设置页损坏时的入口
- **诊断/隔离/一键修复/重启引擎/卸载**：`diagnose` / `quarantine` / `repairHarness` / `restartHarness` / `uninstallPackages`（救援保护条目不可禁用）
- **自动隔离**：可选开关（默认关），加载失败的插件自动禁用
- **启动前自检**：`verifyProfile` / `fixProfile`——损坏的 bundle 会让引擎在启动阶段失败（应用内救砖不可达），管理器提供启动前检查与一键隔离修复；**桌面快捷方式已升级为救援启动**（双击 = 自检 + 启动）
- **加载优先级**：客户端 `immediately: true`；宿主仅依赖 loader 基础服务

### 🧰 其他
- 远程调用 30 秒超时、组件级错误边界、宿主操作日志、中英文界面、搜索

## 环境要求

- Windows 10/11（脚本层）· Node.js ≥ 22.19
- DeepSeek Harness `dsh`（全局安装或 npx）
- `pnpm`（`dsh plugin` 与更新功能依赖）

## 安装

```sh
# 方式一：npm 一键安装（推荐）
dsh plugin --profile web add dsh-plugin-manager-pro

# 方式二：tarball 安装（离线/自建）
# dsh plugin --profile web add ./dsh-plugin-manager-pro-0.5.2.tgz

# 重启 web 生效
dsh web
```

打开浏览器：**设置 → 插件 → 插件管理**。右下角 🛟 打开救援中心；独立救援页 `http://127.0.0.1:3080/rescue`。

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-manager-pro
```

## 工作原理

- **宿主端**（`lib/index.js`）：读取 Cordis Loader 实时状态（启用/运行期阶段/错误），经 Typert 网关暴露远程方法（list/refresh/setSources/setEnabled/resetToggles/update/updateBrowser/diagnose/quarantine/repairHarness/restartHarness/uninstallPackages/getRescueConfig/setRescueConfig/getDownloadConfig/checkDownloads/resolveDownloadUrl/verifyProfile/fixProfile）
- **开关持久化**：写入 profile 的 `cordis.patch.yml`（带 `Managed by dsh-plugin-manager-pro` 注释的行，不触碰用户自有补丁），Loader 热重载应用；运行期无法收敛返回「重启后生效」。机制借鉴 MIT 项目 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)
- **更新源**：registry（pnpm `--registry`）/ github / dshfind（GitHub search topic:dsh-plugin 聚合，缓存 1 小时）——版本取最高可用源
- **下载器**（`lib/downloader.js`）：HTTP 直链 fetch 流式；magnet/.torrent 优先外部下载器（aria2c）→ 内置 webtorrent（可选）→ 提示用 NDM/比特彗星手动导入
- **下载目录**：`$DSH_HOME\downloads` 轮询拾取 `.tgz` 自动安装
- **浏览器端**（`src/client.jsx` → `lib/client.js`）：`window.__ModuleLoader__.load({id, factory})` 契约注册，设置页 tab + 浮动救援球
- **救援页**（`lib/rescue.js`）：`/rescue` 路由（`ctx.inject(["webServer"])` 等待服务就绪后注册）
- **启动前自检**（`verifyProfile`）：bundle 解析性（安装目录/扁平 fallback/profile node_modules）+ patch YAML 可解析性；`fixProfile` 备份后隔离坏 bundle、还原坏 patch
- **受保护条目**：管理器自身、loader 基础设施、webserver/web-runtime/connection/client-runtime 等——禁开关；救援保护集（RESCUE_NEVER）在救砖时同样不可触碰

## 开发

```sh
npm install        # 如遇 npm 拦截 esbuild 安装脚本：npm approve-scripts esbuild
npm run build      # esbuild 打包浏览器端 → lib/client.js（含 __ModuleLoader__ 包装）
node test-bundle.mjs   # 契约测试（真实 require，验证 id/inject/apply 与 React 互操作）
node test-render.mjs   # 渲染测试（jsdom：搜索/开关/失败路径/受保护行）
npm pack           # 产出安装用 tarball
```

## 常见问题（排错）

| 现象 | 原因与解决 |
|---|---|
| 重启后插件没生效 | 插件行被标记 `disabled: true`：检查已安装的 `cordis.patch.yml` 内容与标志是否被外部工具改动过（PS5.1 无 BOM UTF-8 中文会按 GBK 解析成乱码）；ASCII 重写补丁后**升级版本号**重装 |
| `dsh plugin add` 报 "Already up to date" 不更新 | pnpm 按版本号缓存 tarball；**修改后必须升版本号**再 add |
| 引擎起不来（坏 bundle 进 package.json） | 双击桌面「DeepSeek Harness Web UI」（救援启动自动隔离坏包）；或在引擎可用时用救砖面板「启动前自检 → 修复引擎配置」 |
| 刷新后整个列表空白 | 旧版 `run()` 对「直接返回快照」的方法取 `result.snapshot` 得 undefined 崩溃——0.2.1 已修复 |
| 浏览器报 `waiting for service: remote.xxx` | 客户端 inject 不能包含自身挂载的 remote（死锁）；inject 只保留 `["slots","locale","remote"]` |
| 浏览器报 `loaded without registering ... __ModuleLoader__` | 客户端 bundle 缺少 `window.__ModuleLoader__.load({id, factory})` 包装 |
| 计划任务/守护看不到端口 | 任务上下文里 `Get-NetTCPConnection` 看不到交互会话监听；改用 TCP 连接探测 |
| P2P 磁力链接无法下载 | 安装 aria2c（自动启用）或装 webtorrent（`npm install webtorrent`），或用 NDM/比特彗星手动导入 |

## 许可证

MIT。补丁持久化机制借鉴 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)（MIT）。

---

## English

A local plugin manager for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): a "Plugin manager" tab under **Settings → Plugins** with collapsible necessity groups (🔴 essential / 🟡 recommended / 🟢 optional), status colors (red = error/check, yellow = update, grey = disabled, green = enabled), Chinese descriptions, version/source columns, and enable/disable toggles with UI-critical & architecture rows locked.

**Updates (v0.5):** configurable sources (official npm, **dshfind market**, GitHub repos, mirrors) drive version checks; download priority = browser native download (hidden iframe; NDM-style extensions can capture) → external downloaders (NDM/BitComet) → built-in fallback (HTTP/aria2c/P2P magnet·torrent). Anything downloaded into `$DSH_HOME\downloads` is auto-installed.

**Market (v0.6):** a lightweight plugin market tab over the awesome-dsh-plugin curated catalog (1140+ plugins, 14 categories, localized descriptions, stars, added dates; 10-min host cache, GitHub `topic:dsh-plugin` search fallback). The catalog loads once, then search / category chips / sort (stars · added) / pagination all filter locally with zero network round-trips. One-click install prefers the **npm registry** when the entry declares an npm name (prebuilt), otherwise the built-in GitHub downloader (release .tgz → codeload). Two-step confirm, ✓ installed badges, post-install dsh-manifest validation (auto-removes packages that would brick the next boot), and pnpm trap recovery (hoist drift rebuild, `minimumReleaseAge` bypass).

**Rescue (v0.3/v0.5):** standalone `/rescue` page (no UI dependencies), floating 🛟 button, diagnose/quarantine/one-click repair/engine restart/uninstall, optional auto-quarantine, and **pre-boot verify/fix** — the desktop shortcut doubles as a rescue launcher that quarantines broken bundles before boot.

Install: `dsh plugin --profile web add dsh-plugin-manager-pro` → restart `dsh web` → Settings → Plugins → Plugin manager.
