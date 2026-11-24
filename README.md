# 引擎与插件管理台（dsh-plugin-manager-pro）

DSH 的插件管理工具（1.0.0-rc.2，发布前候选版；npm `latest` 仍为 0.9.1）。提供三个独立载体：**3080 设置页管理台**（日常操作）、**3081 启动器兜底页**（引擎不可用时的备用入口）、**救援中心**（诊断与修复）。任一载体失效时，其余载体仍可完成启停、卸载与恢复操作。

> 0.9.1 时代的完整文档（能力对比、兼容性矩阵、权限与数据范围、故障排查）见 [docs/README-full.md](docs/README-full.md)。

## 载体一览

| 载体 | 入口 | 说明 |
| --- | --- | --- |
| **管理台（3080）** | `http://127.0.0.1:3080` → 侧边栏「插件管理」 | 接管引擎内置插件页；功能最全的日常入口，跟随 DSH 主题变量 |
| **兜底页（3081）** | `http://127.0.0.1:3081/plugins` | 纯 Node 进程托管，不依赖引擎运行；扁平设计，深浅主题跟随系统偏好 |
| 启动页（3081） | `http://127.0.0.1:3081/` | 打开即自检并启动引擎，保持原始风格 |
| 救援球 🛟 | 3080 右下角浮动按钮 | 可拖动换位（位置持久记忆），单击打开救援页 |
| 救援页 | `http://127.0.0.1:3081/rescue` | verify / fix / start / stop / status 全套修复能力 |

## 管理台（3080）

### 分区模型

插件列表按来源分三区，语义与引擎实际情况一一对应：

| 分区 | 判定 | 行为 |
| --- | --- | --- |
| **核心组件（引擎必需，不允许禁用）** | 包名白名单（dsh-base / dsh-web-app） | 锁定展示，开关与卸载均拒绝 |
| **引擎内置组件** | 引擎自带（origin=builtin） | 可启停、可查看；行徽章「内置」，区内按名称排序 |
| **用户插件** | 用户安装（origin=user） | 完整操作：启停 / 更新 / 卸载 / 配置 |

「推荐」不再是分区，而是行内标签：仅真正的第三方推荐加装件（如 browser-control）显示。来源筛选（全部 / 架构自带 / 用户安装）、搜索、分区折叠与计数互相联动。

### 页签

- **官方内置（可选）** / **全部插件** / **插件市场**（dshfind 精选目录）/ **操作与场景** / **维护**（更新源管理、救援入口）。
- 行内操作：启停开关（写前自动备份）、市场详情、卸载（卸载前体检预览）、配置页（运行时 slot 注册的插件）。

### 管理器自身的禁用与卸载（统一口径）

管理器不能在自身管理界面（3080）中停用自己；如需禁用或卸载，请前往启动器兜底页（3081 /plugins）或使用 dsh 命令行——兜底页独立于引擎存活，禁用后仍可恢复。

3080 内允许的例外是**卸载**：走额外警告路径，卸载前自动清理开机自启，结果写入卸载报告；卸载后 3080 管理界面消失、3081 兜底页存活至启动器进程结束。

## 兜底页（3081 /plugins）

- **启停 / 更新 / 卸载**：toggle 写 `dsh.profile.bundles`（写前备份）；`pnpm outdated` 批量比对、逐个更新；事务性卸载（备份 → `pnpm remove` → 清理补丁条目 → 逐项验证，每步落日志，失败可回滚；`pnpm remove` 超时或进程状态不明时**不**盲目回滚，标记「未知」请人工确认）。
- **EBUSY 引导**：引擎运行中且目标启用时拒绝硬删，引导「先禁用 → 重启引擎 → 再操作」。
- **mod 体检**：只读 preflight + `~/.dsh/logs/web.log` 尾部 300 行按包聚合，verdict 三档（ok / suspect / broken）。
- **重启引擎 / 停止启动器**：确认框 + toast，写接口全部走 Origin + 一次性令牌防护。
- **有意不做**：行内配置面板、场景管理、下载诊断（依赖引擎 Cordis 运行时，与兜底页定位冲突）；完整功能在 3080 管理台。

## 救援流程

| 症状 | 入口 |
| --- | --- |
| 引擎在跑，但 3080 界面/插件页异常 | 3080 右下角 🛟 救援球，或 `http://127.0.0.1:3080/rescue` |
| 引擎起不来、3080 打不开 | `http://127.0.0.1:3081/`：自检 → 修复 → 启动 → 跳转带 token 的入口 URL |
| 插件被禁用到界面起不来 | `http://127.0.0.1:3081/plugins` 直接 toggle（该页不依赖引擎） |
| 某个插件把引擎打挂 | 3081 `/plugins` → mod 体检看 verdict → 禁用观察或卸载（带备份与验证） |
| 卸载/更新被引擎占用 | 拒绝硬删并引导：先禁用 → 重启引擎 → 再操作 |
| 需要独立于 3081 的备份救援入口 | `npx dsh-pm-rescue`（默认 3082，不抢端口） |
| 彻底移除启动器 | `npx dsh-pm-launcher --uninstall --profile <profile>`（引擎与日志保留） |

