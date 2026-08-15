import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

mkdirSync("lib", { recursive: true });

// DSH 客户端模块契约：bundle 必须以 window.__ModuleLoader__.load({id, factory}) 注册，
// factory 接收模块表的 require，内部自带 module/exports（与官方 bundle 完全一致）。
const BANNER = `window.__ModuleLoader__.load({
	id: "@dsh-local/plugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;
const FOOTER = `		return module.exports;
	}
});
`;

await build({
	entryPoints: ["src/client.jsx"],
	outfile: "lib/client.js",
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: ["es2022"],
	jsx: "automatic",
	sourcemap: true,
	external: ["react", "react/jsx-runtime"],
	banner: { js: BANNER },
	footer: { js: FOOTER },
	logLevel: "info"
});

console.log("client bundle built -> lib/client.js");
