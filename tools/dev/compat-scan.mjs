#!/usr/bin/env node
/**
 * rc2-compat-scan.mjs —— dsh-plugin-manager-pro 进包文件的「Node 版本敏感 API」静态门禁。
 *
 * 用法（脚本已随仓库进 tools/dev/；默认 root 从 cwd 向上找本包，t13）：
 *   node tools/dev/compat-scan.mjs                                # 自动定位包根（cwd 向上找 name=dsh-plugin-manager-pro）
 *   node tools/dev/compat-scan.mjs --root plugin-manager          # 显式指定包根
 *   node tools/dev/compat-scan.mjs --tgz plugin-manager/dsh-plugin-manager-pro-0.9.1.tgz
 *   node tools/dev/compat-scan.mjs --level blocker                # 只在 blocker 命中时失败
 *   node tools/dev/compat-scan.mjs --level none                   # 只报告，永不失败
 *   node tools/dev/compat-scan.mjs --json --quiet
 *   node tools/dev/compat-scan.mjs --list-rules
 *
 * 退出码语义（CI 门禁）：
 *   0 = 门禁线（默认 high）及以上无命中
 *   1 = 命中 high/medium（无 blocker）——「运行期才会炸」级别
 *   2 = 命中 blocker ——「模块链接期就 SyntaxError，插件整体加载失败」级别
 *   3 = 用法 / IO 错误（未能完成扫描，不得当作通过）
 *
 * 设计要点：
 *  - 扫描对象 = npm 实际进包文件（读 package.json 的 files + npm 永远附带项），不是 src/ 源文件。
 *  - 先做「注释/字符串遮罩」再做匹配，避免把注释里的 API 名当成命中（行号保持不变）。
 *  - blocker 判定：ESM 具名导入一个在 engines 下限不存在的 node: 内建导出 —— 这是链接期硬失败
 *    （G1: lib/index.js 顶层 `import { findPackageJSON } from "node:module"`，Node < 22.14 SyntaxError）。
 *  - 浏览器产物（window.__ModuleLoader__ banner）走独立规则集，不套 Node 内建规则。
 *  - 无第三方依赖，node 直接跑；不联网。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

/** 本包的 package.json 名（用于定位真正的包根，t13）。 */
const PKG_NAME = "dsh-plugin-manager-pro";

/**
 * 从 `startDir` 逐级向上找**本包**的根目录（package.json 的 name === dsh-plugin-manager-pro）。
 *
 * 为什么不能按脚本位置推导默认 root（t13）：脚本原在 `audit/verify-090/`，复制到 `tools/dev/` 后
 * `__dirname/../..` 变成了包目录本身 → 默认 root 变成 `<repo>/plugin-manager/plugin-manager`
 * → `package.json not found …` exit 3。改为从 cwd（其次脚本位置）向上找，脚本放哪儿都能自定位。
 * @returns {string|null} 包根绝对路径；找不到返回 null
 */
function findPackageRoot(startDir) {
	let dir = resolve(startDir);
	for (;;) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				if (JSON.parse(readFileSync(manifest, "utf8"))?.name === PKG_NAME) return dir;
			} catch { /* 坏 package.json：继续向上找 */ }
		}
		const parent = dirname(dir);
		if (parent === dir) return null; // 已到卷根
		dir = parent;
	}
}

//#region ---------- Node API 版本表 ----------
// 只收录「Node 18 之后才出现」的 API；minVersion 为单位置 0 的版本号，便于比较。
// src = 依据（nodejs.org 文档 Added in 标记 / API JSON 实测）。

/** node: 内建模块整体最低版本（模块本身不存在的情况）。 */
const BUILTIN_MODULE_MIN = {
	"node:sqlite": { min: "22.5.0", src: "SQLite 文档 Added in: v22.5.0" },
	"node:test/reporters": { min: "19.9.0", src: "文档 Added in: v19.9.0" },
	"node:sea": { min: "21.7.0", src: "文档 Added in: v21.7.0" },
	"node:quic": { min: "23.10.0", src: "文档 Added in: v23.10.0" }
};

