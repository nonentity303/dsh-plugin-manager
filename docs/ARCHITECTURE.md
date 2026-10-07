# 架构（dsh-plugin-manager-pro）

> 面向读者：想知道「它由哪些进程、文件、槽位组成，边界在哪」的人。
> 命令与退出码见 [LAUNCHER.md](LAUNCHER.md)；发布与打包见 [RELEASING.md](RELEASING.md)；使用说明见仓库根 [README.md](../README.md)；版本变更见 [CHANGELOG.md](../CHANGELOG.md)。
>
> 本文描述 **v0.9.1（当前开发树）**。代码锚点写的是「文件 + 符号名」，括号里的行号是 2026-10 的工作树快照 —— 行号会随源码变动，符号名不会。

## 1. 一图看懂

```text
            ┌──────────────────────────────────────────────────────────────┐
   浏览器 ──▶│ 3080  dsh 引擎（DeepSeek Harness web）                       │
            │        ├─ 插件页（本包接管：main key=plugins + 五分区）        │
            │        └─ /rescue 救援页 ← 本包 host 用引擎 webServer 注册     │
            └──────────────────────────────────────────────────────────────┘
                    ▲ 自检/修复/拉起/停止（HTTP 握手 + 身份指纹）
                    │
            ┌───────┴───────────────────────┐        ┌──────────────────────────┐
            │ 3081  open-boot（唯一网页入口）│        │ 3082  rescue-daemon       │
            │  GET /            启动页       │        │  GET /        救援页      │
            │  GET /rescue      救援页       │        │  GET /api/verify|status   │
            │  GET /api/status               │        │  POST /api/fix|start|stop │
            │  POST /api/boot（单飞）        │        │  （独立备份入口，默认 3082）│
            │  /rescue/api/*（复用 3082 实现）│        └──────────────────────────┘
            │  锁端口 = 3081+1000 = 4081     │
            └───────────────────────────────┘
                     │  纯 Node，不依赖主进程；主引擎挂了仍可用
                     ▼
            <profile>/package.json · cordis.patch.yml · plugin-manager.json
                     （自检/修复/隔离只碰这几个文件 + node_modules）
```

**为什么要有独立进程**：`/rescue`（3080）是本包 host 侧通过引擎 `webServer` 注册的（`lib/index.js` 的 `ctx.inject(["webServer"])` → `webServer.register({ path: "/rescue" })`，行号约 1351–1361），**引擎起不来它就一起没了**。3081/3082 的服务是纯 Node 进程，不 import 引擎，所以引擎宕机时仍能自检、修复、把引擎拉起来。

## 2. 进程 / 端口一览

| 端口 | 归属 | 角色 | 代码 | 健康判据 |
|---|---|---|---|---|
| **3080** | dsh 引擎 | 主界面 + 本包 host + `/rescue` | 引擎自身 | **HTTP 握手 + 身份指纹**（`enginectl.engineHealth`） |
| **3081** | `bin/open-boot.mjs` | **唯一网页入口**：启动页 `/`、救援页 `/rescue`、`/api/status`、`POST /api/boot`、`/rescue/api/*` | `bin/open-boot.mjs` | `GET /api/status` 的 JSON `app === "dsh-open-boot"`（`enginectl.launcherHealth`） |
| **3081+1000 = 4081** | `bin/open-boot.mjs --supervise` | **守护单实例锁**（`--port N` → 锁端口 `N+1000`，只 bind 回环） | `open-boot.mjs` 的 `acquireLock`（约 395）/ `--supervise`（约 515） | 能 bind 锁端口 = 本机没有第二个守护 |
| **3082** | `bin/rescue-daemon.mjs` | **独立备份救援入口**（`verify/fix/start/stop/status` API） | `bin/rescue-daemon.mjs` 的 `PORT_DEFAULT` | `app === "dsh-rescue-daemon"` |

- 端口被**非本工具进程**占用 → 明确报错退出，**不静默漂移**（`open-boot` exit 1；`rescue-daemon` exit 1）。
- 身份常量：`PID_APP = "dsh-web-engine"`、`LAUNCHER_APP = "dsh-open-boot"`、`RESCUE_APP = "dsh-rescue-daemon"`（`lib/enginectl.mjs`）。
- **多实例/测试逃生门**：环境变量 `DSH_ENGINE_PORT` 覆盖引擎端口（默认仍是 3080）—— `lib/enginectl.mjs` 的 `ENGINE_PORT`。
- **启动页的三种等价写法**：同机同端口的 `http://127.0.0.1:<端口>/`、`http://localhost:<端口>/`、`http://[::1]:<端口>/` 都能正常驱动写接口（同源白名单，见 §7 写接口防护）；换端口必须用同一个端口打开页面。

