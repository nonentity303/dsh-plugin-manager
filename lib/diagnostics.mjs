/**
 * diagnostics.mjs — 离线只读诊断报告（1.1.0 桌面版支持 M4，契约 F6 / F7 / F8）。
 *
 * 定位：**引擎外灾备**。官方 `fatal-recovery.ts` 再完善也在 Electron 进程里；
 * 进程起不来它就没了。本模块把"引擎起不来时到底发生了什么"变成一份用户能直接
 * 粘贴给插件作者/官方的中文/JSON 报告，而**不写一个字节**：
 *
 *   只读承诺（实现约束，改代码时不许破）：
 *   ① 只用 `node:fs` 的读取 API（readFileSync / readdirSync / statSync /
 *      openSync+readSync+closeSync）；本文件里**不允许出现**任何写/改/删/改名 API。
 *   ② 不 spawn / kill 任何进程，不启停引擎，不碰 profile 事务锁，不触发 checkpoint。
 *   ③ 不联网（端口探测只做本机回环 TCP connect），不从日志里解析 token —— 反而
 *      主动跳过 `logs/web.log`（里面有带 token 的登录链接）。
 *   ④ 缺一项就记 `unavailable` + 中文原因，绝不抛异常、绝不静默。
 *
 * 数据源（官方口径，见 `apps/desktop/docs/diagnostics/README.zh.md`）：
 *   - 桌面宿主：`<安装目录>/resources/app.asar/dsh/desktop-runtime.json` 的 `release`
 *     （`version` / `hostProtocolVersion` / `nodeVersion` / `pnpmVersion`）—— 桌面壳与 dsh
 *     版本绑定，`hostProtocolVersion` 是兼容性判断的关键字段。文件约 4.7 MB（含 2 万余条
 *     files），**只读前部 release 字段，绝不整读**。另报 `resources/runtime/versions.json`
 *     与桌面自带 CLI（`resources/runtime/cli/bin/dsh[.cmd]`，**不是 npm 的 dsh**）。
 *   - 桌面 profile：`<DSH_HOME>/profiles/desktop`，锁 = `<profile>/lock`（官方确定路径）。
 *   - 崩溃报告：`app.getPath('logs')/crash-<UTC>-<source>.log`，Windows/Linux 为
 *     `<userData>/logs`，macOS 为 `~/Library/Logs/DeepSeek Harness`；官方保留最新 10 份，
 *     本模块只取最新 3 份、每份只读前 4 KiB。
 *   - 插件操作记录：`<userData>/plugin-operations/{operations.jsonl,operations.previous.jsonl}`，
 *     NDJSON；官方读取上限 **64 KiB / 100 条**，本模块同口径。
 *   - Host 错误诊断：stderr **最后 64 KiB**；web profile 下即 `rescue-daemon.log`，
 *     直接复用 `lib/enginectl.mjs` 的 `readEngineLog()`。
 *
 * DSH_HOME 解析（官方 `@deepseek-ai/dsh-home-paths` 语义）：
 *   显式覆盖 > `$DSH_HOME`（空/纯空白视为未设置）> `~/.dsh`；`~` 前缀按用户主目录展开。
 *   桌面版另有 `<userData>/harness` 候选，**同时存在且不同**时两个都报并置 warning
 *   （契约 §3）。
 *
 * ⚠️ S1 正在实现 `lib/envprobe.mjs`（含 `detectHomeCandidates`）。本文件里的
 *    `detectHomeCandidates` 是**最小自足版本**；S1 落地后改为复用其实现，避免两份口径。
 */

import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probe, readEngineLog } from "./enginectl.mjs";
import { DEFAULT_ENGINE_PORT, normalizePort } from "./ports.mjs";

/** 报告 schema 版本（机器可读消费方据此判断字段变化）。 */
export const SCHEMA = "drydock-diagnostics/1";

/** 崩溃报告：官方保留最新 10 份；本模块只取最新 3 份。 */
export const CRASH_MAX_FILES = 3;
/** 崩溃报告每份只读前 4 KiB（官方"获取诊断报告"附件口径）。 */
export const CRASH_HEAD_BYTES = 4 * 1024;
/** 引擎日志尾部上限 = 官方"保留 stderr 最后 64 KiB"。 */
export const ENGINE_LOG_MAX_BYTES = 64 * 1024;
/** 插件操作记录读取上限：官方 64 KiB / 100 条。 */
export const OPERATIONS_MAX_BYTES = 64 * 1024;
export const OPERATIONS_MAX_RECORDS = 100;
/** desktop profile 的 lock 内容最多展示 200 字符（契约 §3 EnvProbe.desktopLockText）。 */
export const LOCK_TEXT_MAX = 200;
/** patch 文件正文片段上限（脱敏后进入报告，便于人工判断空 patch / BOM）。 */
const PATCH_EXCERPT_MAX = 400;
/**
 * 官方桌面包内 `desktop-runtime.json` 的 release 字段只在文件前部；整份约 4.7 MB（含 2 万条 files），
 * **绝不整读** —— 先读前 16 KiB 找 `"release"`，找不到再放宽到 128 KiB。
 */
const DESKTOP_RUNTIME_HEAD_BYTES = 16 * 1024;
const DESKTOP_RUNTIME_HEAD_MAX_BYTES = 128 * 1024;

const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

/** 官方崩溃报告文件名（与 `apps/desktop/src/crash-report.ts` 的 CRASH_REPORT_NAME 同口径）。 */
const CRASH_REPORT_NAME = /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:host|web-boot|renderer|main)\.log$/u;
const CRASH_SOURCES = ["host", "web-boot", "renderer", "main"];

// ------------------------------------------------------------------ 基础只读工具

/** stat 的安全包装：不存在/无权限 → null（不抛）。 */
function statSafe(path) {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function isFile(path) {
	const s = statSafe(path);
	return s !== null && s.isFile();
}

function isDir(path) {
	const s = statSafe(path);
	return s !== null && s.isDirectory();
}

/** readdir 的安全包装：目录不存在/无权限 → null（与"空目录"区分）。 */
function listDirSafe(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
			name: entry.name,
			isDir: entry.isDirectory(),
			isFile: entry.isFile()
		}));
	} catch {
		return null;
	}
}

/**
 * 只读文件头部 N 字节：崩溃报告只取前 4 KiB，避免把整份（最多 256 KiB）报告读进报告里。
 * 失败返回 null（调用方转成 unavailable，不抛）。
 */
function readHead(file, maxBytes) {
	let fd;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(maxBytes);
		const read = readSync(fd, buffer, 0, maxBytes, 0);
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* 只读句柄关闭失败不影响已经读到的内容 */
			}
		}
	}
}

/** 读整个文本文件（只读）。 */
function readTextSafe(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function readJsonSafe(file) {
	const text = readTextSafe(file);
	if (text === null) return { ok: false, error: "读取失败" };
	try {
		return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, "")) };
	} catch {
		return { ok: false, error: "JSON 解析失败（文件可能损坏，或被截断）" };
	}
}

// ------------------------------------------------------------------ 脱敏（硬要求）

/**
 * 令牌/密钥识别规则。宁可多打码：字段名命中即脱敏，不判断值"像不像"真令牌。
 * `mask` 收到 `(整段命中, ...捕获组)`，返回替换文本。
 */
