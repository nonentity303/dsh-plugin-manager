# 变更日志（Changelog）

> 本文件**由脚本生成**，请勿手工编辑：发布说明改完后执行 `node tools/dev/gen-changelog.mjs`。
> 校验：`node tools/dev/gen-changelog.mjs --check`（不一致 → exit 1）。
>
> 数据来源：`docs/releases/*.md`（每个版本倒序排列，完整说明见对应文件）；生成规则见 [`tools/dev/gen-changelog.mjs`](tools/dev/gen-changelog.mjs)。
> 日期口径：发布说明里的内联日期，或脚本内 `RELEASE_DATES` 表（来源逐条列在脚本注释里）；**找不到出处就不写日期**
> （新版本发布后把发布日期回填进发布说明再重跑本脚本即可 —— 见 `docs/RELEASING.md` §10 第 13 步）。
> GitHub Releases 另见 <https://github.com/nonentity303/dsh-plugin-manager/releases>。

## [Unreleased]

> 尚未发布的改动不在本文件；开发中的版本号见 `package.json` 的 `version`（发布流程见 [`docs/RELEASING.md`](docs/RELEASING.md)）。

## [0.9.1]

> 一句话：0.9.1 把「装坏了能救」往前推了一步——卸载前先体检、卸载后能清干净、本地写接口有防护、自检有留痕，并把工程文档补齐（架构 / 命令行口径 / CHANGELOG / 英文版）。 启动器与救砖链的命令行闭环 + 卸载侧安全网 + 文档工程化；界面零改版。

### Added · 新增

- 一条命令把启动器痕迹清干净 — `npx dsh-pm-launcher --uninstall`：停**本 profile 的**守护（`.open-boot.pid` + 锁端口 `port+1000` + 进程镜像三重校验，不通过就不动别的进程）→ 删 `HKCU\...\Run` 下**所有** `DSHWeb*` 自启值（含历史 `DSHWebRescue`）→ 删两个 `.vbs` 包装脚本 → 清 pid。幂等（确认无可清理项也 exit 0，退出码三档见 §③），日志保留，引擎 3080 不动
- 卸载管理器不再留下自启残留 — 卸载本插件自身前，管理器会先调用包内的 `bin/open-boot.mjs --uninstall --profile <profile>`（能力探测：旧版本没有该参数就记「已跳过」并继续，不阻断卸载）；结果写进卸载报告与操作历史
- 卸载前先做一次体检 — 卸载预览顶部给出**结论行**（安全 / 需注意 / 有风险 + 一句理由），并列出三类检查：① **依赖断裂**（`dependencies` / `peerDependencies` 为高风险，`optionalDependencies` / `dsh.recommendedDeps` 为提示）② **补丁残留**（`cordis.patch.yml` 里与被卸载包关联的开关行 / insert 行，**只提示、绝不自动删除**）③ **service 与端口冲突**（同名 service / 同端口声明）
- 本地写接口有防护 — `POST /api/boot`、`/rescue/api/start|fix|stop` 需要**同源 `Origin`**（同机同端口白名单：`127.0.0.1` / `localhost` / `[::1]`，不按 `Host` 头派生）+ 页面注入的**一次性令牌**（`X-DSH-PM-Token`，48 位 hex、不落盘、每次启动都换、常量时间比较）；`boot`/`start` 还有**单飞**闸门（并发第二个 → 409）。第三方网页的 `fetch` 一律被拒（403/401），本地工具照常可用；读接口（`GET /api/status|verify`）保持开放
- 自检留下痕迹 — `npx dsh-pm-launcher --status` 每次都往 `<profile>/health.log` 追加一行（`<ISO> OK|FAIL boot=up@3081 engine=up@3080`），并在控制台打印「最近自检：…」；日志保留最近 **7 天 / 最多 1000 行**
- 救援入口收敛到一个端口 — open-boot 现在是 **3081 唯一网页入口**：`/` 是"打开即启动"页，**`/rescue` 是救援页**（含 `/rescue/api/*`，复用同一套实现）。独立备份入口 `npx dsh-pm-rescue` 退到 **3082**，不再与启动器抢端口
- 多实例 / 测试时换引擎端口 — 环境变量 `DSH_ENGINE_PORT` 可覆盖引擎端口（默认 **3080 不变**，仅测试与多实例用）
- 每次改动自动跑测试 — 新增 CI 工作流：push 到 `master` 与所有 PR 自动跑四套测试；**Windows 为门禁**（注册表 / shim / 端口归属这类断言只在 Windows 成立），Ubuntu 为实验性（`continue-on-error`，失败不阻塞合并）
- 查文档而不是翻源码 — 新增 `docs/ARCHITECTURE.md`（三进程 / 槽位契约 / 侧车字段 / 卸载事务）、`docs/LAUNCHER.md`（命令与退出码 / `--uninstall` 四步 / 写接口防护 / 故障排查 + 「文档条目 → 代码位置」核对表）、`CHANGELOG.md`（脚本生成）与英文版 `README.en.md`；`README.md` 首屏补上能力对比表与引擎兼容性矩阵

