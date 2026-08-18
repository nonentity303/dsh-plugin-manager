# Plugin Manager 救砖机制优化方案

> 来源：DeepSeek 分享对话（https://chat.deepseek.com/share/khl0gyeklq9u3i8tt4）+ 对 dsh-plugin-manager-pro v0.6.9.1 源码的现状盘点。
> 目标：解决"救砖工具与主引擎绑死"的单点故障，实现 Steam 式自动隔离与"浏览器访问即自检启动"。

---

## 一、现状盘点（已具备的能力）

| 能力 | 位置 | 状态 |
|---|---|---|
| 启动前自检 verifyProfile（bundle 缺失/补丁损坏检测） | lib/index.js:1333, remote.js | ✅ 已有 |
| 修复 fixProfile（隔离坏 bundle + 恢复损坏补丁 + 备份） | lib/index.js:1362 | ✅ 已有 |
| 独立救援页 /rescue（自包含 HTML，调 /api 网关） | lib/rescue.js, index.js:976 | ⚠️ 已有但**依赖主引擎 HTTP 服务** |
| 失败插件自动隔离 autoQuarantine | index.js:957-959 | ✅ 已有（默认关） |
| 重启引擎 restartHarness（临时桥进程） | index.js:1185 | ✅ 已有 |
| 诊断/隔离/一键修复/卸载 | diagnose/quarantine/repairHarness/uninstallPackages | ✅ 已有 |
| 桌面快捷方式启动时自动检查 | verifyHint 文案提及 | ⚠️ 依赖用户双击，无独立入口 |
| 外部 watchdog（dsh-web-watchdog.ps1 每分钟 TCP 探测） | ~/.dsh/scripts（工作区既有） | ✅ 已有（仅重启，不修配置） |

## 二、核心矛盾

**/rescue 救援页由主引擎的 webServer 注册（index.js:976-986），主引擎启动失败 → 救援页随之瘫痪。**
即：救砖工具和主引擎绑死在同一进程，违背"救砖"初衷。

## 三、优化方向（按优先级）

### 🔴 P0-1：独立救砖守护服务（解耦单点故障）
把 verify/fix/启动/重启能力从主进程剥离，做成**独立于 DSH 主进程的 Node 守护服务**：
- `bin/rescue-daemon.mjs`：监听**备用端口 3081**（与 3080 分离），提供：
  - `verify`：standalone 版 profile 检查（不依赖 @deepseek-ai 运行时，纯 Node + yaml 解析 cordis.patch.yml + 检查 profile node_modules 中 bundle 存在性）
  - `fix`：隔离坏 bundle（patch 写入 disabled）+ 恢复损坏补丁（带 .rescue-bak 备份）
  - `start`：拉起 `dsh web`（spawn，脱离进程组）
  - `stop/restart`：按 PID 文件管理
- 附带一个极简自包含 HTML 救援页（复用 rescue.js 的 UI 风格），指向 3081。
- 主引擎挂了 → 浏览器访问 127.0.0.1:3081 仍可救砖。
- 公共逻辑抽取：`lib/preflight.mjs`（verify/fix 的纯函数版，host 内方法与其共用，避免双实现）。

### 🟡 P0-2：浏览器访问即触发自检启动（问题 3）
让"打开 localhost:3080"成为触发器：
- 方案：rescue-daemon 增加 `open-boot` 模式——监听 3080 端口，收到 HTTP 请求时：
  1. 探测主引擎是否就绪（健康检查）
  2. 未就绪 → 自动 verify → 有问题则 fix → spawn `dsh web`
  3. 302 重定向到 /rescue（或主页）
- 或者：常驻"前台探针"进程（不占 3080，只监听 3081 并定时探测 3080，发现请求意图由浏览器书签/主页触发）——实现成本低。
- 说明：真正"抢 3080 端口再让位"有竞态，优先实现 3081 独立入口 + 浏览器书签/主页指向 3081 的"启动并跳转"按钮。

### 🟢 P1-1：Steam 式自动隔离启动（问题 2）
- `bin/dsh-boot.mjs`（或增强 dsh-web-start.ps1）：启动序列 = verify → fix（自动隔离坏插件）→ spawn dsh web → 健康等待（TCP 探测 3080）→ 退出。
- 与现有 watchdog 协作：watchdog 检测到引擎崩溃 → 调用 `dsh-boot --repair` 而非裸重启。
- 可选增强：启动前快照 cordis.patch.yml + package.json，连续失败 N 次自动回滚到上次正常快照（借鉴 DSH Desktop Generation 机制；fixProfile 已有 .rescue-bak-* 备份基础）。

### 📋 P1-2：文档与桌面入口
- README 增加"救砖"章节：3081 独立救援入口、dsh-boot 命令、故障场景排查表。
- （可选）桌面快捷方式改指向 dsh-boot.mjs（自检+启动一体化）。

## 四、落地优先级

1. **P0-1**（独立救砖守护）→ 2. **P0-2**（浏览器触发启动）→ 3. **P1-1**（Steam 式启动序列）→ 4. **P1-2**（文档/入口）

## 五、风险与约束

- 独立服务**不得引入新依赖**（纯 Node 内置模块 + 现有 yaml/zod），保持零安装负担。
- verify/fix 的 standalone 版必须与 host 内方法**行为一致**（同一份逻辑）。
- 不要动主进程的 /rescue 注册（保留现状兜底），新增能力是叠加。
- 端口冲突处理：3081 被占用时自动寻找 3081+。
- 所有脚本保持 UTF-8，Windows PowerShell 兼容（PS 5.1 纯 ASCII 约束遵守）。