const SECRET_RULES = [
	{
		kind: "疑似 API Key（sk-…）",
		re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{4,}/g,
		mask: () => "<已脱敏:API Key>"
	},
	{
		kind: "疑似 GitHub 令牌",
		re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/g,
		mask: () => "<已脱敏:GitHub 令牌>"
	},
	{
		kind: "疑似 Slack 令牌",
		re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
		mask: () => "<已脱敏:Slack 令牌>"
	},
	{
		kind: "疑似 AWS 访问密钥",
		re: /\bAKIA[0-9A-Z]{12,}/g,
		mask: () => "<已脱敏:AWS 密钥>"
	},
	{
		kind: "疑似 JWT",
		re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
		mask: () => "<已脱敏:JWT>"
	},
	{
		kind: "疑似 Bearer 令牌",
		re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
		mask: () => "Bearer <已脱敏>"
	},
	{
		kind: "字段型密钥（key/token/secret/password/credential）",
		re: /(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd|credential|token)(\s*[:=]\s*)(["']?)([A-Za-z0-9._~+/=-]{6,})\3/gi,
		mask: (whole, key, separator, quote) => `${key}${separator}${quote}<已脱敏>${quote}`
	},
	{
		kind: "疑似邮箱",
		re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
		mask: () => "<邮箱已脱敏>"
	}
];

/** 路径里的用户名段（`C:\Users\<x>` / `/home/<x>` / `/Users/<x>`）。 */
const USER_SEGMENT_RULES = [
	/([A-Za-z]:[\\/]Users[\\/])[^\\/\s"']+/g,
	/(\/home\/)[^/\s"']+/g,
	/(\/Users\/)[^/\s"']+/g
];

/** 控制字符清洗：保留 \n \t，其余不可见字符替换成 `·`（日志里常有 `^C`）。 */
function sanitizeText(value) {
	return String(value)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "·");
}

/** 一行化：多行文本压成单行（items.k/v 展示用）。 */
function oneLine(value) {
	return sanitizeText(value).replace(/\n+/g, " ⏎ ").trim();
}

function createRedactor({ homeDir }) {
	const stats = new Map();
	const hit = (kind, where) => {
		const seen = stats.get(kind);
		if (seen) {
			seen.count += 1;
			return;
		}
		stats.set(kind, { kind, count: 1, where: where ? oneLine(where) : null });
	};

	const scrubSecrets = (text, where) => {
		let out = text;
		for (const rule of SECRET_RULES) {
			out = out.replace(rule.re, (...args) => {
				hit(rule.kind, where);
				return rule.mask(...args);
			});
		}
		return out;
	};

	const userHome = String(homeDir ?? "").replace(/[\\/]+$/, "");
	const lowerHome = userHome.toLowerCase();

	/** 文本脱敏（令牌 + 邮箱 + 路径用户名），返回可直接进报告的安全字符串。 */
	const text = (raw, where) => {
		let out = sanitizeText(raw);
		const before = out;
		for (const rule of USER_SEGMENT_RULES) out = out.replace(rule, "$1<用户>");
		if (out !== before) hit("绝对路径中的用户名", where);
		return scrubSecrets(out, where);
	};

	/** 路径脱敏：主目录缩写为 `~`，其余绝对路径里的用户名打码。 */
	const path = (raw, where) => {
		if (raw === null || raw === undefined || raw === "") return null;
		let out = sanitizeText(raw);
		if (userHome && out.toLowerCase().startsWith(lowerHome)) {
			const boundary = out.length === userHome.length || /[\\/]/.test(out.charAt(userHome.length));
			if (boundary) {
				out = "~" + out.slice(userHome.length);
				hit("主目录路径缩写为 ~（用户名不上报）", where);
			}
		}
		const before = out;
		for (const rule of USER_SEGMENT_RULES) out = out.replace(rule, "$1<用户>");
		if (out !== before) hit("绝对路径中的用户名", where);
		return scrubSecrets(out, where);
	};

	/** 登记"主动跳过"的内容（不产生替换，只为在 redacted 里留痕）。 */
	const record = (kind, where) => hit(kind, where);

	const entries = () => [...stats.values()];

	return { text, path, record, entries };
}

// ------------------------------------------------------------------ DSH_HOME 解析

/** `~` / `~/x` / `~\x` 展开；其余原样返回（`expandHomePath` 官方语义）。 */
function expandTilde(value, homeDir) {
	const raw = String(value ?? "").trim();
	if (raw === "") return "";
	if (raw === "~") return homeDir;
	if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homeDir, raw.slice(2));
	return raw;
}

/**
 * 桌面版 userData 候选（Windows 常见位置 `%APPDATA%\<产品名>`）。
 * 官方打包默认 `%APPDATA%\@deepseek-ai\dsh-desktop`（见 desktop README 的 settings.json 路径），
 * `DSH_DESKTOP_USER_DATA_DIR` 是官方开发/隔离用的覆盖变量。
 * 纯函数，不做 IO。
 */
export function defaultUserDataDirs({ env = process.env, homeDir = homedir(), platform = process.platform } = {}) {
	const out = [];
	const push = (dir) => {
		if (!dir) return;
		const normalized = resolve(dir);
		if (!out.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) out.push(normalized);
	};
	push(expandTilde(env.DSH_DESKTOP_USER_DATA_DIR, homeDir));
	if (platform === "win32") {
		if (env.APPDATA) {
			push(join(env.APPDATA, "@deepseek-ai", "dsh-desktop"));
			push(join(env.APPDATA, "DeepSeek Harness"));
			push(join(env.APPDATA, "dsh-desktop"));
		}
	} else if (platform === "darwin") {
		push(join(homeDir, "Library", "Application Support", "@deepseek-ai", "dsh-desktop"));
		push(join(homeDir, "Library", "Application Support", "DeepSeek Harness"));
	} else {
		if (env.XDG_CONFIG_HOME) push(join(env.XDG_CONFIG_HOME, "@deepseek-ai", "dsh-desktop"));
		push(join(homeDir, ".config", "@deepseek-ai", "dsh-desktop"));
	}
	return out;
}

/**
 * `execPath` 是否**像桌面壳**（而不是 node.exe）。
 *
 * 背景（2026-11-26 真实反馈）：drydock 通常跑在 dsh 引擎的普通 Node 进程里，
 * `process.execPath` 是 `node.exe` —— 用它反推出 `<node目录>/resources`
 * （实测报出过 `C:\apps\node22\resources`）与桌面版**毫无关系**，是纯粹的误导。
 * 只有在 Electron / 桌面壳自己的进程里，`<exe目录>/resources` 才是真的。
 * 判据放宽（宁可多认）：非 node/node.exe 且名字里带 dsh/deepseek/harness/electron。
 */
export function looksLikeDesktopExecutable(execPath) {
	if (typeof execPath !== "string" || execPath === "") return false;
	const base = basename(execPath).toLowerCase();
	if (base === "node" || base === "node.exe" || base === "nodejs" || base === "nodejs.exe") return false;
	return /(?:dsh|deepseek|harness|electron)/.test(base);
}

/**
 * 发现**自定义安装目录**的桌面版（不依赖官方默认路径模板）。
 *
 * 为什么需要（2026-11-26 真实反馈）：官方装到 `%LOCALAPPDATA%\Programs\<产品名>`，
 * 但**社区改版 / 自定义安装**可以叫任何名字（实测 `%LOCALAPPDATA%\Programs\DSH NEXT`），
 * 只靠固定模板路径必然漏 → doctor 报 `desktopHost.found: false`，用户以为工具不支持桌面版。
 *
 * 做法：扫已知安装根的**一层子目录**，凡是自身带 `resources\` 且 resources 下有
 * `app.asar` / `dsh` / `app` 的，就认作桌面安装目录。全部只读，目录不存在或无权限一律跳过。
 * 不引入子进程（注册表/进程反推留给调用方，避免给诊断模块加执行依赖）。
 *
 * @returns {string[]} resources 目录绝对路径（去重）
 */
export function discoverDesktopInstalls({ env = {}, platform = process.platform, fsx = null } = {}) {
	const readdir = fsx?.readdirSync ?? readdirSync;
	const stat = fsx?.statSync ?? statSync;
	const out = [];
	const seen = new Set();
	const push = (dir) => {
		const key = dir.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push(dir);
	};
	const roots = [];
	const addRoot = (root) => {
		if (typeof root === "string" && root !== "" && !roots.includes(root)) roots.push(root);
	};
	if (platform === "win32") {
		if (env.LOCALAPPDATA) addRoot(join(env.LOCALAPPDATA, "Programs"));
		addRoot(env.ProgramFiles);
		addRoot(env["ProgramFiles(x86)"]);
	} else if (platform === "darwin") {
		addRoot("/Applications");
		addRoot(env.HOME ? join(env.HOME, "Applications") : null);
	} else {
		addRoot("/opt");
		addRoot("/usr/local");
	}
	for (const root of roots) {
		let children = [];
		try {
			children = readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const child of children) {
			if (child === null || typeof child !== "object" || child.isDirectory?.() !== true) continue;
			const installDir = join(root, child.name);
			const resources = join(installDir, "resources");
			try {
				if (!stat(resources).isDirectory()) continue;
			} catch {
				continue;
			}
			// ⚠️ 不能只看"有没有 resources"：Electron 应用（Xmind / VS Code / Slack…）全都有这个目录。
			// 实测本机 `%LOCALAPPDATA%\Programs\Xmind\resources` 就会被误认。必须命中 DSH 桌面版特征。
			if (!looksLikeDshDesktopInstall({ installDir, resources, stat, readFile: fsx?.readFileSync ?? readFileSync })) continue;
			push(resources);
		}
	}
	return out;
}

/**
 * 判断一个 `.../<产品名>/resources` 是不是 **DSH 桌面版**（而不是别的 Electron 应用）。
 *
 * 判据按可靠性排列，命中任一即可：
 *   ① 安装目录名像 DSH（`DSH NEXT` 这类社区改版就靠这条 —— 用户实测的正是它）；
 *   ② 有官方桌面版的**解包特征**：`app.asar.unpacked/dsh/`（真包 0.2.2-rc.5 解包确认存在），
 *      或已解包形态的 `dsh/desktop-runtime.json` / `dsh/package.json`；
 *   ③ 有 `app-update.yml` 且内容指向 deepseek 域（官方桌面版独有）。
 * @returns {boolean}
 */
function looksLikeDshDesktopInstall({ installDir, resources, stat = statSync, readFile = readFileSync }) {
	if (/(?:dsh|deepseek|harness)/i.test(basename(installDir))) return true;
	for (const marker of ["app.asar.unpacked/dsh", "dsh/desktop-runtime.json", "dsh/package.json"]) {
		try {
			stat(join(resources, ...marker.split("/")));
			return true;
		} catch {
			// 继续看下一个特征
		}
	}
	try {
		if (/deepseek/i.test(readFile(join(resources, "app-update.yml"), "utf8"))) return true;
	} catch {
		// 没有这个文件就到此为止
	}
	return false;
}

/**
 * 桌面版**安装目录/resources**候选（桌面宿主版本的唯一来源）。
 *
 * 官方事实（真包 0.2.2-rc.5 静态分析，lead 提供）：
 *   `resources/app.asar/dsh/desktop-runtime.json` 的 `release` =
 *   `{version, hostProtocolVersion, nodeVersion, pnpmVersion}` ——
 *   `hostProtocolVersion` 是**判断兼容性的关键字段**（桌面壳与 dsh 版本绑定）。
 *   该文件只在安装目录里，不在 profile 里。
 *
 * 推断顺序：`DSH_DESKTOP_RESOURCES_DIR`（drydock 的显式逃生门）> `process.resourcesPath`
 * （Electron / ELECTRON_RUN_AS_NODE 下存在）> `<execPath 所在目录>/resources`
 * （**仅当 execPath 本身像桌面壳**；node.exe 会被排除，见 looksLikeDesktopExecutable）。
 * 自定义安装目录不在这里 —— 由 `discoverDesktopInstalls()` 扫出来，调用方合并。
 * 普通 Node 进程下这些都是"候选"，不存在就由调用方记 unavailable，不报错。
 * 纯函数，不做 IO。
 */
export function defaultResourcesDirs({ env = process.env, homeDir = homedir(), platform = process.platform, execPath = process.execPath, resourcesPath = process.resourcesPath } = {}) {
	const out = [];
	const push = (dir) => {
		if (!dir) return;
		const expanded = expandTilde(dir, homeDir);
		if (expanded === "") return;
		const absolute = resolve(expanded);
		if (!out.some((existing) => existing.toLowerCase() === absolute.toLowerCase())) out.push(absolute);
	};
	push(env.DSH_DESKTOP_RESOURCES_DIR);
	if (typeof resourcesPath === "string") push(resourcesPath);
	if (looksLikeDesktopExecutable(execPath)) {
		const exeDir = dirname(execPath);
		push(join(exeDir, "resources"));
		if (platform === "darwin") push(join(dirname(exeDir), "Resources"));
		if (platform === "linux") push(join(dirname(exeDir), "resources"));
	}
	return out;
}

/** 从 `text[start] === "{"` 开始做括号配平，切出一个完整的 JSON 对象（字符串内的括号不计）。 */
function extractJsonObject(text, start) {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return null;
}

/**
 * 只读桌面包内 `desktop-runtime.json` 的 `release` 段（**有界读取**，绝不整读 4.7 MB）。
 * 返回 {exists, size, readBytes, release|null, error}。
 */
function readDesktopRuntimeRelease(file) {
	const stat = statSafe(file);
	if (stat === null || !stat.isFile()) return { exists: false, size: 0, readBytes: 0, release: null, error: null };
	let head = readHead(file, DESKTOP_RUNTIME_HEAD_BYTES);
	if (head === null) {
		return { exists: true, size: stat.size, readBytes: 0, release: null, error: "读取失败（app.asar 是打包归档时，普通 Node 进程读不到内部路径；请在桌面版进程内运行诊断）" };
	}
	if (!head.includes('"release"') && stat.size > head.length) {
		const wider = readHead(file, DESKTOP_RUNTIME_HEAD_MAX_BYTES);
		if (wider !== null) head = wider;
	}
	const keyIndex = head.indexOf('"release"');
	if (keyIndex < 0) {
		return { exists: true, size: stat.size, readBytes: head.length, release: null, error: "文件前部找不到 release 字段（为了不白烧内存，没有整读整份 JSON）" };
	}
	const braceIndex = head.indexOf("{", keyIndex);
	const slice = braceIndex < 0 ? null : extractJsonObject(head, braceIndex);
	if (slice === null) {
		return { exists: true, size: stat.size, readBytes: head.length, release: null, error: "release 对象未落在前部读取范围内（不整读大文件）" };
	}
	let parsed;
	try {
		parsed = JSON.parse(slice);
	} catch {
		return { exists: true, size: stat.size, readBytes: head.length, release: null, error: "release 字段 JSON 解析失败（文件可能损坏）" };
	}
	return {
		exists: true,
		size: stat.size,
		readBytes: head.length,
		release: {
			schemaVersion: Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : null,
			version: typeof parsed?.version === "string" ? parsed.version : null,
			hostProtocolVersion: Number.isInteger(parsed?.hostProtocolVersion) ? parsed.hostProtocolVersion : null,
			nodeVersion: typeof parsed?.nodeVersion === "string" ? parsed.nodeVersion : null,
			pnpmVersion: typeof parsed?.pnpmVersion === "string" ? parsed.pnpmVersion : null
		},
		error: null
	};
}

/** 桌面自带运行时版本文件 `resources/runtime/versions.json` = `{node, pnpm}`（小文件，可整读）。 */
function readRuntimeVersions(file) {
	const json = readJsonSafe(file);
	if (!json.ok) return null;
	const value = json.value ?? {};
	return {
		node: typeof value.node === "string" ? value.node : null,
		pnpm: typeof value.pnpm === "string" ? value.pnpm : null
	};
}

/**
 * 探测桌面宿主：安装目录 → `release` 字段 / 自带运行时版本 / 自带 CLI / app.asar 事实。
 * 只读；找不到就是 `found: null`（由段落渲染成 unavailable）。
 */
function collectDesktopHost({ resourcesDirs }) {
	const probed = resourcesDirs.map((dir) => ({ dir, exists: isDir(dir) }));
	for (const { dir, exists } of probed) {
		if (!exists) continue;
		const runtimePath = join(dir, "app.asar", "dsh", "desktop-runtime.json");
		const unpackedPath = join(dir, "app.asar.unpacked", "dsh", "desktop-runtime.json");
		const plainPath = join(dir, "dsh", "desktop-runtime.json");
		let runtime = readDesktopRuntimeRelease(runtimePath);
		let runtimeSource = runtimePath;
		if (!runtime.exists) {
			const unpacked = readDesktopRuntimeRelease(unpackedPath);
			if (unpacked.exists) {
				runtime = unpacked;
				runtimeSource = unpackedPath;
			}
		}
		if (!runtime.exists) {
			const plain = readDesktopRuntimeRelease(plainPath);
			if (plain.exists) {
				runtime = plain;
				runtimeSource = plainPath;
			}
		}
		const versions = readRuntimeVersions(join(dir, "runtime", "versions.json"));
		const cli = [join(dir, "runtime", "cli", "bin", "dsh.cmd"), join(dir, "runtime", "cli", "bin", "dsh")]
			.filter((file) => isFile(file));
		const asarStat = statSafe(join(dir, "app.asar"));
		const hasAnything = runtime.exists || versions !== null || cli.length > 0 || (asarStat !== null && asarStat.isFile());
		if (!hasAnything) continue;
		return {
			dir,
			probed,
			runtime,
			runtimeSource,
			versions,
			cli,
			asar: asarStat !== null && asarStat.isFile() ? { size: asarStat.size } : null
		};
	}
	return { dir: null, probed, runtime: null, versions: null, cli: [], asar: null };
}

/**
 * 系统 dsh（npm 全局安装的那个）——**与桌面自带 CLI 是两个包**，报告里必须分开。
 * 纯路径候选（不 spawn npm）：Windows `%APPDATA%/npm/node_modules`；POSIX 常见全局前缀。
 * （`lib/platform.js` 里有更全的候选链，但它会引入子进程能力；本模块坚持零进程，故只留最小纯路径版。）
 */
function readNpmGlobalDsh({ platform = process.platform, env = process.env, homeDir = homedir() } = {}) {
	const roots = [];
	const push = (root) => {
		if (!root) return;
		const absolute = resolve(expandTilde(root, homeDir));
		if (!roots.some((existing) => existing.toLowerCase() === absolute.toLowerCase())) roots.push(absolute);
	};
	if (platform === "win32") {
		if (env.APPDATA) push(join(env.APPDATA, "npm", "node_modules"));
		if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, "npm", "node_modules"));
	} else {
		push(join(homeDir, ".npm-global", "lib", "node_modules"));
		push(join(homeDir, ".local", "lib", "node_modules"));
		push("/usr/local/lib/node_modules");
		push("/usr/lib/node_modules");
	}
	for (const root of roots) {
		const manifest = join(root, "@deepseek-ai", "dsh", "package.json");
		const json = readJsonSafe(manifest);
		if (json.ok && typeof json.value?.version === "string") {
			return { found: true, version: json.value.version, manifest, roots };
		}
	}
	return { found: false, version: null, manifest: null, roots };
}

/**
 * DSH_HOME 候选探测（契约 §3，S1 `envprobe.detectHomeCandidates` 的最小自足版本）。
 *
 * 解析顺序（按序，全部候选都要报）：
 *   ① `dshHome` 显式覆盖（命令行 --home）   ② `$DSH_HOME`（空/空白 = 未设置）
 *   ③ `~/.dsh`                             ④ `<userData>/harness`（桌面版独占候选）
 * 权威值：显式覆盖 > $DSH_HOME > 默认/桌面里第一个存在的 > 默认。
 *
 * @returns {{authoritative: string|null, authoritativeSource: string, authoritativeExists: boolean,
 *   candidates: Array<{path: string, source: string, kind: string, exists: boolean}>, warnings: string[]}}
 */
export function detectHomeCandidates({ env = process.env, homeDir = homedir(), dshHome = null, userDataDirs = [] } = {}) {
	const candidates = [];
	const seen = new Set();
	const push = (raw, source, kind) => {
		const expanded = expandTilde(raw, homeDir);
		if (!expanded) return;
		const absolute = resolve(expanded);
		const key = absolute.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ path: absolute, source, kind, exists: isDir(absolute) });
	};

	push(dshHome, "命令行 --home（显式覆盖）", "explicit");
	push(env.DSH_HOME, "环境变量 DSH_HOME", "env");
	push(join(homeDir, ".dsh"), "默认位置 ~/.dsh", "default");
	for (const dir of userDataDirs) push(join(dir, "harness"), "桌面 userData/harness", "desktop");

	const explicit = candidates.find((candidate) => candidate.kind === "explicit");
	const fromEnv = candidates.find((candidate) => candidate.kind === "env");
	const authoritative = explicit ?? fromEnv ?? candidates.find((candidate) => candidate.exists) ?? candidates.find((candidate) => candidate.kind === "default") ?? null;

	const warnings = [];
	const existing = candidates.filter((candidate) => candidate.exists);
	if (existing.length > 1) {
		warnings.push(`检测到 ${existing.length} 个存在的 DSH_HOME 候选（${existing.map((candidate) => candidate.path).join("、")}）；权威值取「${authoritative ? authoritative.source : "无"}」，其余候选不会被本报告扫描。`);
	}
	if (authoritative && !authoritative.exists && existing.length > 0) {
		warnings.push(`权威 DSH_HOME（${authoritative.source}）指向的目录不存在：${authoritative.path}；检测到另一个候选存在（${existing[0].path}）。如确认要用后者，请加 --home 或修正环境变量。`);
	}

	return {
		authoritative: authoritative ? authoritative.path : null,
		authoritativeSource: authoritative ? authoritative.source : "未解析",
		authoritativeExists: authoritative !== null && authoritative.exists,
		candidates,
		warnings
	};
}