### Changed · 变更

- **启动页现在也认 `localhost` 与 `[::1]`** — 写接口的同源白名单由"只认 `http://127.0.0.1:<端口>`"扩为**同机同端口的三种等价写法**：`127.0.0.1` / `localhost` / `[::1]`。把浏览器主页写成 `http://localhost:3081/` 现在能正常"打开即启动"（此前会被判跨站 → 403）。端口必须与页面地址一致；第三方域名与其他端口一律 403
- **`--uninstall` 的退出码改为三档 0 / 1 / 2** — **0** = 完成（含确认无可清理项）/ **1** = 出错 / **2** = **归属未确认**：当系统探测（`netstat` / `tasklist`）不可用时，无法判断进程是不是本 profile 的守护 —— 此时**不停止任何进程**、**保留** `.open-boot.pid` 作为线索、**不报"卸载完成"**。脚本/自动化请按"只有 0 才算完成"处理
- **命令行取值不再静默回落默认目标** — `--profile` / `--port` 取值缺失、以 `-` 开头（被后面的开关占用）、空白、非数字或越界（端口）→ **用法错误**：解析立刻停止、用法打到 stderr、**exit 1**，且**零副作用**（不装崩溃日志、不写日志、不动注册表 / pid / 进程）。对三个会改全局自启项的子命令（`--uninstall` / `--install-autostart` / `--uninstall-autostart`），**任何**未识别的开关或多余位置参数（例如把 `--profile` 拼成 `--profle`）同样按用法错误拒绝。新增支持 **`--profile=<目录>`** 写法；其余模式（`--status` 等）仍保持"警告并忽略"以便不打断既有脚本
- **`rescue-daemon` 默认端口 3081 → 3082** — 与启动器同时使用时不再冲突：3081 归 open-boot（唯一网页入口），3082 是独立备份救援入口。如果你曾用 `--port 3082` 显式起它，现在直接 `npx dsh-pm-rescue` 即可
- **`/rescue` 的归属变了** — 0.9.0 及更早：救援页只挂在启动器的 `/` 流程里（或 3082 的服务上）。0.9.1：3081 的 `/rescue` 与 `/rescue/api/*` 就绪；3080 上的 `/rescue` 仍由引擎侧的 host 注册，需要引擎活着
- **`--uninstall-autostart` 未安装时退出码 1 → 0** — 幂等：脚本/自动化可以先无条件执行它，不再需要先探测是否存在
- **`--status` 不再是"纯只读"** — 它会写 `health.log`（这是自检留痕的设计）。不想要日志文件可以直接删掉该文件，下次 `--status` 会重新创建
- **端口被占用时的行为写进帮助** — 3081/3082 被非本工具进程占用 → 明确报错退出（`open-boot` 前台 exit 1；若端口上已是本启动器则 exit 0），**绝不静默漂移到别的端口**；`--help` 现在写明了 `--uninstall` 语义与端口分工
- 界面无变化 — 插件页、五个分区、行内配置与市场行为与 0.9.0 相同

### Fixed · 修复

