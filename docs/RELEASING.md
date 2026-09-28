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

- 唯一来源：`package.json` 的 `version`（当前 0.9.0）。构建产物不写版本号，`lib/client.js` 是源码的编译结果。
- 每个版本必须有 `docs/releases/<version>.md`（发布说明）。缺它就不算可发布。
- 预发布段（如 `0.9.0-1`）用于"同一版本的修补"：`dsh plugin add` 按版本号缓存 tarball，
  **内容改了就必须改版本号**，否则 pnpm 会报 "Already up to date"。
- **同一源码树可以产出两个发布物**（2026-09 起的口径）：
  - `0.9.0` = **UI 发布版**：`package.json` 的 `version` 就是它，包含 0.9 夺舍新页面 + 核心模块修复；
  - `0.8.3` = **派生补丁包**：沿用 0.8.x 旧设置页 UI，只回移核心模块修复（见 §7）。
  仓库里的 `version` 长期保持 UI 发布版的值，**不要为了发 0.8.3 而把仓库版本降下来**；0.8.3 用一次性副本/临时改版本的方式产出。

## 2. 本地验证（发布前必跑）

```sh
npm install            # 或 pnpm install（见 §0）
npm test               # build + bundle/render/integration/launcher 四套测试
npm run test:strict    # 同上但把"写域外已知缺陷"当失败（发布前应当全绿）
npm run check:vendor   # vendor 与工作树的**版本 + 内容级 sha256** 一致性（迁移包不在时 SKIP；见 §5）
```

`test-launcher.mjs` 用**随机端口 + 临时 profile**，不碰 3080/3081 与真 profile，也不写注册表（自启只做只读校验），
因此可以在任何机器上重复跑。

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

## 4. CLI 入口

`package.json` 的 `bin` 暴露三个命令（`exports` 同时放行 `./bin/*` 供程序化调用）：

| 命令 | 文件 | 用途 |
|---|---|---|
| `dsh-pm-launcher` | `bin/open-boot.mjs` | 3081 网页启动器 + 常驻守护（`--supervise`/`--ensure`/`--autostart-status`/`--install-autostart`） |
| `dsh-pm-boot` | `bin/dsh-boot.mjs` | 启动序列：verify → fix → 拉起引擎 → 健康等待（`--repair-only`） |
| `dsh-pm-rescue` | `bin/rescue-daemon.mjs` | 独立救砖守护（verify/fix/start/stop/status API） |

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

# 3) 版本号：在**一次性目录里**把 package.json 的 version 改成 0.8.3（仓库里的 0.9.0 不动）
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

> 参考数值（本机实测，仓库当前 0.9.0 的 bundle 与基线 0.8.3-1 的 bundle 对比）：
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
| 仓库 `package.json` 的 version | 仍为 **0.9.0**（未被派生打包影响 ✓） |
