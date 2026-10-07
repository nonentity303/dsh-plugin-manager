import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

mkdirSync("lib", { recursive: true });

// DSH 客户端模块契约：bundle 必须以 window.__ModuleLoader__.load({id, factory}) 注册，
// factory 接收模块表的 require，内部自带 module/exports（与官方 bundle 完全一致）。
const BANNER = `window.__ModuleLoader__.load({
	id: "dsh-plugin-manager-pro",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;
const FOOTER = `		return module.exports;
	}
});
`;

/**
 * P-01：裁剪 zod v4 里**用不到的 51 个 locale**。
 *
 * 依据（audit/verify-090/rc2-perf-audit.md §P-01，实测）：
 *  - `client.js` 未 minify 时 796,658 B，其中 zod 占 74.2%，**53 个 locale 文件 = 308,634 B（38.8%）**；
 *  - 客户端 UI 只有 zh / en 两套文案（`src/client.jsx` 里两张 i18n 表），且**从不调用**
 *    `z.config()` / `z.locales.*`（仓库内 grep 可核：lib、src、bin、tools 全无）。
 *
 * 保留哪些、为什么：
 *  - `en.js`：zod 的入口 `zod/v4/classic/external.js` 直接 `import en from "../locales/en.js"`，
 *    它是**默认错误文案**来源 —— 掉它会把校验错误信息变成 undefined，所以必须保留；
 *  - `zh-CN.js`：UI 唯一的中文语言，保留以便将来启用中文错误文案；
 *  - 其余 51 个（含 ja / he / ar / ru / … / zh-TW）UI 不提供，换成一个空模块。
 *    `zod/v4/locales/index.js` 是 `export { default as xx } from "./xx.js"` 形式 → 空模块仍满足导入图，
 *    `z.locales.xx` 变成空对象（从不被调用），不影响任何现有行为。
 */
const ZOD_LOCALE_KEEP = new Set(["en.js", "zh-CN.js"]);
const zodLocaleTrim = {
	name: "zod-locale-trim",
	setup(build) {
		build.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]locales[\\/][^\\/]+\.js$/ }, (args) => {
			const fileName = args.path.split(/[\\/]/).pop();
			if (ZOD_LOCALE_KEEP.has(fileName)) return null;   // null = 用默认 loader，保留真实实现
			return { contents: "export default {};\n", loader: "js" };
		});
	}
};

await build({
	entryPoints: ["src/client.jsx"],
	outfile: "lib/client.js",
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: ["es2022"],
	jsx: "automatic",
	sourcemap: true,
	// ⚠️ 勿回退：React 必须留在外部模块表（审计 P-01 已确认当前 external 生效：has_react_dom/has_react_production 均为 false）
	external: ["react", "react/jsx-runtime"],
	// P-01：未 minify 时 18,529 行 / 796,658 B。minify 只改**产物形态**，不改语义（sourcemap 仍生成）
	minify: true,
	plugins: [zodLocaleTrim],
	banner: { js: BANNER },
	footer: { js: FOOTER },
	logLevel: "info"
});

console.log("client bundle built -> lib/client.js");
