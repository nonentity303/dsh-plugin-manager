# dsh-plugin-manager-pro

> 本地插件管理器 —— 为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 提供**独立插件页**（可视化插件管理）+ **独立救砖工具链**。

![badge](https://img.shields.io/badge/dsh-0.1.7-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![version](https://img.shields.io/npm/v/dsh-plugin-manager-pro?color=orange) ![npm](https://img.shields.io/npm/dt/dsh-plugin-manager-pro)

> 社区/本地插件，非 DSH 官方包。npm：`dsh-plugin-manager-pro` · GitHub：[nonentity303/dsh-plugin-manager](https://github.com/nonentity303/dsh-plugin-manager) · 跨平台（Windows / macOS / Linux）
>
> **当前版本 0.9.1**（口径：仓库 `package.json` 的 `version`；上一个发布版是 0.9.0 —— 2026-09-30 上了 npm 与 GitHub Release）。
> 发布状态随时可核对：`npm view dsh-plugin-manager-pro version`；标签见 <https://github.com/nonentity303/dsh-plugin-manager/tags>。
> ⚠️ 刚发布的版本会被 pnpm 的 24 小时冷静期（`minimumReleaseAge`）挡住，装不到时请**显式写版本号**（见下文"安装"）。

![独立插件页：侧边栏一级入口「插件管理」+ 五个分区](https://raw.githubusercontent.com/nonentity303/dsh-plugin-manager/master/docs/images/pm-090-official2.png)

<sub>**图 1** · 0.9 独立插件页实拍（DSH **0.1.7-rc.2** 彩排环境，2026-09-28）：侧边栏一级入口「插件管理」，标签栏就是五个分区——官方内置（可选）· 全部插件 · 插件市场 · 操作与场景 · 维护。源图：`docs/images/pm-090-official2.png`。</sub>

---

## 🧭 为什么会有这个管理器：官方做基础，我做兜底

官方 DSH **0.1.6 起**把插件管理做进了引擎本体：宿主服务 `@deepseek-ai/dsh-plugin-manager`（在 `dsh-base` bundle 里新增 `id: plugin-manager` 行）＋ 客户端页 `@deepseek-ai/dsh-client-ui-plugin-manager`。¹³

本管理器的定位不是"再抄一遍清单页"，而是**接管这个页面，再补上官方不做的部分**：装卸的完整闭环（影响预览 → 事务化卸载 → 失败回滚 → 一键撤销）、操作历史与场景方案、以及**主引擎起不来时的救砖**。

### 能力对比

| 能力 | 官方内置页（DSH 0.1.7） | LX2000WASD/dsh-web-plugin-manager（**已废弃**） | 本管理器（0.9.1） |
|---|---|---|---|
| 在 DSH 0.1.7 上能起来 | ✅ 引擎自带 | ❌ 0.1.6 起装上就起不来（loader 行 id 撞车）¹ | ✅ 0.1.7-rc.2 实测：彩排 + 真机安装⁴ |
| 事务化卸载（影响预览 → 备份 → 删除 → 启动前自检 → 失败回滚） | ❌ 只有 bundle 层的增删（`installBundle` / `removeBundle`）；无影响预览、无撤销³ | ⚠️ 能卸载（含 bundle，实时卸载运行条目），但**不带事务**：失败/超时只提示"重启后生效"，恢复要手动改 `cordis.patch.yml`¹ | ✅ 全套，且卸载后可**一键撤销**⁴ |
| 自动回滚 | ⚠️ 安装/移除 bundle 失败时会复原 profile 文件³ | ⚠️ 安装/更新有质量门与回滚；**卸载没有**¹ | ✅ 卸载与"下载目录自动安装"失败都自动回滚⁴ |
| 独立救砖（主引擎起不来也能修） | ❌ 救援页由主引擎注册，引擎挂了跟着瘫⁵ | ❌ 无独立守护/启动器；其"已知限制"写着自动重启链路可能卡死、需手动拉起¹ | ✅ 3081 启动器 + 3082 独立守护，不依赖主进程⁴ |
| 操作历史撤销 | ❌ | ❌ 功能表与 CLI 里都没有¹ | ✅ 最近 20 次操作可撤销⁴ |
| GitHub Release 数量 | —（随 DSH 引擎发版） | **0** | **11**（含 v0.9.0，附 tgz）² |

**出处**（每条都能点开核对）：

1. 竞品 README（首屏公告 + 功能表 + 已知限制 + CLI）：<https://raw.githubusercontent.com/LX2000WASD/dsh-web-plugin-manager/master/README.md>（raw.githubusercontent 不通时用镜像 <https://cdn.jsdelivr.net/gh/LX2000WASD/dsh-web-plugin-manager@master/README.md>）· 仓库 <https://github.com/LX2000WASD/dsh-web-plugin-manager>。公告原文包含 `TypeError: duplicate loader entry id: plugin-manager`、"本仓库的 0.6.x 仍可用于 DSH <= 0.1.5-rc.2；**在 0.1.6-alpha.2 及以上请勿安装**"；已知限制原文包含"删除 bundle 插件的实时卸载失败/超时不再静默：输出会提示「live unmount 未完成，请重启后完全生效」……需手动拉起"与"禁用被依赖的条目可能导致 profile 启动失败……恢复：手动删除该 profile `cordis.patch.yml` 里的 managed 块"。
2. GitHub API 实测（2026-10-03）：竞品 `releases` 返回空数组 `[]` → <https://api.github.com/repos/LX2000WASD/dsh-web-plugin-manager/releases>；本仓库 `releases` 共 **11** 条，最新 `v0.9.0`（2026-09-30）带资产 `dsh-plugin-manager-pro-0.9.0.tgz` → <https://api.github.com/repos/nonentity303/dsh-plugin-manager/releases>。
3. 官方内置页的能力面（0.1.7-rc.2）= 宿主服务 `@deepseek-ai/dsh-plugin-manager` 暴露的 12 个 remote 方法：`listPlugins` / `listBundles` / `registries` / `inspect` / `setPluginEnabled` / `setBundleEnabled` / `installBundle` / `waitForInstall` / `cancelInstall` / `removeBundle` / `listVersionExemptions` / `setVersionExemption`（npm：<https://www.npmjs.com/package/@deepseek-ai/dsh-plugin-manager>）；页面本体是 <https://www.npmjs.com/package/@deepseek-ai/dsh-client-ui-plugin-manager>。**没有**影响预览、操作历史/撤销、场景方案、救砖自检这些方法。
4. 本仓库实现与验证：`cordis.patch.yml`（停用内置页 + 用自己的行 id 接管）、`lib/index.js`（卸载事务与回滚、操作历史 20 条、侧车持久化）、`bin/rescue-daemon.mjs` · `bin/open-boot.mjs` · `bin/dsh-boot.mjs`（与 `package.json` 的 `bin` 一致）；0.1.7-rc.2 的彩排结论见 `docs/releases/RELEASE_NOTES_0.8.3-1.md`（"引擎 0.1.7-rc.2（隔离彩排环境 `upgrade-rehearsal/`）：**零条目失败**"）与 `docs/releases/0.9.0.md`。
5. 救援页由**主引擎的 webServer** 注册，所以主引擎起不来时它也不可用——这正是独立守护的设计前提（本仓库 `bin/rescue-daemon.mjs` 文件头注释、`docs/releases/0.9.0.md` ⑥）；官方包不提供任何独立守护/启动器入口（两个官方包的 `package.json` 都没有 `bin` 字段）。

### 「老管理器为什么死」——以及本管理器为什么还活着

DSH 0.1.6 起，第三方管理器撞上的是同一堵墙：**只要你声明的 loader entry id 和官方同名，profile 启动时就直接崩**——

```
TypeError: duplicate loader entry id: plugin-manager
```

头号同类竞品 [LX2000WASD/dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager)（2026-10-03 实测：68 stars / 3 forks / 最后 push 2026-09-20 / **0 个 Release**）就是这么退场的：它 2026-09 在 README 首屏宣布停止维护，"对应 DSH <= 0.1.5-rc.2"，并明确写"**在 0.1.6-alpha.2 及以上请勿安装**"¹。

**本管理器踩过同一个坑，并且活了下来**——做法是"不抢、接管"三件事一起做：

| 做法 | 落在哪 |
|---|---|
| ① 停用内置页那一行：`- id: ui-plugin-manager` / `disabled: true` | 包内 `cordis.patch.yml` |
| ② 用自己的行 id `plugin-manager-pro` 插入自己的行——**不与官方 `plugin-manager` 同名** | 包内 `cordis.patch.yml` |
| ③ 客户端注册进 `main`(key=`plugins`) 与 `sidebar.panellist`(id=`plugins`)，并声明内置页原有的 7 个 `plugins.*` 子槽位（第三方配置卡片因此有真实落点） | `src/client.jsx` |

已在 **DSH 0.1.7-rc.2 上实测通过**：隔离彩排环境里引擎正常启动、侧边栏出现「插件管理」、五个分区齐备——就是上面图 1。0.1.7 的兼容修复与彩排结论见 `docs/releases/RELEASE_NOTES_0.8.3-1.md`⁴。

> **我该装哪一版？** DSH **0.1.6 及以后 → 0.9.1**；**0.1.5 及更早的老引擎 → 0.8.2**。完整矩阵见下文「环境要求 → 引擎兼容性矩阵」。

![事务化卸载的影响预览 + 同一张卡片里的救援与诊断入口](https://raw.githubusercontent.com/nonentity303/dsh-plugin-manager/master/docs/images/pm4-uninstall-preview.png)

<sub>**图 2** · 事务化卸载的**影响预览**（彩排环境实拍，2026-09-28）：卸载前先列出将移除的条目与受影响的范围，确认后才动 `package.json`；同一张「诊断中心」卡片的下半部分是救砖入口——`一键修复引擎` / `重启引擎` / `启动前自检` / `失败插件自动隔离`。源图：`docs/images/pm4-uninstall-preview.png`。</sub>

---

## ✨ 亮点

- **独立插件页**（v0.9.0）：插件管理不再挤在设置页里，而是侧边栏一级入口「插件管理」——在一个页面里完成看插件、装插件、**配插件**、卸插件、救引擎，5 个分区：**官方内置（可选）· 全部插件 · 插件市场 · 操作与场景 · 维护**
- **第三方配置入口有落点**（v0.9.0）：接管内置插件页后，第三方插件注册的配置入口照样可用——插件行内显示一行摘要、展开即是它自己的完整配置卡片
- **事务化卸载**（v0.8）：卸载前**影响预览**（依赖它的插件/条目/开关行）→ 备份 → 删除 → 启动前自检 → **失败自动回滚**；卸载后可**一键撤销**
- **操作历史 + 场景方案**（v0.8）：最近 20 次操作留痕可撤销；把插件组合保存为命名场景，一键切换（应用前展示变更预览）
- **救砖能力彻底解耦**（v0.7+）：主引擎挂了，**3081 的启动器（自带救援页）与 3082 的独立救援服务照样能自检、修复、拉起**——不再依赖主进程
- **本地写接口有防护**（v0.9.1）：`Origin`（同机同端口白名单：`127.0.0.1` / `localhost` / `[::1]`）+ 一次性令牌 + 单飞闸门，第三方网页无法触发启动/停止；`--status` 每次留一条 `health.log` 自检记录（保留 7 天 / 1000 行）
- **浏览器即启动器**：把主页设为 `http://127.0.0.1:3081/`（`http://localhost:3081/` 同样可用），打开浏览器 = 自动自检 → 修复 → 启动 → 跳转主界面
- **多源更新聚合**：npm registry / 插件超市 dshfind / GitHub / 自定义镜像并行查询，限流熔断，公平取最高版本

---

## 📋 功能总览（v0.9.1）

### 插件页（侧边栏「插件管理」）

页面按用途分成 5 个分区，切换分区不会丢滚动位置：

| 分区 | 内容 |
|---|---|
| **官方内置（可选）** | 引擎自带、默认未启用的组合包（一键启用/停用）+ 自带配置页的官方插件 + 版本豁免 |
| **全部插件** | 插件清单：搜索、分类折叠、来源筛选、启停开关、行内配置、行内卸载、版本与来源、来源人工修正 |
| **插件市场** | dshfind 精选目录（分类浏览 / 搜索 / 排序）一键安装，在线不可用自动兜底 GitHub 搜索 |
| **操作与场景** | 事务化卸载与影响预览、**卸载前体检**、操作历史一键撤销、场景方案 |
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
- **卸载前体检**（v0.9.1）：预览里给出**结论行**（安全 / 需注意 / 有风险 + 一句理由），并列出三类检查——① 依赖断裂（`dependencies` / `peerDependencies` 为高风险，`optionalDependencies` / `dsh.recommendedDeps` 为提示；被依赖方自己也被别人依赖时降级）② `cordis.patch.yml` 里的**补丁残留**（与被卸载包关联的开关行 / insert 行，**只提示、绝不自动删**）③ **service 与端口冲突**（`dsh.services` / `service` / `provides` / `ports` 声明重复 → 信息，唯一 provider → 提示）
- **卸载管理器自身前先清理自启**（v0.9.1）：删包之前先调用包内 `bin/open-boot.mjs --uninstall`（旧版本无该能力 → 记为"已跳过"，不阻断卸载）

### 📥 更新与下载

- **多源并行 + 权重一致**：所有启用源并行查询取最高版本；并列时随机挑选
- **限流熔断**：GitHub API 403/429 自动冷却 10 分钟；全量刷新 8 并发、结果缓存 30 分钟（缓存命中即时返回；刷新耗时随网络与启用源数量变化）
- **下载优先级**：① 浏览器原生下载（隐藏 iframe，NDM 等扩展可捕获）→ ② 外部下载软件 → ③ 内置下载器兜底（HTTP 直链 / aria2c / P2P magnet·torrent）
- **下载目录自动安装**：`.tgz` / `.tar.gz` 放入 `$DSH_HOME\downloads` → 自动拾取安装；**安装前做清单校验 + 启动前自检，失败自动回滚并标记 `.failed`（不再反复重试）**

### 🛒 插件市场

- **dshfind 精选目录**：目录接口 `https://awesome-dsh-plugin.com/plugins.json`（`lib/index.js` 的 `CATALOG_URL`），带本地化描述 / 星标 / 收录日期与分类；条目数随上游变化，host 端 10 分钟缓存。在线不可用自动兜底 GitHub `topic:dsh-plugin` 搜索
- **零往返过滤**：目录一次拉全量，搜索 / 分类 chips / 排序 / 分页全部客户端本地完成
- **一键安装**：带 npm 名的条目优先 **npm registry 直装**；GitHub 仓库走内置下载器；两步确认防误触；已装 ✓ 徽标
- **装后防砖校验**：自动验证 `dsh.bundle` / `dsh.client` 清单，缺失自动卸载；pnpm hoist 漂移 / `minimumReleaseAge` 陷阱自动恢复

### 🛟 救砖

- **独立救援页 `/rescue`**：自包含 HTML 直连宿主网关，UI 全坏仍可诊断/隔离/一键修复/重启/卸载
- **浮动救援球**：右下角 🛟 按钮，设置页损坏时的入口
- **自动隔离**：可选开关（**默认关**），且只隔离**连续失败达阈值**的插件；界面骨架与基础设施条目在保护集内，永不自动禁用
- **启动前自检**：`verifyProfile` / `fixProfile`——坏 bundle 会在启动阶段拖垮引擎，管理器提供一键检查与隔离修复
- **运行期失败条目自动隔离**：插件与引擎不兼容时 loader 会拖垮整棵树启动（静态自检查不出来）——open-boot / rescue-daemon / dsh-boot 启动失败后自动**解析启动日志 → 隔离失败条目 → 重试**，隔离行带备份可逆

![维护 → 救砖：诊断中心（一键修复引擎 / 重启引擎 / 启动前自检 / 失败插件自动隔离）](https://raw.githubusercontent.com/nonentity303/dsh-plugin-manager/master/docs/images/pm-maintenance-rescue.png)

<sub>**图 3** · 救砖面实拍（同一台彩排环境，2026-09-28）：维护分区的「诊断中心」——`一键修复引擎`、`重启引擎`、`启动前自检`、`失败插件自动隔离`，以及底部「可卸载的 profile 依赖」清单；页面右上角提示独立救援页 `http://127.0.0.1:3080/rescue`（设置页不可用时走右下角 🛟，引擎起不来则走 `http://127.0.0.1:3081/`）。源图：`docs/images/pm-maintenance-rescue.png`。</sub>

### 🧰 独立救砖工具链（核心亮点）

> 传统救砖页由主引擎注册——**主引擎挂了，救砖页也跟着瘫**。v0.7 起救砖能力独立于主进程运行，主引擎宕机依然可用。零新依赖（纯 Node + 项目已有 yaml）。

| 工具 | 用途 | 用法 |
|---|---|---|
| `bin/open-boot.mjs` | **唯一网页入口 + 常驻守护**（3081）：`/` 是"打开即启动"页（自检 → 修复 → 启动 → 跳转 3080），**`/rescue` 是救援页**（含 `/rescue/api/*`）。设为浏览器主页即"打开即启动"（`127.0.0.1` / `localhost` / `[::1]` 三种写法等价，需同端口）。**平时完全隐藏，只有引擎真的需要被拉起时才弹出一个可见的启动窗口显示进度**（`--no-window` 可关闭）。健康判定为 **HTTP 握手 + 身份指纹**；写接口带 **Origin + 一次性令牌**防护；`--uninstall` 一键清理（停守护 → 删自启 → 删 shim → 清 pid；退出码 0/1/2，2 = 归属未确认时不动任何进程并保留 pid） | `npx dsh-pm-launcher` |
| `bin/rescue-daemon.mjs` | **独立备份救援守护**（默认端口 **3082**）：自包含中文救援页 + `verify/fix/start/stop/status` API，不依赖主引擎。`stop` 会先校验 PID 与端口归属（可用 `{"force":true}` 强制）。**不再与 3081 的启动器抢端口**（端口被占时明确报错退出，不静默漂移） | `npx dsh-pm-rescue`（默认 3082） |
| `bin/dsh-boot.mjs` / `.cmd` | **Steam 式启动序列**：verify → 自动隔离坏插件 → 启动 → 健康等待。`--repair-only` 供外部调用（**只自检+修复，不启动引擎**）；`--pause` 结束时等按键；`--help` 查看用法；退出码 0=就绪 / 1=启动失败 / 2=修复未完成。启动即失败（坏命令/端口冲突）会**立即返回**并把日志绝对路径打印出来 | `npx dsh-pm-boot`（Windows 双击等价物：**包内** `bin\dsh-boot.cmd`） |

> 端口的完整分工、退出码表、写接口防护与 `--uninstall` 四步见 [docs/LAUNCHER.md](docs/LAUNCHER.md)；进程与槽位架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

#### 启动器常驻与开机自启

| 命令 | 作用 |
|---|---|
| `npx dsh-pm-launcher --supervise [--interval 60] [--heartbeat-min 10]` | **常驻守护**：静默确保 3081 有服务；锁端口（`port+1000`）保证同机只有一个守护，重复启动会自行退出；**只有 HTTP 握手失败**才拉起，绝不误杀健康实例。守护会写「状态变化」「心跳」「退出」「未捕获异常」四类日志到 `profile/open-boot-supervisor.log`，重启时若发现上一次没有正常退出记录会明确提示 |
| `npx dsh-pm-launcher --ensure` | 一次性确保 3081（桌面快捷方式用，退出码 0/1） |
| `npx dsh-pm-launcher --status` | **状态自检 + 健康留痕**：启动器（HTTP 握手 + 身份）/ 守护（锁端口归属）/ 引擎（HTTP 握手）/ PID 文件 / cwd / 日志与最后一次心跳；退出码 0=启动器健康。3081 被别的进程占用时会明确报出占用者 pid。**每次执行都会往 `profile/health.log` 追加一行**（保留最近 7 天 / 最多 1000 行） |
| `npx dsh-pm-launcher --install-autostart` | **写开机自启**（Windows）：HKCU Run + 生成 `open-boot-autostart.vbs`（登录静默常驻）与 `open-boot-ui.vbs`（确保 3081 后开浏览器）。包装脚本正文**纯 ASCII**（路径运行时由 `WScript.ScriptFullName` 自解析）并做回读校验，**中文用户名/含空格 profile 路径不会再乱码** |
| `npx dsh-pm-launcher --uninstall-autostart` / `--autostart-status` | 移除自启 / 查看状态（含包装脚本是否存在、守护是否存活、3081 上是不是本启动器）。未安装时**幂等**（exit 0） |
| `npx dsh-pm-launcher --uninstall` | **卸载闭环（R13）**：停本 profile 的守护（`.open-boot.pid` + 锁端口 `port+1000` + 进程镜像**三重校验**，不过就拒绝、不动别人的进程）→ 删 `HKCU\...\Run` 下**所有** `DSHWeb*` 值（含历史 `DSHWebRescue`）→ 删两个 `.vbs` → 清 `.open-boot.pid`（**日志保留**）。退出码 **0**=完成（含确认无可清理项）/ **1**=出错 / **2**=归属未确认（`netstat`/`tasklist` 探测不可用：不停止任何进程、保留 pid、不报"卸载完成"）；引擎 3080 不动。管理器卸载自身前会自动调用它 |
| `npx dsh-pm-launcher --help` / `npx dsh-pm-boot --help` | 显示用法（参数不再被静默忽略；无法识别的参数会告警） |

安装后三个命令由 `package.json` 的 `bin` 字段提供（`dsh-pm-launcher` / `dsh-pm-boot` / `dsh-pm-rescue`），也可用 `npx` 免装调用，或直接跑包内文件（路径与 cwd 无关）：

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-plugin-manager-pro/bin/open-boot.mjs" --status
```

开机自启（Windows）只由**包内** `--install-autostart` 写入 `HKCU\...\Run\DSHWebFront`；卸载插件后请执行 `npx dsh-pm-launcher --uninstall-autostart` 清理注册表项与 profile 内的 `open-boot-*.vbs`（否则自启项会指向已删除的包）。

> **自启项被删掉之后怎么恢复？** `--uninstall` / `--uninstall-autostart` 会删掉**所有** `DSHWeb*` 注册表值（含别的 profile 写的同名值），但**不动引擎、不动 profile 配置、不删日志**——对当前 profile 重跑 `npx dsh-pm-launcher --install-autostart` 即恢复（另一个 profile 就在那个 profile 上重跑），`--autostart-status` 只读核对三项状态。完整指引（含"包目录被删"时先重装插件的处理）：[docs/LAUNCHER.md](docs/LAUNCHER.md) §6.1。

- **公共模块**：`lib/preflight.mjs`（standalone 自检/修复，与 host 内 `verifyProfile/fixProfile` 同源）、`lib/enginectl.mjs`（引擎探测/拉起/停止/PID 管理 + 写接口防护共享件）
- **写接口防护**（v0.9.1）：本地 HTTP 写接口（`POST /api/boot`、`/rescue/api/start|fix|stop`）要求**同源 `Origin`**——同机同端口的 `127.0.0.1` / `localhost` / `[::1]` 三种写法等价（**不按 `Host` 头派生**）——加页面内注入的一次性令牌（`X-DSH-PM-Token`，48 位 hex、不落盘、每次启动都换）；缺 `Origin`（本地工具）仍必须带令牌，否则 401。`boot`/`start` 另有**单飞**闸门（并发第二个 → 409）。读接口保持开放供本地工具探测
- **故障排查**：引擎起不来 → ① 浏览器开 `http://127.0.0.1:3081/` →"运行检查 → 修复 → 启动"；② `npx dsh-pm-boot --repair-only` 看自检与隔离列表；③ `npx dsh-pm-launcher --status` 看启动器/守护/引擎各自的真实状态与 `health.log` 最近一条；④ 需要交互式启动时 `npx dsh-pm-boot`（Windows 也可双击**包内** `bin\dsh-boot.cmd`，失败信息里会带引擎日志绝对路径）
- **完整命令表 / 退出码表 / `--uninstall` 四步 / 故障排查表**：[docs/LAUNCHER.md](docs/LAUNCHER.md)

> **健康判定与"停引擎"的安全性**：引擎/启动器就绪 = **HTTP 握手成功且响应带 dsh 身份指纹**（裸 TCP 监听器一律判不健康）。因此：3080、3081 或 3082 被别的进程占用时，工具会**明确报错并拒绝把端口当"已就绪"**，也不会静默换端口。引擎 `stopEngine()` 前会做三重校验（pid 存活 / 进程镜像为 node·dsh / 端口占用者与记录 pid 一致），校验不过一律拒绝并在救援页给出原因，需要时可在救援页点"强制停止"（或 `POST /api/stop {"force":true}`）。PID 文件：引擎为 `profile/.rescue-daemon.pid`、启动器为 `profile/.open-boot.pid`，都是 JSON（含 `app/pid/port/startedAt` 等字段）。
>
> **工作目录**：引擎与启动器统一使用**稳定 cwd**（默认用户主目录，可用 `--cwd <dir>` 或环境变量 `DSH_ENGINE_CWD` 覆盖）。早期版本会把 cwd 落在 `node_modules/dsh-plugin-manager-pro/bin`，导致插件自我更新/卸载时目录被占用（`ERR_PNPM_EPERM`）。
>
> ⚠️ **实现注意**：自启包装脚本一律是「wscript → node」，**不使用隐藏 PowerShell**——`powershell -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden ..."` 这类形态会被部分杀软（如火绒的 AMSI 提供者）判定为恶意并**直接删除脚本文件**。同理，守护拉起服务进程时刻意**不加 `windowsHide`**：libuv 的 `windowsHide` 会被子进程继承，导致"拉起引擎时弹窗"也变成隐藏窗口。

---

## 环境要求

- Windows 10/11 · macOS · Linux（`/rescue` 与三个 bin 工具全平台可用；**开机自启管理 `--install-autostart` 目前为 Windows**，macOS/Linux 可用 `--supervise` 自行加入系统自启）
- Node.js ≥ 18 · DeepSeek Harness `dsh`（全局安装或 npx）· `pnpm`（`dsh plugin` 与更新功能依赖）
- **引擎版本决定你该装哪一版**（见下表）——**装错版本 = 插件页不出现、甚至 profile 起不来**

### 引擎兼容性矩阵（DSH 引擎 × 本管理器版本）

> **引擎版本决定你该装哪一版**——装错版本 = 插件页不出现、甚至 profile 起不来。

| 你的 DSH 引擎 | 本管理器版本 | 状态 | 实测日期 | 备注 / 出处 |
|---|---|---|---|---|
| **0.1.7-rc.2** | **0.9.1**（当前版本；上一个发布版 0.9.0） | ✅ 可用 | 0.9.0：2026-09-28 彩排 + 干净环境装机验收；0.9.1：四套测试全绿（含启动器 **348 项断言**，其中 19 条在受限会话按沙箱边界 SKIP —— 不计通过也不计失败；**以 `node test-launcher.mjs --strict` 的输出为准**） | 隔离彩排环境（独立 `DSH_HOME` + 独立端口）引擎正常启动、侧边栏「插件管理」+ 五分区齐备（本文图 1/图 2/图 3 即该环境实拍）。出处：`docs/releases/0.9.0.md`、`docs/releases/0.9.0-verify.md`（干净环境装机验收）、`docs/releases/RELEASE_NOTES_0.8.3-1.md`（"引擎 0.1.7-rc.2：**零条目失败**"）、[docs/RELEASING.md](docs/RELEASING.md)（发布核对表） |
| **0.1.6 及以后**（含 0.1.6-alpha.2） | **0.9.1**（推荐） | ✅ 推荐（接管内置页） | 0.1.7-rc.2 已实测；**0.1.6-alpha.x 未逐一实测** | 官方从 0.1.6 起把插件管理页并进引擎；本包 `cordis.patch.yml` 停用的那一行 `ui-plugin-manager` 正是这版新增的官方页。出处：`cordis.patch.yml`、npm [`@deepseek-ai/dsh-client-ui-plugin-manager`](https://www.npmjs.com/package/@deepseek-ai/dsh-client-ui-plugin-manager) |
| **0.1.0-rc.6 ~ 0.1.5**（0.1.6 之前的引擎） | **0.8.2** | ✅ 可用（旧「设置 → 插件」tab 路线） | 0.8.2 发布于 2026-09-04；本机升级前的基线是引擎 0.1.1-rc.2 + 0.8.x | 0.8.x 与 0.9 是两套客户端（`docs/releases/0.9.0.md` ⑤），且 0.8.x 在 0.1.7 上不成立（见下一行）；**0.1.5 线未单独实测** |
| **0.1.7-rc.2** | **0.8.2 / 早期 0.8.3 构建** | ❌ 插件整体不激活 | 2026-09-28 彩排实测 | 两个原因都在彩排里复现过：① 0.1.7 起 typert strict codec 必须有 `create()` 工厂；② `dsh.client.inject` 引用的 `@deepseek-ai/dsh-client-runtime` 在 0.1.7 已被移除。0.8.3-1 与 0.9.x 已修（`docs/releases/RELEASE_NOTES_0.8.3-1.md`） |
| **0.1.6 及以后** | **任何声明同名 loader entry id 的第三方管理器**（如 LX2000WASD 0.6.x） | ❌ profile 起不来 | 竞品 2026-09 公告 | `TypeError: duplicate loader entry id: plugin-manager`（官方 `dsh-base` 行 id = `plugin-manager`）；本管理器用**自己的** id `plugin-manager-pro`，不撞车（见上文「老管理器为什么死」） |
| 0.1.6 之前且已装 0.9.x 起不来 | 回退：`dsh plugin --profile web add dsh-plugin-manager-pro@0.8.2` | ⚠️ 恢复路径 | — | 见下文"安装"里的回退命令 |

> **一句话**：**引擎越新越要 0.9.1；引擎很老（0.1.6 之前）才需要 0.8.2。** 0.1.6 这条分界线是唯一确定的，中间的 0.1.6-alpha.x 过渡版本未逐一实测。
> 表里的"实测"记录来自本机**彩排环境**、**干净环境装机验收**与**真机安装归档**（`docs/releases/0.9.0-verify.md`、开发者工作区 `upgrade-rehearsal/`、`audit/install-090/`；后两处原始日志不随 npm 包发布），引擎每次小版本发布后按 `docs/RELEASING.md` 重跑。

## 🔐 权限与数据范围

> 这一段回答"它到底动了我什么"。所有读写都在**本机 profile 目录**与**你自己配置的更新源**范围内：没有账号、没有云端、没有遥测。
> 下表逐条对应 `lib/` 的代码：写文件前都会先留 `.rescue-bak-*` 备份，写盘用「临时文件 + 改名」的原子写法。

| 数据 | 用途 | 是否外传 |
|---|---|---|
| `~/.dsh/profiles/<名字>/package.json` | 读已装插件清单（`dependencies` / `dsh.bundle` / `dsh.client`）；安装、卸载、场景等操作会写回，改前备份 | 否 |
| `~/.dsh/profiles/<名字>/cordis.patch.yml` | 读/写插件启用状态与隔离行（只动带 `Managed by dsh-plugin-manager-pro` 归属标记的部分，改前备份） | 否 |
| `~/.dsh/profiles/<名字>/plugin-manager.json`（侧车文件） | 操作历史（最近 20 条）、场景方案、来源人工修正、待清理列表、更新源配置 | 否 |
| `~/.dsh/profiles/<名字>/node_modules/**` | 读依赖反向图与包简介；卸载/隔离时经 `pnpm` 删除包目录（Windows 文件锁残留登记为"下次启动重试"） | 否（装卸时由 pnpm 自行访问 registry） |
| `~/.dsh/profiles/<名字>/vendor/downloads/*.tgz` | 归档暂存（浏览器下载的包）；仍被依赖引用的永不删除 | 否 |
| `$DSH_HOME/downloads/*` | 「下载目录自动安装」扫描归档；写 `.installed` / `.failed` 标记（删标记可重试） | 否 |
| 本机 npm 全局根（Windows `%APPDATA%\npm`，macOS/Linux `npm root -g` 与常见路径） | **只读**：定位引擎自带的 `@deepseek-ai/*`、提取插件简介 | 否 |
| 更新源：npm registry（默认 `registry.npmjs.org`）、插件超市 `dshfind.com`、GitHub、你添加的镜像（如 `registry.npmmirror.com`） | 查询最新版本、下载归档 | **只查询**（GET 版本元数据 / 下载归档），不上传本地数据 |
| GitHub API：`api.github.com`、`raw.githubusercontent.com`、`codeload.github.com` | 查 Release 与仓库 `package.json`、下载 tgz | 同上 |
| 精选目录 `awesome-dsh-plugin.com/plugins.json` | 拉「插件市场」目录（host 端 10 分钟缓存） | 同上 |
| 本机回环端口 `3080` / `3081` / `3082`（+ 守护锁 `4081 = 3081+1000`） | 主界面 / 启动器与救援页 / 独立备份救援服务 / 守护单实例锁；全部只绑 `127.0.0.1` | 否（不出本机） |
| Windows 注册表 `HKCU\...\Run\DSHWebFront` + profile 内 `open-boot-autostart.vbs`、`open-boot-ui.vbs` | **仅在你显式执行 `--install-autostart` 时写入**；`npx dsh-pm-launcher --uninstall-autostart`（或 `--uninstall`）可清理 | 否 |
| profile 内 `.rescue-daemon.pid`、`.open-boot.pid`、`rescue-daemon.log`、`open-boot-supervisor.log`、`health.log` | 守护/启动器的 PID、日志与自检留痕（`health.log` 保留 7 天 / 1000 行） | 否 |

> **不会碰的东西**：会话内容、`settings.yaml`、`.credentials.yaml`（API Key）——`lib/` 里没有读取它们的代码路径；救援与自检只读写 profile 的 `package.json`、`cordis.patch.yml` 与 pid/日志文件。

## 安装

> **推荐从 npm 安装**（`dsh plugin … add` 底层是 pnpm，会自动用引擎自带的 `@deepseek-ai/*`）。

```sh
# 方式一（推荐，引擎 ≥ 0.1.6）：npm
dsh plugin --profile web add dsh-plugin-manager-pro

# 方式二：刚发版时（或在 24 小时冷静期内）——显式写版本号，最可靠
dsh plugin --profile web add dsh-plugin-manager-pro@0.9.1

# 方式三：离线 tgz（GitHub Release 页下载，或 npm pack 自建）
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.9.1.tgz

# 老引擎（0.1.0-rc.6 ~ 0.1.5）或 0.9.x 装上去不生效时，回退到旧 UI 版
dsh plugin --profile web add dsh-plugin-manager-pro@0.8.2

# 重启 web 生效（客户端 bundle 在引擎启动时加载，装完必须重启）
dsh web
```

> **装不到 / 装完还是旧版？** 两种常见原因：① 引擎在**启动时**加载客户端 bundle——装完**必须重启** `dsh web`；
> ② pnpm 11 起有 **24 小时冷静期**（`minimumReleaseAge` 默认 1440 分钟），**当天刚发布的版本不带版本号会解析到旧版**——
> 用上面"方式二"的显式版本号即可绕过（也可把 `dsh-plugin-manager-pro@0.9.1` 加进 profile 的 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`）。

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
dsh plugin --profile web remove dsh-plugin-manager-pro   # 卸载前会自动调用下面的 --uninstall 清理自启/守护/shim
npx dsh-pm-launcher --uninstall-autostart                # Windows：清理开机自启（幂等）
npx dsh-pm-launcher --uninstall                          # 需要时：彻底清理启动器痕迹（停守护 + 删 DSHWeb* + 删 shim + 清 pid）
```

## 救砖入口速查

| 场景 | 怎么做 |
|---|---|
| 引擎正常，UI 坏了 | `http://127.0.0.1:3080/rescue`（救援页 / 右下角 🛟） |
| 引擎起不来 | `http://127.0.0.1:3081/rescue`（启动器内建的救援页；`/` 是"打开即启动"页）→ 运行检查 → 修复 → 启动。需要独立备份入口时：`npx dsh-pm-rescue`（默认 **3082**，与 3081 不抢端口） |
| 想要"打开即启动" | 浏览器主页设为 `http://127.0.0.1:3081/`（`http://localhost:3081/` 同样可用，同机同端口）；常驻+开机自启用 `npx dsh-pm-launcher --install-autostart` |
| 想要 3081 常驻但不想看窗口 | `npx dsh-pm-launcher --supervise`（守护静默；只有拉起引擎时才弹可见窗口，`--no-window` 可连窗口也关掉） |
| 想知道 3080/3081/3082/4081 到底什么状态 | `npx dsh-pm-launcher --status`（启动器身份 / 守护锁归属 / 引擎 HTTP 握手 / PID 文件 / 最后心跳），并追加一条 `health.log` 留痕 |
| 要彻底移除启动器（自启/守护/shim/pid） | `npx dsh-pm-launcher --uninstall`（退出码 0=完成 / 1=出错 / **2=归属未确认**：此时不动任何进程、保留 pid，换到能跑 `netstat`/`tasklist` 的会话重跑；引擎 3080 与日志保留） |
| 3081 打开的是别人的页面 | 端口被非本工具进程占用：`--status` 会报出占用者 pid；结束它，或用 `--port` 换端口并同步改浏览器主页（工具**不会**静默漂移端口） |
| 命令行一键自检+启动 | `npx dsh-pm-boot`（启动）或 `npx dsh-pm-boot --repair-only`（只自检+修复）；Windows 双击等价物是**包内** `bin\dsh-boot.cmd` |
| 装完界面还是旧的 | 引擎在**启动时**加载客户端 bundle——安装后必须重启 `dsh web`（或让启动器重新拉起引擎） |
| 启停插件后状态没变 | 引擎在启动时套用条目：启停会立即写入配置，但**生效需重启引擎**（界面会在需要重启时提示） |

---

## 工作原理

- **宿主端**（`lib/index.js`）：读取 Cordis Loader 实时状态（启用/运行期阶段/错误），经 Typert 网关暴露远程方法（list/setEnabled/update/verifyProfile/fixProfile/marketCatalog/…）。收敛判定基于引擎真实字段（`Entry.disabled` / `_initTask` / `fiber.state`），**不收敛时如实提示需要重启，不再谎报**
- **运行期错误**：从 cordis 的 `fiber._error` 取真实错误文本（诊断与救援页因此能看到失败原因）
- **插件页接管**（`src/client.jsx` + `cordis.patch.yml`）：客户端注册进 `main`（key=`plugins`）与 `sidebar.panellist`（id=`plugins`），包内 patch 先停用内置的 `ui-plugin-manager`；注册时声明内置插件页原有的 7 个 `plugins.*` 子槽位，其中第三方真正使用的三个（`plugins.row.config` / `plugins.bundle.config` / `plugins.item`）给出真实渲染出口——**未注册的键不会生成空按钮**
- **开关持久化**：写入 profile 的 `cordis.patch.yml`（带 `Managed by dsh-plugin-manager-pro` 注释行，不触碰用户自有补丁）
- **更新源聚合**（`lib/aggregate.js` + `compare-versions.js`）：多源并行 → 最高版本 → 并列随机；源级熔断（403/429 → 10 分钟冷却）；完整支持预发布段
- **下载器**（`lib/downloader.js`）：HTTP 直链流式；magnet/.torrent 优先外部下载器（跨平台 where/which 检测）→ 内置 webtorrent → 提示手动导入
- **跨平台**（`lib/platform.js`）：npm 全局根 Windows 用 `APPDATA\npm\node_modules`，macOS/Linux 用 `npm root -g` + 常见路径 + nvm 目录（10 分钟缓存）
- **独立救砖**（`lib/preflight.mjs` + `lib/enginectl.mjs`）：纯 Node 自检/修复 + 引擎生命周期，被三个 bin 工具复用；与 host 方法同源逻辑。端口分工：3081 = 启动器（唯一网页入口，自带 `/rescue`）、3082 = 独立备份救援服务、4081 = 守护锁
- **本地写接口防护**（`lib/enginectl.mjs` 的 `newApiToken` / `guardWriteRequest` / `createSingleFlight`）：`Origin` + 一次性令牌 + 单飞三道闸，第三方网页无法触发启动/停止
- **健康留痕**：`--status` 每次把结论追加到 `profile/health.log`（`OK|FAIL boot=…@3081 engine=…@3080`，保留 7 天 / 1000 行）
- **受保护条目**：管理器自身、loader 基础设施、webserver/connection/ui-layout 等禁开关；救援 `RESCUE_NEVER` 与自动隔离的**保护集**同源，自动隔离还需连续失败达阈值
- **详细架构**（进程图、槽位契约、侧车字段、卸载事务数据流）：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；命令行口径：[docs/LAUNCHER.md](docs/LAUNCHER.md)

---

## 开发与测试

```sh
npm install                                  # 如遇 npm 拦截 esbuild 安装脚本：npm approve-scripts esbuild
npm run build                                # esbuild 打包浏览器端 → lib/client.js
npm test                                     # build + bundle + render + integration + launcher 全套
node test-launcher.mjs --strict               # 启动器单测（随机端口 + 临时 profile，不碰真 profile/注册表）
node tools/test-host-fixes.mjs                # 宿主侧修复的回归断言
npm run check:vendor                          # 迁移件内容级校验（tgz 内文件 sha256 == 工作树）
npm run pack                                  # build + npm pack（产出安装用 tarball）
node tools/dev/gen-changelog.mjs              # 从 docs/releases/*.md 生成 CHANGELOG.md
node tools/dev/gen-changelog.mjs --check      # 校验 CHANGELOG.md 与发布说明一致（不一致 exit 1）
```

文档：发布流程 [`docs/RELEASING.md`](docs/RELEASING.md)（本地验证 → bump 版本 → **在最后一轮改动之后再打包** → 内容级 `check:vendor` 校验 → 打 tag 发 **GitHub Release** 附 tgz）；架构 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；命令行 [`docs/LAUNCHER.md`](docs/LAUNCHER.md)；版本历史 [`CHANGELOG.md`](CHANGELOG.md)（脚本生成）与 [`docs/releases/`](docs/releases/)。

## 常见问题（排错）

| 现象 | 原因与解决 |
|---|---|
| 装完界面还是旧的 / 新页面不出现 | 客户端 bundle 在引擎启动时加载：**必须重启 `dsh web`**（或让启动器重新拉起引擎） |
| 启停插件后列表状态没变 | 引擎在启动时套用条目：配置已写入，**重启引擎后生效**（界面会在需要重启时提示） |
| `dsh plugin add` 报 "Already up to date" 不更新 | pnpm 按版本号缓存 tarball；**修改后必须升版本号**再 add |
| 引擎起不来（坏 bundle 进 package.json） | 开 `http://127.0.0.1:3081/rescue`（启动器内建救援页）→ 运行检查 → 修复 → 启动；或 `npx dsh-pm-boot --repair-only` |
| 3081 上没有 `/rescue` 页 | 0.9.0 及更早：救援页只挂在 open-boot 的 `/` 流程里（或 3082 的独立守护上）。0.9.1 起 `/rescue` 与 `/rescue/api/*` 就绪在 3081；升级插件即可 |
| 担心第三方网页能触发启动/停止 | 不会：写接口要**同源 `Origin` + 一次性令牌**（`X-DSH-PM-Token`），并发还受单飞闸门限制（403 / 401 / 409）——见 [docs/LAUNCHER.md](docs/LAUNCHER.md) §4 |
| 救砖页自检总报"patch 解析失败" | 已修复：注释开头的合法 patch 不再被误判损坏；升级插件即可 |
| 修复 `cordis.patch.yml` 被误判、日志误报 | 自检逻辑与宿主 `verifyProfile` 同源（`lib/preflight.mjs`），升级后回溯修复均为可逆备份 |
| 浏览器报 `waiting for service: remote.xxx` | 客户端 inject 不能包含自身挂载的 remote（死锁）；inject 只保留 `["slots","locale","remote"]` |
| 第三方插件没有 ⚙ 配置入口 | 0.9.0 起会为它注册的槽位生成入口；若该插件尚未适配 0.1.7 的槽位，请向插件作者反馈 |
| P2P 磁力链接无法下载 | 安装 aria2c（自动启用）或装 webtorrent，或用 NDM/比特彗星手动导入 |

## 许可证

MIT。补丁持久化机制借鉴 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)（MIT）。

---

## English

An English README lives at [README.en.md](README.en.md) (功能清单与命令与中文版一致). Quick version:

A local plugin manager for DeepSeek Harness. Since **0.9.0** the manager is a **standalone page** (sidebar entry "Plugin manager") instead of a tab inside Settings: five sections — **Official built-ins (optional) · All plugins · Market · Operations & scenarios · Maintenance**. It also ships a **standalone brick-rescue toolchain**: `open-boot` (the single web entry on **3081**, boot page `/` + rescue page `/rescue`), `rescue-daemon` (independent backup rescue service on **3082**), and `dsh-boot` (Steam-style boot sequence with exit codes). Cross-platform, zero new runtime dependencies.

Install: `dsh plugin --profile web add dsh-plugin-manager-pro` (pin `@0.9.1` if the release is less than 24 h old — pnpm's `minimumReleaseAge` default blocks brand-new versions) → restart `dsh web` → open the sidebar "Plugin manager". Details: [README.en.md](README.en.md).
