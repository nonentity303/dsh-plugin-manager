# 发布清单 · dsh-plugin-manager-pro 1.0.0-rc.2（2026-11-24）

> **口径来源**：[RELEASING.md](RELEASING.md) 是唯一发布口径，本文不改口径，只是"这一次"的可勾选清单 + 当日实测快照。
> **目标**：以 **dist-tag `next`** 发到 npm，`latest` 保持 **0.9.1** 不动。
> **用法**：从上往下勾；每一项都要有"实测命令 + 结果"，不接受"应该没问题"。

---

## 0. 当日实测快照（2026-11-24 18:20–18:45，全部可复跑）

| 检查项 | 实测值 / 证据 | 结论 |
| --- | --- | --- |
| 工作副本版本 | `package.json` → `1.0.0-rc.2` | ✅ |
| npm 现状 | `npm view dsh-plugin-manager-pro version dist-tags` → `latest: 0.9.1`、`next: 0.9.1-rc2` | ℹ️ 本次应把 `next` 指到 1.0.0-rc.2 |
| 构建可复现 | `node build.mjs` 连跑两次，`lib/client.js` 均 `4C28D1E6A06293E6AE16FE4E09F29C17F6114815FB4B1A4EE4CA395C64B8884E` / **797,750 B** | ✅ |
| test-bundle | 11 条断言全过，exit 0 | ✅ |
| test-render | 18 × `RESULT: PASS`、0 × FAIL | ✅ |
| test-integration | `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-home-paths`（本机 `node_modules` 里该 devDependency 缺失） | ❌ **阻塞**——`npm ci` 后重跑 |
| test-launcher | **354/354**（`DSH_HOME` 指向临时目录，真实 `~/.dsh/scripts/dsh-launcher.cmd` mtime 未变） | ✅ |
| smoke-plugins-api | **28/28 OK**（端口 3093 + 临时 profile/home，全程隔离） | ✅ |
| `docs/releases/1.0.0-rc.2.md` | 不存在（`docs/releases/` 里最新是 `0.9.1.md`） | ❌ **阻塞**（RELEASING §1：缺发布说明不算可发布） |
| CHANGELOG | 顶部是 `[Unreleased]`，**没有** `1.0.0-rc.1 / rc.2` 条目（它是 `docs/releases/*.md` 的生成物） | ❌ 随上一条 |
| `package-lock.json` | 根 `version` 仍是 **0.9.0**（rc.1/rc.2 都没同步） | ⚠️ 待同步 |
| 现有 tgz | `dsh-plugin-manager-pro-1.0.0-rc.2.tgz`（18:00:39）里的 `package/README.md` **还是 rc.1 文案** | ❌ 必须重新 `npm pack` |
| tgz 内容 | 20 件：4 个 `bin/*` + 2 个 `lib/*.mjs` + 9 个 `lib/*.js` + `package.json` / `LICENSE` / `README.md` / `README.en.md` / `cordis.patch.yml`；**无** `.map` / `docs/` / `tools/` / `test-*` / `src/` | ✅ |
| git 工作区 | 分支 `1.0.0-rc.1`；11 个已跟踪文件有改动（其中 5 个是本次文档：`README.md` / `README.en.md` / `docs/README.md` / `docs/RELEASING.md` / `docs/LAUNCHER.md`）+ 未跟踪 `docs/README-full.md`、`docs/发布清单-rc2.md`（需 `git add` 才会进仓库） | ⚠️ |

> 复跑（PowerShell，隔离 DSH_HOME）：
>
> ```powershell
> cd E:\harness\安装收纳\plugins\plugin-manager
> $env:DSH_HOME = "E:\harness\.tmp-release-prep\dsh-home"   # 任意临时目录
> node build.mjs; node test-bundle.mjs; node test-render.mjs; node test-launcher.mjs
> Remove-Item Env:DSH_HOME
> node tools/smoke-plugins-api.mjs
> ```

---

## 1. 冻结与存档

- [ ] 确认此刻没人在改 `src/client.jsx` / `bin/open-boot.mjs`（它们变了就必须重跑 §3 全套）。⚠️ **本次核对期间就观察到 `src/client.jsx` 被并发改动**（18:22:29 → 18:23:36，151,652 → 153,642 B），所以 §0 的哈希/项数都绑定"当时那棵树"，冻结前必须重新取数
- [ ] 文档定稿：`README.md`、`docs/README.md`、`docs/README-full.md`、`README.en.md`、本清单（本次已修一批，见 §11）
- [ ] `git diff --stat` 逐文件复核；工作区快照另存：`git diff > E:\harness\__rc2-$(Get-Date -f yyyyMMdd-HHmm).diff`（**本次不 commit**，由发布负责人决定提交/打 tag）
- [ ] 决定分支口径：当前分支名 `1.0.0-rc.1`，发 rc.2 前要么改名要么新建分支（tag `v1.0.0-rc.2` 必须与发布 commit 对应）

