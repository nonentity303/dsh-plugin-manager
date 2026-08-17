// test-bundle.mjs — 模拟浏览器端 DSH 客户端模块加载器，验证 bundle 契约
// 用法: node test-bundle.mjs [path-to-client.js]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const file = process.argv[2] ?? "lib/client.js";
const code = readFileSync(file, "utf8");

let handoff = null;
const sandbox = {
	window: {
		__ModuleLoader__: {
			load: (h) => {
				handoff = h;
			}
		}
	},
	require: (id) => ({ __stub: id }),
	console,
	setTimeout,
	clearTimeout,
	URL
};
vm.createContext(sandbox);

try {
	vm.runInContext(code, sandbox, { filename: file });
} catch (error) {
	console.error("SYNTAX/EVAL ERROR:", error.message);
	process.exit(1);
}

if (!handoff) {
	console.error("FAIL: bundle did not call window.__ModuleLoader__.load");
	process.exit(1);
}
if (handoff.id !== "dsh-plugin-manager-pro") {
	console.error(`FAIL: registered id ${handoff.id}, expected dsh-plugin-manager-pro`);
	process.exit(1);
}
if (typeof handoff.factory !== "function") {
	console.error("FAIL: handoff.factory is not a function");
	process.exit(1);
}

// 用真实模块解析执行 factory（react 等 external 由宿主模块表提供，本地用 node_modules 模拟）
const exported = handoff.factory((id) => {
	try {
		return require(id);
	} catch {
		return { __stub: id };
	}
});

if (typeof exported?.apply !== "function") {
	console.error("FAIL: bundle exports no apply() — got", Object.keys(exported ?? {}));
	process.exit(1);
}
if (!Array.isArray(exported.inject)) {
	console.error("FAIL: bundle exports no inject[]");
	process.exit(1);
}
console.log("CONTRACT OK:");
console.log("  id      =", handoff.id);
console.log("  inject  =", JSON.stringify(exported.inject));
console.log("  exports =", Object.keys(exported).join(", "));

// ---- 远端契约（TYPERT_REMOTE）：marketCatalog / marketInstall
const { TYPERT_REMOTE } = await import("./lib/remote.js");
const methods = new Map(TYPERT_REMOTE.descriptors.map((d) => [d.method, d]));
const failures = [];
if (methods.has("marketSearch")) failures.push("legacy marketSearch descriptor still present");

const catalogDesc = methods.get("marketCatalog");
if (!catalogDesc) {
	failures.push("no marketCatalog descriptor");
} else {
	const catalogFixture = {
		source: "live",
		updated: "2025-06-01",
		count: 2,
		categories: { market: { zh: "市场", en: "Market" } },
		items: [
			{ name: "dsh-market", owner: "dsh-market", url: "https://github.com/dsh-market/dsh-market", npm: "dshmarket", category: "market", description: { zh: "可视化市场", en: "Visual market" }, stars: 12, added: "2025-06-01" },
			{ name: "owner/repo", owner: "owner", url: "https://github.com/owner/repo", npm: null, category: "github", description: null, stars: null, added: null }
		]
	};
	try {
		catalogDesc.result.schema.parse(catalogFixture);
	} catch (error) {
		failures.push("marketCatalog schema rejects fixture: " + error.message);
	}
}

const installDesc = methods.get("marketInstall");
if (!installDesc) {
	failures.push("no marketInstall descriptor");
} else {
	const targetFixture = { name: "dsh-market", npm: "dshmarket", url: "https://github.com/dsh-market/dsh-market" };
	try {
		installDesc.parameters[0].codec.schema.parse(targetFixture);
	} catch (error) {
		failures.push("marketInstall target schema rejects fixture: " + error.message);
	}
	const resultFixture = { status: "dry-run", packageName: "dshmarket", url: "https://registry.npmjs.org/dshmarket", method: "npm", message: "ok" };
	try {
		installDesc.result.schema.parse(resultFixture);
	} catch (error) {
		failures.push("marketInstall result schema rejects fixture: " + error.message);
	}
}
if (failures.length > 0) {
	console.error("MARKET CONTRACT FAIL:\n - " + failures.join("\n - "));
	process.exit(1);
}
console.log("MARKET CONTRACT OK: marketCatalog/marketInstall schemas accept fixtures");

// ---- entry.origin 契约：快照条目必须携带来源（builtin=架构自带 / user=用户安装）
const listDesc = methods.get("list");
if (!listDesc) {
	console.error("FAIL: no list descriptor");
	process.exit(1);
}
const originFixture = {
	profileName: "web",
	entries: [
		{
			entryId: "e1", configId: "agent", moduleName: "@deepseek-ai/dsh-agent", packageName: "@deepseek-ai/dsh-agent",
			description: "Agent", necessity: "core", enabled: true, phase: "active", error: null,
			protected: true, protectionReason: "x", archived: false, origin: "builtin",
			installedVersion: "1.0.0", latestVersion: null, updateSource: null, needsUpdate: null, managed: false
		},
		{
			entryId: "e2", configId: "community-mod", moduleName: "community-mod", packageName: "community-mod",
			description: "M", necessity: "optional", enabled: false, phase: null, error: null,
			protected: false, protectionReason: null, archived: false, origin: "user",
			installedVersion: null, latestVersion: null, updateSource: null, needsUpdate: null, managed: true
		}
	],
	sources: []
};
try {
	listDesc.result.schema.parse(originFixture);
} catch (error) {
	console.error("FAIL: entry schema rejects origin fixture: " + error.message);
	process.exit(1);
}
const withoutOrigin = { ...originFixture, entries: [originFixture.entries[0]] };
delete withoutOrigin.entries[0].origin;
try {
	listDesc.result.schema.parse(withoutOrigin);
	console.error("FAIL: entry schema accepts an entry WITHOUT origin (contract should require it)");
	process.exit(1);
} catch { /* expected rejection */ }
console.log("ORIGIN CONTRACT OK: entry.origin required (builtin|user)");