- **用 `localhost` 打开启动页被误判为"跨站"（403）**：0.9.0 的同源检查只认 `http://127.0.0.1:<端口>`，于是在自己机器上把主页写成 `http://localhost:3081/` 时，"打开浏览器即自动自检 → 修复 → 启动"整条链路失效（页面能打开，但页内的启动请求被 403 拒掉）。现在 `localhost` 与 `[::1]` 与 `127.0.0.1` 等价（必须同端口），第三方域名仍然被拒。
- **`--uninstall` 在探测受限时会"假报完成"**：当 `netstat` / `tasklist` 被安全策略或受限会话拦下时，工具无法判断某个进程是不是本 profile 的守护，旧行为却仍然走完流程并以 exit 0 打印"卸载完成"。现在这种情况返回 **exit 2（归属未确认）**：不停止任何进程、保留 `.open-boot.pid`、明确提示人工核对，不再谎报成功。
- **未知 / 拼错开关会静默回落到"默认目标"**：三个会改动全局自启项的子命令旧行为是"忽略不认识的参数"——例如把 `--profile` 拼成 `--profle` 后，`npx dsh-pm-launcher --uninstall --profle D:\somewhere` 会**忽略那个拼错的开关**，转而对**默认 profile + 默认端口 3081** 动手：停掉真机 3081 的守护、删掉 `HKCU\...\Run` 下**全部** `DSHWeb*` 自启值，还以 exit 0 报成功；`--port` 取值非法时同样会静默落回默认端口。现在这三个子命令遇到任何未识别 token 一律**用法错误 exit 1 + 零副作用**，`--port` 取值也改为逐个校验（1–65535 的纯数字）。
- **受限环境（禁止命名管道）下的 pnpm 调用不再直接失败**：`spawnPnpm` 与卸载前的自启清理先走管道捕获，遇到 `spawn EPERM`（进程根本没启动、无副作用）会退化为 `stdio:"ignore"` 重试一次并按退出码判定；正常环境行为不变。
- **启动器测试的顺序敏感 flake 修掉**：注册表断言改为解析 `name/type/data` 后按 name 排序比较（Windows Run 键枚举顺序不固定），另加纯函数单测钉死规则；生产三件套（`bin/open-boot.mjs`、`bin/rescue-daemon.mjs`、`lib/enginectl.mjs`）哈希未因此变化。
- **文档里的端口与命令口径与实现对齐**：README 的端口表 / 工具表 / 救砖速查此前还是 0.9.0 的事实（救援守护默认 3081、与启动器互抢），现已改为 0.9.1 的 3081/3082 分工，并与 `docs/LAUNCHER.md` 同口径。

> 完整发布说明：[`docs/releases/0.9.1.md`](docs/releases/0.9.1.md)

## [0.9.0] - 2026-09-30

> 一句话：插件管理从"设置页里的一个清单"变成了独立插件页——从侧边栏直接进入，在一个页面里完成看插件、装插件、配插件、卸插件、救引擎。

### Added · 新增

- 从侧边栏/插件池直接打开「插件管理」 — 新增独立插件页，不再挤在设置页里的只读清单里
- 在一个页面里切换 5 个分区 — 「官方内置（可选）」「全部插件」「插件市场」「操作与场景」「维护」
- 直接在插件行内展开它的配置页 — 第三方插件注册的配置入口现在有落点：行内一行摘要 ＋ 展开后的完整配置卡片
- 在「官方内置（可选）」里一键启用/停用组合包 — 引擎自带、默认未启用的组合包，以及与版本豁免、自带配置页的官方插件
- 一键更新 / 安装 / 卸载 / 撤销 — 多更新源聚合取最高版本、插件市场一键安装、事务化卸载（预览 → 备份 → 删除 → 校验 → 回滚）、操作历史一键撤销、场景方案
- 用命令行管理启动器与救砖 — 新增 `dsh-pm-launcher` / `dsh-pm-boot` / `dsh-pm-rescue` 三个命令（见 ④）
- 界面语言切换后清单实时跟随 — 官方插件清单跟随界面语言与后注册的插件刷新，无需重启引擎
- 翻页、搜索、启用/禁用后不被拉回顶部 — 滚动位置会保留（长列表操作不再跳页）
- 设置页不可用时仍能进救援中心 — 右下角浮动救援球 / <http://127.0.0.1:3081/> 独立救援页

### Fixed · 修复

