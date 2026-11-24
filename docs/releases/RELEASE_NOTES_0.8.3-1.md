# v0.8.3.1 发布说明

> 版本：dsh-plugin-manager-pro 0.8.3.1 · 2026-09-28

本版是**为 DSH 引擎 0.1.7-rc.2 升级做的兼容性修复**，不含新功能，因此只打第四位版本号。

## 修复

1. **Typert strict codec 契约变更（引擎 0.1.7+ 必备）**
   - 现象：在 0.1.7-rc.2 引擎上启动报
     `typert-loader: dsh-plugin-manager-pro invocation "dsh-plugin-manager-pro#pluginManagerPro/list" result codec has no create() factory`，
     插件管理器整体不激活，设置页与插件列表全部消失。
   - 原因：0.1.7 起 `dsh-typert-loader` 要求 strict codec 提供零参、返回 zod schema 的 **`create` 工厂**，不再读取旧的 `schema` 字段（`dsh-api-gateway` 的调用点从 `codec.schema.parse(v)` 改为 `codec.create().parse(v)`）。
   - 修复：`lib/remote.js` 的 `strict()` 改为**双写** `schema` + `create: () => schema`。
     两代引擎的校验器都只做正向字段断言、不拒绝多余字段，因此同一份产物可同时用于 0.1.1-rc.2 与 0.1.7-rc.2。

2. **客户端 inject 指向已删除的包**
   - `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-runtime` 在 0.1.7 已被拆解删除，改为官方 1:1 继任者 **`@deepseek-ai/dsh-client-ui-renderer`**（`slots` / `SlotRegistry` 的新提供者）。
   - 说明：声明本身不会报错（新加载器对未知 inject 名静默跳过），改它是为了让客户端启动图的排序边正确、并消除 0.1.7 上的无谓告警。

## 验证

- `node build.mjs` ✅　`node test-bundle.mjs` ✅（契约测试全绿）
- 引擎 0.1.1-rc.2：profile boot 无告警（改动向后兼容）
- 引擎 0.1.7-rc.2（隔离彩排环境 `upgrade-rehearsal/`）：**零条目失败**
- typert 工件判据：31 个调用点 / 52 个 codec 全部满足 0.1.7 的 `create()` 要求

## 升级路径

引擎从 0.1.1-rc.2 升到 0.1.7-rc.2 时，本版是**必需项**。完整升级方案见工作区 `dev-docs/引擎升级方案-0.1.7.md`。