## 2. 依赖树：发布的字节 = 测过的字节（RELEASING §2bis）

- [ ] `Remove-Item node_modules -Recurse -Force; npm ci`（**必须用 lockfile**，不要用 pnpm 树）
- [ ] **确认 `node_modules/@deepseek-ai/dsh-home-paths` 存在** ← 本次实测就是它缺了，`test-integration` 才挂的
- [ ] `node build.mjs` 两次，`lib/client.js` 哈希一致（基线见 §0，取自 `src/client.jsx` = 153,642 B 那次；若与基线不同，先查 zod 解析——历史上 pnpm/npm 树差 194 KB，再查源码是否又改过）
- [ ] `npm run check:vendor`（迁移包 vendor 不在时会 SKIP，属正常）

## 3. 测试：全绿才算过

| 命令 | 期望 | 本次 |
| --- | --- | --- |
| `node build.mjs` | 退出 0，哈希稳定 | ✅ |
| `node test-bundle.mjs` | 11/11 | ✅ |
| `node test-render.mjs` | 18 PASS / 0 FAIL | ✅ |
| `node test-integration.mjs` | 退出 0 | ❌ 依赖缺失（见 §2） |
| `node test-launcher.mjs` | 354/354 | ✅ |
| `node test-launcher.mjs --strict` | 354/354（无 xfail） | 未跑：沙箱内注册表/管道类断言会 SKIP，需在**沙箱外**复跑 |
| `node tools/smoke-plugins-api.mjs` | 28/28 | ✅ |
| `npm run check:vendor` | exit 0 或 SKIP | 未跑 |

- [ ] 上表全部 ✅（含 `--strict` 在沙箱外复跑）

## 4. 版本与元数据

- [ ] `version` = `1.0.0-rc.2`（唯一来源；构建产物不写版本号）
- [ ] **`docs/releases/1.0.0-rc.2.md` 写好**（阻塞项）。最小骨架：
  - 一句话：rc.2 = 事务卸载 + 更新检查 + 体检 API + `/plugins` 双主题重做 + enginectl 端口透传修复
  - `### Added`：`/plugins/api/{updates,update,uninstall,health}`、兜底页双主题/扁平设计、管理器自禁用/自卸载路径、救援球拖动
  - `### Changed`：标题「引擎与插件管理台」、3080 页面工具栏收编搜索框、市场详情从行内改为带关键词跳市场
  - `### Fixed`：`startEngine` 未透传 `--port`（引擎默认 3080 → 与启动器探测端口不一致，`EADDRINUSE`/假健康）、smoke 的 `AbortError` 误判"已下线"、`friendlyError` 的 EBUSY 人话
  - `### Known issues`：见 §10
- [ ] `node tools/dev/gen-changelog.mjs` 重生成 CHANGELOG，再 `--check` 通过
- [ ] `engines.dsh` / `peerDependencies` 区间没被误改：`>=0.1.7-rc.2 <0.3.0-0`
- [ ] `files` 白名单仍只有 6 条（`lib/*.js`、`lib/*.mjs`、`bin`、`cordis.patch.yml`、`README.md`、`LICENSE`）——**不要**为体积改回 `"lib"`
- [ ] `package-lock.json` 根 `version` 与 `package.json` 对齐（`npm install --package-lock-only`），**并且在 build 之前做**（lock 变了可能换解析树）
- [ ] `description` 文案：现在写的是"独立救砖工具链（**3081** rescue-daemon …）"，而 rescue-daemon 默认已改 **3082** → 建议改成 3082 或去掉端口号（此改动会让 tgz 字节变化，确认后与 §5 一起重打包）
- [ ] CHANGELOG 里不能出现"已发布/已上线"这类时态错误（生成物只写事实）

## 5. 打包

