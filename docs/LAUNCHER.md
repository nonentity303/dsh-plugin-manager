# 启动器与救砖命令行（LAUNCHER）

> 本文是 `bin/open-boot.mjs` / `bin/dsh-boot.mjs` / `bin/rescue-daemon.mjs` 的**口径来源**：端口、命令、退出码、防护规则都在这里。
> 进程与槽位架构见 [ARCHITECTURE.md](ARCHITECTURE.md)；发布流程见 [RELEASING.md](RELEASING.md)；用法速查见仓库根 [README.md](../README.md)。
>
> **口径冻结**：v0.9.1（R7 端口分工 / R13 `--uninstall` / L11 写接口防护 / P1-5 健康留痕）。
> 含 t12 对 t8 终审 F1/F2 的修订：**`--uninstall` 退出码三档（0/1/2）**、**写接口同源白名单加入 `localhost` 与 `[::1]`**。
> 命令、端口、退出码已与实现逐条核对（核对表见 §10）；括号里的行号是 2026-10 工作树快照，符号名是稳定锚点。

## 1. 三个命令

安装后由 `package.json` 的 `bin` 字段提供（`exports` 同时放行 `./bin/*`，可直接跑包内文件）：

| 命令 | 文件 | 角色 |
|---|---|---|
| `dsh-pm-launcher` | `bin/open-boot.mjs` | 3081 网页入口（启动页 + 救援页）+ 常驻守护 + 开机自启管理 + `--uninstall` 卸载闭环 |
| `dsh-pm-boot` | `bin/dsh-boot.mjs` | Steam 式启动序列：自检 → 修复/隔离 → 拉起引擎 → 等就绪 |
| `dsh-pm-rescue` | `bin/rescue-daemon.mjs` | 独立备份救援服务（默认 **3082**）：`verify` / `fix` / `start` / `stop` / `status` |

```sh
npx dsh-pm-launcher --help
npx dsh-pm-boot --help
npx dsh-pm-rescue --help
# 不想用 npx（或没装）：直接跑包内文件，路径与 cwd 无关
node "<包目录>/bin/open-boot.mjs" --status
```

> **不要在文档/脚本里写裸相对路径 `node bin/open-boot.mjs`** —— 那只对"cwd 恰好在包根"的开发者成立（`docs/RELEASING.md` §4）。

## 2. 端口表

| 端口 | 归属 | 提供什么 |
|---|---|---|
| `3080` | dsh 引擎 | 主界面；本包 host 注册的 `/rescue`；健康 = HTTP 握手 + 身份指纹。`DSH_ENGINE_PORT` 可覆盖（默认 3080 不变，仅测试/多实例） |
| `3081` | **open-boot ＝ 唯一网页入口** | `GET /` 启动页（打开即自检启动）· `GET /rescue` 救援页 · `GET/POST /api/boot` · `GET /api/status` · `/rescue/api/*` |
| `3081+1000 = 4081` | open-boot 守护锁 | `--supervise` 单实例锁（`--port N` → 锁端口 **N+1000**） |
| `3082` | rescue-daemon | **独立备份救援入口**：`GET /`、`/api/verify`、`/api/status`、`POST /api/fix\|start\|stop` |

冲突行为：**端口被非本工具进程占用 → 明确报错、exit 1、绝不静默漂移**（`open-boot` 与 `rescue-daemon` 都是这个行为）。

## 3. 命令与退出码

### `bin/open-boot.mjs`（`dsh-pm-launcher`）

