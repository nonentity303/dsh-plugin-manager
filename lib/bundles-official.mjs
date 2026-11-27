/**
 * bundles-official.mjs — 官方 bundle 目录（1.1.0 M3：官方保护集 + 隐藏集 + 模板 + 三分区纯函数）。
 *
 * 数据源：`@deepseek-ai/dsh-official-bundles`（**动态 import**，绝不写进 dependencies / peerDependencies）。
 * 该包导出四张表（0.2.2-rc.5 实测，lib/index.js:4-23、:61-93）：
 *   - PROTECTED_PLUGINS       17 项：插件管理器拒绝停用/卸载的"管理必需"包
 *   - HIDDEN_BUNDLES           8 项：内置 profile bundle + 常驻终端 + worktree 工具（无插件页）
 *   - PROFILE_TEMPLATES        5 个模板：acp / web / headless / sdk / sdk-minimal
 *   - DEFAULT_PROFILE_BUNDLES  1 项：`@deepseek-ai/dsh-base`
 *
 * 为什么要动态 import + 静态回落：drydock 的安装形态决定了它**解析不到**这个包 ——
 * 官方 dsh 把 `@deepseek-ai/dsh-official-bundles` 放在自己的嵌套 node_modules
 * （`<npm全局根>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-official-bundles`），
 * profile 的 node_modules 里没有。所以默认 loader 依次尝试：
 *   ① 裸说明符 `@deepseek-ai/dsh-official-bundles`（hoisted 布局 / 开发仓库里可能可解析）
 *   ② 各 npm 全局根下的 `…/dsh-official-bundles/lib/index.js`
 *   ③ 各 npm 全局根下 `<root>/@deepseek-ai/dsh/node_modules/…/lib/index.js`（**本机真实布局**）
 * 全部失败（包没装 / 老版本 / 导出缺失 / 导出为空集）→ **静态回落副本**，并明确标注 source/reason。
 *
 * 红线（契约 §5.7）：不新增运行时依赖；本文件只做「读 + 纯函数」，不写盘、不发网络。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { npmGlobalRoots } from "./platform.js";

export const OFFICIAL_BUNDLES_PACKAGE = "@deepseek-ai/dsh-official-bundles";

/** 静态回落副本的冻结版本（= 官方包自身版本；升级官方包后这里要同步复核）。 */
export const FALLBACK_SNAPSHOT_VERSION = "0.2.2-rc.5";

/**
 * 静态回落副本：PROTECTED_PLUGINS（17 项，逐字取自官方 lib/index.js:61-79）。
 * ⚠ 顺序与官方一致；**一个字符都不能改**——客户端按包名精确匹配。
 */
export const FALLBACK_PROTECTED_PLUGINS = Object.freeze([
	"@deepseek-ai/dsh-plugin-manager",
	"@deepseek-ai/cordis-plugin-loader",
	"@deepseek-ai/cordis-plugin-include",
	"@deepseek-ai/dsh-api-gateway",
	"@deepseek-ai/dsh-host-webserver",
	"@deepseek-ai/dsh-client-modules",
	"@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
	"@deepseek-ai/dsh-client-ui-plugin-manager",
	"@deepseek-ai/dsh-host-plugin-inventory",
	"@deepseek-ai/dsh-typert-registry",
	"@deepseek-ai/dsh-api-remotes",
	"@deepseek-ai/dsh-api-remote-access",
	"@deepseek-ai/cordis-plugin-timer",
	"@deepseek-ai/dsh-client-connection",
	"@deepseek-ai/dsh-host-frontend-static",
	"@deepseek-ai/dsh-tools",
	"@deepseek-ai/dsh-hmr"
]);

/**
 * 静态回落副本：HIDDEN_BUNDLES（8 项，逐字取自官方 lib/index.js:84-93）。
 * base / web-app / headless / sdk-app / acp-app / sdk-minimal + 两个 experimental 常驻件。
 */
export const FALLBACK_HIDDEN_BUNDLES = Object.freeze([
	"@deepseek-ai/dsh-base",
	"@deepseek-ai/dsh-web-app",
	"@deepseek-ai/dsh-headless",
	"@deepseek-ai/dsh-sdk-app",
	"@deepseek-ai/dsh-acp-app",
	"@deepseek-ai/dsh-sdk-minimal",
	"@deepseek-ai/dsh-experimental-terminal-bundle",
	"@deepseek-ai/dsh-experimental-tool-worktree"
]);

