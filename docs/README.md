# 文档索引

| 文件 | 内容 |
|---|---|
| [INSTALL.md](INSTALL.md) | **安装 / 更新 / 卸载 / 回退**：`dsh plugin` 安装四法、为什么不能在 profile 里 `npm install`、pnpm 24 小时冷静期、重启生效、更新与卸载命令、开机自启与常驻、端口分工、离线 tgz、从 0.9.1 之前旧包升级、版本核对 |
| [USAGE.md](USAGE.md) | **使用**：五个载体、管理台三分区模型与页签、管理器自身的禁用 / 卸载口径、事务化卸载（影响预览 / 体检 / 加固 / 卸载报告 / 历史 / 场景）、更新与下载、插件市场、3081 兜底页、插件页接管与开关持久化 |
| [SECURITY.md](SECURITY.md) | **安全口径**：权限与数据范围（逐项外传判定）、更新源信任模型（1.0.3 起，registry 权威 / 自定义源兜底 / `allowInsecure` / `next` 轨道）、下载 provenance 与校验、3081 写接口防护、页面安全头、3082 Host 校验、引擎救援路由宿主准入、威胁模型与已知限制 |
| [RESCUE.md](RESCUE.md) | **独立救援工具链**：三个 bin 工具、常驻与开机自启命令表、健康判定与「停引擎」安全性、救援流程速查、救援页能力、3081 API 参考、工作原理、已知限制 |
| [COMPATIBILITY.md](COMPATIBILITY.md) | **环境与兼容性**：平台 / Node / pnpm、端口表、引擎兼容矩阵、旧版本淘汰原因、运行期依赖与包内容、桌面与浏览器环境、升级引擎注意事项 |
| [FAQ.md](FAQ.md) | **常见问题与排错**：安装升级、使用界面、引擎起不来、更新下载、安全疑问 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **架构**：三进程（引擎 3080 / open-boot 3081 / 救援守护 3082）、守护锁 `port+1000`、插件页分区与槽位契约、开关持久化与侧车、健康判定口径、卸载事务数据流、文件地图 |
| [LAUNCHER.md](LAUNCHER.md) | **命令行口径**：三个 bin 的全部命令与退出码、`--uninstall` 卸载闭环、开机自启、`health.log` 留痕与轮转、端口表与冲突行为、写接口防护、故障排查，附「文档条目 → 代码位置」核对表 |
| [RELEASING.md](RELEASING.md) | **发布流程**：版本号、构建、打包、`vendor` 刷新与断言、lockfile/包管理器约定、publish 与 2FA/OIDC、24 小时冷静期、引擎升级彩排、发布核对表、**§11 多通道发布**（dist-tag 由 `release/channels.json` 派生） |
| [版本与轨道.md](版本与轨道.md) | **多端发布口径**：三条通道（web / desktop / community）、版本号怎么升（宿主动了只动后缀）、各通道安装命令、semver 排序坑（`-desktop.N < -rc.N`）、为什么不用 GitHub Packages 当主发行面 |
| [环境自适应与剥离.md](环境自适应与剥离.md) | **首启环境探测 + 自动剥离**：三层结构（探测落盘 / 能力表 / 模块登记与惰性装载）、剥离清单与行数、三条硬边界（文件级剥离 / 不 import / 不写别人的东西）、新增环境专属模块的做法 |
| [自更新.md](自更新.md) | **drydock 升级自己**：权威源 + SRI 校验 + 暂存 + 「现在/稍后」+ detached worker（停引擎→装→健康检查→重启→失败回滚）、门禁表与状态机、哪部分还没接（客户端弹窗） |
| [README-full.md](README-full.md) | **v0.9.1 时代的完整全文存档**（能力对比 / 兼容矩阵 / 权限与数据范围 / 故障排查 / 救砖速查），**不是当前手册**；当前中文入口见仓库根 [README.md](../README.md) |
| [发布清单-rc2.md](发布清单-rc2.md) | **1.0.0 发布检查清单**（发 npm 前必跑项、dist-tag、回滚方案、发布后验证 URL、当日实测快照、一致性扫描结果；以 1.0.0-rc.2 名义起草，正式发行为 1.0.0）；口径仍以 RELEASING.md 为准 |
| [releases/](releases/) | 每个版本的发布说明（当前版本以 `docs/releases/` 中最新文件为准；历史 `RELEASE_NOTES_*.md` 原样归档；`0.9.0-verify.md` 是干净环境装机验收报告）。预发布版由 `gen-changelog.mjs` 一并收录，段头带「（预发布）」标注 |
| [review/](review/) | 审计与评审期的分析材料（`BUG_ANALYSIS_*.md`、`OPTIMIZATION_PLAN.md`、`PROBLEMS_README.md`、`IMPROVEMENTS_VERIFIED.md`）——历史快照，**不代表当前实现状态** |
| [images/](images/) | README 与本 doc 集用的实拍图（0.9 界面截图；`README.md` 以绝对 URL 引用；**不进 npm 包**——`files` 白名单不含 `docs/`） |

仓库根还有：中文入口 [README.md](../README.md)、精简英文入口 [README.en.md](../README.en.md)、脚本生成的版本历史 [CHANGELOG.md](../CHANGELOG.md)。

## 与本仓库相关的入口

- 插件本体（host）：`lib/index.js`；客户端 UI：`src/client.jsx` → 构建产物 `lib/client.js`
- 启动器 / 救砖：`bin/open-boot.mjs`、`bin/dsh-boot.mjs`、`bin/rescue-daemon.mjs`（共享库 `lib/preflight.mjs`、`lib/enginectl.mjs`）
- 开发与测试命令：

  ```sh
  npm install          # 如遇 npm 拦截 esbuild 安装脚本：npm approve-scripts esbuild
  npm ci               # 依赖树必须来自 lockfile（见 RELEASING.md §2bis）
  node build.mjs       # src/client.jsx -> lib/client.js（可复现：连跑两次哈希相同）
  node test-bundle.mjs # 构建产物契约（含 origin 来源契约）
  node test-render.mjs # jsdom 真渲染回归（分区模型 / 徽章 / 推荐标签）
  node test-integration.mjs # host 逻辑进程内集成（需 devDependency @deepseek-ai/dsh-home-paths）
  node test-transactional.mjs # 事务性卸载回归
  node test-launcher.mjs      # 启动器全量回归（--strict 把已知写域外缺陷算失败）
  node test-docs.mjs          # 文档 / 版本号口径断言（离线、零依赖）
  node tools/smoke-plugins-api.mjs # 独立端口 + 临时 DSH_HOME 的 /plugins API 冒烟
  npm run check:vendor        # 迁移件内容级校验（tgz 内文件 sha256 == 工作树）
  npm run pack                # build + npm pack（产出安装用 tarball）
  ```

- 开发用一次性脚本（不发布）：`tools/dev/`（含 `gen-changelog.mjs` 生成 CHANGELOG；详见 [tools/dev/README.md](../tools/dev/README.md)）
- 迁移包一致性检查：`npm run check:vendor`

> 用户手册入口：[README.md](../README.md)（安装 / 特色 / 升级自查 / 入口速查）；本目录 `INSTALL` / `USAGE` / `SECURITY` / `RESCUE` / `COMPATIBILITY` / `FAQ` 是拆分后的详解。
