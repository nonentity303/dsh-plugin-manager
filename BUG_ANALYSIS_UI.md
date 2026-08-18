# UI Bug 根因分析：禁用 Mod 时页面崩坏/重置到右上角

## 现象

在插件管理页（PluginManagerTab）中，点击开关**禁用一个 mod** 时：
- **设置画面崩坏**：页面布局异常（可能是错位、重叠或元素消失）
- **管理器页面重置到右上角**：滚动位置回到顶部/左上角
- **禁用功能本身正常**：`setEnabled` 调用成功，状态正确写入并生效

## 触发链路

### 1. 用户操作入口
- **文件**: `src/client.jsx`，行 584-622
- 用户点击自定义 toggle 开关（label 包裹的隐藏 checkbox + span 模拟 UI）
- `onChange={() => toggle(entry)}` → 行 599

### 2. toggle 调用链
- **文件**: `src/client.jsx`，行 154-160
```js
const toggle = (entry) => run(`entry:${entry.entryId}`, () => setEnabled(entry.entryId, !entry.enabled)).then((receipt) => { ... });
```

### 3. run() 内部流程
- **文件**: `src/client.jsx`，行 134-150
```js
const run = async (key, operation) => {
    setBusy(key);                          // 行 135: 设置 busy，UI 显示 loading
    setFeedback(null);                     // 行 136: 清除旧反馈
    try {
        const result = await operation();  // 行 138: 异步调用 setEnabled（远程调用，可能 ~30s 超时）
        const snapshot = result?.snapshot ?? result;
        setState({ status: "ready", snapshot }); // 行 142: ⚡ 关键 — 更新 state 触发重渲染
        return result;
    } catch (error) { ... }
    finally { setBusy(null); }             // 行 148: 清除 busy
};
```

### 4. 重渲染影响
- **文件**: `src/client.jsx`，行 77-91 — `sections` useMemo 重新计算
- **文件**: `src/client.jsx`，行 283-659 — 整个 PluginManagerTab JSX 重新渲染
- **文件**: `src/client.jsx`，行 443-630 — sections 列表逐项重新渲染

## 根因分析

### 根因一：无滚动位置保存机制（导致"重置到右上角"）

**核心问题**：`PluginManagerTab` 组件没有任何滚动位置保存/恢复逻辑。

当 `setState({ status: "ready", snapshot })` 触发重渲染后：
1. 整个 `<section>` 容器（行 284）被 React 重新渲染
2. 父级设置面板（shell 注入的 settings.plugins.tab）可能是一个可滚动的容器
3. 子组件重渲染不直接导致父容器滚动重置——但以下情况会：
   - 如果重渲染触发了 DOM 结构变化（如某个 entry 的 section 折叠状态变化），父容器可能需要重新计算布局
   - 如果 `feedback` 消息区域（行 412-432）出现新内容，DOM 高度变化可能导致父容器滚动调整

**关键证据**：
- 行 49: `const [open, setOpen] = useState(new Set(["core"]))` — 折叠状态独立管理
- 行 447: `const isOpen = searching || open.has(section.key)` — 搜索时强制展开
- 行 142: `setState({ status: "ready", snapshot })` — 每次操作后全量更新 state
- **无任何 `scrollTop` 保存/恢复代码**

**最可能的机制**：父级 shell 的设置面板在子 tab 内容变化时，没有保持滚动锚点。React 的 `setState` 触发完整重渲染，父容器的滚动行为取决于 shell 实现。

### 根因二：Set 对象引用问题（潜在布局崩坏因素）

**文件**: `src/client.jsx`，行 49
```js
const [open, setOpen] = useState(new Set(["core"]));
```

虽然 `setOpen` 使用函数式更新（行 258-263）创建新 Set，这本身是安全的。但有一个微妙问题：

**行 266-267**:
```js
const expandAll = () => setOpen(new Set(NECESSITY_ORDER));
const collapseAll = () => setOpen(new Set());
```

这些操作创建全新的 Set 引用。在正常使用中没问题，但如果 `open` Set 和某些派生值之间的同步有竞态条件，可能导致部分 section 的 `isOpen` 判断不一致。

### 根因三：feedback 区域突变导致布局抖动

**文件**: `src/client.jsx`，行 412-432

toggle 成功后，如果 receipt 中有 failed/restart 信息，`setFeedback` 会插入新的内容块。这个 feedback 区域位于：
- 搜索框（行 370-390）和来源筛选（行 393-407）**之后**
- 折叠分组按钮（行 435-440）**之前**
- 插件列表（行 442-631）**之前**

feedback 区域的突然插入/移除会导致下方所有插件列表发生**垂直位移**，这在视觉上表现为"布局崩坏"。

### 根因四：无虚拟化的全量渲染（性能相关，非直接根因）

行 488-625：每个 entry 都渲染为独立的 `<li>`，没有虚拟化。当条目数量很大时（165+ 包），重渲染开销大，但不会直接导致布局崩坏。

## 修复建议

### 修复 1：保存并恢复滚动位置（解决"重置到右上角"）

在 `run()` 函数中，操作前后保存/恢复滚动位置：

```js
const run = async (key, operation) => {
    // 保存当前滚动位置
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    
    setBusy(key);
    setFeedback(null);
    try {
        const result = await operation();
        const snapshot = result?.snapshot ?? result;
        setState({ status: "ready", snapshot });
        // 恢复滚动位置
        window.scrollTo(0, scrollY);
        return result;
    } catch (error) {
        setFeedback({ severity: "error", message: error instanceof Error ? error.message : String(error) });
        window.scrollTo(0, scrollY);
        return null;
    } finally {
        setBusy(null);
    }
};
```

或者更精细地，只保存/恢复 PluginManagerTab 所在容器的滚动位置（如果能通过 ref 访问的话）。

### 修复 2：最小化重渲染范围

将 `sections` 的计算从 `state` 全量依赖改为更细粒度的依赖：

```js
// 当前（行 77-91）：依赖整个 state 对象
const sections = useMemo(() => { ... }, [query, originFilter, state]);

// 建议：只依赖 entries 数组的引用
const entries = state.status === "ready" ? state.snapshot.entries : [];
const sections = useMemo(() => { ... }, [query, originFilter, entries]);
```

但这需要确保 `entries` 在数据不变时引用稳定。

### 修复 3：使用 ref 锁定焦点/滚动容器

给主列表容器添加 `ref`，在状态更新后手动恢复：

```jsx
const listRef = useRef(null);

useEffect(() => {
    if (listRef.current) {
        listRef.current.scrollTop = savedScrollPos;
    }
}, [state]); // 仅在 state 变化时执行
```

### 修复 4（推荐组合方案）

1. **首要修复**：在 `run()` 中保存/恢复 `window.scrollY`（最简单有效）
2. **次要修复**：将 feedback 区域的插入改为占位符动画，避免布局抖动
3. **可选优化**：给 sections 列表添加 `ref`，用 `scrollTo` 精确恢复而非全局滚动

## 补充说明

- **React Key 检查**：section key=`section.key`（稳定："core"/"recommended"/"optional"），entry key=`entry.entryId`（应为稳定 ID）。Key 不是问题。
- **错误边界**：`TabBoundary`（行 663-681）和 `ConfigCardBoundary`（行 1197-1218）能捕获渲染异常，但不会阻止滚动重置。
- **disabled 功能正常**确认了后端 `setEnabled` 调用无误，问题纯在 UI 层。
