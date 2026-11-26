<p align="center"><img src="docs/images/logo.svg" width="88" height="88" alt="DSH 引擎船坞 drydock"></p>

# DSH 引擎船坞（dsh-drydock，原名 dsh-plugin-manager-pro）

> **当引擎起不来的时候，它还在。** 为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 提供**启动期可靠性工具链**：独立进程、独立端口的启动前自检、坏插件隔离、引擎拉起与救援（3081 / 3082），外加一个顺手的插件管理台。日常的逛与装请用官方插件页或插件市场——我们不重复做。

![badge](https://img.shields.io/badge/dsh-0.1.7+-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![version](https://img.shields.io/npm/v/dsh-drydock?color=orange) ![npm](https://img.shields.io/npm/dt/dsh-drydock)

> 社区/本地插件，非 DSH 官方包。npm：`dsh-drydock`（原名 `dsh-plugin-manager-pro`，旧包将加弃用标记、不删包）· GitHub：[nonentity303/dsh-drydock](https://github.com/nonentity303/dsh-drydock) · 跨平台（Windows / macOS / Linux）
>
> **正式发布版 1.0.0**（npm `latest`，2026-11-25 发布）。核对：`npm view dsh-drydock version`；标签见 <https://github.com/nonentity303/dsh-drydock/tags>。
> ⚠️ **正在更名为 `dsh-drydock`（引擎船坞）**：GitHub 仓库已改名（旧链接自动跳转）；npm 包名将在下个版本迁移，旧名届时加弃用标记（不删包）。安装方式见下文[安装](#安装--更新--卸载)。
> ⚠️ 刚发布的版本会被 pnpm 的 24 小时冷静期（`minimumReleaseAge`）挡住，装不到时请**显式写版本号**（见下文[安装](#安装--更新--卸载)）。

**本管理器接管引擎内置的插件管理页，并补上官方不做的部分**：装卸的完整闭环（影响预览 → 事务化卸载 → 失败回滚 → 一键撤销）、操作历史与场景方案、引擎不可用时依然可用的兜底管理页，以及**主引擎起不来时的独立救援工具链**。任一载体失效时，其余载体仍可完成启停、卸载与恢复操作。

### 定位：装完之后的事，交给引擎船坞

| 场景 | 谁来管 |
| --- | --- |
| 找插件、逛市场、一键装 | 官方插件页 / 插件市场（dshmarket 等）——这条赛道已封顶；本工具**不自建目录**，市场页签只是借 dshfind 目录的顺手入口 |
| 装坏了怎么办 | **本工具**：事务化卸载（影响预览 → 体检 → 备份 → 删除 → 验证 → 失败自动回滚）+ 一键撤销（最近 20 次操作留痕） |
| 装多了怎么管 | **本工具**：来源三分区 + 场景方案（启停组合一键切换）+ 操作历史 |
| 引擎起不来怎么办 | **本工具**：独立进程 3081 的 `verify / fix / start / stop / status`，不依赖 Cordis 运行时；带明确退出码，可被脚本/外部调用 |

> **一句对外口径**：官方与插件市场负责「装进来」；我们负责「装完之后」——装坏了能撤、引擎崩了能救。**它修这次启动，我们修下一次为什么还会坏。**
>
> **不做清单**（请直接使用对应工具，不必在本工具里找）：备份恢复 / WebDAV · 主题切换 · 安全静态扫描 · 评论区与截图分享——这些 dshmarket 已成熟；本工具只专注运维与救援，不做它们的替代品。

![独立插件页：侧边栏一级入口「插件管理」+ 五个页签](https://raw.githubusercontent.com/nonentity303/dsh-drydock/master/docs/images/pm-090-official2.png)

<sub>**图 1** · 独立插件页实拍：侧边栏一级入口「插件管理」，页签为 官方内置（可选）· 全部插件 · 插件市场 · 操作与场景 · 维护。**1.0 起列表内部改为来源三分区**（见下文），页签结构不变。源图：`docs/images/pm-090-official2.png`。</sub>

---

## 载体一览

| 载体 | 入口 | 说明 |
| --- | --- | --- |
| **管理台（3080）** | `http://127.0.0.1:3080` → 侧边栏「插件管理」 | 接管引擎内置插件页；功能最全的日常入口，跟随 DSH 主题变量 |
| **兜底页（3081）** | `http://127.0.0.1:3081/plugins` | 纯 Node 进程托管，不依赖引擎运行；扁平设计，深浅主题（自动跟随引擎外观与系统偏好） |
| 启动页（3081） | `http://127.0.0.1:3081/` | 打开即自检并启动引擎（浏览器主页设为它 = "打开即启动"） |
| 救援球 🛟 | 3080 右下角浮动按钮 | 可拖动换位（位置持久记忆），单击打开救援页 |
| 救援页 | `http://127.0.0.1:3081/rescue` | verify / fix / start / stop / status 全套修复能力 |

## ✨ 亮点

- **独立插件页**：插件管理不挤在设置页里——侧边栏一级入口，一个页面完成看插件、装插件、**配插件**、卸插件、救引擎
- **来源三分区列表**（v1.0）：核心组件（锁定）/ 引擎内置组件 / 用户插件，语义与引擎实际情况一一对应；来源筛选与分区联动
- **第三方配置入口有落点**：插件行内一行摘要，展开即是它自己的完整配置卡片（`plugins.row.config` / `plugins.bundle.config` 槽位）
- **事务化卸载**（v1.0 加固）：卸载前**影响预览与体检** → 备份 → `pnpm remove` → 清理补丁条目 → 逐项验证 → **失败自动回滚**；卸载后可**一键撤销**
- **操作历史 + 场景方案**：最近 20 次操作留痕可撤销；插件组合保存为命名场景，一键切换（应用前展示变更预览）
- **兜底页独立于引擎**（v1.0）：引擎挂了，`http://127.0.0.1:3081/plugins` 依然能启停 / 更新 / 卸载 / 体检 / 重启引擎
- **多源更新聚合**：npm registry / 插件超市 dshfind / GitHub / 自定义镜像并行查询，限流熔断，公平取最高版本
- **浏览器即启动器**：主页设为 `http://127.0.0.1:3081/`，打开浏览器 = 自动自检 → 修复 → 启动 → 跳转主界面
- **本地写接口有防护**（v0.9.1）：`Origin`（同机同端口白名单）+ 一次性令牌 + 单飞闸门，第三方网页无法触发启动/停止

## 📋 功能总览（1.0.0）

### 管理台（3080）

#### 分区模型（v1.0）

插件列表按来源分三区，语义与引擎实际情况一一对应：

| 分区 | 判定 | 行为 |
| --- | --- | --- |
| **核心组件（引擎必需，不允许禁用）** | 包名白名单（dsh-base / dsh-web-app） | 锁定展示，开关与卸载均拒绝 |
| **引擎内置组件** | 引擎自带（origin=builtin） | 可启停、可查看；行徽章「内置」，区内按名称排序 |
| **用户插件** | 用户安装（origin=user） | 完整操作：启停 / 更新 / 卸载 / 配置 |

- 「推荐」不再是分区，而是**行内标签**：仅真正的第三方推荐加装件（如 browser-control）显示，重要引擎组件不再混入推荐清单
- 来源筛选（全部 / 架构自带 / 用户安装）、搜索、分区折叠与计数互相联动
- **来源人工修正**：自动判定来源标签（npm / GitHub / 本地 / 内置），每行可手动覆盖并持久化
- **状态一目了然**：启用状态（🔴 错误/需检查 · 🟡 需更新 · ⚪ 未启用 · 🟢 启用）、名称、功能简介、已装→最新版本 + 来源、开关按键
- **简介自动提取**：内置中文目录优先；未收录的 mod 自动从 `README.zh.md`（优先）/ `package.json.description` / `README.md` 提取一句话简介
- **核心保护**：核心组件白名单行禁止开关与卸载（🔒 标记）

#### 页签

- **官方内置（可选）**：引擎自带、默认未启用的组合包一键启用/停用 + 版本豁免
- **全部插件**：插件清单（见上文分区模型）
- **插件市场**：dshfind 精选目录，一键安装（见下文）
- **操作与场景**：事务化卸载与影响预览、**卸载前体检**、操作历史一键撤销、场景方案
- **维护**：更新源与刷新、启动前自检、救援中心入口、下载目录

行内操作：启停开关（写前自动备份）、市场详情、卸载（卸载前体检预览）、配置页（运行时 slot 注册的插件）。

#### 管理器自身的禁用与卸载（统一口径）

管理器不能在自身管理界面（3080）中停用自己；如需禁用或卸载，请前往启动器兜底页（3081 /plugins）或使用 dsh 命令行——兜底页独立于引擎存活，禁用后仍可恢复。

3080 内允许的例外是**卸载**：走额外警告路径，卸载前自动清理开机自启，结果写入卸载报告；卸载后 3080 管理界面消失、3081 兜底页存活至启动器进程结束。

### 🔐 事务化卸载、历史与场景

- **卸载影响预览**：卸载前展示「影响范围」——依赖该包的已安装插件（`dependencies` / `peerDependencies` 反向图）、将移除的插件条目、将清理的开关行、bundles 声明
- **事务化卸载**：备份 `package.json` + `cordis.patch.yml`（`.rescue-bak-*`）→ `pnpm remove` + 清理补丁条目 + 移除 bundles/开关行 → 逐项验证 → **任何失败自动回滚**；Windows 文件锁残留目录登记 `pendingRemovals`，下次启动自动清理
- **加固（v1.0）**：`pnpm remove` 超时或进程状态不明时**不**盲目回滚——标记「未知」请人工确认，避免把半删状态变成更坏状态；EBUSY 引导（引擎运行中且目标启用时拒绝硬删，提示「先禁用 → 重启引擎 → 再操作」）
- **卸载报告**：自检结果、清理开关行数、级联卸载包、残留列表；支持级联卸载依赖它的可卸载包
- **卸载前体检**（v0.9.1）：预览里给出**结论行**（安全 / 需注意 / 有风险 + 一句理由），并列出三类检查——① 依赖断裂 ② `cordis.patch.yml` 补丁残留（**只提示、绝不自动删**）③ service 与端口冲突
- **操作历史**：最近 20 次操作（卸载/启停/隔离/场景应用/重置开关），一键撤销，侧车持久化跨重启
- **场景方案**：把当前启停状态保存为命名场景（如「办公/写作/演示」），一键应用——先展示**变更预览**，确认后切换；可更新、删除
- **卸载管理器自身前先清理自启**：删包之前先调用包内 `bin/open-boot.mjs --uninstall`（旧版本无该能力 → 记为"已跳过"，不阻断卸载）

### 📥 更新与下载

- **多源并行 + 权重一致**：所有启用源并行查询取最高版本；并列时随机挑选
- **限流熔断**：GitHub API 403/429 自动冷却 10 分钟；全量刷新 8 并发、结果缓存 30 分钟
- **下载优先级**：① 浏览器原生下载（隐藏 iframe，NDM 等扩展可捕获）→ ② 外部下载软件 → ③ 内置下载器兜底（HTTP 直链 / aria2c / P2P magnet·torrent）
- **下载目录自动安装**：`.tgz` / `.tar.gz` 放入 `$DSH_HOME\downloads` → 自动拾取安装；**安装前做清单校验 + 启动前自检，失败自动回滚并标记 `.failed`（不再反复重试）**

### 🛒 插件市场

- **dshfind 精选目录**：带本地化描述 / 星标 / 收录日期与分类；条目数随上游变化，host 端 10 分钟缓存。在线不可用自动兜底 GitHub `topic:dsh-plugin` 搜索
- **零往返过滤**：目录一次拉全量，搜索 / 分类 chips / 排序 / 分页全部客户端本地完成
- **一键安装**：带 npm 名的条目优先 **npm registry 直装**；GitHub 仓库走内置下载器；两步确认防误触；已装 ✓ 徽标
- **装后防砖校验**：自动验证 `dsh.bundle` / `dsh.client` 清单，缺失自动卸载；pnpm hoist 漂移 / `minimumReleaseAge` 陷阱自动恢复

### 🛟 兜底页（3081 /plugins，v1.0 新增）

引擎不可用时依然可用的管理入口（纯 Node 进程托管，扁平设计 + 深浅主题）：

- **启停 / 更新 / 卸载**：toggle 写 `dsh.profile.bundles`（写前备份）；`pnpm outdated` 批量比对、逐个更新；事务性卸载（同上，每步落日志）
- **mod 体检**：只读 preflight + 引擎日志尾部按包聚合，verdict 三档（ok / suspect / broken）
- **重启引擎 / 停止启动器**：确认框 + toast，写接口全部走 Origin + 一次性令牌防护
- **有意不做**：行内配置面板、场景管理、下载诊断（依赖引擎 Cordis 运行时，与兜底页定位冲突）——完整功能在 3080 管理台

### 🛟 救援

- **独立救援页 `/rescue`**：自包含 HTML 直连宿主网关，UI 全坏仍可诊断/隔离/一键修复/重启/卸载
- **浮动救援球**：右下角 🛟 按钮，可拖动换位（位置记忆），设置页损坏时的入口
- **自动隔离**：可选开关（**默认关**），只隔离**连续失败达阈值**的插件；界面骨架与基础设施条目在保护集内，永不自动禁用
- **启动前自检**：`verifyProfile` / `fixProfile`——坏 bundle 会在启动阶段拖垮引擎，一键检查与隔离修复
- **运行期失败条目自动隔离**：启动失败后自动**解析启动日志 → 隔离失败条目 → 重试**，隔离行带备份可逆（3081 的「重启引擎」也会执行一次）

![维护 → 救砖：诊断中心](https://raw.githubusercontent.com/nonentity303/dsh-drydock/master/docs/images/pm-maintenance-rescue.png)

<sub>**图 2** · 维护页签的「诊断中心」实拍：一键修复引擎 / 重启引擎 / 启动前自检 / 失败插件自动隔离。源图：`docs/images/pm-maintenance-rescue.png`。</sub>

## 🧰 独立救援工具链（核心亮点）

> 引擎不可用时，宿主编排的恢复界面（含插件市场内建的恢复面板）能力受限。本工具的差异是**进程级**：救援链跑在独立进程、独立端口（3081），`verify / fix / start / stop / status` 带明确退出码（0 就绪 / 1 启动失败 / 2 修复未完成），可被外部脚本调用，不依赖主引擎是否活着。零新依赖（纯 Node + 项目已有 yaml）。

| 工具 | 用途 | 用法 |
|---|---|---|
| `bin/open-boot.mjs` | **唯一网页入口 + 常驻守护**（3081）：`/` 是"打开即启动"页；**`/plugins` 是兜底管理页**（v1.0）；`/rescue` 是救援页。设为浏览器主页即"打开即启动"。平时完全隐藏，只有引擎需要拉起时才弹一个可见启动窗口（`--no-window` 可关）。健康判定 = HTTP 握手 + 身份指纹；写接口带 Origin + 一次性令牌防护；`--uninstall` 一键清理（退出码 0/1/2，2 = 归属未确认时不动任何进程） | `npx dsh-drydock` |
| `bin/rescue-daemon.mjs` | **独立备份救援守护**（默认端口 **3082**）：自包含中文救援页 + `verify/fix/start/stop/status` API，不依赖主引擎。**不与 3081 抢端口**（被占时明确报错退出，不静默漂移） | `npx dsh-drydock-rescue`（默认 3082） |
| `bin/dsh-boot.mjs` / `.cmd` | **Steam 式启动序列**：verify → 自动隔离坏插件 → 启动 → 健康等待。`--repair-only` 只自检+修复不启动；退出码 0=就绪 / 1=启动失败 / 2=修复未完成；启动即失败会**立即返回**并打印日志绝对路径 | `npx dsh-drydock-boot`（Windows 双击：**包内** `bin\dsh-boot.cmd`） |

> 端口的完整分工、退出码表、写接口防护与 `--uninstall` 四步见 [docs/LAUNCHER.md](docs/LAUNCHER.md)；进程与槽位架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

#### 启动器常驻与开机自启

| 命令 | 作用 |
|---|---|
| `npx dsh-drydock --supervise [--interval 60] [--heartbeat-min 10]` | **常驻守护**：静默确保 3081 有服务；锁端口（`port+1000`）单实例；只有 HTTP 握手失败才拉起，绝不误杀健康实例 |
| `npx dsh-drydock --ensure` | 一次性确保 3081（桌面快捷方式用，退出码 0/1） |
| `npx dsh-drydock --status` | **状态自检 + 健康留痕**：启动器/守护/引擎/PID/cwd/日志与最后心跳；每次追加一行 `profile/health.log`（保留 7 天 / 1000 行） |
| `npx dsh-drydock --install-autostart` | **写开机自启**（Windows）：HKCU Run + 登录静默常驻；包装脚本正文纯 ASCII，中文用户名/含空格路径不乱码 |
| `npx dsh-drydock --uninstall-autostart` / `--autostart-status` | 移除自启 / 查看状态；未安装时**幂等**（exit 0） |
| `npx dsh-drydock --uninstall` | **卸载闭环**：三重归属校验停守护 → 删 HKCU\...\Run 下**所有** `DSHWeb*` 值 → 删 shim → 清 pid（**日志保留**）。退出码 0=完成 / 1=出错 / **2=归属未确认**（不动任何进程、保留 pid）；引擎 3080 不动。管理器卸载自身前会自动调用它 |
| `npx dsh-drydock --help` / `npx dsh-drydock-boot --help` | 显示用法（参数不再被静默忽略） |

> **健康判定与"停引擎"的安全性**：引擎/启动器就绪 = **HTTP 握手成功且响应带 dsh 身份指纹**（裸 TCP 监听器一律判不健康）。端口被别的进程占用时明确报错，不静默换端口。`stopEngine()` 前三重校验（pid 存活 / 进程镜像 / 端口归属），不过一律拒绝，需要时可在救援页"强制停止"。PID 文件均为 JSON（`profile/.rescue-daemon.pid` / `.open-boot.pid`）。
>
> ⚠️ **实现注意**：自启包装脚本一律「wscript → node」，不用隐藏 PowerShell（会被部分杀软误判删除）；守护拉起引擎时刻意不加 `windowsHide`。

## 环境要求

- Windows 10/11 · macOS · Linux（`/rescue` 与三个 bin 工具全平台可用；**开机自启管理目前为 Windows**）
- Node.js ≥ 18 · DeepSeek Harness `dsh`（全局安装或 npx）· `pnpm`（`dsh plugin` 与更新功能依赖）
- 端口（均只监听 `127.0.0.1`）：**3080** 引擎主界面 · **3081** 启动器（启动页 / 兜底页 / 救援页）· **3082** 备份救援 · **4081**（3081+1000）守护单实例锁；`DSH_LAUNCHER_PORT` / `DSH_ENGINE_PORT` 可覆盖

### 引擎兼容性矩阵

| 你的 DSH 引擎 | 本管理器版本 | 说明 |
|---|---|---|
| **≥ 0.1.7-rc.2**（含 0.2.x，`<0.3.0-0`） | **1.0.0**（推荐）／ 0.9.1 | 独立插件页 + 兜底页 + 救援工具链全套；1.0.0 实测于 0.2.x 引擎（三分区 / 统一口径 / 事务卸载，隔离环境 + 主环境双验证） |
| 0.1.6 及以后 | 0.9.1 | 官方 0.1.6 起内置插件管理页，本包接管（停用 `ui-plugin-manager` + 自己的行 id） |
| **0.1.0-rc.6 ~ 0.1.5**（老引擎） | **0.8.2** | 旧「设置 → 插件」tab 路线；0.8.x 在 0.1.7 上不成立（typert strict codec / runtime 依赖移除） |

> **一句话**：引擎越新越要 1.0.0；引擎很老（0.1.6 之前）才需要 0.8.2。回退：`dsh plugin --profile web add dsh-plugin-manager-pro@0.8.2`。

## 🔐 权限与数据范围

> 回答"它到底动了我什么"。所有读写都在**本机 profile 目录**与**你自己配置的更新源**范围内：没有账号、没有云端、没有遥测。写文件前都会先留 `.rescue-bak-*` 备份，写盘用「临时文件 + 改名」的原子写法。

| 数据 | 用途 | 是否外传 |
|---|---|---|
| `~/.dsh/profiles/<名字>/package.json` | 读已装插件清单；安装、卸载、场景等操作会写回，改前备份 | 否 |
| `~/.dsh/profiles/<名字>/cordis.patch.yml` | 读/写插件启用状态与隔离行（只动带归属标记的部分，改前备份） | 否 |
| `~/.dsh/profiles/<名字>/plugin-manager.json`（侧车） | 操作历史（20 条）、场景方案、来源人工修正、待清理列表、更新源配置 | 否 |
| `~/.dsh/profiles/<名字>/node_modules/**` | 读依赖反向图与包简介；卸载/隔离时经 `pnpm` 删除 | 否（装卸时由 pnpm 访问 registry） |
| `$DSH_HOME/downloads/*` | 「下载目录自动安装」扫描归档；写 `.installed` / `.failed` 标记 | 否 |
| 本机 npm 全局根 | **只读**：定位引擎自带的 `@deepseek-ai/*`、提取简介 | 否 |
| 更新源（npm registry / dshfind / GitHub / 你加的镜像） | 查询最新版本、下载归档 | **只查询**，不上传本地数据 |
| 本机回环端口 3080 / 3081 / 3082 / 4081 | 主界面 / 启动器 / 备份救援 / 守护锁；全部只绑 `127.0.0.1` | 否（不出本机） |
| Windows 注册表 `HKCU\...\Run\DSHWebFront` | **仅在显式执行 `--install-autostart` 时写入**；`--uninstall-autostart` 可清理 | 否 |
| profile 内 `.rescue-daemon.pid`、`.open-boot.pid`、`health.log` 等 | 守护/启动器的 PID、日志与自检留痕（7 天 / 1000 行） | 否 |

> **不会碰的东西**：会话内容、`settings.yaml`、`.credentials.yaml`（API Key）——`lib/` 里没有读取它们的代码路径。

## 安装 / 更新 / 卸载

> **推荐从 npm 安装**（`dsh plugin … add` 底层是 pnpm，会自动复用引擎自带的 `@deepseek-ai/*`；不要在 profile 目录里直接 `npm install`——npm 对引擎预发布 peer 的解析在不同版本下表现不一，可能 `ERESOLVE`）。

```sh
# 方式一（推荐）：npm
dsh plugin --profile web add dsh-drydock

# 方式二：刚发版时（或在 24 小时冷静期内）——显式写版本号，最可靠
dsh plugin --profile web add dsh-drydock@1.0.0

# 方式三：离线 tgz（GitHub Release 页下载，或 npm pack 自建）
dsh plugin --profile web add ./dsh-drydock-1.0.0.tgz

# 老引擎（0.1.0-rc.6 ~ 0.1.5）或 0.9.x 装上去不生效时，回退到旧 UI 版
# （0.8.2 只存在于旧包名 dsh-plugin-manager-pro 下，回退命令保留旧名）
dsh plugin --profile web add dsh-plugin-manager-pro@0.8.2

# 重启 web 生效（客户端 bundle 在引擎启动时加载，装完必须重启）
dsh web
```

> **装不到 / 装完还是旧版？** ① 客户端 bundle 只在引擎**启动时**加载——装完必须重启 `dsh web`；
> ② pnpm 11 起有 **24 小时冷静期**（`minimumReleaseAge` 默认 1440 分钟），当天刚发布的版本不带版本号会解析到旧版——用"方式二"的显式版本号即可（也可把 `dsh-drydock@1.0.0` 加入 profile 的 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`）。

装好后两个入口：3080 侧边栏**「插件管理」**（内置插件页已接管）；3081 `http://127.0.0.1:3081/plugins`（引擎不可用时仍可用）。浏览器主页设为 `http://127.0.0.1:3081/` = 打开即自检启动引擎。

```sh
# 更新：3081 兜底页「检查更新」→「更新」，或
pnpm update dsh-drydock --latest --dir <profile>

# 卸载：3081 兜底页「卸载」（带备份、验证与失败回滚），或
dsh plugin --profile web remove dsh-drydock   # 卸载前自动清理自启/守护/shim
npx dsh-drydock --uninstall-autostart                # Windows：清理开机自启（幂等）
npx dsh-drydock --uninstall                          # 需要时：彻底清理启动器痕迹（引擎 3080 与日志保留）
```

## 救援流程速查

| 症状 | 入口 |
| --- | --- |
| 引擎在跑，但 3080 界面/插件页异常 | 3080 右下角 🛟 救援球，或 `http://127.0.0.1:3080/rescue` |
| 引擎起不来、3080 打不开 | `http://127.0.0.1:3081/`：自检 → 修复 → 启动 → 跳转带 token 的入口 URL |
| 插件被禁用到界面起不来 | `http://127.0.0.1:3081/plugins` 直接 toggle（该页不依赖引擎） |
| 某个插件把引擎打挂 | 3081 `/plugins` → mod 体检看 verdict → 禁用观察或卸载（带备份与验证） |
| 卸载/更新被引擎占用 | 拒绝硬删并引导：先禁用 → 重启引擎 → 再操作 |
| 需要独立于 3081 的备份救援入口 | `npx dsh-drydock-rescue`（默认 3082，不抢端口） |
| 想知道 3080/3081/3082/4081 到底什么状态 | `npx dsh-drydock --status`（并追加一条 `health.log` 留痕） |
| 命令行一键自检+启动 | `npx dsh-drydock-boot`（启动）或 `npx dsh-drydock-boot --repair-only`（只自检+修复） |
| 彻底移除启动器 | `npx dsh-drydock --uninstall`（退出码 2 = 归属未确认：不动任何进程） |

> **已知限制**：入口 token URL 只有在引擎 stdout 落到 `<DSH_HOME>/logs/web.log` 时才取得到（启动器经 `enginectl` 拉起时正常落盘）。若引擎由其他路径拉起（如 `dsh-boot` 的弹窗路径），3081 可能给不出可直接跳转的链接——到 `/rescue` 执行一次「重启引擎」即可恢复。

## API 参考（3081）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 启动器 + 引擎状态 |
| POST | `/api/boot` | 自检启动（单飞闸门） |
| POST | `/api/launcher/stop` | 优雅停止本启动器（pid 归属校验） |
| GET/POST | `/plugins/api/bundles` | 列出 / 启停 bundle（写前备份） |
| GET | `/plugins/api/updates` | `pnpm outdated` 投影用户插件 |
| POST | `/plugins/api/update` | 更新单个用户插件（EBUSY 引导） |
| POST | `/plugins/api/uninstall` | 事务性卸载（steps 日志；超时/进程不明时标记「未知」不回滚） |
| GET | `/plugins/api/health` | mod 体检（只读） |
| POST | `/plugins/api/engine/restart` | 重启引擎（失败条目自动隔离一次） |
| GET/POST | `/rescue/api/*` | 救援中心 verify / fix / start / stop / status |

写接口（POST）需要同源 Origin + `X-DSH-PM-Token`（页面 meta 自动携带，不落盘、不写日志）。

## 工作原理

- **宿主端**（`lib/index.js`）：读取 Cordis Loader 实时状态（启用/运行期阶段/错误），经 Typert 网关暴露远程方法（list/setEnabled/update/verifyProfile/fixProfile/marketCatalog/…）。收敛判定基于引擎真实字段，**不收敛时如实提示需要重启，不谎报**
- **来源三分区判定**（v1.0）：核心组件 = 包名白名单；内置/用户 = 引擎 origin 字段（origin=builtin / origin=user），与引擎实际状态一一对应
- **运行期错误**：从 cordis 的 `fiber._error` 取真实错误文本（诊断与救援页能看到失败原因）
- **插件页接管**（`src/client.jsx` + `cordis.patch.yml`）：客户端注册进 `main`（key=`plugins`）与 `sidebar.panellist`（id=`plugins`），patch 停用内置 `ui-plugin-manager`；用自己的行 id `drydock` 不与官方同名；注册内置页原有的 `plugins.*` 子槽位，第三方配置卡片有真实渲染出口
- **开关持久化**：写入 profile 的 `cordis.patch.yml`（带归属注释行，不触碰用户自有补丁）
- **更新源聚合**（`lib/aggregate.js` + `compare-versions.js`）：多源并行 → 最高版本 → 并列随机；源级熔断；完整支持预发布段
- **下载器**（`lib/downloader.js`）：HTTP 直链流式；magnet/.torrent 优先外部下载器 → 内置 webtorrent → 提示手动导入
- **跨平台**（`lib/platform.js`）：npm 全局根按平台定位（10 分钟缓存）
- **独立救援**（`lib/preflight.mjs` + `lib/enginectl.mjs`）：纯 Node 自检/修复 + 引擎生命周期，被三个 bin 工具复用；与 host 方法同源逻辑
- **本地写接口防护**：`Origin` + 一次性令牌 + 单飞三道闸，第三方网页无法触发启动/停止
- **详细架构**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；命令行口径：[docs/LAUNCHER.md](docs/LAUNCHER.md)

## 测试 / 构建

```bash
npm install                                  # 如遇 npm 拦截 esbuild 安装脚本：npm approve-scripts esbuild
npm ci                                       # 依赖树必须来自 lockfile（见 docs/RELEASING.md §2bis）
node build.mjs                               # src/client.jsx -> lib/client.js（可复现：连跑两次哈希相同）
node test-bundle.mjs                         # 构建产物契约（含 origin 来源契约，11 项）
node test-render.mjs                         # jsdom 真渲染回归（分区模型 / 徽章 / 推荐标签等 19 项）
node test-integration.mjs                    # host 逻辑进程内集成（需 devDependency @deepseek-ai/dsh-home-paths）
node test-transactional.mjs                  # 事务性卸载回归
node test-launcher.mjs                       # 启动器全量回归（354 项；--strict 把已知写域外缺陷算失败）
node tools/smoke-plugins-api.mjs             # 独立端口 + 临时 DSH_HOME 的 /plugins API 冒烟（28 项）
npm run check:vendor                         # 迁移件内容级校验（tgz 内文件 sha256 == 工作树）
node tools/dev/gen-changelog.mjs             # 从 docs/releases/*.md 生成 CHANGELOG.md（--check 校验一致）
npm run pack                                 # build + npm pack（产出安装用 tarball）
```

> `test-launcher.mjs` 会重写 `<DSH_HOME>/scripts/dsh-launcher.cmd`；不想动真实 `~/.dsh` 时先设 `DSH_HOME=<临时目录>`。

文档：发布流程 [`docs/RELEASING.md`](docs/RELEASING.md)；架构 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；命令行 [`docs/LAUNCHER.md`](docs/LAUNCHER.md)；版本历史 [`CHANGELOG.md`](CHANGELOG.md)（脚本生成）与 [`docs/releases/`](docs/releases/)；0.9.1 时代的完整文档（能力对比、兼容性矩阵全文）存档于 [`docs/README-full.md`](docs/README-full.md)。

## 常见问题（排错）

| 现象 | 原因与解决 |
|---|---|
| 装完界面还是旧的 / 新页面不出现 | 客户端 bundle 在引擎启动时加载：**必须重启 `dsh web`**（或让启动器重新拉起引擎） |
| 启停插件后列表状态没变 | 引擎在启动时套用条目：配置已写入，**重启引擎后生效**（界面会在需要重启时提示） |
| `dsh plugin add` 报 "Already up to date" 不更新 | pnpm 按版本号缓存 tarball；**修改后必须升版本号**再 add |
| 引擎起不来（坏 bundle 进 package.json） | 开 `http://127.0.0.1:3081/rescue` → 运行检查 → 修复 → 启动；或 `npx dsh-drydock-boot --repair-only` |
| 想禁用管理器自己 | 3080 界面内不可自禁：去 `http://127.0.0.1:3081/plugins`（独立于引擎存活）或用 `dsh plugin remove`；3080 内允许的是**卸载**（额外警告路径，自动清理自启） |
| 列表分区和我认知的不一样 | v1.0 起按来源三分区（核心组件 / 引擎内置组件 / 用户插件）；「推荐」只是行内标签，不再是分区 |
| 担心第三方网页能触发启动/停止 | 不会：写接口要**同源 `Origin` + 一次性令牌**，并发受单飞闸门限制（403 / 401 / 409）——见 [docs/LAUNCHER.md](docs/LAUNCHER.md) §4 |
| 浏览器报 `waiting for service: remote.xxx` | 客户端 inject 不能包含自身挂载的 remote（死锁）；inject 只保留 `["slots","locale","remote"]` |
| 第三方插件没有 ⚙ 配置入口 | 它尚未注册 `plugins.row.config` 槽位——请向插件作者反馈 |
| P2P 磁力链接无法下载 | 安装 aria2c（自动启用）或装 webtorrent，或用 NDM/比特彗星手动导入 |

## 许可证

MIT。补丁持久化机制借鉴 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)（MIT）。

---

## English

An English README lives at [README.en.md](README.en.md). Quick version:

A local plugin manager for DeepSeek Harness. It takes over the engine's built-in plugin page as a **standalone page** (sidebar entry "Plugin manager"): since **1.0.0** the list is grouped **by origin** — **Core components (locked) · Engine built-ins · User plugins** — with "Recommended" demoted to an inline row tag. Sections: Official built-ins (optional) · All plugins · Market · Operations & scenarios · Maintenance. It also ships a **standalone rescue toolchain**: `open-boot` (the single web entry on **3081**: boot page `/` + fallback manager page `/plugins` + rescue page `/rescue`), `rescue-daemon` (independent backup rescue service on **3082**), and `dsh-boot` (Steam-style boot sequence with exit codes). Transactional uninstall with impact preview, pre-uninstall health check, operation history (undo) and named scenarios included. Cross-platform, zero new runtime dependencies.

Install: `dsh plugin --profile web add dsh-drydock` (pin `@1.0.0` if the release is less than 24 h old — pnpm's `minimumReleaseAge` default blocks brand-new versions) → restart `dsh web` → open the sidebar "Plugin manager". Details: [README.en.md](README.en.md).
