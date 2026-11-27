/**
 * envprobe.mjs — M1 环境探测：形态判定（web/desktop/unknown）+ DSH_HOME 权威化 + 端口候选。
 *
 * 设计契约：docs/桌面版移植-1.1.0设计.md 第 3 节。硬性约束：
 *   - **纯函数**：fs / env / homeDir / processTree 全部可注入（`fsx` 缺省时才用 node:fs），
 *     不做网络、不写盘；
 *   - 桌面判定：三档主判（0.9 / 0.8 / 0.7）+ 两档辅助（0.5 / 0.4）；`confidence` 取**主判**命中的最高值，
 *     辅助证据只记录、不单独把形态判成桌面版（否则"端口不一致"会把每个改过端口的网页版判成桌面版）；
 *   - 所有读文件的地方遇到 UTF-8 BOM **报告并剥离**（返回 `bomStripped` / `bomStrippedPaths` + 一条 warning），不静默；
 *   - 端口只产**有序去重候选**（上限 8），**绝不试连**：实际健康判定必须用 enginectl 的 `engineHealth`
 *     （HTTP 握手 + 身份指纹），裸 TCP 能连不算引擎（契约 §3 / F1）。
 *
 * @typedef {object} EnvProbe
 * @property {"web"|"desktop"|"unknown"} kind
 * @property {string|null} reason          判定依据（人类可读，中文）
 * @property {number} confidence           0..1
 * @property {string} dshHome              权威 DSH_HOME
 * @property {string[]} homeCandidates     检测到的所有候选 home（含来源说明）
 * @property {string|null} profileName     当前 profile 名
 * @property {string|null} profileDir      profile 绝对目录
 * @property {boolean} desktopLockPresent  profiles/desktop/lock 是否存在
 * @property {string|null} desktopLockText lock 文件内容（截断 200 字符）
 * @property {string|null} hostVersion     从 app 侧/包侧探到的宿主版本（可能 null）
 * @property {string|null} hostVersionSource "package.json" | "desktop-runtime.json" | null
 * @property {number[]} portCandidates     端口候选（有序，去重）
 * （以下是附加字段，供 M4/M5 直接复用，不改变上面的契约字段）
 * @property {string[]} codes              机器可读判定码
 * @property {object[]} reasons            全部证据（含未命中项，便于"灰着但告诉你为什么"）
 * @property {object[]} warnings           不静默的降级说明（每条带 code + 中文 message）
 * @property {object} desktopProfile       desktop profile 详情（目录/初始化/锁/patch）
 * @property {object} hostVersionDetail    版本探测明细（尝试过哪些产物）
 * @property {object[]} portCandidateDetails 每个端口候选的来源说明
 * @property {{found: boolean, files: string[]}} bomStripped BOM 上报
 */

import { readFileSync as readFileSyncNode, existsSync as existsSyncNode, statSync as statSyncNode } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// ports.mjs 是端口归一化的唯一事实来源（零依赖纯函数）；这里复用它的 normalizePort / 默认端口，
// 避免"1.1.0 又抄一份 3080"的漂移。
import { DEFAULT_ENGINE_PORT, normalizePort } from "./ports.mjs";

/** 桌面版保留 profile 名。 */
export const DESKTOP_PROFILE_NAME = "desktop";
/** 端口候选上限（契约 §3）。 */
export const PORT_CANDIDATE_LIMIT = 8;

const BOM_CHAR = 0xfeff;

/** 桌面可执行文件/进程名特征（任一命中即认为父进程链上有桌面版）。 */
const DESKTOP_PROCESS_PATTERNS = Object.freeze([
	/dsh[-_. ]?desktop/i,
	/deepseek[-_. ]?harness/i,
	/@deepseek-ai\/dsh-desktop/i,
	/harness[-_. ]?desktop/i,
	/dsh[-_. ]?app(?:\.exe)?/i
]);

/** 桌面版 userData 目录名的候选（Electron app name 在各版本/打包方式下不统一，宁可多试）。 */
const DESKTOP_USER_DATA_NAMES = Object.freeze(["DeepSeek Harness", "dsh-desktop", "DeepSeekHarness", "dsh"]);

// ---------------------------------------------------------------- 注入与基础 IO

/**
 * 解析可注入的 fs。注入的 fs 缺哪个函数就**明确不可用**（返回 null），
 * 不会偷偷回落到真实 node:fs —— 否则"纯函数"就是假的，单测会读到真机目录。
 */
function resolveFsx(fsx) {
	if (fsx && typeof fsx === "object") {
		return {
			readFileSync: typeof fsx.readFileSync === "function" ? fsx.readFileSync.bind(fsx) : null,
			existsSync: typeof fsx.existsSync === "function" ? fsx.existsSync.bind(fsx) : null,
			statSync: typeof fsx.statSync === "function" ? fsx.statSync.bind(fsx) : null
		};
	}
	return { readFileSync: readFileSyncNode, existsSync: existsSyncNode, statSync: statSyncNode };
}

/**
 * 剥离并统计 UTF-8 BOM（可重复 BOM 也计数）。导出给 M4/M5 复用。
 * @param {unknown} text
 * @returns {{text: string, bomStripped: boolean, bomCount: number}}
 */
export function stripBom(text) {
	const source = typeof text === "string" ? text : String(text ?? "");
	let count = 0;
	while (source.charCodeAt(count) === BOM_CHAR) count++;
	return { text: count > 0 ? source.slice(count) : source, bomStripped: count > 0, bomCount: count };
}

