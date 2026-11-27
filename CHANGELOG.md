# 变更日志（Changelog）

> 本文件**由脚本生成**，请勿手工编辑：发布说明改完后执行 `node tools/dev/gen-changelog.mjs`。
> 校验：`node tools/dev/gen-changelog.mjs --check`（不一致 → exit 1）。
>
> 数据来源：`docs/releases/*.md`（每个版本倒序排列，完整说明见对应文件）；生成规则见 [`tools/dev/gen-changelog.mjs`](tools/dev/gen-changelog.mjs)。
> 日期口径：发布说明里的内联日期，或脚本内 `RELEASE_DATES` 表（来源逐条列在脚本注释里）；**找不到出处就不写日期**
> （新版本发布后把发布日期回填进发布说明再重跑本脚本即可 —— 见 `docs/RELEASING.md` §10 第 13 步）。
> GitHub Releases 另见 <https://github.com/nonentity303/dsh-drydock/releases>。

## [Unreleased]

> 尚未发布的改动不在本文件；开发中的版本号见 `package.json` 的 `version`（发布流程见 [`docs/RELEASING.md`](docs/RELEASING.md)）。

## [1.0.4] - 2026-11-27

> 一句话：把"雷霆大 README"拆成第一屏就能看懂（特色 + 安装 + 升级自查）的入口页，细节移进 `docs/`；同时给 0.9.1 之前的旧包旧版加强弃用提示，并把 1.0.3 攻击测试发现的两处安全残留收口。

### Changed · 变更

- 第一屏 hero — 名称 + 「当引擎起不来的时候，它还在」+ 2 句价值 + badges
- 四个主打特色 — ① 独立救援工具链（3081/3082）② 事务化卸载/回滚/一键撤销 ③ 更新源信任模型 + 下载 provenance ④ 3081 兜底页 + 跨平台中文 UI
- 安装（30 秒） — `dsh plugin --profile web add dsh-drydock@1.0.4`（+ npx 备用、重启生效、24h 冷静期显式版本）
- 升级自查 — 0.9.1 之前旧版已淘汰 → 一条升级命令
- 入口速查 — 3080 插件管理 / 3081 `/plugins` / 3081 `/` / 3081 `/rescue` / 救援球
- 文档索引 — INSTALL / USAGE / SECURITY / RESCUE / COMPATIBILITY / FAQ / ARCHITECTURE / LAUNCHER / RELEASING / CHANGELOG / releases
- `docs/INSTALL.md` — 安装 / 更新 / 卸载 / 回退 / 离线 tgz / 24h 冷静期 / 自启 / 端口 / 重启生效
- `docs/USAGE.md` — 载体、管理台三分区与页签、事务化卸载、操作历史、场景方案、更新与下载、市场、兜底页
- `docs/SECURITY.md` — 权限与数据范围、更新源信任模型（1.0.3 口径）、下载 provenance、3081 防护、引擎救援路由准入、已知限制/威胁模型
- `docs/RESCUE.md` — 独立救援工具链、救援流程速查、3081 API 参考、工作原理、3082 说明
- `docs/COMPATIBILITY.md` — 环境要求、引擎兼容矩阵、Node 版本、平台
- `docs/FAQ.md` — 常见问题与排错
- `docs/README.md` — 文档索引（已更新）
- **README 变短**：根 README 只保留定位/特色/安装/升级/入口/文档索引；细节看 `docs/`。
- **0.9.1 之前版本在 npm 上显示更强弃用提示**，安装旧版会看到明确升级指引。
- **3082**：非回环 Host 访问返回 421（此前 200）；页面/API 响应新增安全头。
- **引擎内 `/rescue` 与 `/plugins-launcher`**：响应新增安全头；准入语义不变（应用内进入 200，地址栏直开 403，3081 救援页不受影响）。

> 完整发布说明：[`docs/releases/1.0.4.md`](docs/releases/1.0.4.md)

## [1.0.3] - 2026-11-27

> 一句话：把"谁有资格裁决版本"从源类型改成显式权威层——自定义源默认只作降级兜底、`http://` 默认标"明文 · 仅兜底"、`next` 只给 `@deepseek-ai/*`；顺手补掉下载目录 provenance 缺口、下载器两处收紧、救援页 XSS，以及 3081 启动器的一批加固与性能问题。

### Changed · 变更

- **README / README.en 同步 1.0.3 口径**：删掉过时表述（"正式发布版 1.0.0"、"npm 包名将在下个版本迁移"、"回退用 `dsh-plugin-manager-pro@0.8.2`"、插件超市 dshfind、"公平取最高版本"），补上：默认更新源三源、registry 版本权威、自定义源默认只兜底、`http://` 默认"明文 · 仅兜底"（升权威需 `authoritative`，明文还需 `allowInsecure`）、`@deepseek-ai/*` 才有 `next` 轨道、下载目录自动安装需 provenance、旧包已挂弃用提示不删包、`本页对应版本：1.0.3`。
- **`CHANGELOG.md`**：由 `docs/releases/*.md` 生成，本版条目随本文件落盘（`node tools/dev/gen-changelog.mjs`，`--check` 校验一致）。
- **新增 `test-docs.mjs`**（离线、零依赖，已挂进 `scripts.test` 末尾）：断言 README/README.en 的版本号 == `package.json` 的 `version`；README 不含 `dshfind` / `取最高版本` / `下个版本迁移` / `正式发布版 1.0.0`；`docs/releases/1.0.3.md` 存在且含 1.0.3；`CHANGELOG.md` 含 1.0.3。
- **自定义源不再和官方源混比版本**：加镜像 = 加速/兜底，不是把裁决权交出去。要让内网源独占权威，显式 `authoritative: true`（离线部署就是这样用）。
- **`http://` 源默认只兜底**：照常能配、能查版本，但不会赢过官方源；要升权威必须同时确认"允许明文 + 设为权威"。
- **普通包不再吃 `next`**：只有 `@deepseek-ai/*` 才优先 `next`；其余包只取 `latest`，且 `latest` 是预发布时视为"无可用版本"——再不会把 RC 推给你。
- **下载目录里的手工归档不再被自动安装**：必须能对上管理器自己生成的来源记录（包名 + 版本 + 来源 + 摘要，7 天有效）；对不上的写 `.failed`，确认可信后删掉再重试。
- **3081 只接受回环 Host 头**：用 `127.0.0.1:3081` / `localhost:3081` 访问；把非回环域名指到 3081 会拿到 421（这是有意的）。
- **救援路由需要浏览器会话**：引擎内 `/rescue` 与 `/plugins-launcher` 现在要求同源已认证（先在同一浏览器打开 3080 完成 `?token=` 登录，未认证得到 401）；**从应用内进入**（浮动救援球/插件页链接）正常，直接在地址栏打开 `/rescue` 因无来源会被 403 拒绝。无 Connection 服务的宿主/无头部署按旧行为放行。3081 启动器自带的救援页不受影响——引擎完全起不来时它仍是独立入口。

### Fixed · 修复

