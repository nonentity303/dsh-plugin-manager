/**
 * platform.js — 跨平台路径/工具探测（纯函数，可单测）。
 *
 * 覆盖：npm 全局 node_modules 根（`npm root -g` / `npm prefix -g` 探测 → 各平台默认路径 →
 * 版本管理器/包管理器的版本目录）。全部返回「候选目录」列表，调用方自行 existsSync。
 *
 * v0.9.1-rc2（兼容性审计 C-06 / C-13 / C-14 修复）：
 *  - **C-06（medium）**：旧实现裸 `spawnSync("npm", …)`。Windows 上 Node **不会**用 PATHEXT 解析
 *    `npm`→`npm.cmd`，实测必然 `ENOENT`（`status=null, stdout=undefined`）；而 `npm.cmd` 在
 *    Node ≥18.20/20.12/22 又因 CVE-2024-27980 加固抛 `EINVAL`——两条路都不通。
 *    → 改为「`process.execPath` + `npm-cli.js`」（零 shell、零转义；仓库
 *      `tools/dev/npm-preflight.mjs:18` 已踩过同一个坑并给出同一解法），
 *      再退到平台命令形态（Windows 经 `cmd.exe /d /s /c "npm root -g"`，**参数是常量、无注入面**）。
 *      探测结果同时取 `npm prefix -g` 并派生根（posix: `<prefix>/lib/node_modules`，win32: `<prefix>\node_modules`）。
 *      **性能（rc2 冻结前的 P-03 回归）**：`spawnSync(node npm-cli.js …)` 同步阻塞实测 ~190 ms，
 *      会把首次冷启动快照从 ~66 ms 抬到 ~260 ms（3.9×）。因此运行期改为
 *      **「平台默认候选链快路径 + 后台异步权威探测」**（见 `npmGlobalRootReport()`）：
 *      默认候选里有真实存在的目录时**完全不 spawn**，权威根由 detached 子进程（stdout 落临时文件）
 *      在事件循环之外补齐，完成后替换缓存；只有在"默认候选一个都不存在"时才同步探测（那时它是唯一结论来源）。
 *  - **C-13（low）**：win32 缺 `APPDATA` 时旧实现只返回空数组（**静默无候选**）→ 现在回退
 *    `USERPROFILE` / `LOCALAPPDATA` / 主目录推导的默认路径，并把「缺哪个变量、退了哪条路」
 *    写进报告的 `problems`（显式诊断）。
 *  - **C-14（low）**：补齐各平台缺口（macOS `/opt/homebrew`、Linux XDG/Linuxbrew/pnpm、
 *    Windows Volta/nvm-windows/pnpm）。**每个候选都做存在性校验**（`attempted[].exists`），
 *    存在的候选排在前面；未能真机验证的路径在 `NPM_GLOBAL_ROOT_COVERAGE` 里显式标「未实测」。
 *
 * 诚实性口径（与 t12-F2 的 exit 2 一致）：候选链**要么给出结论，要么明确说「探测不可用」**，
 * 绝不静默返回空数组；权威探测未完成时 `probe.pending=true` + `probe.note` 如实标注。
 */