| 命令 | 语义 | 退出码 |
|---|---|---|
| `[--profile <dir>] [--port <n>] [--dsh <cmd>] [--no-window] [--cwd <dir>]` | 前台启动网页入口（默认 3081） | 常驻不退出；端口被非本工具进程占用 → **1**；端口上已有本启动器 → **0** |
| `--ensure` | 一次性确保端口有本启动器（桌面快捷方式用） | **0** = 已就绪/已拉起；**1** = 失败/被占用 |
| `--supervise [--interval <秒>] [--heartbeat-min <分>] [--quiet]` | 常驻守护（锁 `port+1000`） | 常驻；锁被占 → **0**（已有守护，本进程退出） |
| `--status` | 状态自检 + **追加 `health.log`** | **0** = 启动器健康；**1** = 未就绪/被占用 |
| `--install-autostart` | 写 `HKCU\...\Run\DSHWebFront` + 两个 `.vbs` | **0** = 成功；**1** = 失败（含注册表写入失败） |
| `--uninstall-autostart` | 删**所有** `DSHWeb*` Run 值 + 两个 `.vbs` | **0** = 完成（含"未发现"）；**1** = 删除出错 |
| `--uninstall [--profile <dir>] [--port <n>]` | 卸载闭环：停本 profile 守护（三重校验）→ 删 `DSHWeb*` → 删 shim → 清 pid（日志保留） | **0** = 完成（含确认无可清理项）；**1** = 清理过程出错；**2** = **归属未确认**（`netstat`/`tasklist` 探测不可用：未停止任何进程、**保留** `.open-boot.pid`、**不报"卸载完成"**） |
| `--autostart-status` | 只读：自启 / 守护 / 启动器状态 | **0**（未安装也是 0）/ **1**（非 Windows） |
| `--help` | 用法（含 `--uninstall` 语义、三档退出码、端口分工、写接口白名单与 `--profile` 输入校验） | **0** |

补充：`--no-window` 关闭"拉起引擎时弹出的可见启动窗口"；`--wait-ms <n>` 覆盖启动等待；`--quiet` 静默。

**`--profile` 的取值校验与目标闸门**（t14-F1，破坏性输入缺口；三个 bin 里只有 open-boot 会执行全局动作，所以校验在这里）：

- **取值缺失、被后面的开关占用（以 `-` 开头）或全是空白** → **用法错误**：解析立刻停止，`main()` **在任何动作之前**把用法打到 **stderr** 并 **exit 1**，且**零副作用** —— 不装崩溃日志、不写日志、不动注册表 / pid / 进程。
  例：笔误 `--uninstall --profile --port 63001` 现在就是 exit 1、stdout 为空、stderr 打用法错误（以前会把 `--port` 当成 profile、端口回落默认 3081，然后**照常执行全局 `DSHWeb*` 删除**并以 exit 0 报"卸载完成"）。
- **支持 `--profile=<目录>`** 写法（以前这种写法会落进 unknown 被静默忽略，目标悄悄变成默认 profile）；取值前后空白容忍（`trim`）后再绝对化。
- 执行**全局动作**（写或删 `HKCU\...\Run` 下的 `DSHWeb*`、往 profile 写 `.vbs`）**之前**先过**目标闸门**：`--profile` 指向的目录必须**存在 + 是目录 + 含 `package.json` / `cordis.yml` / `cordis.yaml` / `cordis.patch.yml` 之一**；不满足 → **拒绝执行 + exit 1**（归入既有的 **1 = 出错**，**没有新增退出码档位**），且此时注册表与 shim 都不会被动过。

### `bin/rescue-daemon.mjs`（`dsh-pm-rescue`）

| 命令 | 语义 | 退出码 |
|---|---|---|
| `[--profile <dir>] [--port <n>] [--dsh <cmd>] [--cwd <dir>]` | 独立救援服务（默认 **3082**） | 常驻；端口被占 → **1**（不漂移） |
| `--help` | 用法（含写接口防护说明） | **0** |

### `bin/dsh-boot.mjs`（`dsh-pm-boot`）

| 命令 | 语义 | 退出码 |
|---|---|---|
| `[--profile <dir>] [--dsh <cmd>] [--wait-ms <n>] [--cwd <dir>]` | 自检 → 修复/隔离 → 启动 → 等就绪 | **0** = 就绪；**1** = 未就绪 |
| `--repair-only` | **只自检+修复，不启动引擎**（watchdog 用） | **0** = 健康；**2** = 修复后仍有问题 |
| `--pause` | 结束时等按键（供 open-boot 弹出的窗口用） | 同基础用法 |
| `--help` | 用法 | **0** |

Windows 双击等价物是**包内** `bin\dsh-boot.cmd`（只显示进度，引擎日志在 profile 里）。

## 4. 写接口防护（L11）

本地 HTTP 写接口加了三道闸：**同源 `Origin`**（同机同端口白名单）、**一次性令牌**、**单飞**。

| 接口 | 方法 | 第三方 `Origin` | 缺/错 `X-DSH-PM-Token` | 并发第二个 |
|---|---|---|---|---|
| `/api/boot` | POST | **403** | **401** | **409**（busy） |
| `/rescue/api/start`、`/api/start` | POST | **403** | **401** | **409**（与 boot 共用闸门） |
| `/rescue/api/fix\|stop`、`/api/fix\|stop` | POST | **403** | **401** | — |
| `/api/status`、`/api/verify`、`/rescue/api/status\|verify` | GET | 不校验 | 不校验 | — |