- 第三方插件的配置入口在该页面里没有任何落点（行内 ⚙ 不出现、也打不开配置页） — 行内 ⚙ 与展开的配置卡片都有真实出口；没有注册配置的插件不会出现空按钮
- 个别状态与按钮显示为"看不见"（配色令牌缺失、对比度失效） — 相关按钮与状态正常显示（令牌缺失时自动回退到可读颜色）
- 点「打开配置页」没有反应 — 配置页能真正打开
- 官方插件卡片只有标题、没有一行说明 — 卡片带一行简介（与内置插件页一致）
- 切换语言后官方卡片仍是旧语言；后注册的插件不出现 — 清单跟随语言与插件注册实时更新
- 禁用/启用插件后页面跳回顶部 — 滚动位置保留
- 「插件市场」「操作与场景」等入口缺失或不可用 — 5 个分区齐备，市场可浏览与安装
- 禁用/启用插件、应用场景方案后总是等到超时并提示"需要重启" — 即时生效，不再空等超时、不再谎报需要重启
- 插件运行期报错在诊断与救援页显示为空白 — 能读到真实错误文本
- 自动隔离可能把界面/基础设施类插件也写成禁用 — 只隔离真正反复失败的插件（连续失败阈值），且自动隔离默认关闭，需显式开启
- 从下载目录丢进来的归档不校验就安装、失败留残局 — 安装前校验，失败自动回滚
- Windows 上常因参数被拆开而装错包 — 参数按进程语义传递，含空格的路径也能正确工作
- 引擎起不来却报"已就绪"（端口上其实是别的程序） — 就绪 = HTTP 握手 + 身份校验；占用者不是引擎时明确报错
- 救援页「停止引擎」可能杀掉无关进程 — 停止前多重校验（进程/镜像/端口归属），不通过一律拒绝，需要时可在页面强制停止
- 启动失败要空等很久且不给日志路径 — 启动即失败会立即返回并打印引擎日志的绝对路径

> 完整发布说明：[`docs/releases/0.9.0.md`](docs/releases/0.9.0.md)

## [0.8.3-1] - 2026-09-28

> 本版是为 DSH 引擎 0.1.7-rc.2 升级做的兼容性修复，不含新功能，因此只打第四位版本号。

### Fixed · 修复

- **Typert strict codec 契约变更（引擎 0.1.7+ 必备）**
- 现象：在 0.1.7-rc.2 引擎上启动报 `typert-loader: dsh-plugin-manager-pro invocation "dsh-plugin-manager-pro#pluginManagerPro/list" result codec has no create() factory`，插件管理器整体不激活，设置页与插件列表全部消失。
- 原因：0.1.7 起 `dsh-typert-loader` 要求 strict codec 提供零参、返回 zod schema 的 **`create` 工厂**，不再读取旧的 `schema` 字段（`dsh-api-gateway` 的调用点从 `codec.schema.parse(v)` 改为 `codec.create().parse(v)`）。
- 修复：`lib/remote.js` 的 `strict()` 改为**双写** `schema` + `create: () => schema`。两代引擎的校验器都只做正向字段断言、不拒绝多余字段，因此同一份产物可同时用于 0.1.1-rc.2 与 0.1.7-rc.2。
- **客户端 inject 指向已删除的包**
- `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-runtime` 在 0.1.7 已被拆解删除，改为官方 1:1 继任者 **`@deepseek-ai/dsh-client-ui-renderer`**（`slots` / `SlotRegistry` 的新提供者）。
- 说明：声明本身不会报错（新加载器对未知 inject 名静默跳过），改它是为了让客户端启动图的排序边正确、并消除 0.1.7 上的无谓告警。

> 完整发布说明：[`docs/releases/RELEASE_NOTES_0.8.3-1.md`](docs/releases/RELEASE_NOTES_0.8.3-1.md)

## [0.8.2] - 2026-09-04

> README 与发布文案清理（无代码变更）

### Changed · 变更

- **README.md**：移除排错表中与特定部署环境绑定的内容（自定义脚本路径、桌面快捷方式/PID 排查记录），改为与包内实际产物一致的通用的说明；安装示例改用 `<latest>` 占位符。
- **RELEASE_NOTES_0.8.1.md**：删除"本机常驻"描述，改为通用的参考部署说明（开机自启 / 计划任务 / 主页指向 3081），并同步更新 v0.8.1 Release 页文案。

