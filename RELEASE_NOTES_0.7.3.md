# dsh-plugin-manager-pro v0.7.3

> 0.7.2 的补丁：滚动恢复增加 `requestAnimationFrame` 存在性守卫（修复非浏览器环境/VM 测试崩溃）。

## 🐛 修复

- `src/client.jsx`：`run()` 的滚动恢复改为 `restoreScroll()` 辅助函数，对 `requestAnimationFrame` / `window.scrollTo` 做 `typeof` 守卫——浏览器行为不变，SSR/VM sandbox 不再 ReferenceError

## 📦 安装

```sh
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.7.3.tgz
dsh web
```

## 🧪 验证

- `node build.mjs` ✓；`node test-bundle.mjs` 11 项契约全绿 ✓