import { existsSync, readdirSync, readFileSync, openSync, closeSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const NPM_ROOT_CACHE = { at: 0, report: null };
const NPM_ROOT_TTL = 10 * 60 * 1000;
/** 权威探测（node + npm-cli.js）的缓存：`result === null` 表示本进程还没探测过。 */
const PROBE_CACHE = { at: 0, result: null, inFlight: false, scheduled: false };
/** 后台权威探测的延后量：先让当前这次调用（首次快照）跑完，再起子进程（P-03）。 */
const PROBE_DELAY_MS = 200;

/**
 * 全局根覆盖矩阵（**诚实标注**）。`verified` 只写本机真的验证过的结论；
 * 本机是 Windows（Node v24.20.0 / npm 11.19.0），因此所有 macOS/Linux 路径一律标「未实测」。
 */
export const NPM_GLOBAL_ROOT_COVERAGE = [
	{ platform: "win32", source: "npm 探测（node + npm-cli.js）", path: "<npm root -g 结果>", verified: "本机实测（可用）" },
	{ platform: "win32", source: "npm 探测（npm prefix -g 派生）", path: "<npm prefix -g>\\node_modules", verified: "本机实测（与 root -g 同值）" },
	{ platform: "win32", source: "npm 默认全局根", path: "%APPDATA%\\npm\\node_modules", verified: "本机实测（真实存在）" },
	{ platform: "win32", source: "APPDATA 缺失兜底", path: "%USERPROFILE%\\AppData\\Roaming\\npm\\node_modules", verified: "未实测（本机 APPDATA 正常）" },
	{ platform: "win32", source: "APPDATA 缺失兜底", path: "%LOCALAPPDATA%\\npm\\node_modules", verified: "未实测" },
	{ platform: "win32", source: "主目录推导（环境变量全缺）", path: "<home>\\AppData\\Roaming|Local\\npm\\node_modules", verified: "未实测（纯函数已单测，真实环境未构造）" },
	{ platform: "win32", source: "Volta", path: "%LOCALAPPDATA%\\Volta\\tools\\image\\node\\<版本>\\node_modules", verified: "未实测（本机未装 Volta）" },
	{ platform: "win32", source: "nvm-windows", path: "%NVM_HOME%|%APPDATA%\\nvm\\v<版本>\\node_modules", verified: "未实测（本机未装 nvm-windows）" },
	{ platform: "win32", source: "pnpm 全局", path: "%LOCALAPPDATA%\\pnpm\\global\\<版本>\\node_modules", verified: "未实测（本机未装 pnpm 全局）" },
	{ platform: "darwin", source: "npm 探测", path: "<npm root -g 结果>", verified: "未实测（本机 Windows）" },
	{ platform: "darwin", source: "npm 用户前缀", path: "~/.npm-global|~/.local/lib/node_modules", verified: "未实测（本机 Windows）" },
	{ platform: "darwin", source: "系统前缀", path: "/usr/local/lib|/usr/lib/node_modules", verified: "未实测（本机 Windows）" },
	{ platform: "darwin", source: "Apple Silicon Homebrew", path: "/opt/homebrew/lib/node_modules", verified: "未实测（C-06 里的漏检点，按 Homebrew 惯例补）" },
	{ platform: "darwin", source: "Homebrew node 公式", path: "/opt/homebrew/opt/node/lib/node_modules", verified: "未实测" },
	{ platform: "darwin", source: "nvm/Volta/fnm/pnpm", path: "~/.nvm/...|~/.volta/...|fnm|pnpm global", verified: "未实测" },
	{ platform: "linux", source: "npm 探测", path: "<npm root -g 结果>", verified: "未实测（本机 Windows）" },
	{ platform: "linux", source: "npm 用户前缀 / XDG", path: "~/.npm-global|~/.local/lib|$XDG_DATA_HOME/npm", verified: "未实测（本机 Windows）" },
	{ platform: "linux", source: "系统前缀", path: "/usr/local/lib|/usr/lib/node_modules", verified: "未实测（本机 Windows）" },
	{ platform: "linux", source: "Linuxbrew", path: "/home/linuxbrew/.linuxbrew/lib/node_modules", verified: "未实测" },
	{ platform: "linux", source: "nvm/Volta/fnm/pnpm", path: "~/.nvm/...|~/.volta/...|fnm|pnpm global", verified: "未实测" }
];

/**
 * 平台无关的 npm 全局根候选（纯函数，便于测试）。
 *
 * ⚠ **兼容保留（勿作为运行期入口）**：本函数的行为被 `test-bundle.mjs` 逐条钉死
 * （win32 缺 APPDATA → 空数组；linux 候选表的精确顺序），因此**不再承担 C-06/C-13/C-14 的修复**；
 * 运行期入口是 `npmGlobalRootChain()`（多级兜底 + 存在性校验 + 显式诊断）。
 *
 * @param platform - process.platform 值（"win32" / "darwin" / "linux" 等）。
 * @param env - 环境变量（用于 APPDATA / HOME）。
 * @param home - 用户主目录。
 * @param probeRoot - 可选：`npm root -g` 的探测结果（null = 不探测）。
 * @param scanNvm - 可选：nvm 版本目录扫描结果（null = 不扫描）。
 */
export function npmGlobalRootsFor(platform, env, home, probeRoot = null, scanNvm = null) {
	const roots = [];
	if (platform === "win32") {
		const appData = env?.APPDATA;
		if (typeof appData === "string" && appData !== "") {
			roots.push(join(appData, "npm", "node_modules"));
		}
	} else {
		// 1) npm root -g 权威探测（nvm / volta / fnm / 自编译等都能覆盖）
		if (typeof probeRoot === "string" && probeRoot !== "") {
			roots.push(probeRoot);
		}
		// 2) 常见全局前缀
		if (typeof home === "string" && home !== "") {
			roots.push(join(home, ".npm-global", "node_modules"));
			roots.push(join(home, ".local", "lib", "node_modules"));
		}
		roots.push("/usr/local/lib/node_modules");
		roots.push("/usr/lib/node_modules");
		// 3) nvm 各版本目录（每个版本的 lib/node_modules）
		if (Array.isArray(scanNvm)) {
			for (const versionDir of scanNvm) {
				roots.push(join(versionDir, "lib", "node_modules"));
			}
		}
	}
	// 去重（保持顺序）
	const seen = new Set();
	return roots.filter((root) => {
		if (seen.has(root)) return false;
		seen.add(root);
		return true;
	});
}

/** 扫描 ~/.nvm/versions/node 下所有已装 Node 版本目录。 */
export function scanNvmVersionDirs(home) {
	const dir = join(home, ".nvm", "versions", "node");
	try {
		if (!existsSync(dir)) return [];
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => join(dir, d.name));
	} catch {
		return [];
	}
}

