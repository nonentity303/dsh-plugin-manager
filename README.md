# @dsh-local/plugin-manager

DeepSeek Harness（DSH）本地插件管理器 —— 在 Web 界面「设置 → 插件」中提供可视化的插件管理页。

![badge](https://img.shields.io/badge/dsh-0.1.0--rc.6-blue) ![license](https://img.shields.io/badge/license-MIT-green)

> 社区/本地插件，非 DeepSeek Harness 官方包。

## 功能特性（v0.2）

### 🛟 救砖（v0.3）
- **独立救援页 `/rescue`**：完全自包含的 HTML，直连宿主网关，**不依赖任何客户端插件/设置页**——即使 UI 全坏也能诊断与恢复
- **浮动救援球**：右下角 🛟 按钮（客户端运行时存活但设置页损坏时仍可进入救援页）
- **诊断**：扫描加载失败/运行期错误的插件（`diagnose`）
- **隔离**：一键禁用问题插件（`quarantine`，救援保护条目如 timer/webserver/管理器自身不可禁用）
- **一键修复**：重置管理器开关 → 隔离全部失败插件 → 清空缓存（`repairHarness`）
- **重启引擎**：宿主自重启（过渡脚本 2 秒后拉起新实例，`restartHarness`）
- **卸载**：移除 profile 依赖并从 bundles 列表剔除（`uninstallPackages`，需重启生效）
- **自动隔离**：可选——加载失败的插件自动禁用（`setRescueConfig`，默认关闭）
- **加载优先级**：客户端 bundle `immediately: true`（启动清单中立即加载）；宿主仅依赖 loader 基础服务

### 安全与加固（v0.2.3 / v0.2.4）
- **架构保留**：web 层刻意禁用、由浏览器端提供的行（tool-fs/tool-bash/tool-subagent 等）标记「架构保留」并禁止开关——防止误启用导致服务端重复注册与界面崩坏
- **界面必需保护**：ui-layout/ui-sidebar/ui-conversation/ui-theme/ui-tool 等界面骨架插件禁止开关（🔒 标记 + 原因提示）
- **一键还原**：工具栏「重置开关」一键清空管理器写入的所有行（界面异常后自救入口）
- **健壮性**：远程调用 30 秒超时（不再永久转圈）；组件级错误边界（渲染异常只影响本 tab）；修复 CJS react 的 `default` 互操作崩溃（TabBoundary extends undefined）
- **可观测**：宿主操作日志（setEnabled/update/resetToggles 写入 host web 日志）

### 分类折叠
插件按**必要程度**收纳成三个可折叠分组：🔴 **必须**（核心基础设施）· 🟡 **推荐** · 🟢 **可选**；分组头部显示启用计数与可更新角标，支持全部展开/收起（搜索时自动展开）。

### 插件列表
| 列 | 说明 |
|---|---|
| **启用状态** | 🔴 错误/需检查（加载失败或运行期错误） · 🟡 需更新 · ⚪ 未启用 · 🟢 启用 |
| **名称** | 配置 id + 包名 |
| **功能简介** | 内置简体中文目录（未收录显示「无简介」） |
| **必要程度** | 🔴 必须（核心） · 🟡 推荐 · 🟢 可选 |
| **版本** | 已装版本 → 最新版本 + 来源 |
| **开关按键** | 一键启用/停用；受保护条目（管理器自身、Web 表面、会话基础设施）不可停用 |

### 一键更新（参考 ONI Mod Updater 的「检查 → 更新」模式）
- **更新源可配置**：默认预填 **官方源（npm）**、**GitHub 官方仓库** 与 npmmirror 镜像（默认关闭）；可添加任意 npm 兼容 registry 或 GitHub 仓库（GitHub 源适用于「仓库根 package.json 的 name 匹配包名、以 GitHub Releases 发版」的插件）
- **检查更新**：刷新按钮对所有启用的源查询最新版本（`next` 优先于 `latest`，30 分钟缓存，离线/限流不报错）
- **更新**：单包「更新」按钮或工具栏「全部更新」；profile 依赖从提供最高版本的源拉取（registry 源用 `pnpm add pkg@version --registry <源>`，GitHub 源用 codeload tarball）；更新后提示重启生效；随 dsh 安装提供的包标注「随安装更新」

### 其他
搜索（名称/简介/包名）、操作反馈（失败红色 / 需重启黄色 / 成功绿色）、简体中文/英文界面。

## 环境要求

- Node.js ≥ 22.19
- DeepSeek Harness `dsh`（全局安装或 npx）
- `pnpm`（`dsh plugin` 插件管理依赖 + 更新功能依赖）

## 安装

```sh
# 1) 安装 tarball 到 web profile
dsh plugin --profile web add ./dsh-local-plugin-manager-0.2.1.tgz

# 2) 重启 web 生效
dsh web
```

打开浏览器进入 Web 界面：**设置 → 插件 → 插件管理**。

卸载：

```sh
dsh plugin --profile web remove @dsh-local/plugin-manager
```

## 工作原理

- **宿主端**（`lib/index.js`）：读取 Cordis Loader 的实时状态（启用/运行期阶段/错误），通过 Typert 网关暴露 `list` / `refresh` / `setSources` / `setEnabled` / `update` 远程方法；更新源配置持久化在 `<profileDir>/plugin-manager.json`（侧车文件，预填官方源）
- **开关持久化**：目标状态写入 profile 的 `cordis.patch.yml`（带 `Managed by @dsh-local/plugin-manager` 注释的行，**不触碰用户自有的补丁行**），Loader 热重载应用；运行期无法收敛的变更返回「重启后生效」。该机制借鉴 MIT 项目 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)
- **浏览器端**（`src/client.jsx` → 构建为 `lib/client.js`）：以 `window.__ModuleLoader__.load({id, factory})` 契约注册（与官方客户端插件一致），在「设置 → 插件」区注册「插件管理」tab，替代原只读清单页
- **受保护条目**：`api-gateway`、`connection`、`client-runtime`、`modules`、`locale`、`ui-settings*`、`webserver`、`web-runtime`、`timer` 及管理器自身等 —— 防止误关导致管理入口/Web 表面/会话无法恢复