- **updates 接口缓存 + 单飞**：`checkUpdates` 模块级缓存 key=profile、TTL 30 分钟，并记录 `pnpm-lock.yaml` 的 mtime+size，TTL 内且 lockfile 未变直接返回（热调用 < 10ms）；并发请求复用同一个 in-flight Promise（不再第二次起 pnpm）；`pnpm --version` 成功结果缓存（失败不缓存）。既有 `DSH_PM_PNPM_TIMEOUT_MS` 逃生门保留。
- **runPnpm stdout/stderr 环形缓冲**：不再无限 `+=`，只保留末尾 16KB，超出部分丢头部并加 `<...已截断 N 字节>` 标记；返回值仍取末尾 400 字符。
- **`log()` 去 innerHTML**：启动页/兜底页的日志输出改为逐行建 `<div>`/`<span>` + `textContent`，不再 `out.innerHTML += ...`（日志内容来自 pnpm 与包名，属于不可信文本）。

### Security · 安全

- 权威层判定 — 按 `entry.authoritative === true`，**不再按源类型**；`lib/index.js` 内置权威白名单只有 `https://registry.npmjs.org`、`https://registry.npmmirror.com`（URL 规范化后比较，忽略结尾 `/`）
- `official` — 一律由服务端按白名单判定，**忽略客户端提交的 `official`**；`snapshot().sources` 暴露 `official` / `authoritative` / `insecure`
- 用户新增源 — 默认 `authoritative:false`（`custom` 层），只在**没有权威版本**时降级兜底并标 `degraded`；需要独立裁决必须显式 `authoritative:true`
- `http://` 源 — 允许配置（内网 registry / 代理是真实场景），默认标「明文 · 仅兜底」；升权威需同时显式 `authoritative:true` + `allowInsecure:true`，否则自动降级并把原因写进可读 note（不静默）
- UI — 更新源面板显示「官方 / 权威 / 明文 · 仅兜底」徽标；自定义源提供「权威」「允许明文」两个显式勾选（信任升级可见、可撤销）
- 审计 — `setSources` 把来源变更（前→后 URL 集合、authority 变化、是否 http）写进侧车 `history`（沿用现有结构与上限）
- 向后兼容 — 旧夹具（只有 `type`、没有 `authoritative`）按 `registry` = 权威、`github` = 非权威处理，旧断言不被大面积改写
- 仅当包名匹配 `^@deepseek-ai\//` **且**源是内置权威源时，才优先 `dist-tags.next`。
- 其余包只取 `tags.latest`；`latest` 本身是 semver 预发布（含 `-`）→ 视为无可用版本（NOT_FOUND），**不把 RC 推给普通用户**。
- 自定义源即使自己配了 `next` 也不采用。`@deepseek-ai/*` 行为保持不变。
- `updateBrowser` / `resolveDownloadUrl` 生成下载链接时，把期望写进侧车新字段 `pendingDownloads`：`{url, packageName, version, sourceName, expect:{integrity?, shasum?, size?}, at}`，保留最近 50 条，按包名+版本去重。
- `checkDownloads` 先解归档读 `package/package.json`（`node:zlib`，不新增依赖）拿 `name/version`，再找匹配且未过期（7 天）的来源记录。
- 无记录 → **拒绝并写 `.failed`**，提示"未找到来源记录（不是本管理器生成的下载链接）；确认可信后再删除 .failed 重试"（沿用删 `.failed` 作为显式确认）。
- 记录带摘要 → 先流式比对，不一致拒绝；安装成功后移除记录，失败保留（不重复噪音）。
- **size 不再算"已校验"**：`usable` 只看 integrity/shasum；只给 size 时按"未校验"拒绝（门禁 2 文案明说"只给了大小，大小不是内容摘要"），显式 `unverifiedDownloads: allow` 放行时回执只写"仅核对大小，未校验内容摘要"。
- **重定向逐跳校验**：`redirect:"manual"`，最多 5 跳，每跳用 `new URL(loc, current)` 解析且协议必须是 http/https；非 `allowInsecure` 时**任何一跳降级到 http 立即拒绝**（文案说明第几跳降级）；跨 host 不禁止（CDN 正常），超限报错。
- **Host 头校验**：请求入口只接受 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`（大小写不敏感），不匹配 → `421` + JSON `{ok:false,error:"Host 不被允许（仅接受回环地址）"}`，且在路由之前。
- **统一安全响应头**：所有响应（`sendHtml` / `sendJson` / 救援页）带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、CSP（保留 `unsafe-inline` 以便页内脚本/样式与 `/plugins` 同源 fetch 照常工作）；`frame-ancestors 'none'`、`base-uri 'none'`。
- **`GET /plugins/api/bundles` 也要令牌**：GET 也走 `rejectWrite`（Origin + token），页面内联 `api()` 同步带 token 头。
- 两条路由在方法/参数处理之前先走宿主准入：`ctx.connection.requestRejection({headers})`，与 `/api` 同一套 Host/Origin fence + 浏览器会话认证。
- 结论映射：`401` 未认证 / `403` 来源不符 / `undefined` 放行；判定本身抛错时 **fail-closed 403**，避免"校验坏了就敞开"。
- **降级**：宿主没有 Connection 服务（headless、或引擎早于该服务）时保持旧行为（放行，仅适用于回环部署），只记一次日志——不因缺少可选服务让救援页整体不可用。
- 新增 `test-admission.mjs`（15 项，已挂进 `scripts.test`）：无服务降级、401/403、headers 原样透传、抛错 fail-closed、先准入后 405、告警只记一次。
- **实测（隔离测试引擎 33080 + 本版 tgz）**：未认证 `GET /rescue` → **401**、`GET /plugins-launcher` → **401**；用 `?token=` 建立浏览器 cookie 后 → `/rescue` **200**（HTML）、`/plugins-launcher` **200**（JSON）、认证后 `POST /rescue` → **405**。

> 完整发布说明：[`docs/releases/1.0.3.md`](docs/releases/1.0.3.md)

## [1.1.0-rc.2] - 2026-11-26（预发布）

> 一句话：1.1.0-rc.2 让 drydock 能装上 DSH 官方桌面版（Electron），但只做官方覆盖不到的那一块——引擎外灾备：离线只读诊断、官方恢复后自愈、走官方通道重建救援 profile。网页版行为一行未改。 ⚠️ 这是预发布版（rc.2），npm dist-tag 为 `next`，`latest` 仍是 1.0.2。 桌面版能力未在真实桌面环境做完整验收（本机未安装官方桌面版），详见 §⑧。

### Added · 新增

- **拿到一份能直接粘贴的诊断报告** — `npx dsh-drydock-doctor` — **只读**：不写盘、不碰锁、不启停进程。收集环境 / DSH_HOME 候选 / profile 清单 / 桌面锁 / 崩溃报告（`crash-<UTC>-<source>.log`）/ 插件操作记录 / 端口事实 / 引擎日志尾部；**自动脱敏**（令牌、用户名、`~` 缩写）
- **让官方恢复不只是"救活",还能"回到原样"** — `npx dsh-drydock-boot --heal-recovery` — 官方恢复会禁用第三方 bundle + 把 `cordis.patch.yml` 改名 `.bak-<时间戳>` + 建**空 patch** → 你的归属行/开关行/隔离行**全丢**。本命令从侧车与 `.rescue-bak-*` **重建**。默认 dry-run，`--apply --confirm <profile>` 才真写
- **走官方通道重建救援 profile** — `npx dsh-drydock-boot --rescue-profile` — 用官方 `dsh rescue --from-default-profile web`（官方 help 自己推荐的用法），**不碰 desktop profile**、不需要绕官方的 `rejectElectronProfile` 门禁
- 接管官方插件页 — ✅ — ❌ — 撞 `PROTECTED_PLUGINS`，失效形态是静默空白
- 现跑 pnpm 增删 — ✅ — ⛔ 门控 — Electron 持 `profiles/desktop/lock` 时**一律拒绝**
- 启停/配置热切换 — ✅ — 🟡 分级授权 — 允许 patch 级可逆写（有备份、只动归属行）；不做 pnpm 级
- 开机自启 / 浏览器即启动器 — ✅ — ❌ — 官方托盘/后台任务已覆盖，叠加=双份自启
- 内置插件市场 — ✅ — ❌ — 交给官方 market bundle + dshmarket
- 拉起/停止/重启引擎 — ✅ — ❌ — 单实例 + 特权 IPC 属应用；抢了就是"装了起不来"
- **离线只读诊断** — ✅ — ✅ **主战场** — 官方没有，普通用户最缺
- **恢复后自愈** — — — ✅ **主战场** — 官方恢复会埋掉运维层
- **官方通道重建救援 profile** — ✅ — ✅ **主战场** — 官方推荐的合法通道
- `probeEnv()` 判定 `web` / `desktop` / `unknown`，带 `confidence` 与中文 `reason`（多档证据全量记录，未命中项也记）；
- **不再假设 `~/.dsh`**：`--home` > `$DSH_HOME`（空白视为未设置）> `~/.dsh`；检测到多个候选 home 时**全部报出**并给 warning；
- **不再假设端口**：桌面版默认监听**系统分配的随机端口**（官方文档明示），所以端口只产**有序候选**（上限 8），实际健康判定仍用 **HTTP 握手 + dsh 身份指纹**——**裸 TCP 通过绝不算引擎就绪**；
- 宿主版本优先从 app 侧 `desktop-runtime.json` 的 `release.version` 读（含 `hostProtocolVersion`），**跟 npm 版本分开报**，且能原样处理 4 段测试版号。
- 新增**显式开关** `DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1`（默认关）——理由是同机 web + desktop 共存是常态，"存在 desktop profile"不等于"这次请求来自桌面页面"，写接口不能靠猜来放行；
- 放行后**只接受固定白名单** `dsh-app://app`（与桌面自己校验自家来源用的字面量逐字一致），**任何 `http(s)` 第三方源仍然 403**；
- 新增**桌面令牌通道**（`mintDesktopToken()` / `guardDesktopToken()`）：令牌只在内存与请求头，不写日志、不写 profile；
- **补上 CORS 预检**：`OPTIONS` 返回 `Access-Control-Allow-Origin`（回显精确 Origin，**不用 `*`**）+ `Allow-Headers: content-type, x-dsh-pm-token` + `Vary: Origin`，预检合法的请求在正式响应里也带 Allow 头——否则浏览器端会把预检拦掉，服务端根本收不到请求；
- "没有 Origin 就放行"那条既有路径**一行未动**（它是非浏览器本地工具的通道，也是 DNS rebinding 面的老防线）。
- `--heal-recovery` **默认 dry-run**（只打印计划，不动盘）；真写要 `--apply` + `--confirm <profileName>` 双确认；
- 桌面持锁 → **整个目录一个字节都不改**，退出码 `3`，并给"请从系统托盘完全退出后重开"的明确指引；
- 写前 `.rescue-bak-*` 备份 → 原子写（tmp + rename）→ **重读盘复检**（逐条核对 id/name/disabled + YAML 可解析 + 无 BOM）→ 任一步失败**自动回滚**；
- `cordis.patch.yml` 写盘一律**无 BOM**；读到 BOM 会剥离并**报告**（不静默）；
- **不写 `package.json`、不碰 `node_modules`、不写 `state.json`**（桌面场景）。

