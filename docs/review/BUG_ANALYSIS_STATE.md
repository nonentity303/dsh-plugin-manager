# 状态流分析：`setEnabled` 快照刷新链路 — UI 崩坏根因

## 一、状态流链路（Host → Client）

### 1. Host 端 `setEnabled` 流程

**入口**: `lib/index.js:1040-1051`

```
setEnabled(entryId, enabled=false)
  └─ this.serialize()                          // 串行化锁，防并发写
       ├─ this.project(entry)                  // 投影：得到 entry 快照副本
       ├─ this.change(projected, false)        // ↓ change()
       │    ├─ writeDesiredState(YAML)         // 写入 disabled=true
       │    ├─ waitFor(entry.entryId, false)   // 轮询直到 entry.disabled === true
       │    └─ return { status: "changed" }
       └─ return { enabled: false, items: [...], snapshot: this.snapshot() }
                                                            ↑ 全量快照
```

### 2. `change()` / `waitFor()` 时序

**关键文件**: `lib/index.js:1848-1886, 1901-1911`

| 步骤 | 时间线 | fiber.state | entry.disabled | snapshot.enabled | snapshot.phase |
|------|--------|-------------|----------------|------------------|----------------|
| 初始 | t=0 | 2 (active) | false/undefined | true | active |
| YAML 写完 | t≈0ms | 2 (active) | — | — | — |
| Cordis 处理 | t≈1~5ms | 2→5→? | **true** ← waitFor 条件满足 | false | active (或 unloading) |
| waitFor 返回 | t≈5ms | 可能仍为 2 | true | false | phase 可能未变 |
| snapshot() 调用 | t≈5ms | — | — | **false** | 取决于 fiber 是否已卸载 |

**重点**: `waitFor` 只检查 `(entry.disabled ?? false) !== enabled`，不关心 fiber state。因此 `waitFor` 在 `disabled` flag 变更后立即返回，但 fiber 可能仍处于 `state=2 (active)`。此时 snapshot 中的 `enabled=false` 但 `phase="active"`，说明模块仍在内存中运行。

### 3. Remote 协议契约

**关键文件**: `lib/remote.js:311-336`

```javascript
// setEnabled 不在 SNAPSHOT_RESULT_METHODS 中！
SNAPSHOT_RESULT_METHODS = new Set(["list", "refresh", "getSources", "setSources", "resetToggles", "setRescueConfig"])
RECEIPT_RESULT_METHODS  = new Set(["setEnabled", "quarantine", "uninstallPackages", "update"])

// 返回值类型
const receipt = z.object({
    enabled: z.boolean(),    // true/false
    items: z.array(mutationItem),  // [{ entryId, status: "changed", message }]
    snapshot                 // 完整 PluginManagerSnapshot
})
```

客户端收到的响应结构: `{ enabled: false, items: [{status: "changed"}], snapshot: { profileName, entries: [...], sources: [...] } }`

## 二、Client 端触发与传导

### 1. 状态更新路径

**关键文件**: `src/client.jsx:134-150, 154-160, 77-91`

```javascript
// toggle → run → setState (line 154)
toggle(entry)
  └─ run(`entry:${entry.entryId}`, () => setEnabled(entry.entryId, !entry.enabled))
       ├─ setBusy(key)                    // line 135: UI 显示加载态
       ├─ const result = await operation() // RPC call to host
       ├─ const snapshot = result?.snapshot ?? result  // line 141: 提取 snapshot
       ├─ setState({ status: "ready", snapshot })      // line 142: ⚠️ 替换整个 state 对象
       └─ setBusy(null)                   // line 148: 清除 busy

// sections useMemo (line 77-91)
const sections = useMemo(() => {
    if (state.status !== "ready") return [];
    const filtered = state.snapshot.entries.filter(...)       // 按搜索/来源过滤
    return NECESSITY_ORDER.map((key) => ({                  // [core, recommended, optional]
        key,
        entries: filtered.filter((entry) => entry.necessity === key)
    })).filter(section => section.entries.length > 0)
}, [query, originFilter, state])     // ← 依赖整个 state 引用!
```

### 2. 状态传导链