/** 静态回落副本：PROFILE_TEMPLATES（5 个模板，逐字取自官方 lib/index.js:4-10）。 */
export const FALLBACK_PROFILE_TEMPLATES = Object.freeze({
	acp: Object.freeze({ bundles: Object.freeze(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"]) }),
	web: Object.freeze({ bundles: Object.freeze(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]) }),
	headless: Object.freeze({ bundles: Object.freeze(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]) }),
	sdk: Object.freeze({ bundles: Object.freeze(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"]) }),
	"sdk-minimal": Object.freeze({ bundles: Object.freeze(["@deepseek-ai/dsh-sdk-minimal"]) })
});

/** 静态回落副本：DEFAULT_PROFILE_BUNDLES（官方 lib/index.js:23）。 */
export const FALLBACK_DEFAULT_PROFILE_BUNDLES = Object.freeze(["@deepseek-ai/dsh-base"]);

/**
 * drydock 自用额外锁定项（**不属于官方保护集**）。
 *
 * 为什么它存在：1.0.x 的三分区把这两个包白名单成「核心组件」区（lib/client.jsx 的
 * `CORE_PACKAGE_NAMES`，共享文件、由 lead 统一改）。1.1.0 M3 要求 web 侧分区**零回归**，
 * 因此 drydock 继续把它们当核心区（官方把它们放在 HIDDEN_BUNDLES，语义是"内置 bundle、无插件页"）。
 * 新增/删除这一项必须同时改 client 侧补丁，否则 host 的 `section` 与 client 的 `sectionKeyOfEntry` 会打架。
 */
export const DRYDOCK_LOCKED_CORE_PACKAGES = Object.freeze([
	"@deepseek-ai/dsh-base",
	"@deepseek-ai/dsh-web-app"
]);

/** 默认 loader 里逐个尝试的相对路径（相对每个 npm 全局根）。 */
const OFFICIAL_RELATIVE_FILES = Object.freeze([
	"@deepseek-ai/dsh-official-bundles/lib/index.js",
	"@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-official-bundles/lib/index.js"
]);

/**
 * 把模块名收敛成包级名字（scoped 取两段、其余取一段，统一小写）。
 * @param {unknown} name
 * @returns {string}
 */
export function bundleNameOf(name) {
	const text = typeof name === "string" ? name.trim() : "";
	if (text === "") return "";
	if (text.startsWith("cordis:")) return text;
	const lowered = text.toLocaleLowerCase();
	const parts = lowered.split("/").filter((part) => part !== "");
	if (lowered.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : lowered;
	return parts[0] ?? lowered;
}

function toNameSet(value) {
	if (value instanceof Set) {
		const set = new Set();
		for (const item of value) if (typeof item === "string" && item.trim() !== "") set.add(item.trim());
		return set;
	}
	if (Array.isArray(value)) {
		const set = new Set();
		for (const item of value) if (typeof item === "string" && item.trim() !== "") set.add(item.trim());
		return set;
	}
	return null;
}

function toNameList(value) {
	if (!Array.isArray(value)) return null;
	return value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function normalizeTemplates(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const templates = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof name !== "string" || name === "") return null;
		const bundles = toNameList(entry?.bundles);
		if (bundles === null || bundles.length === 0) return null;
		templates[name] = { bundles };
	}
	return Object.keys(templates).length === 0 ? null : templates;
}

/** 静态回落目录（永远可用；`reason` 说明为什么没走官方 import）。 */
export function fallbackOfficialCatalog(reason = "未尝试动态 import（调用方直接指定回落）", attempts = []) {
	return {
		protected: new Set(FALLBACK_PROTECTED_PLUGINS),
		hidden: new Set(FALLBACK_HIDDEN_BUNDLES),
		templates: cloneTemplates(FALLBACK_PROFILE_TEMPLATES),
		defaultProfileBundles: [...FALLBACK_DEFAULT_PROFILE_BUNDLES],
		source: "fallback",
		reason,
		origin: null,
		snapshotVersion: FALLBACK_SNAPSHOT_VERSION,
		attempts: [...attempts]
	};
}

function cloneTemplates(templates) {
	const out = {};
	for (const [name, entry] of Object.entries(templates)) out[name] = { bundles: [...entry.bundles] };
	return out;
}

/**
 * 校验动态 import 到的官方模块：**四项导出必须齐全且非空**，否则整包回落。
 * 不许"部分采用"——半官方半回落会让 source 说谎（契约 §5.9 不许静默失败）。
 * @param {object|null|undefined} mod
 * @returns {{ok:true, protected:Set<string>, hidden:Set<string>, templates:object, defaultProfileBundles:string[]} | {ok:false, reason:string}}
 */
export function validateOfficialModule(mod) {
	const problems = [];
	const protectedSet = toNameSet(mod?.PROTECTED_PLUGINS);
	if (protectedSet === null) problems.push("缺少导出 PROTECTED_PLUGINS（应为 Set / 数组）");
	else if (protectedSet.size === 0) problems.push("PROTECTED_PLUGINS 是空集");
	const hiddenSet = toNameSet(mod?.HIDDEN_BUNDLES);
	if (hiddenSet === null) problems.push("缺少导出 HIDDEN_BUNDLES（应为 Set / 数组）");
	else if (hiddenSet.size === 0) problems.push("HIDDEN_BUNDLES 是空集");
	const templates = normalizeTemplates(mod?.PROFILE_TEMPLATES);
	if (templates === null) problems.push("缺少/为空导出 PROFILE_TEMPLATES（应为 { 模板名: { bundles: string[] } }）");
	const defaults = toNameList(mod?.DEFAULT_PROFILE_BUNDLES);
	if (defaults === null || defaults.length === 0) problems.push("缺少/为空导出 DEFAULT_PROFILE_BUNDLES");
	if (problems.length > 0) return { ok: false, reason: problems.join("；") };
	return { ok: true, protected: protectedSet, hidden: hiddenSet, templates, defaultProfileBundles: defaults };
}

/**
 * 默认加载源（有序）：裸说明符 → 各 npm 全局根下的官方包文件。
 * 可注入 `roots` / `exists`，便于单测与受限环境。
 * @param {object} [options]
 * @param {string[]|null} [options.roots] npm 全局根候选（默认取 npmGlobalRoots()）
 * @param {(path:string)=>boolean} [options.exists]
 * @returns {{label:string, load:()=>Promise<object>}[]}
 */
export function officialLoaderCandidates({ roots = null, exists = existsSync } = {}) {
	const candidates = [{
		label: `裸说明符 ${OFFICIAL_BUNDLES_PACKAGE}`,
		load: () => import(OFFICIAL_BUNDLES_PACKAGE)
	}];
	let list = roots;
	if (list === null) {
		try {
			list = npmGlobalRoots();
		} catch {
			list = [];
		}
	}
	const seen = new Set();
	for (const root of list ?? []) {
		if (typeof root !== "string" || root === "") continue;
		for (const rel of OFFICIAL_RELATIVE_FILES) {
			const file = join(root, ...rel.split("/"));
			if (seen.has(file)) continue;
			seen.add(file);
			try {
				if (!exists(file)) continue;
			} catch {
				continue;
			}
			candidates.push({
				label: file,
				load: () => import(pathToFileURL(file).href)
			});
		}
	}
	return candidates;
}

/**
 * 解析官方目录（**永不抛异常**：最坏得到静态回落副本）。
 * @param {object} [options]
 * @param {()=>Promise<object>} [options.loader] 注入式加载器（测试用假 loader）
 * @param {string[]|null} [options.roots] 覆盖 npm 全局根候选
 * @param {(path:string)=>boolean} [options.exists]
 * @returns {Promise<{protected:Set<string>, hidden:Set<string>, templates:object, defaultProfileBundles:string[], source:"official"|"fallback", reason:string|null, origin:string|null, snapshotVersion:string|null, attempts:string[]}>}
 */
export async function officialCatalog(options = {}) {
	const attempts = [];
	const injected = options.loader;
	const sources = typeof injected === "function"
		? [{ label: "注入的 loader", load: injected }]
		: officialLoaderCandidates({ roots: options.roots ?? null, exists: options.exists ?? existsSync });
	for (const source of sources) {
		let mod;
		try {
			mod = await source.load();
		} catch (error) {
			const code = error?.code ? `${error.code} ` : "";
			const message = error instanceof Error ? error.message : String(error);
			attempts.push(`${source.label}: ${code}${message}`.trim());
			continue;
		}
		const validated = validateOfficialModule(mod);
		if (!validated.ok) {
			attempts.push(`${source.label}: 导出不完整 —— ${validated.reason}`);
			continue;
		}
		return {
			protected: validated.protected,
			hidden: validated.hidden,
			templates: validated.templates,
			defaultProfileBundles: validated.defaultProfileBundles,
			source: "official",
			reason: null,
			origin: source.label,
			snapshotVersion: null,
			attempts
		};
	}
	const reason = sources.length === 0
		? "没有可用的官方包加载源（npm 全局根为空且裸说明符不可解析）"
		: `官方包 ${OFFICIAL_BUNDLES_PACKAGE} 不可用，已用静态回落副本（${FALLBACK_SNAPSHOT_VERSION}）：${attempts.join("；")}`;
	return fallbackOfficialCatalog(reason, attempts);
}

/**
 * 三分区判定（**纯函数**）：`"core" | "builtin" | "user"`。
 *
 * 判定顺序（先到先得）：
 *   1. `coreSet`    —— drydock 自用锁定项（见 {@link DRYDOCK_LOCKED_CORE_PACKAGES}），**不是**官方保护集
 *   2. `protectedSet` —— 官方 PROTECTED_PLUGINS（管理必需，拒绝停用/卸载）
 *   3. `hiddenSet`  —— 官方 HIDDEN_BUNDLES（内置 bundle，无插件页；即使被装成依赖也算"引擎内置"）
 *   4. `origin === "user"` → 用户插件；否则 → 引擎内置组件
 *
 * @param {unknown} name 包名 / 模块名（内部收敛到包级名字 + 小写）
 * @param {{protectedSet?:Iterable<string>|null, hiddenSet?:Iterable<string>|null, coreSet?:Iterable<string>|null, origin?:"builtin"|"user"|null}} [options]
 * @returns {"core"|"builtin"|"user"}
 */
export function classifyBundle(name, { protectedSet = null, hiddenSet = null, coreSet = null, origin = "builtin" } = {}) {
	const key = bundleNameOf(name);
	if (key === "") return origin === "user" ? "user" : "builtin";
	const has = (set) => {
		if (set === null || set === void 0) return false;
		if (typeof set.has === "function") return set.has(key);
		if (Array.isArray(set)) return set.includes(key);
		return false;
	};
	if (has(coreSet)) return "core";
	if (has(protectedSet)) return "core";
	if (has(hiddenSet)) return "builtin";
	return origin === "user" ? "user" : "builtin";
}

/**
 * 这个 bundle 是不是**引擎自带**（不是靠 profile 的 `dependencies` 装出来的）。
 *
 * 为什么需要它：`@deepseek-ai/dsh-base` / `dsh-web-app` 等由引擎随包提供，它们会出现在
 * `dsh.profile.bundles` 里但**不出现在** profile 的 `dependencies` 里。若拿"在不在 dependencies"
 * 当"装没装"，就会把这两个核心组件误判成「声明了但没安装（悬空）」—— 真机实测踩到过。
 *
 * 两页（3080 管理台 / 3081 兜底页）必须用同一份判定，所以放在这里做纯函数。
 */
export function isEngineProvidedBundle(name, { hiddenSet = null, coreSet = null } = {}) {
	const key = bundleNameOf(name);
	if (key === "") return false;
	const inList = (set) => {
		if (set === null || set === void 0) return false;
		if (typeof set.has === "function") return set.has(key);
		if (Array.isArray(set)) return set.includes(key);
		return false;
	};
	return inList(coreSet ?? DRYDOCK_LOCKED_CORE_PACKAGES) || inList(hiddenSet);
}

/** 便于远程传输 / 测试断言：Set → 数组，保持目录顺序（JSON 安全）。 */export function wireOfficialCatalog(catalog) {
	const protectedNames = catalog?.protected instanceof Set ? [...catalog.protected] : [...(catalog?.protected ?? [])];
	const hiddenNames = catalog?.hidden instanceof Set ? [...catalog.hidden] : [...(catalog?.hidden ?? [])];
	return {
		protected: protectedNames,
		hidden: hiddenNames,
		templates: cloneTemplates(catalog?.templates ?? {}),
		defaultProfileBundles: [...(catalog?.defaultProfileBundles ?? [])],
		source: catalog?.source === "official" ? "official" : "fallback",
		reason: typeof catalog?.reason === "string" ? catalog.reason : null,
		origin: typeof catalog?.origin === "string" ? catalog.origin : null,
		snapshotVersion: typeof catalog?.snapshotVersion === "string" ? catalog.snapshotVersion : null
	};
}

/** 官方 PROTECTED_PLUGINS（含来源标记）。 */
export async function officialProtectedPlugins(options = {}) {
	const catalog = await officialCatalog(options);
	const wire = wireOfficialCatalog(catalog);
	return { items: wire.protected, source: wire.source, reason: wire.reason, origin: wire.origin };
}

/** 官方 HIDDEN_BUNDLES（含来源标记）。 */
export async function officialHiddenBundles(options = {}) {
	const catalog = await officialCatalog(options);
	const wire = wireOfficialCatalog(catalog);
	return { items: wire.hidden, source: wire.source, reason: wire.reason, origin: wire.origin };
}

/** 官方 PROFILE_TEMPLATES + DEFAULT_PROFILE_BUNDLES（含来源标记）。 */
export async function officialProfileTemplates(options = {}) {
	const catalog = await officialCatalog(options);
	const wire = wireOfficialCatalog(catalog);
	return {
		templates: wire.templates,
		defaultProfileBundles: wire.defaultProfileBundles,
		source: wire.source,
		reason: wire.reason,
		origin: wire.origin
	};
}
