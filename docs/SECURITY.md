# 安全口径：权限、信任模型、下载 provenance（docs/SECURITY.md）

> 适用版本：**dsh-drydock 1.0.4**。本文回答「它到底动了我什么」「更新源凭什么可信」「哪些边界没做」。
> 安装命令见 [INSTALL.md](INSTALL.md)；命令行与退出码见 [LAUNCHER.md](LAUNCHER.md)；进程架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 一、权限与数据范围

> 所有读写都在**本机 profile 目录**与**你自己配置的更新源**范围内：没有账号、没有云端、没有遥测。写文件前都会先留 `.rescue-bak-*` 备份，写盘用「临时文件 + 改名」的原子写法。

| 数据 | 用途 | 是否外传 |
| --- | --- | --- |
| `~/.dsh/profiles/<名字>/package.json` | 读已装插件清单（`dependencies` / `dsh.bundle` / `dsh.client`）；安装、卸载、场景等操作会写回，改前备份 | 否 |
| `~/.dsh/profiles/<名字>/cordis.patch.yml` | 读 / 写插件启用状态与隔离行（只动带归属标记的部分，改前备份） | 否 |
| `~/.dsh/profiles/<名字>/plugin-manager.json`（侧车） | 操作历史（20 条）、场景方案、来源人工修正、待清理列表、更新源配置、`pendingDownloads` 来源记录 | 否 |
| `~/.dsh/profiles/<名字>/node_modules/**` | 读依赖反向图与包简介；卸载 / 隔离时经 `pnpm` 删除（Windows 文件锁残留登记下次启动清理） | 否（装卸时由 pnpm 访问 registry） |
| `~/.dsh/profiles/<名字>/vendor/downloads/*.tgz` | 浏览器下载的归档暂存；仍被依赖引用的归档绝不删除 | 否 |
| `$DSH_HOME/downloads/*` | 「下载目录自动安装」扫描归档；只有带 provenance 记录（包名 + 版本 + 来源 + 摘要）的归档才会被自动安装；写 `.installed` / `.failed` 标记 | 否 |
| 本机 npm 全局根（Windows `%APPDATA%\npm`；macOS/Linux `npm root -g` 及常见路径） | **只读**：定位引擎自带的 `@deepseek-ai/*`、提取简介 | 否 |
| 更新源（npm registry / GitHub / 你加的镜像） | 查询最新版本、下载归档 | **只查询**，不上传本地数据 |
| GitHub API `api.github.com` / `raw.githubusercontent.com` / `codeload.github.com` | 读 release 与仓库 `package.json`、下载 tgz | 同上 |
| 目录 `awesome-dsh-plugin.com/plugins.json` | 插件市场目录（host 端 10 分钟缓存） | 同上 |
| 本机回环端口 3080 / 3081 / 3082 / 4081 | 主界面 / 启动器 / 备份救援 / 守护锁；全部只绑 `127.0.0.1` | 否（不出本机） |
| Windows 注册表 `HKCU\...\Run\DSHWebFront` + profile 内 `open-boot-autostart.vbs` / `open-boot-ui.vbs` | **仅在显式执行 `--install-autostart` 时写入**；`--uninstall-autostart` / `--uninstall` 可清理 | 否 |
| profile 内 `.rescue-daemon.pid`、`.open-boot.pid`、`rescue-daemon.log`、`open-boot-supervisor.log`、`health.log` | 守护 / 启动器的 PID、日志与自检留痕（`health.log` 保留 7 天 / 1000 行） | 否 |

> **不会碰的东西**：会话内容、`settings.yaml`、`.credentials.yaml`（API Key）——`lib/` 里没有读取它们的代码路径。

## 二、更新源信任模型（1.0.3 起口径，1.0.4 未变）

- **默认更新源（三个）**：npm 官方（`registry.npmjs.org`）/ GitHub 官方仓库 / npmmirror 镜像（`registry.npmmirror.com`）。
- **registry 版本权威**：权威源给出确定版本时，**只在权威源之间**取最高（并列随机），其它源不参与这次裁决；权威源都没有版本时才降级兜底，并在界面与回执里标 `degraded`。
- **自定义源默认只作兜底**：用户新增的源落在 `custom` 层，默认 `authoritative: false`，**不再与官方源混比**；要让它独立裁决版本，必须显式 `authoritative: true`（内网 / 离线部署用，意味着「此后版本裁决与安装均来自该源」）。
- **`http://` 源允许但默认「明文 · 仅兜底」**：内网 registry / 代理是真实场景，所以不禁止；但默认不进权威层。升权威需显式 `authoritative: true`，明文源还要再给 `allowInsecure: true` 才真正生效，否则自动降级并把原因写进可读 note（不静默）。
- **`official` 徽标由服务端判定**：内置权威白名单只有 npm 官方与 npmmirror（按规范化 URL 比较），客户端提交的 `official` 一律忽略。
- **只有 `@deepseek-ai/*` 有 `next` 轨道**：仅该命名空间（且源是内置权威源）才优先 `dist-tags.next`；其余包只取 `latest`，`latest` 本身是 semver 预发布（含 `-`）时视为「无可用版本」——不把 RC 推给普通用户。
- **熔断**：源级 403/429 冷却（GitHub API 10 分钟）、全量刷新 8 并发、结果缓存 30 分钟。