- [ ] `npm run pack`（= `node build.mjs && npm pack`）
- [ ] 新 tgz 的 mtime **晚于** §1 的文档改动（现有那个 18:00 的包内含 rc.1 文案，已作废）
- [ ] `tar -tzf dsh-plugin-manager-pro-1.0.0-rc.2.tgz`：20 件、含 4 个 `bin/*` 与 `enginectl.mjs`/`preflight.mjs`、无 `client.js.map`
- [ ] `tar -xOf dsh-plugin-manager-pro-1.0.0-rc.2.tgz package/README.md | Select-Object -First 3` → 必须是 `v1.0.0-rc.2` 文案
- [ ] 记录 tgz 的 SHA256（`Get-FileHash`），写进发布说明或本清单备注

## 6. npm 登录态与 2FA

- [ ] `npm run preflight`：`whoami`、版本是否已被占用、2FA 能力、tarball 必备文件/体积红线（任一 FAIL 直接中止）
- [ ] `whoami` 通过 ≠ 能发布：以真实发布结果为准（RELEASING §4.5）
- [ ] 401 时改**项目级** `.npmrc`（用户级旧 token 是最常见原因）
- [ ] token 无 Bypass 2FA 时：`--otp <6 位>`

## 7. 发布（dist-tag 必须是 next）

```powershell
npm run preflight
npm run test
npm run publish:npm                        # 预演：npm publish --dry-run（默认仍是 latest，只看不写）
npm run publish:npm:apply -- --tag next    # ⚠️ 真发，必须显式 --tag next
```

- [ ] **绝不能用默认 `latest`**——那会把 0.9.1 顶掉（用户群里装 0.9.1 的环境会变成 rc）
- [ ] 发布后：`npm view dsh-plugin-manager-pro dist-tags` → `latest: 0.9.1`、`next: 1.0.0-rc.2`
- [ ] git 侧：`git tag v1.0.0-rc.2` + push（**需用户明确确认**；RELEASING §10 ⑤）
- [ ] GitHub Release 附 tgz（可选，但仓库惯例是附）

## 8. 回滚方案（发之前先认下来）

npm 上的版本**不可删除、不可覆盖**，所以"回滚"只有三种形态：

1. **改指向**：`npm dist-tag add dsh-plugin-manager-pro@0.9.1 next`（把 `next` 指回旧版；`latest` 本来就没动过）
2. **撤回提示**：`npm deprecate dsh-plugin-manager-pro@1.0.0-rc.2 "rc 撤回：请用 0.9.1"`（已用显式版本号装过的环境仍然能装到，所以必须配合通知用户）
3. **再发一个补丁号**（如 `1.0.0-rc.3`）——**不要删版本重发**

用户侧回滚：

```powershell
dsh plugin --profile web add dsh-plugin-manager-pro@0.9.1   # 显式版本号
# 重启引擎生效
```

- [ ] 浏览器主页仍是 3081：**即使管理器 UI 全坏，兜底页/救援页依然可用**（这是本版最大的保险）
- [ ] 启动器回滚：`npx dsh-pm-launcher --uninstall --profile <profile>` 清掉自启/守护/shim/pid 后再装旧版
- [ ] 卸载/更新的写前备份位置：profile 的 `package.json` 滚动备份 + `cordis.patch.yml.uninstall-bak-<时间戳>`
- [ ] 工作区 diff 已存盘（见 §1）——回滚代码时不会丢今天的改动

## 9. 发布后验证（URL / 命令，逐条留证据）

**registry 侧**

- [ ] `npm view dsh-plugin-manager-pro version dist-tags` → `1.0.0-rc.2` / `next: 1.0.0-rc.2` / `latest: 0.9.1`
- [ ] <https://www.npmjs.com/package/dsh-plugin-manager-pro/v/1.0.0-rc.2> 页面能打开，README 是 rc.2 文案
- [ ] `npm view dsh-plugin-manager-pro@1.0.0-rc.2 dist.tarball` → 下载后 SHA256 与 §5 记录一致

**隔离环境装机**（不碰真机 3080/3081；做法见 SESSION_SUMMARY「测试引擎验证方法」）

```powershell
$env:DSH_HOME = "E:\harness\.dsh-test-rc2"
dsh plugin --profile web add dsh-plugin-manager-pro@1.0.0-rc.2
# 引擎用 13080、启动器用 13081（DSH_ENGINE_PORT / DSH_LAUNCHER_PORT）
```

