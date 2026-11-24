# v0.8.0 发布说明

> 版本：dsh-plugin-manager-pro 0.8.0 · 2026-09-04
> 主题：**安全卸载 × 可撤销 × 场景化** —— 对标社区最佳实践的一轮体验与安全升级。
> 依据：`0.8优化建议.txt`（竞品对比报告：bululuburuarua666 事务化卸载 / @zaogaogwc 预览·历史·场景方案 / dsh-daemon 互补视角）。

## 新增功能

### 🔐 事务化卸载（建议一 + 建议六）
- 卸载前**影响预览**：展示依赖该包的已安装插件（反向依赖图：dependencies / peerDependencies / optionalDependencies）、将移除的 loader 条目、将清理的管理器开关行、bundles 声明。
- **四阶段事务**：备份（`package.json` + `cordis.patch.yml` → `.rescue-bak-<ts>`）→ 删除（仅目标包 + bundles/开关行，可选级联）→ **启动前自检验证** → 失败**自动回滚**（恢复备份 + 按原 spec 重装）。
- **卸载报告**：自检结果、清理开关行数、级联卸载包、残留目录列表。
- **残留清理**：Windows 文件锁导致的删除失败登记 `pendingRemovals`，下次启动自动重试。
- 支持 `file:`/`link:` 本地包（vendor tgz 安装场景）——与 registry 包同等对待。

### ⏱ 操作历史 + 一键撤销（建议二）
- 最近 20 次操作（卸载 / 启停 / 隔离 / 场景应用 / 重置开关），侧车持久化、跨重启保留。
- 卸载 → 恢复备份文件 + 重装依赖；启停/隔离/场景 → 恢复期望开关状态。
- 撤销后自动复核，撤销导致校验失败时明确提示。

### 🧩 场景方案（建议五）
- 把当前插件启停状态保存为命名场景（「办公/写作/演示」…），一键应用。
- 应用前**变更预览**（哪些条目会切换、受保护条目标注 🔒 跳过），确认后才执行；可更新、删除。

### 🏷 来源人工修正（建议三）
- 自动判定来源标签：`builtin`（随 dsh 提供）/ `local`（file:/link:）/ `github`（仓库声明）/ `npm`（默认）。
- 每行可手动覆盖（npm / GitHub / 本地 / 内置），持久化到侧车；自动判定依据包清单 `repository` 与依赖 spec。

### 🔗 依赖关系感知（建议四）
- 卸载时检测依赖链并提供级联模式；市场安装后提示缺失的 `dependencies` / `peerDependencies`（可选 `dsh.recommendedDeps`）。

## 其他变化
- 侧车文件 `plugin-manager.json` 升级 **v2**（overrides / history / scenarios / pendingRemovals），兼容旧版读取。
- `verifyProfile` 拆出 `verifyProfileNow` 供卸后校验复用；修复 pnpm 隔离布局下反向依赖图扫描（symlink 目录）。
- UI 新增「场景」「历史」面板、卸载预览对话框、来源选择器；中英文案同步。
- 新增测试：`test-integration.mjs`（进程内 host 集成：事务卸载/回滚/撤销/场景/来源/侧车）+ `verify-v08.mjs` + `start-v08.ps1`（独立端口 E2E）。

## 测试
- `node test-bundle.mjs`（契约，含 v0.8 新端点 13 项断言）✅
- `node test-render.mjs`（jsdom 渲染回归）✅
- `node test-integration.mjs`（进程内集成，31+ 断言全绿）✅
- **E2E（独立 profile `web-v08` @ 3082，不触碰 3080 主实例）**：33/33 通过——list/预览/场景/来源/事务卸载/撤销/救援页/自检全链路 ✅

## 与竞品差异
保持并强化护城河：独立救砖（3081 守护 + 启动前自检）仍为独有能力；本次补齐「事务化卸载 + 可撤销 + 变更预览」短板后，成为同时覆盖**事前预防 + 事中管理 + 事后救援**全链路的社区插件管理器。
