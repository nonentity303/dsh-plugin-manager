# 发布流程（dsh-plugin-manager-pro）

本文件是唯一的发布口径。任何"发一个版本"的动作都应当能照着它重复出来。

## 0. 包管理器与 lockfile 约定（审计④ R14）

- **canonical：npm**。`package.json` 里有 `"packageManager": "npm@11.19.0"`，仓库里保留 `package-lock.json`。
- `pnpm-workspace.yaml` 保留，是为了让 `pnpm install` 也可用；它的 `allowBuilds.esbuild: true` 必须保留，
  否则 pnpm 10+ 会跳过 esbuild 的安装脚本，`npm run build` 因缺二进制而失败。
- 历史上仓库同时存在 `package-lock.json` 与 `pnpm-lock.yaml`（两份都可能过期）。现已二选一：**只保留 npm 的锁文件**。
  想改用 pnpm 的贡献者执行一次 `pnpm install` 重新生成 `pnpm-lock.yaml` 即可，但请同时更新本文件与 `packageManager`。

## 0bis. 依赖与 peer 约定：profile 安装只用 `dsh plugin add`

- **装进 profile（运行环境）一律用 `dsh plugin --profile <名字> add …`**，不要在那个目录里跑 `npm install`。
  原因：`dsh plugin add` 底层是 **pnpm**，而且 profile 关闭了 `autoInstallPeers`；
  引擎自带的 `@deepseek-ai/*` 由引擎提供、会被复用，不会被重复安装或换版本。
- 引擎自带的 `@deepseek-ai/*`（如 `@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-home-paths`）在 npm registry 上
  都是**预发布版本**（`-rc.*` / `-alpha.*`），且版本历史较杂：`dsh-home-paths` 的 `latest` 标签停在 `0.0.1-rc.3`，
  而引擎实际用的是 `0.1.7-rc.2`。用 **npm** 在任意干净工程里安装本包时，npm 会按自己的 peer 规则去解析这些预发布范围，
  不同 npm 版本表现不一（可能只告警、也可能 `ERESOLVE` 失败）。**这是引擎侧包的版本事实，不是本插件的依赖缺陷**
  —— 本插件自身运行时依赖只有 `yaml` 与 `zod`。
- 因此本包的 `peerDependencies` 只保留真正需要引擎提供的 `@deepseek-ai/dsh-typert-protocol`；
  **不再声明** `@deepseek-ai/dsh-home-paths`（它只是 host 在运行期 import 的引擎模块）。见 X1 记录：`audit/fix-x1.md`。
- 如果你确实要在非 DSH 工程里 `npm install` 本包做实验：加 `--legacy-peer-deps` 可以绕开 peer 解析。
- 参考实测（2026-09-28，本机 npm 11.19.0 / pnpm 11.21.0，`%TEMP%` 干净工程）：
  `npm install <tgz>` / `pnpm add <tgz>` 均退出 0 且**不解析 file: 依赖的 peer**；
  用本地 mini-registry 模拟 registry 安装时，带 peer 的变体也能解析到 `0.1.0-rc.8`（该范围在 registry 上是可满足的）。

## 1. 版本号

- 唯一来源：`package.json` 的 `version`（当前 **0.9.1**）。构建产物不写版本号，`lib/client.js` 是源码的编译结果。
- 每个版本必须有 `docs/releases/<version>.md`（发布说明）。缺它就不算可发布。
- 预发布段（如 `0.9.0-1`）用于"同一版本的修补"：`dsh plugin add` 按版本号缓存 tarball，
  **内容改了就必须改版本号**，否则 pnpm 会报 "Already up to date"。
- **同一源码树可以产出两个发布物**（2026-09 起的口径）：
  - `0.9.0` = **UI 发布版**：`package.json` 的 `version` 就是它，包含 0.9 夺舍新页面 + 核心模块修复；
  - `0.8.3` = **派生补丁包**：沿用 0.8.x 旧设置页 UI，只回移核心模块修复（见 §7）。
  仓库里的 `version` 长期保持 UI 发布版的值，**不要为了发 0.8.3 而把仓库版本降下来**；0.8.3 用一次性副本/临时改版本的方式产出。

## 2. 本地验证（发布前必跑）

```sh
npm ci                 # 必须用 lockfile 装（见 §2bis）——不要用 pnpm 装出另一棵树
npm test               # build + bundle/render/integration/launcher 四套测试
npm run test:strict    # 同上但把"写域外已知缺陷"当失败（发布前应当全绿）
npm run check:vendor   # vendor 与工作树的**版本 + 内容级 sha256** 一致性（迁移包不在时 SKIP；见 §5）
```

`test-launcher.mjs` 用**随机端口 + 临时 profile**，不碰 3080/3081 与真 profile，也不写注册表（自启只做只读校验），
因此可以在任何机器上重复跑。

> **统计断言数别踩这个（D3）**：`test-bundle.mjs` 的断言行是 `CONTRACT OK:` / `RESCUE WIRE OK:` 之类的形式，
> **不以 `OK:` 开头** —— 任何按 `^OK:` 统计的脚本都会把它数成 **0**（实际是 11 条）。要机器统计就逐行枚举，
> 或等它在套件末尾加一行 `ALL … PASSED (11 checks)` 汇总（与 `test-render.mjs` / `test-launcher.mjs` 对齐）。

`test-integration.mjs` 会 `import lib/index.js`，而 host 需要引擎模块
`@deepseek-ai/dsh-home-paths`。它同时是 **optional peerDependencies**（运行时由引擎提供）
和 **devDependencies（钉 0.1.7-rc.2）**——后者专为"在普通工程/CI 里也能跑集成测试"。
只声明 peer 是不够的：`npm ci` 不会装 optional peer，集成测试会以
`ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-home-paths` 失败（这是审计④ R10 的实证）。

## 2bis. 「发布的字节 = 测过的字节」：依赖树必须来自 lockfile

**踩过的坑（2026-09-29，很隐蔽，务必保留这条）**：本地 `node_modules` 曾是用 **pnpm** 装的，
而 lockfile 是 **npm** 的 `package-lock.json` —— 两棵树对 `zod` 的解析不同：

