> ⚠️ **内部文档（不要用作 GitHub Release 正文）**：本文件保留审计编号与证据对照，供开发时与工作区内的审计报告
> （`audit/*.md`，**不在本仓库内**）逐条比对。面向用户的公开发布说明见 [`../releases/0.8.3.md`](../releases/0.8.3.md)。

---

# 0.8.3 发布说明（派生补丁包：核心修复，UI 仍是 0.8.x）

> **一句话**：0.8.3 是**派生补丁包**——沿用 0.8.x 的设置页 UI，把本轮审计修好的**核心模块**（管理器 host、启动器与救砖链、
> 仓库与发布面）回移过来。它不含 0.9.0 的"夺舍新页面"。
> 打包口径（基线 + 覆盖核心文件 + 校验点）见 [`../RELEASING.md`](../RELEASING.md) §7。仓库 `package.json` 的 `version` 保持 **0.9.0**
> （那是 UI 发布版），0.8.3 用一次性目录产出。

- **基线**：已发布的 `dsh-plugin-manager-pro@0.8.3-1`（本仓库备份在 `tools/dev/artifacts/dsh-plugin-manager-pro-0.8.3-1.tgz`）
- **覆盖的核心文件**：`lib/index.js`、`lib/remote.js`、`bin/**`、`lib/enginectl.mjs`、`lib/preflight.mjs`、`package.json`、`docs/`
- **明确不覆盖**：`lib/client.js`（保持 0.8.x 旧 UI）、`cordis.patch.yml`（保持 0.8.x 那份，不接管内置插件页）

---

## 1. 管理器 host 侧修复（H1–H5，`lib/index.js` / `lib/remote.js`）

| ID | 缺陷 | 本版修法 |
|---|---|---|
| **H1** | 开关/隔离/场景切换**必然等到超时并谎报"需要重启"**：收敛判据读了 loader `Entry` 上根本不存在的 `_disposing`（`_disposing === 0` 恒为 false） | 收敛判定改为按引擎真实的启用/运行期状态判定（不再读 `_disposing`）；"等待"只用于真的会收敛的情况（0.1.7 引擎只在启动时套用一次） |
| **H2** | **运行期错误永远读不到**：代码读 `fiber.error`，而 cordis 4.0.4 的 Fiber 只有私有字段 `_error`（`:1031` 声明 / `:1290` 参与 state 判定 / `:1361` 赋值） | 错误文本按 `fiber._error → 兼容字段 error → entry.options.error` 取值并 `String()` 兜底，诊断/救援页不再显示空错误 |
| **H3** | 自动隔离**没有保护集**，一次失败就能把 `ui-*`/基础设施写成持久禁用 | 写禁用行前先过保护集判定（与救援 `RESCUE_NEVER` 同一套语义）；新增连续失败阈值 `AUTO_QUARANTINE_STREAK = 2`（跨启动累计），且自动隔离默认**关闭**（`rescue.autoQuarantine`） |

> **H3 口径说明（t18 补，按独立复核 F3）**：**本版修复代码正确，但其触发路径在 0.1.7 真引擎上不可复现** —— cordis 4.0.4 只在 **apply 成功之后**发射 `internal/plugin`（`cordis/lib/index.js:1093`；另有 `emitPluginDisposed` `:970` 走同一事件名），失败态走的是 `internal/status`（`:1298`），而本插件的 handler 只监听 `internal/plugin`（`lib/index.js:1183`）。真引擎 3 轮真实启动失败实测：`internal/plugin` 发射 **0 次**、侧车 `failureStreak` 恒 `{}`、未写禁用行、无 `.rescue-bak-*` 备份。
> 因此 H3 的性质是**防御性修复**：保护集 / 阈值=2 / 写前备份的逻辑本身正确（经复核与合成 `hostCtx` 单测直接验证），**实际触发待引擎支持**；"自动隔离会把 `ui-*` 写成持久禁用行"这一原始前提在当前引擎上**不可复现**，风险为**潜在**。证据口径细则见 `audit/fix-verify-caliber.md` 与 `audit/verify-fix.md` §1/§7bis。
| **H4** | 下载目录里**任意归档不校验就直装**（与市场安装路径不一致） | 下载目录拾取的归档改走与 `marketInstall` 同款校验链：稳定暂存 → `pnpm add` → dsh 清单校验 → profile 自检 → 失败回滚 |
| **H5** | Windows 上 `shell:true` 未转义 → 参数被拆开，甚至从 registry 装到同名包 | 改为 `cmd.exe /d /s /c` + **显式引用每个参数**（`shell:false`）；非 Windows 直接按 `execFile` 语义；`--dsh` 等含空格路径不再被拆 |

## 2. 启动器与救砖链修复（L1–L8，`bin/**` + `lib/enginectl.mjs` + `lib/preflight.mjs`）