## 3. 插件页：五个分区与槽位契约

### 3.1 接管第一步：patch 层（包内 `cordis.patch.yml`）

官方 0.1.6 起自带插件管理页（行 id `ui-plugin-manager`，见 `@deepseek-ai/dsh-web-app/cordis.patch.yml`）。**同名槽位不能有两个宿主**，所以本包在 `cordis.patch.yml` 里做两件事：

| 动作 | 内容 | 原因 |
|---|---|---|
| 停用内置页 | `- id: ui-plugin-manager` / `disabled: true` | 内置页与自研页都声明 `plugins.*` 子槽位 → 不关掉会冲突 |
| 插入自己的行 | `- insert: [{ id: plugin-manager-pro, name: 'dsh-plugin-manager-pro' }]` | **不与官方 `plugin-manager` 行 id 同名**（同名会让 profile 直接崩：`TypeError: duplicate loader entry id`） |

> 设置页那个只读清单 tab（`ui-settings-plugin-inventory`）**不再停用**：自研 tab 的 id 已从 `all` 改成 `pluginManagerPro`，不再冲突。

### 3.2 客户端注册面（`src/client.jsx` → 构建产物 `lib/client.js`）

| 注册点 | key / id | 作用 |
|---|---|---|
| `main` | `key = "plugins"` | 主面板（插件页本体） |
| `sidebar.panellist` | `id = "plugins"` | 侧边栏一级入口「插件管理」 |
| `settings.plugins.tab` | `id = "pluginManagerPro"` | 设置 → 插件里的同名 tab（旧路径兼容） |

### 3.3 槽位契约：声明 7 个，真正渲染 3 个

`main` 注册时用 `children` **声明内置页原来的 7 个 `plugins.*` 子槽位**（`src/client.jsx` 约 2925–2932），保证第三方插件往这些槽位注入的配置卡片有家可归：

| 子槽位 | kind | 本页是否渲染 | 渲染出口（代码） |
|---|---|---|---|
| `plugins.item` | list | ✅ | 官方插件卡片的摘要/配置页：`renderSlot("plugins.item", { view: "summary" \| "page" }, { only })` |
| `plugins.row.config` | keyed | ✅ | 行内摘要 + 展开的配置卡片：`renderSlot("plugins.row.config", { view }, { entryKey })` |
| `plugins.bundle.config` | keyed | ✅ | 包级配置卡片：`renderSlot("plugins.bundle.config", { view: "page" }, { entryKey })` |
| `plugins.bundle.activation` | keyed | ❌ 只声明 | — |
| `plugins.detail.actions` | list | ❌ 只声明 | — |
| `plugins.detail.badge` | list | ❌ 只声明 | — |
| `plugins.detail.section` | list | ❌ 只声明 | — |

规则与由来：

- `renderSlot` 只有**声明了 `plugins.*` children 的那条 `main` 注册**拿得到（框架契约）—— 这是"必须自己当宿主、不能只读别人的槽位"的原因。
- **未注册的键不会生成空按钮**：配置入口按 `plugins.row.config` / `plugins.bundle.config` 的**已注册键快照**渲染（`keysOf(...)` + 槽位版本订阅）。
- key 约定：`plugins.bundle.config` 的 key = **包名**；`plugins.row.config` 的 key = `<包名>#<行id>`（例：`dsh-free-search#web-search-free`）。
- 老引擎（无这些槽位）不报错：注入是静默 no-op，页面按自有数据渲染。

### 3.4 页面的五个分区

| 分区 | 内容（实现见 `src/client.jsx`） |
|---|---|
| **官方内置（可选）** | 默认未启用的官方组合包（`agent-team-profile` / `voice-input` / `auto-review`…）、自带配置页的官方插件（`plugins.item`）、版本豁免 |
| **全部插件** | 插件清单：搜索、分类折叠（必须/推荐/可选）、来源筛选（架构自带/用户安装）、启停、行内配置、行内卸载、版本与来源 |
| **插件市场** | 目录 → 一键安装（npm 优先，GitHub 走内置下载器） |
| **操作与场景** | 卸载影响预览/体检、操作历史（撤销）、场景方案 |
| **维护** | 更新源、启动前自检、**救援中心**（一键修复/重启引擎/失败插件自动隔离）、下载目录、可卸载的 profile 依赖 |