## 开发

```sh
npm install        # 如遇 npm 拦截 esbuild 安装脚本：npm approve-scripts esbuild
npm run build      # esbuild 打包浏览器端 → lib/client.js（含 __ModuleLoader__ 包装）
node test-bundle.mjs   # 本地模拟浏览器加载器，验证 bundle 契约（id/inject/apply）
npm pack           # 产出安装用 tarball
```

## 常见问题（排错）

| 现象 | 原因与解决 |
|---|---|
| 重启后插件没生效 | 插件行被标记 `disabled: true`：检查已安装的 `cordis.patch.yml` 内容与标志是否被外部工具改动过（注意 PowerShell 5.1 无 BOM UTF-8 中文会被按 GBK 解析成乱码）；以 ASCII 重写补丁后**升级版本号**重新安装 |
| `dsh plugin add` 报 "Already up to date" 且不更新 | pnpm 按版本号缓存 tarball；**修改后必须升版本号**再 add |
| 刷新后整个列表空白 | 旧版 `run()` 把「直接返回快照」的远端方法按收据结构取 `result.snapshot`，得到 undefined 导致渲染崩溃 —— 0.2.1 已修复（`result?.snapshot ?? result`） |
| 浏览器报 `waiting for service: remote.xxx` | 客户端 bundle 的 `inject` 不能包含自身挂载的 remote 服务（死锁）；inject 只保留 `["slots","locale","remote"]` |
| 浏览器报 `loaded without registering ... via __ModuleLoader__.load` | 客户端 bundle 缺少 `window.__ModuleLoader__.load({id, factory})` 包装（esbuild 需用 banner/footer 注入） |
| 计划任务/守护脚本看不到端口 | 计划任务上下文里 `Get-NetTCPConnection` 看不到交互会话的监听端口；改用 TCP 连接探测 |

## 许可证

MIT。补丁持久化机制借鉴 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)（MIT）。

---

## English

A local plugin manager for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): a "Plugin manager" tab under **Settings → Plugins** listing every plugin grouped into collapsible necessity sections (🔴 essential / 🟡 recommended / 🟢 optional), with **status** (red = error/needs check, yellow = update available, grey = disabled, green = enabled), Chinese descriptions, installed/latest versions, and **enable/disable toggles**.

**Update sources (v0.2):** configurable sources (pre-filled: official npm registry, official GitHub repo, npmmirror mirror) drive version checks and one-click updates — `pnpm add` for registry sources, codeload tarballs for GitHub sources; per-package and "update all" buttons. Disabling persists to the profile's `cordis.patch.yml` (owner-marked rows only); the Loader applies it live or reports "restart required". Protected entries (web surface, settings, manager itself) cannot be disabled.

Install: `dsh plugin --profile web add <tarball>` → restart `dsh web` → Settings → Plugins → Plugin manager.