> 完整发布说明：[`docs/releases/RELEASE_NOTES_0.8.2.md`](docs/releases/RELEASE_NOTES_0.8.2.md)

## [0.8.1] - 2026-09-04

> 运行期救砖补完 + 全部插件联网更新

### Fixed · 修复

- `isolateFailedEntries(profileDir, logText)`：从引擎启动日志解析失败条目，往 `cordis.patch.yml` 写归属标记的隔离行 `{id, name, disabled: true}`（带 `.rescue-bak-*` 备份，可逆）。
- `startEngineWithQuarantine`：启动失败 → 读日志（尾部 64KB）→ 自动隔离 → **重试一次**。
- `open-boot`（3081 启动器）、`rescue-daemon`（/api/start）、`dsh-boot` 三个入口全部生效；隔离后引擎恢复启动；更新/替换该插件后移除隔离行即可。

> 完整发布说明：[`docs/releases/RELEASE_NOTES_0.8.1.md`](docs/releases/RELEASE_NOTES_0.8.1.md)

## [0.8.0] - 2026-09-04

> 安全卸载 × 可撤销 × 场景化 —— 对标社区最佳实践的一轮体验与安全升级。

### Added · 新增

- 卸载前**影响预览**：展示依赖该包的已安装插件（反向依赖图：dependencies / peerDependencies / optionalDependencies）、将移除的 loader 条目、将清理的管理器开关行、bundles 声明。
- **四阶段事务**：备份（`package.json` + `cordis.patch.yml` → `.rescue-bak-<ts>`）→ 删除（仅目标包 + bundles/开关行，可选级联）→ **启动前自检验证** → 失败**自动回滚**（恢复备份 + 按原 spec 重装）。
- **卸载报告**：自检结果、清理开关行数、级联卸载包、残留目录列表。
- **残留清理**：Windows 文件锁导致的删除失败登记 `pendingRemovals`，下次启动自动重试。
- 支持 `file:`/`link:` 本地包（vendor tgz 安装场景）——与 registry 包同等对待。
- 最近 20 次操作（卸载 / 启停 / 隔离 / 场景应用 / 重置开关），侧车持久化、跨重启保留。
- 卸载 → 恢复备份文件 + 重装依赖；启停/隔离/场景 → 恢复期望开关状态。
- 撤销后自动复核，撤销导致校验失败时明确提示。
- 把当前插件启停状态保存为命名场景（「办公/写作/演示」…），一键应用。
- 应用前**变更预览**（哪些条目会切换、受保护条目标注 🔒 跳过），确认后才执行；可更新、删除。
- 自动判定来源标签：`builtin`（随 dsh 提供）/ `local`（file:/link:）/ `github`（仓库声明）/ `npm`（默认）。
- 每行可手动覆盖（npm / GitHub / 本地 / 内置），持久化到侧车；自动判定依据包清单 `repository` 与依赖 spec。
- 卸载时检测依赖链并提供级联模式；市场安装后提示缺失的 `dependencies` / `peerDependencies`（可选 `dsh.recommendedDeps`）。

### Changed · 变更

- 侧车文件 `plugin-manager.json` 升级 **v2**（overrides / history / scenarios / pendingRemovals），兼容旧版读取。
- `verifyProfile` 拆出 `verifyProfileNow` 供卸后校验复用；修复 pnpm 隔离布局下反向依赖图扫描（symlink 目录）。
- UI 新增「场景」「历史」面板、卸载预览对话框、来源选择器；中英文案同步。
- 新增测试：`test-integration.mjs`（进程内 host 集成：事务卸载/回滚/撤销/场景/来源/侧车）+ `verify-v08.mjs` + `start-v08.ps1`（独立端口 E2E）。

> 完整发布说明：[`docs/releases/RELEASE_NOTES_0.8.0.md`](docs/releases/RELEASE_NOTES_0.8.0.md)

## [0.7.4] - 2026-08-18

> 启动专项检查修复：preflight verify 识别"已被 patch 隔离"的坏 bundle，不再误报。

### Fixed · 修复

