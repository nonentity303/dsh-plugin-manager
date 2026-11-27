# 安装 / 更新 / 卸载 / 回退（docs/INSTALL.md）

> 适用版本：**dsh-drydock 1.0.4**。安装方式与命令在 1.0.x 线内保持一致；版本号以 `package.json` 与 npm 为准（`npm view dsh-drydock version`）。
> 环境要求与兼容矩阵见 [COMPATIBILITY.md](COMPATIBILITY.md)；权限与数据范围见 [SECURITY.md](SECURITY.md)。

## 一、推荐方式：用 `dsh plugin` 装进 profile

```sh
# 1) 推荐：显式版本号，不会被 24 小时冷静期挡住
dsh plugin --profile web add dsh-drydock@1.0.4

# 2) 发版满 24 小时后，也可以用 latest
dsh plugin --profile web add dsh-drydock

# 3) 离线 tgz（GitHub Release 页下载，或在自己机器上 npm pack 生成）
dsh plugin --profile web add ./dsh-drydock-1.0.4.tgz

# 4) 回退上一个正式版（1.0.x 之间回退走同一包名，不需要旧包）
dsh plugin --profile web add dsh-drydock@1.0.3

# 重启 web 生效（客户端 bundle 在引擎启动时加载）
dsh web
```

`<profile>` 默认是 `web`（即 `~/.dsh/profiles/web`）；用 `dsh plugin --help` 可查看本机 `dsh` 支持的全部参数。

## 二、为什么必须用 `dsh plugin … add`，不要在 profile 里 `npm install`

- 本包是**引擎插件**，运行时需要引擎自带的 `@deepseek-ai/*`。`dsh plugin add` 底层是 **pnpm**，profile 关闭了 `autoInstallPeers`，会直接复用引擎那份依赖，而不是装第二份。
- 引擎的 `@deepseek-ai/*` 在 npm 上是**预发布版本**（`-rc.*` / `-alpha.*`），版本史很乱（例如 `dsh-home-paths` 的 `latest` 停在 `0.0.1-rc.3`，而引擎实际装的是 `0.1.7-rc.2`）。用 **npm** 装会按 npm 自己的 peer 规则去解析这些预发布区间：不同 npm 版本表现不同——轻则警告，重则直接 `ERESOLVE`。
  - 这是**引擎包的客观情况，不是本插件的缺陷**；本包自己的运行期依赖只有 `yaml` 与 `zod`。
  - 若你的 npm 对预发布 peer 很严格，可加 `--legacy-peer-deps`（仍不推荐在 profile 里用 npm 装本包）。
- 结论：**装进 profile 一律走 `dsh plugin … add`**；`npm install` 只用于本仓库的开发依赖（见 [README.md](README.md) 索引里的「开发与测试」）。

## 三、24 小时冷静期（`minimumReleaseAge`）

pnpm 11 起默认有 24 小时冷静期（`minimumReleaseAge` 默认 1440 分钟）：**当天刚发布**的版本，不带版本号会解析到旧版本。三种处理：

1. **显式写版本号**（最可靠）：`dsh plugin --profile web add dsh-drydock@1.0.4`；
2. 把版本加入 profile 的 `pnpm-workspace.yaml`：

   ```yaml
   minimumReleaseAgeExclude:
     - dsh-drydock@1.0.4
   ```

3. 等满 24 小时后再装 `latest`。

## 四、装完必须重启（客户端 bundle 只在启动时加载）

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 装完界面还是旧的 / 新页面不出现 | 客户端 bundle 在引擎**启动时**加载 | 重启 `dsh web`（或让 3081 启动器重新拉起引擎） |
| 启停插件后列表状态没变 | 引擎在启动时套用 `cordis.patch.yml` 条目 | 配置已写入，**重启引擎后生效**（界面会提示需要重启） |
| `dsh plugin add` 报 "Already up to date" 不更新 | pnpm 按版本号缓存 tarball | **修改后必须升版本号**再 add |

## 五、装好后的入口

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 管理台（3080） | `http://127.0.0.1:3080` → 侧边栏「插件管理」 | 接管引擎内置插件页；功能最全的日常入口 |
| 兜底管理页（3081） | `http://127.0.0.1:3081/plugins` | 纯 Node 进程托管，引擎不可用时仍可启停 / 更新 / 卸载 / 体检 / 重启 |
| 启动页（3081） | `http://127.0.0.1:3081/` | 打开即自检 → 修复 → 启动 → 跳转主界面（设为浏览器主页最省心） |
| 救援页（3081） | `http://127.0.0.1:3081/rescue` | verify / fix / start / stop / status |
| 救援球 🛟 | 3080 右下角浮动按钮 | 可拖动换位（位置记忆），设置页损坏时的入口 |

> 引擎内也注册了 `http://127.0.0.1:3080/rescue`，但它经宿主准入：**从应用内**进入正常，地址栏直开会被 403 拒绝。引擎起不来请用 3081。

## 六、更新