- [ ] `http://127.0.0.1:13081/api/status` → `version: "1.0.0-rc.2"`、`pluginsPage: "/plugins"`
- [ ] `http://127.0.0.1:13081/plugins` → 200，HTML 含 `name="dsh-pm-token"`、标题「引擎与插件管理台」
- [ ] `http://127.0.0.1:13081/rescue` → 200
- [ ] 从 `<DSH_HOME>/logs/web.log` 首行取 `?token=` 入口，打开 13080 → 侧边栏出现「插件管理」
- [ ] **真跑三条**（smoke 不覆盖，见 §10 ③）：`/plugins/api/health` 出一份 verdict、`/plugins/api/updates` 列出可更新、一次真实事务性卸载（挑一个可重装的插件）
- [ ] 兜底页主题按钮：点击切深浅、长按 0.6 秒复位为"自动"；救援球拖动后刷新位置保持

## 10. 已知遗留（写进发布说明，不阻塞本次发布）

| # | 遗留 | 影响 / 现状 |
| --- | --- | --- |
| ① | `dsh-boot` 的弹窗启动路径**不落 `web.log`**（token URL 抓不到；`enginectl` 路径正常） | 3081 页可能给不出可直接跳转的入口 URL；已在 README「救援流程」写明绕法（`/rescue` 重启引擎） |
| ② | `test-launcher.mjs` 会重写真实 `~/.dsh/scripts/dsh-launcher.cmd` | 用 `DSH_HOME=<临时目录>` 隔离即可（本次实测 354/354 且真实文件 mtime 未变）；根治需给测试夹具强制隔离 `DSH_HOME` |
| ③ | smoke **未覆盖**卸载/更新真跑 | 目前靠 `--strict` + 手工真跑补；发布后验证 §9 最后一条必须做 |
| ④ | `RescuePanel` 的「🩺 mod 体检」只是**跳转入口**（3080 跨源读 3081 未开 CORS） | 点它跳到 `127.0.0.1:3081/plugins#health`；要内嵌需给 3081 放行 3080 的 CORS |
| ⑤ | 生成物里版本号**写死 `1.0.0-rc.1`**（`<DSH_HOME>/scripts/dsh-launcher.cmd` / `.ps1` 头注释，`bin/open-boot.mjs` 第 1718/1740 行） | 仅注释文字，不影响功能；建议后续改用 `readVersion()`（本次按红线不改 .mjs 代码） |

## 11. 本次一致性扫描（`git grep` 全仓，2026-11-24）

| 扫描项 | 命中 | 处置 |
| --- | --- | --- |
| 旧品牌词「鲸坞」 | **0 命中**（工作树 + `git log -S` 全历史均 0） | 无残留，无需处理 |
| rc.1 版本文案（面向用户） | `README.md` 第 3 行 1 处 | ✅ 已改 rc.2 |
| `1.0.0-rc.1` 特性标记注释 | `bin/open-boot.mjs` 5 处注释 + 2 处生成物字符串、`lib/enginectl.mjs` 3 处、`test-launcher.mjs` 1 处、`tools/smoke-plugins-api.mjs` 1 处 | 注释部分是历史特性标签，**保留**；生成物字符串见下一行 |
| 生成物头注释写死 rc.1 | `bin/open-boot.mjs:1718`、`:1740` | ⚠️ 见 §10 ⑤ |
| 「当前已发布版本 0.9.0」 | `docs/README.md` | ✅ 已改 0.9.1 并标注 rc 发布说明待补 |
| 「当前版本 0.9.1」 | `docs/RELEASING.md:32` | ✅ 已改 1.0.0-rc.2 |
| 归档全文未标归档 | `docs/README-full.md`、`README.en.md` | ✅ 已加"归档提示"块 |
| 裸相对路径 `node bin/...` | `README.md`（RELEASING §4 明文禁止） | ✅ 已改 `npx dsh-pm-launcher --uninstall --profile <profile>` |
| 旧端口事实 | `package.json` 的 `description` 写"3081 rescue-daemon"（实际默认 3082） | ⚠️ 见 §4 最后一条（待决定是否改，改则重打包） |
| 文档漏 rc.2 新路由 | `docs/LAUNCHER.md` §2 端口表与 §4 写接口表都没有 `/plugins` 与 `/plugins/api/*` | ✅ 已补（含 409 单飞口径：只有 `engine/restart` 与 `/api/boot` 共用闸门） |
| 已废弃路由名 | 无（`/rescue`、`/plugins`、`/api/*` 与实现一致） | 无 |

---

> 本清单与 [RELEASING.md](RELEASING.md) 冲突时，**以 RELEASING.md 为准**；本文的实测数字只在 2026-11-24 这一天的这一个工作区成立，复跑前请重新取数。