```
用户点击 toggle
  → setEnabled RPC (异步, 数 ms 到数百 ms)
  → 返回 receipt { enabled, items, snapshot }
  → setState({ status: "ready", snapshot: NEW_OBJECT })   // ⚠️ 新对象引用
  → React 检测到 state 引用变化
  → 全部 useEffect/useMemo 重新计算:
      • sections (line 77-91)          ← 分组重组
      • cardForEntry (line 108-127)    ← 卡片映射重建
      • updatable (line 129-132)       ← 可更新列表
      • originCounts (line 94-103)     ← 来源统计
  → 完整 JSX re-render
```

## 三、导致 UI 崩坏的精确定位

### Bug #1: 分组 DOM 元素重排 → 滚动位置丢失

**位置**: `src/client.jsx:442-630`（sections 渲染循环）

```jsx
{sections.map((section) => {
    // section div 没有 stable key！React 使用 index 作为隐式 key
    return (
        <section key={section.key} style={{ ... }}>  {/* key="core"|"recommended"|"optional" */}
            {isOpen ? (
                <ul>
                    {section.entries.map((entry) => (
                        <li key={entry.entryId}>...</li>  {/* key 稳定 ✓ */}
                    ))}
                </ul>
            ) : null}
        </section>
    );
})}
```

**问题场景**:
- 禁用一个 mod 后，如果该 mod 是某必要程度分组的**最后一个条目**（过滤后为空），该 `<section>` 被删除
- 其余 section 的 DOM 元素**位置改变**，由于 key 基于 `section.key`（字符串常量 "core"/"recommended"/"optional"），React 需要移动或删除 DOM 节点
- 即使条数不变，entries 数组引用全新创建 → React 可能认为子树发生变化
- **结果**: 浏览器滚动位置重置或跳变

### Bug #2: ConfigCardBoundary 组件卸载/重挂载

**位置**: `src/client.jsx:634-657, 1197-1218`

```jsx
{(configCards ?? []).length > 0 ? (
    <section ...>
        {showConfigCards ? configCards.map((card) => (
            <ConfigCardBoundary key={card.id} card={card}>...</ConfigCardBoundary>
        )) : null}
    </section>
) : null}
```

**联动效应**:
- `cardForEntry` Map（line 108-127）在每次 `state` 变化时完全重建
- 当被禁用的 entry 有对应 config card 时，`cardForEntry` 失去该 entry 的映射
- 更重要的是：**DSh settings shell 的 `configCards` prop 可能也随 mod 卸载而变化**
- `ConfigCardBoundary` 及其内部的第三方 `ConfigCardInner(card.render())` 被卸载
- 第三方卡片可能有自己的 cleanup/unmount handler，可能与 DSH 设置系统交互，产生级联副作用

### Bug #3: `setState` 总是创建新对象引用

**位置**: `src/client.jsx:142`

```javascript
setState({ status: "ready", snapshot });
```

每次 toggle 都创建全新的 state 对象（即使内容相同）。所有依赖 `[state]` 的 `useMemo` 都会重新计算：
- `sections` (line 91): `[query, originFilter, state]` → **每次都重新算**
- `updatable` (line 132): `[state]`
- `originCounts` (line 103): `[state]`
- `cardForEntry` (line 127): `[configCards, state]`

**影响**: 不仅仅是视觉重渲染——这些 memo 内部创建的中间对象（如 `cardForEntry` 这个新的 Map）在每次 render 都是全新的，导致 downstream 组件接收到的 props 引用不断变化。

### Bug #4: 排序顺序可能导致条目跨组

**位置**: `lib/index.js:1783-1787` + `client.jsx:87-90`

```javascript
// Host 排序 (index.js:1783-1787):
entries.sort((left, right) => {
    const order = { core: 0, recommended: 1, optional: 2 };
    const diff = (order[left.necessity] ?? 1) - (order[right.necessity] ?? 1);
    return diff !== 0 ? diff : left.configId.localeCompare(right.configId);
});

// Client 分组 (client.jsx:87-90):
NECESSITY_ORDER.map((key) => ({
    key,
    entries: filtered.filter((entry) => entry.necessity === key)
}))
```