/**
 * 读文本文件并剥离 BOM。**任何失败都带机器可读 code + 中文 message**（绝不返回"空文件"糊弄）。
 * @returns {{ok: boolean, path: string, text: string|null, bomStripped: boolean, bomCount: number, code: string|null, message: string|null}}
 */
export function readTextStrippingBom(fsx, path) {
	if (!fsx || typeof fsx.readFileSync !== "function") {
		return {
			ok: false,
			path,
			text: null,
			bomStripped: false,
			bomCount: 0,
			code: "fs-unavailable",
			message: `${path} 未读取：注入的 fsx 缺少 readFileSync（fsx 不完整），本次探测无法读文件。`
		};
	}
	let raw;
	try {
		raw = fsx.readFileSync(path, "utf8");
	} catch (error) {
		const code = error?.code === "ENOENT" ? "file-missing" : error?.code === "EISDIR" ? "not-a-file" : "read-failed";
		return {
			ok: false,
			path,
			text: null,
			bomStripped: false,
			bomCount: 0,
			code,
			message: `${path} 读取失败（${code}）：${error?.message ?? String(error)}`
		};
	}
	const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
	const stripped = stripBom(text);
	return { ok: true, path, text: stripped.text, bomStripped: stripped.bomStripped, bomCount: stripped.bomCount, code: null, message: null };
}

/** 存在性探测：优先 existsSync → statSync → readFileSync 兜底（EISDIR 视为存在）。 */
function fsExists(fsx, path) {
	if (!fsx) return false;
	if (typeof fsx.existsSync === "function") {
		try {
			return Boolean(fsx.existsSync(path));
		} catch {
			return false;
		}
	}
	if (typeof fsx.statSync === "function") {
		try {
			fsx.statSync(path);
			return true;
		} catch {
			return false;
		}
	}
	if (typeof fsx.readFileSync === "function") {
		try {
			fsx.readFileSync(path);
			return true;
		} catch (error) {
			return error?.code === "EISDIR";
		}
	}
	return false;
}

function firstString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 跨平台路径比较（Windows 不分大小写；统一分隔符后小写比较）。 */
function samePath(a, b) {
	const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
	return norm(a) === norm(b);
}

// ---------------------------------------------------------------- DSH_HOME 权威化

/**
 * 列出"可能是桌面版 userData/harness"的候选（只保留**存在**的目录，避免一堆幻影路径）。
 * @returns {{paths: Array<{path: string, source: string}>, warnings: object[]}}
 */
function listDesktopSkillHomes({ env = {}, homeDir, platform = process.platform, fsx }) {
	const out = [];
	const warnings = [];
	const explicitUserData = firstString(env?.DSH_DESKTOP_USERDATA);
	if (explicitUserData) {
		const harness = join(explicitUserData, "harness");
		if (fsExists(fsx, harness)) {
			out.push({ path: harness, source: "桌面版 userData/harness（环境变量 DSH_DESKTOP_USERDATA）" });
		} else {
			warnings.push({
				code: "desktop-userdata-missing",
				message: `环境变量 DSH_DESKTOP_USERDATA=${explicitUserData} 指向的目录下没有 harness（${harness} 不存在），该候选已跳过。`
			});
		}
		return { paths: out, warnings };
	}
	let root = null;
	let rootSource = "";
	if (platform === "win32") {
		const appData = firstString(env?.APPDATA) ?? firstString(env?.LOCALAPPDATA);
		if (appData) {
			root = appData;
			rootSource = "%APPDATA%";
		}
	} else if (platform === "darwin") {
		root = join(homeDir, "Library", "Application Support");
		rootSource = "~/Library/Application Support";
	} else {
		root = firstString(env?.XDG_CONFIG_HOME) ?? join(homeDir, ".config");
		rootSource = "XDG_CONFIG_HOME";
	}
	if (root === null) {
		warnings.push({ code: "desktop-userdata-root-unknown", message: "无法推导桌面版 userData 根目录（缺 APPDATA/XDG_CONFIG_HOME/homeDir），跳过桌面 home 候选。" });
		return { paths: out, warnings };
	}
	for (const name of DESKTOP_USER_DATA_NAMES) {
		const harness = join(root, name, "harness");
		if (fsExists(fsx, harness)) out.push({ path: harness, source: `桌面版 userData/harness（${rootSource}/${name}）` });
	}
	return { paths: out, warnings };
}

/**
 * DSH_HOME 权威化（契约 §3，必须按序）：
 *   1. `process.env.DSH_HOME`（显式）；
 *   2. `$DSH_HOME` 与桌面 `userData/harness` 同时存在且不同 → **两个都报**，`authoritative` 取环境变量，并置一条 warning；
 *   3. `~/.dsh`（默认）。
 * 返回 `{authoritative, candidates[], warnings[], message}`：message 形如"检测到 N 个候选 home（存在 M 个）"。
 * @param {{env?: Record<string, string|undefined>, homeDir?: string|null, fsx?: object|null, platform?: string}} [opts]
 */