// ------------------------------------------------------------------ profile 读取

/** profile 目录里与诊断相关的小文件集合。 */
function readPatchInfo(file) {
	const stat = statSafe(file);
	if (stat === null || !stat.isFile()) return { exists: false };
	let buffer;
	try {
		buffer = readFileSync(file);
	} catch (error) {
		return { exists: true, error: `读取失败（${error.code ?? "未知错误"}）`, size: stat.size, mtimeMs: stat.mtimeMs };
	}
	const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
	let source = buffer.toString("utf8");
	if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
	const lines = source.split(/\r?\n/);
	const meaningful = lines.filter((line) => line.trim() !== "" && !/^\s*#/.test(line));
	const entryCount = lines.filter((line) => /^-\s/.test(line)).length;
	return {
		exists: true,
		error: null,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		bom,
		zeroByte: stat.size === 0,
		empty: stat.size === 0 || meaningful.length === 0,
		entryCount,
		excerpt: source.slice(0, PATCH_EXCERPT_MAX)
	};
}

function readLockInfo(file) {
	const stat = statSafe(file);
	if (stat === null || !stat.isFile()) return { exists: false };
	const text = readTextSafe(file);
	if (text === null) return { exists: true, size: stat.size, error: "读取失败" };
	const clipped = text.slice(0, LOCK_TEXT_MAX);
	return { exists: true, size: stat.size, text: clipped, truncated: text.length > LOCK_TEXT_MAX, error: null };
}

function readPidFile(file) {
	const stat = statSafe(file);
	if (stat === null || !stat.isFile()) return { exists: false };
	const raw = readTextSafe(file);
	if (raw === null) return { exists: true, error: "读取失败" };
	const text = raw.trim();
	if (text === "") return { exists: true, error: "文件为空", size: stat.size };
	if (text.startsWith("{")) {
		try {
			const parsed = JSON.parse(text);
			return {
				exists: true,
				raw: text,
				app: typeof parsed?.app === "string" ? parsed.app : null,
				pid: Number.isInteger(parsed?.pid) ? parsed.pid : null,
				port: normalizePort(parsed?.port),
				error: null,
				size: stat.size
			};
		} catch {
			return { exists: true, error: "JSON 解析失败", size: stat.size };
		}
	}
	const pid = Number.parseInt(text, 10);
	return { exists: true, raw: text, app: null, pid: Number.isInteger(pid) && pid > 0 ? pid : null, port: null, error: null, size: stat.size };
}

function readSidecarInfo(file) {
	const stat = statSafe(file);
	if (stat === null || !stat.isFile()) return { exists: false };
	const json = readJsonSafe(file);
	if (!json.ok) return { exists: true, size: stat.size, error: json.error };
	const parsed = json.value ?? {};
	const history = Array.isArray(parsed.history) ? parsed.history : [];
	const scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios : [];
	let latestHistoryAt = null;
	for (const item of history) {
		if (typeof item?.at !== "string") continue;
		const time = Date.parse(item.at);
		if (Number.isFinite(time) && (latestHistoryAt === null || time > latestHistoryAt)) latestHistoryAt = time;
	}
	return {
		exists: true,
		size: stat.size,
		error: null,
		version: Number.isInteger(parsed.version) ? parsed.version : null,
		historyCount: history.length,
		scenarioCount: scenarios.length,
		pendingRemovalCount: Array.isArray(parsed.pendingRemovals) ? parsed.pendingRemovals.length : 0,
		autoQuarantine: parsed?.rescue?.autoQuarantine === true,
		latestHistoryAt
	};
}

function readMarketState(file) {
	const stat = statSafe(file);
	if (stat === null || !stat.isFile()) return { exists: false };
	const json = readJsonSafe(file);
	if (!json.ok) return { exists: true, size: stat.size, error: json.error };
	const parsed = json.value ?? {};
	return {
		exists: true,
		size: stat.size,
		error: null,
		disabledCount: Array.isArray(parsed.disabled) ? parsed.disabled.length : 0,
		region: typeof parsed.region === "string" ? parsed.region : null
	};
}

function readProfileBundles(file) {
	const json = readJsonSafe(file);
	if (!json.ok) return { ok: false, error: json.error, bundles: [] };
	const bundles = json.value?.dsh?.profile?.bundles;
	if (!Array.isArray(bundles)) return { ok: true, present: false, bundles: [] };
	return { ok: true, present: true, bundles: bundles.filter((name) => typeof name === "string") };
}

/** 列出 profile 目录下与 patch / 备份 / 侧车相关的条目（只读一次 readdir）。 */
function listProfileEntries(dir) {
	const entries = listDirSafe(dir);
	const result = {
		patchBackupsOfficial: [],
		patchBackupsRescue: [],
		patchBackupsOther: [],
		rescueBackups: [],
		unreadable: entries === null
	};
	if (entries === null) return result;
	for (const entry of entries) {
		if (!entry.isFile) continue;
		const stat = statSafe(join(dir, entry.name));
		const mtimeMs = stat ? stat.mtimeMs : null;
		if (/^cordis\.patch\.yml\.bak-/.test(entry.name)) result.patchBackupsOfficial.push({ name: entry.name, mtimeMs });
		else if (/^cordis\.patch\.yml\.rescue-bak-/.test(entry.name)) result.patchBackupsRescue.push({ name: entry.name, mtimeMs });
		else if (/^cordis\.patch\.yml\./.test(entry.name)) result.patchBackupsOther.push({ name: entry.name, mtimeMs });
		if (/\.rescue-bak-/.test(entry.name)) result.rescueBackups.push({ name: entry.name, mtimeMs });
	}
	const byTime = (a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0);
	result.patchBackupsOfficial.sort(byTime);
	result.patchBackupsRescue.sort(byTime);
	result.patchBackupsOther.sort(byTime);
	result.rescueBackups.sort(byTime);
	return result;
}

function collectProfile(name, dir) {
	const exists = isDir(dir);
	if (!exists) return { name, dir, exists: false };
	const entries = listProfileEntries(dir);
	const profile = {
		name,
		dir,
		exists: true,
		packageJson: { exists: isFile(join(dir, "package.json")) },
		patch: readPatchInfo(join(dir, "cordis.patch.yml")),
		lock: readLockInfo(join(dir, "lock")),
		launcherPid: readPidFile(join(dir, ".open-boot.pid")),
		daemonPid: readPidFile(join(dir, ".rescue-daemon.pid")),
		sidecar: readSidecarInfo(join(dir, "plugin-manager.json")),
		market: readMarketState(join(dir, ".dsh-market", "state.json")),
		bundles: readProfileBundles(join(dir, "package.json")),
		engineLog: { exists: false, size: 0 },
		entries,
		warnings: []
	};
	const engineLogStat = statSafe(join(dir, "rescue-daemon.log"));
	if (engineLogStat !== null && engineLogStat.isFile()) profile.engineLog = { exists: true, size: engineLogStat.size };
	if (!profile.packageJson.exists) {
		profile.warnings.push(`profile「${name}」缺少 package.json：该目录可能不是已初始化的 profile（或已损坏）`);
	}
	if (profile.patch.exists && profile.patch.error === null && profile.patch.bom) {
		profile.warnings.push(`profile「${name}」的 cordis.patch.yml 带 UTF-8 BOM（契约要求读时报告并剥离、写时无 BOM）`);
	}
	if (profile.sidecar.exists && profile.sidecar.error) {
		profile.warnings.push(`profile「${name}」的 drydock 侧车 plugin-manager.json 无法使用：${profile.sidecar.error}`);
	}
	if (profile.patch.exists && profile.patch.error) {
		profile.warnings.push(`profile「${name}」的 cordis.patch.yml 无法读取：${profile.patch.error}`);
	}
	return profile;
}

/** 枚举（或聚焦）profile；`focus` 存在时只扫描它。 */
function scanProfiles({ dshHome, focus }) {
	if (focus) {
		const profile = collectProfile(focus.name, focus.dir);
		return {
			dir: join(dshHome, "profiles"),
			available: profile.exists,
			profiles: [profile],
			skipped: [],
			reason: profile.exists ? null : `未找到 profile「${focus.name}」：${focus.dir}`
		};
	}
	const profilesDir = join(dshHome, "profiles");
	const entries = listDirSafe(profilesDir);
	if (entries === null) {
		return { dir: profilesDir, available: false, profiles: [], skipped: [], reason: `profiles 目录不存在：${profilesDir}（DSH_HOME 可能尚未初始化）` };
	}
	const names = [];
	const skipped = [];
	for (const entry of entries) {
		if (!entry.isDir) continue;
		if (entry.name === "node_modules" || entry.name.startsWith(".")) {
			skipped.push(entry.name);
			continue;
		}
		names.push(entry.name);
	}
	names.sort();
	const profiles = names.map((name) => collectProfile(name, join(profilesDir, name)));
	return {
		dir: profilesDir,
		available: profiles.length > 0,
		profiles,
		skipped,
		reason: profiles.length > 0 ? null : `profiles 目录下没有任何 profile 子目录：${profilesDir}`
	};
}

// ------------------------------------------------------------------ 崩溃报告 / 操作记录

/**
 * 解析官方崩溃报告文件名 `crash-<UTC>-<source>.log`：
 * `2026-11-26T10-00-00-000Z`（':' 与 '.' 换成 '-'），source ∈ host / web-boot / renderer / main。
 * 不匹配官方命名但形如 `crash-*.log` 的文件也会解析出来，并把 `known` 标为 false。
 */
export function parseCrashFilename(name) {
	if (typeof name !== "string") return null;
	if (CRASH_REPORT_NAME.test(name)) {
		const body = name.slice("crash-".length, -".log".length);
		const source = CRASH_SOURCES.find((candidate) => body.endsWith(`-${candidate}`));
		const stamp = source ? body.slice(0, -(source.length + 1)) : null;
		return { name, known: true, source, stamp, iso: stamp ? normalizeCrashStamp(stamp) : null };
	}
	const lenient = /^crash-(.+)\.log$/i.exec(name);
	if (lenient === null) return null;
	const body = lenient[1];
	const source = CRASH_SOURCES.find((candidate) => body.endsWith(`-${candidate}`)) ?? null;
	let stamp = body;
	if (source) stamp = body.slice(0, -(source.length + 1));
	else {
		const index = body.lastIndexOf("-");
		if (index > 0) stamp = body.slice(0, index);
	}
	return { name, known: source !== null && /^\d{4}-\d{2}-\d{2}T/.test(stamp), source, stamp, iso: normalizeCrashStamp(stamp) };
}

/** `2026-11-26T10-00-00-000Z` → `2026-11-26T10:00:00.000Z`（解析不出就原样返回）。 */
function normalizeCrashStamp(stamp) {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp ?? "");
	if (match === null) return stamp ?? null;
	return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

/** 桌面版日志目录候选：Windows/Linux = `<userData>/logs`；macOS 另有平台日志目录。 */
function crashLogDirs({ userDataDirs, platform, homeDir }) {
	const dirs = userDataDirs.map((dir) => ({ dir: join(dir, "logs"), source: "userData/logs" }));
	if (platform === "darwin") dirs.unshift({ dir: join(homeDir, "Library", "Logs", "DeepSeek Harness"), source: "macOS 平台日志目录" });
	return dirs;
}

/** 收集最新 N 份崩溃报告（按 mtime 倒序；同名不重复）。 */
function collectCrashReports({ logDirs, redactor }) {
	const found = [];
	const probed = [];
	for (const { dir, source } of logDirs) {
		const entries = listDirSafe(dir);
		probed.push({ dir, source, exists: entries !== null });
		if (entries === null) continue;
		for (const entry of entries) {
			if (!entry.isFile || !/^crash-.*\.log$/i.test(entry.name)) continue;
			const file = join(dir, entry.name);
			const stat = statSafe(file);
			if (stat === null || !stat.isFile()) continue;
			const parsed = parseCrashFilename(entry.name);
			found.push({
				file,
				dir,
				dirSource: source,
				stat,
				parsed,
				name: entry.name
			});
		}
	}
	found.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
	return { probed, found, picked: found.slice(0, CRASH_MAX_FILES) };
}

const OPERATION_REASON_LABEL = { plugin: "插件开关", bundle: "bundle 变更", install: "安装", remove: "卸载" };
const OPERATION_STAGE_LABEL = { install: "安装", enable: "启用/停用", remove: "卸载" };
const OPERATION_APPLICATION_LABEL = { applied: "已应用", "restart-required": "下次启动生效", overridden: "被覆盖", failed: "失败", cancelled: "已取消" };
const OPERATION_PHASE_LABEL = { started: "开始记录（没有结束记录 → 结果未知）", settled: "已结束", unknown: "结果未知" };

/** 校验并渲染一条官方 PluginOperationRecord（未知字段一律显式标"未知"，不猜）。 */
function renderOperationRecord(record, redactor) {
	if (record === null || typeof record !== "object") return null;
	const operation = record.operation;
	if (operation === null || typeof operation !== "object") return null;
	if (typeof operation.time !== "string") return null;
	const phase = OPERATION_PHASE_LABEL[operation.phase] ? operation.phase : "unknown";
	const parts = [];
	parts.push(`${operation.time}`);
	parts.push(OPERATION_REASON_LABEL[operation.reason] ?? `变更原因未知（${String(operation.reason ?? "无")}）`);
	const target = typeof operation.target === "string" ? redactor.text(operation.target, "插件操作记录") : null;
	parts.push(target ? `目标 ${target}` : "目标 未记录");
	if (typeof operation.version === "string") parts.push(`版本 ${redactor.text(operation.version, "插件操作记录")}`);
	parts.push(`阶段 ${OPERATION_STAGE_LABEL[operation.stage] ?? "未知"}`);
	if (typeof operation.enabled === "boolean") parts.push(operation.enabled ? "启用" : "停用");
	parts.push(`状态 ${OPERATION_PHASE_LABEL[phase]}`);
	if (phase === "settled") {
		parts.push(`应用结果 ${OPERATION_APPLICATION_LABEL[operation.application] ?? "未知"}`);
		if (typeof operation.changed === "boolean") parts.push(operation.changed ? "已改动" : "未改动");
		if (typeof operation.errorCode === "string") parts.push(`错误码 ${redactor.text(operation.errorCode, "插件操作记录")}`);
		if (typeof operation.restartReason === "string") parts.push(`重启原因 ${redactor.text(operation.restartReason, "插件操作记录")}`);
	}
	if (typeof record.transportDropped === "number") parts.push(`传输丢弃计数 ${record.transportDropped}`);
	return parts.join(" · ");
}

/**
 * 读取 `<userData>/plugin-operations` 下的两个官方操作记录文件（只读、有界）。
 * 预算与官方一致：总量 64 KiB / 100 条；新段优先（`operations.jsonl` → `operations.previous.jsonl`）。
 */
function collectOperations({ userDataDirs, redactor }) {
	let dir = null;
	const probed = [];
	for (const candidate of userDataDirs) {
		const test = join(candidate, "plugin-operations");
		const exists = isDir(test);
		probed.push({ dir: test, exists });
		if (exists && dir === null) dir = test;
	}
	if (dir === null) {
		return { dir: null, probed, available: false, reason: `未找到插件操作记录目录（已探查 ${probed.map((entry) => entry.dir).join("、")}）；桌面版未安装或未产生记录时属正常。`, records: [], files: [], invalid: 0, truncated: false };
	}
	const fileNames = ["operations.jsonl", "operations.previous.jsonl"];
	const files = [];
	for (const name of fileNames) {
		const file = join(dir, name);
		const stat = statSafe(file);
		if (stat !== null && stat.isFile()) files.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs });
	}
	if (files.length === 0) {
		return { dir, probed, available: false, reason: `操作记录目录存在但没有 operations.jsonl / operations.previous.jsonl：${dir}`, records: [], files: [], invalid: 0, truncated: false };
	}
	const newestFirst = [];
	let bytes = 0;
	let invalid = 0;
	let truncated = false;
	for (const file of files) {
		if (newestFirst.length >= OPERATIONS_MAX_RECORDS || bytes >= OPERATIONS_MAX_BYTES) {
			truncated = true;
			break;
		}
		let raw;
		try {
			raw = readFileSync(file.file);
		} catch {
			continue;
		}
		const text = raw.toString("utf8");
		const lines = text.split(/\r?\n/);
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			if (newestFirst.length >= OPERATIONS_MAX_RECORDS) {
				truncated = true;
				break;
			}
			const line = lines[index].trim();
			if (line === "") continue;
			const lineBytes = Buffer.byteLength(line, "utf8");
			if (bytes + lineBytes > OPERATIONS_MAX_BYTES) {
				truncated = true;
				break;
			}
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch {
				invalid += 1;
				continue;
			}
			const rendered = renderOperationRecord(parsed, redactor);
			if (rendered === null) {
				invalid += 1;
				continue;
			}
			bytes += lineBytes;
			newestFirst.push({ file: file.name, text: rendered, time: typeof parsed.operation?.time === "string" ? parsed.operation.time : null });
		}
	}
	const records = newestFirst.reverse();
	if (files.length > 1) {
		// 官方读取顺序：新段 → 前驱段；展示时统一按"旧 → 新"排列，故前驱段记录本就在前面。
	}
	return {
		dir,
		probed,
		available: true,
		reason: null,
		records,
		files,
		readBytes: bytes,
		invalid,
		truncated
	};
}