```sh
# 方式一：3081 兜底页 → 「检查更新」→「更新」
# 方式二：
pnpm update dsh-drydock --latest --dir <profile>
# 方式三（与安装相同，推荐显式版本号）：
dsh plugin --profile web add dsh-drydock@1.0.4
```

更新源在引擎内按信任模型裁决（registry 权威、自定义源默认只兜底、明文源默认「明文 · 仅兜底」），完整口径见 [SECURITY.md](SECURITY.md) §3。

## 七、卸载

```sh
# 1) 卸载插件本体（会先自动调用 --uninstall 清理自启 / 守护 / shim）
dsh plugin --profile web remove dsh-drydock

# 2) Windows：清理开机自启（幂等，未安装时也是退出码 0）
npx dsh-drydock --uninstall-autostart

# 3) 需要时：彻底清理启动器痕迹（停守护 → 删 DSHWeb* 自启项 → 删 shim → 清 pid；日志保留）
npx dsh-drydock --uninstall
```

- 卸载前会先调用包内 `bin/open-boot.mjs --uninstall`（旧版本没有该能力 → 记为「已跳过」，不阻断卸载）。
- 也可在 3080 管理台内卸载自己（走额外警告路径，自动清理开机自启，结果写入卸载报告）；**禁用**自己则必须去 3081 兜底页或命令行——3080 界面里不能自禁。
- `--uninstall` 退出码：**0** 完成 / **1** 出错 / **2** 归属未确认（不动任何进程、保留 pid）；引擎 3080 与日志不动。

## 八、开机自启与常驻（Windows 为主）

| 命令 | 作用 |
| --- | --- |
| `npx dsh-drydock --supervise [--interval 60] [--heartbeat-min 10]` | 常驻守护：静默确保 3081 有服务；锁端口（`port+1000`）单实例；只有 HTTP 握手失败才拉起，绝不误杀健康实例 |
| `npx dsh-drydock --ensure` | 一次性确保 3081（桌面快捷方式用，退出码 0/1） |
| `npx dsh-drydock --status` | 状态自检 + 健康留痕：启动器 / 守护 / 引擎 / PID / cwd / 日志与最后心跳；每次追加一行 `profile/health.log`（保留 7 天 / 1000 行） |
| `npx dsh-drydock --install-autostart` | 写开机自启（Windows）：`HKCU\...\Run` + 登录静默常驻；包装脚本正文纯 ASCII，中文用户名 / 含空格路径不乱码 |
| `npx dsh-drydock --uninstall-autostart` / `--autostart-status` | 移除自启 / 查看状态；未安装时**幂等**（退出码 0） |
| `npx dsh-drydock --uninstall` | 卸载闭环：三重归属校验停守护 → 删 `HKCU\...\Run` 下**所有** `DSHWeb*` 值 → 删 shim → 清 pid（**日志保留**） |

> macOS / Linux 没有 `--install-autostart`，请用 `--supervise` 配合你自己的服务管理器（systemd / launchd）。

## 九、端口与离线部署

| 端口 | 归属 | 说明 |
| --- | --- | --- |
| 3080 | 引擎主界面 | 由 `dsh web` 监听 |
| 3081 | 启动器（open-boot） | 启动页 `/` · 兜底页 `/plugins` · 救援页 `/rescue` |
| 3082 | 备份救援守护（rescue-daemon） | `npx dsh-drydock-rescue` |
| 4081 | 守护单实例锁 | 3081 + 1000 |

- 全部只绑 `127.0.0.1`；可用 `DSH_LAUNCHER_PORT` / `DSH_ENGINE_PORT` 覆盖。
- 端口被别的进程占用时**明确报错退出，不静默漂移**；`--status` 会报告占用者 pid。
- 内网 / 离线：用方式 3 的 tgz 安装；更新源可配内网 registry（需显式 `authoritative: true`，明文源还需 `allowInsecure: true`，见 [SECURITY.md](SECURITY.md)）。

## 十、从旧包升级（0.9.1 之前的老用户必看）

⛔ **`dsh-plugin-manager-pro` 的 0.9.1 之前版本（含 `0.9.1-rc2`）已淘汰**：存在已知供应链风险，且 Node < 22.14 加载即崩；npm 上已挂**强化弃用提示**（不删包，历史版本仍可安装，但不要用）。升级：

```sh
dsh plugin --profile web remove dsh-plugin-manager-pro
dsh plugin --profile web add dsh-drydock@^1.0.4
dsh web
```

- 新包名 `dsh-drydock` 是唯一推荐入口；1.0.x 之间回退同一包名。
- 0.9.1（旧包 latest）上已有的弃用提示保留，指向 `^1.0.4`。

## 十一、核对版本

```sh
npm view dsh-drydock version                 # npm 上已发布的版本
npm view dsh-drydock dist-tags               # latest / next 轨道
cat ~/.dsh/profiles/web/package.json         # profile 里实际装的版本
```

发布说明与逐版变更见 [releases/](releases/) 与 [CHANGELOG.md](../CHANGELOG.md)。
