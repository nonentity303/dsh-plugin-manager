# 常见问题与排错（docs/FAQ.md）

> 适用版本：**dsh-drydock 1.0.4**。安装细节见 [INSTALL.md](INSTALL.md)；救援见 [RESCUE.md](RESCUE.md)；安全口径见 [SECURITY.md](SECURITY.md)。

## 一、安装与升级

| 现象 | 原因与解决 |
| --- | --- |
| 装完界面还是旧的 / 新页面不出现 | 客户端 bundle 在引擎**启动时**加载：**必须重启 `dsh web`**（或让启动器重新拉起引擎） |
| 装了 1.0.4 但还是旧版本 | ① 没重启；② 24 小时冷静期（`minimumReleaseAge`）把不带版本号的 add 解析到旧版——**显式写 `dsh-drydock@1.0.4`**，或把版本加入 profile `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` |
| `dsh plugin add` 报 "Already up to date" 不更新 | pnpm 按版本号缓存 tarball：**修改后必须升版本号**再 add |
| 从 `dsh-plugin-manager-pro` 升级后两个入口都在 | 旧包没移除干净：`dsh plugin --profile web remove dsh-plugin-manager-pro` 后再 `dsh web`；同一 profile 只保留一个插件管理器 |
| 还在 0.9.1 之前的旧包（含 `0.9.1-rc2`） | 已淘汰（供应链风险 / Node < 22.14 加载即崩，npm 已挂强化弃用提示）：`dsh plugin --profile web remove dsh-plugin-manager-pro && dsh plugin --profile web add dsh-drydock@^1.0.4` |
| 在 profile 里 `npm install` 报 `ERESOLVE` | 不要在 profile 里用 npm 装；用 `dsh plugin --profile web add`（pnpm 复用引擎自带的 `@deepseek-ai/*`），详见 [INSTALL.md](INSTALL.md) §2 |
| 刚发版装不到 | pnpm 24 小时冷静期，见上；或改用离线 tgz |
| 卸载后自启 / 守护还在 | `npx dsh-drydock --uninstall-autostart`，必要时 `npx dsh-drydock --uninstall`（退出码 2 = 归属未确认，不动任何进程） |

## 二、使用与界面

| 现象 | 原因与解决 |
| --- | --- |
| 启停插件后列表状态没变 | 引擎在启动时套用条目：配置已写入，**重启引擎后生效**（界面会在需要重启时提示） |
| **3081 禁用/启用后，3080 的列表里找不到/多出来** | 3080 与 3081 兜底页**共用同一个 profile**，而引擎**只在启动时**读配置（dsh 引擎没有文件监听）。所以：① 任何一页的开关都要**重启引擎**才收敛；② 每次启动前会跟"上次成功启动"比对配置，有变化会写进日志并在 3081 兜底页顶部显示「与上次启动相比的配置变更」（区分"管理台改的"与"未经管理台的改动"）；③ 两页的成员与分区现在同源：3080 也会把"装了但没启用"的插件显示成只读行，并指向 3081 去启用 |
| 列表分区和我认知的不一样 | 1.0 起按来源三分区（核心组件 / 引擎内置组件 / 用户插件）；「推荐」只是行内标签，不再是分区 |
| 想禁用管理器自己 | 3080 界面内**不可自禁**：去 `http://127.0.0.1:3081/plugins`（独立于引擎存活）或用 `dsh plugin remove`；3080 内允许的是**卸载**（额外警告路径，自动清理自启） |
| 第三方插件没有 ⚙ 配置入口 | 它尚未注册 `plugins.row.config` 槽位（或还没适配 0.1.7 的 slots）——请向插件作者反馈；未注册槽位不会出现空按钮 |
| 浏览器报 `waiting for service: remote.xxx` | 客户端 inject 不能包含自身挂载的 remote（死锁）；inject 只保留 `["slots","locale","remote"]` |
| 卸载时提示要重启 / 文件被占用（EBUSY） | 引擎运行中且目标启用时拒绝硬删：先禁用 → 重启引擎 → 再操作；Windows 文件锁残留登记 `pendingRemovals`，下次启动自动清理 |
| 卸载后提示「未知」 | `pnpm remove` 超时或进程状态不明时**不盲目回滚**（避免把半删状态变成更坏状态），请人工确认结果 |
| 场景应用后没变化 | 场景只改启停状态，同样要**重启引擎**生效；应用前会展示变更预览 |