### Changed · 变更

- `package.json`：版本 `1.1.0-rc.1 → 1.1.0-rc.2`；新增 bin **`dsh-drydock-doctor`**；新增 `test:capabilities` / `test:origin` / `test:cors` / `test:diagnostics` / `test:rescue-profile` / **`test:desktop`**；`test` 串联全部新测试；
- npm `description` 首句改为**灾备语义**（"引擎外灾备与坞修"），把"插件管理"往后放——与定位一致；
- 桌面 profile 首次初始化用 **web 模板**的 bundle 列表（官方行为），因此三分区判定在 desktop profile 上与 web 一致。
- `npx dsh-pm-launcher` — **`npx dsh-drydock`** — 主入口：唯一网页入口 + 常驻守护（3081）
- `npx dsh-pm-boot` — **`npx dsh-drydock-boot`** — Steam 式启动序列 / `--heal-recovery` / `--rescue-profile`
- `npx dsh-pm-rescue` — **`npx dsh-drydock-rescue`** — 独立备份救援守护（3082）
- —（本版新增） — **`npx dsh-drydock-doctor`** — 离线只读诊断报告
- 旧命令**全部保留为别名**（`package.json` 的 `bin` 里两条指向同一文件），已写进脚本/快捷方式/文档的老命令**不会失效**。
- **启动链不受影响**：本机实测开机自启链（`HKCU\Run` → `open-boot-autostart.vbs` → `scripts\dsh-open-boot.cmd`）用的是**绝对文件路径** `node_modules\dsh-drydock\bin\open-boot.mjs`，不经过 bin 名。
- **有意不改**的旧标识（改了会断数据或断契约）：sidecar `plugin-manager.json`、备份目录 `.plugin-manager`、一次性令牌头 `X-DSH-PM-Token` / `<meta name="dsh-pm-token">`、环境变量 `DSH_PM_*`、RPC 命名空间 `pluginManagerPro`、类名 `PluginManagerPro`。

### Fixed · 修复

- **`test-launcher.mjs` 的高位端口假失败**（既存 flake，本版定位并修掉）：`freePort()` 可能取到 >64535 的临时端口，而守护锁端口 = 启动器端口 + 1000 越过 65535 → `lockPortOf()` 返回 `null` → open-boot 报"探测不可用"，3 条 F2 断言偶发假失败。现在 `freePort()` 按产品约束重取（≤64535）。
- `bin/dsh-boot.cmd` 补退出码 `3`（安全门拒绝）的提示分支；原先会显示 `UNKNOWN - exit code 3`。

> 完整发布说明：[`docs/releases/1.1.0-rc.2.md`](docs/releases/1.1.0-rc.2.md)

## [1.1.0-rc.1] - 2026-11-26（预发布）

> 一句话：把 1.0.1 更名时有意保留的那一半命名债补齐（命令名 `dsh-pm-*` → `dsh-drydock*`，旧名留别名），并集中修掉一批"用户感知不到工具在干活"的兜底页问题。 ⚠️ 请先读这条：本版未在任何真实用户环境做完整验收。 自动化测试（bundle / render / integration / launcher / 端口隔离 等 452+ 项）全绿，兜底页在隔离环境做过点击验证； 但没有在你的多插件真实 profile、也没有在 Windows 之外的平台上人工跑过全部入口。 想稳…

### Changed · 变更

- `npx dsh-pm-launcher` — **`npx dsh-drydock`** — 主入口：唯一网页入口 + 常驻守护（3081）
- `npx dsh-pm-boot` — **`npx dsh-drydock-boot`** — Steam 式启动序列
- `npx dsh-pm-rescue` — **`npx dsh-drydock-rescue`** — 独立备份救援守护（3082）
- 旧命令**全部保留为别名**（`package.json` 的 `bin` 里两条指向同一文件），已写进脚本/快捷方式/文档的老命令**不会失效**。
- **启动链不受影响**（实测）：本机 `HKCU\Run` → `open-boot-autostart.vbs` → `scripts\dsh-open-boot.cmd` 用的是**绝对文件路径** `node_modules\dsh-drydock\bin\open-boot.mjs`，不经过 bin 名。
- 同步更新 5 份文档的命令示例（`README.md` / `README.en.md` / `docs/LAUNCHER.md` / `docs/README-full.md` / `docs/RELEASING.md`）。