// ------------------------------------------------------------------ 分类渲染

const STATUS_LABEL = { ok: "✓ 正常", warning: "⚠ 警告", unavailable: "○ 不可用" };

function displayWidth(text) {
	let width = 0;
	for (const char of String(text)) {
		const code = char.codePointAt(0);
		width += code > 0x2e7f ? 2 : 1;
	}
	return width;
}

function padRight(text, width) {
	const gap = Math.max(0, width - displayWidth(text));
	return String(text) + " ".repeat(gap);
}

function formatLocalTime(date) {
	const pad = (value) => String(value).padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const minutes = Math.abs(offset);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function formatValue(value) {
	if (value === null || value === undefined) return "（无）";
	if (typeof value === "boolean") return value ? "是" : "否";
	if (Array.isArray(value)) return value.join("、");
	return String(value);
}

function makeSection(id, title, status, items, reason) {
	const section = {
		id,
		title,
		status,
		items: items.map((item) => {
			const normalized = { k: oneLine(item.k), v: item.v };
			if (Object.prototype.hasOwnProperty.call(item, "note") && item.note !== null && item.note !== undefined) normalized.note = oneLine(item.note);
			return normalized;
		})
	};
	if (reason) section.reason = oneLine(reason);
	return section;
}

function plural(count, unit) {
	return `${count} ${unit}`;
}

function bytesLabel(size) {
	if (typeof size !== "number" || !Number.isFinite(size)) return "大小未知";
	if (size < 1024) return `${size} 字节`;
	if (size < 1024 * 1024) return `${size} 字节（约 ${(size / 1024).toFixed(1)} KiB）`;
	return `${size} 字节（约 ${(size / 1024 / 1024).toFixed(2)} MiB）`;
}

function latestLabel(list) {
	if (!Array.isArray(list) || list.length === 0) return null;
	const newest = list[0];
	return newest.mtimeMs ? `${newest.name}（${formatLocalTime(new Date(newest.mtimeMs))}）` : newest.name;
}

function okStat(statuses) {
	if (statuses.includes("warning")) return "warning";
	if (statuses.includes("ok")) return "ok";
	return "unavailable";
}

// ------------------------------------------------------------------ 主入口

/**
 * 收集离线只读诊断报告。
 *
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]        环境变量（测试注入）
 * @param {string} [opts.homeDir]                            用户主目录（测试注入；报告里缩写为 ~）
 * @param {string} [opts.platform]                           平台（测试注入）
 * @param {string} [opts.arch]                               架构（测试注入）
 * @param {string|null} [opts.dshHome]                       显式 DSH_HOME（--home）
 * @param {string|null} [opts.profile]                       profile 名或目录（--profile）
 * @param {boolean} [opts.includeLogs]                       是否包含引擎日志尾部（默认否）
 * @param {string[]|null} [opts.userDataDirs]                桌面版 userData 候选（测试注入）
 * @param {string[]|null} [opts.resourcesDirs]               桌面版安装目录 resources 候选（测试注入）
 * @param {(port:number)=>Promise<boolean>} [opts.probePort] 端口探测注入（默认 TCP connect）
 * @param {()=>Date|Date} [opts.now]                         生成时间注入（测试用）
 * @returns {Promise<object>} 报告对象（结构见 docs/桌面版移植-1.1.0设计.md §4 M4）
 */
export async function collectDiagnostics(opts = {}) {
	const env = opts.env ?? process.env;
	const homeDir = opts.homeDir ?? homedir();
	const platform = opts.platform ?? process.platform;
	const arch = opts.arch ?? process.arch;
	const includeLogs = opts.includeLogs === true;
	const now = typeof opts.now === "function" ? opts.now() : opts.now instanceof Date ? opts.now : new Date();
	const generatedAt = new Date(now);

	const redactor = createRedactor({ homeDir });
	const warnings = [];
	const warn = (message) => {
		const safe = oneLine(redactor.text(message, "警告"));
		if (!warnings.includes(safe)) warnings.push(safe);
	};

	const userDataDirs = (opts.userDataDirs ?? defaultUserDataDirs({ env, homeDir, platform })).map((dir) => resolve(dir));
	const resourcesDirs = (opts.resourcesDirs ?? [
		...defaultResourcesDirs({ env, homeDir, platform }),
		// 自定义安装目录（社区改版/非默认路径）：扫已知安装根的一层子目录
		...discoverDesktopInstalls({ env, platform })
	])
		.map((dir) => resolve(dir))
		.filter((dir, index, all) => all.findIndex((other) => other.toLowerCase() === dir.toLowerCase()) === index);
	const home = detectHomeCandidates({ env, homeDir, dshHome: opts.dshHome ?? null, userDataDirs });
	for (const message of home.warnings) warn(message);

	// ---- 聚焦 profile（--profile name|dir）
	let focus = null;
	if (typeof opts.profile === "string" && opts.profile.trim() !== "") {
		const raw = opts.profile.trim();
		const looksLikePath = /[\\/]/.test(raw) || raw === "." || raw === ".." || /^[A-Za-z]:/.test(raw);
		const asName = { name: raw, dir: join(home.authoritative ?? join(homeDir, ".dsh"), "profiles", raw) };
		const asPath = resolve(expandTilde(raw, homeDir));
		if (looksLikePath) focus = { name: basename(asPath), dir: asPath };
		else if (isDir(asName.dir)) focus = asName;
		else if (isDir(asPath)) focus = { name: basename(asPath), dir: asPath };
		else focus = asName;
	}

	const scanned = scanProfiles({ dshHome: home.authoritative ?? join(homeDir, ".dsh"), focus });
	const profiles = scanned.profiles.filter((profile) => profile.exists);

	// ---- 环境
	const tool = readToolInfo();
	const systemDsh = readNpmGlobalDsh({ platform, env, homeDir });
	const envItems = [
		{ k: "操作系统", v: `${platform} ${arch}` },
		{ k: "Node", v: process.versions.node ?? "未知" },
		{ k: "drydock", v: tool.version ? `${tool.name}@${tool.version}` : `${tool.name}（版本无法读取）` },
		{ k: "运行形态", v: typeof process.versions.electron === "string" ? `Electron 壳内（${process.versions.electron}）` : "Node 进程（非 Electron）" },
		{ k: "工作目录", v: redactor.path(process.cwd(), "环境") ?? "未知" },
		{ k: "DSH_HOME 环境变量", v: env.DSH_HOME && String(env.DSH_HOME).trim() !== "" ? redactor.text(String(env.DSH_HOME).trim(), "环境") : "未设置" },
		{ k: "DSH_HOME 解析优先级", v: "显式 --home > $DSH_HOME（空/纯空白视为未设置）> ~/.dsh（官方 dsh-home-paths 语义）" },
		{ k: "桌面 profile 路径", v: "<DSH_HOME>/profiles/desktop；锁 = <profile>/lock（官方确定路径，桌面版独占）" },
		{ k: "DSH_PROFILE 环境变量", v: env.DSH_PROFILE ? redactor.text(env.DSH_PROFILE, "环境") : "未设置" },
		{ k: "DSH_DESKTOP_USER_DATA_DIR", v: env.DSH_DESKTOP_USER_DATA_DIR ? redactor.path(env.DSH_DESKTOP_USER_DATA_DIR, "环境") : "未设置" },
		{ k: "DSH_DESKTOP_RESOURCES_DIR", v: env.DSH_DESKTOP_RESOURCES_DIR ? redactor.path(env.DSH_DESKTOP_RESOURCES_DIR, "环境") : "未设置" },
		{
			k: "系统 dsh（npm 全局）",
			v: systemDsh.found
				? `${systemDsh.version}（${redactor.path(systemDsh.manifest, "环境")}）`
				: "未找到（npm 全局 node_modules 里没有 @deepseek-ai/dsh；与桌面自带 CLI 无关）",
			note: systemDsh.found ? "这是 npm 安装的 dsh，和桌面版自带的 CLI 不是同一个包" : undefined
		}
	];

	// ---- DSH_HOME
	const homeItems = [
		{ k: "权威 DSH_HOME", v: home.authoritative ? redactor.path(home.authoritative, "DSH_HOME") : "无法解析" },
		{ k: "解析依据", v: home.authoritativeSource },
		{ k: "目录状态", v: home.authoritativeExists ? "存在" : "不存在" },
		{ k: "候选数量", v: plural(home.candidates.length, "个") }
	];
	home.candidates.forEach((candidate, index) => {
		homeItems.push({
			k: `候选 ${index + 1}`,
			v: `${redactor.path(candidate.path, "DSH_HOME 候选") ?? candidate.path}（${candidate.source}）`,
			note: candidate.exists ? "存在" : "不存在"
		});
	});
	const homeSection = makeSection(
		"home",
		"DSH_HOME",
		home.authoritativeExists ? okStat(["ok"]) : "unavailable",
		homeItems,
		home.authoritativeExists ? null : `权威 DSH_HOME 目录不存在或无法解析${home.authoritative ? `：${redactor.path(home.authoritative, "DSH_HOME")}` : ""}（可用 --home 指定）`
	);

	// ---- profile 清单
	const profileItems = [];
	const profileStatuses = [];
	for (const profile of scanned.profiles) {
		if (!profile.exists) {
			profileItems.push({ k: `profile ${profile.name}`, v: "目录不存在", note: redactor.path(profile.dir, "profile") ?? undefined });
			profileStatuses.push("unavailable");
			continue;
		}
		const before = profileItems.length;
		profileItems.push({ k: `profile ${profile.name}`, v: `目录：${redactor.path(profile.dir, "profile")}` });
		profileItems.push({ k: `${profile.name} / package.json`, v: profile.packageJson.exists ? "存在" : "缺失" });
		if (profile.patch.exists) {
			const bits = [];
			bits.push(bytesLabel(profile.patch.size));
			if (profile.patch.error) bits.push(profile.patch.error);
			else {
				bits.push(profile.patch.bom ? "带 UTF-8 BOM" : "无 BOM");
				bits.push(profile.patch.zeroByte ? "空 patch" : profile.patch.empty ? "仅注释/空白（空 patch）" : `${profile.patch.entryCount} 个顶层条目`);
				if (!profile.patch.empty && profile.patch.entryCount === 0) bits.push("没有任何 - 条目（可能是 [] 或纯注释的 patch）");
			}
			profileItems.push({ k: `${profile.name} / cordis.patch.yml`, v: bits.join("，") });
		} else {
			profileItems.push({ k: `${profile.name} / cordis.patch.yml`, v: "缺失" });
		}
		const backupBits = [];
		if (profile.entries.patchBackupsOfficial.length > 0) backupBits.push(`官方恢复备份 ${profile.entries.patchBackupsOfficial.length} 份`);
		if (profile.entries.patchBackupsRescue.length > 0) backupBits.push(`drydock .rescue-bak 备份 ${profile.entries.patchBackupsRescue.length} 份`);
		if (profile.entries.patchBackupsOther.length > 0) backupBits.push(`其它备份 ${profile.entries.patchBackupsOther.length} 份`);
		profileItems.push({ k: `${profile.name} / 备份`, v: backupBits.length > 0 ? backupBits.join("，") : "无" });
		profileItems.push({
			k: `${profile.name} / lock`,
			v: profile.lock.exists ? `存在（${bytesLabel(profile.lock.size)}${profile.lock.error ? `，${profile.lock.error}` : ""}）` : "不存在",
			note: profile.lock.exists && !profile.lock.error && profile.lock.text ? `内容（截断 ${LOCK_TEXT_MAX} 字符）：${redactor.text(profile.lock.text, "lock")}${profile.lock.truncated ? "…" : ""}` : undefined
		});
		profileItems.push({ k: `${profile.name} / .open-boot.pid`, v: pidLabel(profile.launcherPid) });
		profileItems.push({ k: `${profile.name} / .rescue-daemon.pid`, v: pidLabel(profile.daemonPid) });
		if (profile.sidecar.exists) {
			profileItems.push({
				k: `${profile.name} / plugin-manager.json（drydock 侧车）`,
				v: profile.sidecar.error
					? `存在但不可用：${profile.sidecar.error}`
					: `v${profile.sidecar.version ?? "?"}，历史 ${profile.sidecar.historyCount} 条，场景 ${profile.sidecar.scenarioCount} 个，待清理 ${profile.sidecar.pendingRemovalCount} 项`
			});
		} else {
			profileItems.push({ k: `${profile.name} / plugin-manager.json（drydock 侧车）`, v: "缺失（drydock 未在此 profile 留下侧车）" });
		}
		if (profile.market.exists) {
			profileItems.push({
				k: `${profile.name} / .dsh-market/state.json`,
				v: profile.market.error ? `存在但不可用：${profile.market.error}` : `${bytesLabel(profile.market.size)}；disabled ${profile.market.disabledCount} 项${profile.market.region ? `，region ${profile.market.region}` : ""}`
			});
		} else {
			profileItems.push({ k: `${profile.name} / .dsh-market/state.json`, v: "缺失" });
		}
		profileItems.push({ k: `${profile.name} / 引擎日志 rescue-daemon.log`, v: profile.engineLog.exists ? bytesLabel(profile.engineLog.size) : "缺失" });
		if (profile.patch.exists && profile.patch.error === null && profile.patch.excerpt.trim() !== "") {
			profileItems.push({
				k: `${profile.name} / cordis.patch.yml 片段`,
				v: redactor.text(profile.patch.excerpt, "cordis.patch.yml 片段"),
				note: `前 ${Math.min(profile.patch.excerpt.length, PATCH_EXCERPT_MAX)} 字符（已脱敏）`
			});
		}
		for (const message of profile.warnings) warn(message);
		profileStatuses.push(profile.warnings.length > 0 ? "warning" : "ok");
		if (profileItems.length === before) profileItems.push({ k: `profile ${profile.name}`, v: "无可用信息" });
	}
	if (scanned.skipped.length > 0) {
		profileItems.push({ k: "已跳过", v: scanned.skipped.join("、"), note: "非 profile 目录（node_modules / 隐藏目录）" });
	}
	const profilesSection = makeSection(
		"profiles",
		"profile 清单",
		scanned.available ? okStat(profileStatuses) : "unavailable",
		profileItems,
		scanned.reason
	);

	// ---- 桌面 profile 状态
	const desktopProfile = profiles.find((profile) => profile.name === "desktop") ?? collectProfile("desktop", join(home.authoritative ?? join(homeDir, ".dsh"), "profiles", "desktop"));
	const desktopItems = [];
	let desktopStatus = "unavailable";
	let desktopReason = null;
	if (!desktopProfile.exists) {
		desktopReason = `未找到桌面 profile：${redactor.path(desktopProfile.dir, "desktop")}（未安装官方桌面版，或桌面版尚未初始化；本机无桌面版时属正常）`;
	} else {
		const initialized = desktopProfile.packageJson.exists || desktopProfile.lock.exists;
		desktopItems.push({ k: "目录", v: redactor.path(desktopProfile.dir, "desktop") ?? "未知" });
		desktopItems.push({ k: "初始化", v: initialized ? "已初始化（有 package.json 或 lock）" : "未初始化（既无 package.json 也无 lock）" });
		desktopItems.push({
			k: "lock（进程生命周期单实例锁）",
			v: desktopProfile.lock.exists ? "存在" : "不存在",
			note: desktopProfile.lock.exists ? "Electron 正在运行或上次未正常退出：持锁期间禁止写操作（pnpm 增删 / 改 profile / 激活插件）" : "Electron 未持锁"
		});
		if (desktopProfile.lock.exists && desktopProfile.lock.text) {
			desktopItems.push({ k: "lock 内容", v: redactor.text(desktopProfile.lock.text, "desktop/lock"), note: `截断 ${LOCK_TEXT_MAX} 字符` });
		}
		desktopItems.push({
			k: "dsh.profile.bundles",
			v: desktopProfile.bundles.ok
				? desktopProfile.bundles.present
					? `${desktopProfile.bundles.bundles.length} 个：${desktopProfile.bundles.bundles.join("、")}`
					: "未声明（package.json 无 dsh.profile.bundles）"
				: `无法读取：${desktopProfile.bundles.error}`
		});
		desktopItems.push({
			k: "cordis.patch.yml",
			v: desktopProfile.patch.exists ? bytesLabel(desktopProfile.patch.size) : "缺失"
		});
		desktopStatus = initialized ? "ok" : "warning";
		if (desktopProfile.lock.exists) {
			warn(`桌面 profile 存在 lock 文件（${redactor.path(desktopProfile.dir, "desktop")}）：Electron 持锁期间一律不要写 profile。`);
		}
		if (!initialized) warn("桌面 profile 目录存在但没有 package.json / lock：可能只创建了目录，尚未真正初始化。");
	}
	const desktopSection = makeSection("desktop", "桌面 profile 状态", desktopStatus, desktopItems, desktopReason);

	// ---- 桌面宿主（安装目录：release.version / hostProtocolVersion —— 桌面壳与 dsh 版本绑定）
	const host = collectDesktopHost({ resourcesDirs });
	const hostItems = [];
	if (host.probed.length > 0) {
		hostItems.push({
			k: "探查目录",
			v: host.probed.map((entry) => `${redactor.path(entry.dir, "桌面宿主")}（${entry.exists ? "存在" : "不存在"}）`).join("；")
		});
	}
	let hostStatus = "unavailable";
	let hostReason = null;
	if (host.dir === null) {
		hostReason =
			host.probed.length === 0
				? "没找到桌面安装目录：普通 Node 进程没有 process.resourcesPath，也没有扫到自定义安装根；可设 DSH_DESKTOP_RESOURCES_DIR 指向 <安装目录>/resources"
				: `已扫描预设路径与自定义安装根（%LOCALAPPDATA%\\Programs、%ProgramFiles% 等，共 ${host.probed.length} 个候选）都没找到桌面安装目录；未安装桌面版时属正常。装在别处（如 D:\\Apps\\DSH、社区改版目录）时请设 DSH_DESKTOP_RESOURCES_DIR 指向 <安装目录>/resources`;
		if (desktopProfile.exists) {
			warn("存在桌面 profile，但没找到桌面安装目录：拿不到 release.version / hostProtocolVersion（桌面壳与 dsh 版本绑定，兼容性判断需要它）。");
		}
	} else {
		hostItems.push({ k: "桌面安装目录", v: redactor.path(host.dir, "桌面宿主") });
		const runtime = host.runtime;
		if (runtime && runtime.exists && runtime.release) {
			const release = runtime.release;
			hostItems.push({ k: "release.version", v: release.version ?? "未知" });
			hostItems.push({
				k: "release.hostProtocolVersion",
				v: release.hostProtocolVersion === null ? "未知" : release.hostProtocolVersion,
				note: "判断兼容性的关键字段：桌面壳与 dsh 版本绑定"
			});
			hostItems.push({ k: "release.nodeVersion", v: release.nodeVersion ?? "未知" });
			hostItems.push({ k: "release.pnpmVersion", v: release.pnpmVersion ?? "未知" });
			hostItems.push({ k: "release.platform / arch", v: `${platform} ${arch}` });
			hostItems.push({
				k: "读取方式",
				v: `只读文件前 ${bytesLabel(runtime.readBytes)}（文件共 ${bytesLabel(runtime.size)}）`,
				note: "desktop-runtime.json 含 2 万余条 files（约 4.7 MB），不整读，避免白烧内存"
			});
			hostStatus = "ok";
		} else if (runtime && runtime.exists) {
			hostItems.push({ k: "desktop-runtime.json", v: `存在但无法解析 release：${runtime.error}`, note: redactor.path(host.runtimeSource, "桌面宿主") ?? undefined });
			hostStatus = "warning";
			hostReason = runtime.error;
			warn(`桌面宿主 release 无法解析：${runtime.error}`);
		} else {
			hostItems.push({
				k: "desktop-runtime.json",
				v: "未找到（app.asar 内 dsh/desktop-runtime.json、app.asar.unpacked 或已解包的同名文件）",
				note: host.asar ? "app.asar 是打包归档（单个文件），普通 Node 进程读不到归档内部路径；请在桌面版进程内运行诊断，或解包后用 DSH_DESKTOP_RESOURCES_DIR 指向解包目录" : undefined
			});
			hostStatus = "warning";
		}
		if (host.versions) {
			hostItems.push({
				k: "桌面自带运行时（runtime/versions.json）",
				v: `node ${host.versions.node ?? "未知"} / pnpm ${host.versions.pnpm ?? "未知"}`,
				note: "桌面自带运行时（与系统 Node / npm 无关）"
			});
		} else {
			hostItems.push({ k: "桌面自带运行时（runtime/versions.json）", v: "缺失" });
		}
		hostItems.push({
			k: "桌面自带 CLI",
			v: host.cli.length > 0 ? `存在：${host.cli.map((file) => redactor.path(file, "桌面宿主")).join("、")}` : "缺失（runtime/cli/bin/dsh[.cmd]）",
			note: "桌面自带 CLI（Electron 可执行 + 内置 pnpm），不是 npm 的 dsh"
		});
		if (host.asar) hostItems.push({ k: "app.asar", v: `存在（${bytesLabel(host.asar.size)}，只读，未修改）` });
	}
	const desktopHostSection = makeSection("desktop-host", "桌面宿主", hostStatus, hostItems, hostReason);

	// ---- 官方恢复痕迹（F6：空 patch + 官方 .bak-<timestamp> 备份）
	const recoveryItems = [];
	const recoveryStatuses = [];
	for (const profile of profiles) {
		const official = profile.entries.patchBackupsOfficial;
		const emptyPatch = profile.patch.exists && profile.patch.error === null && profile.patch.empty;
		if (!emptyPatch && official.length === 0) {
			recoveryStatuses.push("ok");
			continue;
		}
		if (emptyPatch) {
			recoveryStatuses.push("warning");
			recoveryItems.push({ k: `profile ${profile.name}`, v: "检测到官方恢复痕迹" });
			recoveryItems.push({ k: `${profile.name} / cordis.patch.yml`, v: profile.patch.zeroByte ? "0 字节（官方恢复后下次启动会创建空 patch）" : "只有注释/空白（等同空 patch）" });
			if (official.length > 0) {
				recoveryItems.push({ k: `${profile.name} / 官方恢复备份`, v: official.map((entry) => entry.name).join("、") });
			} else {
				recoveryItems.push({ k: `${profile.name} / 官方恢复备份`, v: "未找到 cordis.patch.yml.bak-<时间戳>（也可能是手工清空）" });
			}
			recoveryItems.push({ k: `${profile.name} / 影响`, v: "归属行 / 开关行 / 隔离行全部丢失（已装包与备份保留；home 级 patch 不受影响）" });
			recoveryItems.push({
				k: `${profile.name} / 建议`,
				v: "恢复后自愈：用 drydock 侧车 plugin-manager.json 与 profile 内的 .rescue-bak-* 备份重建归属行；不要手工粘贴旧 patch（可能与当前已装包不一致）。",
				note: "F6：官方救活引擎的同时把运维层一起埋了，这是 drydock 的主要落点。"
			});
			warn(`profile「${profile.name}」检测到官方恢复痕迹：cordis.patch.yml 是空 patch${official.length > 0 ? `，官方备份 ${official.length} 份` : ""} → 建议走「恢复后自愈」（F6）。`);
		} else {
			recoveryStatuses.push("warning");
			recoveryItems.push({ k: `profile ${profile.name}`, v: "发现官方恢复备份，但当前 cordis.patch.yml 非空" });
			recoveryItems.push({ k: `${profile.name} / 官方恢复备份`, v: official.map((entry) => entry.name).join("、") });
			recoveryItems.push({ k: `${profile.name} / 说明`, v: "可能已经手工恢复或自愈过；请核对备份内容与当前已装包是否一致。" });
			warn(`profile「${profile.name}」存在官方恢复备份但 patch 非空：请核对是否已手工恢复。`);
		}
	}
	const recoverySection = makeSection(
		"recovery",
		"检测到官方恢复痕迹",
		profiles.length === 0 ? "unavailable" : okStat(recoveryStatuses),
		recoveryItems.length > 0 ? recoveryItems : [{ k: "结论", v: "未检测到官方恢复痕迹（没有空 patch，也没有 cordis.patch.yml.bak-<时间戳>）" }],
		profiles.length === 0 ? "没有可检查的 profile" : null
	);

	// ---- 崩溃报告
	const logDirs = crashLogDirs({ userDataDirs, platform, homeDir });
	const crash = collectCrashReports({ logDirs, redactor });
	const crashItems = [];
	const probedDirs = crash.probed.map((entry) => `${redactor.path(entry.dir, "崩溃报告目录") ?? entry.dir}（${entry.source}，${entry.exists ? "存在" : "不存在"}）`);
	crashItems.push({ k: "探查目录", v: probedDirs.join("；") });
	crashItems.push({ k: "保留口径", v: "官方保留最新 10 份崩溃报告；本报告只取最新 3 份，每份只读前 4 KiB" });
	let crashStatus = "unavailable";
	let crashReason = null;
	if (crash.probed.every((entry) => entry.exists === false)) {
		crashReason = "未找到桌面版日志目录（桌面版未安装时属正常；日志可能在别处，可用 DSH_DESKTOP_USER_DATA_DIR 指向真实 userData）";
	} else if (crash.picked.length === 0) {
		crashReason = "日志目录存在，但没有 crash-*.log（桌面版未发生过致命故障）";
	} else {
		crashStatus = "ok";
		crash.picked.forEach((report, index) => {
			const parsed = report.parsed;
			const source = parsed?.source ?? "未知";
			crashItems.push({
				k: `崩溃报告 ${index + 1}`,
				v: `${report.name}（来源=${source}${parsed?.iso ? `，时间=${parsed.iso}` : ""}，${bytesLabel(report.stat.size)}，mtime=${formatLocalTime(new Date(report.stat.mtimeMs))}）`
			});
			const head = readHead(report.file, CRASH_HEAD_BYTES);
			if (head === null) {
				crashItems.push({ k: `崩溃报告 ${index + 1} / 前 4 KiB`, v: "读取失败（文件被占用或无权限）" });
			} else {
				const excerpt = redactor.text(head, `崩溃报告 ${report.name}`);
				crashItems.push({ k: `崩溃报告 ${index + 1} / 前 4 KiB`, v: excerpt.trim() === "" ? "（文件为空）" : excerpt, note: "已脱敏；只读前 4 KiB" });
			}
		});
		if (crash.found.length > crash.picked.length) {
			crashItems.push({ k: "更早的报告", v: `另有 ${crash.found.length - crash.picked.length} 份未展开（最新 ${CRASH_MAX_FILES} 份之外）` });
		}
		warn(`发现 ${crash.found.length} 份崩溃报告（最新：${crash.picked[0].name}）。`);
	}
	const crashSection = makeSection("crash", "崩溃报告", crashStatus, crashItems, crashReason);

	// ---- 插件操作记录
	const operations = collectOperations({ userDataDirs, redactor });
	const operationItems = [];
	if (!operations.available) {
		operationItems.push({ k: "探查目录", v: operations.probed.map((entry) => `${redactor.path(entry.dir, "插件操作记录") ?? entry.dir}（${entry.exists ? "存在" : "不存在"}）`).join("；") });
	} else {
		operationItems.push({ k: "记录条数", v: `${operations.records.length} 条（上限 ${OPERATIONS_MAX_RECORDS} 条 / 64 KiB）` });
		operationItems.push({ k: "文件段", v: operations.files.map((file) => `${file.name}（${bytesLabel(file.size)}）`).join("、") });
		if (operations.invalid > 0) operationItems.push({ k: "无法解析的记录", v: `${operations.invalid} 条（已跳过，不代表操作未发生）` });
		operations.records.forEach((record, index) => {
			operationItems.push({ k: `记录 ${index + 1}`, v: record.text, note: record.file });
		});
		operationItems.push({ k: "口径", v: "操作记录只是上下文，不是崩溃因果证据；缺失记录、只有开始没有结束、损坏的历史都不能说明操作成功。" });
		if (operations.truncated) warn(`插件操作记录超过读取预算（${OPERATIONS_MAX_RECORDS} 条 / 64 KiB），只展示最新部分。`);
	}
	const operationsSection = makeSection("operations", "插件操作记录", operations.available ? "ok" : "unavailable", operationItems, operations.reason);

	// ---- 引擎日志
	const engineLogItems = [];
	const engineLogStatuses = [];
	const webLogFile = join(home.authoritative ?? join(homeDir, ".dsh"), "logs", "web.log");
	const webLogStat = statSafe(webLogFile);
	if (webLogStat !== null && webLogStat.isFile()) {
		engineLogItems.push({
			k: "logs/web.log",
			v: `存在（${bytesLabel(webLogStat.size)}）`,
			note: "内容未读取：该文件含带 token 的登录链接（契约红线：不解析日志取 token）"
		});
		redactor.record("跳过 logs/web.log 内容（内含带 token 的登录链接）", "logs/web.log");
	}
	for (const profile of profiles) {
		if (includeLogs) {
			const tail = readEngineLog(profile.dir, ENGINE_LOG_MAX_BYTES);
			if (tail.trim() === "") {
				engineLogStatuses.push("unavailable");
				engineLogItems.push({ k: `${profile.name} / rescue-daemon.log`, v: profile.engineLog.exists ? "文件存在但没有可读内容" : "缺失（桌面场景常见：Host 由 Electron 管理，stderr 在 userData/logs 的崩溃报告里）" });
				continue;
			}
			engineLogStatuses.push("ok");
			engineLogItems.push({ k: `${profile.name} / rescue-daemon.log 尾部`, v: redactor.text(tail, `引擎日志 ${profile.name}`), note: `最多尾部 64 KiB（官方口径）；已脱敏` });
		} else {
			engineLogStatuses.push("ok");
			engineLogItems.push({ k: `${profile.name} / 引擎日志`, v: profile.engineLog.exists ? `${bytesLabel(profile.engineLog.size)}（未展开，默认不含日志尾部）` : "缺失" });
		}
	}
	let engineLogStatus;
	let engineLogReason = null;
	if (!includeLogs) {
		engineLogStatus = "ok";
		engineLogItems.push({ k: "采集开关", v: "未采集引擎日志尾部（默认不含，避免报告变成长文）", note: "加 --include-logs 可包含；官方口径为 stderr 最后 64 KiB" });
	} else if (profiles.length === 0) {
		engineLogStatus = "unavailable";
		engineLogReason = "没有可检查的 profile，无法读取引擎日志";
	} else {
		engineLogStatus = okStat(engineLogStatuses);
		if (engineLogStatus !== "ok") engineLogReason = "profile 下没有可读的引擎日志（桌面场景 Log 通常在 userData/logs 的崩溃报告里）";
	}
	const engineLogSection = makeSection("engine-logs", "引擎日志", engineLogStatus, engineLogItems, engineLogReason);

	// ---- 端口事实（只报监听与否，**不断言引擎健康** —— 契约红线 3）
	const portCandidates = [];
	const pushPort = (raw, source) => {
		const port = normalizePort(raw);
		if (port === null) return;
		if (portCandidates.some((candidate) => candidate.port === port)) return;
		portCandidates.push({ port, source });
	};
	pushPort(env.DSH_ENGINE_PORT, "环境变量 DSH_ENGINE_PORT");
	for (const profile of profiles) {
		if (profile.launcherPid.exists && profile.launcherPid.port) pushPort(profile.launcherPid.port, `profiles/${profile.name}/.open-boot.pid`);
	}
	pushPort(DEFAULT_ENGINE_PORT, "默认引擎端口");
	const probePort = typeof opts.probePort === "function" ? opts.probePort : (port) => probe(port, 300);
	const portItems = [];
	const portStatuses = [];
	for (const candidate of portCandidates.slice(0, 8)) {
		let listening;
		try {
			listening = (await probePort(candidate.port)) === true;
		} catch (error) {
			listening = null;
		}
		portStatuses.push("ok");
		portItems.push({
			k: `端口 ${candidate.port}`,
			v: listening === null ? "探测失败（不代表没有监听）" : listening ? "有监听" : "无监听",
			note: candidate.source
		});
	}
	portItems.push({ k: "判定口径", v: "只报“端口是否有监听”，不代表引擎健康：引擎健康必须 HTTP 握手 + dsh 身份指纹（本报告不做该断言，避免把裸 TCP 监听当成引擎已就绪）" });
	const desktopProfileForPorts = profiles.find((profile) => profile.name === "desktop");
	if (desktopProfileForPorts) {
		portItems.push({ k: "桌面版端口", v: "官方默认系统分配随机端口，无法从磁盘枚举；本报告不猜测具体端口" });
	}
	const portSection = makeSection("ports", "端口事实", "ok", portItems);

	// ---- drydock 自身状态
	const drydockItems = [];
	const drydockStatuses = [];
	for (const profile of profiles) {
		if (!profile.sidecar.exists && profile.entries.rescueBackups.length === 0) {
			drydockStatuses.push("unavailable");
			drydockItems.push({ k: `profile ${profile.name}`, v: "没有 drydock 侧车与 .rescue-bak 备份（drydock 未在此 profile 运行过）" });
			continue;
		}
		drydockStatuses.push("ok");
		if (profile.sidecar.exists && !profile.sidecar.error) {
			drydockItems.push({
				k: `${profile.name} / 侧车历史`,
				v: `${profile.sidecar.historyCount} 条${profile.sidecar.latestHistoryAt ? `（最新 ${formatLocalTime(new Date(profile.sidecar.latestHistoryAt))}）` : ""}`
			});
			drydockItems.push({ k: `${profile.name} / 侧车场景`, v: `${profile.sidecar.scenarioCount} 个` });
			drydockItems.push({ k: `${profile.name} / 自动隔离`, v: profile.sidecar.autoQuarantine ? "开启" : "关闭" });
		} else if (profile.sidecar.exists) {
			drydockItems.push({ k: `${profile.name} / 侧车`, v: `不可用：${profile.sidecar.error}` });
		} else {
			drydockItems.push({ k: `${profile.name} / 侧车`, v: "缺失" });
		}
		drydockItems.push({
			k: `${profile.name} / .rescue-bak-* 备份`,
			v: profile.entries.rescueBackups.length > 0 ? `${profile.entries.rescueBackups.length} 份（最新 ${latestLabel(profile.entries.rescueBackups)}）` : "无"
		});
		const pmBackupDir = join(profile.dir, ".plugin-manager");
		const pmBackupEntries = listDirSafe(pmBackupDir);
		drydockItems.push({
			k: `${profile.name} / .plugin-manager 卸载备份目录`,
			v: pmBackupEntries === null ? "不存在" : `存在（${pmBackupEntries.length} 项）`
		});
	}
	const drydockSection = makeSection(
		"drydock",
		"drydock 自身状态",
		profiles.length === 0 ? "unavailable" : okStat(drydockStatuses),
		drydockItems.length > 0 ? drydockItems : [{ k: "结论", v: "没有可检查的 profile" }],
		profiles.length === 0 ? "没有可检查的 profile" : null
	);

	const sections = [
		makeSection("env", "环境", "ok", envItems),
		homeSection,
		profilesSection,
		desktopSection,
		desktopHostSection,
		recoverySection,
		crashSection,
		operationsSection,
		engineLogSection,
		portSection,
		drydockSection
	];
	// 段落 reason 里可能直接拼过原始绝对路径 → 统一再过一次脱敏（宁可多打码）
	for (const section of sections) {
		if (section.reason) section.reason = oneLine(redactor.text(section.reason, `段落 ${section.title}`));
	}

	// 端口有监听时给一条"别误读"的提示（不进入 warning：它不是故障）
	const listening = portItems.filter((item) => item.v === "有监听").length;
	if (listening > 0) {
		const ports = portItems.filter((item) => item.v === "有监听").map((item) => item.k.replace("端口 ", ""));
		sections.find((section) => section.id === "ports").items.push({
			k: "注意",
			v: `检测到 ${listening} 个端口有监听（${ports.join("、")}）：只说明有人占着这个端口，不说明是 dsh 引擎、更不说明它健康。`
		});
	}

	if (!home.authoritativeExists) {
		warn(homeSection.reason ?? "权威 DSH_HOME 不可用");
	}

	return {
		schema: SCHEMA,
		generatedAt: generatedAt.toISOString(),
		generatedAtLocal: formatLocalTime(generatedAt),
		mode: "read-only",
		tool,
		environment: {
			platform,
			arch,
			node: process.versions.node ?? null,
			electron: typeof process.versions.electron === "string" ? process.versions.electron : null,
			userHome: redactor.path(homeDir, "环境") ?? null,
			drydock: { name: tool.name, version: tool.version, source: tool.source },
			// 系统 dsh（npm 全局）与桌面自带 CLI 是两个包，报告里分开列
			systemDsh: {
				found: systemDsh.found,
				version: systemDsh.version,
				manifest: systemDsh.manifest ? redactor.path(systemDsh.manifest, "环境") : null
			}
		},
		// 桌面宿主：release.version / hostProtocolVersion 是兼容性判断的关键字段（桌面壳与 dsh 版本绑定）
		desktopHost: {
			found: host.dir !== null,
			dir: host.dir ? redactor.path(host.dir, "桌面宿主") : null,
			release: host.runtime?.release ?? null,
			runtimeSource: host.runtimeSource ? redactor.path(host.runtimeSource, "桌面宿主") : null,
			read: host.runtime ? { fileBytes: host.runtime.size, readBytes: host.runtime.readBytes } : null,
			versions: host.versions,
			cli: host.cli.map((file) => redactor.path(file, "桌面宿主")),
			asarBytes: host.asar ? host.asar.size : null,
			resourcesDirs: host.probed.map((entry) => ({ dir: redactor.path(entry.dir, "桌面宿主"), exists: entry.exists }))
		},
		home: {
			authoritative: home.authoritative ? redactor.path(home.authoritative, "DSH_HOME") : null,
			source: home.authoritativeSource,
			resolved: home.authoritativeExists,
			candidates: home.candidates.map((candidate) => ({ path: redactor.path(candidate.path, "DSH_HOME 候选"), source: candidate.source, exists: candidate.exists })),
			profilesDir: redactor.path(scanned.dir, "profiles") ?? null,
			focus: focus ? { name: focus.name, dir: redactor.path(focus.dir, "profile") } : null
		},
		sections,
		redacted: redactor.entries(),
		warnings,
		stats: {
			sections: sections.length,
			ok: sections.filter((section) => section.status === "ok").length,
			warning: sections.filter((section) => section.status === "warning").length,
			unavailable: sections.filter((section) => section.status === "unavailable").length,
			profiles: profiles.length,
			crashReportsFound: crash.found.length,
			operationRecords: operations.records.length
		}
	};
}

function pidLabel(info) {
	if (!info || !info.exists) return "不存在";
	if (info.error) return `存在但不可用：${info.error}`;
	const bits = [];
	if (info.app) bits.push(`app=${info.app}`);
	if (info.pid !== null && info.pid !== undefined) bits.push(`pid=${info.pid}`);
	if (info.port) bits.push(`port=${info.port}`);
	return bits.length > 0 ? `存在（${bits.join(" / ")}）` : "存在（内容无法识别）";
}

// ------------------------------------------------------------------ 中文报告渲染

/**
 * 把报告对象渲染成"人读中文报告"。所有字符串都已在收集阶段脱敏，这里不再碰原始数据。
 * @param {object} diagnostics collectDiagnostics() 的返回值
 * @returns {string} 多行中文报告（不含末尾换行）
 */
export function renderReport(diagnostics) {
	const lines = [];
	const rule = "═".repeat(72);
	lines.push(rule);
	lines.push("dsh-drydock 离线只读诊断报告");
	lines.push(rule);
	lines.push(`生成时间：${diagnostics.generatedAtLocal}（本机时区）`);
	lines.push(`工具：${diagnostics.tool.name}${diagnostics.tool.version ? ` ${diagnostics.tool.version}` : "（版本无法读取）"} ｜ 环境：${diagnostics.environment.platform} ${diagnostics.environment.arch} ｜ Node ${diagnostics.environment.node ?? "未知"}`);
	lines.push(`DSH_HOME：${diagnostics.home.authoritative ?? "无法解析"}（${diagnostics.home.source}）`);
	if (diagnostics.home.focus) lines.push(`聚焦 profile：${diagnostics.home.focus.name}（${diagnostics.home.focus.dir}）`);
	lines.push("只读声明：本报告只读取文件与探测本机端口；不写盘、不改 profile、不启停进程、不解析日志取 token。");
	lines.push("");

	diagnostics.sections.forEach((section, index) => {
		lines.push(`[${index + 1}] ${section.title}　${STATUS_LABEL[section.status] ?? section.status}`);
		if (section.reason) lines.push(`    ↳ 原因：${section.reason}`);
		if (section.items.length === 0) lines.push("    （无内容）");
		for (const item of section.items) {
			const value = formatValue(item.v);
			const keyWidth = displayWidth(item.k);
			const valueLines = value.split("\n");
			const longValue = valueLines.length > 1 || keyWidth + Math.min(displayWidth(value), 120) > 96;
			if (longValue) {
				lines.push(`    · ${item.k}：`);
				for (const line of valueLines) lines.push(`        ${line}`);
			} else {
				// 长键（例如 "web / plugin-manager.json（drydock 侧车）"）改用「键：值」同行，避免键值粘在一起
				const label = keyWidth >= 30 ? `${item.k}：` : padRight(item.k, 30);
				lines.push(`    · ${label}${value}`);
			}
			if (item.note) lines.push(`        ↳ ${item.note}`);
		}
		lines.push("");
	});

	if (diagnostics.redacted.length > 0) {
		lines.push(`— 脱敏登记（${diagnostics.redacted.length} 项）—`);
		for (const entry of diagnostics.redacted) {
			lines.push(`    · ${entry.kind} ×${entry.count}${entry.where ? `（首见：${entry.where}）` : ""}`);
		}
		lines.push("");
	} else {
		lines.push("— 脱敏登记 —");
		lines.push("    · 未命中任何令牌/邮箱/用户名字段（本报告仍只摘录了受控片段）");
		lines.push("");
	}

	if (diagnostics.warnings.length > 0) {
		lines.push(`— 警告（${diagnostics.warnings.length} 条）—`);
		diagnostics.warnings.forEach((message, index) => lines.push(`    ${index + 1}. ${message}`));
		lines.push("");
	} else {
		lines.push("— 警告 —");
		lines.push("    · 无");
		lines.push("");
	}

	const stats = diagnostics.stats ?? { sections: diagnostics.sections.length };
	lines.push(rule);
	lines.push(`统计：${stats.sections} 个段落（✓${stats.ok} / ⚠${stats.warning} / ○${stats.unavailable}）｜ profile ${stats.profiles} 个 ｜ 崩溃报告 ${stats.crashReportsFound} 份 ｜ 操作记录 ${stats.operationRecords} 条`);
	lines.push("用途：把本报告整段复制给插件作者或官方即可（已脱敏）；含「不可用」段不影响其余证据的可信度。");
	lines.push(rule);
	return lines.join("\n");
}

// ------------------------------------------------------------------ 内部小工具

function readToolInfo() {
	try {
		const parsed = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
		return {
			name: typeof parsed.name === "string" ? parsed.name : "dsh-drydock",
			version: typeof parsed.version === "string" ? parsed.version : null,
			source: "package.json"
		};
	} catch {
		return { name: "dsh-drydock", version: null, source: "unavailable" };
	}
}