## 4. 状态落地：patch 文件与侧车

### 4.1 开关（`<profile>/cordis.patch.yml`）

- `writeDesiredState()`（`lib/index.js`）**只改自己写的行**：新增行带 `commentBefore = "Managed by dsh-plugin-manager-pro. Remove this row to return control to higher-level configuration."`，已有行按 id+name 精确匹配后才改 `disabled` —— **用户自有的补丁行不会被碰**。
- 救援/隔离写的是 `{ id, name, disabled: true }`（同样带归属标记），可逆；改前一定留 `.rescue-bak-<时间戳>` 备份。
- 写盘走「临时文件 + `rename`」的原子写（`atomicWrite`），避免半截 YAML。

### 4.2 侧车（`<profile>/plugin-manager.json`，v2）

| 字段 | 内容 | 上限/说明 |
|---|---|---|
| `version` | 侧车 schema 版本（当前 **2**，v1 只有 `sources` + `rescue`，读取时自动补默认值） | `SIDECAR_VERSION` |
| `sources` | 更新源列表（名称/URL/启用/官方/类型 `registry\|github\|dshfind`） | 默认：npm 官方源、dshfind、GitHub 官方仓库、npmmirror 镜像 |
| `rescue.autoQuarantine` | **自动隔离开关（默认 false）** | 见 §7 |
| `overrides.source` | 来源人工修正：包名 → `npm` / `github` / `local` / `builtin` | 非法标签丢弃 |
| `history` | 操作历史（卸载/启停/隔离/场景/重置开关），含 `undo` 描述 | 最多 **20** 条（`HISTORY_MAX`），新→旧 |
| `scenarios` | 场景方案 `{id, name, createdAt, updatedAt, states}` | `states` = `configId → bool` |
| `pendingRemovals` | Windows 文件锁导致删不掉的包目录，下次启动重试 | 见 §6 |
| `failureStreak` | 自动隔离的连续失败计数 `configId → 次数` | 跨启动累计，上限 16（H3） |

侧车是**纯本地文件**（不外传）；读不出/坏了就回落默认值，不阻塞启动。

## 5. 健康判定口径：HTTP 握手 + 身份指纹

| 探测 | 判据 | 代码 |
|---|---|---|
| 引擎 | `GET http://127.0.0.1:<engine>/` 返回 **HTTP 200–499** 且响应体含身份指纹之一：`dsh web authentication required` / `__DSH_BOOT__` / `DeepSeek Harness` / `dsh-api-gateway` | `enginectl.httpProbe` / `engineHealth`（`ENGINE_MARKERS`） |
| 启动器 | `GET /api/status` 的 JSON `app === "dsh-open-boot"` | `enginectl.launcherHealth` / `identifyLauncherJson` |
| 救援守护 | 同上，`app === "dsh-rescue-daemon"` | 同上 |
| 纯占用（不算健康） | `net.connect` 能连上 → 只说明"端口有人听" | `enginectl.probe` |

**裸 TCP 监听器一律判不健康**——这是刻意的：避免把"端口上有别的程序"误报成"引擎已就绪"。同理，`stopEngine()` 结束进程前做三重校验（pid 存活 / 进程镜像是 node·dsh / 端口占用者与记录的 pid 一致），不过就拒绝（需要时页面可"强制停止"）。

## 6. 卸载事务（数据流）

```text
预览（只读） ──▶ 备份 ──▶ 删除 ──▶ 启动前自检 ──▶ 失败则回滚
   │              │        │           │              │
   │              │        │           │              └─ 恢复 package.json + cordis.patch.yml 备份，
   │              │        │           │                 按原 spec 重装依赖
   │              │        │           └─ verifyProfile（坏 bundle / 坏 patch 立刻暴露）
   │              │        └─ pnpm remove + 移除 bundles/开关行（可级联）
   │              └─ package.json / cordis.patch.yml → *.rescue-bak-<ts>
   └─ 影响预览 + 体检（依赖断裂 / patch 残留 / service·端口冲突）+ 结论行 safe|caution|risky
```

- **删不掉的目录**（Windows 文件锁）登记进 `pendingRemovals`，下次启动自动重试（`retryPendingRemovals`）。
- **卸载管理器自身**时先调用包内 `bin/open-boot.mjs --uninstall --profile <profile>` 清理开机自启/守护/shim（旧版本没有 `--uninstall` → 记为 `skipped`，不阻断卸载）。
- 每一步都写进侧车 `history`，可一键撤销（`undoOperation`）。