### Fixed · 修复

- **卡片顺序调整**：`更新检查结果` / `mod 体检` / `操作步骤日志` 三张"结果卡"从「用户插件」长列表**之后**移到工具栏**正下方**。它们是操作的结果，不是内容主体——列表再长也不该把结果顶出视口。
- **点击后自动到位**：`mod 体检` / `检查更新` / 卸载完成 都会自动 `scrollIntoView` 到对应卡片，并给 1.6s 高亮闪烁，让眼睛有落点。
- **直达链接**：3080 的「mod 体检」入口跳 `/plugins#health` 时，自动执行体检并滚到结果；新增 `hashchange` 监听（地址栏改 hash 也生效）。
- 刷新 — 完全静默 — 「刷新中…」→「已刷新：共 N 个组件（用户插件 N 个，已启用 N 个）」
- 检查更新 — 只禁用按钮、无开始提示 — 「检查中…」+ 开始提示 + 结果带前 3 个包名
- 🩺 mod 体检 — **零提示**，且接口异常会**永久禁用按钮** — 「体检中…」+ 汇总「正常/可疑/异常」计数（异常时点名）+ 卡片自动到位；`withBusy` 保证异常也恢复按钮
- 重启引擎 — 只禁用按钮 — 「重启中…」+ 「最长约 30s」+ 成功后给出入口地址
- 停止本启动器 — 无发起提示 — 「停止中…」+「引擎与本页面不受影响」
- 行内启停开关 — 只有结果、无发起提示 — 行变暗 + 「正在禁用 X…」→「已禁用 X，重启引擎后生效」
- 更新 / 卸载 — 部分路径静默、失败只说"失败" — 全程有发起/取消/结果；失败带**具体原因**（含 engine-busy 引导）
- 市场详情 — **完全静默**（弹窗被拦也不知道） — 成功提示已打开；被拦时给出手动 URL
- 核心组件开关 — 点了**毫无反应**（禁用的 input 吞掉鼠标事件） — 解释性提示「X 是引擎必需的核心组件，不能在这里禁用…」
- 主题 — 只有颜色变化 — 补一句"本页记忆；长按复位为自动"
- 确认框「取消」 — 静默 — 四类写操作取消都有"已取消"回执
- **体检/更新接口抛异常 → 按钮永久禁用**（`disabled=false` 写在 `await` 之后，异常就跳到不了）→ 统一 `withBusy` + `finally`。
- **启动页 409（已有启动流程在跑）只写一行日志、spinner 永转** → 补 `stopSpin()` 与明确提示。
- **toast 浮层盖住按钮会吃掉点击** → `#toasts{pointer-events:none}`（实测 `elementFromPoint` 已穿过）。
- `/`（启动页）：补「已等待 N 秒」计时 + 结束后的逐行结论输出，不再是"转圈到天荒地老"。
- `/rescue`（救援页）：五个按钮全部补「…中」发起文案 + 完成/取消回执，并防重复点击。
- **`test-launcher.mjs` 的高位端口假失败**（既存 flake，本版定位并修掉）：`freePort()` 可能取到 >64535 的临时端口，而守护锁端口 = 启动器端口 + 1000 越过 65535 → `lockPortOf()` 返回 `null` → open-boot 报"探测不可用"，导致 3 条 F2 断言**偶发假失败**。现在 `freePort()` 按产品约束（≤64535）在安全区间取端口。

> 完整发布说明：[`docs/releases/1.1.0-rc.1.md`](docs/releases/1.1.0-rc.1.md)

## [1.0.2] - 2026-11-26

> 一句话：修掉一条可被投毒的更新链——删掉"搜索猜来源"的 dshfind 源，给下载器加上完整性校验，并让 registry 版本权威化；同时并入 1.1.0-rc.1 已发布的命名债清理与兜底页体验修复。

### Changed · 变更

- `npx dsh-pm-launcher` — **`npx dsh-drydock`**
- `npx dsh-pm-boot` — **`npx dsh-drydock-boot`**
- `npx dsh-pm-rescue` — **`npx dsh-drydock-rescue`**
- `test-launcher.mjs` 的高位端口假失败（`freePort()` 取到 >64535 时守护锁端口越过 65535 → 误报"探测不可用"）

### Fixed · 修复

- 结果卡（更新 / mod 体检 / 步骤日志）**前移到工具栏下方**，并在点击后自动滚动 + 高亮；`/plugins#health` 直达也能立刻看到结果
- 12 个交互入口补齐「开始 + 结果」两段反馈；失败必带具体原因
- 修掉 3 个反馈类 bug：体检/更新接口异常导致按钮**永久禁用**、启动页 409 时 spinner 永转、toast 浮层**吃掉按钮点击**

### Security · 安全

- 默认更新源启用了 **dshfind**（"插件超市"）
- dshfind 在 GitHub 搜索 `topic:dsh-plugin <包名>`，**接受第一个 `package.json` name 匹配的仓库**——不校验 owner
- 跨源取**最高版本** → 攻击者伪造 `v999.0.0` 直接赢过真的 npm 发布
- 下载该仓库的 release 资产 / torrent / magnet / codeload 归档，**没有任何 hashCode 或签名校验**，还接受明文 `http://`
- 装进 profile → 生命周期脚本与插件代码在 agent host 里执行
- `DEFAULT_SOURCES` 不再包含 dshfind；`fetchLatestDshfindVersion`、缓存、失败合流键、下载解析分支全部删除（不留死代码）
- 已装用户的侧车 `plugin-manager.json` 里若还有 dshfind 条目，**读取时自动剔除**；旧客户端再提交也会被宿主丢弃
- UI 源列表：**4 个变 3 个**（npm 官方 / GitHub 官方仓库 / npmmirror 镜像）；"恢复默认源"不再塞回 dshfind
- ① 明文传输 — 中间人替换 / 降级劫持 — 默认**拒绝一切 `http://`**（含 `https` 跟随重定向后落到 `http` 的降级）
- ② 无从校验 — "伪造高版本 + 无摘要直装" — 拿不到可校验摘要的下载**默认拒绝**（fail-closed），且**不发起下载、不落盘**
- ③ 校验执行 — 内容被替换 — 给了摘要就**强制校验**：sha512/sha1/sha256（支持 npm SRI 多算法取最强、base64 与 hex 两种形态）+ 可选字节数；**边写盘边算**，包再大也不整体进内存；不匹配就删文件并失败
- registry 源给出确定版本时，**其它源一律不参与比较** → 伪造的 `v999.0.0` 永远不会被选中
- registry 没有版本时才回退到其它源，并标记 `degraded`（界面可提示"版本来自非官方源，未经 npm 校验"）
- 同一信任层内并列仍是随机（保留原来的公平性）
- **"插件超市（dshfind）"源没了**。靠它发现"同名 GitHub 仓库有新版 release"的包，不再从那条路拿到版本；如果包在 npm 上有新版，照常从 npm 更新。不再会出现"某个伪造仓库 v999.0.0 提示可更新"。
- **没有可校验摘要的下载默认被拒**。典型场景：自建 GitHub 仓库的 release 资产没有 `digest`、或用源码归档兜底。
- 提示语会告诉你怎么开
- 开启方式：profile 的 `cordis.patch.yml` 里给 `dsh-drydock` 加配置
- 开启后仍会**在回执里标注"未校验"**，不会静默放行
- **摘要不匹配、明文 `http://` 永远拒绝**，不受上述开关影响——内容已被篡改 / 传输可被替换时没有任何理由放行。

