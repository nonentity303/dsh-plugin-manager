> ⚠️ **内部文档（不要用作 GitHub Release 正文）**：本文件保留审计编号与证据对照，供开发时与工作区内的审计报告
> （`audit/*.md`，**不在本仓库内**）逐条比对。面向用户的公开发布说明见 [`../releases/0.9.0.md`](../releases/0.9.0.md)。

---

# 0.9.0 发布说明（夺舍新页面 / UI 更新版）

> **一句话**：0.9.0 是 **UI 发布版**——客户端换成"夺舍新页面"（真正接管内置插件页），并修掉审计②的 C1–C6。
> 核心模块修复（H1–H5 管理器 host、L1–L8 启动器与救砖链、R1–R15 仓库与发布面）与 **0.8.3 是同一批**，
> 本版同样包含，逐条说明见 [0.8.3](RELEASE_NOTES_INTERNAL_0.8.3.md)；本文件不再把它们当主体叙述。

---

## 1. 夺舍新页面（本版主体）

**注册与接管**（`cordis.patch.yml` + 客户端注册）

- 管理器把自己注册进 `main`(**key=plugins**) 与 `sidebar.panellist`(**id=plugins**)，从而**接管内置插件页**；
  同名 key / 重复子槽位是硬冲突（`dsh-client-ui-slots` 会抛错），因此 patch 层先关掉内置的 `ui-plugin-manager`。
- 注册时带 **`children`**（这是「能不能渲染配置页」的前提，见 C4）：声明 **7 个 `plugins.*` 子槽位**——
  `plugins.item`、`plugins.bundle.activation`、`plugins.bundle.config`、`plugins.row.config`、
  `plugins.detail.actions`、`plugins.detail.badge`、`plugins.detail.section`；另注入注册 `settings.plugins.tab`。
- **真实渲染出口**（0.1.7 契约里第三方插件实际会用的三个）：
  `plugins.row.config`（key = `<包名>#<行id>`：行内 `view:'summary'` + 展开 `view:'page'`）、
  `plugins.bundle.config`（key = 包名：包级配置页）、
  `plugins.item`（key = 条目 id：官方插件自带配置页的 `summary` / `page`）。
  出口按键**存在性**生成：没有插件注册的键不会产生空壳，避免"点了没反应"。

**信息架构（5 个 tab）**

| tab | 内容 |
|---|---|
| `main`（官方内置·可选） | 引擎自带、默认未启用的组合包（`OPTIONAL_BUNDLES`）+ 自带配置页的官方插件 + 版本豁免 |
| `list`（全部插件） | 插件清单：搜索、启用/禁用、行内 ⚙ 配置、行内卸载、来源与版本、折叠分类（必要程度×来源） |
| `market`（插件市场） | dshfind 精选目录 + 一键安装（npm / GitHub / 直链） |
| `ops`（操作与场景） | 事务化卸载与预览、操作历史一键撤销、场景方案、来源人工修正 |
| `maintenance`（维护） | 更新源与刷新、启动前自检、救援中心入口、下载目录 |

**其它**：滚动容器修复（启用/禁用后不再跳回顶部）；浮动救援球在设置页不可用时仍能进 `/rescue`。

## 2. UI 侧缺陷修复（C1–C6，审计②）

| ID | 缺陷（修复前） | 本版修法 | 可验证点 |
|---|---|---|---|
| **C1**（high，功能回归） | 7 个 `plugins.*` 子槽位**只声明不渲染** → 第三方插件的配置入口（行内 ⚙ / 配置页）**完全消失**（旧文档"仍可用"的说法是错的） | 按 0.1.7 契约生成真实出口：`plugins.row.config`（`<包名>#<行id>`，行内 summary + 展开 page）、`plugins.bundle.config`（包名）、`plugins.item`（条目 id，官方插件配置页）；未注册的键不产生出口 | `test-render.mjs` 断言 `hasConfigIcon`；仓库内 `plugins.row.config` 出口可见于源码 L658/L824 与构建产物（0.8.x 旧 bundle 里为 0 命中） |
| **C2** | `--dsw-alias-state-warning-primary` 令牌**未定义**且 18 处引用无 fallback → 相关按钮/状态**不可见**（实测 4 处 computed 失效） | 为该令牌补 fallback（令牌缺失时回退到已定义令牌/字面色），19 处引用统一走同一取值函数 | `test-render.mjs` 令牌断言；构建产物中该标识 19 处、含 fallback 分支 |
| **C3** | `settings.plugin.item` 死路径整体残留（0.1.7 无任何声明者）→ `configCards` 恒空、⚙ 按钮永不出现 | **整段读取与渲染删除**，改由 C1 的三个真实出口承担 | 构建产物内不再有 `settings.plugin.item`（源码中仅剩说明注释） |
| **C4** | 设置页 tab 复用外壳但注册**没有 `children`** → "打开配置页"是死按钮（且二次声明修不了） | 注册带 `children`（7 个槽位），从而拿到框架的 `renderSlot` 才能渲染配置页 | 源码 L2027 注释 + 默认导出契约；`test-bundle.mjs` 槽位声明断言 |
| **C5** | 官方卡片缺 `view:'summary'` → 卡片**没有一行说明** | 官方条目改为请求 `view:'summary'`（与内置页一致） | 源码 L2037；`plugins.item` summary 出口 |
| **C6** | 官方清单是**一次性快照** → 运行时切语言不跟随、后注册条目不出现（实测 chrome 英文/卡片中文） | 改为按「`plugins.item` 槽位版本 + locale revision」做响应式投影 | 源码 L1872/L2760-2780：`getVersion('plugins.item')` + `locale.getSnapshot().revision` 订阅 |