export function detectHomeCandidates({ env = process.env, homeDir = null, fsx = null, platform = process.platform } = {}) {
	const f = resolveFsx(fsx);
	const home = homeDir ?? homedir();
	const defaultHome = join(home, ".dsh");
	const warnings = [];
	if (!f.readFileSync) {
		warnings.push({ code: "fsx-incomplete", message: "注入的 fsx 缺少 readFileSync：候选 home 的存在性无法核实（exists 一律 false），请补全 fsx 后重跑。" });
	}
	const candidates = [];
	const add = (path, source) => {
		if (typeof path !== "string" || path.trim() === "") return;
		const existing = candidates.find((c) => samePath(c.path, path));
		if (existing) {
			if (!existing.sources.includes(source)) existing.sources.push(source);
			return;
		}
		candidates.push({ path, source, sources: [source], exists: fsExists(f, path), authoritative: false });
	};
	const envHome = firstString(env?.DSH_HOME);
	const envHomeProvided = envHome !== null;
	if (envHomeProvided) {
		add(envHome, "环境变量 DSH_HOME");
		if (!fsExists(f, envHome)) {
			warnings.push({ code: "home-missing", message: `环境变量 DSH_HOME 指向的目录不存在（${envHome}）；权威 home 仍取它（显式优先），但请确认是否写错。` });
		}
	}
	add(defaultHome, "默认 ~/.dsh（homeDir 推导）");
	const desktopHomes = listDesktopSkillHomes({ env, homeDir: home, platform, fsx: f });
	warnings.push(...desktopHomes.warnings);
	for (const d of desktopHomes.paths) add(d.path, d.source);

	const authoritative = envHomeProvided ? envHome : defaultHome;
	const authoritativeEntry = candidates.find((c) => samePath(c.path, authoritative));
	if (authoritativeEntry) authoritativeEntry.authoritative = true;
	const desktopDiffer = desktopHomes.paths.find((d) => !samePath(d.path, authoritative));
	if (desktopDiffer && fsExists(f, desktopDiffer.path)) {
		warnings.push({
			code: "home-candidates-conflict",
			message: `环境变量 DSH_HOME（${authoritative}）与桌面版 userData/harness（${desktopDiffer.path}）不是同一个目录：两者都已列入候选，权威取环境变量。若引擎实际用桌面 home，请显式指定 DSH_HOME，否则会读到错的那一份 profile。`
		});
	}
	const existingCount = candidates.filter((c) => c.exists).length;
	return {
		authoritative,
		envHomeProvided,
		candidates,
		warnings,
		count: candidates.length,
		existingCount,
		message: `检测到 ${candidates.length} 个候选 home（存在 ${existingCount} 个）：${candidates.map((c) => `${c.path}［${c.source}］`).join("；")}`
	};
}

// ---------------------------------------------------------------- 桌面判定

/** 进程描述归一化：宽容接受字符串 / {name,image,execPath,cmdline,...} 形态。 */
function asProcessEntry(raw) {
	if (typeof raw === "string") return { pid: null, ppid: null, name: raw, cmdline: raw };
	if (!raw || typeof raw !== "object") return null;
	const command = raw.cmdline ?? raw.command ?? raw.commandLine ?? raw.args ?? "";
	const cmdline = Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : "";
	const name =
		[raw.name, raw.image, raw.imageName, raw.execPath, raw.path, raw.file, raw.exe].find((v) => typeof v === "string" && v.trim() !== "") ?? "";
	return {
		pid: Number.isInteger(raw.pid) ? raw.pid : null,
		ppid: Number.isInteger(raw.ppid) ? raw.ppid : null,
		name: String(name),
		cmdline
	};
}

/**
 * 归一化调用方注入的 processTree。接受两种形态（契约 §6：用注入的假 processTree，不真枚举进程）：
 *   a) 数组：调用方按 self → 祖先 顺序排好的进程描述；
 *   b) `{selfPid, processes:[{pid, ppid, name, cmdline}]}`：按 ppid 从 selfPid 走到根。
 */
function normalizeProcessTree(processTree) {
	if (!processTree) return [];
	if (Array.isArray(processTree)) return processTree.map(asProcessEntry).filter(Boolean);
	if (typeof processTree !== "object") return [];
	const list = [processTree.processes, processTree.chain, processTree.list, processTree.entries].find(Array.isArray) ?? [];
	const entries = list.map(asProcessEntry).filter(Boolean);
	if (Number.isInteger(processTree.selfPid) && entries.some((e) => e.ppid !== null)) {
		const byPid = new Map(entries.filter((e) => e.pid !== null).map((e) => [e.pid, e]));
		const chain = [];
		const seen = new Set();
		let cursor = processTree.selfPid;
		while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
			seen.add(cursor);
			const hit = byPid.get(cursor);
			if (!hit) break;
			chain.push(hit);
			cursor = hit.ppid;
		}
		return chain;
	}
	return entries;
}

function matchDesktopProcess(entries) {
	const matches = [];
	for (const entry of entries) {
		const haystack = `${entry.name} ${entry.cmdline}`.trim();
		if (haystack === "") continue;
		const hit = DESKTOP_PROCESS_PATTERNS.find((re) => re.test(haystack));
		if (hit) matches.push({ name: entry.name || entry.cmdline, pattern: String(hit) });
	}
	return matches;
}

function versionCandidatePaths(fileName) {
	if (fileName === "package.json") {
		// profile 的 package.json 自己 version 常是 0.0.0；真正代表宿主的是依赖里 pin 的 @deepseek-ai/dsh。
		return ["dependencies['@deepseek-ai/dsh']", "devDependencies['@deepseek-ai/dsh']", "version"];
	}
	return [
		"dshVersion",
		"hostVersion",
		"appVersion",
		"dsh.version",
		"app.version",
		"host.version",
		"versions.dsh",
		"versions['@deepseek-ai/dsh']",
		"dependencies['@deepseek-ai/dsh']",
		"packages['@deepseek-ai/dsh'].version",
		"version"
	];
}