## 三、引擎起不来 / 插件把引擎打挂

| 现象 | 原因与解决 |
| --- | --- |
| 引擎起不来（坏 bundle 进了 `package.json`） | 开 `http://127.0.0.1:3081/` → 自检 → 修复 → 启动；或 `npx dsh-drydock-boot --repair-only`；再不行 `npx dsh-drydock-rescue` 用 3082 备份救援 |
| 插件被禁用到界面起不来 | 开 `http://127.0.0.1:3081/plugins` 直接 toggle（不依赖引擎） |
| 某个插件把引擎打挂 | 3081 `/plugins` → mod 体检 verdict（ok / suspect / broken）→ 禁用观察或卸载 |
| 不知道 3080/3081/3082/4081 状态 | `npx dsh-drydock --status`（追加 `health.log` 留痕）；端口属于别人会报告占用 pid |
| 3081 打不开 / 端口被占 | 端口属于别的进程：`--status` 报告 pid；杀掉或改 `--port` 并同步更新浏览器主页（工具**绝不**静默换端口） |
| 3081 给不出带 token 的入口链接 | 引擎 stdout 没落到 `<DSH_HOME>/logs/web.log`：到 `/rescue` 执行一次「重启引擎」即可恢复 |
| 3080 `/rescue` 地址栏直开报 403 | 引擎内救援路由经宿主准入（无来源顶层导航被拒）：请从应用内（救援球 / 插件页）进入，或用 3081 的独立救援页 |

## 四、更新与下载

| 现象 | 原因与解决 |
| --- | --- |
| 更新看不到最新版 | registry 是权威源：权威源给出版本时只在权威源之间取最高；自定义源默认只兜底（`authoritative: false`）。内网源要独立裁决需显式 `authoritative: true`，明文源还需 `allowInsecure: true` |
| 自定义 `http://` 源没有生效 | 默认「明文 · 仅兜底」：既要有 `authoritative: true`，也要有 `allowInsecure: true`，否则自动降级并把原因写进可读 note |
| 普通包被推了 RC | 只有 `@deepseek-ai/*` 走 `next` 轨道；其余包只取 `latest`，`latest` 是预发布时视为无可用版本 |
| P2P 磁力链接无法下载 | 安装 aria2c（自动启用）或 webtorrent，或用 NDM / 比特彗星手动导入 |
| 下载目录里放了 tgz 但不自动安装 | 必须对上**来源记录 provenance**（包名 + 版本 + 来源 + 摘要，7 天有效）：不是本管理器生成的下载链接会写 `.failed` 拒绝；确认可信后删 `.failed` 重试 |
| 回执说「未校验」 | 只有内容摘要（integrity / shasum）才算已校验，字节数不算；无摘要的下载默认拒绝，`security.unverifiedDownloads: allow` 放行时会明说未校验 |

## 五、安全相关疑问

| 疑问 | 回答 |
| --- | --- |
| 第三方网页能触发启动 / 停止吗？ | 不能：写接口要**同源 `Origin`**（同主机同端口，绝不由 `Host`/`Referer` 推导）+ **一次性令牌**（`X-DSH-PM-Token`），且有单飞闸门（403 / 401 / 409）。见 [SECURITY.md](SECURITY.md) §4 |
| 它会把我的数据传出去吗？ | 不会：没有账号、没有云端、没有遥测；只查询你配置的更新源。见 [SECURITY.md](SECURITY.md) §1 |
| 读得到我的 API Key 吗？ | 读不到：`lib/` 里没有读取 `settings.yaml` / `.credentials.yaml` 的代码路径 |
| 下载的包怎么保证没被篡改？ | 摘要校验 + 重定向逐跳明文检测 + provenance 来源记录；但只有摘要没有签名，挡不住恶意发布者（见 [SECURITY.md](SECURITY.md) §5） |

更多「现象 → 入口」速查见 [RESCUE.md](RESCUE.md) §4 与 [LAUNCHER.md](LAUNCHER.md) 的排错表。