- **同源白名单 = 同机同端口的三种等价写法**（`allowedOriginsOf`）：`http://127.0.0.1:<端口>`、`http://localhost:<端口>`、`http://[::1]:<端口>`。三者都指向本机回环，所以从 `http://localhost:3081/` 打开的启动页与 `127.0.0.1` **完全等价**（页内 `POST /api/boot` 带的是 `Origin: http://localhost:3081`）——以前只认 `127.0.0.1` 时，用户在自己机器上用 `localhost` 打开反而被判"跨站"→ 403（t8 终审 F1，已修）。
- **端口必须一致**：`http://localhost:<别的端口>` 或任何第三方域名一律 **403**。
- **不按 `Host` 头派生白名单、也不因"没有 `Origin`"就放行**：跨站页面能伪造 `Host`/`Referer`，也能发不带 `Origin` 的简单请求；按它们放开等于把"只允许本机自身页面"降级成"任意网页都能触发启动/隔离/杀引擎"（DNS rebinding 面）。缺 `Origin`（非浏览器 / 本地工具）**仍然必须带令牌**，否则 401。
- 令牌：服务启动时 `randomBytes(24)` → 48 位 hex，只注入页面 `<meta name="dsh-pm-token">` 与请求头 `X-DSH-PM-Token`（常量时间比较）；**不写日志、不落盘**，每次启动都不同。
- 判据顺序：先看 `Origin`（不合就 403），再看令牌（不对就 401），最后才是单飞（`409`）。
- 所以第三方网页 `fetch('http://127.0.0.1:3081/api/boot', { method: 'POST' })` 会被拒；本地工具（无 `Origin`）带正确令牌可以调用；从 `localhost` 打开的启动页带令牌也能调用。

## 5. `--uninstall` 卸载闭环（R13）

`npx dsh-pm-launcher --uninstall [--profile <dir>] [--port <n>]` 按四步清理，幂等（确认没有可清理项也 exit 0）。

**退出码三档**：**0** = 完成 / **1** = 出错 / **2** = **归属未确认** —— 当 `netstat`/`tasklist` 探测不可用（受限会话、安全策略拦命令）时，
无法判断"进程是不是本 profile 的守护"，于是**不停止任何进程**、**保留** `<profile>\.open-boot.pid`（留线索）、
**不报"卸载完成"**，并打印人工核对建议；探测恢复后重跑即可（这修掉了"探测被拦还假报成功"的 F2）。
出错与未确认同时发生时按 **1** 报（优先级 1 > 2 > 0）。

**动注册表之前先过目标闸门**：`--profile` 目标必须**存在 + 是目录 + 含 `package.json` / `cordis.yml` / `cordis.yaml` / `cordis.patch.yml` 之一**；
不满足 → **拒绝执行并 exit 1**（归入既有的 1 = 出错，未新增档位），下面第 2/3 步的全局 `DSHWeb*` 删除与 `.vbs` 操作都**不会**发生（详见 §3 的 `--profile` 校验说明）。

1. **停本 profile 的守护**：依据 `.open-boot.pid` + 锁端口归属（`--port+1000`）+ 进程镜像**三重校验**；
   校验判定为"不是本进程" → **跳过**该进程并继续；判定为"**归属未确认**"（探测不可用）→ **整体 exit 2**，
   不停止任何进程、不动 pid 文件（绝不 `taskkill /T` 整棵树、也不动别的 profile 的进程）。
2. **删自启**：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下**所有** `DSHWeb*` 值（含历史遗留的 `DSHWebRescue`），逐个打印键名。
3. **删包装脚本**：profile 内 `open-boot-autostart.vbs`、`open-boot-ui.vbs`。
4. **清 PID**：`<profile>\.open-boot.pid`（**仅 exit 0 时**）；**日志默认保留**（`open-boot*.log` / `health.log` / `rescue-daemon.log`）。

引擎（3080）**不在清理范围内**。管理器卸载自身前会先调用它（旧版本无 `--uninstall` → 记为 `skipped`，不阻断卸载）。

## 6. 开机自启（Windows）

