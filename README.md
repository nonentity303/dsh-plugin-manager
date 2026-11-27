<p align="center"><img src="docs/images/logo.svg" width="88" height="88" alt="DSH 引擎船坞 drydock"></p>

# DSH 引擎船坞（dsh-drydock）

> **当引擎起不来的时候，它还在。** 为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 提供**启动期可靠性工具链**：独立进程、独立端口的启动前自检、坏插件隔离、引擎拉起与救援（3081 / 3082），外加一个顺手的插件管理台。
>
> 官方与插件市场负责「装进来」；引擎船坞负责「装完之后」——**装坏了能撤，引擎崩了能救**。它修这次启动，我们修下一次为什么还会坏。

![badge](https://img.shields.io/badge/dsh-0.1.7+-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![version](https://img.shields.io/npm/v/dsh-drydock?color=orange) ![npm](https://img.shields.io/npm/dt/dsh-drydock)

> 社区/本地插件，非 DSH 官方包。npm：`dsh-drydock`（原名 `dsh-plugin-manager-pro`，旧包已挂弃用提示、不删包，仅保留供历史版本安装）· GitHub：[nonentity303/dsh-drydock](https://github.com/nonentity303/dsh-drydock) · 跨平台（Windows / macOS / Linux）
>
> **本页对应版本：1.1.0-desktop.1**（桌面通道；`npm view dsh-drydock dist-tags` 可核对；标签见 <https://github.com/nonentity303/dsh-drydock/tags>）
> ⚠️ 刚发布的版本会被 pnpm 的 **24 小时冷静期**（`minimumReleaseAge`）挡住：装不到或装完还是旧版时，**显式写版本号**（见下方安装）。
> 版本与通道口径见 [docs/版本与轨道.md](docs/版本与轨道.md)：`-desktop.N` = 桌面通道、`-rc.N` = 网页预发布、无后缀 = 正式版。

## 四个主打特色

### ① 独立救援工具链：引擎挂了还能救
3081 启动器（`/` 打开即自检启动、`/plugins` 兜底管理页、`/rescue` 救援页）与 3082 备份救援守护跑在**独立进程、独立端口**，不依赖 Cordis 运行时；`verify / fix / start / stop / status` 带明确退出码（0 就绪 / 1 启动失败 / 2 修复未完成），可被外部脚本调用。→ [docs/RESCUE.md](docs/RESCUE.md)

### ② 事务化卸载 / 失败回滚 / 一键撤销
卸载前给**影响预览 + 体检结论**（安全 / 需注意 / 有风险）→ 备份 → 卸载 → 逐项验证 → **任何失败自动回滚**；Windows 文件锁残留登记 `pendingRemovals`，下次启动自动清理；最近 20 次操作一键撤销，插件组合存为**场景方案**一键切换。→ [docs/USAGE.md](docs/USAGE.md)

### ③ 更新源信任模型 + 下载 provenance
默认 npm 官方 `registry.npmjs.org` / GitHub 官方仓库 / npmmirror 三源，**registry 版本权威**；自定义源默认 `authoritative: false` **只作兜底**、不与官方源混比；`http://` 源允许但默认标「**明文 · 仅兜底**」，升权威需显式 `authoritative: true` + `allowInsecure: true`；只有 `@deepseek-ai/*` 走 `next` 轨道；下载目录自动安装必须对上**来源记录 provenance**（包名 + 版本 + 来源 + 摘要，7 天有效）。→ [docs/SECURITY.md](docs/SECURITY.md)

### ④ 3081 兜底页 + 跨平台中文 UI
引擎挂了也能在 `http://127.0.0.1:3081/plugins` 启停 / 更新 / 卸载 / 体检 / 重启引擎；全中文界面、深浅主题自动跟随系统偏好；Windows / macOS / Linux 全平台（开机自启管理目前为 Windows）。→ [docs/USAGE.md](docs/USAGE.md)

## 安装（30 秒）

```sh
# 网页版（正式版通道，= npm latest）
dsh plugin --profile web add dsh-drydock@1.0.4
# 发版满 24 小时后，也可以不带版本号
dsh plugin --profile web add dsh-drydock

# 桌面版（DSH Desktop，独立 profile；桌面通道 = npm dist-tag desktop）
#   1) 先启动一次桌面版以初始化 profiles/desktop → 2) 从系统托盘**完全退出**
#   3) 用桌面版自带 CLI（不是 npm 的 dsh）执行，4) 重开桌面版并在设置里确认插件已启用
dsh plugin --profile desktop add dsh-drydock@desktop

# 离线 tgz（GitHub Release 页下载，或 npm pack 自建）
dsh plugin --profile web add ./dsh-drydock-<版本>.tgz

# 回退上一个正式版（1.0.x 之间回退走同一包名）
dsh plugin --profile web add dsh-drydock@1.0.3

# 重启 web 生效（客户端 bundle 在引擎启动时加载）
dsh web
```

装好后两个入口：**3080 侧边栏「插件管理」**（接管引擎内置插件页）与 **3081 兜底页** `http://127.0.0.1:3081/plugins`。浏览器主页设为 `http://127.0.0.1:3081/` = 打开即自检 → 修复 → 启动 → 跳转主界面。

- **不想装进 profile？** `npx dsh-drydock` 起 3081 启动器、`npx dsh-drydock-boot --repair-only` 命令行自检 + 修复、`npx dsh-drydock-rescue` 起 3082 备份救援——都无需安装。
- **装不到 / 装完还是旧版？** ① 客户端 bundle 只在引擎启动时加载，**必须重启 `dsh web`**；② 24 小时冷静期内务必写显式版本号（或把 `dsh-drydock@1.0.4` 加入 profile `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`）。完整安装 / 更新 / 卸载 / 回退 / 离线 tgz / 开机自启见 [docs/INSTALL.md](docs/INSTALL.md)。

## 桌面版（DSH Desktop）支持（1.1.0 新增）

> 桌面版官方已把安装 / 启停 / 更新 / 卸载 / 崩溃恢复吃进 app，所以 drydock 在桌面只做**官方覆盖不到**的三件事：
> **离线只读诊断、官方恢复后自愈、走官方通道重建救援 profile**（不接管插件页 / 不自启 / 不拉起或停止 Host / 不写 `node_modules`）。

```sh
npx dsh-drydock-doctor                                     # ① 离线只读诊断（--json 可贴进 issue）
npx dsh-drydock-boot --heal-recovery [--apply --confirm web] # ② 官方恢复后自愈（默认 dry-run）
npx dsh-drydock-boot --rescue-profile                       # ③ 官方通道重建救援 profile（桌面形态拒绝执行）
npx dsh-drydock-modules --audit                             # ④ 本环境永远不会执行的文件 + 行数（首启已自动探测）
```

**首启环境探测 + 自动剥离（本版新增）**：装完第一次启动即探测宿主形态（web / desktop / unknown）并落盘，
**不属于本形态的模块连 `import` 都不发生**（实测桌面形态整体剥离 `lib/rescue-profile.mjs` 1331 行）。
→ [docs/环境自适应与剥离.md](docs/环境自适应与剥离.md) · [docs/桌面版移植-1.1.0设计.md](docs/桌面版移植-1.1.0设计.md)
> ⚠️ 桌面能力有 fixture + 注入式单测覆盖，但**真机链路未验收**：首次请先跑 `dsh-drydock-doctor`。

## 升级自查（0.9.1 之前的老用户必看）

> ⛔ **0.9.1 之前的 `dsh-plugin-manager-pro`（含 `0.9.1-rc2`）已淘汰**：存在已知供应链风险，且 Node < 22.14 加载即崩。npm 上已挂**强化弃用提示**（不删包，历史版本仍可安装，但**不要用**）。

一条命令升级到新包名：

```sh
dsh plugin --profile web remove dsh-plugin-manager-pro   # 移除旧包（保留 profile 备份）
dsh plugin --profile web add dsh-drydock@^1.0.4          # 安装唯一推荐入口
dsh web                                                   # 重启生效
```

新包名 `dsh-drydock` 是唯一推荐入口；1.0.x 之间回退用同一包名（如 `dsh-drydock@1.0.3`）。引擎要求 ≥ 0.1.7-rc.2，更老的引擎请留在历史版本。详见 [docs/INSTALL.md](docs/INSTALL.md) 与 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 入口速查

| 入口 | 地址 | 用途 |
| --- | --- | --- |
| 管理台（3080） | `http://127.0.0.1:3080` → 侧边栏「插件管理」 | 日常入口：看 / 装 / 配 / 卸 / 救引擎，功能最全 |
| 兜底管理页（3081） | `http://127.0.0.1:3081/plugins` | 引擎不可用时仍可用：启停 / 更新 / 卸载 / 体检 / 重启引擎 |
| 启动页（3081） | `http://127.0.0.1:3081/` | 打开即自检 → 修复 → 启动（设为浏览器主页最省心） |
| 救援页（3081） | `http://127.0.0.1:3081/rescue` | verify / fix / start / stop / status 全套修复能力 |
| 救援球 🛟 | 3080 右下角浮动按钮 | 可拖动换位（位置记忆），设置页损坏时的入口 |

> 引擎内也注册了一份 `/rescue`（`http://127.0.0.1:3080/rescue`），但它经宿主准入：**从应用内**（救援球 / 插件页）进入正常；在地址栏直开属无来源顶层导航，会被 403 拒绝。引擎起不来时请用 3081 的独立救援页。

## 日常怎么用（3 分钟）

1. **启停插件**：3080 侧边栏「插件管理」→ 列表开关（核心组件锁定，不可禁用 / 卸载）；改动写入 profile 的 `cordis.patch.yml`，**重启引擎生效**（界面会提示）。
2. **更新**：维护页签「检查更新」→「更新」；或 `pnpm update dsh-drydock --latest --dir <profile>`。更新源按信任模型裁决（见特色 ③）。
3. **卸载**：行内卸载 → 影响预览 + 体检结论 → 备份 → 执行 → 逐项验证，失败自动回滚；「操作与场景」页签可一键撤销。
4. **救援**：见下方「出问题了先看这里」，全量命令与退出码见 [docs/RESCUE.md](docs/RESCUE.md)。

## 它管什么、不管什么

| 场景 | 谁来管 |
| --- | --- |
| 找插件、逛市场、一键装 | 官方插件页 / 插件市场（dshmarket 等）——本工具**不自建目录**，市场页签只是顺手入口 |
| 装坏了怎么办 | **本工具**：事务化卸载 + 一键撤销（最近 20 次操作） |
| 装多了怎么管 | **本工具**：来源三分区 + 场景方案 + 操作历史 |
| 引擎起不来怎么办 | **本工具**：3081 / 3082 独立救援，不依赖引擎进程 |
| 备份恢复 / WebDAV / 主题切换 / 静态安全扫描 | 不做——这些 dshmarket 已成熟，请直接用对应工具 |

## 出问题了先看这里

| 症状 | 入口 |
| --- | --- |
| 引擎在跑，但 3080 界面 / 插件页异常 | 3080 右下角 🛟 救援球，或从插件页进入 3080 `/rescue` |
| 引擎起不来、3080 打不开 | `http://127.0.0.1:3081/`：自检 → 修复 → 启动 → 跳转 |
| 插件被禁用到界面起不来 | `http://127.0.0.1:3081/plugins` 直接 toggle（不依赖引擎） |
| 某个插件把引擎打挂 | 3081 `/plugins` → 体检 verdict → 禁用观察或卸载 |
| 卸载 / 更新被引擎占用 | 拒绝硬删，引导「先禁用 → 重启引擎 → 再操作」 |
| 想知道 3080/3081/3082/4081 状态 | `npx dsh-drydock --status`（并追加一条 `health.log`） |
| 彻底移除启动器痕迹 | `npx dsh-drydock --uninstall`（退出码 2 = 归属未确认：不动任何进程） |

## 环境与端口（装前核对一眼）

- **平台**：Windows 10/11 · macOS · Linux（救援工具链与三个 bin 全平台；开机自启管理目前为 Windows）
- **Node**：`engines.node` 为 `>=18.0.0`（本版未收紧），但 Node 18 已 EOL、pnpm 11 也不再支持 18/20/21，**实际请在 Node 22 LTS 或更新上运行**
- **引擎**：DeepSeek Harness `dsh` ≥ `0.1.7-rc.2`（`<0.3.0-0`），并需要 `pnpm`（`dsh plugin` 与更新依赖）
- **端口**（均只监听 `127.0.0.1`）：**3080** 引擎主界面 · **3081** 启动器（启动页 / 兜底页 / 救援页）· **3082** 备份救援 · **4081**（3081+1000）守护单实例锁

详见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | 安装 / 更新 / 卸载 / 回退 / 离线 tgz / 24h 冷静期 / 开机自启 / 端口 / 从旧包升级 |
| [docs/USAGE.md](docs/USAGE.md) | 载体、管理台分区模型与页签、事务化卸载、操作历史、场景方案、更新与下载、插件市场、兜底页 |
| [docs/SECURITY.md](docs/SECURITY.md) | 权限与数据范围、更新源信任模型、下载 provenance、写接口防护、救援路由准入、威胁模型 |
| [docs/RESCUE.md](docs/RESCUE.md) | 独立救援工具链、救援流程速查、3081 API 参考、工作原理、3082 说明 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | 环境要求、引擎兼容矩阵、Node 版本、平台与端口 |
| [docs/FAQ.md](docs/FAQ.md) | 常见问题与排错（含旧包升级问题） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 三进程架构、槽位契约、侧车字段、卸载事务数据流 |
| [docs/LAUNCHER.md](docs/LAUNCHER.md) | 三个 bin 的全部命令与退出码、`--uninstall` 闭环、写接口防护 |
| [docs/RELEASING.md](docs/RELEASING.md) | 发布流程（§11 多通道发布：dist-tag 由 `release/channels.json` 派生） |
| [docs/版本与轨道.md](docs/版本与轨道.md) | 三条发布通道（web / desktop / community）、版本号怎么升、各通道安装命令 |
| [docs/环境自适应与剥离.md](docs/环境自适应与剥离.md) | 首启环境探测、能力表、环境专属模块的惰性装载与剥离清单（死代码审查输入） |
| [CHANGELOG.md](CHANGELOG.md) | 版本历史（脚本生成） |
| [docs/releases/](docs/releases/) | 每版发布说明（本页对应 [1.1.0-desktop.1](docs/releases/1.1.0-desktop.1.md)） |
| [docs/README-full.md](docs/README-full.md) | 0.9.1 时代完整存档（能力对比 / 兼容矩阵全文），**非当前手册** |

## 许可证

MIT。补丁持久化机制借鉴 [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager)（MIT）。

English: [README.en.md](README.en.md)（精简入口；英文详解文档暂未拆分，细节以中文 `docs/` 为准）。
