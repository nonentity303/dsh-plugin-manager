# v0.8.1 发布说明

> 版本：dsh-plugin-manager-pro 0.8.1 · 2026-09-04
> 主题：**运行期救砖补完 + 全部插件联网更新**

延续 v0.8.0（事务化卸载 / 操作历史撤销 / 场景方案 / 来源修正 / 依赖感知），本次修复两个现场问题：

## 1. 🔧 运行期失败条目自动隔离（@nanmicoder/dsh-agent-teams 事故修复）

**问题**：独立救砖的启动前自检（`verifyProfile`/`fixProfile`）只检查「bundles 可解析 + patch 可解析」，
对「能解析但启动即抛错」的插件（插件与引擎版本不兼容等）无能为力——loader 的
`failed to apply loader entry <id> (<name>)` 会拖垮**整棵树启动**，引擎起不来，页面救砖也够不着。

**修复**（`lib/preflight.mjs` + `enginectl.mjs` + 三个 bin 全部接线）：

- `isolateFailedEntries(profileDir, logText)`：从引擎启动日志解析失败条目，往 `cordis.patch.yml`
  写归属标记的隔离行 `{id, name, disabled: true}`（带 `.rescue-bak-*` 备份，可逆）。
- `startEngineWithQuarantine`：启动失败 → 读日志（尾部 64KB）→ 自动隔离 → **重试一次**。
- `open-boot`（3081 启动器）、`rescue-daemon`（/api/start）、`dsh-boot` 三个入口全部生效；
  隔离后引擎恢复启动；更新/替换该插件后移除隔离行即可。

## 2. 🌐 除管理器外的全部 mod 改为联网更新

**问题**：本机插件多为 `file:` 安装（vendor tgz），旧版本直接判为「本地包，无法更新」。

**修复**：`file:` 安装包（vendor tgz / 目录）纳入联网更新（registry 直装 / GitHub 下载 / 浏览器下载）；
仅两类保持原样——**插件管理器自身**（请用 `dsh plugin add` 安装新版）与
`link:/workspace:` 开发链接（避免破坏本地开发引用）。

## 3. 运维

- 3081 独立入口（open-boot）已在本机常驻 + 开机自启（HKCU Run `DSHWebFront`）；
  桌面快捷方式「DeepSeek Harness Web UI」指向 `dsh-web-rescue.ps1`（自检→隔离→启动）。

## 测试

- `test-bundle.mjs` / `test-render.mjs` / `test-integration.mjs` 全绿（新增 isolateFailedEntries 4 项断言）。
- 3080 主实例冒烟（list/自检/诊断/历史/场景/预览/救援页）通过；3081 状态/启动 API 验证通过。