| 动作 | 命令 | 写什么 |
|---|---|---|
| 安装 | `npx dsh-pm-launcher --install-autostart` | `HKCU\...\Run\DSHWebFront` → `wscript` 调用 `open-boot-autostart.vbs`（登录静默常驻）与 `open-boot-ui.vbs`（确保 3081 后开浏览器） |
| 查看 | `npx dsh-pm-launcher --autostart-status` | 只读：注册表值、shim 是否存在、守护是否持有锁端口 |
| 移除 | `npx dsh-pm-launcher --uninstall-autostart`（或 `--uninstall`） | 删所有 `DSHWeb*` 值 + 两个 `.vbs`；未安装时 exit **0** |

- 包装脚本正文**纯 ASCII**，路径由 `WScript.ScriptFullName` 运行时自解析 —— 中文用户名/含空格路径不会乱码。
- 自启项**只有本工具写**（迁移包 `deploy.ps1` 只调用本命令，不自己写注册表）；卸载插件后请执行 `--uninstall-autostart`，否则自启项会指向已删除的包。
- macOS/Linux：没有 `--install-autostart`，用 `--supervise` 自行挂到系统服务/launchd/systemd。

### 6.1 自启项被删掉之后怎么恢复（`--uninstall` / `--uninstall-autostart`）

> 这一个子节回答一个具体问题：**那两个命令把 `DSHWeb*` 删干净了，之后想恢复该怎么写、恢复成什么形态？**

**① 删了什么、没动什么**

| | 内容 |
|---|---|
| **删** | ① `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下**所有**名字以 `DSHWeb` 开头的值 —— 当前只有一个 `DSHWebFront`，历史版本还留过 `DSHWebRescue`；因为是机器级单值名，**别的 profile 写的那一个也会一并被删**。② 你**指定的那个 profile**（默认 `~/.dsh/profiles/web`）里的 `open-boot-autostart.vbs`、`open-boot-ui.vbs`。③ `--uninstall` 还会清掉 `<profile>\.open-boot.pid`（`--uninstall-autostart` 不碰 pid） |
| **不动** | 引擎（3080）的进程与配置、`rescue-daemon`（3082）、**别的 profile 的守护**（归属三重校验不通过就跳过）、profile 的 `package.json` / `cordis.patch.yml`，以及**所有日志**（`open-boot*.log` / `health.log` / `rescue-daemon.log` 一律保留） |

**② 怎么恢复**

```sh
# 恢复「当前 profile」的开机自启（写回 DSHWebFront + 重建两个 .vbs）
npx dsh-pm-launcher --install-autostart

# 如果被删掉的是「另一个 profile」的自启项：在**那个 profile** 上重跑同一条命令
npx dsh-pm-launcher --install-autostart --profile <那个 profile 目录>
```

- 注册表里只有**一个**值名（`DSHWebFront`），所以语义是"**谁最后装谁生效**"——把自启指回你想要的那个 profile，就是重跑它的 `--install-autostart`。
- 恢复出来的形态：值内容是 `"<wscript>" //nologo "<profile>\open-boot-autostart.vbs"`；shim 正文**纯 ASCII**（第一行写着 `Generated by dsh-plugin-manager-pro. Safe to delete.`），运行时用 `WScript.ScriptFullName` 推导自己所在目录，再调用 `<profile>\node_modules\dsh-plugin-manager-pro\bin\open-boot.mjs`；写盘后做**回读校验**（字节数 + 每条命令行都在），校验不过就直接报错，**宁可不装也不装一个坏的自启**。

**③ 怎么核对**

```sh
npx dsh-pm-launcher --autostart-status   # 只读（未安装也 exit 0；非 Windows 明确提示并 exit 1）
npx dsh-pm-launcher --status             # 引擎 / 启动器 / 守护的真实状态 + health.log 最后一条
```

`--autostart-status` 会打印三项状态 + 最近心跳：

1. **注册表值**：已安装 / 未安装，值内容，以及注册表指向的那个 `.vbs` 是否真的存在（不存在会提示"自启会失败，请重新 `--install-autostart`"）；注册表指向的不是本工具的 shim 时也会标出来。
2. **守护**：锁端口 `port+1000`（`port` 默认 3081）是否被持有 —— 没被持有就是"守护未运行"。
3. **启动器**：`port` 上跑的是不是本启动器（identity `dsh-open-boot`）；是别的进程会报出占用者 pid。

**④ 一个坑：包目录没了**

