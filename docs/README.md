# 文档索引

| 文件 | 内容 |
|---|---|
| [RELEASING.md](RELEASING.md) | 发布流程：版本号、构建、打包、`vendor` 刷新与断言、lockfile/包管理器约定、publish 与打 tag |
| [releases/](releases/) | 每个版本的发布说明（`0.9.0.md` 为当前版本；历史 `RELEASE_NOTES_*.md` 原样归档） |
| [review/](review/) | 审计与评审期的分析材料（`BUG_ANALYSIS_*.md`、`OPTIMIZATION_PLAN.md`、`PROBLEMS_README.md`、`IMPROVEMENTS_VERIFIED.md`、`0.8优化建议.txt`）——历史快照，**不代表当前实现状态** |

## 与本仓库相关的入口

- 插件本体（host）：`lib/index.js`；客户端 UI：`src/client.jsx` → 构建产物 `lib/client.js`
- 启动器 / 救砖：`bin/open-boot.mjs`、`bin/dsh-boot.mjs`、`bin/rescue-daemon.mjs`（共享库 `lib/preflight.mjs`、`lib/enginectl.mjs`）
- 测试：`npm test`（`test-bundle.mjs` / `test-render.mjs` / `test-integration.mjs` / `test-launcher.mjs`）
- 开发用一次性脚本（不发布）：`tools/dev/`（详见 [tools/dev/README.md](../tools/dev/README.md)）
- 迁移包一致性检查：`npm run check:vendor`

> 使用说明（安装、入口命令、救砖入口速查）在仓库根的 `README.md`。
