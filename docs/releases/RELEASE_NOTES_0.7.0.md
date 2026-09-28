# dsh-plugin-manager-pro v0.7.0

## ✨ 新功能：独立救砖工具链（解决"救砖页与主引擎绑死"的单点故障）

主引擎启动失败时，`/rescue`（由主引擎注册）会随之瘫痪。v0.7.0 把救砖能力剥离为独立于主进程的工具链（零新依赖，纯 Node + 已有 yaml）：

| 工具 | 说明 | 用法 |
|---|---|---|
| `bin/rescue-daemon.mjs` | **独立救砖守护**（端口 3081）：自包含中文救援页 + verify/fix/start/stop/status API，不依赖主引擎 | `node bin/rescue-daemon.mjs --profile <dir>` |
| `bin/open-boot.mjs` | **浏览器访问即自检启动**：普通模式监听 3081（打开即 verify→fix→start→跳转 3080）；`--front` 常驻模式在引擎挂时接管 3080 端口，浏览器打开 3080 即触发自动拉起 | `node bin/open-boot.mjs --front` |
| `bin/dsh-boot.mjs` / `.cmd` | **Steam 式启动序列**：verify → 自动隔离坏插件 → 启动 → 健康等待；`--repair-only` 供外部调用；退出码 0/1/2 | 双击 `dsh-boot.cmd` 或 `node bin/dsh-boot.mjs` |

- `lib/preflight.mjs`：standalone 自检/修复（bundle 解析性 + patch 可解析性；坏 bundle 以 `disabled:true` 写入 patch 隔离，可逆；损坏补丁备份后重建）——与 host 内 `verifyProfile/fixProfile` 同源逻辑
- `lib/enginectl.mjs`：引擎探测/拉起/停止/PID 管理公共模块

## 🐛 修复

- **waitFor 状态判断**：改为 `(entry.disabled ?? false) !== enabled`（对 undefined 场景与原逻辑完全等价，可读性重构）
- **log() ESM 化**：`require('fs')` → 导入的 `appendFileSync`（修复 HOST-REQUIRE 契约违规）
- **packageInfoOf 补 try-catch**：manifest 解析失败不再抛异常
- **Node 版本要求降至 ≥18**（engines 更新，无依赖硬性要求）
- **依赖管理**：维持 peerDependencies（避免 pnpm 双实例）
- **打包修复**：`files` 增加 `bin/`（否则救砖工具进不了安装包）

## 🔧 配套脚本修复（~/.dsh/scripts，随文档说明）

- `dsh-web-start.ps1`：**陈旧 PID 误判修复**——web.pid 指向 svchost 等非 node 进程时不再误判"已运行"而拒绝启动（此前导致桌面快捷方式双击无效）；同时移除 watchdog 循环启动逻辑（看门狗由 open-boot `--front` 常驻替代）
- `dsh-web-rescue.ps1`：**yaml fallback 误判修复**——以注释开头的合法 cordis.patch.yml 不再被误判为损坏

## 📦 安装

```sh
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.7.0.tgz
dsh web
```

## 🧪 验证

- `node --check` 全部 9 个 JS 文件 ✓
- `test-bundle.mjs` 11 项契约检查全绿 ✓
- rescue-daemon / open-boot 冒烟测试（verify/status/boot）✓
- 桌面快捷方式链路实机验证（kill 引擎 → rescue.ps1 → 引擎自动拉起，start.log 确认 stale pid 忽略后 fresh start）✓