## 3. 同批次：与 0.8.3 完全相同的核心修复

本版包含 0.8.3 的全部核心修复（同一批改动），逐条细节见 **[内部版 0.8.3 说明](RELEASE_NOTES_INTERNAL_0.8.3.md)**：

- **H1–H5**（管理器 host）：开关/隔离不再假报"需重启"；运行期错误可读（`_error`）；自动隔离有保护集 + 连续失败阈值；
  下载目录归档走完整校验链；Windows 参数引用不再被拆（含从 registry 装错包）。
  - **H3 口径说明（t18 补，按独立复核 F3）**：**修复代码正确，但触发路径在 0.1.7 真引擎上不可复现** —— cordis 4.0.4 仅在 **apply 成功后**发射 `internal/plugin`（`cordis/lib/index.js:1093`；`emitPluginDisposed` `:970` 同事件名），失败态走 `internal/status`（`:1298`），而 handler 只监听 `internal/plugin`（`lib/index.js:1183`）。真引擎 3 轮真实失败：发射 **0 次**、`failureStreak` 恒 `{}`、无禁用行、无备份 → H3 为**防御性修复（待引擎支持）**，原 blocker 前提"会把 `ui-*` 写成持久禁用行"在当前引擎**不可复现**（风险为潜在）。细则见 `audit/fix-verify-caliber.md`。
- **L1–L8**（启动器与救砖链）：`dsh-boot.cmd` 可用；引擎 cwd 不再锁包；守护有崩溃日志/心跳/存活校验；
  健康判定 = HTTP 握手 + 身份指纹（不再有"假健康"）；PID 有身份、停止前多重校验（不误杀）；`--wait-ms` 不再吞参；
  启动失败早期检测 + 日志路径；自启 `.vbs` 纯 ASCII + 回读校验。
- **R1–R15**（仓库与发布面）：见 §4。

## 4. 可安装入口与发布面（R1/R8/R9/R14/R3/R4/R5）

| 项 | 状态 |
|---|---|
| CLI 入口（R1） | `package.json` 增 `bin`：`dsh-pm-launcher`（3081 启动器/守护/自启）、`dsh-pm-boot`（启动序列）、`dsh-pm-rescue`（独立救砖守护）；`exports["./bin/*"]` 放行子路径。实测装进临时工程后 `.bin` 生成三个真实 shim，`--help` 全部退出 0 |
| 发布物（R8） | `files` 精确白名单；1.64 MB `lib/client.js.map` 不再进包（`npm pack` 19 项、`has map: false`） |
| 测试（R9） | 新增 `test-launcher.mjs`（57 断言，随机端口 + 临时 profile，注册表只读）；`npm test` = build + bundle + render + integration + launcher |
| 包管理器（R14） | `packageManager: npm`；保留 npm 锁文件、删除冗余 pnpm 锁；`pnpm-workspace.yaml` 的 `allowBuilds.esbuild` 取明确布尔 |
| 迁移链（R3/R4/R5/R15） | vendor 刷新到当前版本 + manifest `_meta` + `npm run check:vendor`；`deploy.ps1`（含仓库根模板副本）不再自建 `.vbs`、不再写 `DSHWebFront`，改调包内 `--install-autostart`，并在写 profile 前做 vendor 版本断言 |

## 5. 安装 / 升级

```sh
# npm 已发布版本（或 GitHub Release 附的 tgz）
dsh plugin --profile web add dsh-plugin-manager-pro
# 离线 tarball
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.9.0.tgz
# 重启 web 生效
dsh web
```

自启（Windows）：`npx dsh-pm-launcher --install-autostart`；查看：`--autostart-status`；移除：`--uninstall-autostart`。
只想修 bug 不换 UI 的用户用 0.8.3（打包口径见 `../RELEASING.md` §7）。

## 6. 验证与互斥说明

- `npm test` 四套全绿；`test-launcher.mjs` 57 断言（含 L6/L1/L8/L4b 回归）；`npm pack --dry-run` 19 项、无 `.map`。
- 「0.9 新 UI」与「0.8.x 旧 UI」**不可混装**：新 UI 依赖 `cordis.patch.yml` 禁用 `ui-plugin-manager`；
  0.8.3 与 0.9.0 的客户端 bundle 互斥，升级/降级时请整包替换（`dsh plugin add` 会按版本号重装）。

## 7. 未闭环（写域外/流程项）

- ~~`README.md` 的入口用法仍在教 `node bin/...` 相对路径~~ **已解决**（2026-09-28）：README 的入口用法已同步为
  `npx dsh-pm-*` 系列命令；此条仅作历史记录保留。
- `.e2e/dsh-v08-demo/` 历史 fixture 无测试引用，保留待评审。
- R6/R7/R12/R13（外挂脚本退役、3081 端口分工文档、git tag/npm 发布口径、卸载闭环）见 `audit/00-摘要与修复清单.md`。