/** 小路径取值器：支持 `a.b` 与 `a['k']` / `a["k"]`。 */
function readPath(obj, path) {
	let current = obj;
	for (const segment of path.match(/[^.[\]]+|\[[^\]]+\]/g) ?? []) {
		if (current === null || typeof current !== "object") return undefined;
		const key = segment.startsWith("[") ? segment.slice(1, -1).replace(/^['"]|['"]$/g, "") : segment;
		current = current[key];
	}
	return current;
}

/** 版本号只做"像版本号"的粗校验：4 段测试版号（0.1.7-rc.1.20260924.1）必须原样通过，不做 semver 解析。 */
function looksLikeVersion(value) {
	return typeof value === "string" && value.trim() !== "" && value.trim().length <= 200 && /^\d[\w.+-]*$/.test(value.trim());
}

function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * 桌面判定。三档主判任一命中 → 桌面版（confidence 取命中的最高值）：
 *   - `ELECTRON_RUN_AS_NODE` 存在且父进程链含桌面可执行（0.9）
 *   - `<dshHome>/profiles/desktop` 存在且已初始化（有 package.json 或 lock）（0.8）
 *   - 当前 profile 名为保留名 `desktop`（0.7）
 * 两档辅助只记录、不单独定罪：`<profileDir>/.dsh-market/state.json` 存在（0.5）、观测端口 ≠ 配置端口（0.4）。
 *
 * @param {{fsx?: object|null, dshHome?: string|null, env?: object, processTree?: any, profileName?: string|null, observedPorts?: Array, profileDir?: string|null}} [opts]
 * @returns {{isDesktop: boolean, confidence: number, strength: string, reasons: object[], warnings: object[], locked: boolean, lockText: string|null, initialized: boolean, profileDir: string|null, bomStrippedPaths: string[], patch: object, electron: object, code: string, message: string}}
 */
export function detectDesktop({
	fsx = null,
	dshHome = null,
	env = process.env,
	processTree = null,
	profileName = null,
	observedPorts = [],
	profileDir = null
} = {}) {
	const f = resolveFsx(fsx);
	const reasons = [];
	const warnings = [];
	const bomStrippedPaths = [];
	const cleanProfileName = typeof profileName === "string" && profileName.trim() !== "" ? profileName.trim() : null;
	if (typeof dshHome !== "string" || dshHome.trim() === "") {
		const message = "detectDesktop 缺少 dshHome：无法检查 profiles/desktop，桌面判定为未执行（不是「不是桌面版」，请先解析 DSH_HOME）。";
		return {
			isDesktop: false,
			confidence: 0,
			strength: "none",
			reasons,
			warnings: [{ code: "desktop-probe-no-home", message }],
			locked: false,
			lockText: null,
			lockTextLength: 0,
			lockBomStripped: false,
			initialized: false,
			hasPackageJson: false,
			hasLock: false,
			hasPatch: false,
			marketStatePresent: false,
			profileDir: null,
			profileName: cleanProfileName,
			bomStrippedPaths,
			patch: { path: null, present: false, bomStripped: false, bomCount: 0 },
			electron: { envPresent: false, chainChecked: false, chainLength: 0, matched: [] },
			observedPort: null,
			code: "desktop-probe-no-home",
			message
		};
	}
	const dir = typeof profileDir === "string" && profileDir.trim() !== "" ? profileDir : join(dshHome, "profiles", DESKTOP_PROFILE_NAME);
	const packageFile = join(dir, "package.json");
	const lockFile = join(dir, "lock");
	const patchFile = join(dir, "cordis.patch.yml");
	const marketStateFile = join(dir, ".dsh-market", "state.json");

	const hasPackageJson = fsExists(f, packageFile);
	const lockExists = fsExists(f, lockFile);
	const hasPatch = fsExists(f, patchFile);
	const marketStatePresent = fsExists(f, marketStateFile);
	const initialized = hasPackageJson || lockExists;

	// lock 内容（截断 200 字符；BOM 必须报告并剥离）
	let lockText = null;
	let lockTextLength = 0;
	let lockBomStripped = false;
	if (lockExists) {
		const read = readTextStrippingBom(f, lockFile);
		if (read.ok) {
			lockBomStripped = read.bomStripped;
			lockTextLength = read.text.length;
			lockText = read.text.slice(0, 200);
			if (read.bomStripped) {
				bomStrippedPaths.push(lockFile);
				warnings.push({ code: "bom-stripped", path: lockFile, message: `检测到 UTF-8 BOM，已剥离后读取：${lockFile}（${read.bomCount} 个）；写回请保持无 BOM。` });
			}
		} else {
			warnings.push({ code: "desktop-lock-unreadable", path: lockFile, message: `profiles/desktop/lock 存在但读不出内容（${read.code}）：${read.message}` });
		}
	}

	// cordis.patch.yml（存在性 + BOM 上报；内容不在此解析）
	const patchRead = readTextStrippingBom(f, patchFile);
	let patchBomStripped = false;
	if (patchRead.ok && patchRead.bomStripped) {
		patchBomStripped = true;
		bomStrippedPaths.push(patchFile);
		warnings.push({ code: "bom-stripped", path: patchFile, message: `检测到 UTF-8 BOM，已剥离后识别：${patchFile}（${patchRead.bomCount} 个）；写回请保持无 BOM。` });
	}
	if (patchRead.ok && hasPatch) {
		reasons.push({ code: "desktop:patch-present", tier: 0, matched: true, message: `${patchFile} 存在（状态行文件在，桌面版 profile 结构完整）。` });
	}

	// 主判 0.9：ELECTRON_RUN_AS_NODE + 父进程链含桌面可执行
	const electronEnvPresent = env !== null && typeof env === "object" && env.ELECTRON_RUN_AS_NODE !== undefined && env.ELECTRON_RUN_AS_NODE !== null;
	const chain = normalizeProcessTree(processTree);
	const chainMatches = chain.length > 0 ? matchDesktopProcess(chain) : [];
	if (electronEnvPresent && chainMatches.length > 0) {
		reasons.push({
			code: "desktop:electron-chain",
			tier: 0.9,
			matched: true,
			message: `检测到 ELECTRON_RUN_AS_NODE，且父进程链含桌面可执行文件（${chainMatches.map((m) => m.name).join(" / ")}）：当前就是桌面版 Host。`
		});
	} else if (electronEnvPresent) {
		reasons.push({
			code: "desktop:electron-env-unverified",
			tier: 0.9,
			matched: false,
			message:
				chain.length === 0
					? "检测到 ELECTRON_RUN_AS_NODE，但调用方未提供 processTree，无法确认父进程链上是桌面可执行文件；按契约不按 0.9 判定。"
					: `检测到 ELECTRON_RUN_AS_NODE，但父进程链（${chain.length} 个进程）里没有桌面可执行特征；不按 0.9 判定。`
		});
		warnings.push({
			code: "electron-env-unverified",
			message: "存在 ELECTRON_RUN_AS_NODE 但父进程链不可核实：形态可能被低估为网页版。请在完整环境里注入真实 processTree 后重跑。"
		});
	} else {
		reasons.push({
			code: "desktop:no-electron-env",
			tier: 0.9,
			matched: false,
			message: "环境变量里没有 ELECTRON_RUN_AS_NODE（网页版引擎的正常形态）。"
		});
	}

	// 主判 0.8：profiles/desktop 存在且已初始化
	if (fsExists(f, dir) && initialized) {
		reasons.push({
			code: "desktop:profile-initialized",
			tier: 0.8,
			matched: true,
			message: `${dir} 存在且已初始化（${hasPackageJson ? "有 package.json" : ""}${hasPackageJson && lockExists ? " + " : ""}${lockExists ? "有 lock" : ""}）：存在桌面版独占 profile。`
		});
	} else {
		reasons.push({
			code: "desktop:no-initialized-profile",
			tier: 0.8,
			matched: false,
			message: `${dir} 不存在或未初始化（缺 package.json 与 lock）。`
		});
	}

	// 主判 0.7：当前 profile 名是保留名 desktop（调用方显式传入才算，避免自证循环）
	if (cleanProfileName === DESKTOP_PROFILE_NAME) {
		reasons.push({
			code: "desktop:reserved-profile-name",
			tier: 0.7,
			matched: true,
			message: `当前 profile 名是保留名「${DESKTOP_PROFILE_NAME}」（桌面版专用，web 模板里不存在这个名字）。`
		});
	} else {
		reasons.push({
			code: "desktop:profile-name-not-reserved",
			tier: 0.7,
			matched: false,
			message: `当前 profile 名是「${cleanProfileName ?? "未提供"}」，不是保留名「${DESKTOP_PROFILE_NAME}」。`
		});
	}

	// 辅助 0.5：.dsh-market/state.json
	if (marketStatePresent) {
		reasons.push({
			code: "desktop:market-state",
			tier: 0.5,
			matched: true,
			message: `${marketStateFile} 存在（桌面版侧车产物，辅助证据）。`
		});
	}

	// 辅助 0.4：观测端口 ≠ 配置端口（桌面版默认监听随机端口）
	const configuredPort = normalizePort(env?.DSH_ENGINE_PORT) ?? DEFAULT_ENGINE_PORT;
	const observedList = (Array.isArray(observedPorts) ? observedPorts : [])
		.map((item) => (item && typeof item === "object" ? item.port : item))
		.map((item) => normalizePort(item))
		.filter((item) => item !== null);
	const observedDiff = observedList.find((port) => port !== configuredPort) ?? null;
	if (observedDiff !== null) {
		reasons.push({
			code: "desktop:observed-port-differs",
			tier: 0.4,
			matched: true,
			message: `观测端口 ${observedDiff} ≠ 配置端口 ${configuredPort}（桌面版默认监听系统分配端口，辅助证据，不单独定罪）。`
		});
	}

	const mainMatched = reasons.filter((r) => r.matched && r.tier >= 0.7);
	// tier 0 是"上下文记录"（如 patch 存在），既不是主判也不是辅助置信度，不能拿来判形态。
	const auxMatched = reasons.filter((r) => r.matched && r.tier > 0 && r.tier < 0.7);
	const isDesktop = mainMatched.length > 0;
	const confidence = isDesktop ? Math.max(...mainMatched.map((r) => r.tier)) : 0;
	const topReason = isDesktop ? mainMatched.reduce((best, cur) => (cur.tier > best.tier ? cur : best)) : null;
	return {
		isDesktop,
		confidence,
		strength: isDesktop ? "strong" : auxMatched.length > 0 ? "auxiliary-only" : "none",
		reasons,
		warnings,
		locked: lockExists,
		lockText,
		lockTextLength,
		lockBomStripped,
		initialized,
		hasPackageJson,
		hasLock: lockExists,
		hasPatch,
		marketStatePresent,
		profileDir: dir,
		profileName: cleanProfileName,
		bomStrippedPaths,
		patch: { path: patchFile, present: hasPatch, bomStripped: patchBomStripped, bomCount: patchRead.bomCount, textAvailable: patchRead.ok },
		electron: { envPresent: electronEnvPresent, chainChecked: chain.length > 0, chainLength: chain.length, matched: chainMatches.map((m) => m.name) },
		observedPort: observedDiff,
		code: isDesktop
			? topReason.code
			: auxMatched.length > 0
				? "desktop-auxiliary-only"
				: "desktop-no-evidence",
		message: isDesktop
			? topReason.message
			: auxMatched.length > 0
				? "只命中辅助证据（.dsh-market/state.json 或端口不一致），不足以判定桌面版；按未知形态处理，需要更多证据。"
				: "未发现桌面版证据（无 ELECTRON_RUN_AS_NODE 命中、profiles/desktop 未初始化、profile 名非保留名）。"
	};
}

// ---------------------------------------------------------------- 宿主版本

/**
 * 宿主版本探测：**优先 app 侧产物**（桌面自带 CLI 不是 npm 的 dsh，F9）。
 * 读取顺序：`<dshHome>/profiles/desktop/desktop-runtime.json` → `.../package.json`
 * → `.../node_modules/@deepseek-ai/dsh/package.json`（兜底）。
 * 版本号**原样返回字符串**，不做 semver 解析（测试版可能是 4 段：0.1.7-rc.1.20260924.1）。
 * @param {{fsx?: object|null, dshHome?: string|null}} [opts]
 * @returns {{version: string|null, source: string|null, file: string|null, field: string|null, bomStripped: boolean, checked: object[], code: string, message: string}}
 */
export function probeHostVersion({ fsx = null, dshHome = null } = {}) {
	const f = resolveFsx(fsx);
	const checked = [];
	const empty = (code, message) => ({ version: null, source: null, file: null, field: null, bomStripped: false, checked, code, message });
	if (typeof dshHome !== "string" || dshHome.trim() === "") {
		return empty("host-version-no-home", "probeHostVersion 缺少 dshHome：无法读取 app 侧产物以确定宿主版本（不会回落到 npm 全局 dsh 的版本）。");
	}
	const profileDir = join(dshHome, "profiles", DESKTOP_PROFILE_NAME);
	const targets = [
		{ file: join(profileDir, "desktop-runtime.json"), source: "desktop-runtime.json" },
		{ file: join(profileDir, "package.json"), source: "package.json" },
		{ file: join(profileDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), source: "node_modules/@deepseek-ai/dsh/package.json" }
	];
	let bomStripped = false;
	for (const target of targets) {
		const read = readTextStrippingBom(f, target.file);
		checked.push({ file: target.file, ok: read.ok, code: read.code, bomStripped: read.bomStripped });
		if (!read.ok) continue;
		if (read.bomStripped) bomStripped = true;
		const json = safeJson(read.text);
		if (json === null) {
			checked[checked.length - 1].parseError = "JSON 解析失败";
			continue;
		}
		for (const field of versionCandidatePaths(target.source === "package.json" ? "package.json" : "other")) {
			const value = readPath(json, field);
			if (!looksLikeVersion(value)) continue;
			const source = target.source === "node_modules/@deepseek-ai/dsh/package.json" ? "package.json" : target.source;
			return {
				version: value.trim(),
				source,
				file: target.file,
				field,
				bomStripped,
				checked,
				code: "host-version-found",
				message: `宿主版本 ${value.trim()}（来自 ${source} 的 ${field}；原样返回，未做 semver 解析）。`
			};
		}
		checked[checked.length - 1].parseError = checked[checked.length - 1].parseError ?? "没有可识别的版本字段";
	}
	return empty(
		"host-version-unavailable",
		`未能从 ${profileDir} 的 app 侧产物（desktop-runtime.json / package.json / node_modules）读到宿主版本；不拿 npm 全局 dsh 冒充，宁可报 null。`
	);
}

// ---------------------------------------------------------------- 端口候选

function normalizeObserved(observedPorts, warnings) {
	const out = [];
	for (const item of Array.isArray(observedPorts) ? observedPorts : []) {
		const raw = item && typeof item === "object" ? item.port : item;
		const source = item && typeof item === "object" && typeof item.source === "string" && item.source.trim() !== "" ? item.source.trim() : null;
		const port = normalizePort(raw);
		if (port === null) {
			warnings.push({
				code: "observed-port-invalid",
				message: `调用方传入的观测端口 ${JSON.stringify(raw)} 不是合法端口（1-65535），已丢弃；请检查 Electron --port / netstat 的解析。`
			});
			continue;
		}
		out.push({ port, source: source ?? "调用方观测端口（Electron --port / netstat）" });
	}
	return out;
}

/**
 * 端口候选（契约 §3）：只产**有序去重候选**，上限 8，**绝不试连**。
 *
 * 顺序：`DSH_ENGINE_PORT` → `profiles/<p>/.open-boot.pid` 记录的端口 → 3080 → 调用方观测端口。
 *
 * ⚠️ 红线：本函数**不做任何连接/握手**。候选是否真是引擎，必须由调用方交给 enginectl 的
 * `engineHealth(port)`（HTTP 握手 + dsh 身份指纹：`dsh web authentication required` / `__DSH_BOOT__` 等）
 * 判定；**裸 TCP 能连不算引擎**（任何进程都能占端口）。
 * 参数里的 `healthFn` 只为调用方接线方便而接受，本函数**故意不调用**（test-capabilities.mjs 断言调用次数为 0）。
 *
 * @param {{env?: object, healthFn?: Function|null, fsx?: object|null, profileDir?: string|null, observedPorts?: Array<number|string|{port: any, source?: string}>, basePort?: number, limit?: number}} [opts]
 * @returns {{ports: number[], notes: object[], dropped: object[], warnings: object[], limit: number, message: string, verify: object, bomStrippedPaths: string[]}}
 */
export function resolvePortCandidates({
	env = process.env,
	healthFn = null,
	fsx = null,
	profileDir = null,
	observedPorts = [],
	basePort = DEFAULT_ENGINE_PORT,
	limit = PORT_CANDIDATE_LIMIT
} = {}) {
	const f = resolveFsx(fsx);
	const warnings = [];
	const bomStrippedPaths = [];
	const notes = [];
	const add = (port, source, extra = {}) => {
		const normalized = normalizePort(port);
		if (normalized === null) return;
		const existing = notes.find((n) => n.port === normalized);
		if (existing) {
			if (!existing.alsoFrom.includes(source)) existing.alsoFrom.push(source);
			return;
		}
		notes.push({ port: normalized, source, alsoFrom: [], ...extra });
	};

	// ① 环境变量
	const envPortRaw = env?.DSH_ENGINE_PORT;
	if (envPortRaw !== undefined && envPortRaw !== null) {
		const envPort = normalizePort(envPortRaw);
		if (envPort === null) {
			warnings.push({
				code: "port-env-invalid",
				message: `环境变量 DSH_ENGINE_PORT=${JSON.stringify(envPortRaw)} 不是合法端口（1-65535），已忽略；请按 lib/ports.mjs 的 normalizePort 规则修正。`
			});
		} else {
			add(envPort, "环境变量 DSH_ENGINE_PORT");
		}
	} else {
		warnings.push({ code: "port-env-absent", message: "环境变量 DSH_ENGINE_PORT 未设置：端口候选里没有显式配置值（这是桌面版的正常形态，Host 端口是系统分配的）。" });
	}

	// ② 启动器写的 .open-boot.pid
	if (typeof profileDir === "string" && profileDir.trim() !== "") {
		const pidFile = join(profileDir, ".open-boot.pid");
		const read = readTextStrippingBom(f, pidFile);
		if (read.ok) {
			if (read.bomStripped) {
				bomStrippedPaths.push(pidFile);
				warnings.push({ code: "bom-stripped", path: pidFile, message: `检测到 UTF-8 BOM，已剥离后解析：${pidFile}（${read.bomCount} 个）；写回请保持无 BOM。` });
			}
			const info = safeJson(read.text);
			const app = info && typeof info.app === "string" && info.app !== "" ? info.app : null;
			const appNote = app ? `（app=${app}）` : "";
			// 注意：本仓库 bin/open-boot.mjs 写进 `.open-boot.pid` 的 `port` 是**启动器**端口（默认 3081），
			// 不是引擎端口（实测 2026-11-26：profiles/web/.open-boot.pid → port=3081）。契约仍要求把它列为候选，
			// 这里照办但在来源里写明角色，避免调用方把启动器端口当引擎端口；桌面版若有 enginePort 字段则优先采信。
			const enginePortField = normalizePort(info?.enginePort);
			const pidPort = normalizePort(info?.port);
			if (enginePortField !== null) {
				add(enginePortField, `.open-boot.pid 的 enginePort 字段${appNote}`, { pidFile: true, field: "enginePort" });
			}
			if (pidPort !== null) {
				add(pidPort, `.open-boot.pid 记录的 port 字段${appNote}（本仓库里它是启动器端口，是否引擎须由 engineHealth 判定）`, {
					pidFile: true,
					field: "port"
				});
			}
			if (enginePortField === null && pidPort === null) {
				warnings.push({
					code: "pid-file-no-port",
					message: `${pidFile} 存在但读不到合法 port/enginePort 字段（旧格式或损坏），已跳过；不能据此判断引擎端口。`
				});
			}
		} else if (read.code !== "file-missing") {
			warnings.push({ code: "pid-file-unreadable", message: `${pidFile} 读取失败（${read.code}）：${read.message}` });
		}
	}

	// ③ 默认端口
	add(basePort, `默认端口 ${basePort}`);

	// ④ 调用方观测端口（桌面：Electron --port / netstat）
	for (const item of normalizeObserved(observedPorts, warnings)) add(item.port, item.source);

	const ports = notes.slice(0, limit).map((n) => n.port);
	const dropped = notes.slice(limit).map((n) => ({ port: n.port, source: n.source }));
	if (dropped.length > 0) {
		warnings.push({
			code: "port-candidates-truncated",
			message: `端口候选超过上限 ${limit} 个，已丢弃 ${dropped.length} 个（${dropped.map((d) => d.port).join(", ")}）；前 ${limit} 个优先级的候选保留。`
		});
	}
	const message = `${ports.length > 0 ? `端口候选 ${ports.length} 个（有序去重，上限 ${limit}）：${ports.join(", ")}` : "端口候选为空"}。说明：这里只产候选、绝不试连；实际健康判定必须用 enginectl 的 engineHealth（HTTP 握手 + 身份指纹），裸 TCP 通过不算引擎。`;
	return {
		ports,
		notes,
		dropped,
		warnings,
		limit,
		message,
		bomStrippedPaths,
		verify: {
			required: "engineHealth",
			provided: typeof healthFn === "function",
			invoked: false,
			note: "resolvePortCandidates 只产候选，不调用 healthFn；候选必须逐个交给 engineHealth 验证（HTTP 握手 + 身份指纹），裸 TCP 不算。"
		}
	};
}

// ---------------------------------------------------------------- 总探测

/**
 * 一次完整的环境探测（契约 §3 的 EnvProbe）。
 * @param {{env?: object, fsx?: object|null, homeDir?: string|null, processTree?: any, profileName?: string|null, observedPorts?: Array, healthFn?: Function|null, platform?: string}} [opts]
 * @returns {EnvProbe}
 */
export function probeEnv({
	env = process.env,
	fsx = null,
	homeDir = null,
	processTree = null,
	profileName = null,
	observedPorts = [],
	healthFn = null,
	platform = process.platform
} = {}) {
	const f = resolveFsx(fsx);
	const home = detectHomeCandidates({ env, homeDir, fsx: f, platform });
	const dshHome = home.authoritative;
	const desktopDir = join(dshHome, "profiles", DESKTOP_PROFILE_NAME);
	const desktopDirPresent = fsExists(f, desktopDir);
	const envProfile = firstString(env?.DSH_PROFILE);
	const explicitProfile = typeof profileName === "string" && profileName.trim() !== "" ? profileName.trim() : null;
	const currentProfile = explicitProfile ?? envProfile ?? (desktopDirPresent ? DESKTOP_PROFILE_NAME : "web");
	const profileDir = join(dshHome, "profiles", currentProfile);
	const desktop = detectDesktop({
		fsx: f,
		dshHome,
		env,
		processTree,
		// 只把**调用方显式给的** profile 名当作 0.7 证据（自动从目录反推会导致自证循环）
		profileName: explicitProfile ?? envProfile,
		observedPorts
	});
	const hostVersion = probeHostVersion({ fsx: f, dshHome });
	const port = resolvePortCandidates({ env, healthFn, fsx: f, profileDir, observedPorts });

	const reasons = [...desktop.reasons];
	const webReasons = [];
	let kind = "web";
	let confidence = 0;
	let reason = "";
	const codes = [];
	const electronEnvPresent = desktop.electron.envPresent;
	const electronVerified = desktop.electron.matched.length > 0;
	if (desktop.isDesktop) {
		kind = "desktop";
		confidence = desktop.confidence;
		const top = desktop.reasons.filter((r) => r.matched && r.tier === desktop.confidence)[0];
		reason = top?.message ?? desktop.message;
		codes.push(...desktop.reasons.filter((r) => r.matched).map((r) => r.code));
	} else if (electronEnvPresent && !electronVerified) {
		kind = "unknown";
		confidence = 0.5;
		reason =
			"检测到 ELECTRON_RUN_AS_NODE，但父进程链不可核实（未注入 processTree 或链上没有桌面可执行），形态无法判定；请注入真实 processTree 后在完整环境重跑，避免把桌面版误当网页版。";
		codes.push("unknown-electron-unverified");
		webReasons.push({ code: "unknown-electron-unverified", tier: 0, matched: false, message: reason });
	} else if (desktopDirPresent && !desktop.initialized) {
		kind = "unknown";
		confidence = 0.4;
		reason = `检测到 ${desktopDir} 目录，但缺 package.json 与 lock（未初始化）：无法判定是桌面版还是残留目录，按 unknown 处理，不启用任何桌面专属行为。`;
		codes.push("unknown-desktop-profile-uninitialized");
		webReasons.push({ code: "unknown-desktop-profile-uninitialized", tier: 0, matched: false, message: reason });
	} else {
		if (!electronEnvPresent) {
			webReasons.push({
				code: "web:no-electron-env",
				tier: 0.5,
				matched: true,
				message: "环境变量里没有 ELECTRON_RUN_AS_NODE → 当前不是 Electron 进程形态。"
			});
		}
		if (!desktopDirPresent) {
			webReasons.push({
				code: "web:desktop-profile-absent",
				tier: 0.7,
				matched: true,
				message: `${desktopDir} 不存在 → 不存在桌面版独占 profile。`
			});
		}
		if (!home.envHomeProvided) {
			webReasons.push({
				code: "web:default-home",
				tier: 0.4,
				matched: true,
				message: "DSH_HOME 未显式设置，按默认 ~/.dsh 解析 → 与网页版 dsh 的默认形态一致。"
			});
		}
		confidence = Math.max(0.3, ...webReasons.filter((r) => r.matched).map((r) => r.tier));
		reason = `未发现桌面版证据（无 ELECTRON_RUN_AS_NODE、${desktopDir} 不存在、当前 profile 名为 ${currentProfile}），按网页版处理：能力表全开（零回归）。`;
		codes.push(...webReasons.filter((r) => r.matched).map((r) => r.code));
	}
	reasons.push(...webReasons);

	const warnings = [...home.warnings, ...desktop.warnings, ...port.warnings];
	if (kind === "desktop" && hostVersion.version === null) warnings.push({ code: "host-version-unavailable", message: hostVersion.message });
	const bomStrippedPaths = [...desktop.bomStrippedPaths];
	if (hostVersion.bomStripped && hostVersion.file && !bomStrippedPaths.includes(hostVersion.file)) bomStrippedPaths.push(hostVersion.file);
	for (const p of port.bomStrippedPaths) if (!bomStrippedPaths.includes(p)) bomStrippedPaths.push(p);
	const bomStripped = { found: bomStrippedPaths.length > 0, files: bomStrippedPaths };

	/** @type {EnvProbe} */
	const result = {
		kind,
		reason,
		confidence,
		codes,
		reasons,
		warnings,
		dshHome,
		homeCandidates: home.candidates.map((c) => `${c.path}（来源：${c.source}）`),
		homeCandidateDetails: home.candidates,
		homeCandidateMessage: home.message,
		profileName: currentProfile,
		profileDir,
		desktopLockPresent: desktop.locked,
		desktopLockText: desktop.lockText,
		desktopProfile: {
			dir: desktop.profileDir,
			initialized: desktop.initialized,
			hasPackageJson: desktop.hasPackageJson,
			locked: desktop.locked,
			hasPatch: desktop.hasPatch,
			marketStatePresent: desktop.marketStatePresent,
			patchBomStripped: desktop.patch.bomStripped
		},
		hostVersion: hostVersion.version,
		hostVersionSource: hostVersion.source,
		hostVersionDetail: hostVersion,
		portCandidates: port.ports,
		portCandidateDetails: port.notes,
		portMessage: port.message,
		portVerify: port.verify,
		bomStripped,
		electron: desktop.electron
	};
	return result;
}