/** node: 内建具名导出最低版本（链接期失败：ESM 具名导入不存在 → SyntaxError）。 */
const BUILTIN_EXPORT_MIN = {
	"node:module": {
		// 实测：v20 docs module.json 不含 findPackageJSON；v22 docs 含（Added in: v22.14.0）
		findPackageJSON: { min: "22.14.0", src: "module.html Added in: v22.14.0（并在 API JSON 中核对 v20 缺失）" },
		flushCompileCache: { min: "22.10.0", src: "module.html Added in: v23.0.0, v22.10.0" },
		enableCompileCache: { min: "22.8.0", src: "module.html Added in: v22.8.0" },
		getCompileCacheDir: { min: "22.8.0", src: "module.html Added in: v22.8.0" },
		registerHooks: { min: "22.15.0", src: "module.html Customization Hooks v22.15.0" },
		stripTypeScriptTypes: { min: "22.13.0", src: "module.html Added in: v22.13.0" }
	},
	"node:fs": {
		glob: { min: "22.0.0", src: "fs 文档 Added in: v22.0.0" },
		globSync: { min: "22.0.0", src: "fs 文档 Added in: v22.0.0" },
		openAsBlob: { min: "19.8.0", src: "fs 文档 Added in: v19.8.0" }
	},
	"node:fs/promises": {
		glob: { min: "22.0.0", src: "fs/promises 文档 Added in: v22.0.0" },
		openAsBlob: { min: "19.8.0", src: "fs/promises 文档 Added in: v19.8.0" }
	},
	"node:path": {
		matchesGlob: { min: "22.5.0", src: "path 文档 Added in: v22.5.0" }
	},
	"node:process": {
		getBuiltinModule: { min: "22.3.0", src: "process 文档 Added in: v22.3.0" },
		loadEnvFile: { min: "20.12.0", src: "process 文档 Added in: v21.7.0, v20.12.0" }
	},
	"node:util": {
		styleText: { min: "20.12.0", src: "util 文档 Added in: v21.7.0, v20.12.0" },
		parseEnv: { min: "20.12.0", src: "util 文档 Added in: v21.7.0, v20.12.0" },
		getCallSites: { min: "22.9.0", src: "util 文档 Added in: v22.9.0" },
		MIMEType: { min: "19.1.0", src: "util 文档 Added in: v19.1.0" }
	},
	"node:os": {
		availableParallelism: { min: "18.14.0", src: "os 文档 Added in: v19.4.0, v18.14.0" }
	},
	"node:net": {
		getDefaultAutoSelectFamily: { min: "18.18.0", src: "net 文档 Added in: v19.4.0, v18.18.0" }
	},
	"node:crypto": {
		hash: { min: "20.12.0", src: "crypto 文档 Added in: v21.7.0, v20.12.0" }
	},
	"node:test": {
		run: { min: "18.9.0", src: "test 文档 Added in: v18.9.0" },
		mock: { min: "19.1.0", src: "test 文档 Added in: v19.1.0" },
		snapshot: { min: "22.3.0", src: "test 文档 Added in: v22.3.0" }
	},
	"node:stream": {
		getDefaultHighWaterMark: { min: "18.17.0", src: "stream 文档 Added in: v18.17.0" },
		setDefaultHighWaterMark: { min: "18.17.0", src: "stream 文档 Added in: v18.17.0" }
	},
	"node:worker_threads": {
		markAsUncloneable: { min: "22.13.0", src: "worker_threads 文档 Added in: v22.13.0" }
	}
};

/**
 * 运行期 API 规则（不是 import，是调用）。
 * match 用正则；limit 用来压住重名误报（如 `.with(`、`.union(`）。
 * runtime: "any" 表示宿主与浏览器产物都看；"node" 只看宿主侧。
 */
