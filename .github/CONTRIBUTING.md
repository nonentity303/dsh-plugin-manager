# 贡献与流程规范（dsh-drydock）

> 目标：**任何人都能照着这份文件，判断"我现在该做什么、做完怎么证明"**。
> 发布细节见 [`docs/RELEASING.md`](../docs/RELEASING.md)；版本与通道见 [`docs/版本与轨道.md`](../docs/版本与轨道.md)。

## 0. 红线（先看这四条）

1. **未经维护者明确确认，不得发布**：`npm publish` / `git tag` / GitHub Release / 新建或移动 dist-tag / 提交 PR 到第三方仓库，全部要等确认。
2. **未测试不提交**。测试要贴命令与输出，不接受"应该没问题"。
3. **不在 PR 里提交构建产物**：`lib/client.js` 已 `gitignore`，由 `prepack` / `npm test` 自动构建。
4. **不在 issue / PR / 日志里出现凭据**：API Key、`.npmrc` token、`_authToken`、DPAPI 文件内容。doctor 输出会自动脱敏，但仍请自查。

## 1. 开工前先读

| 你要做什么 | 先读 |
|---|---|
| 改代码 / 加功能 | `docs/ARCHITECTURE.md`、`docs/LAUNCHER.md`、`lib/capabilities.mjs` 的能力表注释 |
| 动桌面相关 | `docs/桌面版移植-1.1.0设计.md` + `lib/capabilities.mjs`（**能力门控是唯一开关事实来源，不许散落 `if (isDesktop)`**） |
| 发版 / 改版本号 | `docs/RELEASING.md`（§10 核对表、§11 多通道） |
| 改 Issue / PR 流程 | 本文件 + `.github/ISSUE_TEMPLATE/` |

## 2. 分支与命名

- **分支只表达轨道，不在分支名里写版本号**：`track/desktop`、`track/community`、`release/1.0.x`、`chore/<主题>`、`fix/<主题>`。
  （历史包袱：`desktop-1.1.0-rc.2` 这种"分支名 = 版本号"的写法已废弃 —— 改一次版本要同步三处。）
- 一个 PR 只做一件事；跨通道的改动拆开提，方便单独回滚。
- 禁止直接往 `master` 推功能提交；`master` 保持可发布。

## 3. 提交信息

`<type>(<scope>): <一句话>`，type ∈ `feat` / `fix` / `chore` / `docs` / `test` / `refactor` / `release`。

```
fix(launcher): 高位端口假失败（freePort 越过 64535）
docs(版本与轨道): 补桌面通道安装命令
release(1.0.5): 产物不入库 + 多通道发布链路
```

## 4. PR 流程（五步，不得跳）

1. **开 issue 或认领 issue**（一行说明你要做什么）→ 避免重复劳动。
2. **开分支**（按 §2 命名）→ 改代码 → 本地跑门禁：
   ```sh
   node test-isolation.mjs && node test-channels.mjs && node test-docs.mjs
   npm test            # 含构建；沙箱里 esbuild 会 EPERM，需正常权限
   ```
3. **提 PR**：用 `.github/pull_request_template.md`，**影响面**与**测试证据**两节必须填实。
4. **审阅**：涉及热文件（`lib/index.js` / `lib/enginectl.mjs` / `bin/*` / `src/client.jsx`）时，PR 里必须写"web 影响面"。
5. **合并后**：如果是修 bug 且当前有维护线，评估是否需要 backport（打 `backport` 标签并说明目标线）。

## 5. 通道与版本（最容易踩的地方）

- **版本号里的预发布标识就是通道**：`-rc.N` → `next`、`-desktop.N` → `desktop`、`-community.N` → `community`、无后缀 → `latest`。
- **桌面/社区桌面的宿主升版适配只动后缀，不动核心版本号**（`1.1.0-desktop.1 → .2`）。
- 通道的机器可读定义只有一处：`release/channels.json`。改它必须同时跑 `node test-channels.mjs`。
- **禁止**在 CI / 文档 / 脚本里另写一套 dist-tag 判断。

## 6. Issue 分类与标签

| 标签 | 含义 | 配套模板 |
|---|---|---|
| `bug` | 功能不符合预期 | Bug 报告 |
| `host-compat` | 某个宿主形态下的兼容性问题（要求贴 `dsh-drydock-doctor --json`） | 宿主兼容性报告 |
| `enhancement` | 新能力 / 行为变更 | 功能请求 |
| `track:web` / `track:desktop` / `track:community` | 该 issue 影响哪个发布通道 | 模板里的下拉即自动带出 |
| `needs-real-machine` | 需要真桌面运行时验证才能定性 | — |
| `desktop-change` | 本期改动触及"热文件"超污染预算，需要单独审"web 影响面" | — |
| `backport` | 需要回移到维护线 | — |
| `release-blocker` | 挡住下一次发布 | — |

维护者维护口径：**能写成断言的，不要写成"请注意"**（本项目历史上"文档写了、脚本没跟上"反复出事）。

## 7. 安全问题的报告方式

**不要开公开 issue**。用 GitHub 的 [私密漏洞报告](https://github.com/nonentity303/dsh-drydock/security/advisories/new)（Security → Report a vulnerability），或按 `SECURITY.md` 里的联系方式。
`SECURITY.md` 里写了当前的安全模型：来源信任、下载摘要校验（fail-closed）、对外 HTTP 路由的宿主准入。

## 8. 文档改动也算贡献

- 文档里的命令必须**可复制可执行**；示例路径用相对路径或明确说明 cwd。
- 改了行为就改文档；改了文档就重跑 `node test-docs.mjs` 与 `node test-channels.mjs`。
- `CHANGELOG.md` **不要手改**，由 `node tools/dev/gen-changelog.mjs` 从 `docs/releases/*.md` 生成。
