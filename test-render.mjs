// test-render.mjs — 在 jsdom 中真实渲染 PluginManagerTab，复现「搜索 + 点开关」交互
// 用法: node test-render.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";

const require = createRequire(import.meta.url);

// ---- 1. jsdom 环境
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://127.0.0.1:3080/" });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.CSS = dom.window.CSS;

// ---- 2. 通过 __ModuleLoader__ 契约加载打包后的 client bundle
let handoff = null;
const sandbox = {
	window: {
		__ModuleLoader__: {
			load: (h) => {
				handoff = h;
			}
		},
		navigator: { language: "en-US" }
	},
	console,
	URL,
	setTimeout,
	clearTimeout
};
vm.createContext(sandbox);
const code = readFileSync("lib/client.js", "utf8");
vm.runInContext(code, sandbox, { filename: "lib/client.js" });
if (!handoff) throw new Error("bundle did not register");
const exportsObj = handoff.factory((id) => require(id));
const { PluginManagerTab, marketFilterItems, shouldDebounceSearch, SEARCH_DEBOUNCE_MS } = exportsObj;
if (typeof PluginManagerTab !== "function") throw new Error("no PluginManagerTab export");
if (typeof marketFilterItems !== "function") throw new Error("no marketFilterItems export");
if (typeof shouldDebounceSearch !== "function") throw new Error("no shouldDebounceSearch export (P-05)");

// ---- 2b. P-05：搜索防抖的纯函数语义（可证伪：修复前没有「输入值 ≠ 生效过滤值」这个概念，
//          过滤在每次 onChange 同步执行；现在必须由 shouldDebounceSearch 决定是否起定时器）
{
	const cases = [
		{ query: "theme", filterQuery: "", want: true, why: "刚输入、过滤值还没跟上 → 必须起防抖定时器" },
		{ query: "theme", filterQuery: "theme", want: false, why: "过滤值已跟上 → 不再起定时器（不做多余重建）" },
		{ query: "", filterQuery: "theme", want: true, why: "清空搜索（本项最贵：199 行重建）→ 同样走防抖等停顿" },
		{ query: "", filterQuery: "", want: false, why: "初始态一致 → 不起定时器" }
	];
	for (const c of cases) {
		const got = shouldDebounceSearch(c.query, c.filterQuery);
		if (got !== c.want) throw new Error(`P-05 shouldDebounceSearch(${JSON.stringify(c.query)}, ${JSON.stringify(c.filterQuery)}) = ${got}，期望 ${c.want}（${c.why}）`);
	}
	if (!(SEARCH_DEBOUNCE_MS >= 100 && SEARCH_DEBOUNCE_MS <= 150)) {
		throw new Error(`P-05 防抖窗口不在审计建议的 100–150 ms 区间：${SEARCH_DEBOUNCE_MS}`);
	}
	console.log(`RESULT: PASS - P-05 search debounce pure logic (${cases.length} cases, window ${SEARCH_DEBOUNCE_MS}ms)`);
}

// ---- 3. 构造一个真实感 snapshot（覆盖 needsUpdate/managed/protected 各状态；e1/e2 架构自带，e3-e6 用户安装）
const entries = [
	{ entryId: "e1", configId: "agent", moduleName: "@deepseek-ai/dsh-agent", packageName: "@deepseek-ai/dsh-agent", description: "Agent 核心", necessity: "core", enabled: true, phase: "active", error: null, protected: true, protectionReason: "必需", archived: false, origin: "builtin", installedVersion: "0.1.0-rc.6", latestVersion: "0.1.0-rc.6", updateSource: "官方源 (npm)", needsUpdate: false, managed: false },
	{ entryId: "e2", configId: "ui-theme", moduleName: "@deepseek-ai/dsh-client-ui-theme", packageName: "@deepseek-ai/dsh-client-ui-theme", description: "主题", necessity: "recommended", enabled: true, phase: "active", error: null, protected: false, protectionReason: null, archived: false, origin: "builtin", installedVersion: "0.1.0-rc.6", latestVersion: "0.1.0-rc.9", updateSource: "官方源 (npm)", needsUpdate: true, managed: false },
	{ entryId: "e3", configId: "community-mod", moduleName: "community-mod", packageName: "community-mod", description: "社区插件", necessity: "optional", enabled: false, phase: null, error: null, protected: false, protectionReason: null, archived: false, origin: "user", installedVersion: "1.0.0", latestVersion: "1.2.0", updateSource: "官方源 (npm)", needsUpdate: true, managed: true },
	{ entryId: "e4", configId: "broken-mod", moduleName: "broken-mod", packageName: "broken-mod", description: "坏插件", necessity: "recommended", enabled: false, phase: "failed", error: "boom", protected: false, protectionReason: null, archived: false, origin: "user", installedVersion: "1.0.0", latestVersion: "1.0.0", updateSource: "官方源 (npm)", needsUpdate: false, managed: true },
	{ entryId: "e5", configId: "pkg-no-version", moduleName: "pkg-no-version", packageName: "pkg-no-version", description: "无版本", necessity: "optional", enabled: true, phase: "active", error: null, protected: false, protectionReason: null, archived: false, origin: "user", installedVersion: "0.1.0", latestVersion: null, updateSource: null, updateReason: "not-found", needsUpdate: null, managed: true },
	{ entryId: "e6", configId: "vision-router", moduleName: "dsh-vision-router", packageName: "dsh-vision-router", description: "视觉路由（自带配置）", necessity: "optional", enabled: true, phase: "active", error: null, protected: false, protectionReason: null, archived: false, origin: "user", installedVersion: "1.3.0", latestVersion: null, updateSource: null, updateReason: "network", needsUpdate: null, managed: true }
];
const makeSnapshot = (entriesMut) => ({
	profileName: "web",
	entries: entriesMut ?? entries,
	sources: [
		{ name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, type: "registry" },
		{ name: "GitHub 官方仓库", url: "https://github.com/deepseek-ai/deepseek-harness", enabled: true, official: true, type: "github" },
		{ name: "npmmirror 镜像", url: "https://registry.npmmirror.com", enabled: false, official: false, type: "registry" }
	]
});

