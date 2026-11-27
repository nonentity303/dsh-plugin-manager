<!--
  这个模板是「影响面 + 证据」两张表。填不出来的那一项，就是你还没想清楚的地方 —— 别删。
  流程与红线见 .github/CONTRIBUTING.md；版本/通道口径见 docs/版本与轨道.md。
-->

## 这个 PR 做了什么

<!-- 一到三句；如果是修 bug，写清"原来的错误行为 → 现在的行为" -->

## 影响面（必填）

- **目标通道**：`web` / `desktop` / `community`（由版本号的预发布标识决定，见 `release/channels.json`）
- **web 影响面**：无 / 具体说明（涉及 `lib/index.js`、`lib/enginectl.mjs`、`bin/open-boot.mjs`、`bin/rescue-daemon.mjs`、`bin/dsh-boot.mjs`、`src/client.jsx` 的改动**必须**写）
- **污染预算**：热文件改动统计（如 `lib/index.js +12/−0`）。单项超过 **+80/−20** 时在此说明理由，并打 `desktop-change` 标签
- **是否改动了客户端源码**（`src/client.jsx` / `build.mjs`）：是 / 否 —— **构建产物 `lib/client.js` 不入库**，改源码后不要提交产物

## 测试证据（贴命令 + 结果，不要只写"已测"）

- [ ] `node test-isolation.mjs`（host 侧 import 契约 + 污染预算）
- [ ] `node test-channels.mjs`（通道配置 ↔ CI ↔ 文档一致性）
- [ ] `node test-docs.mjs`
- [ ] `npm test`（含 `node build.mjs` 构建；沙箱里 esbuild 会 EPERM，需在正常权限下跑）
- [ ] 涉及启动器/救援链：`node test-launcher.mjs --strict`
- [ ] 涉及下载/更新：`node test-downloader.mjs` + `node test-security-provenance.mjs`

## 发布说明

- [ ] `docs/releases/<版本>.md` 已写（版本号与 `package.json` 一致）
- [ ] `node tools/dev/gen-changelog.mjs --check` exit 0
- [ ] 若改了通道/发布流程：`docs/版本与轨道.md` 与 `docs/RELEASING.md` 已同步

## 回滚

<!-- 这个改动出问题怎么退：revert 本 commit 是否安全？是否留下不可逆的外部状态（tag / npm 版本 / 注册表键 / 文件系统改动）？ -->
