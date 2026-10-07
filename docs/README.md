# 文档索引

| 文件 | 内容 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **架构**：三进程（引擎 3080 / open-boot 3081 / 救援守护 3082）、守护锁 `port+1000`、插件页五分区与槽位契约、开关持久化与侧车、健康判定口径、卸载事务数据流、文件地图 |
| [LAUNCHER.md](LAUNCHER.md) | **命令行口径**：三个 bin 的全部命令与退出码、`--uninstall` 卸载闭环、开机自启、`health.log` 留痕与轮转、端口表与冲突行为、写接口防护、故障排查，附「文档条目 → 代码位置」核对表 |
| [RELEASING.md](RELEASING.md) | **发布流程**：版本号、构建、打包、`vendor` 刷新与断言、lockfile/包管理器约定、publish 与 2FA/OIDC、24 小时冷静期、引擎升级彩排、发布核对表 |
| [releases/](releases/) | 每个版本的发布说明（`0.9.0.md` 为当前已发布版本；历史 `RELEASE_NOTES_*.md` 原样归档；`0.9.0-verify.md` 是干净环境装机验收报告） |
| [review/](review/) | 审计与评审期的分析材料（`BUG_ANALYSIS_*.md`、`OPTIMIZATION_PLAN.md`、`PROBLEMS_README.md`、`IMPROVEMENTS_VERIFIED.md`）——历史快照，**不代表当前实现状态** |
| [images/](images/) | README 用的实拍图（三张 0.9 界面截图，`README.md` 以绝对 URL 引用；**不进 npm 包**——`files` 白名单不含 `docs/`） |

仓库根还有：使用说明 [README.md](../README.md) / [README.en.md](../README.en.md)、脚本生成的版本历史 [CHANGELOG.md](../CHANGELOG.md)。

## 与本仓库相关的入口

- 插件本体（host）：`lib/index.js`；客户端 UI：`src/client.jsx` → 构建产物 `lib/client.js`
- 启动器 / 救砖：`bin/open-boot.mjs`、`bin/dsh-boot.mjs`、`bin/rescue-daemon.mjs`（共享库 `lib/preflight.mjs`、`lib/enginectl.mjs`）
- 测试：`npm test`（`test-bundle.mjs` / `test-render.mjs` / `test-integration.mjs` / `test-launcher.mjs`）
- 开发用一次性脚本（不发布）：`tools/dev/`（含 `gen-changelog.mjs` 生成 CHANGELOG；详见 [tools/dev/README.md](../tools/dev/README.md)）
- 迁移包一致性检查：`npm run check:vendor`

> 使用说明（安装、入口命令、救砖入口速查、权限与数据范围）在仓库根的 `README.md` / `README.en.md`。