| 依赖树 | zod | `lib/client.js` |
|---|---|---|
| 本地 pnpm 树（漂移） | 4.5.4 | **976,145 B**（22,684 行） |
| lockfile / `npm ci`（canonical） | 4.4.3 | **782,481 B**（18,236 行） |

差 **194 KB（25%）**。后果：**CI 发布的 bundle 与本地测过的 bundle 不是同一份**。
（诊断法：esbuild 的 `metafile` 显示两棵树 `inputs` 字节完全相同 → 差异只能来自依赖解析；
再逐个替换包定位到 zod。这个手法值得记住。）

**铁律**：

1. `packageManager` 是 `npm@11.19.0`，lockfile 是 `package-lock.json` → **装依赖就用 `npm ci`**。
   保留 `pnpm-workspace.yaml` 只是为了 pnpm 用户能跑 `build`（esbuild 的 `allowBuilds`），
   **不代表依赖树可以是 pnpm 的**。
2. 发布前做一次**干净树校验**：`rm -rf node_modules && npm ci && npm test && node build.mjs`，
   确认 `lib/client.js` 的 sha256 与你测过的那份一致。
3. 本机与 CI 都用 `npm ci` → 两边构建**逐字节相同**（已实测：`547e8d75dd3d26b7`）。
4. **复现构建一律用 canonical `node build.mjs`**，不要用 shell 拼 `--banner:js=` / `--footer:js=`（D4）：
   PowerShell 向原生程序传多行参数会**吞掉引号与 `\n`/`\t` 转义**，实测等价 CLI 产物变成
   **795,362 B / `60E76846…`**，而 canonical 是 **792,931 B / `00D06285…`** —— 差 2,431 B 的另一份字节。
   （两次等价 CLI 之间确实同哈希，所以那条只能证明"构建路径确定"，**不能**当等价性证据。）

## 3. 打包

```sh
npm run pack           # = node build.mjs && npm pack
# 或：node tools/dev/pack.mjs
```

- 产物：`dsh-plugin-manager-pro-<version>.tgz`（仓库根）。
- 发布物白名单在 `package.json` 的 `files`：`lib/*.js`、`lib/*.mjs`、`bin`、`cordis.patch.yml`、`README.md`、`LICENSE`。
  - **`lib/client.js.map` 故意不发布**（本地调试用，1.6 MB；同时被 `.gitignore` 忽略）。不要为了"体积好看"改回 `"lib"` 整目录。
  - 测试脚本、`tools/`、`docs/` 不发布。
- 核对清单：`npm pack --dry-run` 的输出里必须有四个 `bin/*` 与两个 `lib/*.mjs`（`enginectl.mjs`、`preflight.mjs`）。

## 4. 发布到 npm（认证 / 2FA / 冷静期 —— 一次说清，不用再调）

> 这一节的目的是：**任何一台机器、任何一次发版，都照抄这四步**，不再出现"token 明明是对的却 401"。

### 4.1 一次性准备：写一份**项目级** `.npmrc`