const RUNTIME_RULES = [
	{ id: "import.meta.dirname", min: "20.11.0", sev: "high", re: /\bimport\.meta\.dirname\b/g, src: "ESM 文档 Added in: v21.2.0, v20.11.0", note: "Node 20.11/21.2 之前是 undefined（静默）→ 拼出 \"undefined/xxx\" 路径" },
	{ id: "import.meta.filename", min: "20.11.0", sev: "high", re: /\bimport\.meta\.filename\b/g, src: "ESM 文档 Added in: v21.2.0, v20.11.0", note: "同上" },
	{ id: "Array.prototype.toSorted", min: "20.0.0", sev: "high", re: /\.toSorted\s*\(/g, src: "V8 11.0 / Node 20.0.0" },
	{ id: "Array.prototype.toReversed", min: "20.0.0", sev: "high", re: /\.toReversed\s*\(/g, src: "V8 11.0 / Node 20.0.0" },
	{ id: "Array.prototype.toSpliced", min: "20.0.0", sev: "high", re: /\.toSpliced\s*\(/g, src: "V8 11.0 / Node 20.0.0" },
	{ id: "Array.prototype.with", min: "20.0.0", sev: "low", re: /[\]\)]\s*\.with\s*\(/g, src: "V8 11.0 / Node 20.0.0", verify: true, note: "同名方法多，需人工确认是否为 Array#with" },
	{ id: "Object.groupBy", min: "21.0.0", sev: "high", re: /\bObject\.groupBy\s*\(/g, src: "V8 11.7 / Node 21.0.0" },
	{ id: "Map.groupBy", min: "21.0.0", sev: "high", re: /\bMap\.groupBy\s*\(/g, src: "V8 11.7 / Node 21.0.0" },
	{ id: "Promise.withResolvers", min: "22.0.0", sev: "high", re: /\bPromise\.withResolvers\s*\(/g, src: "V8 11.9 / Node 22.0.0" },
	{ id: "Array.fromAsync", min: "22.0.0", sev: "high", re: /\bArray\.fromAsync\s*\(/g, src: "Node 22.0.0" },
	{ id: "Set.prototype.union", min: "22.0.0", sev: "low", re: /\.union\s*\(/g, src: "V8 12.4 / Node 22.0.0", verify: true, note: "同名函数多（如 zod 的 union），需人工确认是否 Set#union" },
	{ id: "Set.prototype.intersection", min: "22.0.0", sev: "low", re: /\.intersection\s*\(/g, src: "V8 12.4 / Node 22.0.0", verify: true, note: "同上" },
	{ id: "Set.prototype.difference", min: "22.0.0", sev: "low", re: /\.difference\s*\(/g, src: "V8 12.4 / Node 22.0.0", verify: true, note: "同上" },
	{ id: "String.prototype.isWellFormed", min: "20.0.0", sev: "medium", re: /\.isWellFormed\s*\(/g, src: "Node 20.0.0" },
	{ id: "String.prototype.toWellFormed", min: "20.0.0", sev: "medium", re: /\.toWellFormed\s*\(/g, src: "Node 20.0.0" },
	{ id: "AbortSignal.any", min: "20.3.0", sev: "medium", re: /\bAbortSignal\.any\s*\(/g, src: "Node 20.3.0" },
	{ id: "process.getBuiltinModule", min: "22.3.0", sev: "high", re: /\bprocess\.getBuiltinModule\s*\(/g, src: "Node 22.3.0" },
	{ id: "URL.parse", min: "22.1.0", sev: "medium", re: /\bURL\.parse\s*\(/g, src: "Node 22.1.0" },
	{ id: "global.navigator", min: "21.0.0", sev: "medium", re: /(?<![.\w])navigator\s*\.\s*(userAgent|language|languages|hardwareConcurrency|platform)\b/g, src: "Node 21.0.0" },
	{ id: "global.WebSocket", min: "21.0.0", sev: "medium", re: /(?<![.\w])new\s+WebSocket\s*\(/g, src: "Node 21.0.0（22 起默认开启）" },
	{ id: "Uint8Array.toBase64", min: "22.0.0", sev: "medium", re: /\.toBase64\s*\(/g, src: "Node 22.0.0" },
	{ id: "Uint8Array.toHex", min: "22.0.0", sev: "medium", re: /\.toHex\s*\(/g, src: "Node 22.0.0" },
	{ id: "fs.promises.glob", min: "22.0.0", sev: "high", re: /\bfs(?:Promises|\.promises|p)\.glob\s*\(/g, src: "fs/promises 文档 Added in: v22.0.0" },
	{ id: "structuredClone", min: "17.0.0", sev: "ok", re: /\bstructuredClone\s*\(/g, src: "Node 17.0.0 —— engines>=18 内安全" },
	{ id: "AbortSignal.timeout", min: "17.3.0", sev: "ok", re: /\bAbortSignal\.timeout\s*\(/g, src: "Node 17.3.0 —— engines>=18 内安全" },
	{ id: "global.fetch", min: "18.0.0", sev: "ok", re: /(?<![.\w"'])fetch\s*\(/g, src: "Node 18.0.0（18 上仍标 experimental）" }
];

/** 语法规则（解析期/链接期就炸，或语义随版本变）。 */
const SYNTAX_RULES = [
	{ id: "import-attributes-with", min: "22.0.0", sev: "blocker", re: /\bimport\s[^;\n]*\bwith\s*\{\s*type\s*:/g, src: "import attributes 用 `with`：Node 22 起；Node 18/20 解析期 SyntaxError", note: "Node 18/20 只认 `assert { type: ... }`" },
	{ id: "require-esm", min: "22.12.0", sev: "high", re: /\brequire\s*\(\s*["'][^"']+["']\s*\)/g, src: "CJS require() 加载 ESM：Node 22.12+（需目标确为 ESM-only 包）", verify: true, cjsOnly: true, note: "仅 CJS 文件 + 目标包为 ESM-only 时成立" },
	{ id: "using-declaration", min: "24.0.0", sev: "medium", re: /(?:^|[;{}]\s*)using\s+[A-Za-z_$][\w$]*\s*=/g, src: "显式资源管理 using：Node 24 起默认可用（此前需 --harmony 标志）", verify: true, note: "需人工核实运行 Node 版本；低置信度，默认只提示" },
	{ id: "regexp-v-flag", min: "20.0.0", sev: "medium", re: /new\s+RegExp\s*\([^)]*,\s*["'][dgimsuvy]*v["']\s*\)/g, src: "RegExp v 标志：Node 20.0.0（用字面量 /.../v 亦同）" },
	{ id: "regexp-v-literal", min: "20.0.0", sev: "medium", re: /(?:^|[^\\/\w])\/(?![/*])(?:\\.|\[[^\]]*\]|[^/\n\\])+\/[dgimsuvy]*v[dgimsuvy]*/g, src: "RegExp v 标志字面量：Node 20.0.0" },
	{ id: "RegExp.escape", min: "24.0.0", sev: "medium", re: /\bRegExp\.escape\s*\(/g, src: "Node 24.0.0", verify: true },
	{ id: "Promise.try", min: "24.0.0", sev: "medium", re: /\bPromise\.try\s*\(/g, src: "Node 24.0.0", verify: true },
	{ id: "node-test-module", min: "18.0.0", sev: "ok", re: /["']node:test["']/g, src: "Node 18.0.0 —— engines>=18 内安全" }
];
//#endregion

//#region ---------- 工具 ----------
function parseVersion(v) {
	const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v ?? "").trim());
	if (m === null) return null;
	return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}
function cmpVersion(a, b) {
	const A = parseVersion(a), B = parseVersion(b);
	if (A === null || B === null) return 0;
	for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
	return 0;
}
/** 把 ">=18.0.0" / "^18" / ">=20 <23" 解析成最低版本（取第一个下限；无法解析返回 null）。 */
function enginesFloor(range) {
	if (typeof range !== "string") return null;
	const m = /(?:>=|\^|~|>)?\s*v?(\d+(?:\.\d+){0,2})/.exec(range);
	return m === null ? null : m[1];
}
const SEV_RANK = { blocker: 4, high: 3, medium: 2, low: 1, ok: 0 };
function worse(a, b) { return SEV_RANK[a] >= SEV_RANK[b] ? a : b; }

/**
 * 行内遮罩：把注释与字符串字面量替换成同宽空格，保留换行与列位置（行号/列号不变）。
 * 这样正则命中就一定是「真代码」，不会被注释里的 API 名骗到。
 */
function maskCode(src) {
	const out = src.split("");
	let i = 0, state = "code", quote = "";
	const n = src.length;
	while (i < n) {
		const c = src[i];
		const c2 = src[i + 1];
		if (state === "code") {
			if (c === "/" && c2 === "/") { state = "line"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
			if (c === "/" && c2 === "*") { state = "block"; out[i] = " "; out[i + 1] = " "; i += 2; continue; }
			if (c === '"' || c === "'" || c === "`") {
				state = "str"; quote = c; out[i] = " "; i += 1; continue;
			}
			i += 1; continue;
		}
		if (state === "line") {
			if (c === "\n") { state = "code"; i += 1; continue; }
			out[i] = " "; i += 1; continue;
		}
		if (state === "block") {
			if (c === "*" && c2 === "/") { out[i] = " "; out[i + 1] = " "; state = "code"; i += 2; continue; }
			if (c !== "\n") out[i] = " ";
			i += 1; continue;
		}
		if (state === "str") {
			if (c === "\\") { out[i] = " "; if (src[i + 1] !== "\n") out[i + 1] = " "; i += 2; continue; }
			if (c === quote) { out[i] = " "; state = "code"; i += 1; continue; }
			if (c !== "\n") out[i] = " ";
			i += 1; continue;
		}
	}
	return out.join("");
}

/**
 * 带 import 语句的原始文本（未遮罩）解析：找出 `from "node:x"` 的具名导入。
 * 返回 [{specifier, names:Set, line, raw}]。用原始文本是因为遮罩会吃掉字符串里的模块名。
 */
function findBuiltinImports(raw) {
	const found = [];
	const re = /\bimport\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
	let m;
	while ((m = re.exec(raw)) !== null) {
		const clause = m[1].trim();
		const specifier = m[2];
		if (!specifier.startsWith("node:")) continue;
		const line = raw.slice(0, m.index).split("\n").length;
		const names = new Set();
		const braces = /\{([\s\S]*?)\}/.exec(clause);
		if (braces !== null) {
			for (const part of braces[1].split(",")) {
				const piece = part.trim().split(/\s+as\s+/)[0].trim();
				if (piece !== "") names.add(piece);
			}
		}
		found.push({ specifier, names, line, raw: `import ${clause} from "${specifier}"` });
	}
	return found;
}

/** 动态 import("node:x") / require("node:x") 里出现的目标模块（模块整体版本规则用）。 */
function findDynamicBuiltinRefs(masked) {
	const hits = [];
	const re = /(?:\bimport\s*\(|\brequire\s*\()\s*["'](node:[^"']+)["']/g;
	let m;
	while ((m = re.exec(masked)) !== null) {
		hits.push({ specifier: m[1], line: masked.slice(0, m.index).split("\n").length, raw: m[0] });
	}
	return hits;
}
//#endregion

//#region ---------- 进包文件发现 ----------
// npm 永远附带项（实测：package.json / README* / LICENSE*；CHANGELOG.md 不在其中）
const ALWAYS_INCLUDED = ["package.json", "README.md", "README.en.md", "LICENSE", "LICENCE"];

/** 展开 package.json `files` 里的简单 glob（`dir`、`dir/*.js`、`dir/**`、`exact`）。 */
function expandPattern(root, pattern) {
	const out = [];
	const p = pattern.replace(/\/+$/, "");
	if (p.includes("*")) {
		// 只做逐段 glob：目录固定 + 末段模式
		const parts = p.split("/");
		let dirs = [root];
		for (let i = 0; i < parts.length; i++) {
			const seg = parts[i];
			const last = i === parts.length - 1;
			const next = [];
			for (const d of dirs) {
				if (!existsSync(d) || !statSync(d).isDirectory()) continue;
				if (seg === "**") {
					// 递归全收
					const walk = (base) => {
						for (const e of readdirSync(base, { withFileTypes: true })) {
							const full = join(base, e.name);
							if (e.isDirectory()) walk(full);
							else next.push(full);
						}
					};
					walk(d);
					continue;
				}
				if (seg.includes("*")) {
					const re = new RegExp("^" + seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/\\\\]*") + "$");
					for (const e of readdirSync(d, { withFileTypes: true })) {
						// last=true 时只收文件；last=false 时只收目录
						if (e.isDirectory() === last) continue;
						if (!re.test(e.name)) continue;
						next.push(join(d, e.name));
					}
				} else {
					const full = join(d, seg);
					if (!existsSync(full)) continue;
					if (last) {
						// 「目录名」模式（如 files:["bin"]）＝ 该目录下全部文件，递归收
						if (statSync(full).isDirectory()) {
							const walk = (base) => {
								for (const e of readdirSync(base, { withFileTypes: true })) {
									const child = join(base, e.name);
									if (e.isDirectory()) walk(child);
									else out.push(child);
								}
							};
							walk(full);
						} else out.push(full);
					} else next.push(full);
				}
			}
			dirs = next;
		}
		for (const f of dirs) out.push(f);
	} else {
		const full = join(root, p);
		if (existsSync(full)) {
			// 无通配符的「目录名」模式（files:["bin"]）＝ 目录下全部文件，递归收
			if (statSync(full).isDirectory()) {
				const walk = (base) => {
					for (const e of readdirSync(base, { withFileTypes: true })) {
						const child = join(base, e.name);
						if (e.isDirectory()) walk(child);
						else out.push(child);
					}
				};
				walk(full);
			} else out.push(full);
		}
	}
	return out;
}

function listShippedFiles(root) {
	const pkgPath = join(root, "package.json");
	if (!existsSync(pkgPath)) return null;
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	const files = new Set();
	const patterns = Array.isArray(pkg.files) && pkg.files.length > 0 ? pkg.files : ["**"];
	const warnings = [];
	for (const pattern of patterns) {
		const matched = expandPattern(root, pattern).filter((f) => existsSync(f) && statSync(f).isFile());
		if (matched.length === 0) warnings.push(`package.json files 里的 "${pattern}" 没有匹配到任何文件（扫描覆盖可能不完整）`);
		for (const f of matched) files.add(f);
	}
	for (const name of ALWAYS_INCLUDED) {
		const f = join(root, name);
		if (existsSync(f) && statSync(f).isFile()) files.add(f);
	}
	// package.json 的 main / exports 指向的文件必须进包
	const collect = (v) => {
		if (typeof v === "string") {
			const f = join(root, v.replace(/^\.\//, ""));
			if (existsSync(f) && statSync(f).isFile()) files.add(f);
		} else if (v !== null && typeof v === "object") {
			for (const x of Object.values(v)) collect(x);
		}
	};
	collect(pkg.main);
	collect(pkg.exports);
	collect(pkg.bin);
	collect(pkg.dsh?.bundle?.patch);
	return { pkg, files: [...files].sort(), warnings };
}

//#region ---------- 极简 tar 读取（--tgz 模式，零依赖） ----------
function readTarEntries(buf) {
	const entries = [];
	let off = 0;
	while (off + 512 <= buf.length) {
		const header = buf.subarray(off, off + 512);
		if (header.every((b) => b === 0)) break;
		const str = (start, len) => {
			const s = header.subarray(start, start + len);
			const end = s.indexOf(0);
			return s.subarray(0, end === -1 ? s.length : end).toString("utf8").trim();
		};
		const name = str(0, 100);
		const prefix = str(345, 155);
		const sizeOctal = str(124, 12).replace(/\0/g, "").trim();
		const size = parseInt(sizeOctal === "" ? "0" : sizeOctal, 8) || 0;
		const type = String.fromCharCode(header[156] || 48);
		const full = prefix === "" ? name : `${prefix}/${name}`;
		off += 512;
		if (type === "0" || type === "\0" || type === "") {
			entries.push({ name: full, data: buf.subarray(off, off + size) });
		}
		off += Math.ceil(size / 512) * 512;
	}
	return entries;
}

function loadTgz(tgzPath) {
	const raw = readFileSync(tgzPath);
	const entries = readTarEntries(gunzipSync(raw));
	const files = [];
	for (const e of entries) {
		if (e.name.endsWith("/")) continue;
		let rel = e.name.replace(/^package\//, "");
		rel = rel.split("\\").join("/");
		files.push({ rel, text: e.data.toString("utf8"), bytes: e.data.length });
	}
	files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
	const pkgEntry = files.find((f) => f.rel === "package.json");
	return { pkg: pkgEntry ? JSON.parse(pkgEntry.text) : {}, files };
}
//#endregion

//#region ---------- 扫描主体 ----------
function scanFile(rel, text, pkg) {
	const hits = [];
	const masked = maskCode(text);
	const isBrowserBundle = /__ModuleLoader__/.test(text.slice(0, 2000));
	const fileFloor = enginesFloor(pkg?.engines?.node);
	const lines = text.split("\n");

	const push = (rule) => {
		hits.push({
			file: rel,
			line: rule.line,
			api: rule.api,
			min: rule.min,
			sev: rule.sev,
			kind: rule.kind,
			verify: rule.verify === true,
			src: rule.src,
			note: rule.note ?? "",
			snippet: (lines[rule.line - 1] ?? "").trim().slice(0, 160)
		});
	};

	// 1) ESM 具名导入内建导出 —— 链接期硬失败
	for (const imp of findBuiltinImports(text)) {
		const modMin = BUILTIN_MODULE_MIN[imp.specifier];
		if (modMin !== undefined) {
			push({
				api: `${imp.specifier}（模块整体）`, min: modMin.min, sev: "blocker",
				kind: "builtin-module", line: imp.line, src: modMin.src,
				note: "该内建模块在 Node 低版本不存在 → 链接期 SyntaxError，插件整体加载失败"
			});
		}
		const table = BUILTIN_EXPORT_MIN[imp.specifier];
		for (const name of imp.names) {
			const entry = table?.[name];
			if (entry === undefined) continue;
			const sev = fileFloor !== null && cmpVersion(entry.min, fileFloor) <= 0 ? "ok" : "blocker";
			push({
				api: `${imp.specifier} → { ${name} }`, min: entry.min, sev,
				kind: "esm-named-import", line: imp.line, src: entry.src,
				note: "ESM 具名导入不存在的导出 → 链接期 SyntaxError: The requested module does not provide an export named ...（插件整体加载失败）"
			});
		}
	}

	// 2) 动态 import / require 里的内建模块
	for (const ref of findDynamicBuiltinRefs(masked)) {
		const modMin = BUILTIN_MODULE_MIN[ref.specifier];
		if (modMin === undefined) continue;
		const sev = fileFloor !== null && cmpVersion(modMin.min, fileFloor) <= 0 ? "ok" : "high";
		push({ api: `${ref.specifier}（动态引用）`, min: modMin.min, sev, kind: "dynamic-builtin", line: ref.line, src: modMin.src, note: "低版本下抛 ERR_UNKNOWN_BUILTIN_MODULE" });
	}

	// 3) 运行期 API（浏览器产物只跑 non-node 规则）
	for (const rule of RUNTIME_RULES) {
		if (isBrowserBundle && rule.sev !== "ok") continue;
		const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
		let m;
		while ((m = re.exec(masked)) !== null) {
			const line = masked.slice(0, m.index).split("\n").length;
			const sev = rule.sev === "ok" ? "ok"
				: (fileFloor !== null && cmpVersion(rule.min, fileFloor) <= 0 ? "ok" : rule.sev);
			hits.push({
				file: rel, line, api: rule.id, min: rule.min, sev, kind: "runtime-api",
				verify: rule.verify === true, src: rule.src, note: rule.note ?? "",
				snippet: (lines[line - 1] ?? "").trim().slice(0, 160)
			});
			if (!rule.re.global) break;
		}
	}

	// 4) 语法规则
	for (const rule of SYNTAX_RULES) {
		if (isBrowserBundle && rule.sev !== "ok") continue;
		if (rule.cjsOnly && !/\.(cjs)$/.test(rel) && !/\.js$/.test(rel)) continue;
		const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
		let m;
		while ((m = re.exec(masked)) !== null) {
			const line = masked.slice(0, m.index).split("\n").length;
			const sev = rule.sev === "ok" ? "ok"
				: (fileFloor !== null && cmpVersion(rule.min, fileFloor) <= 0 ? "ok" : rule.sev);
			hits.push({
				file: rel, line, api: rule.id, min: rule.min, sev, kind: "syntax",
				verify: rule.verify === true, src: rule.src, note: rule.note ?? "",
				snippet: (lines[line - 1] ?? "").trim().slice(0, 160)
			});
			if (!rule.re.global) break;
		}
	}
	return hits;
}

function scanAll(files, pkg) {
	const all = [];
	for (const f of files) {
		const text = f.text !== undefined ? f.text : readFileSync(f.abs, "utf8");
		const rel = f.rel !== undefined ? f.rel : f.relPath;
		all.push(...scanFile(rel, text, pkg));
	}
	// 去重（同一文件同一行同一 API 只留一条）
	const seen = new Set();
	return all.filter((h) => {
		const k = `${h.file}:${h.line}:${h.api}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	}).sort((a, b) => (SEV_RANK[b.sev] - SEV_RANK[a.sev]) || a.file.localeCompare(b.file) || a.line - b.line);
}
//#endregion

//#region ---------- CLI ----------
function parseArgs(argv) {
	const opts = { root: null, tgz: null, level: "high", json: false, quiet: false, listRules: false, showOk: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--root") opts.root = argv[++i];
		else if (a === "--tgz") opts.tgz = argv[++i];
		else if (a === "--level") opts.level = argv[++i];
		else if (a === "--json") opts.json = true;
		else if (a === "--quiet") opts.quiet = true;
		else if (a === "--show-ok") opts.showOk = true;
		else if (a === "--list-rules") opts.listRules = true;
		else if (a === "--help" || a === "-h") opts.help = true;
		else { console.error(`unknown arg: ${a}`); opts.bad = true; }
	}
	return opts;
}

function printRules() {
	console.log("== node: 内建模块整体最低版本 ==");
	for (const [k, v] of Object.entries(BUILTIN_MODULE_MIN)) console.log(`  ${v.min.padEnd(9)} ${k}   (${v.src})`);
	console.log("\n== node: 内建具名导出最低版本（缺 0 时链接期 SyntaxError） ==");
	for (const [mod, exports] of Object.entries(BUILTIN_EXPORT_MIN)) {
		for (const [name, v] of Object.entries(exports)) console.log(`  ${v.min.padEnd(9)} ${mod} → { ${name} }   (${v.src})`);
	}
	console.log("\n== 运行期 API ==");
	for (const r of RUNTIME_RULES) console.log(`  ${r.min.padEnd(9)} ${r.sev.padEnd(7)} ${r.id}   (${r.src})`);
	console.log("\n== 语法 ==");
	for (const r of SYNTAX_RULES) console.log(`  ${r.min.padEnd(9)} ${r.sev.padEnd(7)} ${r.id}   (${r.src})`);
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log("用法: node rc2-compat-scan.mjs [--root <dir> | --tgz <file>] [--level blocker|high|medium|low|none] [--json] [--quiet] [--show-ok] [--list-rules]");
		process.exit(3);
	}
	if (opts.listRules) { printRules(); process.exit(0); }
	if (opts.bad) process.exit(3);

	let files, pkg, sourceLabel, warnings = [];
	if (opts.tgz !== null) {
		const tgz = resolve(opts.tgz);
		if (!existsSync(tgz)) { console.error(`tgz not found: ${tgz}`); process.exit(3); }
		const loaded = loadTgz(tgz);
		pkg = loaded.pkg;
		files = loaded.files.map((f) => ({ rel: f.rel, text: f.text }));
		sourceLabel = `tgz: ${relative(REPO_ROOT, tgz)} (${files.length} files)`;
	} else {
		// 默认 root（t13）：**从 cwd 向上找本包**（其次从脚本位置向上找）→ 脚本复制到哪儿都能自定位；
		// `--root <dir>` 仍可显式覆盖，行为与退出码语义不变。
		const detected = opts.root !== null ? resolve(opts.root) : (findPackageRoot(process.cwd()) ?? findPackageRoot(__dirname));
		if (detected === null) {
			console.error(`未找到 package.json（name=${PKG_NAME}）：请用 --root <dir> 指定包根目录（当前 cwd=${process.cwd()}）`);
			process.exit(3);
		}
		const root = detected;
		const listed = listShippedFiles(root);
		if (listed === null) { console.error(`package.json not found under: ${root}`); process.exit(3); }
		pkg = listed.pkg;
		warnings = listed.warnings ?? [];
		files = listed.files.map((abs) => ({ rel: relative(root, abs).split(sep).join("/"), abs }));
		sourceLabel = `dir: ${relative(REPO_ROOT, root) || "."} (${files.length} files)`;
	}
	if (files.length === 0) { console.error("未发现任何待扫描文件 —— 扫描覆盖为 0，不得视为通过"); process.exit(3); }

	const hits = scanAll(files, pkg);
	const floor = enginesFloor(pkg?.engines?.node);
	const blockers = hits.filter((h) => h.sev === "blocker");
	const highs = hits.filter((h) => h.sev === "high");
	const mediums = hits.filter((h) => h.sev === "medium");
	const lows = hits.filter((h) => h.sev === "low");
	const oks = hits.filter((h) => h.sev === "ok");
	// 实际最低要求 = 所有 blocker/high 命中里的最高 min（verify 规则不计入结论）
	const conclusive = hits.filter((h) => (h.sev === "blocker" || h.sev === "high") && h.verify !== true);
	const effective = conclusive.reduce((acc, h) => (acc === null || cmpVersion(h.min, acc) > 0 ? h.min : acc), null);

	if (opts.json) {
		console.log(JSON.stringify({
			source: sourceLabel, engines: pkg?.engines ?? null, declaredFloor: floor,
			effectiveFloor: effective, counts: { blocker: blockers.length, high: highs.length, medium: mediums.length, low: lows.length, ok: oks.length },
			hits: opts.showOk ? hits : hits.filter((h) => h.sev !== "ok")
		}, null, 2));
	} else {
		const show = (list, title) => {
			if (list.length === 0) return;
			console.log(`\n--- ${title} (${list.length}) ---`);
			const w = Math.max(...list.map((h) => h.file.length), 8);
			for (const h of list) {
				const flag = h.verify === true ? "?" : " ";
				console.log(`  [${h.sev}]${flag} ${h.file.padEnd(w)}:${String(h.line).padEnd(5)} ${h.api.padEnd(34)} min node >= ${h.min}`);
				if (!opts.quiet) {
					if (h.snippet !== "") console.log(`         code: ${h.snippet}`);
					if (h.note !== "") console.log(`         why : ${h.note}`);
					console.log(`         src : ${h.src}`);
				}
			}
		};
		console.log(`# rc2-compat-scan  source=${sourceLabel}`);
		console.log(`# scanned files: ${files.map((f) => f.rel).join(", ")}`);
		for (const w of warnings) console.log(`# WARN ${w}`);
		console.log(`# declared engines.node = ${pkg?.engines?.node ?? "(none)"}   floor=${floor ?? "?"}`);
		console.log(`# effective floor (blocker/high, 排除待人工核实项) = ${effective ?? "(none above floor)"}`);
		console.log(`# counts: blocker=${blockers.length} high=${highs.length} medium=${mediums.length} low=${lows.length} ok=${oks.length}`);
		show(blockers, "BLOCKER —— 链接期/解析期硬失败，插件整体加载失败");
		show(highs, "HIGH —— 运行期抛错（走到即炸）");
		show(mediums, "MEDIUM —— 条件性/降级行为");
		show(lows, "LOW —— 待人工核实（可能误报）");
		if (opts.showOk) show(oks, "OK —— 在 engines 下限内安全（仅供参考）");
		if (floor !== null && effective !== null && cmpVersion(effective, floor) > 0) {
			console.log(`\n结论：engines.node=${pkg.engines.node} 与实际最低要求 ${effective} 不一致 —— 修代码或提 engines（二者必居其一）。`);
		} else if (effective !== null) {
			console.log(`\n结论：实际最低要求 ${effective} ⊆ engines.node=${pkg?.engines?.node}。`);
		}
	}

	// 门禁退出码
	const gate = opts.level;
	if (gate === "none") process.exit(0);
	if (blockers.length > 0) process.exit(2);
	const over = (sev) => hits.some((h) => h.sev === sev && h.verify !== true);
	if (gate === "blocker") process.exit(0);
	if (gate === "high" || gate === "medium" || gate === "low") {
		if (over("high")) process.exit(1);
	}
	if (gate === "medium") { if (over("medium")) process.exit(1); }
	if (gate === "low") { if (over("medium") || over("low")) process.exit(1); }
	process.exit(0);
}

main();
//#endregion