> **已知限制**：入口 token URL 只有在引擎 stdout 落到 `<DSH_HOME>/logs/web.log` 时才取得到（启动器经 `enginectl` 拉起时正常落盘）。若引擎由其他路径拉起（如 `dsh-boot` 的弹窗路径），3081 可能给不出可直接跳转的链接——到 `/rescue` 执行一次「重启引擎」即可恢复。

## API 参考（3081）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 启动器 + 引擎状态 |
| POST | `/api/boot` | 自检启动（单飞闸门） |
| POST | `/api/launcher/stop` | 优雅停止本启动器（pid 归属校验） |
| GET/POST | `/plugins/api/bundles` | 列出 / 启停 bundle（写前备份） |
| GET | `/plugins/api/updates` | `pnpm outdated` 投影用户插件 |
| POST | `/plugins/api/update` | 更新单个用户插件（EBUSY 引导） |
| POST | `/plugins/api/uninstall` | 事务性卸载（steps 日志；超时/进程不明时标记「未知」不回滚） |
| GET | `/plugins/api/health` | mod 体检（只读） |
| POST | `/plugins/api/engine/restart` | 重启引擎（失败条目自动隔离一次） |
| GET/POST | `/rescue/api/*` | 救援中心 verify / fix / start / stop / status |

写接口（POST）需要同源 Origin + `X-DSH-PM-Token`（页面 meta 自动携带，不落盘、不写日志）。

## 环境要求

- DSH 引擎 `>=0.1.7-rc.2 <0.3.0-0`；Node.js ≥ 18。
- 端口（均只监听 `127.0.0.1`）：**3080** 引擎主界面 · **3081** 启动器 · **3082** 备份救援 · **4081**（3081+1000）守护单实例锁。
- `DSH_LAUNCHER_PORT` / `DSH_ENGINE_PORT` 可覆盖默认端口。

## 安装 / 更新 / 卸载

```bash
# 安装（一律走 dsh plugin add：底层 pnpm，复用引擎自带的 @deepseek-ai/*）
dsh plugin --profile web add dsh-plugin-manager-pro@1.0.0-rc.2
# 或离线 tgz（本仓库 node build.mjs && npm pack 的产物）
dsh plugin --profile web add ./dsh-plugin-manager-pro-1.0.0-rc.2.tgz

# 装完必须重启引擎：客户端 bundle 只在引擎启动时加载
dsh web
```

> **装不到 / 装完还是旧版？** ① 客户端 bundle 只在引擎**启动时**加载——装完必须重启 `dsh web`；
> ② pnpm 11 起有 24 小时冷静期（`minimumReleaseAge` 默认 1440 分钟），预发布号不会被 `latest` 解析到——
> 一律显式写版本号，或将 `dsh-plugin-manager-pro@<版本>` 加入 profile 的 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`。

装好后两个入口：3080 侧边栏「插件管理」（内置插件页已接管）；3081 `http://127.0.0.1:3081/plugins`（引擎不可用时仍可用）。浏览器主页设为 `http://127.0.0.1:3081/` = 打开即自检启动引擎。

```bash
# 更新：3081 兜底页「检查更新」→「更新」，或
pnpm update dsh-plugin-manager-pro --latest --dir <profile>

# 卸载：3081 兜底页「卸载」（带备份、验证与失败回滚），或
dsh plugin --profile web remove dsh-plugin-manager-pro
# 清理启动器痕迹（自启 / 守护 / shim / pid；引擎 3080 与日志保留；幂等）
npx dsh-pm-launcher --uninstall --profile <profile>
```

`--uninstall` 链：三重归属校验停守护 → 删 HKCU\...\Run 下 DSHWeb* 自启值 → 删 profile 内 open-boot-*.vbs shim → 清 pid 文件；拒绝处理归属不明的进程（绝不 `taskkill /T`）。退出码 **0**=完成 / **1**=出错 / **2**=归属未确认（不动任何进程）。

## 测试 / 构建

```bash
npm ci                       # 依赖树必须来自 lockfile（见 docs/RELEASING.md §2bis）
node build.mjs               # src/client.jsx -> lib/client.js（可复现：连跑两次哈希相同）
node test-bundle.mjs         # 构建产物契约（含 origin 来源契约）
node test-render.mjs         # jsdom 真渲染回归（分区模型 / 徽章 / 推荐标签等 19 项）
node test-integration.mjs    # host 逻辑进程内集成（需 devDependency @deepseek-ai/dsh-home-paths）
node test-launcher.mjs       # 启动器全量回归（354 项；--strict 把已知写域外缺陷算失败）
node tools/smoke-plugins-api.mjs   # 独立端口 + 临时 DSH_HOME 的 /plugins API 冒烟
npm run check:vendor         # vendor 与工作树版本 + sha256 一致性
```

> `test-launcher.mjs` 会重写 `<DSH_HOME>/scripts/dsh-launcher.cmd`；不想动真实 `~/.dsh` 时先设 `DSH_HOME=<临时目录>`。

## 功能对等声明

3080 管理台功能最全（分区浏览 / 市场 / 配置 / 场景 / 维护 / 救援）；3081 兜底页覆盖引擎不可用场景下的高频刚需（启停 / 更新 / 卸载 / 体检 / 重启 / 救援入口）。两处对管理器自身禁用/卸载的说明采用同一口径（见上文）。
