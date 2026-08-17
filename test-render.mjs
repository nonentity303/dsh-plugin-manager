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
const { PluginManagerTab, marketFilterItems } = exportsObj;
if (typeof PluginManagerTab !== "function") throw new Error("no PluginManagerTab export");
if (typeof marketFilterItems !== "function") throw new Error("no marketFilterItems export");

// ---- 3. 构造一个真实感 snapshot（覆盖 needsUpdate/managed/protected 各状态；e1/e2 架构自带，e3-e6 用户安装）
const entries = [
	{ entryId: "e1", configId: "agent", moduleName: "@deepseek-ai/dsh-agent", packageName: "@deepseek-ai/dsh-agent", description: "Agent 核心", necessity: "core", enabled: true, phase: "active", error: null, protected: true, protectionReason: "必需", archived: false, origin: "builtin", installedVersion: "0.1.0-rc.6", latestVersion: "0.1.0-rc.6", updateSource: "官方源 (npm)", needsUpdate: false, managed: false },
	{ entryId: "e2", configId: "ui-theme", moduleName: "@deepseek-ai/dsh-client-ui-theme", packageName: "@deepseek-ai/dsh-client-ui-theme", description: "主题", necessity: "recommended", enabled: true, phase: "active", error: null, protected: false, protectionReason: null, archived: false, origin: "builtin", installedVersion: "0.1.0-rc.6", latestVersion: "0.1.0-rc.9", updateSource: "官方源 (npm)", needsUpdate: true, managed: false },
	{ entryId: "e3", configId: "community-mod", moduleName: "community-mod", packageName: "community-mod", description: "社区插件", necessity: "optional", enabled: false, phase: null, error: null, protected: false, protectionReason: null, archived: false, origin: "user", installedVersion: "1.0.0", latestVersion: "1.2.0", updateSource: "官方源 (npm)", needsUpdate: true, managed: true },
	{ entryId: "e4", configId: "broken-mod", moduleName: "broken-mod", packageName: "broken-mod", description: "坏插件", necessity: "recommended", enabled: false, phase: "failed", error: "boom", protected: false, protectionReason: null, archived: false, origin: "user", installedVersion: "1.0.0", latestVersion: "1.0.0", updateSource: "官方源 (npm)", needsUpdate: false, managed: true },
	{ entryId: "e5", configId: "pkg-no-version", moduleName: "pkg-no-version", packageName: "pkg-no-version", description: "无版本", necessity: "optional", enabled: true, phase: "active", error: null, protected: false, protectionReason: null, archived: false, origin: "user", installedVersion: "0.1.0", latestVersion: null, updateSource: null, needsUpdate: null, managed: true },
	{ entryId: "e6", configId: "vision-router", moduleName: "dsh-vision-router", packageName: "dsh-vision-router", description: "视觉路由（自带配置）", necessity: "optional", enabled: true, phase: "active", error: null, protected: false, protectionReason: null, archived: false, origin: "user", installedVersion: "1.3.0", latestVersion: null, updateSource: null, needsUpdate: null, managed: true }
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

	// 搜索
	const searchInput = document.querySelector('input[type="search"]');
	if (!searchInput) throw new Error("search input not found");
	await act(async () => {
		searchInput.value = "theme";
		searchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	console.log("search render OK");

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

// ---- 9. 插件自带配置入口：行标记 + 折叠区渲染 + 卡片错误边界
const root5 = document.createElement("div");
document.body.appendChild(root5);
const root5Instance = createRoot(root5);
let configCardsError = null;
try {
	const configCards = [
		{ id: "vision-router", label: "视觉路由", render: () => React.createElement("div", null, "VR-CONFIG-CARD") },
		{ id: "broken-card", label: "坏卡片", render: () => { throw new Error("boom-card"); } }
	];
	await act(async () => {
		root5Instance.render(React.createElement(PluginManagerTab, { ...api, t, configCards }));
	});
	await settle();
	const text5 = () => root5.textContent;
	// 行标记：展开 optional 分组（jsdom 无法触发受控 input 的 onChange，不用搜索），vision-router 行应有 configEntry 按钮
	const optionalHeader5 = Array.from(root5.querySelectorAll("header")).find((h) => h.textContent.startsWith("necessityOptional"));
	if (!optionalHeader5) throw new Error("optional section header missing");
	await act(async () => {
		optionalHeader5.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	if (!text5().includes("configEntry")) throw new Error("config button missing on vision-router row");
	// 折叠区：点击 header 展开，正常卡片渲染 + 坏卡片被边界兜底
	const cardsHeader = Array.from(root5.querySelectorAll("header")).find((h) => h.textContent.includes("configCards"));
	if (!cardsHeader) throw new Error("config cards section header missing");
	await act(async () => {
		cardsHeader.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	});
	await settle(30);
	if (!text5().includes("VR-CONFIG-CARD")) throw new Error("plugin config card not rendered");
	if (!text5().includes("configCardFailed") || !text5().includes("boom-card")) {
		throw new Error("broken card should be caught by boundary");
	}
	console.log("RESULT: PASS - config card entry (row button + section + error boundary)");
} catch (error) {
	configCardsError = error;
	console.error("CONFIG-CARDS ERROR:", error && error.stack ? error.stack : error);
	process.exitCode = 1;
}

if (!renderError && !failError && !marketError && !marketError2 && !configCardsError) {
	console.log("ALL RENDER TESTS PASSED");
}