| ID | 缺陷 | 本版修法 |
|---|---|---|
| **L1** | `bin/dsh-boot.cmd` **完全坏**（`cd /d "%~dp0"` 后又执行 `node bin\dsh-boot.mjs` → `bin\bin\…` MODULE_NOT_FOUND），并打印误导性的 FAILED | 修好脚本定位（在 `bin\` 目录下双击即可用） |
| **L2** | 引擎 cwd 落在插件包目录 → 自我更新/卸载 EPERM（文件被占用） | 新增稳定 cwd 解析（`resolveEngineCwd`），拉起引擎时切到不锁包的目录 |
| **L3** | 守护**没有存活证据/退出日志/异常兜底**（"静默消失"不可归因）；`--autostart-status` 只看注册表值 | 崩溃日志安装（`installCrashLogging`）+ 守护心跳（`--heartbeat-min`）+ `--status`/`--autostart-status` 校验守护存活与端口归属 |
| **L4** | 健康判定 = 裸 TCP 连接 → **假健康**（任意监听进程都被当成"引擎已就绪"），自愈静默失效 | 健康判定改为 **HTTP 握手 + dsh 身份指纹**（`engineHealth` / `launcherHealth`）；端口被非 dsh 进程占用时明确报错，不误判、不误杀 |
| **L5** | PID 文件记的是 `cmd.exe` 包装进程且**无身份校验**，`stopEngine` 直接 `taskkill /T /F` → PID 复用即误杀无辜进程树 | PID 文件带身份字段（`readPidInfo`），停止前做多重校验（存活 + 进程镜像 + 端口占用者一致），不通过即拒绝（不杀） |
| **L6** | `--wait-ms` 解析多一次 `i++` **吞掉后一个参数**：`--wait-ms 60000 --autostart-status` 会让只读命令变成真去监听端口 | 删掉多余自增；未知参数不再静默忽略而是告警 |
| **L7** | 启动失败无早期检测（spawn 后空等 90s）、失败信息不给日志路径；`--dsh` 含空格必失败 | 监听子进程 `exit`/`error` 提前判失败（`failedEarly`）；失败信息带上日志绝对路径与日志尾部；`--dsh` 参数按进程语义传递（见 H5） |
| **L8** | 自启包装 `.vbs` 用 `encoding:"ascii"` → 中文用户名路径（`C:\Users\张三\…`）写成乱码，登录自启静默失效（而 `--autostart-status` 仍报"已安装"） | shim 正文**纯 ASCII**（profile 路径由 `WScript.ScriptFullName` 运行时推导，不再内嵌）；非 ASCII 时落 UTF-16LE+BOM；写后**回读校验**，失败即报错 |

## 3. 仓库与发布面收敛（R1/R2/R3/R4/R5/R8/R9/R11/R14/R15）

- **R1** 可安装的 CLI 入口：`package.json` 增 `bin`（`dsh-pm-launcher` / `dsh-pm-boot` / `dsh-pm-rescue`）+ `exports["./bin/*"]`。
- **R2/R11** 删除机器专属死代码（`restart-engine.ps1`、`pack.ps1`、`rename-*`，含另一台机器的用户名路径），
  开发脚本迁 `tools/dev/` 并参数化；历史 tgz 归档、日志与运行产物移出仓库根。
- **R3/R15** 迁移包 vendor 刷新到当前版本并加 `_meta` 版本断言（`npm run check:vendor` + `deploy.ps1` 部署时断言）。
- **R4/R5** 自启只有一个所有者：`deploy.ps1` 不再自建 `.vbs`、不再写 `HKCU\...\Run\DSHWebFront`，
  改为调用包内 `open-boot.mjs --install-autostart`。
- **R8** `lib/client.js.map`（1.6 MB）不再进发布物（`files` 精确白名单）。
- **R9** 新增 `test-launcher.mjs`（随机端口 + 临时 profile，57 条断言）并补 `scripts.test` 串起四套测试。
- **R14** 包管理器口径唯一：`packageManager: npm`，保留 npm 锁文件、删除冗余 pnpm 锁；`pnpm-workspace.yaml` 取值明确。

> 这些条目对 0.9.0 也完全适用（同一批改动）。0.8.3 只是"UI 仍旧"的那一份。

## 4. UI 状态声明（**重要：本版不含 0.9 的新 UI**）

- 本版**沿用 0.8.x 旧设置页 UI**：
  - 不注册 `main`(key=plugins) / `sidebar.panellist`(id=plugins)，不声明/渲染 7 个 `plugins.*` 子槽位；
  - `cordis.patch.yml` 保持 0.8.x 那份（禁用只读清单 tab `ui-settings-plugin-inventory`，**不**禁用内置 `ui-plugin-manager`）；
  - `lib/client.js` 是 0.8.x 的旧产物。
- 因此下列 **UI 侧缺陷在本版仍然存在**，已在 **0.9.0** 修复：
  - **C1（high，功能回归）**：7 个 `plugins.*` 子槽位只声明不渲染 → **第三方插件的配置入口（行内 ⚙ / 配置页）消失**；
  - **C2（用户可见）**：`--dsw-alias-state-warning-primary` 令牌未定义且无 fallback → 相关按钮/状态**不可见**。
  - 同批还有 C3（`settings.plugin.item` 死路径）、C4（tab 注册缺 `children` → "打开配置页"死按钮）、
    C5（官方卡片缺 `view:'summary'` → 无一行说明）、C6（官方清单是静态快照，切语言不跟随）—— 同样只在 0.9.0 修。
- 想同时拿到"新 UI + 全部核心修复"，请用 **0.9.0**。

## 5. 安装 / 升级

```sh
# 离线 tarball（0.8.3 派生包）
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.8.3.tgz
dsh web
```

升级到 0.9.0 后如需回到 0.8.x 的旧 UI，直接安装 0.8.3 包即可（两者核心修复相同，只有客户端不同）。
自启/卸载：`npx dsh-pm-launcher --install-autostart` / `--uninstall-autostart`。

## 6. 已知未闭环（与本版无关，见审计报告）

- `migration/deploy.ps1` 的模板副本已在 0.8.3 周期内同步（与 `migration/pkg/main/deploy.ps1` 逐字节一致）；
  迁移包 `Log()` 仍会把 `deploy.log` 写进包目录（既有行为，待后续处理）。
- 审计④ R6/R7/R12/R13（外挂脚本退役、3081 端口分工、git tag/npm 发布口径、卸载闭环）属文档/流程项，
  已完成的部分见 §3，其余见 `audit/00-摘要与修复清单.md` 与 `audit/fix-repo.md`。
