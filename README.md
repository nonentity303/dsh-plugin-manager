# @dsh-local/plugin-manager

DeepSeek Harness（DSH）本地插件管理器 —— 在 Web 界面「设置 → 插件」中提供可视化的插件管理页。

![badge](https://img.shields.io/badge/dsh-0.1.0--rc.6-blue) ![license](https://img.shields.io/badge/license-MIT-green)

> 社区/本地插件，非 DeepSeek Harness 官方包。

## 功能特性

插件列表每一行显示：

| 列 | 说明 |
|---|---|
| **启用状态** | 🔴 错误/需检查（加载失败或运行期错误） · 🟡 需更新（npm 有新版） · ⚪ 未启用 · 🟢 启用 |
| **名称** | 配置 id + 包名 |
| **功能简介** | 内置简体中文目录（未收录显示「无简介」） |
| **必要程度** | 🔴 必须（核心） · 🟡 推荐 · 🟢 可选 |
| **版本** | 已装版本 → 最新版本（按 npm `next`/`latest` dist-tag 对比，30 分钟缓存） |
| **开关按键** | 一键启用/停用；受保护条目（管理器自身、Web 表面、会话基础设施）不可停用 |

其他能力：搜索（名称/简介/包名）、刷新并重新检测版本、操作反馈（失败红色 / 需重启黄色提示）、简体中文/英文界面。

## 环境要求

- Node.js ≥ 22.19
- DeepSeek Harness `dsh`（全局安装或 npx）
- `pnpm`（`dsh plugin` 插件管理依赖）

## 安装

```sh
# 1) 安装 tarball 到 web profile
dsh plugin --profile web add ./dsh-local-plugin-manager-0.1.3.tgz

# 2) 重启 web 生效
dsh web
```

打开浏览器进入 Web 界面：**设置 → 插件 → 插件管理**。

卸载：

```sh
dsh plugin --profile web remove @dsh-local/plugin-manager
```

## 工作原理

- **宿主端**（`lib/index.js`）：读取 Cordis Loader 的实时状态（启用/运行期阶段/错误），通过 Typert 网关暴露 `list` / `refresh` / `setEnabled` 三个远程方法；`refresh` 会向 npm registry 查询每个包的最新版本（`next` 优先于 `latest`，缓存 30 分钟，离线不报错）。
- **开关持久化**：目标状态写入 profile 的 `cordis.patch.yml`（带 `Managed by @dsh-local/plugin-manager` 注释的行，**不触碰用户自有的补丁行**），Loader 热重载应用；运行期无法收敛的变更返回「重启后生效」。该机制借鉴 MIT 项目 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)。
- **浏览器端**（`src/client.jsx` → 构建为 `lib/client.js`）：以 `window.__ModuleLoader__.load({id, factory})` 契约注册（与官方客户端插件一致），在「设置 → 插件」区注册「插件管理」tab，替代原只读清单页。
- **受保护条目**：`api-gateway`、`connection`、`client-runtime`、`modules`、`locale`、`ui-settings*`、`webserver`、`web-runtime`、`timer` 及管理器自身等 —— 防止误关导致管理入口/Web 表面/会话无法恢复。

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
| 浏览器报 `waiting for service: remote.xxx` | 客户端 bundle 的 `inject` 不能包含自身挂载的 remote 服务（死锁）；inject 只保留 `["slots","locale","remote"]` |
| 浏览器报 `loaded without registering ... via __ModuleLoader__.load` | 客户端 bundle 缺少 `window.__ModuleLoader__.load({id, factory})` 包装（esbuild 需用 banner/footer 注入） |
| 计划任务/守护脚本看不到端口 | 计划任务上下文里 `Get-NetTCPConnection` 看不到交互会话的监听端口；改用 TCP 连接探测 |

## 许可证

MIT。补丁持久化机制借鉴 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)（MIT）。

---

## English

A local plugin manager for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): a "Plugin manager" tab under **Settings → Plugins** that lists every plugin with **status** (red = error/needs check, yellow = update available, grey = disabled, green = enabled), a **Chinese description**, **necessity** (red = essential, yellow = recommended, green = optional), installed/latest **versions**, and an **enable/disable toggle**. Disabling persists to the profile's `cordis.patch.yml` (owner-marked rows only); the Loader applies it live or reports "restart required". Protected entries (web surface, settings, manager itself) cannot be disabled.

Install: `dsh plugin --profile web add <tarball>` → restart `dsh web` → Settings → Plugins → Plugin manager.