## 7. 救砖链路

| 能力 | 实现 | 触发方式 |
|---|---|---|
| 启动前自检 / 修复 | `lib/preflight.mjs` 的 `verifyProfile` / `fixProfile`（与 host 内方法同源） | 网页按钮、`--repair-only`、救援页 |
| 隔离启动期失败的条目 | `isolateFailedEntries()`：从引擎启动日志解析 `failed to apply loader entry …` → 往 patch 写带归属标记的隔离行（可逆） | 启动失败后自动重试一次（`startEngineWithQuarantine`） |
| 独立救援页 | 3081 `/rescue`（open-boot 内建，复用 3082 的 `handleApi`）、3082 `/`（rescue-daemon 自带页） | 引擎起不来时用 |
| 浮动救援球 | 页内自建 DOM（不受槽位体系影响），设置页坏了也能点 | 3080 页面右下角 🛟 |
| 写接口防护 | `guardWriteRequest`（同源 `Origin` = 同机同端口的 `127.0.0.1` / `localhost` / `[::1]` 白名单，**不按 `Host` 头派生**；缺 `Origin` 仍须令牌 + 一次性令牌 `X-DSH-PM-Token`）+ `createSingleFlight`（boot/start 并发第二个 → 409） | 见 [LAUNCHER.md](LAUNCHER.md) §4 |

自动隔离**默认关**（`rescue.autoQuarantine = false`），且只隔离连续失败达阈值的插件，界面骨架/基础设施条目在保护集内。

## 8. 文件地图

**profile 目录（`~/.dsh/profiles/<名字>/`）**

| 文件 | 归属 | 说明 |
|---|---|---|
| `package.json` | 引擎 + 本包 | 已装插件清单；卸载/安装会改写（改前备份） |
| `cordis.patch.yml` | 引擎 + 本包（带归属标记的行） | 启停与隔离 |
| `plugin-manager.json` | 本包 | 侧车状态（§4.2） |
| `*.rescue-bak-<ts>` | 本包 | 事务与修复的备份（可回溯） |
| `.rescue-daemon.pid` / `.open-boot.pid` | 本包 | 引擎 / 启动器的 pid + 归属信息（JSON） |
| `rescue-daemon.log` / `open-boot-supervisor.log` / `health.log` | 本包 | 引擎日志、守护日志、自检留痕（`health.log` 轮转 7 天 / 1000 行） |
| `open-boot-autostart.vbs` / `open-boot-ui.vbs` | 本包 | 开机自启包装脚本（仅 `--install-autostart` 写） |
| `vendor/downloads/*.tgz` | 本包 | 归档暂存（仍被依赖引用的不删） |

**仓库模块**

| 路径 | 职责 |
|---|---|
| `lib/index.js` | host 侧：清单/启停、事务化卸载与体检、历史/场景、市场、更新源聚合、`/rescue` 路由 |
| `lib/remote.js` | Typert 远程契约（客户端 ↔ host 的方法与载荷） |
| `lib/client.js` | 客户端 bundle（由 `src/client.jsx` 经 `node build.mjs` 打包生成，**不手改**） |
| `lib/preflight.mjs` | standalone 自检/修复/隔离（无引擎依赖） |
| `lib/enginectl.mjs` | 引擎探测/拉起/停止、PID 文件、写接口防护共享件 |
| `bin/open-boot.mjs` / `bin/dsh-boot.mjs` / `bin/rescue-daemon.mjs` | 三个命令行入口（见 [LAUNCHER.md](LAUNCHER.md)） |
| `cordis.patch.yml` | 包内 patch 层（停用内置页 + 插入自己的行） |

## 9. 相关文档

- [LAUNCHER.md](LAUNCHER.md) —— 三个 bin 的全部命令、退出码、`--uninstall` 闭环、自启、`health.log`、故障排查
- [RELEASING.md](RELEASING.md) —— 版本号、构建、打包、`check:vendor`、发布核对表、引擎升级彩排
- [releases/](releases/) —— 每个版本的发布说明；[CHANGELOG.md](../CHANGELOG.md) 是脚本生成的汇总
- 仓库根 [README.md](../README.md) —— 安装/升级/回退、权限与数据范围、引擎兼容性矩阵、常见问题
