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
		}
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
const { PluginManagerTab } = exportsObj;
if (typeof PluginManagerTab !== "function") throw new Error("no PluginManagerTab export");

// ---- 3. 构造一个真实感 snapshot（覆盖 needsUpdate/managed/protected 各状态）
const entries = [
	{ entryId: "e1", configId: "agent", moduleName: "@deepseek-ai/dsh-agent", packageName: "@deepseek-ai/dsh-agent", description: "Agent 核心", necessity: "core", enabled: true, phase: "active", error: null, protected: true, protectionReason: "必需", installedVersion: "0.1.0-rc.6", latestVersion: "0.1.0-rc.6", updateSource: "官方源 (npm)", needsUpdate: false, managed: false },
	{ entryId: "e2", configId: "ui-theme", moduleName: "@deepseek-ai/dsh-client-ui-theme", packageName: "@deepseek-ai/dsh-client-ui-theme", description: "主题", necessity: "recommended", enabled: true, phase: "active", error: null, protected: false, protectionReason: null, installedVersion: "0.1.0-rc.6", latestVersion: "0.1.0-rc.9", updateSource: "官方源 (npm)", needsUpdate: true, managed: false },
	{ entryId: "e3", configId: "community-mod", moduleName: "community-mod", packageName: "community-mod", description: "社区插件", necessity: "optional", enabled: false, phase: null, error: null, protected: false, protectionReason: null, installedVersion: "1.0.0", latestVersion: "1.2.0", updateSource: "官方源 (npm)", needsUpdate: true, managed: true },
	{ entryId: "e4", configId: "broken-mod", moduleName: "broken-mod", packageName: "broken-mod", description: "坏插件", necessity: "recommended", enabled: false, phase: "failed", error: "boom", protected: false, protectionReason: null, installedVersion: "1.0.0", latestVersion: "1.0.0", updateSource: "官方源 (npm)", needsUpdate: false, managed: true },
	{ entryId: "e5", configId: "pkg-no-version", moduleName: "pkg-no-version", packageName: "pkg-no-version", description: "无版本", necessity: "optional", enabled: true, phase: "active", error: null, protected: false, protectionReason: null, installedVersion: "0.1.0", latestVersion: null, updateSource: null, needsUpdate: null, managed: true }
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

if (!renderError && !failError) {
	console.log("ALL RENDER TESTS PASSED");
}