自启最终拉起的是 `<profile>\node_modules\dsh-plugin-manager-pro\bin\open-boot.mjs`。
**插件被卸载或包目录被删掉**时这个路径不存在 —— 此时 shim 不会静默失败，它会把原因写进
`<profile>\open-boot-autostart.error.log`（一行 `… launcher script missing: <path>`）并以 **exit 3** 退出；
所以"开机没反应"先看这个文件。修复顺序是：**先重装插件**（`dsh plugin --profile web add dsh-plugin-manager-pro@0.9.1`）**再重跑 `--install-autostart`**。

## 7. `health.log` 自检留痕（P1-5）

- `--status` **每次**都往 `<profile>/health.log` 追加一行（不是"纯只读命令"）。

  ```text
  2026-10-06T02:31:10.000Z OK boot=up@3081 engine=up@3080
  ```

  格式：`<ISO 时间> OK|FAIL boot=<up|down|occupied>@<启动器端口> engine=<up|down|occupied>@<引擎端口>`（`occupied` = 端口被非本工具进程占用）；控制台同时打印「最近自检：…」。
- **轮转**：只保留最近 **7 天**、最多 **1000** 行（`pruneHealthEntries`，写入前裁剪）。行首没有可解析时间戳的行按"用户手工写的内容"处理，不因年龄被丢（但仍受 1000 行上限约束）；写失败不影响 `--status` 的退出码。
- 用途：回答"上次自检是什么时候、什么结果"——排查"昨天还能用、今天不行"这类问题时先看它。

## 8. 启动器常驻（`--supervise`）

- 静默确保 3081 有服务：**只有 HTTP 握手失败**才拉起；健康实例绝不误杀。
- 单实例由**锁端口**保证：`server.listen(port+1000, "127.0.0.1")` 成功即持有锁；重复启动会因 `EADDRINUSE` 自行退出（exit 0）。
- 日志写 `<profile>/open-boot-supervisor.log`：状态变化 / 心跳（默认 10 分钟）/ 退出 / 未捕获异常四类；重启时若发现上一次没有正常退出记录会明确提示。

## 9. 常见故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开 3081 是别人的页面 | 端口被非本工具进程占用（工具不会漂移端口） | `npx dsh-pm-launcher --status` 看占用者 pid；结束它，或 `--port` 换端口并同步改浏览器主页/自启 |
| `--status` 报守护未运行但 3081 能开 | 守护被外部结束过（锁端口已释放） | `npx dsh-pm-launcher --supervise` 重新常驻；日志见 `open-boot-supervisor.log` |
| 引擎起不来 | 坏 bundle / 坏 patch / 端口被占 | ① 浏览器开 <http://127.0.0.1:3081/> →"运行检查 → 修复 → 启动"；② `npx dsh-pm-boot --repair-only` 看隔离列表；③ `npx dsh-pm-launcher --status` |
| 拉起引擎时弹窗 | 设计如此（只有真需要拉起时才弹可见窗口） | `--no-window` 关闭；守护模式默认静默 |
| 3081 上打不开救援页 | 旧版本（0.9.0）的 `/rescue` 不在 open-boot 上 | 升级到 0.9.1；或临时用 `npx dsh-pm-rescue`（3082） |
| 自启不生效 | 注册表项被手工删过 / 指向旧包 | `npx dsh-pm-launcher --autostart-status` → `--install-autostart` 重装 |
| 卸载插件后仍开机弹东西 | 自启项没清 | `npx dsh-pm-launcher --uninstall-autostart` |
| 第三方网页能触发启动 | 不应该（L11 已拦） | 见 §4；若真被触发，请附 `Origin`/令牌情况报 issue |
| `--uninstall` 返回 **exit 2**（归属未确认） | `netstat`/`tasklist` 探测不可用（受限会话、安全策略拦命令）→ 不知道进程是不是本 profile 的守护 | 这是**故意的保守行为**：没停任何进程、`.open-boot.pid` 被保留。先 `npx dsh-pm-launcher --status` 人工核对启动器/守护/引擎，再换一个能跑 `netstat`/`tasklist` 的会话重跑 `--uninstall` |
| 从 `http://localhost:3081/` 打开启动页 | 0.9.1 起 `localhost` 与 `[::1]` 已在同源白名单内（同机同端口），可正常自动启动 | 若仍 403：确认端口与页面 URL 一致（换端口要用同一个端口打开），并附页面 `Origin` 值报 issue |
| 命令只打了用法错误就结束（**exit 1**、stdout 为空） | `--profile` 取值缺失 / 被后面的开关占用（以 `-` 开头）/ 全空白 —— 例如 `--uninstall --profile --port 63001` | 这是**用法错误**：什么都没动过（注册表 / pid / 进程 / 日志都没碰）。补上取值，或写成 `--profile=<目录>`，再重跑 |
| 提示"拒绝安装开机自启 / 拒绝执行"且 exit 1 | 目标闸门没过：`--profile` 指向的目录不存在、不是目录，或缺 `package.json` / `cordis*.yml` | 检查 `--profile` 是否指到了真正的 profile 目录（默认 `~/.dsh/profiles/web`）；闸门在动注册表之前生效，注册表与 shim 未被改动 |

