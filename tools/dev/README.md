# tools/dev —— 开发用一次性脚本（不随包发布）

这些脚本**不在 `package.json` 的 `files` 白名单里**，只服务本机开发/验证，不承诺跨机器可移植性（虽然已尽量参数化）。
所有路径都从环境推导：`$env:USERPROFILE` / `$env:DSH_HOME` / `$env:APPDATA` / `$PSScriptRoot` / `homedir()` / `tmpdir()`。

| 脚本 | 用途 |
|---|---|
| `restart-main.ps1` | 重启主引擎（默认 profile `web`、端口 3080）并跑 `verify-main-smoke.mjs`。日志落 `$DSH_HOME\logs` |
| `start-v08.ps1` | 起一个**隔离**引擎（profile `web-v08`、端口 3082）→ 跑 `verify-v08.mjs` → 关掉它。绝不碰 3080/3081 |
| `verify-main-smoke.mjs` | 对运行中的实例做只读端点冒烟（`VERIFY_PORT`/`VERIFY_PROFILE_DIR` 可覆盖） |
| `verify-v08.mjs` | v0.8+ E2E（卸载事务/撤销/场景/来源覆盖…）；结果 JSON 默认写 `tmpdir()`，可用 `V08_E2E_OUT` 指定 |
| `verify-origin.mjs` | 来源字段端点检查；结果 JSON 默认写 `tmpdir()`，可用 `ORIGIN_VERIFY_OUT` 指定 |
| `verify-recovery.mjs` | 救援链路端点检查；结果 JSON 默认写 `tmpdir()`（`RECOVERY_VERIFY_OUT`） |
| `verify-refresh.mjs` | 刷新耗时/缓存检查；结果 JSON 默认写 `tmpdir()`（`REFRESH_VERIFY_OUT`） |
| `verify-sandbox.mjs` | 沙箱 profile（默认 `~/.dsh/profiles/web-test`，`VERIFY_PROFILE_DIR` 可覆盖）的隔离验证 |
| `verify-stable.mjs` | 稳定性冒烟；结果 JSON 默认写 `tmpdir()`（`STABLE_VERIFY_OUT`） |
| `pack.mjs` | `node build.mjs` + `npm pack` 的等价封装（正式口径见 `docs/RELEASING.md`） |
| `push-via-api.mjs` | `github.com:443` 被墙时用 GitHub Git Data API 推送本地 commit（`gh auth token`） |
| `artifacts/` | 历史 tarball 归档（`*.tgz` 已被 `.gitignore` 忽略，永远不会进发布物） |

## 约定

- **不要在仓库根写日志/JSON**：这些脚本的输出都指向 `$DSH_HOME\logs` 或 `tmpdir()`。
  仓库根只放源码、配置、`build.mjs`、四个 `test-*.mjs` 与文档。
- **随机端口/临时目录**：给启动器写自动化测试时请照 `test-launcher.mjs` 的做法（`listen(0)` 取空闲端口 + `mkdtemp` 临时 profile），
  不要用 3080/3081 或真 profile。
- 一键回归：仓库根 `npm test`（其中 `test-launcher.mjs` 覆盖启动器/救砖链路）。
