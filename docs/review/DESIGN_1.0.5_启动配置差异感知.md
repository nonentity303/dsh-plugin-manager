# 1.0.5 设计草案 — 启动配置差异感知（体验优化小版本）

> 状态：草案（待 1.0.4 反馈收集后再排期实现）
> 定位：**体验优化升级**，不加新依赖、不改信任模型，目标是消灭「重启后插件莫名其妙没了/多了」这类静默行为。

## 1. 背景：1.0.4 实测案例还原（2026-11-27）

3080/3081 共用 `~/.dsh/profiles/web` 一个 profile。用户在 3081 管理台禁用
`dsh-plugin-wallpaper-engine`（= 从 `package.json` 的 `dsh.profile.bundles` 移除）后：

1. 15:42:43 open-boot supervisor 自动重启 3080 引擎——此刻 bundles 里没有 wallpaper，
   **禁用态被这次重启固化**，3080 起来后 wallpaper 消失；
2. 用户在 3081 重新启用（bundles 加回），但引擎已在运行、不热挂载；
3. 手动重启 3080 后 wallpaper 才恢复。

三个事实叠加造成困惑：

- **共用 profile**：3080/3081 任一管理台的开关操作写的是同一份文件；
- **引擎只在启动时读配置**：`dsh` 引擎 lib 中没有任何 `fs.watch`/`watchFile`/`chokidar`，
  bundle 挂载由 `profile-boot` 在启动时一次性解析；
- **无变更来源提示**：重启前没人告诉你「配置和上次启动不一样了」。

## 2. 目标与非目标

**目标**

- G1 引擎（重新）启动前，能发现「本次配置 ≠ 上次成功启动的配置」并明确告警，区分变更来源；
- G2 管理台开关操作在共用 profile 场景下，提示影响所有引擎；
- G3 全部离线可测，零新依赖。

**非目标**

- 不做引擎热加载（那是引擎侧的大改，不属于 drydock 范围）；
- 不引入日志数据库（见 §6）；
- 不改变安装/卸载/开关的现有语义与 UI 结构。

## 3. 方案 A：per-engine 启动快照 + 启动前 diff（G1，核心）

### 3.1 落盘格式

```jsonc
// .plugin-manager/boot-snapshot.json —— 原子写（tmp + rename）
{
  "v": 1,
  "engines": {
    "3080": {
      "at": "2026-11-27T07:42:43.000Z",   // 该引擎上次成功启动时间
      "pid": 10440,
      "bundles": ["@angelky7/dsh-browser-control", "...", "dsh-plugin-wallpaper-engine"],
      "deps": { "dsh-drydock": "1.0.4", "dsh-plugin-wallpaper-engine": "1.4.3" },
      "patchRows": 1                       // cordis.patch.yml 顶层条目数
    },
    "3081": { "..." : "同结构" }
  }
}
```

**必须按 engine 分键**：3080/3081 共用 profile，快照互相覆盖会让 diff 全是噪音。
engine 身份用端口（open-boot supervisor 与 rescue-daemon 都已知自己的端口）。

### 3.2 写入与读取

- **写**：引擎成功启动（健康探测通过）后，supervisor/rescue-daemon 写快照；
- **读**：下次拉起引擎前 diff「当前 package.json + patch 行数」vs 快照 →
  `added / removed / version-changed / patch-changed`；
- 首次启动无快照 → 只写不比；快照损坏/写一半 → 视为无快照重建，
  **快照自身的问题永不拦启动**。

### 3.3 告警呈现

- 3081 兜底页与 supervisor 日志：差异列表（谁加了、谁少了、版本变化）；
- 兜底页加一行「与上次启动相比的配置变更」，带时间戳。

## 4. 方案 B：history 交叉核对定性质（G1 的一半）

diff 出差异后，**顺手**查 `plugin-manager.json` 的 `history`（现成 sidecar，不加新文件）：

| 交叉结果 | 定性 | 提示语气 |
| --- | --- | --- |
| 有对应 `setEnabled` / `uninstall` 记录 | 用户经管理台操作 | 「上次管理台操作后未重启，本次启动已按该状态加载」（复现 wallpaper 案例） |
| 无任何记录 | 未经管理台的变更（CLI / 手工 / 其他工具） | 「配置变更未经过插件管理器，请确认来源」 |

- history **只做定性，不当数据源**：`dsh plugin add`（引擎 CLI）、手跑 pnpm、
  直接编辑 package.json 都不经过 history——快照 diff 才是全量的；
- 匹配规则：按 `packageName` + 时间窗（快照时间之后、本次启动之前的最近一条）。

## 5. 方案 C/D：跨引擎提示与预检集成点（G2）

- **C** `setEnabled` / `uninstallPackages` 等写配置操作的返回里，
  当检测到同 profile 存在多个引擎实例时（读 `.open-boot.pid` / 快照 engines 键），
  提示语从「重启后生效」升级为「所有使用此 profile 的引擎（3080、3081）都需重启」；
- **D** supervisor 拉起引擎前跑 §3 的 diff（`preflight.mjs` 的
  `resolveBundleExportsPatch` 现成可用），diff 非空 → 日志 + 兜底页可见，**不拦启动**。

## 6. 明确不做：日志数据库

- 启动差异需要的是「上次启动的地面真值」，不是「全部操作历史」；
  历史回放要处理撤销/隔离/失败分支，且覆盖不了绕过 drydock 的变更；
- 操作量是人肉量级（每天几条），现有 history sidecar 已有上限与 undo 机制；
- 零依赖文件 sidecar 是本包一贯原则，SQLite 是引依赖 + 引损坏风险 + 引迁移负担。

## 7. 实现量预估

| 模块 | 行数 | 位置 |
| --- | --- | --- |
| 快照读写（原子写、v1 校验、per-engine 键） | ~60 | `lib/boot-snapshot.mjs`（新） |
| diff + 告警文案（含 history 匹配） | ~110 | `lib/preflight.mjs` 扩展 + supervisor 接入 |
| 跨引擎重启提示 | ~30 | `lib/index.js` 各写操作返回处 |
| 离线测试（快照 roundtrip、diff 三分支、history 命中/不命中、损坏容错） | ~150 | `test-boot-diff.mjs`（新） |

## 8. 节奏

1. **先收 1.0.4 反馈**（npm / GitHub issue / 3080 使用观察），本草案不排期实现；
2. 反馈里出现同类「静默变更」案例 → 优先级上调，按 §3→§4→§5 顺序实现为 1.0.5；
3. 1.0.5 = 体验优化小版本（patch 级变更量，minor 号只为本方案留位），不捆绑其他特性。