// ---- 4. 渲染并模拟交互
const root = createRoot(document.getElementById("root"));
const calls = { list: 0, setEnabled: 0, update: 0, refresh: 0, setSources: 0 };
const api = {
	list: async () => {
		calls.list++;
		return makeSnapshot();
	},
	refresh: async () => {
		calls.refresh++;
		return makeSnapshot();
	},
	setEnabled: async (entryId, enabled) => {
		calls.setEnabled++;
		// 模拟成功收据：entries 中该行 enabled 翻转
		const next = entries.map((e) => (e.entryId === entryId ? { ...e, enabled } : e));
		return { enabled, items: [{ entryId, status: "changed", message: null }], snapshot: makeSnapshot(next) };
	},
	update: async (names) => {
		calls.update++;
		return { items: names.map((n) => ({ packageName: n, status: "updated", message: "ok", installedVersion: "1.2.0", latestVersion: "1.2.0" })), snapshot: makeSnapshot() };
	},
	setSources: async (sources) => {
		calls.setSources++;
		return makeSnapshot();
	}
};
const t = (k) => k;

let renderError = null;
try {
	await act(async () => {
		root.render(React.createElement(PluginManagerTab, { ...api, t }));
	});
	console.log("initial render OK; list calls:", calls.list);

	// 来源筛选：用户安装 chips（展开 recommended/optional 后断言）
	const rootEl = document.getElementById("root");
	const findBtnByText = (text) => Array.from(rootEl.querySelectorAll("button")).find((b) => b.textContent.includes(text));
	const findHeader = (text) => Array.from(rootEl.querySelectorAll("header")).find((h) => h.textContent.startsWith(text));
	const originUserChip = findBtnByText("originUser");
	if (!originUserChip) throw new Error("origin user chip not found");
	await act(async () => {
		originUserChip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	if (rootEl.textContent.includes("agent")) throw new Error("builtin entry still visible after originUser filter");
	await act(async () => {
		findHeader("necessityRecommended").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		findHeader("necessityOptional").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	const textAfterUser = rootEl.textContent;
	if (!textAfterUser.includes("broken-mod") || !textAfterUser.includes("community-mod")) {
		throw new Error("user entries missing after originUser filter: " + textAfterUser.slice(0, 300));
	}
	if (!textAfterUser.includes("originUser")) throw new Error("user badge not rendered on rows");
	// 架构自带
	await act(async () => {
		findBtnByText("originBuiltin").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	const textAfterBuiltin = rootEl.textContent;
	if (!textAfterBuiltin.includes("agent") || textAfterBuiltin.includes("community-mod")) {
		throw new Error("builtin filter wrong: " + textAfterBuiltin.slice(0, 300));
	}
	// 全部
	await act(async () => {
		findBtnByText("originAll").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	if (!rootEl.textContent.includes("community-mod")) throw new Error("originAll reset failed");
	console.log("RESULT: PASS - origin filter (user/builtin/all) + user badges");

	// C-09 文案（弱网）：版本未知必须区分「网络不可达，可重试」(e6 updateReason=network)
	// 与「源里没有此插件/无更新」(e5 updateReason=not-found)，不能再一律显示「版本未知」
	if (!rootEl.textContent.includes("versionNetworkError")) throw new Error("network-reason version hint missing (C-09): " + rootEl.textContent.slice(0, 300));
	if (!rootEl.textContent.includes("versionNotFound")) throw new Error("not-found version hint missing (C-09)");
	console.log("RESULT: PASS - C-09 version hints (network / not-found) rendered distinctly");

	// 搜索
	// 注意（P-05）：这里**不能**用 jsdom 驱动文本输入做行为断言 —— 实测 React 18.3.1 + jsdom 24
	// 不投递 input/change 事件（onChange 永不触发；值跟踪器也已被直接赋值污染），
	// 因此「清空搜索每键延迟」只在真浏览器里测（audit/verify-090/rc2-perf-probe.mjs --section browser）。
	// 防抖逻辑本身用纯函数断言（见下方 P-05 段）。
	const searchInput = document.querySelector('input[type="search"]');
	if (!searchInput) throw new Error("search input not found");
	await act(async () => {
		searchInput.value = "theme";
		searchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	console.log("search render OK（jsdom 不投递 input 事件，行为断言见纯函数段）");

	// 点开关（搜索过滤后可见的行）
	const checkbox = document.querySelector('input[type="checkbox"]');
	if (!checkbox) throw new Error("no checkbox found");
	await act(async () => {
		checkbox.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	console.log("toggle render OK; setEnabled calls:", calls.setEnabled);
} catch (error) {
	renderError = error;
	console.error("RENDER/INTERACTION ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

if (!renderError) {
	console.log("RESULT: PASS - search + toggle interaction renders without error");
}

// ---- 5. 失败路径：setEnabled 抛错 -> 应显示错误反馈而非崩溃
const root2 = document.createElement("div");
document.body.appendChild(root2);
const root2Instance = createRoot(root2);
const apiFail = {
	...api,
	setEnabled: async () => {
		throw new Error("host refused");
	}
};
let failError = null;
try {
	await act(async () => {
		root2Instance.render(React.createElement(PluginManagerTab, { ...apiFail, t }));
	});
	await act(async () => {
		const checkbox = document.querySelector('#root + div input[type="checkbox"]') ?? root2.querySelector('input[type="checkbox"]');
		if (!checkbox) throw new Error("no checkbox in fail instance");
		checkbox.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	// 等待异步错误反馈渲染
	await new Promise((resolve) => setTimeout(resolve, 50));
	await act(async () => {});
	const alertText = root2.textContent;
	if (!alertText.includes("host refused")) throw new Error("failure feedback not rendered: " + alertText);
	console.log("RESULT: PASS - setEnabled failure shows feedback without crashing");
} catch (error) {
	failError = error;
	console.error("FAILURE-PATH ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

// ---- 6. 受保护行的开关应 disabled
if (!failError) {
	const protectedCheckbox = root2.querySelector('input[type="checkbox"]');
	const firstRowProtected = entries[0].protected;
	if (firstRowProtected && !protectedCheckbox.disabled) {
		console.error("FAIL: protected entry toggle should be disabled");
		process.exitCode = 1;
	} else {
		console.log("RESULT: PASS - protected entry toggle is disabled");
	}
}

// ---- 7. 插件市场：目录加载失败 -> 显示错误 + 重试按钮（先于成功用例，确保模块缓存未命中）
const marketCatalogFixture = {
	source: "live",
	updated: "2025-06-01",
	count: 3,
	categories: { market: { zh: "市场", en: "Market" }, theme: { zh: "主题", en: "Theme" }, utility: { zh: "工具", en: "Utility" } },
	items: [
		{ name: "dsh-market", owner: "dsh-market", url: "https://github.com/dsh-market/dsh-market", npm: "dshmarket", category: "market", description: { zh: "可视化插件市场", en: "Visual plugin market" }, stars: 128, added: "2025-05-01" },
		{ name: "dsh-theme-zen", owner: "zen", url: "https://github.com/zen/dsh-theme-zen", npm: "dsh-theme-zen", category: "theme", description: { en: "A calm theme" }, stars: 5, added: "2025-06-01" },
		{ name: "community-mod", owner: "comm", url: "https://github.com/comm/community-mod", npm: "community-mod", category: "utility", description: { en: "Community module" }, stars: 42, added: "2024-01-01" }
	]
};
const findButton = (container, text) => {
	for (const btn of container.querySelectorAll("button")) {
		if (btn.textContent.trim() === text) return btn;
	}
	return null;
};
const settle = async (ms = 30) => {
	await new Promise((resolve) => setTimeout(resolve, ms));
	await act(async () => {});
};

const root3 = document.createElement("div");
document.body.appendChild(root3);
const root3Instance = createRoot(root3);
let marketError = null;
try {
	const apiFailCatalog = {
		...api,
		marketCatalog: async () => {
			throw new Error("offline");
		},
		marketInstall: async () => ({ status: "failed", packageName: null, url: null, method: null, message: "n/a" })
	};
	await act(async () => {
		root3Instance.render(React.createElement(PluginManagerTab, { ...apiFailCatalog, t }));
	});
	await settle();
	const marketBtn = findButton(root3, "market");
	if (!marketBtn) throw new Error("market section button not found");
	await act(async () => {
		marketBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(50);
	const text3 = root3.textContent;
	if (!text3.includes("marketLoadFail") || !text3.includes("offline")) {
		throw new Error("market load failure feedback not rendered: " + text3.slice(0, 300));
	}
	console.log("RESULT: PASS - market catalog failure shows error + retry");
} catch (error) {
	marketError = error;
	console.error("MARKET FAILURE-PATH ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

// ---- 8. 插件市场：目录渲染 / 搜索过滤 / 分类 chips / 已装徽标 / 两步安装
const root4 = document.createElement("div");
document.body.appendChild(root4);
const root4Instance = createRoot(root4);
const marketCalls = [];
let marketError2 = null;
try {
	const apiMarket = {
		...api,
		marketCatalog: async () => marketCatalogFixture,
		marketInstall: async (target, dryRun) => {
			marketCalls.push({ target, dryRun });
			return { status: "installed", packageName: target.npm ?? target.name, url: target.url, method: target.npm ? "npm" : "github", message: "installed ok" };
		}
	};
	await act(async () => {
		root4Instance.render(React.createElement(PluginManagerTab, { ...apiMarket, t }));
	});
	await settle();
	await act(async () => {
		findButton(root4, "market").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(60);

	const text = () => root4.textContent;
	// 目录条目渲染（含本地化描述 en）
	if (!text().includes("dsh-market") || !text().includes("Visual plugin market")) {
		throw new Error("catalog items not rendered: " + text().slice(0, 400));
	}
	// community-mod 已装（entries 里有 packageName=community-mod）-> 徽标
	if (!text().includes("marketInstalledBadge")) {
		throw new Error("installed badge missing: " + text().slice(0, 400));
	}
	console.log("RESULT: PASS - catalog renders with installed badge");

	// 搜索/分类/排序为纯函数（jsdom 无法可靠模拟 React 受控 input 事件，逻辑直测）
	const filter = (q, cat, sort) => marketFilterItems(marketCatalogFixture, q, cat, sort).map((i) => i.name);
	const byStars = filter("", "all", "stars");
	if (JSON.stringify(byStars) !== JSON.stringify(["dsh-market", "community-mod", "dsh-theme-zen"])) {
		throw new Error("sort by stars wrong: " + JSON.stringify(byStars));
	}
	const byAdded = filter("", "all", "added");
	if (JSON.stringify(byAdded) !== JSON.stringify(["dsh-theme-zen", "dsh-market", "community-mod"])) {
		throw new Error("sort by added wrong: " + JSON.stringify(byAdded));
	}
	const byZen = filter("zen", "all", "stars");
	if (JSON.stringify(byZen) !== JSON.stringify(["dsh-theme-zen"])) {
		throw new Error("search by name wrong: " + JSON.stringify(byZen));
	}
	const byNpm = filter("dshmarket", "all", "stars");
	if (JSON.stringify(byNpm) !== JSON.stringify(["dsh-market"])) {
		throw new Error("search by npm name wrong: " + JSON.stringify(byNpm));
	}
	const byDesc = filter("calm", "all", "stars");
	if (JSON.stringify(byDesc) !== JSON.stringify(["dsh-theme-zen"])) {
		throw new Error("search by description wrong: " + JSON.stringify(byDesc));
	}
	const byCat = filter("", "market", "stars");
	if (JSON.stringify(byCat) !== JSON.stringify(["dsh-market"])) {
		throw new Error("category filter wrong: " + JSON.stringify(byCat));
	}
	console.log("RESULT: PASS - filter/sort pure functions (search/category/stars/added)");

	// 分类 chips（click 可驱动）
	await act(async () => {
		findButton(root4, "Market").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	if (!text().includes("dsh-market") || text().includes("dsh-theme-zen")) {
		throw new Error("category chip filter failed: " + text().slice(0, 400));
	}
	await act(async () => {
		findButton(root4, "marketAll").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	if (!text().includes("dsh-theme-zen")) throw new Error("category reset failed");
	console.log("RESULT: PASS - category chips filter locally");

	// 两步安装：安装 -> 确认 -> 调 marketInstall -> 徽标出现
	await act(async () => {
		findButton(root4, "marketInstall").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	if (!text().includes("marketConfirmInstall")) throw new Error("confirm state not armed");
	await act(async () => {
		findButton(root4, "marketConfirmInstall").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(50);
	if (marketCalls.length !== 1) throw new Error(`marketInstall not called exactly once: ${marketCalls.length}`);
	if (marketCalls[0].target.npm !== "dshmarket" || marketCalls[0].dryRun !== false) {
		throw new Error("marketInstall target wrong: " + JSON.stringify(marketCalls[0]));
	}
	if (!text().includes("installed ok")) throw new Error("install feedback missing");
	const badgeCount = (text().match(/marketInstalledBadge/g) || []).length;
	if (badgeCount !== 2) throw new Error(`expected 2 installed badges, got ${badgeCount}`);
	console.log("RESULT: PASS - two-step install calls host and marks installed");
} catch (error) {
	marketError2 = error;
	console.error("MARKET RENDER ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

// ---- 9. 第三方配置出口（0.1.7：plugins.row.config / plugins.bundle.config）
//      验收点：只有**已注册**的键才产生按钮与出口；summary/page 走框架 renderSlot 三项签名；
//      未注册键既不渲染也不调用 renderSlot（stub 对未知键直接抛错）。
const root5 = document.createElement("div");
document.body.appendChild(root5);
const root5Instance = createRoot(root5);
let configCardsError = null;
try {
	const renderCalls = [];
	const renderSlotStub = (key, ownerProps, opts) => {
		renderCalls.push({ key, view: ownerProps?.view, entryKey: opts?.entryKey, only: opts?.only });
		if (key === "plugins.row.config" && opts?.entryKey === "dsh-vision-router#vision-router") {
			return ownerProps?.view === "summary"
				? React.createElement("span", null, "ROW-SUMMARY")
				: React.createElement("div", null, "ROW-PAGE");
		}
		if (key === "plugins.bundle.config" && opts?.entryKey === "dsh-vision-router") {
			return ownerProps?.view === "summary" ? null : React.createElement("div", null, "BUNDLE-PAGE");
		}
		throw new Error(`unregistered slot key rendered: ${key} entryKey=${opts?.entryKey}`);
	};
	const configSurfaces = (() => {
		// 与产品代码一样：getSnapshot 必须返回稳定引用，否则 useSyncExternalStore 会无限重渲染
		const snapshot = { rows: ["dsh-vision-router#vision-router"], bundles: ["dsh-vision-router"] };
		return { getSnapshot: () => snapshot, subscribe: () => () => {} };
	})();
	await act(async () => {
		root5Instance.render(React.createElement(PluginManagerTab, { ...api, t, renderSlot: renderSlotStub, configSurfaces }));
	});
	await settle();
	const text5 = () => root5.textContent;
	const optionalHeader5 = Array.from(root5.querySelectorAll("header")).find((h) => h.textContent.startsWith("necessityOptional"));
	if (!optionalHeader5) throw new Error("optional section header missing");
	await act(async () => {
		optionalHeader5.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	// 行内 summary（契约的 view:'summary'）+ 行内配置按钮
	if (!text5().includes("ROW-SUMMARY")) throw new Error("row summary (view:'summary') not rendered: " + text5().slice(0, 300));
	const rowConfigBtn = Array.from(root5.querySelectorAll("button")).find((b) => b.textContent.includes("configEntry"));
	if (!rowConfigBtn) throw new Error("row config button missing on dsh-vision-router row");
	const bundleConfigBtn = Array.from(root5.querySelectorAll("button")).find((b) => b.textContent.includes("configBundleEntry"));
	if (!bundleConfigBtn) throw new Error("bundle config button missing on dsh-vision-router row");
	// 未注册的插件（community-mod / pkg-no-version）不应有配置按钮：只允许 vision-router 这一行出现 2 个
	const configBtnCount = Array.from(root5.querySelectorAll("button")).filter((b) => /configEntry|configBundleEntry/.test(b.textContent)).length;
	if (configBtnCount !== 2) throw new Error(`expected exactly 2 config buttons (row+bundle on one entry), got ${configBtnCount}`);
	const rowsWithConfig = Array.from(root5.querySelectorAll("li")).filter((li) => /configEntry|configBundleEntry/.test(li.textContent));
	if (rowsWithConfig.length !== 1) throw new Error(`config buttons must be confined to the matched row, got ${rowsWithConfig.length} rows`);
	// 展开 page 视图：行配置按钮 -> ROW-PAGE；包配置按钮 -> BUNDLE-PAGE
	await act(async () => {
		rowConfigBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(30);
	if (!text5().includes("ROW-PAGE")) {
		throw new Error("row config page view not rendered: " + text5().slice(0, 400));
	}
	await act(async () => {
		bundleConfigBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(30);
	if (!text5().includes("BUNDLE-PAGE")) {
		throw new Error("bundle config page view not rendered: " + text5().slice(0, 400));
	}
	// 所有 renderSlot 调用都必须是「已声明 + 已注册」的那两个键
	const badCalls = renderCalls.filter((c) => !(
		(c.key === "plugins.row.config" && c.entryKey === "dsh-vision-router#vision-router") ||
		(c.key === "plugins.bundle.config" && c.entryKey === "dsh-vision-router")
	));
	if (badCalls.length > 0) throw new Error("unexpected renderSlot calls: " + JSON.stringify(badCalls));
	console.log("RESULT: PASS - third-party config outlets (row.config summary+page, bundle.config page, registered keys only)");

	// 降级：没有 renderSlot（设置页 tab 上下文）时不得出现任何配置按钮
	const root6 = document.createElement("div");
	document.body.appendChild(root6);
	const root6Instance = createRoot(root6);
	await act(async () => {
		root6Instance.render(React.createElement(PluginManagerTab, { ...api, t, configSurfaces }));
	});
	await settle();
	const header6 = Array.from(root6.querySelectorAll("header")).find((h) => h.textContent.startsWith("necessityOptional"));
	if (header6) {
		await act(async () => {
			header6.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		});
		await settle();
	}
	if (root6.textContent.includes("configEntry") || root6.textContent.includes("configBundleEntry")) {
		throw new Error("config buttons must not render without renderSlot: " + root6.textContent.slice(0, 300));
	}
	console.log("RESULT: PASS - no dead config buttons without renderSlot (settings-tab degradation)");
} catch (error) {
	configCardsError = error;
	console.error("CONFIG-OUTLET ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

// ---- 9b. configSurfacesFor 纯函数（键匹配规则，含未注册键与跨包误配）
try {
	const { configSurfacesFor } = exportsObj;
	if (typeof configSurfacesFor !== "function") throw new Error("configSurfacesFor not exported");
	const freeSearch = { packageName: "dsh-free-search", moduleName: "dsh-free-search", configId: "web-search-free" };
	const surfaces = { rows: ["dsh-free-search#web-search-free", "dsh-vision-router#vision-router"], bundles: ["dshmarket", "dsh-recall-plugin"] };
	const hit = configSurfacesFor(freeSearch, surfaces);
	if (hit.rows.length !== 1 || hit.rows[0].key !== "dsh-free-search#web-search-free" || hit.rows[0].rowId !== "web-search-free") {
		throw new Error("row key match wrong: " + JSON.stringify(hit));
	}
	if (hit.bundles.length !== 0) throw new Error("free-search must not match bundle keys: " + JSON.stringify(hit.bundles));
	const market = configSurfacesFor({ packageName: "dshmarket", moduleName: "dshmarket", configId: "dsh-market" }, surfaces);
	if (market.bundles.length !== 1 || market.bundles[0].key !== "dshmarket" || market.rows.length !== 0) {
		throw new Error("bundle key match wrong: " + JSON.stringify(market));
	}
	const recall = configSurfacesFor({ packageName: "dsh-recall-plugin", moduleName: "dsh-recall-plugin", configId: "recall" }, surfaces);
	if (recall.bundles.length !== 1 || recall.bundles[0].key !== "dsh-recall-plugin") throw new Error("recall bundle key wrong: " + JSON.stringify(recall));
	// 同一个包的多行 → 逐个列出（前缀匹配的语义：行属于包）
	const routers = configSurfacesFor({ packageName: "dsh-vision-router", moduleName: "dsh-vision-router", configId: "vision-router" }, surfaces);
	if (routers.rows.length !== 1 || routers.rows[0].rowId !== "vision-router") throw new Error("vision-router row key wrong: " + JSON.stringify(routers));
	// 未注册 / 无匹配 → 全空（不产生空白按钮）
	const none = configSurfacesFor({ packageName: "community-mod", moduleName: "community-mod", configId: "community-mod" }, surfaces);
	if (none.rows.length !== 0 || none.bundles.length !== 0) throw new Error("unmatched entry should have no outlets");
	if (configSurfacesFor(freeSearch, undefined).rows.length !== 0) throw new Error("undefined surfaces must degrade to empty");
	console.log("RESULT: PASS - configSurfacesFor key matching (row `pkg#rowId` / bundle `pkg`, no false hits)");
} catch (error) {
	configCardsError = error;
	console.error("CONFIG-SURFACES ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

// ---- 10. 官方内置（可选）子页：C4（无 renderSlot 不得留死按钮）+ C5（卡片一行说明走 view:'summary'）----
const root7 = document.createElement("div");
document.body.appendChild(root7);
const root7Instance = createRoot(root7);
let officialError = null;
try {
	const { OfficialPluginsPanel } = exportsObj;
	if (typeof OfficialPluginsPanel !== "function") throw new Error("OfficialPluginsPanel not exported");
	const officialApi = {
		listBundles: async () => [
			{ name: "@deepseek-ai/dsh-experimental-voice-input-bundle", version: "0.1.7-rc.2", description: "voice", enabled: false, installed: true, optional: true },
			{ name: "dsh-free-search", version: "0.4.39", description: "search", enabled: true, installed: true, optional: false }
		],
		listVersionExemptions: async () => ({ exemptions: {} }),
		setBundleEnabled: async () => ({ ok: true })
	};
	const itemSnapshot = null; // 占位（真正的 itemsSource 见下）
	const itemsSource = (() => {
		const snapshot = [{ id: "shell", label: "终端" }, { id: "web-search", label: "网页搜索" }];
		return { getSnapshot: () => snapshot, subscribe: () => () => {} };
	})();
	const renderCalls = [];
	const renderSlotStub = (key, ownerProps, opts) => {
		renderCalls.push({ key, view: ownerProps?.view, only: opts?.only });
		if (key !== "plugins.item") throw new Error("unexpected key in OfficialPluginsPanel: " + key);
		if (ownerProps?.view === "summary") return React.createElement("span", null, `ITEM-SUMMARY-${opts?.only}`);
		return React.createElement("div", null, `ITEM-PAGE-${opts?.only}`);
	};
	await act(async () => {
		root7Instance.render(React.createElement(OfficialPluginsPanel, { officialApi, itemsSource, renderSlot: renderSlotStub, t }));
	});
	await settle(60);
	const text7 = () => root7.textContent;
	if (!text7().includes("ITEM-SUMMARY-shell") || !text7().includes("ITEM-SUMMARY-web-search")) {
		throw new Error("official item summary (view:'summary') not rendered: " + text7().slice(0, 400));
	}
	const openBtn = Array.from(root7.querySelectorAll("button")).find((b) => b.textContent.trim() === "officialOpen");
	if (!openBtn) throw new Error("official item open button missing with renderSlot available");
	await act(async () => {
		openBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(30);
	if (!text7().includes("ITEM-PAGE-shell")) throw new Error("official item page view not rendered: " + text7().slice(0, 400));
	// 可选组合包 + 官方插件都渲染
	if (!text7().includes("语音输入") || !text7().includes("终端")) throw new Error("official bundle/item cards missing");
	// C4：没有 renderSlot（设置页 tab 上下文）→ 不得出现「打开配置页」死按钮，改为提示
	const root8 = document.createElement("div");
	document.body.appendChild(root8);
	const root8Instance = createRoot(root8);
	await act(async () => {
		root8Instance.render(React.createElement(OfficialPluginsPanel, { officialApi, itemsSource, t }));
	});
	await settle(60);
	if (root8.textContent.includes("officialOpen")) throw new Error("dead open button rendered without renderSlot");
	if (!root8.textContent.includes("configMainPageHint")) throw new Error("settings-tab hint missing: " + root8.textContent.slice(0, 300));
	console.log("RESULT: PASS - official panel (item summary/page via renderSlot, no dead button without it)");
} catch (error) {
	officialError = error;
	console.error("OFFICIAL PANEL ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

// ---- 11. 行内卸载按钮：用户安装行有「卸载」，架构自带行没有 ----
// root5 只展开了 optional 分组 => 可见用户行 e3/e5/e6（3 行），e4 在未展开的 recommended 分组
const uninstallBtnCount = (root5.textContent.match(/rescueUninstall/g) || []).length;
if (uninstallBtnCount !== 3) throw new Error(`expected 3 row uninstall buttons (visible user rows e3/e5/e6), got ${uninstallBtnCount}`);
const agentRow = Array.from(root5.querySelectorAll("li")).find((li) => li.textContent.includes("agent"));
if (agentRow !== undefined && agentRow.textContent.includes("rescueUninstall")) throw new Error("builtin row should not have uninstall button");
console.log("RESULT: PASS - row uninstall buttons (user entries only)");

// ---- 12. 卸载影响预览：P1-4 三类体检 + 结论行 + L9 自启清理报告 ----
//      验收点：预览顶部有结论行（safe/caution/risky + 一句理由）；三类检查按 severity 分级渲染；
//              isSelf 时提示「卸载前会清理开机自启」；卸载报告渲染 L9 清理结果（含失败/跳过）。
const root9 = document.createElement("div");
document.body.appendChild(root9);
const root9Instance = createRoot(root9);
let impactError = null;
const expandOptional = async (container) => {
	const header = Array.from(container.querySelectorAll("header")).find((h) => h.textContent.startsWith("necessityOptional"));
	if (header !== undefined) {
		await act(async () => {
			header.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		});
	}
};
const openUninstallFlow = async (container, rowText) => {
	const row = Array.from(container.querySelectorAll("li")).find((li) => li.textContent.includes(rowText));
	if (row === undefined) throw new Error(`uninstall row not found: ${rowText}`);
	const button = Array.from(row.querySelectorAll("button")).find((b) => b.textContent.includes("rescueUninstall"));
	if (button === undefined) throw new Error(`uninstall button not found in row: ${rowText}`);
	await act(async () => {
		button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(30);
};
try {
	const makePreview = (overrides) => ({
		packages: [{
			packageName: "community-mod", spec: "^1.0.0", inBundles: true, patchRows: 1,
			affectedEntries: [{ configId: "community-mod", moduleName: "community-mod", enabled: true }],
			dependents: [{ packageName: "dep-mod", type: "dependencies", spec: "^1.0.0" }],
			isSelf: false,
			checks: [
				{ id: "dependency-break", severity: "high", title: "dep-mod 依赖 community-mod", detail: "dep-mod 在 dependencies 里声明了 community-mod@^1.0.0。" },
				{ id: "patch-residue", severity: "warning", title: "patch 残留：insert: id=demo-row", detail: "cordis.patch.yml 里仍有与 community-mod 关联的条目。" },
				{ id: "duplicate-port", severity: "info", title: "重复端口：3081", detail: "卸载后仍有 other-mod 声明同一端口 3081。" }
			],
			verdict: "risky",
			verdictReason: "体检发现 1 项高风险、1 项提示、1 项信息：dep-mod 依赖 community-mod。",
			canUninstall: true,
			...overrides
		}]
	});
	// —— 12a. 三类体检 + 高风险结论行 ——
	let previewFor = makePreview({});
	let reportFor = null;
	const impactApi = {
		...api,
		uninstallPreview: async (names) => {
			if (names[0] !== previewFor.packages[0].packageName) throw new Error(`uninstallPreview called with ${JSON.stringify(names)}`);
			return previewFor;
		},
		uninstallPackages: async (names, options) => ({
			items: [{
				packageName: names[0], status: "removed", message: "已卸载，重启 profile 后生效。",
				affectedEntries: names, removedPatchRows: 1, dependentPackages: [], verifyOk: true, residuals: [], backupPath: "/tmp/backup.json",
				isSelf: false, autostartCleanup: null,
				...(reportFor ?? {})
			}],
			snapshot: makeSnapshot()
		})
	};
	await act(async () => {
		root9Instance.render(React.createElement(PluginManagerTab, { ...impactApi, t }));
	});
	await expandOptional(root9);
	await openUninstallFlow(root9, "community-mod");
	const verdictEl = root9.querySelector("[data-check-verdict]");
	if (verdictEl === null) throw new Error("verdict line not rendered: " + root9.textContent.slice(0, 300));
	if (verdictEl.getAttribute("data-check-verdict") !== "risky") throw new Error(`verdict attr wrong: ${verdictEl.getAttribute("data-check-verdict")}`);
	if (!verdictEl.textContent.includes("uninstallVerdictRisky")) throw new Error("verdict label (risky) not rendered: " + verdictEl.textContent);
	const reasonEl = root9.querySelector("[data-check-reason]");
	if (reasonEl === null || !reasonEl.textContent.includes("1 项高风险")) throw new Error("verdict reason not rendered: " + (reasonEl?.textContent ?? "null"));
	const checkRows = Array.from(root9.querySelectorAll("[data-check-id]"));
	if (checkRows.length !== 3) throw new Error(`expected 3 check rows, got ${checkRows.length}`);
	const bySeverity = Object.fromEntries(checkRows.map((row) => [row.getAttribute("data-check-id"), row.getAttribute("data-check-severity")]));
	if (bySeverity["dependency-break"] !== "high") throw new Error(`dependency-break severity wrong: ${JSON.stringify(bySeverity)}`);
	if (bySeverity["patch-residue"] !== "warning") throw new Error(`patch-residue severity wrong: ${JSON.stringify(bySeverity)}`);
	if (bySeverity["duplicate-port"] !== "info") throw new Error(`duplicate-port severity wrong: ${JSON.stringify(bySeverity)}`);
	if (!checkRows.some((row) => row.textContent.includes("uninstallCheckHigh"))) throw new Error("high-risk badge label not rendered");
	if (!checkRows.some((row) => row.textContent.includes("uninstallCheckInfo"))) throw new Error("info badge label not rendered");
	if (root9.querySelector("[data-self-hint]") !== null) throw new Error("self hint must not render for a normal package");
	console.log("RESULT: PASS - uninstall impact preview (verdict line + 3 graded checks)");

	// —— 12b. 卸载报告：L9 自启清理（cleaned）+ 自我卸载提示 ——
	await act(async () => {
		const confirm = findButton(root9, "uninstallConfirm");
		if (confirm === null) throw new Error("confirm button not found");
		confirm.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(40);
	const autostartRow = root9.querySelector("[data-autostart-cleanup]");
	if (autostartRow !== null) throw new Error("autostart cleanup row must not render for a normal package uninstall");
	if (root9.querySelector("[data-self-uninstalled]") !== null) throw new Error("self-uninstall hint must not render for a normal package");
	console.log("RESULT: PASS - normal uninstall report has no autostart cleanup row");

	// —— 12c. 管理器自身：isSelf 提示 + 自启清理结果 + 自我卸载说明 ——
	previewFor = makePreview({
		packageName: "dsh-plugin-manager-pro",
		isSelf: true,
		dependents: [],
		checks: [{ id: "self-uninstall", severity: "warning", title: "将被卸载的是管理器自身", detail: "卸载前会先调用包内 bin/open-boot.mjs --uninstall 清理开机自启。" }],
		verdict: "caution",
		verdictReason: "体检发现 1 项提示：将被卸载的是管理器自身。"
	});
	reportFor = {
		isSelf: true,
		autostartCleanup: { status: "cleaned", exitCode: 0, message: "开机自启已清理（exit 0）", command: "node bin/open-boot.mjs --uninstall --profile /p" }
	};
	const root10 = document.createElement("div");
	document.body.appendChild(root10);
	const root10Instance = createRoot(root10);
	// 管理器自身的行：origin=user（profile 依赖）+ protected（不能停用自身），但可以卸载（L9）
	const selfEntries = [...entries, {
		entryId: "e7", configId: "plugin-manager-pro", moduleName: "dsh-plugin-manager-pro", packageName: "dsh-plugin-manager-pro",
		description: "插件管理器", necessity: "optional", enabled: true, phase: "active", error: null,
		protected: true, protectionReason: "插件管理器不能停用自身。", archived: false, origin: "user",
		installedVersion: "0.9.1", latestVersion: null, updateSource: null, needsUpdate: null, managed: false
	}];
	const selfApi = { ...impactApi, list: async () => makeSnapshot(selfEntries) };
	await act(async () => {
		root10Instance.render(React.createElement(PluginManagerTab, { ...selfApi, t }));
	});
	await expandOptional(root10);
	await openUninstallFlow(root10, "dsh-plugin-manager-pro");
	const selfVerdict = root10.querySelector("[data-check-verdict]");
	if (selfVerdict === null || selfVerdict.getAttribute("data-check-verdict") !== "caution") throw new Error(`self verdict wrong: ${selfVerdict?.getAttribute("data-check-verdict")}`);
	const selfHint = root10.querySelector("[data-self-hint]");
	if (selfHint === null || !selfHint.textContent.includes("uninstallSelfHint")) throw new Error("self uninstall hint missing: " + root10.textContent.slice(0, 400));
	await act(async () => {
		const confirm = findButton(root10, "uninstallConfirm");
		if (confirm === null) throw new Error("confirm button not found (self)");
		confirm.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(40);
	const cleanupRow10 = root10.querySelector("[data-autostart-cleanup]");
	if (cleanupRow10 === null) throw new Error("autostart cleanup row missing for self uninstall");
	if (cleanupRow10.getAttribute("data-autostart-cleanup") !== "cleaned") throw new Error(`autostart cleanup status wrong: ${cleanupRow10.getAttribute("data-autostart-cleanup")}`);
	if (!cleanupRow10.textContent.includes("uninstallAutostartCleaned") || !cleanupRow10.textContent.includes("uninstallAutostartTitle")) {
		throw new Error("autostart cleanup labels missing: " + cleanupRow10.textContent);
	}
	if (root10.querySelector("[data-self-uninstalled]") === null) throw new Error("self-uninstalled notice missing");
	console.log("RESULT: PASS - self uninstall (hint + L9 autostart cleanup report)");

	// —— 12d. 安全结论 + 无检查项 + 旧宿主（无 checks/verdict 字段）降级 ——
	previewFor = makePreview({ packageName: "pkg-no-version", dependents: [], checks: [], verdict: "safe", verdictReason: "没有依赖断裂、补丁残留或 service/端口冲突。" });
	const root11 = document.createElement("div");
	document.body.appendChild(root11);
	const root11Instance = createRoot(root11);
	await act(async () => {
		root11Instance.render(React.createElement(PluginManagerTab, { ...impactApi, t }));
	});
	await expandOptional(root11);
	await openUninstallFlow(root11, "pkg-no-version");
	const safeVerdict = root11.querySelector("[data-check-verdict]");
	if (safeVerdict === null || safeVerdict.getAttribute("data-check-verdict") !== "safe") throw new Error(`safe verdict wrong: ${safeVerdict?.getAttribute("data-check-verdict")}`);
	if (root11.querySelector("[data-check-empty]") === null) throw new Error("empty-check placeholder missing");
	if (!safeVerdict.textContent.includes("uninstallVerdictSafe")) throw new Error("safe verdict label missing");
	// 旧宿主：预览里没有 checks/verdict/isSelf（新客户端 + 旧宿主混跑）时不得崩
	previewFor = makePreview({ packageName: "broken-mod", dependents: [] });
	delete previewFor.packages[0].checks;
	delete previewFor.packages[0].verdict;
	delete previewFor.packages[0].verdictReason;
	delete previewFor.packages[0].isSelf;
	const root12 = document.createElement("div");
	document.body.appendChild(root12);
	const root12Instance = createRoot(root12);
	await act(async () => {
		root12Instance.render(React.createElement(PluginManagerTab, { ...impactApi, t }));
	});
	await expandOptional(root12);
	const recommendedHeader = Array.from(root12.querySelectorAll("header")).find((h) => h.textContent.startsWith("necessityRecommended"));
	if (recommendedHeader !== undefined) {
		await act(async () => {
			recommendedHeader.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		});
	}
	await openUninstallFlow(root12, "broken-mod");
	const legacyVerdict = root12.querySelector("[data-check-verdict]");
	if (legacyVerdict === null || legacyVerdict.getAttribute("data-check-verdict") !== "safe") throw new Error("legacy host preview should degrade to safe verdict");
	if (root12.querySelector("[data-check-empty]") === null) throw new Error("legacy host preview should show empty-check placeholder");
	console.log("RESULT: PASS - safe verdict / empty checks / legacy-host degradation");
} catch (error) {
	impactError = error;
	console.error("UNINSTALL IMPACT ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

// ---- 13. 弱网（C-04/C-09）：目录整体失败（source=error）时必须给「网络不可达，可重试」文案 + 重试按钮，
//          而不是把真实原因（断网/代理）藏起来显示成「操作超时」。
const root13 = document.createElement("div");
document.body.appendChild(root13);
const root13Instance = createRoot(root13);
let marketError3 = null;
try {
	const apiErrCatalog = {
		...api,
		marketCatalog: async () => ({ source: "error", updated: null, count: 0, categories: null, items: [] }),
		marketInstall: async () => ({ status: "failed", packageName: null, url: null, method: null, message: "n/a" })
	};
	await act(async () => {
		root13Instance.render(React.createElement(PluginManagerTab, { ...apiErrCatalog, t }));
	});
	await settle();
	await act(async () => {
		findButton(root13, "market").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(60);
	// 模块级目录缓存可能已被前面的用例填充：点「刷新目录」强制重新拉取（走 source=error 分支）
	const refreshCatalogBtn = root13.querySelector('button[title="marketRefresh"]');
	if (refreshCatalogBtn !== null) {
		await act(async () => {
			refreshCatalogBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		});
		await settle(60);
	}
	const text13 = root13.textContent;
	if (!text13.includes("marketSourceErrorHint")) {
		throw new Error("market network-error hint missing (C-09): " + text13.slice(0, 300));
	}
	if (!text13.includes("marketRetry")) throw new Error("market retry button missing after network error");
	console.log("RESULT: PASS - market catalog network-error hint + retry (C-04/C-09)");
} catch (error) {
	marketError3 = error;
	console.error("MARKET NETWORK-ERROR PATH ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

if (!renderError && !failError && !marketError && !marketError2 && !configCardsError && !officialError && !impactError && !marketError3) {
	console.log("ALL RENDER TESTS PASSED");
}