> 完整发布说明：[`docs/releases/1.0.2.md`](docs/releases/1.0.2.md)

## [1.0.1] - 2026-11-25

> 一句话：项目更名为 dsh-drydock（DSH 引擎船坞）——新 npm 包名 + 新 loader id，彻底摆脱与官方插件管理器的 id 冲突；同时完成端口覆盖补完（全链路支持非默认端口）与品牌视觉落地（DeepSeek 官方鲸形 + Docker 式货箱 logo 接入全部自有页面）。

### Added · 新增

- 在非默认端口下完整使用 — 端口全链路可覆盖：`DSH_LAUNCHER_PORT`（默认 3081）、`DSH_ENGINE_PORT`（默认 3080）、rescue-daemon `--port`（默认 3082）、守护锁端口自动推导（launcher+1000）——健康检查、身份指纹、页面跳转、锁端口、自动拉起、API 路径随端口一致联动；端口推导收敛到 `lib/ports.mjs` 单一事实源
- 用隔离模式做测试与二改 — 新增 `DSH_PM_SCRIPTS_DIR` / `DSH_PM_NO_SCRIPTS=1` 隔离开关，测试不再触碰真实 `~/.dsh/scripts`；交付 `tools/dev/test-extra-ports.mjs` 隔离测试引擎（69 项断言，临时 DSH_HOME + 自选端口可重复运行）
- 在自有页面看到品牌标识 — 管理台（3080）、启动页 / 兜底页 / 救援页（3081）、救援守护页（3082）四类页面头部加入 logo mark（主题自适应 currentColor，深浅主题均适配），并为各页补内联 SVG favicon（蓝底白鲸货箱，16px 可辨），消除 favicon 404

### Fixed · 修复

- **更名 dsh-drydock** — npm 包名 `dsh-plugin-manager-pro` → `dsh-drydock`；loader entry id → `drydock`（官方 DSH 0.1.6+ 已占用 `plugin-manager` id，旧 id 与官方插件管理器同装会冲突）；typert RPC 前缀、cordis patch 显示名、bin 自引用、README/文档同步
- 管理台与兜底页视觉更新 — 标题区 logo + 新双色规范（DeepSeek 品牌蓝 #4D6BFE + 白）；测试断言的文案与结构不变
- 有意保留旧标识 — sidecar 文件名 `plugin-manager.json`、备份目录 `<profile>/.plugin-manager`、bin 命令名（`dsh-pm-launcher` / `dsh-pm-boot` / `dsh-pm-rescue`）、`DSH_PM_*` 环境变量前缀等**存量用户数据面标识保持不变**，改名不影响既有数据与脚本
- 历史文档 — CHANGELOG 历史条目与 `docs/releases/` 旧版说明按发布时口径保留（旧名），不做追溯改写

> 完整发布说明：[`docs/releases/1.0.1.md`](docs/releases/1.0.1.md)

## [1.0.0] - 2026-11-24

> 一句话：插件管理的三个入口（3080 管理台 / 3081 兜底页 / 救援中心）全部重做定型——列表按来源三分区、管理器自身的禁用与卸载口径统一、卸载/更新/体检全链路事务化，并完整吸收 0.9.1-rc2 预发布的兼容性与性能加固（Node 18/20 修复、弱网韧性、bundle −67.9%）。

### Added · 新增

- **引擎挂了也能管插件** — 新增 3081 兜底页 `/plugins`（纯 Node 进程托管，不依赖引擎）：启停 / 批量更新（`pnpm outdated`）/ 事务性卸载 / mod 体检（verdict 三档）/ 重启引擎 / 停止启动器；扁平设计 + 深浅主题（跟随引擎外观与系统偏好）
- 在 3080 看到与引擎一致的来源分区 — 列表按来源三分区：**核心组件（白名单锁定）· 引擎内置组件 · 用户插件**；来源筛选（全部 / 架构自带 / 用户安装）与分区折叠计数联动
- 只把「推荐」给真正的第三方加装件 — 「推荐」从分区降级为行内标签（如 browser-control），重要引擎组件不再混入推荐清单
- 一页兜住救援流程 — 救援球可拖动换位（位置记忆）；3081 的「重启引擎」会自动隔离一次失败条目；救援流程速查表入文档
- 命令行管理启动器与救砖 — `dsh-pm-launcher` / `dsh-pm-boot` / `dsh-pm-rescue` 三个命令（v0.9 已有，1.0 文档与 `--help` 全面对齐）

### Fixed · 修复

- **管理器自身的禁用与卸载统一口径** — 管理器不能在自身管理界面（3080）中停用自己；如需禁用或卸载，请前往启动器兜底页（3081 /plugins）或使用 dsh 命令行——兜底页独立于引擎存活，禁用后仍可恢复。3080 内允许的例外是**卸载**（额外警告路径，卸载前自动清理开机自启）；3081 行徽章同步改为「管理器·本页可禁用/可卸载（3080 界面内不可自禁）」
- **文案中性化** — 全量去除拟人化措辞（「命脉」「救砖」→「核心组件」「救援」），中英文与文档同步
- 兜底页启停与引擎状态一致 — toggle 直接写 `dsh.profile.bundles`，写前自动备份；启动器并入插件管理后 3081 同时具备启动页 / 兜底页 / 救援页三入口
- 卸载失败可能留下半删状态或误回滚 — 事务性卸载：备份 → `pnpm remove` → 清理补丁条目 → 逐项验证，每步落日志、失败可回滚；`pnpm remove` 超时或进程状态不明时**不**盲目回滚，标记「未知」请人工确认
- 卸载/更新被运行中的引擎占用时硬删卡死 — EBUSY 引导：拒绝硬删，提示「先禁用 → 重启引擎 → 再操作」
- 启动器拉起引擎未透传 `--port`，引擎落到 3080 与启动器探测端口不一致（`EADDRINUSE` / 假健康） — 端口全链路透传，探测与实际一致
- smoke 把 `AbortError` 误判为「引擎已下线」 — 区分超时与真实下线
- EBUSY 报错直接抛原始异常 — `friendlyError` 输出可读指引
- 启动器对无效 token 的拒绝过严（引擎 0.2.2 返回 303） — token URL 校验接受 303 / 200+`__DSH_BOOT__`
- 引擎起不来却报"已就绪" — 就绪 = HTTP 握手 + 身份校验（与 0.9.0 一致，继续保留）
- **G1（blocker）** — 0.9.1 在 Node < 22.14 加载即崩（顶层具名导入 `node:module` 的 `findPackageJSON`，该导出 Node 22.14 才有）→ 改命名空间导入 + 运行时特性检测 + 可移植回退解析器，静态门禁 `node tools/dev/compat-scan.mjs --root .` 守住（本版 `blocker=0`）
- **F6** — `--uninstall` / `--uninstall-autostart` 修复跨 profile 误删自启：只删指向目标 profile 的值与死指针，其余报告不删；删前 reg export 备份
- **C-05~C-15（跨平台）** — 非 Windows 弹窗启动纯函数化（.command 脚本 + osascript 兜底 / gnome-terminal -- / konsole、xterm -e）+ 退出码校验；全局安装根多级兜底；端口归属 lsof→ss→/proc/net/tcp 兜底链；缺环境变量给显式诊断
- **弱网韧性（C-02/03/04/09）** — 网络失败不污染「无更新」负缓存（合流窗口 + 显式重试穿透）；refresh() 总预算 90s 到点中止在飞请求（客户端 240s→120s）；按源指数退避 + 熔断；404 与网络异常分文案（「网络不可达，可重试」）
- **性能 P-01** — 客户端 bundle minify + 裁剪 zod 未用 locale → **796,658 → 254KB（−67.9%）**，gzip 约 66KB
- **性能 P-02** — 宿主 README 简介结果级缓存（含负结果，TTL 5min + 包操作显式失效）→ 热快照文件探测 1,016 → 0 次、热中位 18.8 → 1.1 ms
- **性能 P-05** — 搜索过滤 120ms 防抖 + 纯函数单测（清空搜索每键重建 199 行 60–86ms → 只重建一次）

