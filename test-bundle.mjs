// test-bundle.mjs — 模拟浏览器端 DSH 客户端模块加载器，验证 bundle 契约
// 用法: node test-bundle.mjs [path-to-client.js]
import { readFileSync } from "node:fs";
import vm from "node:vm";

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
if (handoff.id !== "@dsh-local/plugin-manager") {
	console.error(`FAIL: registered id ${handoff.id}, expected @dsh-local/plugin-manager`);
	process.exit(1);
}
if (typeof handoff.factory !== "function") {
	console.error("FAIL: handoff.factory is not a function");
	process.exit(1);
}

// 执行 factory（模块表 require 只解析 react 存根；渲染期才真正用到）
const exported = handoff.factory((id) => ({ __stub: id }));

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