实现位置：`lib/aggregate.js` + `lib/compare-versions.js`（信任层按源 `authoritative` 判定，而不是按源类型）。

## 三、下载 provenance 与校验

- **下载优先级**：① 浏览器原生下载（隐藏 iframe，NDM 等扩展可捕获）→ ② 外部下载软件 → ③ 内置下载器兜底（HTTP 直链 / aria2c / P2P magnet·torrent）。
- **下载目录自动安装需来源记录**：`.tgz` / `.tar.gz` 放进 `$DSH_HOME\downloads` 后，先读归档内 `package.json`；只有能与管理器自己生成的下载记录（包名 + 版本 + 来源 + 期望摘要，7 天有效）对上的才自动安装；对不上的拒绝并写 `.failed`。安装成功后记录移除。
- **校验口径**：只有内容摘要（integrity / shasum）才算「已校验」，**字节数单独存在不算**；重定向逐跳校验，任何一跳降级到明文 `http` 都拒绝（除非显式 `allowInsecure`）；无摘要的下载默认拒绝，`security.unverifiedDownloads: allow` 放行时回执也会明说「未校验」。
- 实现位置：`lib/downloader.js`（流式 HTTP）+ 侧车 `pendingDownloads` 比对。

## 四、本地写接口与页面防护

### 4.1 3081 写接口（0.9.1 起）

写接口（`POST /api/boot`、`/rescue/api/start|fix|stop` 等）需要：

- **同源 `Origin`**：同主机同端口白名单 `127.0.0.1` / `localhost` / `[::1]`，**绝不从 `Host` / `Referer` 推导**（`localhost:3081` 与 `127.0.0.1:3081` 等价，换端口不等价）；
- **一次性令牌**：页面注入 `X-DSH-PM-Token`（48 位十六进制，不落盘、不写日志，每次启动轮换）；缺 `Origin` 的本地工具仍须带令牌，否则 401；
- **单飞闸门**：boot / start 并发第二个请求返回 409。

所以第三方网页无法触发启动 / 停止；读接口（`GET /api/status|verify`）对本地工具保持开放。实现：`lib/enginectl.mjs`（`newApiToken` / `allowedOriginsOf` / `guardWriteRequest` / `createSingleFlight`）。

### 4.2 3081 页面与救援页安全头（1.0.4 起）

3081 启动器的页面与 API 响应统一带：

- `Content-Security-Policy`：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`（页面脚本 / 样式是内联的，保留 `unsafe-inline`；`connect-src 'self'` 不影响同源 RPC）
- `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`

### 4.3 3082 备份救援守护（1.0.4 起）

- **Host 校验前置**：只接受 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`（大小写不敏感、必须带端口），其余返回 **421** JSON（`{ok:false,code:421,error:"Host 不被允许（仅接受回环地址）"}`），防 DNS 重绑定。
- **全响应安全头**：页面 / API / 421 都带 §4.2 那套头。
- 既有 **Origin + 一次性令牌** 写接口判定不变。

### 4.4 引擎内救援路由的宿主准入（1.0.3 起）

引擎内的 `/rescue` 与 `/plugins-launcher` 走宿主同一套准入（`ctx.connection.requestRejection`）：

- Host / Origin 不符 → **403**；浏览器未认证 → **401**；判定抛错 → **fail-closed 403**。
- 宿主没有 Connection 服务（headless / 早期引擎）时退回旧行为（放行，仅回环部署可用），并只记一次日志。
- **从应用内进入**（浮动救援球 / 插件页链接）可正常打开；直接在地址栏输入 `http://127.0.0.1:3080/rescue` 属无来源顶层导航，会被 403 拒绝——引擎完全起不来时请用 3081 的独立救援页。

### 4.5 引擎与端口

- 3080 / 3081 / 3082 / 4081 全部只绑 `127.0.0.1`，不出本机。
- 启动器 / 引擎健康判定 = **HTTP 握手成功且响应带 dsh 身份指纹**；裸 TCP 监听器一律判不健康，端口被别的进程占用时明确报错、不静默换端口。
- `stopEngine()` 前三重校验（pid 存活 / 进程镜像 / 端口归属），不过一律拒绝；救援页提供「强制停止」。

## 五、威胁模型与已知限制（如实）

1. **只有摘要、没有签名**：校验锚定 registry / GitHub 摘要，挡传输篡改与投毒包体，**挡不住恶意发布者**；发布者签名（sigstore）未做。
2. **provenance 记录是本机信任**：`pendingDownloads` 在 profile 侧车，同用户可写；它挡的是「别的程序往 downloads 里丢包」，不是 OS 级隔离。
3. **`engines.node` 未收紧**（仍 `>=18.0.0`，实际建议 Node 22 LTS+）；收紧排在 1.1.x。
4. **codeload 兜底仍是 movable tag**（1.0.4 未改）。
5. **3080 RPC 的纵深防御**（1.0.3 攻击测试报告 A S2）本版未动。
6. **英文详解文档暂未拆分**：`README.en.md` 为精简入口，细节以中文 `docs/` 为准。
7. **不做的清单**：备份恢复 / WebDAV、主题切换、安全静态扫描——这些 dshmarket 已成熟，本工具不重复做。