> 完整发布说明：[`docs/releases/1.0.0.md`](docs/releases/1.0.0.md)

## [0.9.1-rc2] - 2026-10-07（预发布）

> 一句话：0.9.1 在 Node 18/20 上装完就加载失败；0.9.1-rc2 把这个 blocker、弱网下"把网络失败说成无更新"的四连、以及跨平台六条一起修掉。 兼容性（Node 18 重新可用 / macOS·Linux 命令形态）+ 弱网（失败不再假装"无更新"、超时不再假超时）；界面零改版。 尝鲜安装：`npm i dsh-plugin-manager-pro@next`（等价于 `@0.9.1-rc2`）。 发布日期：2026-10-07（预发布；实际以 npm `next` 的时间戳与 G…

### Fixed · 修复

- **G1（blocker，Node 18/20 装完就加载失败）— 现象**：0.9.1 的 `lib/index.js` 顶层写 `import { findPackageJSON } from "node:module"`，而该导出 **Node 22.14.0 才有**。ESM「具名导入一个不存在的导出」在**链接期**抛 `SyntaxError: The requested module 'node:module' does not provide an export named 'findPackageJSON'`，模块体一行都不执行 → **插件整体加载失败**；而 `package.json` 那时已声明 `engines.node >= 18.0.0`。
- **修法**：顶层改为**命名空间导入**（`import * as nodeModule from "node:module"`）+ **运行时特性检测**：Node ≥ 22.14 仍走官方 `findPackageJSON`（行为完全不变）；旧版本走随包的**回退解析器**（`createRequire` → 包入口逐级向上找 `package.json` → 手工沿 `node_modules` 链与 pnpm 隔离目录兜底，覆盖"`exports` 没有导出 `./package.json`"的现代包）。
- **为什么不是"把 engines 提到 22.14"**：`@deepseek-ai/dsh` 自身**没有 `engines` 字段**，"引擎支持 18"这个外部依据并不存在，但反过来也没有依据要求 22.14 —— 于是本版用回退实现把 18 变成真的，**保留 `engines.node >= 18.0.0` 并让它可被门禁验证**。
- **门禁证据（静态扫描）**：`node tools/dev/compat-scan.mjs --root .` → `blocker=0 high=0 medium=0 low=19 ok=14`、**exit 0**（0.9.1 发布件上是 `blocker=1`、exit 2）；`declared engines.node = >=18.0.0`、`effective floor = (none above floor)`。残留 19 条 low 全部是 `z.union(...)` 被误判为 `Set#union` 的**同名误报**（zod 的 union），脚本自己标了"待人工核实"。
- **独立验证（第①步闸门，对打包后的 tgz）**：`rc2-compat-scan.mjs --tgz` → **exit 0**、`blocker=0 high=0 medium=0 low=19 ok=14`、`effective floor = (none above floor)`；对照 **0.9.1 发布件 → exit 2、`blocker=1`**（`lib/index.js:1 node:module → { findPackageJSON } min node >= 22.14.0`）。（出处：闸门报告 §4.1）
- **独立验证（Node 20 形状模拟，A/B 负控）**：用 `node:module` 的 `registerHooks()` 把裸 `node:module` 重定向到一个**故意不导出 `findPackageJSON`** 的 shim，再动态 import 包入口 —— **rc2 候选件 `IMPORT_OK`**（导出 `Config`/`PluginManagerPro`/`__internals`/`default`，且 `snapshot()` 正常列出真实装机插件），**0.9.1 发布件 `IMPORT_FAILED`**（`SyntaxError: The requested module 'node:module' does not provide an export named 'findPackageJSON'`）；旧形状下 `resolver_mode=fallback`、`stats={official:0, fallback:4}`，当前 Node 24 未 hook 时仍走官方路径（`resolver_mode=findPackageJSON`，行为不变）。（出处：闸门报告 §4.2；实测形状模拟，非真实 Node 20 进程）
- **F6（high，`--uninstall` 删掉别的 profile 的开机自启）— 现象**：`npx dsh-pm-launcher --uninstall` 旧实现把 `HKCU\...\Run` 下**所有** `DSHWeb*` 值一律删掉 —— 与 `--profile` 指向哪个 profile 无关。于是在临时/非默认 profile 上做卸载，会顺手删掉**真机 profile**的开机自启项（用户下次开机才发现"自启没了"）。
- **修法（按 profile 作用域）**：只删**指向目标 profile 目录内**的值，以及**死指针**（数据里的 `.vbs` 已不存在，含历史 `DSHWebRescue`）；其余一律**报告但不删**（指向别的 profile、别的工具写的 `DSHWeb*`、数据里没有 `.vbs` 路径）。
- **删前留证**：真要删之前先把整个 Run 键 `reg export` 到 `<profile>\.plugin-manager\registry-backup-<时间戳>.reg`（失败只告警、不阻断主流程）；输出分「已删除」「已跳过」两块，逐条带键名、类型、数据与**判定理由** —— 卸载日志本身就可当审计证据。
- **安全性**：缺少 `--profile` 时**拒绝清理**（不再有"删所有 DSHWeb*"的路径）；注册表读不到时不谎报"已清干净"，而是明确告警要求人工核对。
- **回归证据**：启动器套件新增第 16 组（`t31/F6`）断言 —— 含真实注册表诱饵用例"指向目标 profile 的值被删 / 指向别的 profile 的值仍在"（可证伪：旧行为会一并删掉）。
- **C-02 网络失败不再污染「无更新」负缓存**：三种版本查询在 catch 到网络异常后不再写长期负缓存（旧行为：一次 DNS 抖动 → 30 分钟 / dshfind 源 1 小时内的"重试"根本不联网）。现在网络类失败只进 **30 秒合流窗口**（作用仅是让并发请求别同时轰同一个源），且**显式手势（点"检查更新"/"更新"）会穿透**它，保证真的再联网一次；只有**确定性结论**（拿到版本号、404 明确无此包）才允许进负缓存。来源配置一改，缓存/合流窗口/退避状态**全部作废**。
- **C-03 检查更新有总预算、到点真的会停**：`refresh()` 新增**总预算 90 秒**（deadline 折算进每个单请求的超时，到点在飞请求 `abort`、后续批次不再发起），客户端"检查更新"超时 **240 秒 → 120 秒**（客户端预算 ≥ 宿主预算，不再出现"界面报超时、后台还在跑半小时"）。网络类失败按源**指数退避**（15 秒 → 10 分钟），同一次全量里同一源连续失败 5 次即**本批熔断**。
- **C-04 市场目录不再被全局串行队列顶成假超时**：`marketCatalog()` **移出全局 FIFO**（它只读网络 + 内存缓存，没有需要互斥的写操作），**缓存命中在排队之前**就返回，并按 key 去重；客户端超时 **20 秒 → 45 秒**（旧值低于宿主两次网络最坏的 8+10 秒，网络完全正常也会假超时）。
- **C-09 区分「包里没有」与「网络不可达」**：版本查询返回 `reason`（`not-found` / `network` / `timeout` / `backoff` / 无源），经 `snapshot.entries[].updateReason` 透传到界面文案 —— 404 走「更新源没有此插件/无更新」，网络类失败走「网络不可达，可重试」，403 走「更新源限流冷却中，稍后自动重试」，不再一律「版本未知」（文案原文见下一条）。
- **界面文案（实测原文，不是设计稿）**：行级 `network` / `timeout` → **「网络不可达，可重试」**（设计上两者**共用一句**，区别只在 `updateReason`）；`not-found` → **「更新源没有此插件/无更新」**；`backoff` → **「更新源限流冷却中，稍后自动重试」**；无 reason 时回落到「版本未知」；**汇总行** → **「网络较慢：检查更新已在总预算内中止（3s / 3s，已查 5/5），结果可能不完整（失败不会被缓存），网络恢复后可直接重试。」**（`refreshAborted` 行；0.9.1 完全没有这一行）。**注意：已发布的实现里并没有「超时已取消」这类字符串** —— 独立验证按实际实现取证（`src/client.jsx:2400/269`），本说明不写用户看不到的文案。（出处：闸门报告 §3.1）
- **独立验证（第①步闸门，真实本机 socket、零注入 fetch）**：`404` → 37 ms、5/5 `updateReason=not-found`、`VERSION_CACHE` 5 条（**确定性结论允许写负缓存**）、失败窗口 0 条；连接被拒（ECONNREFUSED）→ 4 ms、5/5 `network`、`VERSION_CACHE=0`、dshfind 1 小时搜索缓存 0 条、失败只进 30 秒合流（5 条）；**源恢复后立即 5/5 拿到真结论**（没有假负缓存）；**黑洞 + 2.5 秒预算 → 2,506 ms 返回、`aborted=true`、5/5 `timeout`、`VERSION_CACHE=0`**；`403` → 5/5 `backoff` 且有冷却记录；默认预算 + 黑洞 → 8,017 ms 返回（单请求 8 秒 `AbortSignal` 先到），**相对客户端 120 秒超时有 112 秒余量**。（出处：闸门报告 §3.1）
- **市场页独立验证（同闸门）**：目录请求自带 **8 秒**硬超时；先在黑洞桩上排一个 **20 秒预算**的检查更新，再并发调市场 → **6,107 ms 返回**（`source=live`、4,414 条），此刻检查更新仍在飞（`refresh_still_running_when_market_returned: true`）→ **确实没有排进全局 FIFO**；再点一次 → 0 ms 命中 10 分钟目录缓存；失败态渲染「重试」按钮 + **「网络不可达，可重试：目录请求全部失败（断网/代理/限流都可能），点击重试重新加载。」**。（出处：闸门报告 §3.2）
- **C-05（high）弹窗启动不再静默假成功**：命令构造抽成纯函数 —— macOS 不再把 shell 命令行递给 `open -a Terminal`（`open` 只接受文件/URL，旧写法必然报错却告知"已弹出"），改为生成 `.command` 脚本（`chmod 755`、纯 ASCII）+ `open -a Terminal <脚本>`，并留 `osascript` 兜底；Linux 不再依赖已被移除的 `gnome-terminal -e`（`gnome-terminal` 用 `--`，其余终端保留 `-e` 的候选链）。**启动后校验子进程的 error 事件与退出码**（端口出现监听者作强证据），失败返回 `ok:false` 让调用方退回静默启动；顺带修掉"子进程 error 无人监听会崩宿主进程"的隐患。
- **C-06（medium）全局根探测在 Windows 上从"必然失败"变为可用**：旧写法 `spawnSync("npm", …)` 在 Windows 上必然 `ENOENT`（Node 不按 PATHEXT 解析 `npm`→`npm.cmd`），而 `npm.cmd` 在 Node ≥18.20/20.12/22 又因安全加固抛 `EINVAL` —— 两条直连路都不通。现在改走 **`process.execPath` + `npm-cli.js`**（零 shell、零转义），并做多级兜底：`root -g` → `prefix -g` 派生根 → 平台默认路径 → 版本管理器扫描，**每个候选都做存在性校验**。
- **C-07（medium）端口归属探测有兜底链**：原来是"没有 `lsof` 就等于探测不可用"（精简发行版/容器/Alpine 常无 `lsof`）→ `--uninstall`/守护流程退化为"归属未确认，拒绝处理"并被卡住。现在按 **`lsof` → `ss -ltnp` → `/proc/net/tcp`（inode → `/proc/*/fd` 反查）**依次降级；三条都不可用时明确报"探测不可用，**不能据此断言端口空闲**"（保守，不假成功）。
- **C-13 / C-14（low）全局安装根覆盖与诊断**：`win32` 分支缺 `APPDATA` 时不再静默返回空候选 —— 回退 `USERPROFILE` / `LOCALAPPDATA` / 主目录推导路径，并把"缺哪个变量、退了哪条路"写进报告的 `problems`（显式诊断）；缺足够多时明说"全局插件探测不可用"，而不是"你没有全局插件"。覆盖面补上 macOS `/opt/homebrew`（Apple Silicon Homebrew）、Linux XDG 路径、Windows Volta / nvm-windows / pnpm 全局；每个候选标注是否**实测过**，未实测的明确写"未实测"。
- **C-15（low）`tools/dev/pack.mjs` 在 Node ≥ 22 上可用**：旧写法 `npm.cmd` 必抛 `EINVAL`（本机实测），现改走 `node + npm-cli.js`，并补 `--help` / `--dry-run` / `--no-build`。实测 `--help` 与真实 `npm pack --dry-run` 均 **exit 0**。（该脚本**不进 npm 包**，只影响仓库侧打包流程。）
- **独立验证（第①步闸门）**：Windows 实测 —— 退出码正/负控（`exit 0 → ok:true`；`exit 3 → ok:false, exitCode=3`；**命令不存在 → ENOENT 且宿主进程不崩**；端口出现监听者 → `ok:true`）；`--status` **exit 0 / 211 ms**（0.9.1 是同级的 184 ms，无回归）；P-03 全局根探测首调 **0.61 ms**（零 spawn）+ 约 0.5 s 后权威根自愈；`pack.mjs --help` 与 `--dry-run --no-build` 均 exit 0。**纯函数矩阵**（对候选件）覆盖：darwin 缺脚本**必须 `ok:false`**（不许退回 `open -a Terminal <shell 命令行>`）、darwin 有脚本走 `open -a Terminal <*.command>` + `osascript` 兜底、linux `gnome-terminal --`（其余终端保留 `-e`）、C-07 三级兜底链与三个解析器、C-13 三级环境变量兜底 + 5 条诊断、C-14 覆盖矩阵。**macOS / Linux 未真机运行**（纯函数 + 依赖注入），`NPM_GLOBAL_ROOT_COVERAGE` 里非 win32 项自身即标「未实测」。（出处：闸门报告 §3.3 / §3.4）
- **P-01 客户端 bundle 未 minify**：bundle **792,931 → 255,903 B（−67.7 %）**、行数 **18,482 → 81**、gzip（level 9）**120,937 → 66,250（−45.2 %）**、brotli **97,342 → 56,152**、zod locale 引用 **106 → 0**。（独立验证：闸门报告 §5.1，字节取自两个 tgz 的 `lib/client.js`）
- **P-02 每次 `snapshot()` 重做 1,016 次文件系统探测**：**热快照 fs 探测 1,016 → 0**（独立 fs 计数钩子，7 次抽样全 0）；热快照中位 **18.8 → 1.1 ms**、冷快照 **101 → 61.7 ms**。（闸门报告 §5.2 / §5.3）
- **P-03 回归消解（本版自己的修法一度引入）**：C-06 改走 `node + npm-cli.js` 后，首屏曾多出 ~190 ms 同步阻塞；现在快路径命中**零 spawn**，全局根探测首调 **0.61 ms**，约 0.5 s 后权威根自愈（期间 `problems` 明说"后台异步进行中"，不冒充权威）。（闸门报告 §3.3）
- **P-04 `--status` 开销**：候选件实测 **exit 0 / 211 ms**（0.9.1 同级 184 ms，**无回归**）。（闸门报告 §3.3）
- **代价如实写**：`snapshot_json_bytes` **93,582 → 97,621 B**（+4.0 KB，新增 `updateReason` 等字段）、`construct_ms` **1.7 → 2.4 ms**、`uninstallPreview_ms` 9.6 → 9.1 ms。
- **P-05 的界面项未改**：199 行全展开仍是 **4,544 个 DOM 节点**（无虚拟化）—— 本版**不改界面**；「清空搜索每键延迟」的真浏览器复测未取得（见 §⑧ 未实测边界 1）。
- **C-16**：`package.json` 的 `files` **显式列出 `README.en.md`**。此前英文 README 能进包只是靠 npm 对 `README*` 的自动附带规则（0.9.0 的包里有、0.9.1 才有），换打包器或 npm 改规则就会**静默消失**。核验：`npm pack --dry-run --json` → `version=0.9.1-rc2`、`entryCount=20`、清单含 `README.en.md`。
- **C-11 口径统一**：`engines.node = ">=18.0.0"` 与实现实际要求**一致**（由 G1 的回退路径保证），并由 `tools/dev/compat-scan.mjs` 静态门禁守住（blocker/high 命中即 exit 2/1）。引擎侧没有可用锚点：`@deepseek-ai/dsh` 自身无 `engines` 字段 —— 所以本插件的 Node 下限**只由自身扫描 + 门禁决定**，README 里已写明。
- **README（中/英）**：引擎兼容性矩阵、Node 口径与断言数按**本轮实测**更新；预发布版的装法与 semver 提醒写进首屏"我该装哪一版"。
- **`CHANGELOG.md` 生成口径**：生成器（`tools/dev/gen-changelog.mjs`）支持预发布版本号（`-rcN` / `-rc.N` / `-alpha.N` / `-beta.N`），排序改为**发布顺序（新→旧）**、预发布段头带**（预发布）**标注，并新增**静默漏版护栏**（`docs/releases/` 下有"版本号打头却没被识别"的文件时直接 exit 1，避免 `--check` 假绿）。

