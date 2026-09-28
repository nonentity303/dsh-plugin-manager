# dsh-plugin-manager-pro v0.7.2

> 修复：禁用 mod 时设置画面崩坏/页面重置（陈年 UI bug）+ 启动器 stdio 崩溃。

## 🐛 修复

1. **UI：禁用 mod 后画面崩坏、页面重置到右上角**（陈年 bug，禁用功能本身正常）
   - 根因（双路分析确认，见 `BUG_ANALYSIS_UI.md` / `BUG_ANALYSIS_STATE.md`）：
     - `run()` 更新快照触发全量重渲染后**无滚动位置保存/恢复** → 页面跳回顶部
     - `useMemo` 全依赖 `state` 引用 → 每次操作全量重算分组/统计/卡片映射
   - 修复（`src/client.jsx`，最小侵入）：
     - `run()` 操作前保存 `window.scrollY`，`setState` 后与 `catch` 中用 `requestAnimationFrame` 恢复滚动位置（带 `typeof` 守卫，SSR 安全）
     - `sections` / `originCounts` / `cardForEntry` / `updatable` 的 `useMemo` 依赖从 `[state]` 收紧为 `[state.snapshot?.entries]`
   - 不改变：禁用功能、折叠/分组/搜索、ConfigCardBoundary 生命周期

2. **启动器 stdio 崩溃**（`lib/enginectl.mjs`）：`spawn` 的 `stdio` 传 `WriteStream` 对象（fd 为 null）导致 `The argument 'stdio' is invalid`、引擎无法拉起
   - 修复：改用 `openSync()` 数字 fd（`stdio: ["ignore", fd, fd]`），已实测 spawn 成功

## 📦 安装

```sh
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.7.2.tgz
dsh web
```

## 🧪 验证

- `node test-bundle.mjs` 11 项契约检查全绿 ✓
- `node --check` 全部 JS 文件 ✓
- spawn fd 最小实测（exit 0，日志正常写入）✓
- 修复经 4 成员团队（千问 qwen3.6/3.7-flash、deepseek-v4-flash、硅基 V3.2）双路根因分析 + 实施 + 独立审查闭环 ✓