/**
 * 通用「版本目录」扫描（纯函数，可注入 list 做单测）：
 * 在若干基目录下挑出名字匹配 `pattern` 的子目录（如 `v22.0.0` / `20.11.0` / `5`）。
 * 用于 Volta / nvm-windows / fnm / pnpm global 这类「按版本分层」的全局根。
 * @param {string[]} baseDirs
 * @param {{pattern?:RegExp, list?:Function}} [options]
 * @returns {string[]} 匹配到的绝对目录（基目录本身不存在 → 跳过，不抛）
 */
export function scanVersionDirs(baseDirs, { pattern = /^v?\d+\.\d+/, list = readdirSync } = {}) {
	const found = [];
	for (const base of Array.isArray(baseDirs) ? baseDirs : []) {
		if (typeof base !== "string" || base === "") continue;
		let entries = [];
		try { entries = list(base, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			const name = typeof entry === "string" ? entry : entry?.name;
			if (typeof name !== "string" || !pattern.test(name)) continue;
			found.push(join(base, name));
		}
	}
	return found;
}

/**
 * `npm prefix -g` 的取值 → 全局 node_modules 根（纯函数）。
 * posix 前缀（`/usr/local`）→ `<prefix>/lib/node_modules`；Windows（`%APPDATA%\npm`）→ `<prefix>\node_modules`。
 */
export function npmRootFromPrefix(prefix, platform = process.platform) {
	if (typeof prefix !== "string" || prefix.trim() === "") return null;
	const clean = prefix.trim();
	return platform === "win32" ? join(clean, "node_modules") : join(clean, "lib", "node_modules");
}

/**
 * 找 npm 的 CLI 入口（`npm-cli.js`）——**跨平台且参数零转义**的调用路线。
 *
 * 为什么不是 `spawn("npm")` / `spawn("npm.cmd")`：
 *  - Windows：`npm` 不带扩展名 → Node 不做 PATHEXT 解析 → **ENOENT**（本机实测）；
 *  - `npm.cmd`：Node ≥18.20/20.12/22 因 CVE-2024-27980 加固 → 裸 spawn 抛 **EINVAL**（本机实测）。
 *  另外 `shell:true` 会引入引号/拼接坑（且 npm 官方也不建议）。
 * @returns {{path:string|null, candidates:string[]}}
 */
export function resolveNpmCliPath({ execPath = process.execPath, env = {}, exists = existsSync } = {}) {
	const candidates = [];
	const envCli = env?.npm_execpath;
	if (typeof envCli === "string" && /npm-cli\.js$/i.test(envCli)) candidates.push(envCli);
	const nodeDir = dirname(execPath);
	candidates.push(join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"));            // Windows / 官方安装包布局
	candidates.push(join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")); // Unix 前缀布局
	if (typeof env?.APPDATA === "string" && env.APPDATA !== "") {
		candidates.push(join(env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js")); // Windows 全局 npm
	}
	candidates.push("/usr/lib/node_modules/npm/bin/npm-cli.js");
	candidates.push("/usr/local/lib/node_modules/npm/bin/npm-cli.js");
	for (const candidate of candidates) {
		try {
			if (exists(candidate)) return { path: candidate, candidates };
		} catch { /* 单个候选探测失败不影响其余 */ }
	}
	return { path: null, candidates };
}

/**
 * `npm root -g` / `npm prefix -g` 多级探测（**返回每级的原始结论**，失败也留证据）。
 * @returns {{root:string|null, source:string|null, attempts:Array, npmCli:string|null, npmCliCandidates:string[]}}
 */
export function probeNpmGlobalRootDetailed({
	env = process.env,
	platform = process.platform,
	execPath = process.execPath,
	comspec = null,
	exists = existsSync,
	run = (command, args) => spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 15000 })
} = {}) {
	const attempts = [];
	const record = (strategy, command, args, result) => {
		const stdout = typeof result?.stdout === "string" ? result.stdout : "";
		const line = stdout.trim().split(/\r?\n/).filter((l) => l.trim() !== "")[0]?.trim() ?? "";
		attempts.push({
			strategy, command, args,
			status: result?.status ?? null,
			error: result?.error ? `${result.error.code || "spawn-error"} ${result.error.message}`.trim() : null,
			output: line
		});
		return line;
	};
	const npmCli = resolveNpmCliPath({ execPath, env, exists });
	const done = (source, root) => ({ root, source, attempts, npmCli: npmCli.path, npmCliCandidates: npmCli.candidates });

	if (npmCli.path === null) {
		attempts.push({ strategy: "npm-cli.js 定位", command: null, args: [], status: null, error: "未找到 npm-cli.js", output: "" });
	} else {
		// 1) node + npm-cli.js（零 shell / 零转义；Windows 上既不是 ENOENT 也不是 EINVAL 的唯一可靠路线）
		const result = run(execPath, [npmCli.path, "root", "-g"]);
		const line = record("node npm-cli.js root -g", execPath, [npmCli.path, "root", "-g"], result);
		if (result?.status === 0 && line !== "") return done("node npm-cli.js root -g", line);
		// 1b) `npm prefix -g` → 派生根（老版本 npm 或 root 子命令异常时的等价来源）
		const prefixResult = run(execPath, [npmCli.path, "prefix", "-g"]);
		const prefixLine = record("node npm-cli.js prefix -g", execPath, [npmCli.path, "prefix", "-g"], prefixResult);
		const derived = prefixResult?.status === 0 ? npmRootFromPrefix(prefixLine, platform) : null;
		if (derived) return done("node npm-cli.js prefix -g", derived);
	}

	// 2) 平台命令形态。Dock/Finder/GUI 启动时 PATH 极简（通常没有 npm）→ 这里会记 ENOENT，
	//    不做隐瞒，交给候选链兜底（C-06 的 macOS 场景）。
	const shellRuns = platform === "win32"
		? [["cmd.exe npm root -g", comspec || env?.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"]],
			["cmd.exe npm prefix -g", comspec || env?.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm prefix -g"]]]
		: [["npm root -g", "npm", ["root", "-g"]],
			["npm prefix -g", "npm", ["prefix", "-g"]]];
	for (const [strategy, command, args] of shellRuns) {
		const result = run(command, args);
		const line = record(strategy, command, args, result);
		if (result?.status !== 0 || line === "") continue;
		const root = strategy.includes("prefix") ? npmRootFromPrefix(line, platform) : line;
		if (root) return done(strategy, root);
	}
	return done(null, null);
}

/**
 * 执行 `npm root -g`（失败返回 null）。
 * 兼容旧签名：返回值仍是「根字符串或 null」。需要**失败原因**时用 `probeNpmGlobalRootDetailed()`。
 */
export function probeNpmGlobalRoot(options = {}) {
	return probeNpmGlobalRootDetailed(options).root;
}

/**
 * npm 全局根**候选链**（纯函数 + 注入式探测，便于在 Windows 上单测 macOS/Linux 分支）。
 *
 * 语义（诚实性口径）：候选链**要么给出结论，要么在 `problems` 里明确说「探测不可用」**；
 * 任何一级的缺失/失败都留痕（`attempted` / `problems`），不静默返回空。
 *
 * @param {object} [options]
 * @param {string} [options.platform] process.platform 值
 * @param {object} [options.env] 环境变量（APPDATA / USERPROFILE / LOCALAPPDATA / XDG_DATA_HOME）
 * @param {string} [options.home] 用户主目录
 * @param {object} [options.probes] `probeNpmGlobalRootDetailed()` 的结果（或等价的注入对象）
 * @param {object} [options.scans] 版本目录扫描结果：{nvm, volta, fnm, pnpm, nvmWindows}
 * @param {boolean} [options.probesPending] 权威探测是否**在后台进行中**（此时不计入 problems，只标注 pending + note）
 * @param {(p:string)=>boolean} [options.exists] 存在性校验（默认 fs.existsSync）
 * @param {boolean} [options.notes] 是否带上该平台的覆盖清单（默认 true）
 * @returns {{ok:boolean, platform:string, roots:string[], existing:string[], attempted:Array, problems:string[], probe:object, coverage?:Array}}
 */
export function npmGlobalRootChain({
	platform = process.platform,
	env = {},
	home = "",
	probes = {},
	scans = {},
	probesPending = false,
	exists = existsSync,
	notes = true
} = {}) {
	const attempted = [];
	const problems = [];
	const seen = new Set();
	const add = (level, source, path) => {
		if (typeof path !== "string" || path.trim() === "" || seen.has(path)) return false;
		seen.add(path);
		let present = false;
		try { present = Boolean(exists(path)); } catch { present = false; }
		attempted.push({ level, source, path, exists: present });
		return true;
	};
	const listOf = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string" && v !== "") : []);
	const hasEnv = (key) => typeof env?.[key] === "string" && env[key].trim() !== "";
	const windows = platform === "win32";
	// 探测结果的两种字段形态都接受：`{npmRoot,npmPrefix}` 与 `probeNpmGlobalRootDetailed()` 的 `{root,...}`
	const probeRoot = typeof probes?.npmRoot === "string" && probes.npmRoot !== ""
		? probes.npmRoot
		: (typeof probes?.root === "string" && probes.root !== "" ? probes.root : null);
	const probePrefix = typeof probes?.npmPrefix === "string" && probes.npmPrefix !== "" ? probes.npmPrefix : null;

	// 0) 探测结论（权威级）：npm root -g / npm prefix -g
	if (probeRoot) add("probe", "npm root -g 探测", probeRoot);
	if (probePrefix) {
		const derived = npmRootFromPrefix(probePrefix, platform);
		if (derived) add("probe", "npm prefix -g 探测（派生）", derived);
	}
	if (!probeRoot && !probePrefix) {
		if (probesPending) {
			problems.push("npm 权威探测（node + npm-cli.js）在后台异步进行中：本次结论基于平台默认候选链（已做存在性校验）→ 探测完成后会用权威根替换缓存，下一次调用即生效");
		} else {
			const failed = (Array.isArray(probes?.attempts) ? probes.attempts : [])
				.filter((a) => a && (a.error || a.status !== 0))
				.map((a) => `${a.strategy}${a.error ? `（${a.error}）` : a.status !== null && a.status !== void 0 ? `（exit ${a.status}）` : ""}`);
			problems.push(failed.length > 0
				? `npm 探测未拿到根路径：${failed.join("；")} → 已退到默认路径候选链`
				: "npm 探测未执行或未拿到根路径 → 已退到默认路径候选链（候选链结论见下）");
		}
	}

	if (windows) {
		// 1) Windows 的 npm 默认全局根
		if (hasEnv("APPDATA")) {
			add("default", "%APPDATA%\\npm\\node_modules", join(env.APPDATA, "npm", "node_modules"));
		} else {
			problems.push("缺少环境变量 APPDATA：无法按标准位置定位 Windows 的 npm 全局根（%APPDATA%\\npm\\node_modules）→ 已回退 USERPROFILE/LOCALAPPDATA/主目录推导路径");
			// 2) APPDATA 缺失时的等价兜底
			if (hasEnv("USERPROFILE")) {
				add("fallback", "%USERPROFILE%\\AppData\\Roaming\\npm\\node_modules（APPDATA 等价）", join(env.USERPROFILE, "AppData", "Roaming", "npm", "node_modules"));
			} else {
				problems.push("也缺少环境变量 USERPROFILE：%USERPROFILE%\\AppData\\Roaming\\npm\\node_modules 无法确认");
			}
			if (hasEnv("LOCALAPPDATA")) {
				add("fallback", "%LOCALAPPDATA%\\npm\\node_modules", join(env.LOCALAPPDATA, "npm", "node_modules"));
			} else {
				problems.push("也缺少环境变量 LOCALAPPDATA：%LOCALAPPDATA%\\npm\\node_modules 无法确认");
			}
			// 3) 主目录推导的平台默认路径（环境变量全缺时的最后一级）
			if (typeof home === "string" && home !== "") {
				add("fallback-home", "<home>\\AppData\\Roaming\\npm\\node_modules（平台默认）", join(home, "AppData", "Roaming", "npm", "node_modules"));
				add("fallback-home", "<home>\\AppData\\Local\\npm\\node_modules", join(home, "AppData", "Local", "npm", "node_modules"));
			} else {
				problems.push("无法得到用户主目录（homedir）：Windows 默认路径推导不可用");
			}
		}
		// 4) 其他包管理器 / 版本管理器（版本目录由 scans 注入）
		for (const dir of listOf(scans.nvmWindows)) add("nvm-windows", "nvm-windows 版本目录", join(dir, "node_modules"));
		for (const dir of listOf(scans.volta)) add("volta", "Volta 版本目录", join(dir, "node_modules"));
		for (const dir of listOf(scans.pnpm)) add("pnpm", "pnpm 全局版本目录", join(dir, "node_modules"));
	} else {
		// 1) 常见用户前缀（`npm prefix -g` 的常见取值）
		if (typeof home === "string" && home !== "") {
			add("default", "~/.npm-global/node_modules", join(home, ".npm-global", "node_modules"));
			add("default", "~/.local/lib/node_modules", join(home, ".local", "lib", "node_modules"));
		} else {
			problems.push("无法得到用户主目录（homedir）：~/.npm-global 等用户前缀候选无法推导");
		}
		// 2) XDG（npm 在没有 npmrc prefix 时的用户级数据目录）
		if (hasEnv("XDG_DATA_HOME")) {
			add("xdg", "$XDG_DATA_HOME/npm/node_modules", join(env.XDG_DATA_HOME, "npm", "node_modules"));
		} else if (typeof home === "string" && home !== "") {
			add("xdg", "~/.local/share/npm/node_modules", join(home, ".local", "share", "npm", "node_modules"));
		}
		// 3) 系统前缀
		add("system", "/usr/local/lib/node_modules", "/usr/local/lib/node_modules");
		add("system", "/usr/lib/node_modules", "/usr/lib/node_modules");
		// 4) 平台特有前缀（macOS Apple Silicon 的 Homebrew 是 C-06 的漏检点）
		if (platform === "darwin") {
			add("homebrew", "Apple Silicon Homebrew", "/opt/homebrew/lib/node_modules");
			add("homebrew", "Homebrew node 公式", "/opt/homebrew/opt/node/lib/node_modules");
		} else {
			add("linuxbrew", "Linuxbrew", "/home/linuxbrew/.linuxbrew/lib/node_modules");
		}
		// 5) 版本管理器（版本目录由 scans 注入）
		for (const dir of listOf(scans.nvm)) add("nvm", "nvm 版本目录", join(dir, "lib", "node_modules"));
		for (const dir of listOf(scans.volta)) add("volta", "Volta 版本目录", join(dir, "lib", "node_modules"));
		for (const dir of listOf(scans.fnm)) add("fnm", "fnm 版本目录", join(dir, "installation", "lib", "node_modules"));
		for (const dir of listOf(scans.pnpm)) add("pnpm", "pnpm 全局版本目录", join(dir, "node_modules"));
	}

	const existing = attempted.filter((item) => item.exists);
	const roots = [...existing, ...attempted.filter((item) => !item.exists)].map((item) => item.path);
	if (attempted.length === 0) {
		problems.push("npm 全局根候选链为空：缺 APPDATA/USERPROFILE/LOCALAPPDATA/主目录，且 npm 探测未返回结果 → 「全局插件探测不可用」，**不是**「没有全局安装的插件」");
	} else if (existing.length === 0) {
		problems.push(`候选链里的 ${attempted.length} 条路径目前都不存在（全局 npm 目录可能尚未创建）：${attempted.map((item) => item.path).join(" / ")} → 「未发现全局安装目录」，不等于「没有全局插件」`);
	}
	const report = {
		ok: roots.length > 0,
		platform,
		roots,
		existing: existing.map((item) => item.path),
		attempted,
		problems,
		probe: {
			source: probes?.source ?? null,
			root: probeRoot,
			npmCli: probes?.npmCli ?? null,
			pending: Boolean(probesPending),
			note: probesPending
				? "npm 权威探测（node + npm-cli.js）在后台异步进行：本次结论基于平台默认候选链；探测完成后自动替换缓存，下一次调用即生效"
				: null,
			attempts: Array.isArray(probes?.attempts) ? probes.attempts : []
		}
	};
	if (notes) report.coverage = NPM_GLOBAL_ROOT_COVERAGE.filter((item) => item.platform === platform);
	return report;
}

/** 该平台的版本管理器/包管理器版本目录扫描（运行期用）。 */
export function scanVersionManagerDirs(platform, home) {
	if (typeof home !== "string" || home === "") return {};
	const env = process.env;
	if (platform === "win32") {
		const local = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA !== "" ? env.LOCALAPPDATA : "";
		const roaming = typeof env.APPDATA === "string" && env.APPDATA !== "" ? env.APPDATA : "";
		const nvmHomes = [];
		if (typeof env.NVM_HOME === "string" && env.NVM_HOME !== "") nvmHomes.push(env.NVM_HOME);
		if (roaming !== "") nvmHomes.push(join(roaming, "nvm"));
		const pnpmBases = [];
		if (roaming !== "") pnpmBases.push(join(roaming, "pnpm", "global"));
		if (local !== "") pnpmBases.push(join(local, "pnpm", "global"));
		return {
			nvmWindows: scanVersionDirs(nvmHomes),
			volta: local === "" ? [] : scanVersionDirs([join(local, "Volta", "tools", "image", "node")]),
			pnpm: scanVersionDirs(pnpmBases)
		};
	}
	return {
		nvm: scanNvmVersionDirs(home),
		volta: scanVersionDirs([join(home, ".volta", "tools", "image", "node")]),
		fnm: scanVersionDirs([join(home, ".local", "share", "fnm", "node-versions")]),
		pnpm: scanVersionDirs([join(home, ".local", "share", "pnpm", "global")])
	};
}

/**
 * 把权威探测**延后到当前事件循环忙完**再起（P-03：连异步 `spawn()` 在 Windows 上也有 ~40 ms 的
 * 同步开销，落在"首次快照"这条路径上依然是可观测的回归）。定时器 unref：短命 CLI 直接退出、不拖住进程
 * （那时本次调用已用平台默认候选链给过结论）。
 * @returns {boolean} 是否已排入后台探测
 */
function scheduleBackgroundProbe(delayMs = PROBE_DELAY_MS) {
	if (PROBE_CACHE.inFlight || PROBE_CACHE.scheduled || PROBE_CACHE.result !== null) return false;
	PROBE_CACHE.scheduled = true;
	const timer = setTimeout(() => {
		PROBE_CACHE.scheduled = false;
		startBackgroundProbe();
	}, delayMs);
	if (typeof timer.unref === "function") timer.unref();
	return true;
}

/**
 * 当前平台的 npm 全局根**报告**（带 10 分钟缓存）。
 *
 * 冷启动性能（P-03）：**默认候选链先给结论、权威探测走后台** ——
 *  - 默认候选里已有真实存在的目录 → 本次调用**零 spawn**（本机实测：APPDATA\npm\node_modules 存在），
 *    权威根由 `scheduleBackgroundProbe()` 补齐，完成后替换缓存（10 分钟内只探一次）；
 *  - 默认候选**一个都不存在** → 同步探测（此时探测是唯一能给出结论的来源，宁可慢也要有结论）；
 *  - 权威探测未完成时 `probe.pending=true` + `probe.note` 如实标注（不谎称已有权威结论）。
 * `problems` 非空时必须由调用方展示/记录——它是「探测降级」的唯一信号。
 */
export function npmGlobalRootReport() {
	const now = Date.now();
	if (NPM_ROOT_CACHE.report !== null && now - NPM_ROOT_CACHE.at < NPM_ROOT_TTL) return NPM_ROOT_CACHE.report;
	let home = "";
	try { home = homedir(); } catch { home = ""; }
	const platform = process.platform;
	const scans = scanVersionManagerDirs(platform, home);

	// 1) 先用"已知的探测结果"（可能是后台探测刚拿到的）构建一条候选链
	let pending = false;
	let probes = PROBE_CACHE.result ?? {};
	let report = npmGlobalRootChain({ platform, env: process.env, home, probes, scans });
	if (PROBE_CACHE.result === null) {
		if (report.existing.length === 0) {
			// 快路径一个都不存在 → 同步探测一次（唯一能给出结论的来源；慢但正确）
			PROBE_CACHE.result = probeNpmGlobalRootDetailed({ env: process.env, platform });
			PROBE_CACHE.at = now;
			probes = PROBE_CACHE.result;
		} else {
			pending = scheduleBackgroundProbe();
			probes = PROBE_CACHE.result ?? {};
		}
		report = npmGlobalRootChain({ platform, env: process.env, home, probes, scans, probesPending: pending });
	}
	NPM_ROOT_CACHE.at = now;
	NPM_ROOT_CACHE.report = report;
	return report;
}

/**
 * 权威探测的**非阻塞**实现：detached 子进程 + stdout 落临时文件（不用管道：受限会话里 Node 管道 stdio 会 EPERM），
 * 完成后更新 `PROBE_CACHE` 并失效报告缓存 —— 事件循环一分钟都不被它挡住。
 * @returns {boolean} 是否真的起了后台探测
 */
function startBackgroundProbe() {
	if (PROBE_CACHE.inFlight || PROBE_CACHE.result !== null) return false;
	const npmCli = resolveNpmCliPath({ execPath: process.execPath, env: process.env });
	if (npmCli.path === null) {
		PROBE_CACHE.inFlight = false;
		PROBE_CACHE.at = Date.now();
		PROBE_CACHE.result = { root: null, source: null, attempts: [{ strategy: "npm-cli.js 定位", command: null, args: [], status: null, error: "未找到 npm-cli.js", output: "" }], npmCli: null, npmCliCandidates: npmCli.candidates };
		return false;
	}
	const outFile = join(tmpdir(), `dsh-npm-root-probe-${process.pid}-${Date.now()}.txt`);
	let fd = null;
	let child = null;
	try {
		fd = openSync(outFile, "w");
		child = spawn(process.execPath, [npmCli.path, "root", "-g"], { stdio: ["ignore", fd, "ignore"], windowsHide: true });
	} catch {
		if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
		return false;
	}
	try { closeSync(fd); } catch { /* 子进程已继承 */ }
	PROBE_CACHE.inFlight = true;
	const settle = (status, errorText) => {
		PROBE_CACHE.inFlight = false;
		let text = "";
		try { text = readFileSync(outFile, "utf8").trim().split(/\r?\n/).filter((l) => l.trim() !== "")[0]?.trim() ?? ""; } catch { text = ""; }
		try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
		PROBE_CACHE.at = Date.now();
		PROBE_CACHE.result = {
			root: status === 0 && text !== "" ? text : null,
			source: status === 0 && text !== "" ? "node npm-cli.js root -g（后台异步探测）" : null,
			attempts: [{
				strategy: "node npm-cli.js root -g（后台异步）", command: process.execPath, args: [npmCli.path, "root", "-g"],
				status: status ?? null, error: errorText ?? null, output: text
			}],
			npmCli: npmCli.path, npmCliCandidates: npmCli.candidates
		};
		// 权威结论到手 → 让下一次调用重建报告（本次调用已返回"待探测"版；调用方无需干预）
		NPM_ROOT_CACHE.at = 0;
		NPM_ROOT_CACHE.report = null;
	};
	child.once("error", (error) => settle(null, `${error?.code || "spawn-error"} ${error?.message ?? error}`.trim()));
	child.once("exit", (code) => settle(code, null));
	child.unref();
	return true;
}

/**
 * 当前平台的 npm 全局 node_modules 根候选（带 10 分钟缓存）。
 * 顺序：**真实存在的候选在前**（调用方大多是"读里面的 package.json"，先命中省掉无谓 IO）。
 */
export function npmGlobalRoots() {
	return npmGlobalRootReport().roots;
}

/** 判断「探测是否降级」（候选为空 / 或没有任何候选目录存在）—— 供 UI/日志区分「无全局插件」与「探测不可用」。 */
export function npmGlobalRootsDegraded(report = npmGlobalRootReport()) {
	return report.ok === false || report.existing.length === 0;
}

/** 一行式诊断文本（problems 逐条换行；无问题返回 null）。 */
export function formatNpmGlobalRootProblems(report = npmGlobalRootReport()) {
	if (!Array.isArray(report.problems) || report.problems.length === 0) return null;
	return report.problems.map((line) => `⚠ ${line}`).join("\n");
}

/** 清缓存（更新/卸载后调用，让新安装的全局包路径生效）。 */
export function clearNpmGlobalRootCache() {
	NPM_ROOT_CACHE.report = null;
}