```sh
# 在仓库根（与 package.json 同级）建 .npmrc，内容一行：
//registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

三条硬规则：

1. **必须是项目级 `.npmrc`，不要只依赖用户级 `~/.npmrc`**。npm 的读取优先级是
   `命令行 > 环境变量 > 项目 .npmrc > 用户 .npmrc > 全局`；用户级里那枚陈旧的 token
   **正是历史 `E401` 的元凶**（项目级一旦存在就会盖过它，问题立刻消失）。
   ⚠️ 但要注意：**"项目级优先"意味着项目级那枚如果权限不足，会把用户级那枚有效 token 顶掉**——
   2026-09-30 的实况就是如此（项目级 token 无写权限 → 一路 404）。
2. `.npmrc` **已进 `.gitignore`**，不要把它提交进仓库，也不要把 token 写进任何文档/Release 说明。
3. 轮换 token 的操作：npm 网站 → Access Tokens → **Revoke** 旧的 → Generate New Token
   → 重新写进 `.npmrc` → **跑写权限探测**（见 §4.2 事实二，不要只看 `npm whoami`）。
   **在聊天/工单里出现过一次的 token 就当作已泄露**。

### 4.2 关于 2FA 与权限：三个反直觉的事实（2026-09-30 实测）

**事实一：`npm publish --dry-run` 不向 registry 发任何请求**（只做本地打包）。
所以 dry-run 通过 ≠ 能发布；权限 / 2FA 只有真发布那一刻才暴露。

**事实二：`npm whoami` 成功证明不了「能发布」。** registry 对**写操作**权限不足时返回
**404 `{"error":"Not found"}`**（故意掩盖 401，避免泄露包是否存在），而读操作一切正常。
本次实测两枚 token：

| token 来源 | `npm whoami` | 写操作探测（PUT 合法 body） |
|---|---|---|
| 手工建的项目 `.npmrc`（`npm_9asqCZ…`） | ✅ nonentity303 | **404 = 无写权限** |
| `npm login --auth-type=web` 写入 `~/.npmrc` | ✅ nonentity303 | **401 + `npm-notice` = 有写权限（仅缺 2FA）** |

→ 发布前请用**写权限探测**而不是 `whoami`：对该包名发一个结构合法、版本不存在的 `PUT`
（如 `0.0.0-probe`）。判据：**401 = 有写权限（只缺 2FA）／404 = 无写权限**。

**事实三：npm CLI 只实现 TOTP，完全不读 registry 的「安全密钥」入口。**
2FA 拦截时 registry 返回的是：

```
www-authenticate: OTP
npm-notice: Open https://www.npmjs.com/login/<uuid> to use your security key for authentication
```

而 npm 11.19.0 的 `lib/utils/auth.js` 只在 `err.body.authUrl && err.body.doneUrl` 同时存在时
才走 WebAuthn（`webAuthOtp`），且要求 **stdin/stdout 是 TTY**；registry 实际给的是
`npm-notice` **响应头**，CLI 不解析它 → 直接抛
`This operation requires a one-time password`，并把 URL 打成 `auth/cli/***`。
**对"只用 Windows Hello、未配置 TOTP"的账号，CLI 发布天然被堵死。**

补充：registry 对 `npm-otp` 的校验规则是 **6 位纯数字 TOTP** 或 **64 字符 web token**
（`otp length must be 64 characters long`）——随手一串数字过不去。

**三条可用姿势**：

| 姿势 | 操作 | 评价 |
|---|---|---|
| **① `tools/dev/publish-webauth.mjs`** | 脚本从响应头取未打码的 `npm-notice` 链接 → 开浏览器用 Windows Hello 认证 → **每 20 秒重试真发布**直到成功 | ✅ 已验证（0.9.0 就是这么发的） |
| **② Bypass 2FA 的 granular token** | npm 网站生成（勾 Bypass 2FA）→ 写进项目 `.npmrc` | 省事，但 npm 正在收紧（见下） |
| **③ Trusted Publishing（OIDC）** | 交给 CI：`id-token: write`，**零 token、零 2FA** | 长期正解（见 `.github/workflows/release.yml`） |

> ⚠️ npm 官方正在收紧 ②（CLI 提示原文）：
> `npm tokens that bypass 2FA are being restricted for account changes and direct publishing.`
> 日常发版走 ③，卡住时用 ① 兜底。

**为什么 ① 的进度判据必须是「反复试真发布」**：npm 的 web token 是写进 CLI 会话的，
探测请求看不出浏览器会话状态——只有真的调 `publish` 才知道认证生效没有（失败即 `EOTP` 就继续等）。

### 4.3 每次发布：三条命令

```sh
npm run preflight          # ① 体检：身份 / 版本是否已占用 / 2FA / tarball 内容（只读，不改任何东西）
npm run test               # ② 回归：build + bundle/render/integration/launcher 四套（见 §2）
npm run publish:npm        # ③ 预演：npm publish --dry-run（不写 registry）
npm run publish:npm:apply  # ④ 真发；发布后自动核对 registry 并打印冷静期提示
```

- ③/④ 用的是同一个脚本 `tools/dev/publish-npm.mjs`：**默认预演，必须显式 `--apply` 才真发**。
  发布前它会自己再串一遍体检，任何 FAIL 直接中止。
- 其它参数：`--tag next`（发到别的 dist-tag）、`--otp 123456`（token 没有 2FA 绕过能力时用）、
  `--cache <目录>`（npm 缓存不可写时指定，例如受限沙箱/只读盘）。
- 脚本会**强制把 npm 缓存指到一个可写目录**（默认仓库内 `.npm-cache/`，已 gitignore）。
  默认缓存目录不可写时报的是 `EPERM`（看起来像权限故障，其实只是缓存目录不可写），指一下就没了。

### 4.4 发完立刻要做的两件事

1. **核对**：`npm view dsh-plugin-manager-pro version` 必须等于 `package.json` 的 `version`
   （`publish:npm:apply` 已经自动打印）。README 里"npm 上最新是 X"这句话要同步改。
2. **告诉用户怎么立刻装上**——pnpm 11 的 `minimumReleaseAge` 默认 **1440 分钟**（24 小时），
   刚发的版本**不带版本号是装不到的**：

   ```sh
   # 立刻装（唯一永远可靠的写法：显式版本号）
   dsh plugin --profile web add dsh-plugin-manager-pro@0.9.0
   # 或者把该版本加进 profile 的 pnpm-workspace.yaml：
   # minimumReleaseAgeExclude:
   #   - dsh-plugin-manager-pro@0.9.0
   ```

   这条同样写进了 README 的安装小节，避免"发了但用户说装不上"。

### 4.5 常见错误对照表

| 症状 | 真因 | 处理 |
|---|---|---|
| `E401 Unauthorized` | 用的是用户级 `~/.npmrc` 里的旧 token（或 token 被撤销） | 写项目级 `.npmrc`；`npm run preflight` 看 whoami |
| `EOTP` / This operation requires a one-time password | token 没有 Bypass 2FA 能力 | `--otp <6位数>` 直发，或改走 §4.2 的 ③ |
| `dry-run` 通过但真发布失败 | **dry-run 不访问 registry**，它不校验权限/2FA | 以真发布结果为准；用 `npm access list collaborators` 提前确认写权限 |
| `EPERM ... npm-cache` | npm 缓存目录不可写 | `--cache <可写目录>`（脚本已默认处理） |
| `EPUBLISHCONFLICT` / cannot publish over | 同版本号已存在 | 改 `package.json` 的 version（禁止删版本重发） |
| 发布成功但用户装的是旧版 | `minimumReleaseAge` 24 小时冷静期 | 让用户用显式版本号 `@<version>` 安装 |
| 包内容少了 bin / 多了 `.map` | `files` 白名单被改动 | 体检里的「tarball 必备文件 / 体积红线」会拦下 |



`package.json` 的 `bin` 暴露三个命令（`exports` 同时放行 `./bin/*` 供程序化调用）：

| 命令 | 文件 | 用途 |
|---|---|---|
| `dsh-pm-launcher` | `bin/open-boot.mjs` | 3081 **唯一网页入口**（启动页 `/` + 救援页 `/rescue` + `/api/*`）+ 常驻守护（`--supervise`/`--ensure`/`--status`/`--autostart-status`/`--install-autostart`/`--uninstall-autostart`）+ `--uninstall` 卸载闭环 |
| `dsh-pm-boot` | `bin/dsh-boot.mjs` | 启动序列：verify → fix → 拉起引擎 → 健康等待（`--repair-only`） |
| `dsh-pm-rescue` | `bin/rescue-daemon.mjs` | 独立**备份**救援服务（默认 **3082**；verify/fix/start/stop/status API） |

> 端口、退出码、写接口防护与 `--uninstall` 四步的完整口径见 [`LAUNCHER.md`](LAUNCHER.md)（该文件与实现逐条核对，附「文档条目 → 代码位置」核对表）。

安装后可直接 `npx dsh-pm-launcher --help`，或在包目录里 `node node_modules/dsh-plugin-manager-pro/bin/open-boot.mjs --help`。
**不要在 README/文档里写裸相对路径 `node bin/...`**——那只对"cwd 恰好在包根"的开发者成立。

## 5. 迁移包 vendor 刷新（审计④ R3/R15 → F5）

`migration/pkg/main/vendor/` 里预置了 profile 各插件的离线 tarball，`deploy.ps1` 用 `tools/fix-package-json.js`
把它们 pin 到 profile 的 `package.json`。**vendor 过期 = 新机器装出旧版插件**（历史上 vendor 里躺过 0.7.4 的旧启动器）。

> **两条硬性口径（F5 的教训）**
> 1. **必须在最后一轮源码修改之后再打包**。只要之后还有人改 `lib/`、`bin/`、`README.md`、`package.json`，
>    打出来的 tgz 就是陈旧的；顺序错一次，新机器就会装出"版本号对、内容旧"的包。
> 2. **必须做内容级校验**（`npm run check:vendor` 现在会逐文件比 sha256）。
>    **只比版本号是无效断言**：陈旧 tgz 的 `package/package.json` 版本同样是 `0.9.0`，
>    旧版断言（仅版本）会把它整个放行 —— 这正是 F5 的成因。实测：同一份陈旧 tgz，
>    仅版本断言 exit 0，内容级断言 exit 1 并列出 5 个差异文件。

刷新步骤：

1. 确认本轮所有修复已合并（**最后一个改文件的写者也收工了**），然后按 §3 打出 `dsh-plugin-manager-pro-<version>.tgz`；
2. 把它拷进 `migration/pkg/main/vendor/`（删除旧版本 tgz，文件名与 `manifest.json` 指向一致）；
3. 更新 `migration/pkg/main/vendor/manifest.json`：
   - `"dsh-plugin-manager-pro": "dsh-plugin-manager-pro-<version>.tgz"`
   - `"_meta": { "dsh-plugin-manager-pro": "<version>" }`（deploy 时的期望版本，**必须与 package.json 一致**）
4. 断言（**仓库侧，内容级**）：`npm run check:vendor` → 必须全绿。它会做三件事：
   - 版本链一致（manifest `_meta` == tgz 内 `package/package.json` == 仓库 `package.json`）；
   - **正向**：`files` 白名单里工作树的每个文件都必须在 tgz 内出现且 sha256 一致（改了源码没重打包 → 失败）；
   - **反向**：tgz 内每个文件都必须能在工作树里找到且 sha256 一致（tgz 比工作树新或旧都算失败）。
   失败时会打印「文件 / tgz 内 sha256 / 工作树 sha256」差异清单，照着重新打包即可。
5. 断言（**部署侧**）：`deploy.ps1` 在部署时还会再断言一次 —— 版本不符、tgz 缺关键文件、
   或安装到 `node_modules/dsh-plugin-manager-pro` 的文件与 tgz 内同名文件 sha256 不一致，都会直接 throw
   （防止"tarball 陈旧/损坏/被 registry 解析成别的版本"这类问题在新机器上静默通过）。


## 6. 发布

```sh
git add -A && git commit -m "v<version>: <一句话>"
git tag v<version>
npm publish            # 或走 GitHub Release 附 tgz（离线/自建场景）
git push && git push --tags
```

- npm 已发布版本与仓库 `version` 必须能对上；`git tag` 也要补齐（历史上 tag 停在 v0.6.9，与 npm 上的 0.8.x 脱节）。
- 自启注册表所有权（审计④ R4/R5）：**只有 `dsh-pm-launcher --install-autostart` 写 `HKCU\...\Run\DSHWebFront`**。
  迁移包 `deploy.ps1` 不再自建 `.vbs`、也不再写该键，它只调用包内 `--install-autostart`（失败时打印警告，不静默降级）。
  卸载统一走 `dsh-pm-launcher --uninstall-autostart`。

## 7. 派生补丁包 0.8.3（核心修复回移到 0.8.x UI）

**为什么**：0.9.0 的客户端是"夺舍新页面"（接管内置插件页），对只想修 bug、不想换 UI 的用户，
需要一个**沿用 0.8.x 旧设置页、但包含本轮全部核心修复**的补丁包。这就是 0.8.3。
它**不是**从仓库当前源码直接构建的版本（那样会带上 0.9 的新 UI），而是"基线 + 覆盖核心文件"的派生包。

**基线**：npm 上已发布的 `dsh-plugin-manager-pro@0.8.3-1`（旧 UI 的最后一版）。
本仓库 `tools/dev/artifacts/dsh-plugin-manager-pro-0.8.3-1.tgz` 保留了同一份基线副本。

**步骤（可照做）**

```sh
# 1) 准备一个一次性工作目录，解包基线（不要在仓库里改 version）
mkdir /tmp/pm-083 && tar -xzf tools/dev/artifacts/dsh-plugin-manager-pro-0.8.3-1.tgz -C /tmp/pm-083
cd /tmp/pm-083/package

# 2) 用本轮修好的"核心文件"覆盖基线里的对应文件（客户端 bundle 不动！）
#    - lib/index.js          管理器 host（H1–H5）
#    - lib/remote.js         远程契约（H2 相关字段）
#    - bin/**                启动器与救砖链（L1–L8）
#    - lib/enginectl.mjs     引擎生命周期（L2/L4/L5/L7）
#    - lib/preflight.mjs     启动前自检/修复
#    - tools/dev 与 docs/    文档/开发脚本（可选，不影响运行）
#    注意：**不要**覆盖 lib/client.js（保持 0.8.x 旧 UI），也**不要**覆盖 cordis.patch.yml
#         （0.8.x 那份没有 main key=plugins 的接管）

# 3) 版本号：在**一次性目录里**把 package.json 的 version 改成 0.8.3（仓库里的版本不动）
node -e "const f='package.json',p=require('./'+f);p.version='0.8.3';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')"

# 4) 打包（不要跑 build.mjs，否则会把 0.9 的新 UI 编译进 lib/client.js）
npm pack
```

**打包后必须校验（两条硬性检查）**

```sh
# ① UI 必须是旧版：新 UI 的槽位出口 plugins.row.config 在旧 bundle 里不存在
tar -xOzf dsh-plugin-manager-pro-0.8.3.tgz package/lib/client.js | grep -c 'plugins.row.config'   # 期望 0
# ② 不能有 main key=plugins 的接管：patch 层应仍是 0.8.x 那份
tar -xOzf dsh-plugin-manager-pro-0.8.3.tgz package/cordis.patch.yml | grep -c 'ui-plugin-manager'          # 期望 0
tar -xOzf dsh-plugin-manager-pro-0.8.3.tgz package/cordis.patch.yml | grep -c 'ui-settings-plugin-inventory' # 期望 1
# ③ 核心文件确实是新的（对照仓库）
tar -xOzf dsh-plugin-manager-pro-0.8.3.tgz package/lib/enginectl.mjs | grep -c 'engineHealth'      # 期望 >0（L4 修复的产物）
tar -xOzf dsh-plugin-manager-pro-0.8.3.tgz package/lib/index.js     | grep -c 'AUTO_QUARANTINE_STREAK' # 期望 >0（H3 修复的产物）
```

> 参考数值（本机实测，0.9.0 的 bundle 与基线 0.8.3-1 的 bundle 对比）：
> `plugins.row.config` 在 0.8.3-1 的 `lib/client.js` 里为 **0** 命中，在 0.9.0 里为 **6** 命中 → 用它当"新 UI 指纹"是可靠的。

**发布**：`npm publish` 或 GitHub Release 附 tgz；`git tag v0.8.3`（tag 指向产出该包的那次提交即可，
仓库 `package.json` 的 version 仍是 0.9.0，本文件 §1 已说明这种双发布物的口径）。

**三条不要碰**（覆盖列表里刻意排除）：

1. `lib/client.js` —— 覆盖了就等于把 0.9 的新 UI 装进 0.8.3，C1/C2 的"UI 侧缺陷"描述立刻失效；
2. `cordis.patch.yml` —— 0.9 那份会禁用内置 `ui-plugin-manager` 接管插件页，0.8.3 必须保持基线那份；
3. `README.md` —— 0.9 的 README 讲的是夺舍新页面；建议保持基线的 README（旧 UI 的说明）。
   （`docs/` 覆盖只影响源码树的可读性：`files` 白名单不包含 `docs/`，它不会进 tarball。）

**本流程已实测通过（2026-09-28，派生包 `dsh-plugin-manager-pro-0.8.3.tgz`）**

| 校验点 | 实测值 |
|---|---|
| `package/lib/client.js` 内 `plugins.row.config` | **0**（旧 UI ✓，0.9 的 bundle 是 6） |
| `package/cordis.patch.yml` 内 `ui-plugin-manager` | **0** ✓ |
| `package/cordis.patch.yml` 内 `ui-settings-plugin-inventory` | **1** ✓ |
| `package/lib/enginectl.mjs` 内 `engineHealth` | **6**（L4 修复已进包 ✓） |
| `package/lib/index.js` 内 `AUTO_QUARANTINE_STREAK` | **5**（H3 修复已进包 ✓） |
| tarball 内 `client.js.map` | **0**（不发布 sourcemap ✓） |
| 仓库 `package.json` 的 version | 仍为 **0.9.0**（当时的仓库版本；演练证明派生打包不会动仓库版本 ✓） |

## 8. pnpm 11 的 24 小时冷静期（`minimumReleaseAge`）

**事实**：pnpm 11 起 `minimumReleaseAge` 默认 **1440 分钟**（v11 之前为 0）——
[pnpm 文档 settings/dependency-resolution#minimumreleaseage](https://pnpm.io/settings/dependency-resolution#minimumreleaseage)。
`minimumReleaseAgeStrict` 默认 `false`，所以表现不是"直接失败"，而是**新版本可见但解析不到**：当天发布的版本
`dsh plugin --profile web add dsh-plugin-manager-pro`（不带版本号）会解析到**旧版**，用户看到的是"发了但我装不上"。

**发布时必做的两件事**

1. 发完立刻核对（`publish:npm:apply` 会自动打印）：
   ```sh
   npm view dsh-plugin-manager-pro version          # 必须等于 package.json 的 version
   npm view dsh-plugin-manager-pro time.0.9.1       # 发布时间戳
   ```
2. 告诉用户**怎么立刻装上**——唯一永远可靠的写法是显式版本号：
   ```sh
   dsh plugin --profile web add dsh-plugin-manager-pro@0.9.1
   # 或把它加进 profile 的 pnpm-workspace.yaml（本机已用过这个豁免）：
   # minimumReleaseAgeExclude:
   #   - dsh-plugin-manager-pro@0.9.1
   ```

> 这条同时写进了仓库根 `README.md` 的安装小节（"装不到 / 装完还是旧版？"）：**别在发版当天说"已发布，去装吧"**。

## 9. 引擎升级彩排（每次 DSH `0.1.x` 发布后必跑）

**为什么是硬流程**：官方 0.1.6 把插件管理页收进引擎后，**同类管理器成批死亡**——声明了与官方同名的 loader entry id
就会让 profile 直接崩（`TypeError: duplicate loader entry id: plugin-manager`，见 `README.md` 的「老管理器为什么死」）。
本包靠"不与官方抢 id + 关内置页 + 自己当槽位宿主"活下来，但**下一次引擎改动同样会打到我们身上**。
所以每次引擎小版本发布后，必须在**隔离环境**里验收三类破坏性变更：

| 类别 | 检查什么 | 怎么验 | 命中后的动作 |
|---|---|---|---|
| **行 id** | 官方 `dsh-base` / `dsh-web-app` 的 patch 里是否新增/改名了 `plugin-manager`、`ui-plugin-manager` 等行 | 读引擎安装目录的 `@deepseek-ai/dsh-base/cordis.patch.yml`、`@deepseek-ai/dsh-web-app/cordis.patch.yml`，与 `dev-docs/管理器适配0.1.7新UI方案.md` 的记录对比 | 调整包内 `cordis.patch.yml`（停用哪一行 / 自己用什么 id），并跑一遍彩排 |
| **槽位** | `main` 的 `key`、`sidebar.panellist` 的 `id`、7 个 `plugins.*` 子槽位的名字与 kind 是否变化 | 用探针脚本抓 `__DSH_BOOT__` 与槽位注册表；对照 `src/client.jsx` 的 `children` 声明 | 改客户端注册面（`main` / `sidebar.panellist` / `children`）并重建 `lib/client.js` |
| **包存在性** | `dsh.client.inject` 引用的 `@deepseek-ai/*` 包是否还在（0.1.7 删掉过 `dsh-client-runtime`）、typert strict codec 是否需要新工厂 | `upgrade-rehearsal/tools/scan-compat.mjs --target <引擎 node_modules>`（逐 mod 扫全版本历史）+ 启动日志里查 `did not activate` / `no create() factory` | 改 `package.json` 的 `dsh.client.inject` / `lib/remote.js` 的 codec，重打包后在彩排环境复跑 |

**彩排搬运单（照抄）**

```sh
# 1) 独立 DSH_HOME + 克隆 profile（绝不碰真实 ~/.dsh）
#    参见 upgrade-rehearsal/README.md 的三个坑：别 robocopy 克隆 node_modules、必须独立 DSH_HOME、
#    不要在彩排根目录跑 npm/pnpm install
# 2) 用隔离引擎起一个独立端口（例：3085）
# 3) 装候选 tgz（显式版本号 + 关掉冷静期）
#    dsh plugin --profile web add ./dsh-plugin-manager-pro-<版本>.tgz --config.minimumReleaseAge=0
# 4) 判定标准
#    a. 启动日志里**不出现** `dsh: warning: N entries did not activate`
#    b. 侧边栏出现「插件管理」，五个分区齐备（截图存证）
#    c. 第三方配置卡片（如 dsh-free-search 的行内配置）能展开
#    d. `npx dsh-pm-launcher --status` 对隔离 profile 报三进程正常
```

彩排结论写进 `docs/releases/<版本>.md` 的「验证」段（历史样例见 `RELEASE_NOTES_0.8.3-1.md`：**引擎 0.1.7-rc.2：零条目失败**），
并在下一次发版时更新 `README.md` 的引擎兼容性矩阵。

## 10. 发布核对表（用户规定的固定五步，照抄即可）

> **固定五步，不得跳步或换序**：**① 独立端口验证 → ② 打包 → ③ 主端口安装 → ④ 补充打包 → ⑤ 上传**。
> 适用于所有自研 mod（本包与后续新 mod）。下面 18 条按这五步分组，编号即执行顺序。

**红线（先看这四条）**

1. **未经用户明确确认，不得进入第 ⑤ 步** —— 推送 / tag / npm 发布一律等用户点头。
2. **任何改动之后必须回到第 ② 步重新打包**（代码、文档、版本号、发布日期都算）；"版本号相同、内容陈旧"是最隐蔽的坑。
3. 每一步都要留下**可复核证据**（命令原文 + 输出 + 哈希 / 截图）；**未实测的不写"通过"**。
4. **预发布版绝不能发成 `latest`** —— 版本号含 `-`（如 `0.9.1-rc2`）时，`release.yml` 会自动改用 dist-tag **`next`**；走人工兜底路径（第 14 步）时必须**显式** `--tag next`。发错会让 `npm i dsh-plugin-manager-pro` 的用户拿到 RC（见下文「预发布版（RC）专项」）。

### ① 独立端口验证（绝不碰真机 3080/3081/4081）

| # | 步骤 | 命令 | 通过标准 |
|---|---|---|---|
| 1 | 搭隔离环境 | 独立 `DSH_HOME` + 克隆 profile（排除 `node_modules` 后重建）+ 非默认端口（如 3090/3091/3092） | 真机 3080/3081/4081 全程未被动过（记录前后 pid 与注册表值） |
| 2 | 装候选件，跑通**全部新功能** | `dsh plugin --profile <名> add <候选 tgz> --config.minimumReleaseAge=0`；`node test-launcher.mjs --strict` / `npm test` | 四套件全绿；**启动器断言数以 `node test-launcher.mjs --strict` 的输出为准**（别把历史数字抄进报告）；**每个新功能**都有命令原文 + 输出 + 截图或用户点检清单 |
| 3 | 补彩排结论 | 需要时按 §9 跑引擎升级彩排的三类破坏性变更（行 id / 槽位 / 包存在性） | 结论写进 `docs/releases/<版本>.md` 的「验证」段；**未取得的证据如实记为"未取得"** |

### ② 打包（canonical 路径 + 记录指纹）

| # | 步骤 | 命令 | 通过标准 |
|---|---|---|---|
| 4 | 干净树构建 | `rm -rf node_modules && npm ci && npm run build` | `lib/client.js` 的 sha256 == 你测过的那份（§2bis）。**只用 canonical `node build.mjs`**；不要用 shell 拼 `--banner:js=`（D4：PowerShell 吞引号与 `\n`/`\t`，产物变成另一份字节） |
| 5 | 四套测试 | `npm test`；发布前再加 `npm run test:strict` | 全绿（bundle / render / integration / launcher）。统计断言数时注意 **`test-bundle.mjs` 不以 `^OK:` 开头**（D3，按 `^OK:` 会数成 0，实际 11 条） |
| 6 | bump 版本 + 元数据 + 发布说明 + CHANGELOG | 改 `package.json` 的 `version`；核对 `engines`；写/更新 `docs/releases/<版本>.md`（发布日期可在第 ④ 步回填）；`node tools/dev/gen-changelog.mjs` | `node tools/dev/gen-changelog.mjs --check` exit 0（发布说明已进 CHANGELOG；**排序口径 = 发布顺序（新→旧）：日期倒序 → 同一天同族的预发布版在正式版之上 → 无日期者垫底**；预发布段头必须带**（预发布）**标注，如 `## [0.9.1-rc2] - 2026-10-07（预发布）`）。生成器另有**静默漏版护栏**：`docs/releases/` 下出现"版本号打头却没被识别成发布说明"的文件时直接 exit 1（白名单见脚本注释 `NON_RELEASE_SUFFIXES`）；预发布形态支持 `-rcN` / `-rc.N` / `-alpha.N` / `-beta.N`；**`engines.node` 与实现要求一致** —— 核对：`node -p "JSON.stringify(require('./package.json').engines)"`。本轮已发现一处运行时门槛：`findPackageJSON` 在 Node 18/20 上加载失败，**最终下限以 `package.json` 的 `engines` 落地值为准**（改完 engines 要回到第 ② 步重打包） |
| 7 | vendor 刷新 + 内容级校验 | 先按 §5 用**本轮** tgz 刷新 `migration/pkg/main/vendor/` 与 `manifest.json`，再 `npm run check:vendor` | 版本链 + 正反双向逐文件 sha256 全绿。**vendor 还停在上一版时这一步必然红**（开发期为预期状态，打包后必须刷新） |
| 8 | 打包 + 记录指纹 + 逐文件比对 | `npm run pack`（= `node build.mjs && npm pack`）→ 记录 **sha256 + 文件数 + 关键文件哈希** → **逐文件比对 tgz 与工作树**（可用 `node tools/dev/verify-triple.mjs` 做「本地 tgz / 工作树 / registry」三方比对） | 逐文件一致（**不一致 = 作废重打**）；`npm pack --dry-run` 的输出里有四个 `bin/*` 与两个 `lib/*.mjs` |

### ③ 主端口安装（**在上传之前**，真机真实环境）

| # | 步骤 | 命令 | 通过标准 |
|---|---|---|---|
| 9 | 装进真机 profile 并重启引擎 | `dsh plugin --profile web add <候选 tgz>` → 重启 3080/3081 | 新功能在**真实环境**可用、日常使用无碍（记录重启前后的 pid / 版本 / 关键文件哈希） |
| 10 | CI 门禁（可与 9 并行） | push 到 `master` 后看 `.github/workflows/test.yml` | Windows 矩阵（node 20/22）**必须全绿**；Ubuntu 是实验性（`continue-on-error`），红了不阻塞，但要修测试的平台分支 |

### ④ 补充打包（装机阶段暴露的东西全部落地）

| # | 步骤 | 命令 | 通过标准 |
|---|---|---|---|
| 11 | 落地改动 → 重新打包 | 修复 / 文档 / 版本与日期回填 → **回到第 4–8 步重跑**（build → test → gen-changelog → check:vendor → pack） | **发布件 == 工作树 == 已装机验证的那一份**（内容级校验）；日期回填后 `gen-changelog --check` 仍 exit 0 |

### ⑤ 上传（推送 / tag / 发布，需用户明确确认）

| # | 步骤 | 命令 | 通过标准 |
|---|---|---|---|
| 12 | 提交 + 推送 + tag | `git add -A && git commit -m "v<版本>: …"` → `git tag v<版本>` → 推送 master 与 tag | 发布提交里同时含发布说明、刷新后的 `CHANGELOG.md`、以及 README 的图片绝对 URL（图片与 README 同 commit，不存在坏图窗口）。**tag 必须与 `package.json` 的 `version` 逐字一致**（含 `-rc2` 这类后缀，tag 形如 `v0.9.1-rc2`）；不一致时 `release.yml` 的「校验 tag 与 package.json 版本一致」这一步会 throw 并中止 |
| 13 | CI 发布（OIDC，零 token） | tag 触发 `.github/workflows/release.yml` 走 `npm publish --provenance --access public --tag <dist-tag>` | tag 与 `package.json` 版本一致性校验通过、日志里 token 是占位符、发布成功；CI 里也跑过与第 4–5、7 步相同的构建 / 测试 / vendor。**dist-tag 由工作流自动判定**：版本号含 `-` → `next`，否则 → `latest`（人工兜底发布时要自己加 `--tag next`） |
| 14 | 兜底路径（仅本机、无 TOTP 时） | `npm run publish:webauth`（取未打码 `npm-notice` 链接 → Windows Hello → 每 20 秒重试真发布） | 见 §4.2 ①；**0.9.0 就是这么发的**。**注意**：手动路径不会自动判定 dist-tag —— 预发布版必须自己加 `--tag next` |
| 15 | **双轨发布必须同字节（D1，强制）** | npm 发布完成后，**从 registry 下载该版本的 tarball**，与候选件比对 `sha256` 与字节数；**一致后把这个下载下来的文件作为 GitHub Release 附件上传**，并记录两边 sha256 与字节数 | 两处 sha256 与字节数**逐字相等**。**禁止**用"本机重新打包"的 tgz 当 Release 附件（v0.9.0 就是这么错的：附件 `217,689 B` / `sha256 a29ead25…`，npm 上 `217,699 B` / `9cbd3684…`，差 10 B）。**本轮起 `release.yml` 已把这一步自动化**：它用 `npm pack` 与 registry 下载件做 sha256 比对，不一致直接 throw；CI 日志末行打印「Release 附件请用 registry 下载的同一份」 |
| 16 | 发完立刻核对（**两段判定**） | ① packument：`npm view dsh-plugin-manager-pro@<版本> version`；② tarball：`https://registry.npmjs.org/dsh-plugin-manager-pro/-/dsh-plugin-manager-pro-<版本>.tgz` 的 `HEAD` 是否 200；③ `npm view dsh-plugin-manager-pro dist-tags` | ① 必须等于 `package.json` 的 version —— **只有它缺失才算"发布失败"**；② **packument 出现 ≠ tarball 可用**：tarball 在 CDN 上可能滞后数分钟（0.9.1 首次实测约 5 分钟），因此要**先 packument、再 tarball 可达**，两段合起来等 **≥10 分钟**；tarball 仍未就绪只记"传播中"、不判失败（稍后手动回读）；③ dist-tags 见「预发布版（RC）专项」 |
| 17 | 图片可达性回读（D2） | `https://api.github.com/repos/nonentity303/dsh-plugin-manager/contents/docs/images/pm-090-official2.png`（另两张同理） | HTTP **200** 且 `download_url` 可用。**推送前必然 404**（图是未跟踪的新文件）；本机 raw 域名受网络分区影响，回读用 api.github.com contents，必要时 jsDelivr 镜像，**不要**用 raw 链接自检 |
| 18 | 冷静期提示 + 收尾 | `README.md` 安装小节保留"显式写版本号"（§8）；关掉临时 profile/端口；`git status` 干净 | 用户能按 README 就地装上当天发布的版本；工作树干净 |

### 预发布版（RC）专项（版本号含 `-` 时适用）

> 场景：用户要求某一轮先用**预发布版本号**（如 `0.9.1-rc2`）给尝鲜用户，验证通过后再发正式版。
> 下列规则由 `release.yml`（tag 校验 / dist-tag 判定 / 发布后核对）与人工核对共同保证，**逐条可勾选**。

| # | 项 | 怎么做 | 判据 / 命令 |
|---|---|---|---|
| R1 | 版本号 | `package.json` 的 `version` 写成 `0.9.1-rc2`（**含 `-rc2` 后缀**，npm 视为预发布） | `node -p "require('./package.json').version"` → `0.9.1-rc2` |
| R2 | tag | `git tag v0.9.1-rc2`（与 `version` **逐字一致**，含后缀） | `release.yml` 的「校验 tag 与 package.json 版本一致」这一步通过；不一致会 throw 并中止（第 5 步） |
| R3 | dist-tag | CI 自动判定：版本号含 `-` → **`next`**；人工兜底发布（第 14 步）时自己加 `--tag next` | `npm view dsh-plugin-manager-pro dist-tags` → 必须同时看到 `next: 0.9.1-rc2` **且 `latest: 0.9.1`（保持指向当时最新正式版）** |
| R4 | **红线** | **绝不能把 RC 发成 `latest`** —— 否则 `npm i dsh-plugin-manager-pro` 的人会装到预发布版 | 若发现 `latest` 变成了 RC：立刻 `npm dist-tag add dsh-plugin-manager-pro@<最近正式版> latest` 把标签拨回去，并在发布记录里注明 |
| R5 | GitHub Release | 预发布版创建时勾 **`prerelease: true`**，**不要**标 "Latest" | Release 页显示 Pre-release 徽标；Latest 仍指向最近的正式版（附件仍按第 15 步用 registry 下载件） |
| R6 | 尝鲜安装（对外写法） | 文档/公告写 `npm i dsh-plugin-manager-pro@next` 或 `@0.9.1-rc2` | 装出来的版本 = `0.9.1-rc2`；不要写"装最新版" |
| R7 | 正式版收口 | RC 验证通过后，把它的内容并入**下一个正式版本号**（例如紧跟 `0.9.1-rc2` 的是 `0.9.2`）再发正式版 —— **此时 `latest` 才前移**；npm 不允许把已发布的正式版号重发 | `dist-tags` 的 `latest` 前移到新正式版；RC 留在 `next`（可选：发完正式版后 `npm dist-tag rm dsh-plugin-manager-pro next` 收掉 `next`） |

> **D1 的由来**：v0.9.0 的 GitHub Release 附件与 npm 发布件**不是同一份字节** —— 附件 `217,689 B` / `sha256 a29ead25…`，
> npm `217,699 B` / `9cbd3684…`（差 10 B）。这是 F5 的同族问题：**版本号相同、内容不同**；两个渠道拿到的包不一样，
> 用户无法用任何哈希互相验证。第 15 步就是为它加的硬关卡。
>
> **发布后核对为什么分两段（0.9.1 首次真实运行暴露）**：registry 的 **packument**（`npm view <包>@<版本> version`）通常立刻可见，
> 但**同一版本的 tarball 在 CDN 上可能滞后数分钟**（0.9.1 首次实测约 5 分钟）—— 旧版"短轮询"会把这种情况误报成失败。
> 现在 `release.yml` 的「发布后核对 registry」按两段判定：① packument（30×20s ≈ 10 分钟，**只有它缺失才 throw**）；
> ② tarball `HEAD`（30×20s ≈ 10 分钟，未就绪只 `Write-Warning` 并按成功退出）；最后做**双渠道同字节** sha256 比对（D1 自动化，不一致 throw）。
> 人工核对按第 16 步照做即可，**总时长 ≥10 分钟**。
>
> **最低 Node 版本**：以 `package.json` 的 `engines.node` 为**唯一口径**（本文件刻意不写具体数字，避免与实现漂移）。
> 本轮已知一处运行时门槛：`findPackageJSON` 需要较新的 Node，Node 18/20 上会加载失败 —— 修完由实现方落进 `engines`，
> 发布前按第 6 步核对 `node -p "JSON.stringify(require('./package.json').engines)"`。注意：CI 的**发布** runner 固定 Node 24
> （`.github/workflows/release.yml`），它只说明"发布环境能跑"，**不等于**用户侧最低要求。
>
> **D2 / D3 / D4**（低优先观察，已就近写进上文）：**D2** 图片是 `raw.githubusercontent…/master/…` 绝对 URL → 推送前 404，推送后按第 17 步回读；
> **D3** `test-bundle.mjs` 的断言不以 `OK:` 开头 → 统计别用 `^OK:`（见 §2）；**D4** 复现构建只用 canonical `node build.mjs`，别用 shell 拼 banner（见 §2bis 第 4 条）。
>
> **与旧版的对应**：第 4–13、15–18 条即上一版核对表的 1–13 条；变化在于**顺序**（新增"主端口安装"为第 ③ 步、放在上传之前，
> 并把"补充打包"独立成第 ④ 步）、红线三条 → **四条**，以及本轮新增的**「预发布版（RC）专项」小节**、
> 第 13 步的 **dist-tag 自动判定**、第 15 步的**双渠道同字节自动化**、第 16 步的**两段核对**。
>
> 发布说明模板：`docs/releases/<版本>.md`（历史样例：`0.9.0.md` 面向用户、`RELEASE_NOTES_0.8.x.md` 按模块分节）。
> 版本历史汇总由 `node tools/dev/gen-changelog.mjs` 生成 `CHANGELOG.md`，**不要手改**。