`necessity` 从 `project()` 方法获取，由 `NECESSITY[configId]` 决定（固定值）。因此 disable 操作不会改变条目的 necessity。**此项不是直接原因**，但如果其他操作（如 install/remove mod）改变了 entries 集合，排序稳定性取决于 `configId`。

## 四、根因总结

### 核心根因

**禁用 mod 后，host 返回全量快照，client 使用新 state 引用替换旧引用，触发 React 完整子树重渲染和 DOM 重组。关键问题在于：**

1. **DOM 层级重排**：sections 的数量/顺序可能变化，每个 section 包含多个 entries；当 entries 数组整体替换时，React 通过 `entry.entryId` key 做 diff，但**外层 section 的 key 是字符串常量**（"core"/"recommended"/"optional"），如果某个 section 的 entries 数量显著减少甚至消失，React 会删除并重排 DOM 子树

2. **ConfigCardBoundary 卸载**：被禁用的 mod 对应的 config card 可能随之卸载，触发自定义 cleanup 逻辑，可能与 DSH 全局状态机交互

3. **无增量状态更新**：整个 `state` 对象被替换，而非对 entries 做 patch/delta 合并。这意味着所有 `useMemo` 计算结果都被丢弃重建

4. **scroll 容器行为**：DSh settings shell 的设置面板通常是一个固定高度的 scrollable 容器。当内容高度突变（某些卡片卸载 + entries 重排），浏览器重新计算 layout，可能触发 scroll-to-top 或 scroll-position jump

### 为什么"禁用功能正常"

`waitFor` 确保 `entry.disabled === true` 后才返回，YAML 持久化正确完成。Cordis 后续异步处理 fiber 生命周期。开关本身的读写是正确的，UI 只是**视觉表现**出问题。

## 五、修复建议

### 建议 A: 避免全量 state 替换（推荐）

```javascript
// client.jsx 修改：用 delta 代替全量快照
// 方案 1: 只更新变化的 entries
const run = async (key, operation) => {
    setBusy(key);
    try {
        const result = await operation();
        const snapshot = result?.snapshot ?? result;
        setState(prev => {
            // 用新 entries 替换现有 entries（保持同一引用更稳定）
            return {
                ...prev,
                snapshot: {
                    ...prev.snapshot,
                    entries: snapshot.entries  // 只换 entries，profileName/sources 不变
                }
            };
        });
        return result;
    } catch (error) { /* ... */ }
};
```

### 建议 B: 给 section 添加 stable key + 防止空组移除

```jsx
// client.jsx:443 修改
<section key={`section-${section.key}`} style={{ ... }}
         data-section={section.key}>
```

并在 sections 过滤前保留空组的占位标记，防止整节 DOM 消失。或者使用 CSS transition + will-change 平滑过渡。

### 建议 C: 延迟 ConfigCardBoundary 卸载

对于匹配了 config card 的 entry，即使用户禁用该 mod，也不要立即卸载对应的 `ConfigCardBoundary`。可以将 `cardForEntry` 的缓存延长到下一个 render 周期，或在 entry 从 entries 中移除时保留卡片实例一段时间。

### 建议 D: 最小化 useMemo 依赖

将 `sections` 的依赖从 `[query, originFilter, state]` 改为精确依赖：
```javascript
}, [query, originFilter, state.snapshot.entries]);
```

这样只有在 entries 数组本身变化时才重新计算，而不是每次 state 引用变化就重新计算。

### 建议 E（最简修复）: 在 run() 中对 state 做浅比较

```javascript
const run = async (key, operation) => {
    setBusy(key);
    try {
        const result = await operation();
        const snapshot = result?.snapshot ?? result;
        // 只在快照真正不同时才更新
        if (snapshot !== state.snapshot) {
            setState({ status: "ready", snapshot });
        }
        return result;
    } catch { /* ... */ } finally { setBusy(null); }
};
```

**优先级**: A > E > C > B > D

其中 **A（增量更新）** 和 **E（浅比较跳过无变化更新）** 能同时解决大部分问题，且改动最小。

---

*分析完成 by bugfinder-b · 基于 lib/index.js, lib/remote.js, src/client.jsx 源码*