- `lib/preflight.mjs`：`verifyProfile` 现在会读取 cordis.patch.yml 中 `disabled: true` 的条目，**已被隔离的 bundle 不再算作问题**
- 背景：`fixProfile` 隔离坏 bundle 的方式是写 patch `{id, name, disabled: true}`（loader 会跳过，引擎可正常启动），但 verify 仍按"bundle 不可解析"报错 → 造成 verify/fix 循环误报、`dsh-boot --repair-only` 误判退出码 2
- 修复后：fix → 再 verify 返回 `ok: true`（实测通过）

> 完整发布说明：[`docs/releases/RELEASE_NOTES_0.7.4.md`](docs/releases/RELEASE_NOTES_0.7.4.md)

## [0.7.3] - 2026-08-18

> 0.7.2 的补丁：滚动恢复增加 `requestAnimationFrame` 存在性守卫（修复非浏览器环境/VM 测试崩溃）。

### Fixed · 修复

- `src/client.jsx`：`run()` 的滚动恢复改为 `restoreScroll()` 辅助函数，对 `requestAnimationFrame` / `window.scrollTo` 做 `typeof` 守卫——浏览器行为不变，SSR/VM sandbox 不再 ReferenceError

> 完整发布说明：[`docs/releases/RELEASE_NOTES_0.7.3.md`](docs/releases/RELEASE_NOTES_0.7.3.md)

## [0.7.2]

> 修复：禁用 mod 时设置画面崩坏/页面重置（陈年 UI bug）+ 启动器 stdio 崩溃。

### Fixed · 修复

- **UI：禁用 mod 后画面崩坏、页面重置到右上角**（陈年 bug，禁用功能本身正常）
- 根因（双路分析确认，见 `BUG_ANALYSIS_UI.md` / `BUG_ANALYSIS_STATE.md`）：
- `run()` 更新快照触发全量重渲染后**无滚动位置保存/恢复** → 页面跳回顶部
- `useMemo` 全依赖 `state` 引用 → 每次操作全量重算分组/统计/卡片映射
- 修复（`src/client.jsx`，最小侵入）：
- `run()` 操作前保存 `window.scrollY`，`setState` 后与 `catch` 中用 `requestAnimationFrame` 恢复滚动位置（带 `typeof` 守卫，SSR 安全）
- `sections` / `originCounts` / `cardForEntry` / `updatable` 的 `useMemo` 依赖从 `[state]` 收紧为 `[state.snapshot?.entries]`
- 不改变：禁用功能、折叠/分组/搜索、ConfigCardBoundary 生命周期
- **启动器 stdio 崩溃**（`lib/enginectl.mjs`）：`spawn` 的 `stdio` 传 `WriteStream` 对象（fd 为 null）导致 `The argument 'stdio' is invalid`、引擎无法拉起
- 修复：改用 `openSync()` 数字 fd（`stdio: ["ignore", fd, fd]`），已实测 spawn 成功

> 完整发布说明：[`docs/releases/RELEASE_NOTES_0.7.2.md`](docs/releases/RELEASE_NOTES_0.7.2.md)

## [0.7.1]

> v0.7.0 的修订版：移除 open-boot 的 `--front` 3080 端口接管模式（端口争抢/keep-alive 竞态导致引导页无限循环），统一为稳定的 3081 独立入口。

### Changed · 变更

- `bin/rescue-daemon.mjs` — **独立救砖守护**（3081）：自包含中文救援页 + verify/fix/start/stop/status API，不依赖主引擎 — `node bin/rescue-daemon.mjs --profile <dir>`
- `bin/open-boot.mjs` — **网页启动入口**（3081）：打开 `http://127.0.0.1:3081/` → 自动 自检→修复→启动 → 跳转 3080。设为浏览器主页即"打开即启动"，无端口争抢 — `node bin/open-boot.mjs --profile <dir>`
- `bin/dsh-boot.mjs` / `.cmd` — **Steam 式启动序列**：verify → 自动隔离坏插件 → 启动 → 健康等待；`--repair-only`；退出码 0/1/2 — 双击 `dsh-boot.cmd`
- `lib/preflight.mjs`：standalone 自检/修复（bundle 解析性 + patch 可解析性；坏 bundle 以 `disabled:true` 写入 patch 可逆隔离；损坏补丁备份后重建）——与 host 内 `verifyProfile/fixProfile` 同源
- `lib/enginectl.mjs`：引擎探测/拉起/停止/PID 管理公共模块