## 10. 核对表：文档条目 → 代码位置

| 文档条目 | 代码位置（v0.9.1 工作树） |
|---|---|
| `dsh-pm-launcher` → `bin/open-boot.mjs`；`dsh-pm-boot` → `bin/dsh-boot.mjs`；`dsh-pm-rescue` → `bin/rescue-daemon.mjs` | `package.json` 的 `bin` 字段 |
| 3081 = open-boot 唯一网页入口；3082 = rescue-daemon | `bin/open-boot.mjs` 的 `RESCUE_DAEMON_PORT`（约 79）与 `HELP_TEXT` 端口分工段（约 151）；`bin/rescue-daemon.mjs` 的 `PORT_DEFAULT = 3082` |
| `DSH_ENGINE_PORT` 覆盖引擎端口（默认 3080） | `lib/enginectl.mjs` 的 `ENGINE_PORT`（约 38–45） |
| 锁端口 = `port + 1000` | `bin/open-boot.mjs` 的 `acquireLock` 调用点（约 515）与 `--status`（约 562/578）、`--autostart-status`（约 748）、`collectOwnedDaemons`（约 823） |
| `--ensure` / `--supervise` / `--status` / `--install-autostart` / `--uninstall-autostart` / `--autostart-status` / `--uninstall` / `--help` / `--no-window` / `--quiet` / `--interval` / `--heartbeat-min` / `--cwd` / `--dsh` / `--profile` / `--port` / `--wait-ms` | `bin/open-boot.mjs` 的 `parseArgs`（约 100–120）+ `HELP_TEXT`（约 125–152） |
| `--uninstall` 四步（停守护 → 删 `DSHWeb*` → 删 shim → 清 pid）+ **三档退出码 0/1/2** | `bin/open-boot.mjs` 的 `uninstallLauncher`（约 917；`result.exitCode` 约 1016：1=出错 > 2=归属未确认 > 0=完成）、`collectOwnedDaemons`（约 822，三重校验 + `verified/unverified` 标记）、`removeDsWebRunValues`（约 704）、`HELP_TEXT` 的 `--uninstall 语义（冻结契约）`（约 142–152，含三档退出码）、`main()` 的 `r.exitCode ?? (r.ok ? 0 : 1)`（约 1218） |
| `--install-autostart` 写 `HKCU\...\Run\DSHWebFront` + 两个 `.vbs` | `bin/open-boot.mjs` 的 `RUN_KEY`/`AUTOSTART_NAME`（约 69–71）、`reg add`（约 774）、shim 生成（`autostartShimPath`/`uiShimPath`） |
| **`--profile` 取值校验（缺失 / 以 `-` 开头 / 全空白 → 用法错误）、`--profile=<目录>` 形式、以及目标闸门**（§3 说明段、§5 第 2/3 步之前、§9 两行） | `bin/open-boot.mjs` 的 `parseArgs`（约 95–143：`fail` 约 103、`profileValueError` 约 105、`--profile` 分支约 113、`--profile=` 分支约 118、取值 `trim()+resolve()` 约 116/122）、`main()` 的 `usageError` 分支（约 1265–1271：**任何动作之前** stderr 打用法 + `return 1`，不装崩溃日志/不写日志）、`HELP_TEXT` 的「输入校验（t14-F1）」段（约 189–193）、目标闸门调用点：`installAutostart`（约 805）、`uninstallAutostart`（约 838）、`uninstallLauncher`（约 970）；判定实现 `lib/enginectl.mjs` 的 `looksLikeProfileDir`（约 226–238：存在 + 是目录 + 含 `package.json` / `cordis.yml` / `cordis.yaml` / `cordis.patch.yml` 之一） |
| `--uninstall-autostart` 未安装时 exit 0 | `bin/open-boot.mjs` 的自启移除分支（`listRunValues` 约 686 → `removeDsWebRunValues` 约 704） |
| `health.log` 追加与轮转（7 天 / 1000 行） | `bin/open-boot.mjs` 的 `HEALTH_LOG`/`HEALTH_MAX_LINES`/`HEALTH_MAX_AGE_DAYS`（约 73–76）、`pruneHealthEntries`（约 216）、`appendHealthLog`（约 234）、`readLastHealthEntry`（约 249）、`--status` 追加点（约 582 附近） |
| 写接口 403/401/409 与令牌规则 | `lib/enginectl.mjs` 的 `newApiToken`（约 532）、`allowedOriginsOf`（约 551，白名单 = `127.0.0.1` / `localhost` / `[::1]` + **服务自身端口**）、`sameOriginOf`（约 556，白名单第一项）、`guardWriteRequest`（约 573）、`createSingleFlight`（约 546 之后）；接线：`bin/open-boot.mjs`（约 1034–1044）、`bin/rescue-daemon.mjs`（约 307–330） |
| 引擎健康 = HTTP 握手 + 身份指纹 | `lib/enginectl.mjs` 的 `httpProbe`（约 74）、`ENGINE_MARKERS`（约 52）、`engineHealth`（约 101） |
| 启动器/救援身份 = JSON `app` 字段 | `lib/enginectl.mjs` 的 `LAUNCHER_APP`/`RESCUE_APP`（约 48–50）、`launcherHealth`（约 117） |
| 停止引擎三重校验 | `lib/enginectl.mjs` 的 `stopEngine`（约 438）、`describeEngineProcess`（约 422） |
| `dsh-boot` 的 `--repair-only` / `--pause` / 退出码 0/1/2 | `bin/dsh-boot.mjs` 的 `parseArgs`（约 55–70）、`HELP_TEXT`（约 40–50）、`process.exit(code)`（约 180） |
| 退出码落点（§3 的每一格） | `bin/open-boot.mjs`：前台端口占用分支（约 1116–1129，自己的实例 → `exit(0)`、别人的进程 → `exit(1)`）、未捕获异常（约 286，`exit(1)`）、`--uninstall` 的三档（约 1016，1 > 2 > 0）、入口 `process.exit(code)`（约 1200 前后）。`bin/dsh-boot.mjs`：`return 2`（约 100，repair-only 未修复）、`return 1`（约 122/143）、`process.exit(code)`（约 180）。`bin/rescue-daemon.mjs`：端口被占与服务启动失败 `process.exit(1)`（约 315/348/352）、入口 `process.exit(code)`（约 390） |
| 自启删除范围 / 恢复形态 / 缺包时的行为（§6.1） | `bin/open-boot.mjs` 的 `AUTOSTART_NAME = "DSHWebFront"`（约 68）、`RUN_VALUE_PREFIX = /^DSHWeb/i`（约 71）、`removeDsWebRunValues`（约 704：删**所有**匹配值；非 Windows 记 skipped；注册表读不到时明告"未确认"）、`uninstallAutostart`（约 790：删给定 profile 的两个 shim + 注册表值）、`uninstallLauncher`（约 885：第 2 步删注册表、第 3 步删本 profile 的 shim、第 4 步清 pid；第 1 步只停本 profile 的守护）、`installAutostart`（约 759：重建两个 shim + `reg add`，失败返回 ok=false）、`buildShimLines`（约 624：`WScript.ScriptFullName` → `base\node_modules\dsh-plugin-manager-pro\bin\open-boot.mjs`；文件不存在时写 `open-boot-autostart.error.log` 并 `WScript.Quit 3`）、`writeShim`（约 663：字节数 + 每条命令行回读校验）、`autostartStatus`（约 733：注册表值 / shim 是否存在 / 锁端口归属 / 启动器身份 / 最近心跳；非 Windows `ok=false` → exit 1） |

> 测试与验收：`node test-launcher.mjs --strict`（启动器/守护/自启/卸载闭环/写接口防护/健康留痕的端到端断言，含真实端口与临时 profile）；`npm test` 串起四套测试。归档见 `audit/verify-090/logs/`（团队任务 t1）。
