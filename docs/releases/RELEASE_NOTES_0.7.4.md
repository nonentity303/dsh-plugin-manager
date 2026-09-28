# dsh-plugin-manager-pro v0.7.4

> 启动专项检查修复：preflight verify 识别"已被 patch 隔离"的坏 bundle，不再误报。

## 🐛 修复

- `lib/preflight.mjs`：`verifyProfile` 现在会读取 cordis.patch.yml 中 `disabled: true` 的条目，**已被隔离的 bundle 不再算作问题**
  - 背景：`fixProfile` 隔离坏 bundle 的方式是写 patch `{id, name, disabled: true}`（loader 会跳过，引擎可正常启动），但 verify 仍按"bundle 不可解析"报错 → 造成 verify/fix 循环误报、`dsh-boot --repair-only` 误判退出码 2
  - 修复后：fix → 再 verify 返回 `ok: true`（实测通过）

## ✅ 启动专项检查（0.7.3 全项复查）

- 语法：全部 lib/bin JS 文件 `node --check` 通过
- 契约：`test-bundle.mjs` 11 项全绿
- fixProfile 写盘安全（临时副本实测）：patch YAML 合法、`{id,name,disabled:true}` + OWNER_MARKER、package.json 未被改动
- **启动链路实测**：引擎停止后经 open-boot（3081）拉起成功（stdio fd 修复生效）

## 📦 安装

```sh
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.7.4.tgz
dsh web
```