### Fixed · 修复

- **移除 open-boot `--front` 3080 接管**：该模式在引擎拉起期间会重新抢占 3080（`server.close()` 被浏览器 keep-alive 连接阻塞导致 boot 不触发、引导页无限循环）。保留 3081 独立入口（无端口争抢，稳定）
- **waitFor 状态判断**：`(entry.disabled ?? false) !== enabled`（undefined 场景与原逻辑等价，可读性重构）
- **log() ESM 化**：`require('fs')` → 导入的 `appendFileSync`（修复 HOST-REQUIRE 契约违规）
- **packageInfoOf 补 try-catch**；**engines 降至 ≥18**；**依赖维持 peerDependencies**
- **`files` 增加 `bin/`**（救砖工具进包）
- `dsh-web-start.ps1`：陈旧 PID 误判修复（web.pid 指向 svchost 等非 node 进程时不再拒绝启动）；移除 watchdog 循环启动
- `dsh-web-rescue.ps1`：yaml fallback 误判修复（注释开头的合法 patch 不再被判损坏）

> 完整发布说明：[`docs/releases/RELEASE_NOTES_0.7.1.md`](docs/releases/RELEASE_NOTES_0.7.1.md)

## [0.7.0]

> 主引擎启动失败时，`/rescue`（由主引擎注册）会随之瘫痪。v0.7.0 把救砖能力剥离为独立于主进程的工具链（零新依赖，纯 Node + 已有 yaml）：

### Added · 新增

- `bin/rescue-daemon.mjs` — **独立救砖守护**（端口 3081）：自包含中文救援页 + verify/fix/start/stop/status API，不依赖主引擎 — `node bin/rescue-daemon.mjs --profile <dir>`
- `bin/open-boot.mjs` — **浏览器访问即自检启动**：普通模式监听 3081（打开即 verify→fix→start→跳转 3080）；`--front` 常驻模式在引擎挂时接管 3080 端口，浏览器打开 3080 即触发自动拉起 — `node bin/open-boot.mjs --front`
- `bin/dsh-boot.mjs` / `.cmd` — **Steam 式启动序列**：verify → 自动隔离坏插件 → 启动 → 健康等待；`--repair-only` 供外部调用；退出码 0/1/2 — 双击 `dsh-boot.cmd` 或 `node bin/dsh-boot.mjs`
- `lib/preflight.mjs`：standalone 自检/修复（bundle 解析性 + patch 可解析性；坏 bundle 以 `disabled:true` 写入 patch 隔离，可逆；损坏补丁备份后重建）——与 host 内 `verifyProfile/fixProfile` 同源逻辑
- `lib/enginectl.mjs`：引擎探测/拉起/停止/PID 管理公共模块

### Fixed · 修复

- **waitFor 状态判断**：改为 `(entry.disabled ?? false) !== enabled`（对 undefined 场景与原逻辑完全等价，可读性重构）
- **log() ESM 化**：`require('fs')` → 导入的 `appendFileSync`（修复 HOST-REQUIRE 契约违规）
- **packageInfoOf 补 try-catch**：manifest 解析失败不再抛异常
- **Node 版本要求降至 ≥18**（engines 更新，无依赖硬性要求）
- **依赖管理**：维持 peerDependencies（避免 pnpm 双实例）
- **打包修复**：`files` 增加 `bin/`（否则救砖工具进不了安装包）
- `dsh-web-start.ps1`：**陈旧 PID 误判修复**——web.pid 指向 svchost 等非 node 进程时不再误判"已运行"而拒绝启动（此前导致桌面快捷方式双击无效）；同时移除 watchdog 循环启动逻辑（看门狗由 open-boot `--front` 常驻替代）
- `dsh-web-rescue.ps1`：**yaml fallback 误判修复**——以注释开头的合法 cordis.patch.yml 不再被误判为损坏

> 完整发布说明：[`docs/releases/RELEASE_NOTES_0.7.0.md`](docs/releases/RELEASE_NOTES_0.7.0.md)