> 完整发布说明：[`docs/releases/0.9.1-rc2.md`](docs/releases/0.9.1-rc2.md)

## [0.9.1] - 2026-10-07

> 一句话：0.9.1 把「装坏了能救」往前推了一步——卸载前先体检、卸载后能清干净、本地写接口有防护、自检有留痕，并把工程文档补齐（架构 / 命令行口径 / CHANGELOG / 英文版）。 启动器与救砖链的命令行闭环 + 卸载侧安全网 + 文档工程化；界面零改版。 发布日期：2026-10-07（npm 发布时刻 2026-10-07T01:23:37Z；npm 与 GitHub Release 附件为同一份字节，sha256 `88C182B852AA5CCB73E67EA6298E102935BC39E…

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

## [1.1.0-desktop.2]（预发布·桌面通道）

> 发布日期：待发布（本文件随合并先落盘；真机验收结论回填后再发） 通道：desktop（`npm dist-tag desktop`）；本版本不会动 `latest`。 版本口径见 [`../版本与轨道.md`](../版本与轨道.md)：桌面适配/迭代走预发布后缀，不顶动核心版本号。 相对 `1.1.0-desktop.1` 的增量：自更新（含 3080 界面上的「现在 / 稍后」弹窗）＋ 首启环境探测与自动剥离的收口。

### Added · 新增

- **首启环境探测 + 自动剥离**（`lib/envprobe.mjs` / `lib/capabilities.mjs` / `lib/host-profile.mjs`）：安装后首次启动探测宿主形态（`web` / `desktop` / `unknown`），把结论与证据原子写入 host profile； **非本环境的模块不会被加载**（惰性装载 + 剥离清单），`dsh-drydock-modules` 可随时审计"本环境永远不会执行的代码"。
- **能力门控**（M1）：一张能力表 + 中文理由，UI 按表渲染，**不散落 `if (isDesktop)`**；被关掉的入口可点开看理由。
- **来源防护 + CORS**（M2/M6）：桌面页面来源 `dsh-app://app` 走单独白名单；正式响应补 `Access-Control-Allow-Origin`/`Vary`；安全响应头与 1.0.3 的 `applySecurityHeaders` 合并（桌面与网页同一套）。
- **离线只读诊断**（M4）：`dsh-drydock-doctor`（人读 / `--json` / `--include-logs` / `--out`），不写盘、不碰锁、不启停进程。
- **官方目录三分区**（M3）：`lib/bundles-official.mjs` 直接读官方 `PROTECTED_PLUGINS`(17) / `HIDDEN_BUNDLES`(8) / `PROFILE_TEMPLATES`(5)，带静态回落副本。
- **恢复后自愈**（M5）：`dsh-drydock-boot --heal-recovery`（默认 dry-run，真写需双确认），从侧车与 `.rescue-bak-*` 重建被官方恢复埋掉的归属行。
- **官方通道救援 profile**（M5）：`dsh-drydock-boot --rescue-profile`（**桌面形态下拒绝执行**——绝不 spawn/kill 宿主）。
- **自更新**（`bin/drydock-update.mjs` + `lib/self-update.mjs`）：从权威源（npm https + `dist.integrity` SRI）或用户显式确认的本地 tgz 取包 → 校验 → 暂存 → **「现在 / 稍后」** → detached worker（停引擎 → 装 → 健康检查 → 重启，失败自动回滚）。桌面形态**不自动装**（profile 由 Electron 独占），只提示；选了「稍后」下次启动由 3081 启动器再提醒。对应 RPC：`selfUpdateStatus` / `selfUpdatePrepare` / `selfUpdateDecide`；**3080 插件页工具栏下方新增「管理器自身」卡片** （有 pending 出「现在升级 / 稍后」两个按钮；桌面形态只显示提示文案；升级中显示"引擎会重启，完成后刷新本页"）。 → [docs/自更新.md](../自更新.md)

> 完整发布说明：[`docs/releases/1.1.0-desktop.2.md`](docs/releases/1.1.0-desktop.2.md)

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
