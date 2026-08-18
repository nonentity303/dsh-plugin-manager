# dsh-plugin-manager-pro v0.7.1

> v0.7.0 的修订版：移除 open-boot 的 `--front` 3080 端口接管模式（端口争抢/keep-alive 竞态导致引导页无限循环），统一为稳定的 **3081 独立入口**。

## ✨ 救砖工具链（最终形态）

| 工具 | 说明 | 用法 |
|---|---|---|
| `bin/rescue-daemon.mjs` | **独立救砖守护**（3081）：自包含中文救援页 + verify/fix/start/stop/status API，不依赖主引擎 | `node bin/rescue-daemon.mjs --profile <dir>` |
| `bin/open-boot.mjs` | **网页启动入口**（3081）：打开 `http://127.0.0.1:3081/` → 自动 自检→修复→启动 → 跳转 3080。设为浏览器主页即"打开即启动"，无端口争抢 | `node bin/open-boot.mjs --profile <dir>` |
| `bin/dsh-boot.mjs` / `.cmd` | **Steam 式启动序列**：verify → 自动隔离坏插件 → 启动 → 健康等待；`--repair-only`；退出码 0/1/2 | 双击 `dsh-boot.cmd` |

- `lib/preflight.mjs`：standalone 自检/修复（bundle 解析性 + patch 可解析性；坏 bundle 以 `disabled:true` 写入 patch 可逆隔离；损坏补丁备份后重建）——与 host 内 `verifyProfile/fixProfile` 同源
- `lib/enginectl.mjs`：引擎探测/拉起/停止/PID 管理公共模块

## 🐛 修复

- **移除 open-boot `--front` 3080 接管**：该模式在引擎拉起期间会重新抢占 3080（`server.close()` 被浏览器 keep-alive 连接阻塞导致 boot 不触发、引导页无限循环）。保留 3081 独立入口（无端口争抢，稳定）
- **waitFor 状态判断**：`(entry.disabled ?? false) !== enabled`（undefined 场景与原逻辑等价，可读性重构）
- **log() ESM 化**：`require('fs')` → 导入的 `appendFileSync`（修复 HOST-REQUIRE 契约违规）
- **packageInfoOf 补 try-catch**；**engines 降至 ≥18**；**依赖维持 peerDependencies**
- **`files` 增加 `bin/`**（救砖工具进包）

## 🔧 配套脚本修复（~/.dsh/scripts）

- `dsh-web-start.ps1`：陈旧 PID 误判修复（web.pid 指向 svchost 等非 node 进程时不再拒绝启动）；移除 watchdog 循环启动
- `dsh-web-rescue.ps1`：yaml fallback 误判修复（注释开头的合法 patch 不再被判损坏）

## 📦 安装

```sh
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.7.1.tgz
dsh web
```

## 🧪 验证

- `node --check` 全部 JS 文件 ✓；`test-bundle.mjs` 11 项契约全绿 ✓
- rescue-daemon / open-boot（3081）冒烟测试 ✓
- 桌面快捷方式链路实机验证（kill 引擎 → rescue.ps1 → 自动拉起）✓
- open-boot 3081 网页启动流程实机验证（kill 引擎 → POST /api/boot → 引擎拉起 → 3080 恢复）✓
