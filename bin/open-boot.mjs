#!/usr/bin/env node
/**
 * open-boot.mjs — 浏览器访问即触发自检启动（网页启动器 / 3081 常驻入口）。
 *
 * 在 3081 端口提供常驻网页入口：打开 http://127.0.0.1:3081/ →
 * 自动 verify → 有问题自动 fix（隔离坏 bundle）→ 拉起 `dsh web` → 跳转 3080。
 *
 * 设计取舍：
 *  - 1.0.3（安全性能审查 S3/S4/P1/P2）：
 *    · **Host 头校验（S3）**：请求入口只接受 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`
 *      （带端口、大小写不敏感），其余 421 JSON —— 挡住"攻击者域名解析到 127.0.0.1 后同源读接口"
 *      的 DNS 重绑定；校验在**路由之前**。
 *    · **统一安全响应头（S4）**：CSP（default-src 'none' + script/style 'unsafe-inline' + connect-src 'self'
 *      + frame-ancestors 'none' + base-uri 'none'）、X-Frame-Options DENY、nosniff、Referrer-Policy
 *      no-referrer，覆盖 sendHtml/sendJson/救援页/404/421；页面内联脚本样式照常可跑。
 *    · **bundles GET 也过 Origin+令牌（S3 附带）**：已装插件清单不再裸奔（页面 api() 本就带令牌）。
 *    · **updates 缓存 + 单飞（P1）**：30 分钟缓存（key=profile，另存 pnpm-lock.yaml 的 mtime+size 失效）、
 *      并发共用 in-flight Promise（不再重复起 pnpm）、`pnpm --version` 成功结果进程内缓存 → 热调用 < 10ms。
 *    · **runPnpm 有界缓冲（P2）**：stdout/stderr 只保末尾 16KB + `<...已截断 N 字节>` 标记，长驻守护不再堆峰值。
 *    · **启动页 log() 改逐行 DOM（S4）**：textContent 追加，不再 innerHTML 拼接。
 *  - 3081 独立入口，无端口争抢（v0.7.0 的 3080 接管模式已移除）。
 *  - **平时隐藏，拉起引擎时弹窗**：常驻守护自身无任何窗口；
 *    只有当引擎（3080）真的不在时，才弹出一个**可见的启动窗口**，
 *    显示 自检 → 修复 → 启动 的进度，结束后按任意键关闭（--no-window 可关掉）。
 *  - 常驻守护用 `--supervise`：只做「端口不可用 → 二次确认 → 隐藏拉起」，
 *    并靠锁端口保证同一时间只有一个守护。
 *  - v0.9.1（审计③ R13 / R7 / L11 / P1-5）：
 *    · **`--uninstall` 卸载闭环（R13）**：按 profile 停本 profile 的守护（`.open-boot.pid` + 锁端口
 *      `port+1000` + 进程镜像三重校验，不过就拒绝且不动别的 profile 的进程、绝不 `taskkill /T` 整棵树）
 *      → 删 `HKCU\...\Run` 下**所有** `DSHWeb*` 值（含历史 `DSHWebRescue`，并打印键名）
 *      → 删 profile 内 `open-boot-*.vbs` shim → 清 `.open-boot.pid`（日志默认保留）；幂等 exit 0。
 *    · **本地写接口防护（L11）**：`POST /api/boot` 与救援写接口三道检查 ——
 *      Origin（为空或同源 `http://127.0.0.1:<port>`，其他 403）/ 一次性令牌（页面 meta
 *      `dsh-pm-token` + 请求头 `X-DSH-PM-Token`，不匹配 401）/ 单飞（并发第二个 409）。
 *      读取类接口（GET /api/status）保持开放，`launcherHealth` 身份握手不受影响。
 *    · **健康留痕（P1-5）**：`--status` 每次都往 `<profile>/health.log` 追加一行
 *      `ISO 时间 OK/FAIL boot=… engine=…`（保留最近 7 天 / 最多 1000 行），控制台新增「最近自检：…」。
 *    · **救援入口与端口分工（R7）**：3081 是唯一网页入口，open-boot 自身提供完整救援能力
 *      （`/rescue` 页面 + `/rescue/api/*`，复用 rescue-daemon 的 handleApi，挂在独立前缀下，
 *      不影响 `/api/status` 的身份语义）；`rescue-daemon` 默认端口改为 3082。端口被占时明确报错，不漂移。
 *  - v0.9.1-rc2（兼容性审计 C-05，high）：
 *    · **弹窗启动不再静默假成功**：命令构造抽成纯函数 `bootWindowPlan()`（macOS 用 `.command` 脚本 +
 *      `open`/`osascript`；Linux 按终端特性给 `--`/`-e` + 兜底链），并**校验子进程退出码/error 事件**
 *      （`launchViaCandidates`/`verifyLauncherExit`），失败逐个记原因后返回 ok:false → 退回静默启动。
 *      旧实现的 `open -a Terminal <shell 命令行>`（open 只接受文件/URL）与 `gnome-terminal -e`
 *      （GNOME 42+ 已移除）在用户机器上直接报错却被告知"已弹出启动窗口"。
 *  - v0.9.0-2（审计③ 修复 L2/L3/L4/L6/L7/L8）：
 *    · 健康判定 = **HTTP 握手 + 身份校验**（裸 TCP 监听器一律判不健康）；
 *      3081 被非本工具进程占用时**明确报错**，不再"假健康"、也不再静默漂移端口。
 *    · 守护补 `uncaughtException/unhandledRejection/exit` 落盘 + 周期性心跳日志；
 *      新增 `--status`（pid 存活 + HTTP 握手 + 端口归属）；`--autostart-status`
 *      同时校验包装脚本存在与守护存活。
 *    · 参数解析修掉 `--wait-ms` 多跳一个 token 的 bug；新增 `--help/--status/--heartbeat-min/--cwd`。
 *    · 引擎/启动器使用**稳定 cwd**（默认用户主目录），不再锁住本包目录。
 *    · 包装 .vbs 改为**运行时自解析路径**（正文纯 ASCII）+ 回读校验，
 *      中文用户名等非 ASCII profile 路径不再乱码。
 *
 * 用法：
 *   node bin/open-boot.mjs [--profile <dir>] [--port <n>] [--dsh <cmd>] [--no-window] [--cwd <dir>]
 *   node bin/open-boot.mjs --ensure         确保 3081 有服务（一次性，供桌面快捷方式用）
 *   node bin/open-boot.mjs --supervise [--interval <秒>] [--heartbeat-min <分钟>] [--quiet]
 *   node bin/open-boot.mjs --status         打印启动器/守护/引擎状态（退出码 0=启动器健康；写 health.log）
 *   node bin/open-boot.mjs --install-autostart | --uninstall-autostart | --autostart-status
 *   node bin/open-boot.mjs --uninstall [--profile <dir>] [--port <n>]   卸载启动器（停守护 + 清自启 + 删 shim + 清 pid）
 *   node bin/open-boot.mjs --help
 *
 * 零新依赖（复用 lib/preflight.mjs 与 lib/enginectl.mjs）。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createLockServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProfile, fixProfile, isolateFailedEntries } from "../lib/preflight.mjs";
import { removePatchEntriesFor } from "../lib/patch-clean.mjs";
import { DRYDOCK_FAVICON_LINK, drydockLogoMarkSvg, handleApi as handleRescueApi, rescuePageHtml } from "./rescue-daemon.mjs";
import { entryUrlOf, launcherPortFromEnv, lockPortOf, rescuePortFromEnv } from "../lib/ports.mjs";
import {
	ENGINE_PORT, LAUNCHER_APP, bootWindowPlan, chdirStable, corsPreflightResponse, corsResponseHeaders, createSingleFlight, detectAvailableTerminals, engineHealth,
	guardWriteRequest, isAlive, killTreeForce, launchViaCandidates, launcherHealth, looksLikeProfileDir, newApiToken, portOwner,
	portOwnerProbe, probe, processImage, processImageProbe, readPidInfo, resolveEngineCwd, startEngineWithQuarantine, stopEngine,
	validateCliValue, validateIntegerValue, validatePortValue, waitForEngine, writeOriginPolicyFromEnv
} from "../lib/enginectl.mjs";
// 1.1.0：首启环境探测（把宿主形态写进 `<DSH_HOME>/.drydock/host-profile.json`，供各进程按形态剥离模块）。
import { ensureHostProfile } from "../lib/host-profile.mjs";

const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");
const SELF = fileURLToPath(import.meta.url);
const AUTOSTART_NAME = "DSHWebFront";
/**
 * 自启注册表键。**生产路径 = HKCU Run 键**（下面这条默认值，语义与退出码契约都不变）。
 *
 * `DSH_PM_RUN_KEY` 是**测试注入点**（t10 测试卫生）：套件默认把作用域指向
 * `HKCU\Software\DSHPluginManagerTest\Run-<pid>` 这样的测试专用子键，从而
 * 「默认跑测试绝不动用户的真实自启项」，同时仍然走**完全相同的 reg.exe 代码路径**
 * （作用域判定 / 死指针清理 / 归属未确认 exit 2 的语义一条都不少）。
 * 只接受 `HKCU\` 下的路径 —— 防止被误指向 HKLM/HKCR 等全局位置或畸形键名；
 * 未设该环境变量时行为与历史版本逐字节一致（默认值见下）。
 */
const RUN_KEY = (() => {
	const override = process.env.DSH_PM_RUN_KEY;
	if (typeof override === "string" && /^HKCU\\/i.test(override.trim())) return override.trim();
	return "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
})();
/** 自启注册表值前缀：本工具写过的一律归它管（含历史遗留 `DSHWebRescue`，审计③ R13）。 */
const RUN_VALUE_PREFIX = /^DSHWeb/i;
const SUP_LOG = "open-boot-supervisor.log";
/** P1-5 健康留痕：`--status` 每次追加一行，保留最近 7 天 / 最多 1000 行。 */
const HEALTH_LOG = "health.log";
const HEALTH_MAX_LINES = 1000;
const HEALTH_MAX_AGE_DAYS = 7;
/** R7 端口分工：本启动器 = 唯一网页入口（默认 3081），rescue-daemon = 独立备份入口（默认 3082）。 */
const RESCUE_DAEMON_PORT = rescuePortFromEnv();

function readVersion() {
	try { return JSON.parse(readFileSync(join(dirname(SELF), "..", "package.json"), "utf8")).version || null; }
	catch { return null; }
}

/**
 * 开关表（t24 表驱动解析）：**解析器的唯一事实来源**。每项声明
 *   - `name` / `aliases`：精确匹配的开关名（**大小写敏感**：`--UNINSTALL` 不是已知开关 → 拒绝 + did-you-mean）
 *   - `kind`：`"value"`（需要取值）/ `"mode"`（选择子命令/模式，互斥）/ `"flag"`（普通布尔）
 *   - `validate`：取值校验（返回值见 `lib/enginectl.mjs` 的共享件），所有取值开关都必须声明
 *   - `mode`：模式名（仅 kind="mode"，用于互斥检查）
 *   - `apply(args, value?)`：把解析结果写进 args
 *
 * 解析规则（结构上堵死"静默回落默认目标"这一类，前三次入口分别是 t14-F1 / t18-F1 / t21-F1）：
 *   ① 取值开关的取值 **缺失 / 全空白 / 以 `-` 开头** → 用法错误。最后一类是关键：`--dsh --profile`
 *      以前会把 `--profile` 吞成 `--dsh` 的取值，让后面的开关"凭空消失"、`args.unknown` 保持为空，
 *      于是静默回落到**默认 profile + 3081** 并对全局 `DSHWeb*` 执行删除后报成功。
 *   ② 任何以 `-` 开头且不在表里的 token → **所有模式**一律用法错误 + did-you-mean（不再"警告并忽略"）。
 *   ③ 不以 `-` 开头的 token 是**位置参数**：保留原状 —— 全局子命令拒绝（见 unknownTokenPolicy），
 *      其余模式警告并忽略（可被未知拼写的调用方脚本容忍）。
 *   ④ 取值开关统一支持 `--flag=值` 内联写法（不再只有 `--profile=` 例外）；非取值开关写 `=` → 明确报错。
 *   ⑤ 模式开关互斥：同时出现多个不同模式（`--help` 除外，help 优先）→ 用法错误并列出冲突的开关。
 */
const SWITCH_TABLE = [
	// ---- 取值开关（kind: "value"）：取值必须过共享校验件 ----
	{
		name: "--profile", kind: "value",
		validate: (raw) => validateCliValue(raw, { flag: "--profile", hint: "写法：--profile <目录> 或 --profile=<目录>" }),
		apply: (args, value) => { args.profile = resolve(value.trim()); }
	},
	{
		name: "--port", kind: "value",
		validate: (raw) => validatePortValue(raw),
		apply: (args, value) => { args.port = Number(value.trim()); }
	},
	{
		name: "--dsh", kind: "value",
		validate: (raw) => validateCliValue(raw, { flag: "--dsh", hint: "写法：--dsh <命令>，例如 --dsh \"npx dsh\"" }),
		apply: (args, value) => { args.dsh = value.trim(); }
	},
	{
		name: "--cwd", kind: "value",
		validate: (raw) => validateCliValue(raw, { flag: "--cwd", hint: "写法：--cwd <目录>" }),
		apply: (args, value) => { args.cwd = resolve(value.trim()); }
	},
	{
		name: "--interval", kind: "value",
		validate: (raw) => validateIntegerValue(raw, { flag: "--interval", min: 5, max: 86400 }),
		apply: (args, value) => { args.interval = Number(value.trim()); }
	},
	{
		name: "--wait-ms", kind: "value",
		validate: (raw) => validateIntegerValue(raw, { flag: "--wait-ms", min: 1, max: 86400000 }),
		apply: (args, value) => { args.waitMs = Number(value.trim()); }
	},
	{
		name: "--heartbeat-min", kind: "value",
		validate: (raw) => validateIntegerValue(raw, { flag: "--heartbeat-min", min: 1, max: 1440 }),
		apply: (args, value) => { args.heartbeatMin = Number(value.trim()); }
	},
	// ---- 模式开关（kind: "mode"）：互斥 ----
	{ name: "--uninstall", kind: "mode", mode: "uninstall", apply: (args) => { args.uninstall = true; } },
	{ name: "--install-autostart", kind: "mode", mode: "autostart:install", apply: (args) => { args.autostart = "install"; } },
	{ name: "--uninstall-autostart", kind: "mode", mode: "autostart:uninstall", apply: (args) => { args.autostart = "uninstall"; } },
	{ name: "--autostart-status", kind: "mode", mode: "autostart:status", apply: (args) => { args.autostart = "status"; } },
	{ name: "--status", kind: "mode", mode: "status", apply: (args) => { args.status = true; } },
	{ name: "--supervise", kind: "mode", mode: "supervise", apply: (args) => { args.supervise = true; } },
	{ name: "--ensure", kind: "mode", mode: "ensure", apply: (args) => { args.ensure = true; } },
	{ name: "--help", kind: "mode", mode: "help", aliases: ["-h"], apply: (args) => { args.help = true; } },
	// ---- 普通布尔开关（kind: "flag"）----
	{ name: "--quiet", kind: "flag", apply: (args) => { args.quiet = true; } },
	{ name: "--no-window", kind: "flag", apply: (args) => { args.window = false; } },
	{ name: "--front", kind: "flag", legacy: true, apply: () => { /* v0.7.1 起已移除 3080 接管模式，忽略该参数 */ } }
];

/** 开关名 → 规格（精确匹配，大小写敏感）。 */
const SWITCH_BY_NAME = new Map();
for (const spec of SWITCH_TABLE) {
	SWITCH_BY_NAME.set(spec.name, spec);
	for (const alias of spec.aliases ?? []) SWITCH_BY_NAME.set(alias, spec);
}

/** 已知开关名列表（did-you-mean 的候选集；只列主名，便于提示）。 */
const KNOWN_SWITCH_NAMES = SWITCH_TABLE.map((spec) => spec.name);

/** Levenshtein 距离（did-you-mean 用；token 很短，成本可忽略）。 */
function editDistance(a, b) {
	const rows = a.length + 1;
	const cols = b.length + 1;
	let prev = Array.from({ length: cols }, (_, j) => j);
	for (let i = 1; i < rows; i++) {
		const cur = [i];
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		prev = cur;
	}
	return prev[cols - 1];
}

/**
 * did-you-mean：给出最接近的已知开关（比较时**忽略大小写**，但匹配本身大小写敏感）。
 * 前缀关系（`--uninstal` ⊂ `--uninstall`）也算接近，避免长开关被距离阈值挡掉。
 */
export function suggestClosestSwitch(token, { max = 3 } = {}) {
	const needle = String(token).toLowerCase();
	const scored = KNOWN_SWITCH_NAMES.map((name) => {
		const lower = name.toLowerCase();
		let score = editDistance(needle, lower);
		if (lower.startsWith(needle) || needle.startsWith(lower)) score = Math.min(score, 1);
		return { name, score };
	}).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
	const limit = Math.max(2, Math.floor(needle.length / 3));
	return scored.filter((item) => item.score <= limit).slice(0, max).map((item) => item.name);
}

/** 未知开关的报错文案（含 did-you-mean 与大小写敏感说明）。 */
function unknownSwitchMessage(token) {
	const suggestions = suggestClosestSwitch(token);
	const tail = suggestions.length > 0
		? `；是否想输入 ${suggestions.join(" 或 ")}？（开关名匹配**大小写敏感**）`
		: "（开关名匹配大小写敏感；用 --help 查看全部开关）";
	return `未知开关：${token}${tail}`;
}

/**
 * 位置参数策略（t20 起，t24 收窄为**只处理位置参数**：开关形态的未知 token 已在解析阶段一律拒绝）。
 *
 * 三个**全局子命令**（`--uninstall` / `--install-autostart` / `--uninstall-autostart`）会写或删
 * `HKCU\...\Run` 下的 `DSHWeb*`、并可能停进程：它们的 `--profile` 缺省值是**默认 profile**（合法目标），
 * 所以多余的位置参数（往往是拼错的开关留下的残渣）必须拒绝，否则一次笔误就是一次全局改动。
 * 其余模式（server/`--ensure`/`--supervise`/`--status`/`--autostart-status`）保持"警告并忽略"，
 * 以免打断既有的调用方脚本。
 */
export function unknownTokenPolicy(args) {
	if (!args || !Array.isArray(args.unknown) || args.unknown.length === 0) return { reject: false, message: null };
	const tokens = args.unknown.join(" ");
	const isGlobal = Boolean(args.uninstall) || args.autostart === "install" || args.autostart === "uninstall";
	if (isGlobal) {
		return {
			reject: true,
			message: `全局子命令不接受多余的位置参数：${tokens}（请检查开关拼写；这三个子命令会改动全局自启项，`
				+ `多余的 token 不会被静默忽略，也不会回落到默认 profile）`
		};
	}
	return { reject: false, message: `无法识别的位置参数（已忽略）：${tokens}（这些模式允许位置参数存在；用 --help 查看用法）` };
}

/**
 * 解析命令行（表驱动，见 SWITCH_TABLE）。
 *
 * 取值校验统一走 `lib/enginectl.mjs` 的共享件；任何用法错误都记为 `args.usageError` 并**立即停止解析**，
 * 由 `main()` 在任何动作之前打印用法并 exit 1（零副作用）。
 */
function parseArgs(argv) {
	// 1.0.0-rc.1 可迁移性：启动器端口可用 DSH_LAUNCHER_PORT 覆盖（默认仍 3081），
	// 整机迁移/多实例时不再依赖写死端口；CLI --port 仍然优先。推导见 lib/ports.mjs。
	const defaultLauncherPort = launcherPortFromEnv();
	const args = {
		profile: PROFILE_DEFAULT, port: defaultLauncherPort, dsh: "dsh", cwd: null,
		supervise: false, ensure: false, status: false, help: false,
		interval: 60, heartbeatMin: 10, quiet: false, window: true, waitMs: 90000,
		autostart: null, uninstall: false, usageError: null, unknown: [], modes: []
	};
	/** 记录用法错误并立刻停止解析（不做任何后续动作）。 */
	const fail = (message) => { args.usageError = message; return args; };

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		let spec = SWITCH_BY_NAME.get(token) ?? null;
		let inlineValue;
		// ④ `--flag=值` 内联写法（取值开关统一支持；非取值开关写 = 明确报错）
		if (!spec && /^--[A-Za-z][A-Za-z0-9-]*=/.test(token)) {
			const head = token.slice(0, token.indexOf("="));
			const rest = token.slice(token.indexOf("=") + 1);
			const inlineSpec = SWITCH_BY_NAME.get(head) ?? null;
			if (inlineSpec) {
				if (inlineSpec.kind !== "value") return fail(`开关 ${head} 不接受取值（写法：${head}）`);
				spec = inlineSpec;
				inlineValue = rest;
			}
		}
		if (!spec) {
			// ② 像开关的未知 token：所有模式一律拒绝 + did-you-mean
			if (typeof token === "string" && token.startsWith("-")) return fail(unknownSwitchMessage(token));
			// ③ 位置参数：交给 unknownTokenPolicy 按模式处理
			args.unknown.push(token);
			continue;
		}
		if (spec.kind === "value") {
			let raw = inlineValue;
			if (raw === void 0) {
				const error = spec.validate(argv[i + 1]); // ① 缺失/空白/以 - 开头 → 用法错误（开关不会被吞）
				if (error) return fail(error);
				raw = argv[i + 1];
				i++;
			} else {
				const error = spec.validate(raw);
				if (error) return fail(error);
			}
			spec.apply(args, raw);
			continue;
		}
		spec.apply(args);
		if (spec.kind === "mode") args.modes.push({ flag: spec.name, mode: spec.mode });
	}

	// ⑤ 模式互斥：多个不同模式同时出现 → 用法错误（列出冲突开关）；`--help` 优先，不参与冲突
	if (args.help !== true) {
		const chosen = args.modes.filter((item) => item.mode !== "help");
		const distinct = [...new Set(chosen.map((item) => item.mode))];
		if (distinct.length > 1) {
			return fail(`互斥的子命令/模式同时出现：${chosen.map((item) => item.flag).join(" + ")}（一次只能选一个；用 --help 查看用法）`);
		}
	}
	return args;
}

const HELP_TEXT = `浏览器启动器 / 3081 常驻入口（dsh-drydock 引擎船坞）

用法：
  node bin/open-boot.mjs [选项]                 启动 3081 网页入口（前台）
  node bin/open-boot.mjs --supervise            常驻守护：静默确保 3081 有服务（推荐自启）
  node bin/open-boot.mjs --ensure               一次性确保 3081 有服务（桌面快捷方式用）
  node bin/open-boot.mjs --status               打印启动器/守护/引擎状态（退出码 0=启动器健康；追加 health.log）
  node bin/open-boot.mjs --install-autostart    写开机自启（Windows：HKCU Run + 包装 .vbs）
  node bin/open-boot.mjs --uninstall-autostart  只移除开机自启（等价于 --uninstall 的自启部分）
  node bin/open-boot.mjs --autostart-status     查看自启状态（含包装脚本/守护存活校验）
  node bin/open-boot.mjs --uninstall            卸载本次安装的全部痕迹（停守护 → 删 DSHWeb* 自启 → 删 shim → 清 pid）
  node bin/open-boot.mjs --help                 显示本帮助

选项：
  --profile <dir>        profile 目录（默认 ~/.dsh/profiles/web）
  --port <n>             启动器端口（默认 3081；被非本工具进程占用时直接报错，不再自动漂移）
  --dsh <cmd>            启动引擎的命令（默认 dsh；含空格的路径也可用）
  --cwd <dir>            引擎/启动器的稳定工作目录（默认用户主目录，避免锁住包目录）
  --no-window            拉起引擎时不弹可见窗口（静默启动）
  --interval <秒>        守护检查间隔（默认 60，最小 5）
  --heartbeat-min <分>   守护心跳日志间隔（默认 10 分钟）
  --quiet                不往控制台打印（日志仍写 profile/open-boot-supervisor.log）

环境变量（端口覆盖，与 --port 同时存在时 --port 优先）：
  DSH_LAUNCHER_PORT      启动器端口（默认 3081）
  DSH_ENGINE_PORT        引擎端口（默认 3080；测试/多实例逃生门）
  DSH_RESCUE_PORT        rescue-daemon 备份入口端口（默认 3082）
  DSH_PM_SCRIPTS_DIR     生成的启动脚本目录（默认 <DSH_HOME>/scripts；测试隔离用）
  DSH_PM_NO_SCRIPTS=1    跳过 dsh-launcher.cmd 生成（只读/受限环境）
  DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1  允许桌面版页面来源 dsh-app://app 的写请求（默认关；网页版不要开）
  DSH_DRYDOCK_DESKTOP_TOKEN=<48hex>   桌面版令牌（宿主用 mintDesktopToken() 生成，同时交给本服务与桌面页面）
  DSH_DRYDOCK_ALLOW_NULL_ORIGIN=1     桌面页面确实发 Origin: null 时再开（需同时开上面第一项；只认桌面令牌）
守护单实例锁端口 = 启动器端口 + 1000（默认 3081 → 4081；--supervise 用它保证单实例）。

--uninstall 语义（冻结契约，供管理器卸载钩子调用）：
  1) 只停**本 profile 的**守护：依据 .open-boot.pid + 锁端口（--port+1000）+ 进程镜像三重校验；
     校验不过一律拒绝并打印原因（绝不 taskkill /T 整棵树、绝不误杀别的 profile 的守护）。
  2) 删 HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run 下**所有** DSHWeb* 值（含历史 DSHWebRescue），并打印键名。
  3) 删 profile 内 open-boot-autostart.vbs / open-boot-ui.vbs（shim）。
  4) 清理 <profile>\\.open-boot.pid；日志（open-boot*.log / health.log / rescue-daemon.log）默认保留。
  5) 幂等：条件满足时重复执行仍然 exit 0。
  退出码：0=完成（含"无可清理项"、归属校验不通过而跳过他人进程）；
          1=清理过程出错（注册表/脚本删除失败、已确认的进程停不下来、pid 文件删不掉）；
          2=**归属未确认**（netstat/tasklist 探测不可用）：未停止任何进程、**保留** .open-boot.pid、
            不报告"卸载完成"（读不到 ≠ 没有守护）。可换到不受限的会话重跑，或按输出里的人工核对建议处理。

端口分工（v0.9.1 起）：
  3080 = dsh 引擎；3081 = 本启动器（**唯一网页入口**：/ 启动页、/rescue 救援页、/api/* 与 /rescue/api/*）；
  3082 = rescue-daemon（独立备份救援入口，不再与 3081 争抢）。

写接口同源白名单（L11）：http://127.0.0.1:<port> ／ http://localhost:<port> ／ http://[::1]:<port>
  （同机同端口的等价主机名；其他 Origin 一律 403。端口取本服务监听端口。）
  桌面版（1.1.0）：显式设 DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1 时额外允许 dsh-app://app（Electron 页面来源，
  大小写不敏感、允许末尾 "/"），令牌照旧校验；其他 dsh-app 页面与任何 http(s) 第三方源仍然 403。
  CORS 预检（1.1.0 M6）：桌面页带自定义头 X-DSH-PM-Token 跨源 fetch 时浏览器先发 OPTIONS —— 启动器直接
  应答 204 + Access-Control-Allow-Origin/Methods/Headers/Max-Age（只回显被允许的那个 Origin，绝不 *）；
  来源不被允许的 OPTIONS 一律 403 且不回任何 Allow 头。预检排在令牌校验之前（规范要求，不带令牌）。

输入校验（表驱动解析：t14-F1 / t18-F1 / t21-F1 三次实测的"静默回落默认目标"家族）：
  取值开关（--profile / --port / --dsh / --cwd / --interval / --wait-ms / --heartbeat-min）的取值：
    · **缺失 / 全空白 / 以 - 开头** → 用法错误（以 - 开头一定不是真取值，而是被吞掉的下一个开关）；
    · 数值开关还要求纯数字且在范围内（--port 1-65535；--interval 5-86400；--wait-ms 1-86400000；--heartbeat-min 1-1440）；
    · 统一支持内联写法 --flag=值（如 --profile=<目录> / --port=3099）；非取值开关写 = 会明确报错。
  未知开关：任何以 - 开头且不在已知开关表里的 token（**所有模式**，例如 --status --typo）→ 用法错误 + did-you-mean。
    开关名匹配**大小写敏感**（--UNINSTALL 不是 --uninstall，会被拒绝并提示最接近的写法）。
  位置参数（不以 - 开头的多余 token）：全局子命令（--uninstall / --install-autostart / --uninstall-autostart）拒绝；
    其余模式（前台 server / --ensure / --supervise / --status / --autostart-status）**警告并忽略**（兼容既有调用方脚本）。
  互斥：模式开关一次只能选一个（--uninstall / --install-autostart / --uninstall-autostart / --autostart-status /
    --status / --supervise / --ensure），多个同时出现 → 用法错误并列出冲突的开关；--help 例外（优先，直接打用法）。
  所有用法错误统一为：stderr 打印本用法、退出码 1，且**不执行任何动作**（不动注册表 / pid / 进程 / 日志）。
  另外，执行任何**全局性**动作（写或删 HKCU\...\Run 下的 DSHWeb*、写 profile 内 .vbs）之前，
  会先校验目标目录确实像 profile（存在 + 是目录 + 含 package.json / cordis*.yml）：不合法 → 拒绝 + 退出 1。
`;

// ---------------------------------------------------------------- 日志 / 路径
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function stamp() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 守护日志：落到 profile 目录，与 enginectl 的 rescue-daemon.log 同处。 */
function supLog(args, message) {
	const line = `[${stamp()}] ${message}`;
	if (!args.quiet) console.log(line);
	try { appendFileSync(join(args.profile, SUP_LOG), line + "\n", "utf8"); } catch { /* 日志失败不影响主流程 */ }
}

function supLogRaw(args, line) {
	try { appendFileSync(join(args.profile, SUP_LOG), `${line}\n`, "utf8"); } catch { /* ignore */ }
}

/** 读守护日志尾部若干行（诊断用）。 */
function readSupTail(args, lineCount = 6) {
	try {
		const text = readFileSync(join(args.profile, SUP_LOG), "utf8");
		const lines = text.slice(-8000).split(/\r?\n/).filter((line) => line.trim() !== "");
		return lines.slice(-lineCount).join("\n");
	} catch { return ""; }
}

function lastHeartbeat(args) {
	try {
		const text = readFileSync(join(args.profile, SUP_LOG), "utf8");
		const lines = text.split(/\r?\n/).filter((line) => line.includes("心跳"));
		return lines.length > 0 ? lines[lines.length - 1] : null;
	} catch { return null; }
}

const pidPathOf = (args) => join(args.profile, ".open-boot.pid");
const logPathOf = (args) => join(args.profile, "open-boot.log");
const engineLogPathOf = (args) => join(args.profile, "rescue-daemon.log");
/**
 * 2026-11-24 启动器补丁（自 v0.9.1 运行时补丁移植）：给启动页一个**可直接用的**入口 URL。
 * 引擎每次进程重启都会换新的 launchToken（每进程随机，只打印在自己的 stdout 上），而 web.log
 * 可能是上一个进程写的 → 拿旧 token 去跳只会撞 401。所以必须先验证：0.2.x 有效 token 返回
 * 303（浏览器带 cookie 落地）；无效/陈旧 token 是 401。两者都不是就不给 URL，页面退回旧行为。
 */
async function latestTokenUrl() {
	try {
		const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
		const text = readFileSync(join(home, "logs", "web.log"), "utf8");
		const tokenRe = new RegExp("http:\\/\\/127\\.0\\.0\\.1:" + ENGINE_PORT + "\\/\\?token=[A-Za-z0-9_\\-.]+", "g");
		const all = [...text.matchAll(tokenRe)].map((m) => m[0]);
		if (!all.length) return null;
		const url = all[all.length - 1];
		const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2500) });
		const body = await res.text();
		return res.status === 303 || (res.status === 200 && body.includes("__DSH_BOOT__")) ? url : null;
	} catch { return null; }
}

/**
 * G03/G04（rc.3 候选·token 链路可靠性）：引擎只在 config.printUrl 时 console.log 登录链接，且
 * announceReady 在连接就绪后才触发 → 重启场景 web.log 可能暂时没有新 token 行，latestTokenUrl()
 * 返回 null。这里在 null 时于 2s 内再轮询几次 web.log（每次启动是追加写，晚一点就有了）；
 * 仍拿不到就如实返回 null，**页面走降级指引，绝不渲染假 token 链接**。
 */
async function latestTokenUrlWithRetry(extraWaitMs = 2000) {
	const first = await latestTokenUrl();
	if (first) return first;
	const startedAt = Date.now();
	while (Date.now() - startedAt < extraWaitMs) {
		await sleep(400);
		const retry = await latestTokenUrl();
		if (retry) return retry;
	}
	return null;
}
const healthLogPath = (profileDir) => join(profileDir, HEALTH_LOG);

/**
 * 端口上的服务是不是"本启动器"：握手失败时**二次确认**一次。
 * 原因（2026-10-06 实测）：机器负载高时单次 1.5s 握手会偶发超时，而 `--status`/`--autostart-status`
 * 会据此打印"3081 被别人的进程占用"这种**吓人的误报**（并把 FAIL 写进 health.log）。
 * 这里沿用 ensureServer 的同一约定：有监听者但握手失败 → 等 500ms 后用更长的超时再确认。
 */
async function launcherHealthWithRetry(port) {
	const first = await launcherHealth(port);
	if (first.ok) return first;
	if (!(await probe(port))) return first;
	await sleep(500);
	return await launcherHealth(port, 3000);
}

// ---------------------------------------------------------------- 健康留痕（P1-5）
/**
 * 轮转：只保留最近 `maxAgeDays` 天（按行首 ISO 时间判断）且最多 `maxLines` 行。
 * 行首没有可解析时间戳的行按"用户手工内容"处理，不因年龄被丢（仍受行数上限约束）。
 */
export function pruneHealthEntries(lines = [], { maxLines = HEALTH_MAX_LINES, maxAgeDays = HEALTH_MAX_AGE_DAYS, now = Date.now() } = {}) {
	const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
	const kept = [];
	for (const raw of lines) {
		if (typeof raw !== "string") continue;
		const line = raw.trim();
		if (line === "") continue;
		const stamp = /^(\d{4}-\d{2}-\d{2}T\S+)/.exec(line);
		if (stamp) {
			const at = Date.parse(stamp[1]);
			if (Number.isFinite(at) && at < cutoff) continue;
		}
		kept.push(line);
	}
	return maxLines > 0 && kept.length > maxLines ? kept.slice(-maxLines) : kept;
}

/** 追加一行自检结论到 `<profile>/health.log`（不存在则创建；写失败不抛）。 */
export function appendHealthLog(profileDir, entry) {
	const path = healthLogPath(profileDir);
	let existing = [];
	try { existing = readFileSync(path, "utf8").split(/\r?\n/); } catch { /* 首次写入 */ }
	const merged = pruneHealthEntries([...existing, entry]);
	try {
		mkdirSync(profileDir, { recursive: true });
		writeFileSync(path, merged.join("\n") + "\n", "utf8");
	} catch (error) {
		return { ok: false, path, lines: 0, entry, message: `写健康日志失败：${error.message}` };
	}
	return { ok: true, path, lines: merged.length, entry, maxLines: HEALTH_MAX_LINES, maxAgeDays: HEALTH_MAX_AGE_DAYS };
}

/** 读 health.log 的最后一条记录（无文件/空文件 → null）。 */
export function readLastHealthEntry(profileDir) {
	try {
		const lines = pruneHealthEntries(readFileSync(healthLogPath(profileDir), "utf8").split(/\r?\n/));
		return lines.length > 0 ? lines[lines.length - 1] : null;
	} catch { return null; }
}

/** 组装一条自检结论行：`ISO 时间 OK/FAIL boot=<up|down|occupied>@<port> engine=<up|down|occupied>@<enginePort>`。 */
export function healthEntry({ ok, bootState, port, engineState, enginePort }) {
	return `${new Date().toISOString()} ${ok ? "OK" : "FAIL"} boot=${bootState}@${port} engine=${engineState}@${enginePort}`;
}

/** 读一个 JSON 文件（不存在/坏格式返回 null）。 */
function readJsonFile(path) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function modeOf(args) {
	if (args.uninstall) return "uninstall";
	if (args.autostart) return `autostart:${args.autostart}`;
	if (args.help) return "help";
	if (args.status) return "status";
	if (args.supervise) return "supervise";
	if (args.ensure) return "ensure";
	return "server";
}

/**
 * 崩溃/退出可观测（审计③ L3）：守护"静默消失"是本次审计里最难归因的问题，
 * 因此这里把未捕获异常、未处理的 Promise 拒绝、进程退出（退出码/模式/cwd）都落盘。
 */
function installCrashLogging(args) {
	try { mkdirSync(args.profile, { recursive: true }); } catch { /* ignore */ }
	const detail = (value) => (value && value.stack ? value.stack : String(value));
	process.on("uncaughtException", (error) => {
		supLogRaw(args, `[${stamp()}] ✗ 未捕获异常（模式 ${modeOf(args)}，pid ${process.pid}）：${detail(error)}`);
		if (!args.quiet) console.error(error);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		supLogRaw(args, `[${stamp()}] ✗ 未处理的 Promise 拒绝（模式 ${modeOf(args)}，pid ${process.pid}）：${detail(reason)}`);
	});
	process.on("exit", (code) => {
		supLogRaw(args, `[${stamp()}] 进程退出：code ${code}（模式 ${modeOf(args)}，pid ${process.pid}，cwd ${process.cwd()}）`);
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		try { process.on(signal, () => { supLogRaw(args, `[${stamp()}] 收到 ${signal}，退出（pid ${process.pid}）`); process.exit(0); }); }
		catch { /* 平台不支持该信号 */ }
	}
}

// ---------------------------------------------------------------- 弹窗启动
/**
 * 弹出一个**可见**的启动窗口跑 dsh-boot 启动序列（自检→修复→启动→等待）。
 * 这是「平时隐藏，拉起引擎时弹窗」约定的落点；失败时返回 ok:false 由调用方退回静默启动。
 *
 * v0.9.1-rc2（兼容性审计 C-05，high）：**不再静默假成功**——
 *  - 命令构造抽成纯函数 `enginectl.bootWindowPlan()`（macOS 用 `.command` 脚本 + `open`/`osascript`，
 *    Linux 按终端特性给 `--`/`-e` 形态与兜底链；旧实现的 `open -a Terminal <shell 命令行>` 与
 *    `gnome-terminal -e` 都是**不成立的命令形态**，会在用户机器上直接报错却被告知"已弹出"）；
 *  - 启动后**校验子进程的 error 事件与退出码**（`launchViaCandidates` + `verifyLauncherExit`），
 *    外加"端口是否真的出现监听者"的正向证据；任何一条候选立刻失败 → 逐个记原因并返回 ok:false。
 * @param {object} args parseArgs 结果（profile/dsh/waitMs/cwd…）
 * @param {object} [deps] 测试注入点：{ platform, execPath, plan, launch, probePort, probeFn, spawnFn }
 */
export async function spawnBootWindow(args, deps = {}) {
	const bootScript = join(dirname(SELF), "dsh-boot.mjs");
	if (!existsSync(bootScript)) return { ok: false, message: "缺少 bin/dsh-boot.mjs" };
	// 窗口进程的 cwd 用稳定目录（审计③ L2）：不要把 cwd 留在本包/profile 目录里，
	// 否则引擎会继承一个"锁住包目录"的工作目录，pnpm 更新/卸载会 EPERM。
	const workDir = resolveEngineCwd(args.cwd);
	const bootArgs = [bootScript, "--profile", args.profile, "--dsh", args.dsh, "--wait-ms", String(args.waitMs), "--pause"];
	const platform = deps.platform ?? process.platform;
	const execPath = deps.execPath ?? process.execPath;
	const scriptPath = join(args.profile, "open-boot-window.command");
	const plan = deps.plan ?? bootWindowPlan({
		platform, execPath, bootArgs, workDir, scriptPath,
		available: platform === "linux" ? detectAvailableTerminals() : null
	});
	if (!plan.ok) {
		return { ok: false, platform, plan, message: `弹窗启动不可用：${plan.reason}（改为静默启动）` };
	}
	if (plan.script) {
		// macOS：先把命令写成 .command 脚本（chmod 755），再让 open 打开**文件**（C-05 的关键修正）
		try {
			mkdirSync(args.profile, { recursive: true });
			writeFileSync(scriptPath, plan.script, { mode: 0o755 });
			chmodSync(scriptPath, 0o755);
		} catch (error) {
			return { ok: false, platform, plan, message: `无法写 macOS 启动脚本 ${scriptPath}：${error instanceof Error ? error.message : String(error)}（改为静默启动）` };
		}
	}
	const stderrPath = join(args.profile, "open-boot-window.stderr.log");
	const launch = deps.launch ?? launchViaCandidates;
	const result = await launch(plan.candidates, {
		probePort: deps.probePort === void 0 ? ENGINE_PORT : deps.probePort,
		probeFn: deps.probeFn ?? probe,
		spawnFn: deps.spawnFn,
		graceMs: deps.graceMs,
		cwd: workDir,
		stderrPath,
		readStderrText: () => { try { return readFileSync(stderrPath, "utf8"); } catch { return ""; } }
	});
	if (result.ok) {
		return {
			ok: true, platform, plan, via: result.via, attempts: result.attempts, verdict: result.verdict,
			message: `已弹出启动窗口（${plan.kind === "windows" ? "cmd /c start" : result.via}；证据：${result.evidence}）`
		};
	}
	return {
		ok: false, platform, plan, attempts: result.attempts,
		message: `弹窗启动**失败**（不再谎报成功），改为静默启动：${result.reason}`
	};
}

// ---------------------------------------------------------------- boot 流程
/**
 * boot 流程。窗口模式（默认）下由可见窗口负责 自检→修复→启动；
 * --no-window 时退回内部静默启动（含运行期失败条目隔离重试）。
 */
async function boot(args, onLog = () => {}) {
	// 引擎健康 = HTTP 握手 + 身份指纹（审计③ L4）：裸 TCP 可连不算"引擎就绪"
	const health = await engineHealth(ENGINE_PORT);
	if (health.ok) {
		return { ok: true, alreadyRunning: true, healthy: true, entryUrl: await latestTokenUrlWithRetry(), message: `引擎已在 ${ENGINE_PORT} 运行（HTTP 握手正常），直接打开主界面。` };
	}
	if (await probe(ENGINE_PORT)) {
		// 2026-11-24 启动器补丁（自 v0.9.1 运行时补丁移植）：开机时 DSHWebRescue（--no-open 起引擎）
		// 与本启动器会同时动作，3080 **已监听但 HTTP 握手还没就绪**是"正在启动"的正常瞬时状态
		// （0.2.2 先绑端口后注册路由，窗口期内 GET / 是 404）。旧逻辑把它当成"外来进程占用"并要求
		// 用户手动结束进程 → 用户杀掉的正是刚起来的真引擎（"每次重启都得杀 node"的自锁根因）。
		// 新逻辑：监听者是 node.exe 就当作引擎正在启动，先等握手；只有非 node 监听者才报外来占用。
		const owner = portOwner(ENGINE_PORT);
		const ownerImage = owner === null ? null : processImage(owner);
		const ownerIsNode = ownerImage !== null && /^node(\.exe)?$/i.test(ownerImage);
		if (ownerIsNode) {
			onLog(`端口 ${ENGINE_PORT} 上已有 node 进程（pid ${owner}）但握手未就绪：判定为引擎正在启动，最多等待 ${Math.round(args.waitMs / 1000)}s`);
			if (await waitForEngine(ENGINE_PORT, args.waitMs, 500, engineHealth)) {
				return {
					ok: true, alreadyRunning: true, healthy: true, starting: true, entryUrl: await latestTokenUrlWithRetry(),
					message: `引擎正在启动，已就绪（pid ${owner}）。`
				};
			}
			return {
				ok: false, alreadyRunning: false, starting: true, occupied: false, verifyOk: null, issues: [],
				logPath: engineLogPathOf(args),
				message: `引擎进程（pid ${owner}）占着 ${ENGINE_PORT}，但 ${Math.round(args.waitMs / 1000)}s 内 HTTP 握手未就绪。⚠ 不要结束这个进程（它就是真正的引擎）：稍等后刷新本页，或到救援中心查看引擎日志。`
			};
		}
		return {
			ok: false, alreadyRunning: false, occupied: true, portOwner: owner, verifyOk: null, issues: [],
			logPath: engineLogPathOf(args),
			message: `端口 ${ENGINE_PORT} 被${owner ? ` pid ${owner}` : "其他进程"}（${ownerImage ?? "未知映像"}）占用，且它不是 dsh 引擎（HTTP 握手失败）：拒绝跳转到坏页面，也不会重复启动。请先用任务管理器确认并结束该进程。`
		};
	}

	// 自检（窗口模式下只做只读自检：真正的修复交给窗口里的 dsh-boot，避免两处同时改配置）
	const verify = verifyProfile(args.profile);
	let fixed = null;
	if (!args.window && !verify.ok && verify.issues.length > 0) {
		fixed = fixProfile(args.profile);
	}
	onLog(`自检：${verify.ok ? "配置正常" : `发现 ${verify.issues.length} 个问题`}`);

	let windowInfo = null;
	if (args.window) {
		// C-05：spawnBootWindow 现在会**校验子进程的 error/退出码**，只有真的起来才 ok:true
		windowInfo = await spawnBootWindow(args);
		onLog(windowInfo.ok ? windowInfo.message : `弹窗失败（${windowInfo.message}），改为静默启动`);
	}

	if (!args.window || !windowInfo.ok) {
		const start = await startEngineWithQuarantine({ profileDir: args.profile, dshCmd: args.dsh, isolateFailedEntries, waitMs: args.waitMs, cwd: args.cwd });
		return {
			ok: start.ok, alreadyRunning: false, verifyOk: verify.ok, issues: verify.issues, fixed,
			window: windowInfo, quarantined: start.quarantined, quarantineMessage: start.quarantineMessage,
			start, logPath: start.log || engineLogPathOf(args),
			entryUrl: start.ok ? await latestTokenUrlWithRetry() : null,
			message: start.message
		};
	}

	// 窗口模式：等窗口里的启动序列把引擎拉起来（同样用 HTTP 健康判定）
	const up = await waitForEngine(ENGINE_PORT, args.waitMs, 300, engineHealth);
	return {
		ok: up, alreadyRunning: false, verifyOk: verify.ok, issues: verify.issues, fixed,
		window: windowInfo, quarantined: [], logPath: engineLogPathOf(args),
		entryUrl: up ? await latestTokenUrlWithRetry() : null,
		message: up ? `引擎已启动并就绪（${ENGINE_PORT}）。` : `引擎启动超时（${Math.round(args.waitMs / 1000)}s），请看启动窗口/日志：${engineLogPathOf(args)}`
	};
}

// ---------------------------------------------------------------- 常驻守护
function acquireLock(lockPort) {
	return new Promise((resolveLock) => {
		const server = createLockServer();
		// 同步异常（如端口越界）也要能落到结果里，避免未捕获拒绝
		server.once("error", (error) => resolveLock({ error }));
		try {
			server.listen(lockPort, "127.0.0.1", () => resolveLock(server));
		} catch (error) {
			resolveLock({ error });
		}
	});
}

/** 读启动器 pid 文件并做存活 + 身份校验（取不到可信 pid 返回 null）。 */
function readLivePid(args) {
	try {
		const file = pidPathOf(args);
		if (!existsSync(file)) return null;
		const age = Date.now() - statSync(file).mtimeMs;
		if (age > 24 * 60 * 60 * 1000) return null; // 超过一天的 PID 文件不再可信
		const info = readPidInfo(args.profile);
		if (!info) return null;
		const pid = info.pid;
		if (!isAlive(pid)) return null;
		const image = processImage(pid);
		if (image !== null && !/^node(\.exe)?$/.test(image)) {
			supLog(args, `pid 文件里的 ${pid} 现在是 ${image}（不是 node），忽略以免误杀`);
			return null;
		}
		return pid;
	} catch { return null; }
}

/**
 * 确保 3081 上有**本启动器**在跑。
 * 审计③ L4：判定用 HTTP 握手 + 身份，而不是"端口能连"；
 *           端口被别的东西占用时明确报错（不假健康、不静默漂移、不杀别人的进程）。
 */
async function ensureServer(args) {
	const health = await launcherHealth(args.port);
	if (health.ok) return { ok: true, alreadyRunning: true, state: "up", identity: health.identity, pid: health.json?.pid ?? null };

	if (await probe(args.port)) {
		await sleep(3000); // 二次确认，避免抖动
		const retry = await launcherHealth(args.port);
		if (retry.ok) return { ok: true, alreadyRunning: true, state: "up", identity: retry.identity, pid: retry.json?.pid ?? null };
		const owner = portOwner(args.port);
		return {
			ok: false, alreadyRunning: false, state: "foreign", portOwner: owner,
			message: `端口 ${args.port} 被非本工具进程占用（pid ${owner ?? "未知"}）：本工具不会在此端口重复拉起，也不会结束别人的进程。请结束该进程或改用 --port（并把浏览器主页改成新端口）。`
		};
	}

	const livePid = readLivePid(args);
	if (livePid) {
		supLog(args, `pid ${livePid} 存活但 ${args.port} 未通过 HTTP 握手，等待 15s`);
		if (await waitForEngine(args.port, 15000, 500, launcherHealth)) return { ok: true, alreadyRunning: true, state: "up" };
		try {
			process.kill(livePid);
			supLog(args, `回收卡死的启动器 pid ${livePid}`);
			await sleep(1000);
		} catch (error) {
			supLog(args, `无法回收 pid ${livePid}：${error.message}`);
			return { ok: false, alreadyRunning: false, state: "stuck", message: `启动器 pid ${livePid} 无响应且无法结束：${error.message}` };
		}
	}

	let logFd = null;
	try {
		logFd = openSync(logPathOf(args), "a");
		// 注意：这里**故意不用 windowsHide:true**。libuv 的 windowsHide 会设置
		// STARTF_USESHOWWINDOW/SW_HIDE，而该状态会被子进程继承——那样下面 boot()
		// 弹出的启动窗口也会是隐藏的（"平时隐藏、拉起引擎时弹窗"就失效了）。
		// detached 已经保证它没有控制台、不会闪窗，所以无需 windowsHide。
		// cwd 用稳定目录（审计③ L2）：启动器自己的 cwd 也不能留在本包/profile 目录里。
		const child = spawn(process.execPath, [SELF, "--profile", args.profile, "--port", String(args.port), "--dsh", args.dsh], {
			cwd: resolveEngineCwd(args.cwd), detached: true, stdio: ["ignore", logFd, logFd]
		});
		child.unref();
		writeFileSync(pidPathOf(args), JSON.stringify({
			app: LAUNCHER_APP, pid: child.pid, port: args.port, profile: args.profile,
			startedAt: new Date().toISOString(), launcherPid: process.pid
		}) + "\n", "utf8");
		supLog(args, `已拉起启动器 pid ${child.pid}（cwd ${resolveEngineCwd(args.cwd)}）`);
	} catch (error) {
		supLog(args, `拉起失败：${error.message}`);
		return { ok: false, alreadyRunning: false, state: "error", message: `拉起启动器失败：${error.message}` };
	} finally {
		if (logFd !== null) { try { closeSync(logFd); } catch { } }
	}

	const up = await waitForEngine(args.port, 25000, 500, launcherHealth);
	supLog(args, up ? `端口 ${args.port} 就绪（HTTP 握手通过）` : `端口 ${args.port} 超时未就绪（未通过 HTTP 握手）`);
	return { ok: up, alreadyRunning: false, state: up ? "spawned" : "timeout", message: up ? `已在 ${args.port} 拉起启动器。` : `启动器在 25s 内未就绪，见 ${logPathOf(args)}` };
}

/**
 * 上一次守护有没有留下"正常退出"记录？
 * 审计③ L3 的可观测性缺口：Windows 上被 taskkill /F 或杀软强制结束的进程**无法**执行任何退出钩子
 * （Node 的 SIGTERM handler 在 Windows 上也不会被触发），所以"守护静默消失"只能靠**事后对账**发现：
 * 若日志里最后一次"守护启动"之后没有"进程退出"行，就说明上次是被外部强制结束的。
 */
function previousRunWasUnclean(args) {
	try {
		const text = readFileSync(join(args.profile, SUP_LOG), "utf8");
		const lines = text.split(/\r?\n/);
		let lastStart = -1;
		let lastExit = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes("守护启动：")) lastStart = i;
			// 只认"守护模式"自己的退出行：同目录日志里还有 --ensure/--status 等其它模式的退出行，不能混算
			if (lines[i].includes("进程退出：") && lines[i].includes("模式 supervise")) lastExit = i;
		}
		if (lastStart < 0) return null; // 首次运行
		if (lastExit > lastStart) return null; // 上次正常退出过
		return { line: lines[lastStart], index: lastStart };
	} catch { return null; }
}

async function supervise(args) {
	const lockPort = lockPortOf(args.port);
	if (lockPort === null) {
		supLog(args, `✘ 无法推导守护锁端口：启动器端口 ${args.port} + 1000 超过 65535。请改用 1..64535 的端口（默认 3081）。`);
		return 1;
	}
	const lock = await acquireLock(lockPort);
	if (!lock || lock.error) {
		supLog(args, `已有守护占用锁端口 ${lockPort}（${lock?.error?.code || "EADDRINUSE"}），本进程退出`);
		return 0;
	}
	const unclean = previousRunWasUnclean(args);
	if (unclean) {
		supLog(args, `⚠ 上一次守护没有留下正常退出记录（很可能被 taskkill /F 或杀软强制结束，Windows 上这类结束无法写日志）；上次启动于：${unclean.line}`);
	}
	const heartbeatMs = Math.max(60 * 1000, args.heartbeatMin * 60 * 1000);
	supLog(args, `守护启动：每 ${args.interval}s 检查 ${args.port}（锁端口 ${lockPort}，心跳每 ${args.heartbeatMin} 分钟，pid ${process.pid}）`);
	let lastHeartbeatAt = 0;
	let lastState = null;
	for (;;) {
		try {
			const result = await ensureServer(args);
			const stateKey = `${result.state}:${result.identity || ""}`;
			if (stateKey !== lastState) {
				const detail = result.state === "up"
					? `${args.port} 正常（${result.identity}${result.pid ? ` pid ${result.pid}` : ""}）`
					: result.state === "foreign" ? `⚠ ${result.message}`
						: result.state === "spawned" ? "已拉起启动器"
							: result.state === "timeout" ? `⚠ 启动器未就绪：${result.message || ""}`
								: `⚠ ${result.message || result.state}`;
				supLog(args, `状态变化：${detail}`);
				lastState = stateKey;
				lastHeartbeatAt = Date.now();
			} else if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
				const engine = await engineHealth(ENGINE_PORT);
				supLog(args, `心跳：${args.port} ${result.ok ? "正常" : "异常"}（${result.identity || result.state}）；引擎 ${ENGINE_PORT} ${engine.ok ? "正常" : "未就绪"}；pid ${process.pid}`);
				lastHeartbeatAt = Date.now();
			}
		} catch (error) {
			supLog(args, `检查异常：${error.message}`);
			lastState = null;
		}
		await sleep(args.interval * 1000);
	}
}

// ---------------------------------------------------------------- 状态自检
/**
 * `--status`：一次性打印启动器/守护/引擎的真实状态（审计③ L3）。
 * 退出码：0 = 本启动器健康；1 = 启动器未就绪（被占用/未运行）。
 */
async function reportStatus(args) {
	const lockPort = lockPortOf(args.port);
	const lines = [];
	const launcher = await launcherHealthWithRetry(args.port);
	const tcp = await probe(args.port);
	const owner = tcp ? portOwner(args.port) : null;
	if (launcher.ok) {
		const json = launcher.json || {};
		lines.push(`启动器（${args.port}）：✔ 在跑（identity=${launcher.identity}${json.pid ? `，pid ${json.pid}` : ""}）`);
		if (json.profile) lines.push(`  上报 profile：${json.profile}；window=${json.window}；version=${json.version ?? "?"}`);
	} else if (tcp) {
		lines.push(`启动器（${args.port}）：✘ 端口被 pid ${owner ?? "未知"} 占用，但它不是本启动器（${launcher.error || "HTTP 握手失败"}）`);
		lines.push(`  ⚠ 浏览器主页若设为 http://127.0.0.1:${args.port}/ 会打开别人的服务；请结束该进程或改用 --port。`);
	} else {
		lines.push(`启动器（${args.port}）：✘ 没有监听者（未运行）`);
	}

	const lockOwner = lockPort === null ? null : portOwner(lockPort);
	lines.push(lockPort === null
		? `守护：✘ 无法推导锁端口（启动器端口 ${args.port} + 1000 超过 65535）`
		: `守护：${lockOwner ? `pid ${lockOwner} 持有锁端口 ${lockPort}（守护在跑）` : `无进程持有锁端口 ${lockPort}（守护未运行，或被外部结束过；见下方日志）`}`);

	const engine = await engineHealth(ENGINE_PORT);
	const engineTcp = engine.ok ? true : await probe(ENGINE_PORT);
	if (engine.ok) lines.push(`引擎（${ENGINE_PORT}）：✔ HTTP 握手正常（${engine.marker || `HTTP ${engine.status}`}）`);
	else if (engineTcp) lines.push(`引擎（${ENGINE_PORT}）：✘ 端口有监听者（pid ${portOwner(ENGINE_PORT) ?? "未知"}）但不是 dsh 引擎（HTTP 握手失败）`);
	else lines.push(`引擎（${ENGINE_PORT}）：✘ 未运行`);

	const launcherInfo = readJsonFile(pidPathOf(args));
	const engineInfo = readPidInfo(args.profile);
	lines.push(`启动器 PID 文件（.open-boot.pid）：${launcherInfo ? `${JSON.stringify(launcherInfo)}${isAlive(launcherInfo.pid) ? "（进程存活）" : "（进程已不存在）"}` : "无"}`);
	lines.push(`引擎 PID 文件（.rescue-daemon.pid）：${engineInfo ? JSON.stringify(engineInfo) : "无"}`);
	lines.push(`cwd：${process.cwd()}（引擎 cwd 使用 ${resolveEngineCwd(args.cwd)}）`);
	const hb = lastHeartbeat(args);
	lines.push(`日志：${join(args.profile, SUP_LOG)}；${logPathOf(args)}；${engineLogPathOf(args)}`);
	lines.push(`最后一次心跳：${hb || "（无心跳记录）"}`);

	// P1-5 健康留痕：把本次结论追加进 <profile>/health.log（ISO 时间 + OK/FAIL + engine/boot 端口状态），
	// 控制台同时给出「最近自检」行（本条 + 上一条，均取自该日志）。--status 仍然不改 profile 配置。
	const bootState = launcher.ok ? "up" : tcp ? "occupied" : "down";
	const engineState = engine.ok ? "up" : engineTcp ? "occupied" : "down";
	const entry = healthEntry({ ok: launcher.ok, bootState, port: args.port, engineState, enginePort: ENGINE_PORT });
	const previous = readLastHealthEntry(args.profile);
	const written = appendHealthLog(args.profile, entry);
	lines.push(`最近自检：${entry}${previous ? `（上一次：${previous}）` : "（此前无记录，本次为第一条）"}`);
	lines.push(written.ok
		? `自检日志：${written.path}（共 ${written.lines} 行；轮转保留最近 ${HEALTH_MAX_AGE_DAYS} 天 / 最多 ${HEALTH_MAX_LINES} 行）`
		: `自检日志：写入失败 —— ${written.message}`);

	const tail = readSupTail(args, 5);
	if (tail) lines.push(`日志尾部：\n${tail}`);
	return { ok: launcher.ok, message: lines.join("\n"), healthEntryText: entry, healthLog: written.path, previousHealthEntry: previous };
}

// ---------------------------------------------------------------- 开机自启
function autostartShimPath(args) { return join(args.profile, "open-boot-autostart.vbs"); }
function uiShimPath(args) { return join(args.profile, "open-boot-ui.vbs"); }

/**
 * 生成包装 .vbs 的正文。
 * 审计③ L8：**不再把 profile 路径写死在文件里**——WSH 按 ANSI 读取无 BOM 的 .vbs，
 * 中文用户名（C:\Users\张三\…）会被写成乱码。这里改为在运行时用 WScript.ScriptFullName
 * 推导自身所在目录（包装脚本就放在 profile 目录里），因此正文保持纯 ASCII。
 * node 可执行文件：能安全内嵌时内嵌（ASCII 路径），否则回退 %ProgramFiles%\nodejs\node.exe / PATH 上的 node。
 */
function buildShimLines(args, mode) {
	const execPath = process.execPath;
	const asciiExec = /^[\x00-\x7F]*$/.test(execPath);
	const lines = [
		"Set fso = CreateObject(\"Scripting.FileSystemObject\")",
		"Set sh  = CreateObject(\"WScript.Shell\")",
		"base   = fso.GetParentFolderName(WScript.ScriptFullName)",
		"script = base & \"\\node_modules\\dsh-drydock\\bin\\open-boot.mjs\"",
		"If Not fso.FileExists(script) Then",
		"  On Error Resume Next",
		"  Set lf = fso.OpenTextFile(base & \"\\open-boot-autostart.error.log\", 8, True)",
		"  lf.WriteLine Now & \" launcher script missing: \" & script",
		"  lf.Close",
		"  WScript.Quit 3",
		"End If"
	];
	if (asciiExec) {
		lines.push(`node = """${execPath}"""`);
	} else {
		lines.push("node = \"node\"");
		lines.push("pf = sh.ExpandEnvironmentStrings(\"%ProgramFiles%\")");
		lines.push("If fso.FileExists(pf & \"\\nodejs\\node.exe\") Then node = \"\"\"\" & pf & \"\\nodejs\\node.exe\" & \"\"\"\"");
	}
	if (mode === "supervise") {
		// VBS 里的引号要成对转义：`" """ ` = 空格 + 一个引号；`""" xxx """` = `" xxx "`。
		// 目标命令行： "<node>" "<script>" --supervise --profile "<base>" --port <port> --quiet
		lines.push(`sh.Run node & " """ & script & """ --supervise --profile """ & base & """ --port ${args.port} --quiet", 0, False`);
	} else {
		lines.push(`sh.Run node & " """ & script & """ --ensure --profile """ & base & """ --port ${args.port} --quiet", 0, True`);
		lines.push(`sh.Run "http://127.0.0.1:${args.port}/", 1, False`);
	}
	return lines;
}

/**
 * 写 .vbs 包装脚本（审计③ L8）：
 *  - 正文纯 ASCII → 直接写 ASCII；万一含非 ASCII → 写 UTF-16LE + BOM（WSH 认得带 BOM 的 Unicode 脚本）。
 *  - 写完**回读校验**（字节数 + 每条命令行都在），校验不过就抛错：宁可不装自启，也不装一个坏的。
 */
function writeShim(path, runLines) {
	const body = ["' Generated by dsh-drydock. Safe to delete.", ...runLines].join("\r\n") + "\r\n";
	const asciiSafe = /^[\x00-\x7F]*$/.test(body);
	const encoded = asciiSafe ? Buffer.from(body, "ascii") : Buffer.from(`\uFEFF${body}`, "utf16le");
	writeFileSync(path, encoded);
	const readBack = readFileSync(path);
	if (!readBack.equals(encoded)) throw new Error(`回读校验失败：${path} 写入 ${encoded.length} 字节、读回 ${readBack.length} 字节`);
	const text = asciiSafe ? readBack.toString("ascii") : readBack.subarray(2).toString("utf16le");
	for (const line of runLines) {
		if (!text.includes(line)) throw new Error(`回读校验失败：${path} 缺少命令行 ${JSON.stringify(line.slice(0, 60))}…`);
	}
	return { path, bytes: encoded.length, encoding: asciiSafe ? "ascii" : "utf-16le+bom", verified: true };
}

function regQuery(name) {
	if (process.platform !== "win32") return { status: 2, value: "" };
	const out = spawnSync("reg", ["query", RUN_KEY, "/v", name], { windowsHide: true, encoding: "utf8" });
	if (out.status !== 0) return { status: 1, value: "" };
	const match = /REG_SZ\s+(.+)\s*$/m.exec(out.stdout || "");
	return { status: 0, value: match ? match[1].trim() : "" };
}

/** 列出 `HKCU\...\Run` 下的全部值（name/type/data）。非 Windows 返回 `[]`；**读取失败返回 null**（≠ 没有值）。 */
export function listRunValues() {
	if (process.platform !== "win32") return [];
	const out = spawnSync("reg", ["query", RUN_KEY], { windowsHide: true, encoding: "utf8", timeout: 10000 });
	if (out.status !== 0 || !out.stdout) return null;
	const values = [];
	for (const line of out.stdout.split(/\r?\n/)) {
		// 值行形如：`    DSHWebFront    REG_SZ    "C:\Windows\System32\wscript.exe" //nologo "…vbs"`
		const m = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
		if (m) values.push({ name: m[1], type: m[2], data: m[3].trim() });
	}
	return values;
}

/**
 * 从自启值数据里解析"被启动的脚本路径"（本工具生成的形态：
 * `"C:\Windows\System32\wscript.exe" //nologo "<abs>\open-boot-autostart.vbs"`）。
 * 容错：优先取最后一个 `.vbs` 引号路径；退化为任意 `.vbs` 绝对路径；解析不出返回 null。
 */
export function extractShimPath(data) {
	const text = String(data ?? "");
	const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	const quotedVbs = [...quoted].reverse().find((p) => /\.vbs$/i.test(p));
	if (quotedVbs) return quotedVbs;
	const bare = /([A-Za-z]:\\[^"]*?\.vbs)(?=\s|$|"|;)/i.exec(text);
	return bare ? bare[1] : null;
}

/** 路径是否位于目录内（大小写无关；Windows 路径统一成正斜杠比较）。 */
function isInsideDir(child, dir) {
	const norm = (p) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const c = norm(child);
	const d = norm(dir);
	return c === d || c.startsWith(`${d}/`);
}

/**
 * t31（F6）：判定一个 `DSHWeb*` 自启值该怎么处理 —— **按 profile 作用域**，纯函数便于单测。
 *
 * 之前 `--uninstall` 会删掉 Run 键下**所有** `DSHWeb*`，与 `--profile` 指向哪个 profile 无关：
 * 在一次临时/非默认 profile 的卸载里，会顺手删掉**另一个 profile**（例如真机）的开机自启项。
 * 现在的判定：
 *   · 数据指向的脚本在**目标 profile 目录内** → 删（属于本 profile）；
 *   · 脚本文件**不存在**（死指针，含历史 `DSHWebRescue` 指向的已消失路径）→ 删（留着只会误导）；
 *   · 其它（指向别的 profile / 其它工具写的 `DSHWeb*` / 数据里没有 .vbs 路径）→ **保留并报告**。
 * @returns {{action:"delete"|"keep", reason:string, shim:string|null}}
 */
export function classifyAutostartValue(value, { profileDir } = {}) {
	const shim = extractShimPath(value?.data);
	if (!shim) {
		return { action: "keep", reason: "跳过：数据里没有 .vbs 脚本路径（不是本工具写的形态）", shim: null };
	}
	if (profileDir && isInsideDir(shim, profileDir)) {
		return {
			action: "delete",
			reason: existsSync(shim)
				? `属于本 profile（${dirname(shim)}）`
				: `属于本 profile 且脚本已不存在（死指针）：${shim}`,
			shim
		};
	}
	if (!existsSync(shim)) return { action: "delete", reason: `死指针：脚本文件不存在（${shim}）`, shim };
	return { action: "keep", reason: `跳过：属于其它 profile（${dirname(shim)}）`, shim };
}

/** 文件名安全的时间戳：`YYYYMMDD-HHmmss`（注册表备份用）。 */
function fileStamp(date = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** t31：删除前把整个 Run 键导出到 `<profile>\.plugin-manager\registry-backup-<ts>.reg`（失败只告警，不阻断）。 */
export function backupRunKey(profileDir, { timeoutMs = 15000, now = new Date() } = {}) {
	const dir = join(profileDir, ".plugin-manager");
	const file = join(dir, `registry-backup-${fileStamp(now)}.reg`);
	if (process.platform !== "win32") return { ok: false, path: file, message: "非 Windows：跳过注册表备份" };
	try { mkdirSync(dir, { recursive: true }); }
	catch (error) { return { ok: false, path: file, message: `⚠ 注册表备份失败（不阻断）：无法创建 ${dir}（${error.message}）` }; }
	const out = spawnSync("reg", ["export", RUN_KEY, file, "/y"], { windowsHide: true, encoding: "utf8", timeout: timeoutMs });
	const detail = out.error ? `${out.error.code || "spawn-error"} ${out.error.message}`.trim() : (out.stderr || "").trim();
	if (out.error || out.status !== 0 || !existsSync(file)) {
		return { ok: false, path: file, message: `⚠ 注册表备份失败（不阻断）：${detail || `reg export exit ${out.status}`}` };
	}
	return { ok: true, path: file, message: `已备份注册表 Run 键 → ${file}` };
}

/**
 * t31（F6）：**按 profile 作用域**清理 `DSHWeb*` 自启值（含死指针），其余值报告而不删。
 *
 * @param {object} args 解析后的参数（必须带 profile）
 * @param {object} deps 可注入依赖（测试用）：{ listValues, deleteValue, exportKey }
 * @returns {{ok, readable, removed, deleted, kept, failed, backup, message}}
 */
export function removeProfileRunValues(args = {}, deps = {}) {
	const listValues = deps.listValues ?? listRunValues;
	const deleteValue = deps.deleteValue ?? ((name) => spawnSync("reg", ["delete", RUN_KEY, "/v", name, "/f"], { windowsHide: true, encoding: "utf8", timeout: 10000 }));
	const exportKey = deps.exportKey ?? backupRunKey;
	if (!args || typeof args.profile !== "string" || args.profile.trim() === "") {
		return {
			ok: false, readable: false, removed: [], deleted: [], kept: [], failed: [], backup: null,
			message: "⚠ 拒绝清理自启值：缺少明确的 --profile 目标（按 profile 作用域清理必须知道自己在为哪个 profile 卸载）"
		};
	}
	if (process.platform !== "win32") {
		return { ok: true, skipped: true, readable: false, removed: [], deleted: [], kept: [], failed: [], backup: null, message: "非 Windows：跳过注册表清理" };
	}
	const values = listValues();
	if (values === null) {
		return {
			ok: true, skipped: false, readable: false, removed: [], deleted: [], kept: [], failed: [], backup: null,
			message: `⚠ 无法读取注册表 ${RUN_KEY}（reg query 失败或被安全策略拦截）：DSHWeb* 自启残留**未确认**，请人工用 reg query 核对`
		};
	}
	const planned = values
		.filter((value) => RUN_VALUE_PREFIX.test(value.name))
		.map((value) => ({ ...value, verdict: classifyAutostartValue(value, { profileDir: args.profile }) }));
	const toDelete = planned.filter((item) => item.verdict.action === "delete");
	const kept = planned
		.filter((item) => item.verdict.action === "keep")
		.map((item) => ({ name: item.name, type: item.type, data: item.data, reason: item.verdict.reason, shim: item.verdict.shim }));

	// 删除前先备份（仅当真要删；失败只告警，不阻断）
	const backup = toDelete.length > 0
		? exportKey(args.profile)
		: { ok: true, skipped: true, path: null, message: "没有需要删除的值（无需备份）" };

	const deleted = [];
	const failed = [];
	for (const item of toDelete) {
		const out = deleteValue(item.name) || {};
		const detail = (out.stderr || out.stdout || (out.error ? out.error.message : "")).trim();
		if (out.status === 0 || deps.deleteValue) deleted.push({ name: item.name, type: item.type, data: item.data, reason: item.verdict.reason, shim: item.verdict.shim });
		else failed.push({ name: item.name, message: detail || `reg delete exit ${out.status}` });
	}

	// 输出：已删除 / 已跳过 两块逐条（键名 + 类型 + 数据 + 判定理由）→ 卸载输出本身可当审计证据
	const lines = [];
	lines.push(`按 profile 作用域清理（目标 profile：${args.profile}）`);
	if (backup?.message) lines.push(`备份：${backup.message}`);
	if (deleted.length > 0) {
		lines.push(`已删除（${deleted.length}）：`);
		for (const item of deleted) lines.push(`   · ${item.name}  ${item.type}  ${item.data}  —— ${item.reason}`);
	} else {
		lines.push("已删除（0）：没有属于本 profile 的 DSHWeb* 值");
	}
	if (kept.length > 0) {
		lines.push(`已跳过（${kept.length}，未删除）：`);
		for (const item of kept) lines.push(`   · ${item.name}  ${item.type}  ${item.data}  —— ${item.reason}`);
	}
	if (failed.length > 0) {
		lines.push(`删除失败（${failed.length}）：`);
		for (const item of failed) lines.push(`   ✘ ${item.name}：${item.message}`);
	}
	return {
		ok: failed.length === 0, skipped: false, readable: true,
		removed: deleted.map((item) => item.name), deleted, kept, failed, backup,
		message: lines.join("\n")
	};
}

/**
 * @deprecated t31 起名字不再准确（不再"删所有 DSHWeb*"，而是按 profile 作用域）。
 * 保留导出仅为兼容既有引用；新代码请用 `removeProfileRunValues(args)`。
 */
export function removeDsWebRunValues(args) {
	return removeProfileRunValues(args);
}

/**
 * `--autostart-status`（审计③ L3）：除了注册表值，还校验
 *   ① 包装脚本是否存在 ② 守护是否持有锁端口 ③ 3081 上是不是本启动器
 */
async function autostartStatus(args) {
	if (process.platform !== "win32") return { ok: false, message: "开机自启管理目前仅支持 Windows。" };
	const query = regQuery(AUTOSTART_NAME);
	const shimFromReg = /"([^"]+\.vbs)"/i.exec(query.value);
	const shimPath = shimFromReg ? shimFromReg[1] : autostartShimPath(args);
	const shimExists = existsSync(shimPath);
	const lines = [];
	if (query.status !== 0) {
		lines.push(`${AUTOSTART_NAME}：未安装`);
		lines.push(`  （可执行：node ${SELF} --install-autostart）`);
	} else {
		lines.push(`${AUTOSTART_NAME}：已安装`);
		lines.push(`  命令：${query.value}`);
		lines.push(`  包装脚本：${shimPath} ${shimExists ? `✔ 存在（${statSync(shimPath).size} 字节）` : "✘ 不存在（自启会失败，请重新 --install-autostart）"}${shimFromReg ? "" : "（注册表未指向本工具的 vbs）"}`);
	}
	const lockPort = lockPortOf(args.port);
	const lockOwner = lockPort === null ? null : portOwner(lockPort);
	lines.push(`  守护进程：${lockPort === null ? `✘ 无法推导锁端口（启动器端口 ${args.port} + 1000 超过 65535）`
		: lockOwner ? `✔ pid ${lockOwner} 持有锁端口 ${lockPort}` : `✘ 无进程持有锁端口 ${lockPort}（守护未运行；下次登录会由自启拉起）`}`);
	const launcher = await launcherHealthWithRetry(args.port);
	if (launcher.ok) lines.push(`  启动器（${args.port}）：✔ 在跑（${launcher.identity}）`);
	else if (await probe(args.port)) lines.push(`  启动器（${args.port}）：✘ 端口被 pid ${portOwner(args.port) ?? "未知"} 占用，不是本启动器`);
	else lines.push(`  启动器（${args.port}）：✘ 未运行`);
	lines.push(`  最近心跳：${lastHeartbeat(args) || "（无）"}`);
	return { ok: true, installed: query.status === 0, shimExists, message: lines.join("\n") };
}

function installAutostart(args) {
	if (process.platform !== "win32") {
		return { ok: false, message: "开机自启安装目前仅支持 Windows；其他平台请手动把 `node bin/open-boot.mjs --supervise` 加入系统自启。" };
	}
	// 同样是全局性动作（写 HKCU\...\Run\DSHWebFront）+ 往 profile 写 shim：目标必须像样的 profile（t14-F1）
	const target = looksLikeProfileDir(args.profile);
	if (!target.ok) {
		return { ok: false, message: `拒绝安装开机自启：${target.reason}\n  写 HKCU\\...\\Run 与 profile 内 .vbs 都属于全局动作，必须给出合法的 --profile 目标（退出码 1，未做任何改动）。` };
	}
	const shim = autostartShimPath(args);
	const uiShim = uiShimPath(args);
	// 只调用 node，不使用隐藏 PowerShell——部分杀软（如火绒 AMSI）会拦截并删除该形态。
	let shimInfo;
	try {
		shimInfo = writeShim(shim, buildShimLines(args, "supervise"));
		writeShim(uiShim, buildShimLines(args, "ensure"));
	} catch (error) { return { ok: false, message: `写入包装脚本失败：${error.message}` }; }

	const wscript = join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
	const value = `"${wscript}" //nologo "${shim}"`;
	const out = spawnSync("reg", ["add", RUN_KEY, "/v", AUTOSTART_NAME, "/t", "REG_SZ", "/d", value, "/f"], { windowsHide: true, encoding: "utf8", timeout: 10000 });
	if (out.status !== 0) {
		const detail = (out.stderr || out.stdout || (out.error ? `${out.error.code || ""} ${out.error.message}` : "")).trim();
		return { ok: false, message: `写入注册表失败：${detail || "reg add 未返回任何输出（可能是安全策略/受限会话拦截了 reg.exe）"}` };
	}
	return {
		ok: true,
		message: `开机自启已安装：${AUTOSTART_NAME} → ${shim}\n` +
			`  包装脚本：${shimInfo.encoding} ${shimInfo.bytes} 字节（回读校验 ✔；路径在运行时自解析，中文用户名不会乱码）\n` +
			`  常驻守护（登录时静默启动）：node bin/open-boot.mjs --supervise\n` +
			`  桌面快捷方式可指向：wscript //nologo "${uiShim}"（确保 ${args.port} 后打开浏览器）\n` +
			`  当前会话立即可用：node bin/open-boot.mjs --supervise\n` +
			`  安装后建议核对：node bin/open-boot.mjs --autostart-status`
	};
}

function uninstallAutostart(args) {
	// 删 DSHWeb* 是全局动作：目标必须像样的 profile（t14-F1），否则拒绝执行（不删注册表、不删 shim）
	const target = looksLikeProfileDir(args.profile);
	if (!target.ok) {
		return { ok: false, message: `拒绝移除开机自启：${target.reason}\n  删除 HKCU\\...\\Run 下的 DSHWeb* 属于全局动作，必须给出合法的 --profile 目标（退出码 1，未做任何改动）。` };
	}
	const shim = autostartShimPath(args);
	const uiShim = uiShimPath(args);
	const reg = removeProfileRunValues(args);
	const deleted = [];
	const failed = [];
	for (const file of [shim, uiShim]) {
		if (!existsSync(file)) continue;
		try { unlinkSync(file); deleted.push(file); }
		catch (error) { failed.push(`${file}（${error.message}）`); }
	}
	const ok = reg.ok && failed.length === 0;
	const parts = [reg.message];
	parts.push(deleted.length > 0 ? `已删除包装脚本：${deleted.map((p) => p.split(/[\\/]/).pop()).join(", ")}` : "未发现包装脚本（open-boot-*.vbs）");
	if (reg.failed.length > 0) parts.push(`注册表删除失败：${reg.failed.map((f) => `${f.name}（${f.message}）`).join("；")}`);
	if (failed.length > 0) parts.push(`脚本删除失败：${failed.join("；")}`);
	if (process.platform !== "win32") parts.push("（非 Windows：开机自启管理不适用）");
	return { ok, message: parts.join("\n"), reg, deleted, failed };
}

// ---------------------------------------------------------------- 卸载闭环（R13）
/**
 * 按 profile 收集"可确认属于本 profile"的守护/启动器进程。
 *
 * 审计③ R13 的核心风险是**误杀**：`.open-boot.pid` 只有一个文件、锁端口是 port+1000，
 * 一旦拿错 profile（或 pid 被系统复用）就可能把别人的守护/无关进程杀掉。
 * 因此这里做**三重校验**，任何一项不过就一律不动：
 *   ① `.open-boot.pid`：存在、带本工具身份标记（app=LAUNCHER_APP）、记录的 profile 与端口都与本次目标一致；
 *   ② 端口归属：pid 必须持有启动器端口（`--port`）或锁端口（`--port + 1000`）；
 *   ③ 进程镜像：必须是 node（`node` / `node.exe`）。
 * 另外：**绝不**用 `taskkill /T`（审计③ 装机教训：`/T` 会连整棵树一起杀掉），只用 `process.kill(pid)`。
 *
 * 探测可用性（t8 终审 F2）：三重校验依赖 netstat（端口归属）与 tasklist（进程镜像）。
 * 这两个探测**可能被环境拦截**（受限会话、命令不存在）：此时"读不到"≠"没有守护"。
 * 因此每个候选进程都带 `verified`：
 *   - `verified=true`  → 探测成功：`owned=true` 可停；`owned=false` 是"**确认非本进程/确认已不存在**"，可安全清理；
 *   - `verified=false` → **归属未确认**（探测不可用）：一律不动，交给 `uninstallLauncher` 保留 pid 文件并警告。
 * @param {object} args 解析后的参数（profile/port）
 * @param {object} probes 可注入探针（测试/受限环境模拟）：{ portOwner, processImage, isAlive }
 */
export function collectOwnedDaemons(args, probes = {}) {
	const lockPort = lockPortOf(args.port);
	const ownerOf = probes.portOwner ?? portOwnerProbe;
	const imageOf = probes.processImage ?? processImageProbe;
	const aliveOf = probes.isAlive ?? isAlive;
	const info = readJsonFile(pidPathOf(args));
	const blocked = [];
	const candidates = [];
	if (!info) {
		// 没有 pid 文件 = 无可定位的守护：跳过停止步骤（不是"校验失败"，但仍不结束任何进程）
		return {
			info: null, lockPort, candidates, blocked, owned: [], unverified: [],
			note: `没有 ${pidPathOf(args)}：无可定位的守护（跳过停止步骤，不会结束任何进程）`,
			lockPortOwner: lockPort === null ? null : portOwner(lockPort)
		};
	}
	if (info.app !== LAUNCHER_APP) blocked.push(`.open-boot.pid 缺少本工具身份标记（app=${info.app ?? "无"}）`);
	const infoProfile = info.profile ? resolve(info.profile) : null;
	if (!infoProfile) blocked.push(".open-boot.pid 未记录 profile");
	else if (infoProfile !== resolve(args.profile)) blocked.push(`.open-boot.pid 记录的 profile 是 ${info.profile}（本次目标是 ${args.profile}）`);
	const infoPort = Number(info.port);
	if (!Number.isInteger(infoPort)) blocked.push(".open-boot.pid 未记录端口");
	else if (infoPort !== Number(args.port)) blocked.push(`.open-boot.pid 记录的端口是 ${infoPort}（本次目标是 ${args.port}）`);
	if (blocked.length > 0) return { info, lockPort, candidates: [], blocked, owned: [], unverified: [] };

	for (const item of [
		{ pid: Number(info.launcherPid), role: "常驻守护（--supervise，应持有锁端口）" },
		{ pid: Number(info.pid), role: "启动器服务（网页入口）" }
	]) {
		if (!Number.isInteger(item.pid) || item.pid <= 0) continue;
		if (!aliveOf(item.pid)) {
			candidates.push({ ...item, alive: false, verified: true, owned: false, reason: `pid ${item.pid} 已不存在（无需结束）` });
			continue;
		}
		const imageProbe = imageOf(item.pid);
		// rc.2 P2-6：探测不可用（ok:false）必须被尊重——不再把"探测失败"兜底成"无监听者"（ok:true,pid:null）。
		// ok:false 会进入 failures → verified=false → owned=false → 该 pid 不会被列入可结束名单。
		const lockProbe = lockPort === null
			? { ok: false, pid: null, reason: `无法推导锁端口（启动器端口 ${args.port} + 1000 超过 65535）` }
			: (ownerOf(lockPort) ?? { ok: false, pid: null, reason: "探测函数无返回" });
		const portProbe = ownerOf(infoPort) ?? { ok: false, pid: null, reason: "探测函数无返回" };
		const holdsLock = lockProbe.pid === item.pid;
		const holdsPort = portProbe.pid === item.pid;
		const failures = [imageProbe, lockProbe, portProbe].filter((p) => p && p.ok === false);
		const verified = failures.length === 0;
		const imageOk = imageProbe.ok === true && typeof imageProbe.image === "string" && /^node(\.exe)?$/.test(imageProbe.image);
		const owned = verified && imageOk && (holdsLock || holdsPort);
		let reason;
		if (owned) reason = `进程镜像 ${imageProbe.image}；${holdsLock ? `持有锁端口 ${lockPort}` : `持有端口 ${infoPort}`}`;
		else if (!verified) reason = `归属未确认：探测不可用（${failures.map((p) => p.reason).filter(Boolean).join("；") || "netstat/tasklist 无输出"}）`;
		else reason = `确认非本进程：进程镜像是 ${imageProbe.image ?? "未知（该 pid 已不存在）"}`
			+ (holdsLock || holdsPort ? "" : `，且既没持有锁端口 ${lockPort} 也没持有 ${infoPort}（pid 可能已被系统复用）`);
		candidates.push({
			...item, alive: true, image: imageProbe.image ?? null, holdsLock, holdsPort, verified, owned, reason
		});
	}
	const unverified = candidates.filter((c) => c.alive && c.verified === false);
	return { info, lockPort, candidates, blocked, owned: candidates.filter((c) => c.owned), unverified };
}

/** 结束一个已通过归属校验的 pid（**不带 /T**，只杀这一个进程）。 */
async function stopOwnedPid(pid, { timeoutMs = 6000 } = {}) {
	const startedAt = Date.now();
	try { process.kill(pid); }
	catch (error) { return { ok: false, pid, message: `无法结束 pid ${pid}：${error.message}` }; }
	while (Date.now() - startedAt < timeoutMs) {
		if (!isAlive(pid)) return { ok: true, pid, message: `已结束 pid ${pid}（等 ${Date.now() - startedAt}ms 确认退出）` };
		await sleep(200);
	}
	return { ok: false, pid, message: `已发送结束信号但 pid ${pid} 仍在（可能需要管理员权限）` };
}

/**
 * `--uninstall`（R13，冻结契约）：卸载启动器在本 profile 留下的全部痕迹。
 * 顺序很重要：**先停常驻守护**（否则它 60s 内会把启动器再拉起来），再停启动器服务。
 *
 * 退出码（t8 终审 F2 起）：
 *   0 = 完成（含"无可清理项"、"归属校验不通过而跳过他人进程"）；
 *   1 = 清理过程出错（注册表删除失败 / shim 删不掉 / 已确认的进程停不下来 / pid 文件删不掉）；
 *   2 = **归属未确认**：netstat/tasklist 探测不可用 → 未停止任何进程、**保留 pid 文件**、
 *       不报告"卸载完成"（此时"读不到"≠"没有守护"，不能假装成功）。
 * @param {object} probes 可注入探针（测试/受限环境模拟）：{ portOwner, processImage, isAlive }
 * @returns {Promise<{ok, exitCode, message, stopped, blocked, skipped, unverified, removedValues, deletedShims, pidCleared}>}
 */
export async function uninstallLauncher(args, probes = {}) {
	const aliveOf = probes.isAlive ?? isAlive;
	const lines = [];
	const result = { ok: true, exitCode: 0, stopped: [], blocked: [], skipped: [], unverified: [], removedValues: [], deletedShims: [], pidCleared: false };
	lines.push(`卸载启动器：profile ${args.profile}；启动器端口 ${args.port}；锁端口 ${lockPortOf(args.port) ?? "无法推导（端口 + 1000 超过 65535）"}`);
	lines.push(`端口分工：${args.port} = 本启动器（唯一网页入口）；${RESCUE_DAEMON_PORT} = rescue-daemon 备份入口；${ENGINE_PORT} = 引擎（**不动**）`);

	// 0) 目标合法性闸门（t14-F1）：全局性动作（删 HKCU 下的 DSHWeb*）之前必须先确认目标像样的 profile。
	//    目标不合法时**一个动作都不做**（不删注册表、不删 shim、不碰 pid、不结束进程），退出码 1。
	const target = looksLikeProfileDir(args.profile);
	if (!target.ok) {
		result.ok = false;
		result.exitCode = 1;
		result.profileRejected = target.reason;
		lines.push(`✘ 拒绝执行：${target.reason}`);
		lines.push("   原因：卸载会删除 HKCU\\...\\Run 下**全局**的 DSHWeb* 自启值，必须先有明确且合法的 profile 目标。");
		lines.push("   请检查 --profile 是否漏了取值（例如后面紧跟另一个开关）、是否写成了 = 形式、或目录是否真的存在。");
		lines.push("   退出码 1（用法/目标错误）；本次执行未改动任何注册表值、pid 文件与进程。");
		result.message = lines.join("\n");
		return result;
	}

	// 1) 停本 profile 的守护（三重校验，不过就一律不动）
	const owned = collectOwnedDaemons(args, probes);
	if (owned.blocked.length > 0) {
		result.blocked = owned.blocked;
		lines.push("1) 停守护：⚠ 归属校验不通过，**拒绝处理任何进程**（不会 taskkill /T，也不会动别的 profile 的守护）：");
		for (const reason of owned.blocked) lines.push(`   · ${reason}`);
		lines.push("   → 若确认这些进程就是本 profile 的启动器，请人工结束后再重跑 --uninstall。");
	} else if (owned.note) {
		lines.push(`1) 停守护：${owned.note}`);
		if (owned.lockPortOwner) {
			lines.push(`   ⚠ 锁端口 ${owned.lockPort} 仍被 pid ${owned.lockPortOwner} 占用：无法确认归属，未结束该进程（如需清理请人工确认）。`);
		}
	} else if (owned.candidates.length === 0) {
		lines.push("1) 停守护：.open-boot.pid 里没有任何进程记录（无需停止）");
	} else {
		lines.push("1) 停守护（先守护、后启动器；逐个进程三重校验通过才动）：");
		// 先停持有锁端口的守护，再停启动器服务
		const ordered = [...owned.candidates].sort((a, b) => Number(Boolean(b.holdsLock)) - Number(Boolean(a.holdsLock)));
		for (const item of ordered) {
			if (item.verified === false) {
				// 探测不可用 → 归属未确认：不动、不删 pid 文件、不报告完成（F2）
				result.unverified.push({ ...item });
				lines.push(`   · ⚠ 归属未确认，跳过 pid ${item.pid}（${item.role}）：${item.reason}`);
				continue;
			}
			if (!item.owned) {
				result.skipped.push({ ...item });
				lines.push(`   · 跳过 pid ${item.pid}（${item.role}）：${item.reason}`);
				continue;
			}
			const stopped = await stopOwnedPid(item.pid);
			lines.push(`   · ${stopped.ok ? "✔" : "✘"} pid ${item.pid}（${item.role}）：${stopped.message}；依据：${item.reason}`);
			if (stopped.ok) result.stopped.push({ pid: item.pid, role: item.role });
			else { result.ok = false; result.blocked.push(stopped.message); }
		}
	}

	// 2) 按 profile 作用域清理 HKCU\...\Run 下的 DSHWeb* 值（t31/F6：只删属于本 profile 的 + 死指针）
	const reg = removeProfileRunValues(args);
	result.removedValues = reg.removed;
	result.keptRunValues = reg.kept;
	result.registryBackup = reg.backup?.path ?? null;
	lines.push(`2) 自启注册表：${reg.message}`);
	if (reg.failed.length > 0) {
		result.ok = false;
		for (const item of reg.failed) lines.push(`   ✘ ${item.name}：${item.message}`);
	}
	lines.push(`   （${RUN_KEY}）`);

	// 3) 删 profile 内的 shim
	const shims = [autostartShimPath(args), uiShimPath(args)];
	const deleted = [];
	const failedShims = [];
	for (const file of shims) {
		if (!existsSync(file)) continue;
		try { unlinkSync(file); deleted.push(file); }
		catch (error) { failedShims.push(`${file}（${error.message}）`); }
	}
	result.deletedShims = deleted;
	lines.push(deleted.length > 0
		? `3) 包装脚本：已删除 ${deleted.map((p) => p.split(/[\\/]/).pop()).join(", ")}`
		: "3) 包装脚本：未发现 open-boot-autostart.vbs / open-boot-ui.vbs（无需删除）");
	if (failedShims.length > 0) { result.ok = false; lines.push(`   ✘ 删除失败：${failedShims.join("；")}`); }

	// 4) 清 pid 文件（日志默认保留）。注意：下面三种情况都要**保留** pid 文件 —— 它是用户手工收尾的唯一线索：
	//    a) 归属未确认（探测不可用）：不知道守护是否还在，不能删线索、更不能报"完成"（F2）；
	//    b) 已确认属于本 profile 的进程没停下来（例如权限不足）；
	//    c) 删除本身失败。
	const stillOwned = (owned.candidates || []).filter((item) => item.owned && aliveOf(item.pid));
	const unverifiedAlive = owned.unverified || [];
	try {
		if (unverifiedAlive.length > 0) {
			result.pidCleared = false;
			result.pidRetained = true;
			lines.push(`4) PID 文件：**保留** ${pidPathOf(args)} —— 归属未确认（探测不可用），未停止任何进程，也不把这次执行当作"卸载完成"；`);
			lines.push(`   人工核对建议：netstat -ano -p tcp | findstr :${args.port} ／ tasklist /FI "PID eq <pid>" ／ 或在任务管理器确认 pid ${unverifiedAlive.map((item) => item.pid).join(", ")} 后手工结束并重跑 --uninstall`);
		} else if (stillOwned.length > 0) {
			result.pidCleared = false;
			result.pidRetained = true;
			lines.push(`4) PID 文件：保留 ${pidPathOf(args)}（仍有本 profile 的进程在跑：${stillOwned.map((item) => `pid ${item.pid}`).join(", ")}；解决后请重跑 --uninstall）`);
		} else if (existsSync(pidPathOf(args))) {
			unlinkSync(pidPathOf(args));
			result.pidCleared = true;
			lines.push(`4) PID 文件：已清理 ${pidPathOf(args)}`);
		} else {
			lines.push("4) PID 文件：不存在（无需清理）");
		}
	} catch (error) {
		result.ok = false;
		lines.push(`4) PID 文件：清理失败 —— ${error.message}`);
	}

	lines.push("5) 日志默认保留（open-boot*.log / health.log / rescue-daemon.log 未被删除；需要彻底清理可直接删 profile 目录）");
	// 退出码：1（出错）> 2（归属未确认）> 0（完成）。只有 0 才叫"卸载完成"。
	result.exitCode = result.ok === false ? 1 : (unverifiedAlive.length > 0 ? 2 : 0);
	result.ok = result.exitCode === 0;
	if (result.exitCode === 0) {
		lines.push("✔ 卸载完成（幂等：重复执行仍然 exit 0）");
	} else if (result.exitCode === 2) {
		lines.push(`⚠ 卸载未完成（exit 2）：${unverifiedAlive.length} 个进程的归属无法确认（netstat/tasklist 探测不可用）→`
			+ " 已保留 pid 文件、未停止任何进程。请按上面的「人工核对建议」确认后重跑，或在不受限的会话里重跑 --uninstall。");
	} else {
		lines.push("✘ 卸载未完全成功，见上面的 ✘ 行（exit 1）");
	}
	result.message = lines.join("\n");
	return result;
}

// ---------------------------------------------------------------- 网页入口
/**
 * 启动页 HTML（自包含）。
 * L11：一次性令牌通过 `<meta name="dsh-pm-token">` 注入页面，页面对 `/api/boot` 的写请求
 * 必须带 `X-DSH-PM-Token`；令牌只存在于页面与请求头，**不写日志、不落 profile 文件**。
 */
function bootPageHtml({ token = "__DSH_PM_TOKEN__", enginePort = ENGINE_PORT, entryUrl = entryUrlOf(launcherPortFromEnv()) } = {}) {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 启动器</title>${DRYDOCK_FAVICON_LINK}
<meta name="dsh-pm-token" content="${token}">
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:40px 24px;display:flex;justify-content:center}
.card{max-width:560px;width:100%;background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:24px;text-align:center}
h1{font-size:20px;color:#fff;margin:0 0 6px}.sub{color:#8b93a3;font-size:13px;margin-bottom:22px}
.spinner{width:34px;height:34px;border:3px solid #2a2e38;border-top-color:#60a5fa;border-radius:50%;margin:0 auto 16px;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
pre{background:#0b0d11;border:1px solid #2a2e38;border-radius:8px;padding:12px;font-size:12px;text-align:left;white-space:pre-wrap;max-height:280px;overflow:auto}
.ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}a{color:#60a5fa}
</style></head><body><div class="card">
<h1>${drydockLogoMarkSvg(20)} 🚀 DSH 启动器</h1>
<div class="sub">正在执行 自检 → 修复 → 启动，完成后自动打开主界面…</div>
<div class="spinner" id="spin"></div>
<div class="sub" id="elapsed" aria-live="polite" style="margin:-6px 0 10px;font-size:12.5px"></div>
<pre id="out"></pre>
<div class="sub" style="margin:16px 0 0"><a href="/rescue">救援中心</a>（检查 / 修复 / 启动 / 停止 / 状态）· <a href="/plugins">插件管理</a>（启停 mod / 重启引擎 / 停止启动器）</div>
<script>
const out = document.getElementById("out");
const spin = document.getElementById("spin");
const elapsedEl = document.getElementById("elapsed");
const TOKEN = (document.querySelector('meta[name="dsh-pm-token"]') || {}).content || "";
// U1：启动流程是一个长请求（自检→修复→启动），中间没有任何服务端事件 —— 用计时器证明"页面没卡住"
let waited = 0;
const ticker = setInterval(function(){
	waited++;
	elapsedEl.textContent = "已等待 " + waited + " 秒" + (waited >= 15 ? "（首次启动或修复较慢，页面没有卡住，请勿关闭）" : "…");
}, 1000);
function stopSpin(){
	clearInterval(ticker);
	spin.style.display = "none";
	if (waited > 0) elapsedEl.textContent = "本次等待 " + waited + " 秒";
}
// S4：逐行 DOM 追加（textContent），不再 innerHTML += —— 日志里出现什么字符都不会被解析成 HTML，
// 也省掉手工转义（旧实现只转义 "<"，"&" 与属性上下文仍是缺口）。样式沿用 span.cls。
function log(line, cls){
	var row = document.createElement("div");
	if (cls) { var span = document.createElement("span"); span.className = cls; span.textContent = String(line); row.appendChild(span); }
	else { row.textContent = String(line); }
	out.appendChild(row);
	out.scrollTop = out.scrollHeight;
}
function goEntry(r){
	stopSpin();
	if (r && r.entryUrl) { location.href = r.entryUrl; return; }
	// G03：entryUrl=null（引擎本次启动没打印/没写可读的 token 行）→ 降级指引，不渲染假 token 链接。
	log("⚠ 未捕获到本次启动的登录链接（entryUrl=null，引擎可能没有把 token 行写进 web.log）。", "warn");
	log("① 已登录过的浏览器：直接打开 http://127.0.0.1:${enginePort}/ 即可（登录 cookie 仍有效）。", "warn");
	log("② 新浏览器/新设备：查看引擎控制台输出的 dsh web: …?token=…，或到 ~/.dsh/logs/web.log 末尾查找最后一次启动追加的链接。", "warn");
	var link = document.createElement("a");
	link.href = "http://127.0.0.1:${enginePort}/";
	link.textContent = "→ 打开 http://127.0.0.1:${enginePort}/";
	out.appendChild(document.createElement("br"));
	out.appendChild(link);
	stopSpin();
}
(async () => {
	try {
		const r = await fetch("/api/boot", { method: "POST", headers: { "X-DSH-PM-Token": TOKEN } }).then((x) => x.json());
		if (r.ok && r.alreadyRunning) {
			log("✓ " + r.message, "ok");
			goEntry(r);
			return;
		}
		if (r.code === 409) {
			// U1：原本这里只写一行日志就 return，转圈图标永远转下去 → 看起来像卡死
			log("⚠ " + (r.error || "已有启动流程在执行中"), "warn");
			log("本页不会自动跳转；可等它完成，或打开 " + location.origin + "/rescue 救援中心看状态。", "warn");
			stopSpin();
			return;
		}
		if (r.verifyOk === false) log("自检：⚠ 发现 " + (r.issues||[]).length + " 个问题", "warn");
		else if (r.verifyOk === true) log("自检：✓ 配置正常", "ok");
		if (r.fixed) log("修复：" + (r.fixed.message || "完成"), "ok");
		if (r.window && r.window.ok) log("⧉ " + r.window.message + "（窗口里可看到完整进度，结束时按任意键关闭）", "warn");
		if (r.ok) { log("✓ " + (r.message || "引擎已启动"), "ok"); stopSpin(); setTimeout(() => goEntry(r), 600); }
		else if (r.quarantined && r.quarantined.length) { log("⚠ 运行期失败条目已自动隔离：" + r.quarantined.join(", "), "bad"); log("✓ " + (r.message || "重试成功"), "ok"); stopSpin(); setTimeout(() => goEntry(r), 600); }
		else {
			log("✗ " + (r.message || JSON.stringify(r)), "bad");
			if (r.logPath) log("日志：" + r.logPath, "warn");
			log("可运行 node bin/open-boot.mjs --status 查看启动器/守护/引擎状态，或打开 " + location.origin + "/rescue 救援中心", "warn");
			stopSpin();
		}
	} catch (e) {
		log("✗ 请求失败：" + e.message, "bad");
		stopSpin();
	}
})();
</script>
</div></body></html>`;
}

// ---------------------------------------------------------------- 1.0.0-rc.1：启动器内置插件管理 + 用户可控启停

/** 引擎 UI 的核心组件 bundle：禁用它们等于把 3080 的网页入口拆了 → 拒绝一键禁用，提示走救援中心。 */
const CORE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
const BUNDLES_BACKUP_NAME = "package.json.bundles-backup.json";
const BUNDLES_BACKUP_KEEP = 5;

function readProfileManifest(profile) {
	try { return JSON.parse(readFileSync(join(profile, "package.json"), "utf8")); }
	catch { return null; }
}

function bundlesBackupPathOf(profile) { return join(profile, BUNDLES_BACKUP_NAME); }

/** 写 profile 清单前的滚动备份（保留最近 5 份，带时间戳，绝不覆盖更旧的备份）。 */
function backupProfileManifest(profile) {
	const manifest = readProfileManifest(profile);
	if (!manifest) return null;
	const dir = profile;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const target = join(dir, `package.json.bak-${stamp}`);
	writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n", "utf8");
	writeFileSync(bundlesBackupPathOf(profile), JSON.stringify(manifest, null, 2) + "\n", "utf8");
	try {
		const olds = readdirSync(dir)
			.filter((f) => /^package\.json\.bak-\d{4}-\d{2}-\d{2}T/.test(f))
			.sort().reverse().slice(BUNDLES_BACKUP_KEEP);
		for (const f of olds) { try { unlinkSync(join(dir, f)); } catch { /* 清不掉不影响主流程 */ } }
	} catch { /* 清理失败不影响主流程 */ }
	return target;
}

/** 列出 profile 里安装的所有 bundle：enabled 来自 dsh.profile.bundles（0.2.x 的唯一加载开关）。 */
function listBundles(profile) {
	const manifest = readProfileManifest(profile);
	if (!manifest) return { ok: false, error: `无法读取 profile 清单：${join(profile, "package.json")}` };
	const enabled = manifest?.dsh?.profile?.bundles ?? [];
	const installed = Object.keys(manifest.dependencies ?? {});
	const names = [...new Set([...installed, ...enabled])].sort();
	return {
		ok: true, profile,
		bundles: names.map((name) => ({ name, enabled: enabled.includes(name), core: CORE_BUNDLES.includes(name) })),
		backup: existsSync(bundlesBackupPathOf(profile)) ? bundlesBackupPathOf(profile) : null
	};
}

/** 启用/禁用一个 bundle：写前备份 → 改 dsh.profile.bundles → 原子写回（写失败时备份还在）。 */
function setBundleEnabled(profile, name, enabled) {
	if (typeof name !== "string" || !name.trim()) return { ok: false, error: "bundle 名缺失" };
	name = name.trim();
	if (!enabled && CORE_BUNDLES.includes(name)) {
		return { ok: false, error: `${name} 是引擎必需的核心组件，不允许从这里禁用（否则引擎 ${ENGINE_PORT} 无法再打开页面）。如确需操作请手工改 profile 的 package.json，或走救援中心。` };
	}
	const manifest = readProfileManifest(profile);
	if (!manifest) return { ok: false, error: `无法读取 profile 清单：${join(profile, "package.json")}` };
	const known = new Set([...Object.keys(manifest.dependencies ?? {}), ...(manifest?.dsh?.profile?.bundles ?? [])]);
	if (!known.has(name)) return { ok: false, error: `profile 里没有安装 ${name}，不认识这个 bundle。` };
	const enabledList = [...(manifest?.dsh?.profile?.bundles ?? [])];
	const before = enabledList.includes(name);
	if (before === enabled) return { ok: true, changed: false, message: `${name} 已经是${enabled ? "启用" : "禁用"}状态，无需变更。`, ...listBundles(profile) };
	backupProfileManifest(profile);
	const next = enabled ? [...enabledList, name].sort() : enabledList.filter((b) => b !== name);
	manifest.dsh = manifest.dsh || {};
	manifest.dsh.profile = manifest.dsh.profile || {};
	manifest.dsh.profile.bundles = next;
	try {
		writeFileAtomic(join(profile, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
	} catch (error) {
		return { ok: false, error: `写回清单失败（备份未动，原文件未损坏风险）：${error.message}` };
	}
	return { ok: true, changed: true, message: `${enabled ? "启用" : "禁用"} ${name} 完成；重启引擎后生效。`, ...listBundles(profile) };
}

// ---------------------------------------------------------------- 1.0.0-rc.2：更新 / 事务性卸载 / mod 体检（launcher 原生能力，不依赖引擎 Cordis 服务）

/** 管理器自身包名（自卸载走额外警告路径）。 */
const MANAGER_SELF_NAME = "dsh-drydock";
/** npm 包名白名单：进 shell 前先过这道闸（pnpm 参数防注入）。 */
const PKG_NAME_RE = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** 引擎启动日志路径（launcher 会把引擎 stdout 追加到这里；mod 体检按它聚合错误计数）。 */
function webLogPath() {
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(dshHome, "logs", "web.log");
}

function patchFilePathOf(profile) { return join(profile, "cordis.patch.yml"); }

/** 用户侧 bundle = 已安装依赖里除核心组件之外的部分（管理器自身也在其中）。 */
function userBundleNames(profile) {
	const manifest = readProfileManifest(profile);
	if (!manifest) return [];
	return Object.keys(manifest.dependencies ?? {}).filter((name) => !CORE_BUNDLES.includes(name)).sort();
}

/**
 * P2：pnpm 输出缓冲上限 = 保留末尾 16 KB。调用方普遍只用 `slice(-400)`（错误摘录），
 * 大 profile 的 `pnpm outdated --json` / `pnpm install` 输出可达 MB 级，长驻守护里是无上限的堆峰值。
 */
const PNPM_OUTPUT_CAP = 16 * 1024;

/**
 * 有界输出缓冲（P2）：超出上限时丢**头部**、只留末尾 cap 个字符，并记下丢弃字节数；
 * 取值时前置 `<...已截断 N 字节>` 标记，让读日志的人知道"这里不是开头"。
 * 返回值仍是完整字符串（末尾语义不变），所以 `slice(-400)` 这类调用方无需改动。
 */
function createBoundedBuffer(cap = PNPM_OUTPUT_CAP) {
	let tail = "";
	let dropped = 0;
	return {
		append(chunk) {
			tail += String(chunk);
			if (tail.length > cap) { dropped += tail.length - cap; tail = tail.slice(-cap); }
		},
		toString() { return dropped === 0 ? tail : `<...已截断 ${dropped} 字节>${tail}`; },
		get dropped() { return dropped; },
		get size() { return tail.length; }
	};
}

/**
 * 以「pnpm 命令 + 白名单参数」的方式跑子进程（rc.2 P1-4：exec → spawn 拿 pid）。
 * resolve 永不 reject，失败也返回结构化结果 { code, stdout, stderr, timedOut, state }：
 *   state="done"    —— 子进程已确认退出（含超时后确认杀死的情形）；
 *   state="unknown" —— 超时触发了 taskkill /T /F，但之后仍探到进程存活：**不知道 pnpm 是否真的停了**，
 *                      调用方（卸载事务）据此不做回滚/继续，直接报告 unknown 请人工确认。
 * 超时杀的是**本函数自己启动**的子树（taskkill /PID <pid> /T /F），与 P0-1「不 /T 连坐别人」不冲突。
 * 测试逃生门：DSH_PM_PNPM_TIMEOUT_MS 环境变量可整体下调默认超时（不设 = 180000）。
 * P2：stdout/stderr 走有界环形缓冲（保末尾 16KB + 截断标记），不再无上限累积。
 */
function runPnpm(pnpmArgs, { cwd, timeoutMs } = {}) {
	const defaultTimeout = Number(process.env.DSH_PM_PNPM_TIMEOUT_MS);
	const timeout = timeoutMs ?? (Number.isInteger(defaultTimeout) && defaultTimeout > 0 ? defaultTimeout : 180000);
	return new Promise((resolveRun) => {
		let child;
		try {
			child = spawn("pnpm", pnpmArgs, {
				cwd, windowsHide: true, env: process.env,
				shell: process.platform === "win32" // Windows 的 pnpm 是 .cmd：须经 shell 解析（PID = cmd 包装进程，/T 连它下面的 pnpm→node 一起清）
			});
		} catch (error) {
			resolveRun({ code: 1, stdout: "", stderr: `pnpm spawn 失败：${error.message}`, timedOut: false, state: "done" });
			return;
		}
		// P2：有界缓冲（保末尾 16KB）；返回值语义与旧版一致（末尾内容不变）
		const stdoutBuf = createBoundedBuffer();
		const stderrBuf = createBoundedBuffer();
		let settled = false;
		let timedOut = false;
		const finish = (code, state) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveRun({ code, stdout: stdoutBuf.toString(), stderr: stderrBuf.toString(), timedOut, state });
		};
		const killTree = () => {
			timedOut = true;
			try {
				// rc.2：taskkill 只允许出现在 enginectl（test-launcher R13 约束 open-boot 源零 taskkill 调用）；
				// 这里杀的是本函数自己启动的 pnpm 子树（唯一允许 /T 的场景）。
				killTreeForce(child.pid);
			} catch { /* 进程可能刚好退出 */ }
			// 确认死亡（最多 ~1.2s）：还活着就不能当作"已回滚安全"，报 unknown
			let attempts = 0;
			const confirmDeath = () => {
				attempts += 1;
				if (!isAlive(child.pid)) { finish(1, "done"); return; }
				if (attempts >= 6) { finish(1, "unknown"); return; }
				setTimeout(confirmDeath, 200);
			};
			setTimeout(confirmDeath, 150);
		};
		const timer = setTimeout(() => {
			if (!settled && child.pid) killTree();
		}, timeout);
		child.stdout?.on("data", (d) => { stdoutBuf.append(d); });
		child.stderr?.on("data", (d) => { stderrBuf.append(d); });
		child.on("error", (error) => {
			stderrBuf.append(`\n${error.message}`);
			finish(1, "done");
		});
		child.on("close", (code) => finish(typeof code === "number" ? code : 1, "done"));
	});
}

/** 原子写（rc.2 P2-3）：先写同目录临时文件，再 renameSync 覆盖目标——清单/patch 不再可能半写损坏。 */
function writeFileAtomic(file, text) {
	const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	writeFileSync(tmp, text, "utf8");
	try {
		renameSync(tmp, file);
	} catch (error) {
		try { unlinkSync(tmp); } catch { /* 清理失败不影响抛错 */ }
		throw error;
	}
}

/** 只读 web.log 的**末尾** maxBytes 字节（rc.2 P1-6：不再全量读日志，statSync+定长尾读）。 */
function readWebLogTail(maxBytes = 256 * 1024) {
	const file = webLogPath();
	try {
		const st = statSync(file);
		const size = Math.min(st.size, maxBytes);
		if (size <= 0) return "";
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(size);
			const read = readSync(fd, buf, 0, size, st.size - size);
			return buf.subarray(0, read).toString("utf8");
		} finally { closeSync(fd); }
	} catch { return ""; }
}

/**
 * rc.2 P1-2：卸载成功后把包从 manifest.dsh.profile.bundles 里摘除（悬空声明会让引擎侧
 * listBundles 出现幽灵条目）。复用 P2-3 的原子写；清单不可读/写失败时如实报告（verify 步会兜底断言）。
 */
function removeBundleEntry(profile, pkgName) {
	const manifestPath = join(profile, "package.json");
	let manifest;
	try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
	catch (error) { return { ok: false, detail: `清单不可读（${error.message}），无法摘 dsh.profile.bundles——请人工检查。` }; }
	const bundles = manifest?.dsh?.profile?.bundles;
	if (!Array.isArray(bundles)) return { ok: true, detail: "清单没有 dsh.profile.bundles 段，无需摘除" };
	if (!bundles.includes(pkgName)) return { ok: true, detail: "dsh.profile.bundles 本就没有该包" };
	try {
		const next = {
			...manifest,
			dsh: { ...manifest.dsh, profile: { ...(manifest.dsh?.profile ?? {}), bundles: bundles.filter((name) => name !== pkgName) } }
		};
		writeFileAtomic(manifestPath, JSON.stringify(next, null, 2) + "\n");
		return { ok: true, detail: "已从 dsh.profile.bundles 摘除该包" };
	} catch (error) {
		return { ok: false, detail: `摘除失败（${error.message}）：清单里仍有悬空声明，请人工处理或从备份恢复。` };
	}
}

/**
 * rc.2 P1-3：EBUSY 防护的状态判定改为 **fail-closed**。握手失败时不再默认"引擎没在跑"，
 * 而是用纯端口探测复核：端口仍有监听者 = 引擎状态未知 → 拒绝硬删（半删/EBUSY 风险）。
 * 返回 { running:boolean|null, message:string|null }；message 非 null 时调用方直接拒绝。
 */
async function engineBusyGate() {
	const engine = await engineHealth(ENGINE_PORT);
	if (engine.ok) return { running: true, message: null };
	if (!(await probe(ENGINE_PORT))) return { running: false, message: null };
	return {
		running: null,
		message: `端口 ${ENGINE_PORT} 有监听者，无法确认引擎已停（HTTP 握手未通过：${engine.error || `HTTP ${engine.status ?? "?"}`}）。` +
			`为避免半删/EBUSY，请先停止引擎或在救援页确认端口上的进程后重试。`
	};
}

/**
 * 事务性卸载：备份（清单 + patch 文件）→ （管理器自身先清自启）→ pnpm remove → 摘 bundles →
 * 清 cordis.patch.yml 条目块 → 验证（dependencies / bundles / patch / pnpm ls 四项后置断言）。
 * 任一步失败即回滚备份并返回逐步日志 steps[{action,status,detail,rollback}]。
 * 核心组件 bundle 拒绝；引擎握手失败但端口有监听者 → fail-closed 拒绝（P1-3）。
 */
async function uninstallPackageTransactional(args, pkgName) {
	const profile = args.profile;
	const steps = [];
	const step = (action, status, detail, rollback = null) => steps.push({ action, status, detail, rollback });
	if (!PKG_NAME_RE.test(pkgName)) return { ok: false, error: `非法包名：${pkgName}`, steps };
	if (CORE_BUNDLES.includes(pkgName)) return { ok: false, error: `${pkgName} 是引擎必需的核心组件，不允许卸载。`, steps };
	const manifest = readProfileManifest(profile);
	if (!manifest || !(pkgName in (manifest.dependencies ?? {}))) {
		return { ok: false, error: `profile 里没有安装 ${pkgName}，无事可做。`, steps };
	}
	const gate = await engineBusyGate();
	if (gate.message) {
		return { ok: false, blocked: "engine-unknown", error: gate.message, steps };
	}
	const enabled = manifest?.dsh?.profile?.bundles ?? [];
	if (gate.running && enabled.includes(pkgName)) {
		return {
			ok: false, blocked: "engine-busy",
			error: `引擎正在运行且 ${pkgName} 处于启用状态：node_modules 被引擎进程占用，硬删会 EBUSY/半删。请先在下方禁用它 → 重启引擎 → 再回来卸载。`,
			steps
		};
	}
	if (pkgName === MANAGER_SELF_NAME) {
		step("self-warning", "warn",
			"这是管理器自身：卸载会移除引擎（" + ENGINE_PORT + "）内的插件管理界面；启动器（" + args.port + "）兜底页存活到本次进程结束。", null);
		// rc.2 P1-5：自卸载先进程内清开机自启 + 删 shim，再 pnpm remove（不再要求用户之后手动 --uninstall）。
		const auto = uninstallAutostart(args);
		step("autostart-cleanup", auto.ok ? "ok" : "warn",
			`开机自启已自动清理：${String(auto.message || "").split("\n")[0]}`, null);
	}
	// 1) 备份（清单走现有滚动备份；patch 文件独立一次性备份）
	let manifestBackup = null;
	try {
		manifestBackup = backupProfileManifest(profile);
		step("backup-manifest", "ok", manifestBackup ? `package.json 已备份 → ${manifestBackup}` : "清单为空/不可读，跳过备份（后面也没有可回滚的清单）", manifestBackup);
	} catch (error) {
		step("backup-manifest", "fail", error.message, null);
		return { ok: false, error: "备份失败，未做任何改动。", steps };
	}
	let patchBackup = null;
	const patchFile = patchFilePathOf(profile);
	if (existsSync(patchFile)) {
		patchBackup = `${patchFile}.uninstall-bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		try {
			writeFileSync(patchBackup, readFileSync(patchFile, "utf8"), "utf8");
			step("backup-patch", "ok", `cordis.patch.yml 已备份 → ${patchBackup}`, patchBackup);
		} catch (error) {
			step("backup-patch", "fail", error.message, null);
			return { ok: false, error: "patch 备份失败，未做任何改动。", steps };
		}
	}
	// 2) pnpm remove
	const removed = await runPnpm(["remove", pkgName], { cwd: profile });
	if (removed.code !== 0) {
		step("pnpm-remove", "fail",
			`exit ${removed.code}${removed.timedOut ? "（超时）" : ""}${removed.state === "unknown" ? "；超时杀树后仍探测到 pnpm 存活（state=unknown）" : ""}：${(removed.stderr || removed.stdout).slice(-400)}`, null);
		if (removed.state === "unknown") {
			return { ok: false, error: "pnpm remove 超时且无法确认 pnpm 已停止（state=unknown）：为避免在半成品状态上回滚/继续，本次不做任何后续动作，请人工确认 pnpm 进程已结束后重试。", steps };
		}
		if (manifestBackup) {
			try {
				writeFileAtomic(join(profile, "package.json"), readFileSync(manifestBackup, "utf8"));
				step("rollback-manifest", "ok", "清单已从备份回滚", null);
			} catch (error) { step("rollback-manifest", "fail", error.message, null); }
		}
		return { ok: false, error: "pnpm remove 失败：已回滚清单，patch 文件未动。", steps };
	}
	step("pnpm-remove", "ok", `pnpm remove ${pkgName} 完成`, null);
	// 3) 摘 dsh.profile.bundles（rc.2 P1-2：pnpm remove 会改写 dependencies，但 bundles 段要我们自己摘）
	const bundleCleanup = removeBundleEntry(profile, pkgName);
	step("bundle-cleanup", bundleCleanup.ok ? "ok" : "warn", bundleCleanup.detail, manifestBackup);
	// 4) 清 patch 条目块（rc.2 P1-1：正则匹配三形态；removed=0 且有块 → 降级 warn 请人工确认）
	const patch = removePatchEntriesFor(profile, pkgName);
	if (patch.total > 0 && patch.removed === 0) {
		step("patch-cleanup", "warn",
			`patch 文件有 ${patch.total} 个条目块，但未找到归属 ${pkgName} 的条目（removed=0）——未做任何修改，请人工确认 cordis.patch.yml。`, patchBackup);
	} else {
		step("patch-cleanup", "ok", patch.detail ?? `cordis.patch.yml：移除 ${patch.removed}/${patch.total} 个条目块`, patchBackup);
	}
	// 5) 验证（rc.2 P2-2：四项后置条件逐一断言，而不是只看 pnpm ls）
	const verify = await runPnpm(["ls", pkgName, "--depth", "0"], { cwd: profile, timeoutMs: 60000 });
	const manifestNow = readProfileManifest(profile);
	const depGone = !manifestNow || !(pkgName in (manifestNow.dependencies ?? {}));
	const bundleGone = !manifestNow || !((manifestNow?.dsh?.profile?.bundles ?? []).includes(pkgName));
	const patchGone = patch.total === 0 || patch.removed > 0;
	const pnpmGone = verify.code === 0 && !verify.stdout.includes(pkgName);
	const conditions = [
		["dependencies", depGone],
		["dsh.profile.bundles", bundleGone],
		["cordis.patch.yml 条目", patchGone],
		["pnpm ls", pnpmGone]
	];
	const failed = conditions.filter(([, passed]) => !passed).map(([label]) => label);
	if (failed.length === 0) {
		step("verify", "ok", "后置条件全部满足：dependencies / dsh.profile.bundles / cordis.patch.yml 均已无该包，pnpm ls 也不再列出", null);
	} else {
		step("verify", "warn",
			`后置条件未全满足（${failed.join("、")} 仍含 ${pkgName}）：如异常请手工检查 node_modules / 清单 / patch（备份：${[manifestBackup, patchBackup].filter(Boolean).join("、") || "无"}）`, null);
	}
	const isSelf = pkgName === MANAGER_SELF_NAME;
	return {
		ok: true, self: isSelf,
		message: isSelf
			? `${pkgName} 已卸载（开机自启已自动清理）。本启动器（${args.port} 兜底页）存活到本次进程结束；${ENGINE_PORT} 内的插件管理界面随本次引擎重启消失。`
			: `${pkgName} 已卸载（备份 → 移除 → 摘 bundles → 清 patch → 验证，全程有回滚记录）。`,
		steps
	};
}

/**
 * P1：updates 结果缓存（key = profile，TTL 30 分钟）。
 * 另存 `pnpm-lock.yaml` 的 mtime+size 作失效键：lockfile 一变（用户装了/卸了包、改了依赖树）
 * 立刻重算，不让 30 分钟缓存把"刚装的插件"藏起来。只缓存**成功**结果——失败（pnpm 缺失/输出异常）
 * 留给用户重试，不把一个可修的故障钉在缓存里半小时。
 */
const UPDATES_CACHE_MS = 30 * 60 * 1000;
const updatesCache = new Map();
/** P1：单飞——同一 profile 的并发请求共用同一个 in-flight Promise（复用同一结果，不是 409）。 */
const updatesInflight = new Map();
/** P1：`pnpm --version` 成功结果模块级缓存（失败不缓存：装好 pnpm 后下一次就能恢复）。 */
let pnpmVersionCache = null;

/** lockfile 指纹：mtimeMs + size（文件不存在记 "absent"，仍然稳定可比）。 */
function lockfileStamp(profile) {
	try {
		const st = statSync(join(profile, "pnpm-lock.yaml"));
		return `${st.mtimeMs}:${st.size}`;
	} catch { return "absent"; }
}

/** 测试面：清空 updates 缓存 / 单飞 / 版本缓存（生产路径不调用）。 */
function resetUpdatesCacheForTests() {
	updatesCache.clear();
	updatesInflight.clear();
	pnpmVersionCache = null;
}

/**
 * 检查用户插件更新：一次 pnpm outdated --json，再投影到用户 bundle（核心组件不参与）。
 * P1：30 分钟缓存（key=profile + lockfile 指纹）+ 并发单飞 + pnpm --version 进程内缓存；
 *     `run`/`now` 是测试注入点（默认就是 runPnpm / Date.now）。
 * 热调用目标 < 10ms：命中缓存时不 spawn 任何子进程。
 */
async function checkUpdates(args, { run = runPnpm, now = Date.now } = {}) {
	const profile = args.profile;
	const users = userBundleNames(profile);
	if (users.length === 0) return { ok: true, updates: [], message: "profile 没有用户插件。" };
	const lock = lockfileStamp(profile);
	const cached = updatesCache.get(profile);
	if (cached && now() - cached.at < UPDATES_CACHE_MS && cached.lock === lock) return cached.result;
	// 并发进来时复用同一个 Promise：不会重复拉起 pnpm，也不会把第二个请求判成 409
	const pending = updatesInflight.get(profile);
	if (pending) return pending;
	const task = (async () => {
		if (pnpmVersionCache === null) {
			const ping = await run(["--version"], { cwd: profile, timeoutMs: 15000 });
			if (ping.code !== 0) return { ok: false, error: `pnpm 不可用（exit ${ping.code}）：${(ping.stderr || ping.stdout).slice(-200)}` };
			pnpmVersionCache = (ping.stdout || "").trim();
		}
		const out = await run(["outdated", "--json"], { cwd: profile, timeoutMs: 120000 });
		let table = {};
		try { table = JSON.parse(out.stdout || "{}") || {}; }
		catch {
			return { ok: false, error: `pnpm outdated 输出无法解析（exit ${out.code}）：${(out.stderr || out.stdout).slice(-300)}` };
		}
		const updates = users.map((name) => {
			const row = table[name] || table[`./${name}`] || null;
			return {
				name,
				current: row?.current ?? null,
				latest: row?.latest ?? null,
				needsUpdate: Boolean(row && row.latest && row.current !== row.latest)
			};
		});
		const result = { ok: true, updates };
		updatesCache.set(profile, { at: now(), lock, result });
		return result;
	})();
	updatesInflight.set(profile, task);
	try { return await task; }
	finally { updatesInflight.delete(profile); }
}

/** 更新单个用户插件（与卸载同一套 EBUSY 引导 + P1-3 fail-closed：握手失败但端口有监听者 → 拒绝）。 */
async function updatePackage(args, pkgName) {
	const profile = args.profile;
	if (!PKG_NAME_RE.test(pkgName)) return { ok: false, error: `非法包名：${pkgName}` };
	if (CORE_BUNDLES.includes(pkgName)) return { ok: false, error: `${pkgName} 是引擎必需的核心组件，更新请走引擎侧（主界面 → 插件管理）。` };
	const manifest = readProfileManifest(profile);
	if (!manifest || !(pkgName in (manifest.dependencies ?? {}))) return { ok: false, error: `profile 里没有安装 ${pkgName}` };
	const gate = await engineBusyGate();
	if (gate.message) return { ok: false, blocked: "engine-unknown", error: gate.message };
	const enabled = manifest?.dsh?.profile?.bundles ?? [];
	if (gate.running && enabled.includes(pkgName)) {
		return {
			ok: false, blocked: "engine-busy",
			error: `引擎正在运行且 ${pkgName} 处于启用状态：文件被占用，更新会 EBUSY。请先禁用 → 重启引擎 → 再更新。`
		};
	}
	const result = await runPnpm(["update", pkgName, "--latest"], { cwd: profile });
	if (result.code !== 0) {
		if (result.state === "unknown") {
			return { ok: false, error: "pnpm update 超时且无法确认 pnpm 已停止（state=unknown）：不判断成败，请人工确认 pnpm 进程已结束后重试。" };
		}
		return { ok: false, error: `pnpm update 失败（exit ${result.code}${result.timedOut ? "，超时" : ""}）：${(result.stderr || result.stdout).slice(-400)}` };
	}
	return { ok: true, message: `${pkgName} 已更新；重启引擎后生效。`, output: (result.stdout || "").slice(-1200) };
}

/** rc.2 P1-6：体检报告 30s 缓存（key=profile），避免每次点体检都重读/重扫日志。 */
const healthReportCache = new Map();
const HEALTH_REPORT_CACHE_MS = 30000;

/**
 * mod 体检（只读）：① lib/preflight.verifyProfile 逐 bundle 可解析性；② DSH_HOME/logs/web.log
 * **末尾 256KB**（rc.2 P1-6：不再全量读日志）按 bundle 名聚合错误计数。verdict：ok/suspect/broken。
 * rc.2 P2-4：不属于任何 bundle 的 preflight 问题与未识别来源的日志错误拆到 globalIssues 单独展示。
 */
function healthReport(args) {
	const profile = args.profile;
	const cached = healthReportCache.get(profile);
	if (cached && Date.now() - cached.at < HEALTH_REPORT_CACHE_MS) return cached.report;
	const issues = [];
	try {
		const verify = verifyProfile(profile);
		for (const item of verify.issues ?? []) issues.push({ name: item.name, detail: item.reason });
	} catch (error) {
		issues.push({ name: "(preflight)", detail: `体检器异常：${error instanceof Error ? error.message : String(error)}` });
	}
	const counts = {};
	try {
		const text = readWebLogTail(256 * 1024);
		const tail = text.split(/\r?\n/).slice(-300);
		for (const line of tail) {
			if (!/(error|失败|✗|cannot|EADDR|EBUSY|ERR_)/i.test(line)) continue;
			const m = line.match(/(@?[\w./@-]*dsh-[\w.-]+)/);
			const pkg = m ? m[1] : "(未识别)";
			counts[pkg] = (counts[pkg] ?? 0) + 1;
		}
	} catch { /* web.log 不存在：静默忽略 */ }
	const bundles = listBundles(profile);
	const bundleNames = new Set((bundles.ok ? bundles.bundles : []).map((b) => b.name));
	const rows = (bundles.ok ? bundles.bundles : []).map((b) => {
		const issue = issues.find((x) => x.name === b.name);
		const errs = counts[b.name] ?? 0;
		let verdict = "ok";
		let detail = b.enabled ? "已启用，preflight 无异常" : "已禁用（不加载，无风险）";
		if (issue) { verdict = "broken"; detail = issue.detail; }
		else if (errs >= 3) { verdict = "suspect"; detail = `web.log 尾部 300 行内出现 ${errs} 次错误——建议禁用观察`; }
		else if (errs > 0) { verdict = "suspect"; detail = `web.log 尾部 300 行内出现 ${errs} 次错误`; }
		return { name: b.name, enabled: b.enabled, core: b.core, verdict, detail };
	});
	const bundleIssues = issues.filter((x) => bundleNames.has(x.name));
	const globalIssues = [
		...issues.filter((x) => !bundleNames.has(x.name)),
		...Object.entries(counts)
			.filter(([pkg]) => !bundleNames.has(pkg))
			.map(([pkg, n]) => ({ name: pkg, detail: `web.log 尾部 300 行内出现 ${n} 次错误（不属于任何已装 bundle，可能与全局配置/引擎本身有关）` }))
	];
	const report = { ok: true, rows, issues: bundleIssues, globalIssues, logErrors: counts, logPath: webLogPath() };
	healthReportCache.set(profile, { at: Date.now(), report });
	return report;
}

/**
 * 重启引擎：停（多重校验；**rc.2 P0-1：不再传 force:true**——校验不过就如实拒绝并给出原因
 * 与人工确认引导，绝不带着未通过的身份校验硬杀）→ 起（带失败隔离）。与 /api/boot 共用单飞闸门。
 */
async function restartEngine(args, flight, entered) {
	try {
		const stop = await stopEngine(args.profile, { port: ENGINE_PORT });
		const stillUp = await probe(ENGINE_PORT);
		if (!stop.ok && stillUp) {
			// 停不掉且端口仍被占（PID 文件缺失/身份校验不过等防误杀保护生效）→ 不继续拉起第二个引擎
			const reasons = Array.isArray(stop.reasons) && stop.reasons.length ? stop.reasons.join("；") : (stop.message || "原因未知");
			return {
				ok: false,
				message: `重启已中止：停止旧引擎未通过校验，且端口 ${ENGINE_PORT} 仍被占用，未尝试重启。\n原因：${reasons}\n` +
					`请到救援中心核对进程身份；确认无误后可用救援页的「强制停止」（显式人工动作）再回来重启。`
			};
		}
		// 走到这里 = ①停成功 ②引擎本来就不在（PID 文件缺失但端口空闲）
		const start = await startEngineWithQuarantine({ profileDir: args.profile, dshCmd: args.dsh, waitMs: args.waitMs, cwd: args.cwd });
		return {
			ok: start.ok, stoppedPid: stop.pid ?? null,
			quarantined: start.quarantined ?? [], quarantineMessage: start.quarantineMessage ?? null,
			entryUrl: start.ok ? await latestTokenUrlWithRetry() : null,
			message: (stop.ok ? `旧引擎已停（${stop.message}）→ ` : "") + (start.message || "")
		};
	} catch (error) {
		return { ok: false, message: `重启流程异常：${error instanceof Error ? error.message : String(error)}` };
	} finally {
		flight.leave(entered.entry);
	}
}

/**
 * 生成/更新 `<DSH_HOME>/scripts/dsh-launcher.cmd`（start|stop|status）与配套 WMI 启动脚本。
 * 每次启动器进程起来都重写一遍 → 重装/升级后自愈；内容全部 ASCII + CRLF、路径全部加引号、
 * 不含任何写死的盘符/用户名（node/profile/cwd 全部来自当前进程实况）。
 * start 用 WMI Win32_Process.Create（父进程是 WmiPrvSE）→ 从 agent Job/控制台里发起也能存活。
 */
/**
 * PowerShell 单引号字符串安全：路径含 ' 时翻倍转义（' → ''），否则会截断/破坏命令行。
 * 适用于所有用单引号包路径的 ps1 赋值与 powershell -Command 内联片段。
 */
const escPs = (value) => value.replace(/'/g, "''");

function ensureLauncherCmd(args) {
	try {
		const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
		// 隔离红线：脚本目录默认 <DSH_HOME>/scripts，但允许 DSH_PM_SCRIPTS_DIR 覆盖 ——
		// 测试/多实例必须能把生成物锁在临时目录，绝不改写用户真实的 ~/.dsh/scripts（历史污染点）。
		// DSH_PM_NO_SCRIPTS=1 则完全跳过生成（只读/受限环境）。
		if (process.env.DSH_PM_NO_SCRIPTS === "1") return null;
		const scriptsDir = resolve(process.env.DSH_PM_SCRIPTS_DIR || join(dshHome, "scripts"));
		const logDir = join(dshHome, "logs");
		mkdirSync(scriptsDir, { recursive: true });
		mkdirSync(logDir, { recursive: true });
		const node = process.execPath;
		const boot = SELF;
		const profile = args.profile;
		const port = String(args.port);
		const cwd = args.cwd || process.cwd();
		const launcherLog = join(logDir, "open-boot.log");
		const ps1Path = join(scriptsDir, "dsh-launcher-start.ps1");

		const ps1 = [
			"# Generated by dsh-drydock open-boot (launcher 1.0.0); regenerated at every launcher start.",
			"# Escapes any console Job object by parenting the new process to WmiPrvSE via Win32_Process.Create.",
			"# Written as UTF-8 with BOM so PowerShell 5.1 parses non-ASCII (dev-copy) paths correctly.",
			"$node = '" + escPs(node) + "'",
			"$boot = '" + escPs(boot) + "'",
			"$profile = '" + escPs(profile) + "'",
			"$port = '" + escPs(port) + "'",
			"$cwd = '" + escPs(cwd) + "'",
			"$log = '" + escPs(launcherLog) + "'",
			"$line = 'cmd.exe /s /c \"\"' + $node + '\" \"' + $boot + '\" --supervise --profile \"' + $profile + '\" --port ' + $port + ' --no-window >> \"' + $log + '\" 2>&1\"'",
			"$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $cwd }",
			"if ($r.ReturnValue -ne 0) { Write-Error ('WMI Win32_Process.Create failed with ReturnValue ' + $r.ReturnValue); exit 1 }",
			"Write-Output ('dsh-launcher: started launcher pid ' + $r.ProcessId)",
			""
		].join("\r\n");

		const cmd = [
			"@echo off",
			"rem Line 1-3 are pure ASCII: cmd parses them before the codepage switch below.",
			"rem Non-ASCII paths (dev copies) need the file itself to be UTF-8 + this switch;",
			"rem production install paths are pure ASCII and unaffected.",
			"chcp 65001 >nul",
			"rem DSH launcher control script, generated by open-boot (dsh-drydock 1.0.0).",
			"rem Regenerated automatically at every launcher start; safe to delete (it will come back).",
			"rem Usage: dsh-launcher.cmd start|stop|status",
			"setlocal EnableExtensions",
			"set \"NODE=" + node + "\"",
			"set \"BOOT=" + boot + "\"",
			"set \"PROFILE=" + profile + "\"",
			"set \"PORT=" + port + "\"",
			"set \"WORKDIR=" + cwd + "\"",
			"set \"LOGDIR=" + logDir + "\"",
			"set \"PS1=" + ps1Path + "\"",
			"set \"PIDFILE=%PROFILE%\\.open-boot.pid\"",
			"rem PIDPS = PIDFILE with ' doubled (cmd substitution) so PowerShell single-quoted paths stay intact",
			"set \"PIDPS=%PIDFILE:'=''%\"",
			"if /i \"%~1\"==\"start\" goto start",
			"if /i \"%~1\"==\"stop\" goto stop",
			"if /i \"%~1\"==\"status\" goto status",
			"echo Usage: %~nx0 start^|stop^|status",
			"endlocal & exit /b 2",
			":start",
			"if not exist \"%NODE%\" echo [dsh-launcher] node.exe missing: %NODE% & endlocal & exit /b 2",
			"if not exist \"%BOOT%\" echo [dsh-launcher] open-boot.mjs missing: %BOOT% & endlocal & exit /b 2",
			"powershell -NoProfile -ExecutionPolicy Bypass -File \"%PS1%\"",
			"endlocal & exit /b %ERRORLEVEL%",
			":stop",
			"if not exist \"%PIDFILE%\" echo [dsh-launcher] no pid file - launcher not running (or already stopped) & endlocal & exit /b 0",
			"for /f usebackq delims= %%p in (`powershell -NoProfile -Command \"(Get-Content -Raw '%PIDPS%' | ConvertFrom-Json).pid\"`) do set \"LPID=%%p\"",
			"if not defined LPID echo [dsh-launcher] pid file unreadable, remove it manually: %PIDFILE% & endlocal & exit /b 1",
			"for /f usebackq delims= %%a in (`powershell -NoProfile -Command \"$p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + %LPID%); if ($null -eq $p) { 'gone' } elseif ($p.CommandLine -match 'open-boot') { 'match' } else { 'mismatch' }\"`) do set \"OWNER=%%a\"",
			"rem rc.2 P2-5：OWNER 未取到（for /f 无输出）也必须拒绝——只有显式 'match' 才放行，杜绝空值穿透到 taskkill",
			"if \"%OWNER%\"==\"gone\" echo [dsh-launcher] pid %LPID% already gone - cleaning stale pid file & del /q \"%PIDFILE%\" >nul 2>&1 & endlocal & exit /b 0",
			"if not \"%OWNER%\"==\"match\" echo [dsh-launcher] pid %LPID% is NOT a dsh launcher (pid reuse suspected) - refusing to kill & endlocal & exit /b 3",
			"echo [dsh-launcher] stopping launcher, pid %LPID% ...",
			"rem rc.2 P2-5：去掉 /T——不再连坐整棵进程树（启动器自己的子树里可能有用户会话），只结束启动器主进程",
			"taskkill /F /PID %LPID% >nul 2>&1",
			"del /q \"%PIDFILE%\" >nul 2>&1",
			"echo [dsh-launcher] stopped.",
			"endlocal & exit /b 0",
			":status",
			"powershell -NoProfile -Command \"$ErrorActionPreference='Stop'; try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ('http://127.0.0.1:' + '%PORT%' + '/api/status'); if ($r.Content -match 'dsh-open-boot') { Write-Output ('RUNNING ' + (ConvertFrom-Json $r.Content).pid); exit 0 } } catch { }; Write-Output 'DOWN'; exit 1\"",
			"endlocal & exit /b %ERRORLEVEL%",
			""
		].join("\r\n");

		// ps1 加 UTF-8 BOM：PowerShell 5.1 无 BOM 会按 ANSI(GBK) 读，中文路径（开发副本）会乱码
		writeFileSync(ps1Path, "\uFEFF" + ps1, "utf8");
		writeFileSync(join(scriptsDir, "dsh-launcher.cmd"), cmd, "utf8");
		return join(scriptsDir, "dsh-launcher.cmd");
	} catch (error) {
		console.error(`[open-boot] 生成 dsh-launcher.cmd 失败（不影响本次启动）：${error.message}`);
		return null;
	}
}

/**
 * 引擎主题偏好（服务端只读）：DSH 的主题设置落在 Host 用户设置文档 ui-theme 段（字段 preference: light|dark|system，
 * 默认 system=跟随系统偏好；dsh-settings v0.9+ 把 settings.yaml 收进 profile.home）。
 * 本机该文件不存在时返回 "system" —— 页面回退到 prefers-color-scheme；文件一旦出现（用户在引擎外观里存过主题），重启启动器即生效。
 */
function engineThemePreference(profile) {
	const candidates = [join(profile, "settings.yaml")];
	const legacy = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "settings.yaml");
	if (!candidates.includes(legacy)) candidates.push(legacy);
	for (const path of candidates) {
		try {
			const lines = readFileSync(path, "utf8").split(/\r?\n/);
			let inBlock = false;
			for (const line of lines) {
				if (/^#/.test(line) || !line.trim()) continue;
				if (/^\S/.test(line)) { // 顶层键：进入/离开 ui-theme 段
					if (inBlock) break;
					inBlock = line.startsWith("ui-theme:");
					continue;
				}
				if (!inBlock) continue;
				const match = line.match(/^\s+preference:\s*["']?(\S+?)["']?\s*$/);
				if (match) return ["light", "dark", "system"].includes(match[1]) ? match[1] : "system";
			}
		} catch { /* 读不到（无文件/权限）就按 system */ }
	}
	return "system";
}

/**
 * 启动器内置插件管理页（1.0.0-rc.2 重做）：独立于引擎 UI —— mod 全被禁用时它是唯一能重新打开它们的入口。
 * 设计语言与 3085 预览一致：浅灰底 + 白卡 + 蓝强调、扁平分区、toggle 开关、toast、确认框；
 * 主题三态（自动=引擎外观 preference > 系统偏好；手动覆盖 localStorage；长按复位）；标题「引擎与插件管理台」。
 * 功能：搜索过滤 / 启停 / 更新检查与更新 / 事务性卸载（步骤日志）/ mod 体检 / 市场辅助 / 重启引擎 / 停止启动器。
 */
function pluginsPageHtml({ token = "__DSH_PM_TOKEN__", enginePort = ENGINE_PORT, launcherPort = launcherPortFromEnv(), engineTheme = "system" } = {}) {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>引擎与插件管理台</title>${DRYDOCK_FAVICON_LINK}
<meta name="dsh-pm-token" content="${token}">
<style>
:root{--bg:#f6f7f9;--card:#ffffff;--border:#e3e6ec;--text:#1c2330;--dim:#6b7280;--accent:#3b6ef6;--accent-bg:#eef2ff;
--ok:#16a34a;--ok-bg:#e7f6ec;--bad:#dc2626;--bad-bg:#fdeaea;--warn:#d97706;--warn-bg:#fdf3e3;--chip:#eef2ff;--shadow:0 1px 3px rgba(16,24,40,.06)}
[data-theme="dark"]{--bg:#15171c;--card:#1e2128;--border:#2e323c;--text:#e5e7eb;--dim:#9aa1ad;--accent:#5b8cff;--accent-bg:#232838;
--ok:#4ade80;--ok-bg:#1d3326;--bad:#f87171;--bad-bg:#3a1d1d;--warn:#fbbf24;--warn-bg:#332a16;--chip:#232838;--shadow:none}
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:28px 20px 48px;display:flex;justify-content:center;transition:background .15s,color .15s}
.wrap{max-width:760px;width:100%}
header{display:flex;align-items:flex-start;gap:12px;margin-bottom:18px}
header h1{font-size:19px;margin:0;font-weight:700;letter-spacing:.2px}
header .sub{color:var(--dim);font-size:12.5px;margin-top:4px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-bottom:14px;box-shadow:var(--shadow)}
.sect{font-size:12px;font-weight:700;color:var(--dim);letter-spacing:.6px;margin:0 0 10px;text-transform:uppercase}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input[type=search]{flex:1 1 200px;min-width:160px;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:8px;padding:7px 12px;font-size:13px;outline:none}
input[type=search]:focus{border-color:var(--accent)}
button{cursor:pointer;border:1px solid var(--border);background:var(--card);color:var(--text);border-radius:8px;padding:6px 13px;font-size:13px;transition:background .12s,opacity .12s}
button:hover{border-color:var(--accent);color:var(--accent)}
button:disabled{opacity:.45;cursor:not-allowed;color:var(--text);border-color:var(--border)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.primary:hover{color:#fff;opacity:.92}
button.danger{color:var(--bad);border-color:var(--bad)}
button.danger:hover{background:var(--bad-bg);color:var(--bad)}
.rows{display:flex;flex-direction:column}
.rowitem{display:flex;align-items:center;gap:12px;padding:10px 4px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.rowitem:last-child{border-bottom:none}
.rowitem .meta{flex:1;min-width:180px}
.rowitem .name{font-family:ui-monospace,monospace;font-size:13px;font-weight:600;word-break:break-all}
.rowitem .desc{color:var(--dim);font-size:12px;margin-top:2px}
.badge{display:inline-block;padding:1px 9px;border-radius:999px;font-size:11.5px;font-weight:600}
.b-on{background:var(--ok-bg);color:var(--ok)}.b-off{background:var(--bad-bg);color:var(--bad)}
.b-core{background:var(--warn-bg);color:var(--warn)}.b-self{background:var(--chip);color:var(--accent)}
.b-upd{background:var(--accent-bg);color:var(--accent)}
/* toggle 开关 */
.toggle{position:relative;display:inline-block;width:36px;height:20px;flex:none}
.toggle input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.toggle .knob{position:absolute;inset:0;border-radius:999px;background:var(--border);transition:background .15s;pointer-events:none}
.toggle .knob::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.toggle input:checked + .knob{background:var(--accent)}
.toggle input:checked + .knob::after{left:18px}
.toggle input:disabled + .knob{opacity:.45;cursor:not-allowed}
/* U1：禁用的 input 会吞掉鼠标事件（点击落在它身上就什么都不发生）→ 让事件落到 label/knob 上，
   这样"点核心组件开关"能弹 toast 解释为什么不能点，而不是一片死寂。 */
.toggle input:disabled{pointer-events:none}
.hint{color:var(--dim);font-size:12px;line-height:1.6}
.hint a{color:var(--accent)}
.dim{color:var(--dim)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
pre.log{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.7;white-space:pre-wrap;max-height:260px;overflow:auto;font-family:ui-monospace,monospace}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:baseline}
.dot.ok{background:var(--ok)}.dot.suspect{background:var(--warn)}.dot.broken{background:var(--bad)}
/* toast */
#toasts{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:60;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.toast{background:var(--card);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:8px;padding:9px 16px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.14);max-width:520px}
.toast.ok{border-left-color:var(--ok)}.toast.bad{border-left-color:var(--bad)}.toast.warn{border-left-color:var(--warn)}
/* 确认框 */
#mask{position:fixed;inset:0;background:rgba(10,12,16,.45);display:none;align-items:center;justify-content:center;z-index:50}
#mask.open{display:flex}
#confirmBox{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;max-width:440px;width:calc(100% - 40px);box-shadow:0 8px 30px rgba(0,0,0,.25)}
#confirmBox h3{margin:0 0 8px;font-size:15px}
#confirmBox p{margin:0 0 14px;font-size:13px;color:var(--dim);line-height:1.7;white-space:pre-wrap}
#confirmBox .btns{display:flex;justify-content:flex-end;gap:8px}
.panel{display:none}
.panel.open{display:block}
/* U1：结果卡片落点 —— 操作完成后滚动到位 + 闪一下，避免"结果在视口外 = 按钮没反应" */
@keyframes cardflash{0%{box-shadow:0 0 0 0 rgba(59,110,246,0)}35%{box-shadow:0 0 0 3px var(--accent)}100%{box-shadow:0 0 0 0 rgba(59,110,246,0)}}
.card.flash{animation:cardflash 1.6s ease-out}
/* U1：按钮 loading 态（发起反馈） */
button.busy{cursor:progress;opacity:.65}
.rowitem.busy{opacity:.6}
</style></head><body><div class="wrap">
<header>
	<div>
		<h1>${drydockLogoMarkSvg(20)} 引擎与插件管理台</h1>
		<div class="sub">插件管理（启动器内置兜底页 · 独立于引擎 UI） · <a href="/">启动页</a> · <a href="/rescue">救援中心</a> · <a href="http://127.0.0.1:${enginePort}/" id="mainLink">主界面</a></div>
	</div>
</header>

<div class="card">
	<div class="toolbar">
		<input type="search" id="q" placeholder="搜索插件名 / 描述…" aria-label="搜索插件">
		<button id="refreshBtn" title="重新读取 bundle 列表">刷新</button>
		<button id="checkUpdBtn" title="对用户插件逐一比对最新版本">检查更新</button>
		<button id="healthBtn" title="preflight 只读校验 + 引擎日志错误聚合">🩺 mod 体检</button>
		<button id="themeBtn" type="button" aria-label="切换深浅主题">
			<svg id="themeIconSun" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1.5px"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
			<svg id="themeIconMoon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1.5px;display:none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
			主题
		</button>
		<button id="restartBtn" class="danger">🔄 重启引擎</button>
		<button id="stopBtn" class="danger">⛔ 停止本启动器</button>
	</div>
	<div class="hint" style="margin-top:10px"><span id="engstate" class="dim">引擎状态检测中…</span> · 改动启用状态后需重启引擎生效（写前自动备份 package.json）。</div>
</div>

<div class="card panel" id="updPanel">
	<p class="sect">更新检查结果</p>
	<div class="rows" id="updRows"></div>
</div>

<div class="card panel" id="healthPanel">
	<p class="sect">mod 体检（只读）</p>
	<div class="rows" id="healthRows"></div>
	<div class="hint" style="margin-top:8px" id="healthHint"></div>
</div>

<div class="card panel" id="stepPanel">
	<p class="sect">操作步骤日志</p>
	<div class="rows" id="stepRows"></div>
</div>

<div class="card">
	<p class="sect">核心组件（引擎必需，不允许禁用）</p>
	<div class="rows" id="coreRows"></div>
</div>

<div class="card">
	<p class="sect">用户插件</p>
	<div class="rows" id="userRows"></div>
	<div class="hint" style="margin-top:8px">配置入口在各插件的行内设置（主界面 → 插件管理 → 行内 ⚙）；「市场详情」打开主界面市场页。</div>
</div>

<div class="hint" style="margin-top:16px">管理器不能在自身管理界面（引擎 ${enginePort}）中停用自己；如需禁用或卸载，请前往启动器兜底页（本页 ${launcherPort} /plugins）或使用 dsh 命令行——兜底页独立于引擎存活，禁用后仍可恢复。<b>可事务性自卸载</b>（含开机自启清理指引）。卸载/更新前若引擎正占用目标包，会引导你先禁用并重启引擎，而不是硬删。</div>
</div>

<div id="toasts"></div>
<div id="mask"><div id="confirmBox" role="dialog" aria-modal="true">
	<h3 id="cfTitle">确认</h3><p id="cfText"></p>
	<div class="btns"><button id="cfCancel">取消</button><button id="cfOk" class="danger">确认</button></div>
</div></div>

<script>
var TOKEN = (document.querySelector('meta[name="dsh-pm-token"]') || {}).content || "";
var ENGINE_PORT = ${enginePort};
var bundles = [];
var updates = [];
var reloadTried = false;

// —— 主题：自动优先（服务端注入的引擎主题 preference > 系统偏好），手动点击写 localStorage 覆盖，长按复位自动 ——
var ENGINE_THEME = ${JSON.stringify(engineTheme)}; // "light" | "dark" | "system"（来自 profile settings.yaml ui-theme 段）
var THEME_KEY = "jdock-theme";
var themeBtn = document.getElementById("themeBtn");
var themeIconSun = document.getElementById("themeIconSun");
var themeIconMoon = document.getElementById("themeIconMoon");
var darkMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function systemDark(){ return Boolean(darkMedia && darkMedia.matches); }
function autoTheme(){ return ENGINE_THEME !== "system" ? ENGINE_THEME : (systemDark() ? "dark" : "light"); }
function manualTheme(){
	try { var v = localStorage.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : null; }
	catch (e) { return null; }
}
function applyTheme(){
	var theme = manualTheme() || autoTheme();
	document.documentElement.setAttribute("data-theme", theme);
	// 深色时亮出太阳（点击转浅色），浅色时亮出月亮；自动模式在 tooltip 里说明来源
	themeIconSun.style.display = theme === "dark" ? "" : "none";
	themeIconMoon.style.display = theme === "dark" ? "none" : "";
	var source = manualTheme() ? "手动" : "自动（" + (ENGINE_THEME !== "system" ? "跟随引擎外观：" + ENGINE_THEME : "跟随系统偏好") + "）";
	themeBtn.title = "主题：" + source + "。点击切换深浅；长按 0.6 秒复位为自动。";
	themeBtn.setAttribute("aria-label", themeBtn.title);
}
var themePressTimer = null;
var themeLongPressed = false;
themeBtn.addEventListener("click", function(){
	if (themeLongPressed) { themeLongPressed = false; return; } // 长按复位后的那次 click 不再当作切换
	var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
	try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 写不进去就只在本会话生效 */ }
	applyTheme();
	toast("主题已切换为" + (next === "dark" ? "深色" : "浅色") + "（本页记忆；长按主题按钮复位为自动）", "ok");
});
themeBtn.addEventListener("pointerdown", function(){
	themeLongPressed = false;
	themePressTimer = setTimeout(function(){
		themeLongPressed = true;
		themePressTimer = null;
		try { localStorage.removeItem(THEME_KEY); } catch (e) {}
		applyTheme();
		toast("主题已复位：自动（" + (ENGINE_THEME !== "system" ? "跟随引擎外观：" + ENGINE_THEME : "跟随系统偏好") + "）", "ok");
	}, 650);
});
["pointerup", "pointerleave", "pointercancel"].forEach(function(name){
	themeBtn.addEventListener(name, function(){
		if (themePressTimer !== null) { clearTimeout(themePressTimer); themePressTimer = null; }
	});
});
if (darkMedia && darkMedia.addEventListener) darkMedia.addEventListener("change", function(){ if (!manualTheme()) applyTheme(); });
applyTheme();

function toast(text, cls){
	var box = document.getElementById("toasts");
	var el = document.createElement("div");
	el.className = "toast " + (cls || "");
	el.setAttribute("role", "status");
	el.textContent = text;
	box.appendChild(el);
	setTimeout(function(){ el.remove(); }, 5200);
}
// —— U1：发起反馈 / 落点反馈的统一实现 ——
/** 按钮 loading 态：禁用 + 改文案，结束后逐字还原（防重复点击 + 用户能看出"点到了"）。 */
function setBusy(btn, busy, label){
	if (!btn) return;
	if (busy) {
		if (btn.dataset.idleText === undefined) btn.dataset.idleText = btn.textContent;
		btn.disabled = true;
		btn.classList.add("busy");
		btn.setAttribute("aria-busy", "true");
		if (label) btn.textContent = label;
	} else {
		btn.disabled = false;
		btn.classList.remove("busy");
		btn.removeAttribute("aria-busy");
		if (btn.dataset.idleText !== undefined) { btn.textContent = btn.dataset.idleText; delete btn.dataset.idleText; }
	}
}
async function withBusy(btn, label, fn){
	setBusy(btn, true, label);
	try { return await fn(); } finally { setBusy(btn, false); }
}
/** 结果卡片落点：打开 → 滚进视口（block:nearest，不把页面顶跳）→ 高亮闪一下；toast 是"感知"，这是"眼睛的落点"。 */
function revealPanel(id){
	var panel = document.getElementById(id);
	if (!panel) return;
	panel.classList.add("open");
	panel.classList.remove("flash");
	try { void panel.offsetWidth; } catch (e) { /* 强制重排以重放动画 */ }
	panel.classList.add("flash");
	if (panel._flashTimer) clearTimeout(panel._flashTimer);
	panel._flashTimer = setTimeout(function(){ panel.classList.remove("flash"); }, 1700);
	try {
		// 卡片比视口还高时（体检 20+ 行 / 长列表后的步骤日志）nearest 可能只对齐底边，
		// 标题被切掉一半 → 这种情况对齐卡片顶部，保证"体检结果"这个标题一定在屏幕里。
		var tall = panel.getBoundingClientRect().height > window.innerHeight * 0.85;
		panel.scrollIntoView({ block: tall ? "start" : "nearest", behavior: "smooth" });
	} catch (e) { try { panel.scrollIntoView(false); } catch (e2) { /* 老浏览器不支持时退化为仅高亮 */ } }
}
/** 失败 toast 必须带原因：服务端没给原因也要说清"没给原因"，不许只说"失败"。 */
function failText(prefix, r){
	return prefix + "：" + ((r && r.error) ? r.error : "服务端未返回原因（可看「操作步骤日志」或重启启动器后重试）");
}

function confirmBox(title, text, okLabel){
	return new Promise(function(resolveCF){
		var mask = document.getElementById("mask");
		document.getElementById("cfTitle").textContent = title;
		document.getElementById("cfText").textContent = text;
		var ok = document.getElementById("cfOk");
		ok.textContent = okLabel || "确认";
		mask.classList.add("open");
		function done(val){ mask.classList.remove("open"); ok.removeEventListener("click", onOk); document.getElementById("cfCancel").removeEventListener("click", onCancel); resolveCF(val); }
		function onOk(){ done(true); }
		function onCancel(){ done(false); }
		ok.addEventListener("click", onOk);
		document.getElementById("cfCancel").addEventListener("click", onCancel);
	});
}
async function api(path, body){
	// rc.2 P1-6：GET（/updates /health）也要带令牌——服务端对这两个 GET 已开令牌校验
	var headers = { "X-DSH-PM-Token": TOKEN };
	var opt = body
		? { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers), body: JSON.stringify(body) }
		: { headers: headers };
	var x = await fetch(path, opt);
	if (x.status === 401 && !reloadTried) {
		reloadTried = true;
		try { sessionStorage.setItem("jdock-reloaded", "1"); } catch (e) {}
		location.reload();
		return new Promise(function(){});
	}
	return x.json();
}
async function guard(fn, busyLabel){
	// 统一兜底：任何按钮处理器的网络/服务端异常都变成可见 toast，不再静默卡死按钮
	try { return await fn(); }
	catch (e) { toast("网络错误：" + (e && e.message ? e.message : e) + "（启动器可能已重启，请刷新页面）", "bad"); return null; }
}
function el(tag, cls, text){
	var node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined && text !== null) node.textContent = text;
	return node;
}
function toggleHtml(b){
	var label = document.createElement("label");
	label.className = "toggle";
	label.title = b.core ? "核心组件：不允许从这里禁用（否则引擎 " + ENGINE_PORT + " 无法打开页面）" : (b.name + (b.enabled ? "：点击禁用" : "：点击启用"));
	var input = document.createElement("input");
	input.type = "checkbox"; input.checked = b.enabled; input.disabled = Boolean(b.core);
	input.setAttribute("aria-label", b.name + (b.enabled ? " 禁用" : " 启用"));
	input.dataset.name = b.name;
	var knob = document.createElement("span"); knob.className = "knob";
	label.appendChild(input); label.appendChild(knob);
	if (b.core) {
		// 核心组件的开关是 disabled 的：点它原本毫无反应（用户以为坏了）→ 现在明确说明为什么不能点
		label.addEventListener("click", function(ev){
			ev.preventDefault();
			toast(b.name + " 是引擎必需的核心组件，不能在这里禁用；确需停用请走救援中心 /rescue 或手工改 profile。", "warn");
		});
	}
	return label;
}
function renderRows(){
	var kw = document.getElementById("q").value.trim().toLowerCase();
	var coreRows = document.getElementById("coreRows");
	var userRows = document.getElementById("userRows");
	coreRows.textContent = ""; userRows.textContent = "";
	var list = bundles.filter(function(b){
		if (!kw) return true;
		return b.name.toLowerCase().includes(kw) || String(b.description || "").toLowerCase().includes(kw);
	});
	var updMap = {};
	updates.forEach(function(u){ updMap[u.name] = u; });
	list.forEach(function(b){
		var row = el("div", "rowitem");
		var meta = el("div", "meta");
		var nameLine = el("div", "name");
		nameLine.textContent = b.name;
		if (b.core) nameLine.appendChild(el("span", "badge b-core", " 核心"));
		if (b.self) nameLine.appendChild(el("span", "badge b-self", " 管理器·本页可禁用/可卸载（引擎 ${enginePort} 界面内不可自禁）"));
		if (updMap[b.name] && updMap[b.name].needsUpdate) nameLine.appendChild(el("span", "badge b-upd", " 有新版 " + updMap[b.name].latest));
		meta.appendChild(nameLine);
		var desc = b.description || (b.core ? "引擎必需的核心组件" : (b.self ? "本管理台对应的插件包（禁用后引擎 ${enginePort} 的插件页消失，启动器 ${launcherPort} 本页不受影响）" : ""));
		if (updMap[b.name] && updMap[b.name].current) desc = (desc ? desc + " · " : "") + "当前 " + updMap[b.name].current;
		if (desc) meta.appendChild(el("div", "desc", desc));
		row.appendChild(meta);
		row.appendChild(toggleHtml(b));
		if (!b.core) {
			if (updMap[b.name] && updMap[b.name].needsUpdate) {
				var ub = el("button", null, "更新");
				ub.title = "pnpm update（引擎占用时会引导先禁用）";
				ub.addEventListener("click", function(){ doUpdate(b.name, ub); });
				row.appendChild(ub);
			}
			var ub2 = el("button", null, "卸载");
			ub2.className = b.self ? "danger" : "";
			ub2.addEventListener("click", function(){ doUninstall(b, ub2); });
			row.appendChild(ub2);
		}
		var mk = el("button", null, "市场详情");
		mk.title = "打开主界面（引擎未运行时置灰）";
		mk.disabled = !engineUp;
		mk.addEventListener("click", function(){
			var url = "http://127.0.0.1:" + ENGINE_PORT + "/";
			var w = null;
			try { w = window.open(url, "_blank"); } catch (e) { w = null; }
			if (!w) toast("浏览器拦截了新标签页：请允许本站弹窗，或手动打开 " + url, "warn");
			else toast("已在新标签页打开主界面（" + url + "）", "ok");
		});
		row.appendChild(mk);
		(b.core ? coreRows : userRows).appendChild(row);
	});
	if (!list.filter(function(b){ return !b.core; }).length) userRows.appendChild(el("div", "hint", kw ? "没有匹配「" + kw + "」的用户插件" : "profile 里没有用户插件"));
}
function renderUpdateRows(){
	var panel = document.getElementById("updPanel");
	var rows = document.getElementById("updRows");
	rows.textContent = "";
	panel.classList.add("open");
	updates.forEach(function(u){
		var row = el("div", "rowitem");
		var meta = el("div", "meta");
		meta.appendChild(el("div", "name", u.name));
		meta.appendChild(el("div", "desc", u.needsUpdate ? (u.current || "?") + " → " + u.latest + "（可更新）" : (u.current ? "已是最新 " + u.current : "版本未知")));
		row.appendChild(meta);
		if (u.needsUpdate) {
			var b = el("button", "primary", "更新");
			b.addEventListener("click", function(){ doUpdate(u.name, b); });
			row.appendChild(b);
		}
		rows.appendChild(row);
	});
}
function renderSteps(steps){
	var panel = document.getElementById("stepPanel");
	var rows = document.getElementById("stepRows");
	rows.textContent = "";
	panel.classList.add("open");
	steps.forEach(function(s){
		var row = el("div", "rowitem");
		var mark = s.status === "ok" ? "✔" : (s.status === "warn" ? "⚠" : (s.status === "fail" ? "✘" : "·"));
		var cls = s.status === "ok" ? "ok" : (s.status === "warn" ? "warn" : (s.status === "fail" ? "bad" : "dim"));
		var meta = el("div", "meta");
		var line = el("div", null, null);
		var strong = el("b", cls, mark + " " + s.action);
		line.appendChild(strong);
		line.appendChild(el("span", "dim", "　" + s.detail));
		meta.appendChild(line);
		if (s.rollback) meta.appendChild(el("div", "desc", "回滚依据：" + s.rollback));
		row.appendChild(meta);
		rows.appendChild(row);
	});
}
async function doUpdate(name, btn){
	setBusy(btn, true, "更新中…");
	await guard(async function(){
		var okGo = await confirmBox("更新 " + name, "将运行 pnpm update --latest。若引擎正在运行且该插件已启用，会拒绝并引导你先禁用。", "更新");
		if (!okGo) { toast("已取消更新 " + name, "warn"); return; }
		toast("正在更新 " + name + "（pnpm update --latest，可能 10-60s）…", "warn");
		var r = await api("/plugins/api/update", { name: name });
		if (!r.ok) {
			toast(failText("更新 " + name + " 失败", r) + (r.blocked === "engine-busy" ? "（引擎正占用该包：先禁用该插件并重启引擎，再更新）" : ""), r.blocked === "engine-busy" ? "warn" : "bad");
			return;
		}
		toast("已更新 " + name + (r.message ? "：" + r.message : "（重启引擎后生效）"), "ok");
		// 刷新更新面板并 revealPanel("updPanel")（refreshUpdates 内部负责滚到位；失败时不会掀出空卡片）
		await refreshUpdates({ showPanel: true, announce: false });
	});
	setBusy(btn, false);
}
async function doUninstall(b, btn){
	setBusy(btn, true, "卸载中…");
	await guard(async function(){
		var warnText = b.self
			? "这是管理器自身：卸载后引擎 ${enginePort} 内的插件管理界面消失；启动器 ${launcherPort} 本兜底页存活到启动器进程结束；之后请运行 node bin/open-boot.mjs --uninstall 清理开机自启。确定继续？"
			: "将执行事务性卸载：备份清单与 cordis.patch.yml → pnpm remove → 清理补丁行 → 验证；每一步都会留下回滚记录。确定继续？";
		var okGo = await confirmBox("卸载 " + b.name, warnText, "卸载");
		if (!okGo) { toast("已取消卸载 " + b.name, "warn"); return; }
		toast("正在卸载 " + b.name + "（事务性：备份 → pnpm remove → 清理补丁 → 验证）…", "warn");
		var r = await api("/plugins/api/uninstall", { name: b.name });
		if (!r.ok) {
			toast(failText("卸载 " + b.name + " 失败", r) + (r.blocked === "engine-busy" ? "（引擎正占用该包：先禁用该插件并重启引擎，再卸载）" : ""), r.blocked === "engine-busy" ? "warn" : "bad");
			return;
		}
		toast("已卸载 " + b.name + (r.message ? "：" + r.message : "（重启引擎后生效）"), "ok");
		if (Array.isArray(r.steps)) { renderSteps(r.steps); revealPanel("stepPanel"); }
		await loadBundles();
	});
	setBusy(btn, false);
}
async function loadBundles(announce){
	return guard(async function(){
		var r = await api("/plugins/api/bundles");
		if (!r.ok) { toast(failText("读取插件列表失败", r), "bad"); return; }
		bundles = (r.bundles || []).map(function(b){ return { name: b.name, enabled: b.enabled, core: b.core, self: b.name === "dsh-drydock" }; });
		renderRows();
		if (announce) {
			var users = bundles.filter(function(b){ return !b.core; }).length;
			var on = bundles.filter(function(b){ return b.enabled; }).length;
			toast("已刷新：共 " + bundles.length + " 个组件（用户插件 " + users + " 个，已启用 " + on + " 个）", "ok");
		}
	});
}
async function refreshUpdates(opts){
	opts = opts || {};
	var showPanel = opts.showPanel !== false;
	var announce = opts.announce !== false;
	return guard(async function(){
		if (announce) toast("正在检查更新：逐个比对用户插件的最新版本…", "warn");
		var r = await api("/plugins/api/updates");
		if (!r.ok) { toast(failText("检查更新失败", r), "bad"); return; }
		updates = r.updates || [];
		var pending = updates.filter(function(u){ return u.needsUpdate; });
		var n = pending.length;
		if (announce) {
			var names = pending.slice(0, 3).map(function(u){ return u.name; }).join("、");
			toast(n
				? "发现 " + n + " 个可更新插件：" + names + (n > 3 ? " 等" : "") + "（结果在「更新检查结果」卡片）"
				: "全部 " + updates.length + " 个用户插件已是最新", n ? "warn" : "ok");
		}
		renderRows();
		if (showPanel) renderUpdateRows();
		if (showPanel) revealPanel("updPanel");
	});
}
async function runHealth(){
	return guard(async function(){
		toast("正在做 mod 体检（只读：preflight 校验 + 引擎日志末尾 256KB）…", "warn");
		var r = await api("/plugins/api/health");
		if (!r.ok) { toast(failText("mod 体检失败", r), "bad"); return; }
		var reportRows = r.rows || [];
		var gi = r.globalIssues || [];
		var broken = reportRows.filter(function(x){ return x.verdict === "broken"; });
		var suspect = reportRows.filter(function(x){ return x.verdict === "suspect"; });
		var rows = document.getElementById("healthRows");
		rows.textContent = "";
		reportRows.forEach(function(row){
			var item = el("div", "rowitem");
			var meta = el("div", "meta");
			var line = el("div", "name", null);
			line.appendChild(el("span", "dot " + row.verdict));
			line.appendChild(document.createTextNode(row.name));
			if (row.core) line.appendChild(el("span", "badge b-core", " 核心"));
			if (!row.enabled) line.appendChild(el("span", "badge b-off", " 已禁用"));
			meta.appendChild(line);
			meta.appendChild(el("div", "desc", row.detail + (row.verdict === "broken" ? "（建议卸载或回滚）" : row.verdict === "suspect" ? "（建议禁用观察）" : "")));
			item.appendChild(meta);
			rows.appendChild(item);
		});
		// rc.2 P2-4：非 bundle 归属的 preflight 问题与未识别日志错误 → 单独区块
		if (gi.length) {
			var ghead = el("div", "rowitem");
			ghead.appendChild(el("b", "warn", "⚠ 全局问题（不属于任何已装 bundle，勿按插件处理）"));
			rows.appendChild(ghead);
			gi.forEach(function(row){
				var item = el("div", "rowitem");
				var meta = el("div", "meta");
				meta.appendChild(el("div", "name", row.name || "(未识别)"));
				meta.appendChild(el("div", "desc", row.detail || ""));
				item.appendChild(meta);
				rows.appendChild(item);
			});
		}
		document.getElementById("healthHint").textContent = "日志：" + (r.logPath || "") + "；体检只读（preflight 校验 + 日志末尾 256KB 聚合，30s 缓存），不改任何文件。";
		var healthy = reportRows.length - broken.length - suspect.length;
		var head = "体检完成：" + reportRows.length + " 个组件（正常 " + healthy + " / 可疑 " + suspect.length + " / 异常 " + broken.length + "）" + (gi.length ? "，另有 " + gi.length + " 条全局问题" : "");
		if (!reportRows.length) toast("体检完成：profile 里没有已装组件（「用户插件」列表为空就是原因）", "warn");
		else if (broken.length) toast(head + "；异常：" + broken.slice(0, 3).map(function(x){ return x.name; }).join("、") + (broken.length > 3 ? " 等" : ""), "bad");
		else if (suspect.length || gi.length) toast(head, "warn");
		else toast(head + "，全部正常", "ok");
		revealPanel("healthPanel");
	});
}
document.getElementById("q").addEventListener("input", renderRows);
document.getElementById("refreshBtn").addEventListener("click", function(){
	return withBusy(this, "刷新中…", function(){ return loadBundles(true); });
});
document.getElementById("checkUpdBtn").addEventListener("click", function(){
	return withBusy(this, "检查中…", function(){ return refreshUpdates({ showPanel: true, announce: true }); });
});
document.getElementById("healthBtn").addEventListener("click", function(){
	return withBusy(this, "体检中…", function(){ return runHealth(); });
});
document.getElementById("restartBtn").addEventListener("click", async function(){
	setBusy(this, true, "重启中…");
	try {
		await guard(async function(){
			var okGo = await confirmBox("重启引擎", "停旧引擎 → 拉起新引擎（失败条目自动隔离一次）→ 等握手。期间引擎 ${enginePort} 会短暂不可用。", "重启");
			if (!okGo) { toast("已取消重启引擎", "warn"); return; }
			toast("正在重启引擎（停旧 → 拉起 → 握手，最长约 30s）…", "warn");
			var r = await api("/plugins/api/engine/restart", {});
			if (r.ok) toast("引擎已重启，http://127.0.0.1:" + ENGINE_PORT + "/ 可访问" + (r.entryUrl ? "；登录链接已就绪，可直接打开主界面。" : "。"), "ok");
			else toast(failText("重启引擎失败", r), "bad");
			setEngineState(r.ok);
			// G03：entryUrl=null 时的降级指引（不渲染假 token 链接）
			if (r.ok && !r.entryUrl) toast("未捕获到本次启动的登录链接：① 已登录过的浏览器直接打开 http://127.0.0.1:" + ENGINE_PORT + "/（cookie 仍有效）；② 新浏览器请看引擎控制台输出的 dsh web: …?token=…，或到 ~/.dsh/logs/web.log 末尾查找最后一次启动追加的链接。", "warn");
		});
	} finally {
		setBusy(document.getElementById("restartBtn"), false);
	}
});
document.getElementById("stopBtn").addEventListener("click", async function(){
	setBusy(this, true, "停止中…");
	try {
		await guard(async function(){
			var okGo = await confirmBox("停止本启动器", "启动器进程将优雅退出并清理 pid 文件；引擎与本页面不受影响，重新打开 ${launcherPort} 会重新拉起启动器。", "停止");
			if (!okGo) { toast("已取消停止启动器", "warn"); return; }
			toast("正在停止本启动器（引擎与本页面不受影响）…", "warn");
			var r = await api("/api/launcher/stop", {});
			toast(r.message || "启动器即将退出；重新打开本页地址会重新拉起启动器。", r.ok === false ? "bad" : "warn");
			setTimeout(function(){ location.reload(); }, 1200);
		});
	} finally {
		setBusy(document.getElementById("stopBtn"), false);
	}
});
document.getElementById("userRows").addEventListener("change", async function(ev){
	var input = ev.target;
	if (!input || input.dataset.name === undefined) return;
	var name = input.dataset.name;
	var want = Boolean(input.checked);
	var row = input.closest ? input.closest(".rowitem") : null;
	input.disabled = true;
	if (row) row.classList.add("busy");
	toast((want ? "正在启用 " : "正在禁用 ") + name + "…", "warn");
	await guard(async function(){
		var r = await api("/plugins/api/bundles", { name: name, action: want ? "enable" : "disable" });
		if (!r.ok) toast(failText((want ? "启用 " : "禁用 ") + name + " 失败", r), "bad");
		else toast((want ? "已启用 " : "已禁用 ") + name + (r.changed === false ? "（本来就是这个状态，未改动）" : "，重启引擎后生效"), r.changed === false ? "warn" : "ok");
	});
	await loadBundles();
});
var engineUp = false;
function setEngineState(up){
	engineUp = up;
	var s = document.getElementById("engstate");
	s.textContent = up ? "引擎：运行中（端口 " + ENGINE_PORT + "）" : "引擎：未运行（重启按钮可拉起）";
	s.className = up ? "ok" : "warn";
	renderRows();
}
async function loadEngine(){
	return guard(async function(){
		var st = await fetch("/api/status").then(function(x){ return x.json(); });
		setEngineState(Boolean(st.engineUp));
	});
}
loadBundles(); loadEngine();
// U1：结果区（#updPanel / #healthPanel / #stepPanel）已前移到用户插件列表之上，
// 因此 #health 直达既能看见结果，也不会被长列表顶出视口；再靠 revealPanel 的滚动+高亮给落点。
if (location.hash === "#health") runHealth(); // 3080 RescuePanel 的「mod 体检」入口直达（/plugins#health）
window.addEventListener("hashchange", function(){
	if (location.hash === "#health") runHealth();
});
</script>
</div></body></html>`;
}

/**
 * 读取并解析 POST JSON body（≤64KB；解析失败/超限返回 null；10s 超时返回 { timeout: true }
 * 并断开连接——慢速/挂起的恶意客户端不再无限占用处理器）。
 */
function readJsonBody(req) {
	return new Promise((resolveBody) => {
		let data = "";
		let settled = false;
		let timer = null;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			resolveBody(value);
		};
		timer = setTimeout(() => {
			finish({ timeout: true });
			try { req.destroy(); } catch { /* ignore */ }
		}, 10000);
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 65536) { finish(null); try { req.destroy(); } catch { /* ignore */ } }
		});
		req.on("end", () => { try { finish(data.trim() ? JSON.parse(data) : {}); } catch { finish(null); } });
		req.on("error", () => finish(null));
	});
}

/**
 * S3：Host 头校验（DNS 重绑定防护）。只接受带端口的回环主机名 ——
 * 攻击者把 `evil.example` 解析到 127.0.0.1 后，浏览器发出的请求 Host 仍是 `evil.example`，
 * 只看 Origin/令牌挡不住"读接口被同源化"（/api/status 会暴露 profile 绝对路径 / pid / 版本）。
 * 严格按审查报告：必须带端口、大小写不敏感、只认这三种回环写法。
 */
function isAllowedHost(hostHeader, port) {
	if (typeof hostHeader !== "string" || hostHeader.trim() === "") return false;
	const host = hostHeader.trim().toLowerCase();
	return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/**
 * S4：统一安全响应头。页面是内联 `<script>` + 内联 `<style>`，因此保留 `'unsafe-inline'`
 * （nonce 化要同时改三个页面模板 + 救援页，1.0.3 不做）；其余全部收紧：
 *   default-src 'none'      —— 默认不许加载任何东西；
 *   connect-src 'self'      —— 3081 页只能同源 fetch（/plugins/api/*、/rescue/api/*）；
 *   img-src 'self' data:    —— 内联 favicon 是 data: URI；
 *   frame-ancestors 'none' / X-Frame-Options: DENY —— 禁止被嵌框（点劫持）；
 *   base-uri 'none'         —— 防 <base> 改写相对地址；
 *   nosniff / Referrer-Policy: no-referrer —— 防 MIME 嗅探与地址外泄。
 */
const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
};

/**
 * 给响应挂上安全头并返回可交给 writeHead 的 headers。
 * 也在请求入口先 `setHeader` 一次：这样 lib/rescue 的 handleRescueApi 自己 writeHead 的
 * JSON 响应（本仓库文件范围外）同样带上安全头。
 */
function applySecurityHeaders(res, extra = {}) {
	if (res && typeof res.setHeader === "function" && !res.headersSent) {
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
	}
	return { ...SECURITY_HEADERS, ...extra };
}

function startServer(args) {
	const startedAt = new Date().toISOString();
	// 1.0.0-rc.1：每次启动器进程起来都重写 dsh-launcher.cmd（重装/升级后自愈，路径全部来自当前实况）
	const launcherCmdPath = ensureLauncherCmd(args);
	// L11 ②：一次性令牌（每次启动随机生成）——只注入页面 meta 与请求头，**不写日志、不落 profile 文件**
	const token = newApiToken();
	// v1.1.0 M2（契约 F1/F2）：桌面版渲染进程的页面来源是自定义协议 `dsh-app://app`（Electron 从打包
	// 静态资源加载，不是 HTTP 源），桌面页发来的写请求 Origin 会被同源白名单判成"跨站"→403。默认全关，
	// 只有显式设置 DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1 才多认这一个固定来源；令牌照旧校验（桌面拿不到页面
	// meta 里的令牌 → 宿主进程经 DSH_DRYDOCK_DESKTOP_TOKEN 把桌面令牌同时交给本服务与桌面页面）。
	// 不设环境变量 = 与 1.0.x 完全一致（web 零回归）。只改调用点，判定逻辑在 lib/enginectl.mjs。
	const writeOriginPolicy = writeOriginPolicyFromEnv();
	// L11 ③：boot 与救援 /api/start 共用同一个单飞闸门
	const flight = createSingleFlight("open-boot:boot");
	// rc.2 P2-1：插件更新/卸载事务共用第二个单飞闸门（并发第二个请求 → 409，不再并行跑两条 pnpm）
	const pluginsFlight = createSingleFlight("open-boot:plugins");
	const rescueCtx = { profile: args.profile, dsh: args.dsh, cwd: args.cwd, port: args.port, flight };
	const sendJson = (res, code, body) => {
		// v1.1.0 M6（S6）：正式响应也要带 Access-Control-Allow-Origin + Vary（预检过了、正式响应没带
		// 浏览器照样拦）；只回显被允许的 Origin（由 handler 入口按同一套白名单算好），来源不允许时为空。
		// 1.0.3 起安全响应头统一走 applySecurityHeaders（CSP/XFO/nosniff），两者合并成一次 writeHead。
		res.writeHead(code, applySecurityHeaders(res, { "Content-Type": "application/json; charset=utf-8", ...(res.dshCorsHeaders || {}) }));
		res.end(JSON.stringify(body));
	};
	/** L11 ①②：写接口的 Origin + 令牌检查。返回 true 表示已拒绝并应答。 */
	const rejectWrite = (req, res) => {
		const failure = guardWriteRequest(req, { port: args.port, token, ...writeOriginPolicy });
		if (!failure) return false;
		sendJson(res, failure.status, { ok: false, code: failure.code, error: failure.message });
		return true;
	};
	const sendHtml = (res, html) => {
		res.writeHead(200, applySecurityHeaders(res, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }));
		res.end(html);
	};

	const server = createServer(async (req, res) => {
		// S4：先挂安全头（任何分支、含救援 API 自己的 writeHead 都继承）
		applySecurityHeaders(res);
		// S3：Host 校验放在**路由之前**——DNS 重绑定请求在这里就该被 421 挡掉
		if (!isAllowedHost(req.headers.host, args.port)) {
			sendJson(res, 421, { ok: false, code: 421, error: "Host 不被允许（仅接受回环地址）" });
			return;
		}
		const url = new URL(req.url, "http://127.0.0.1");
		const pathname = url.pathname;
		// v1.1.0 M6（S6，P0 收尾）：CORS 预检分支 —— 必须排在路由与 `guardWriteRequest` **之前**
		// （预检请求按 CORS 规范不带令牌；排在令牌校验之后会永远 401，正式请求根本发不出去）。
		// 真包证据：桌面把 dsh-app 注册为 corsEnabled:true，桌面页面（来源 dsh-app://app）带自定义头
		// X-DSH-PM-Token 跨源 fetch 本端口时浏览器必定先发 OPTIONS。这里来源被允许 → 204 + Allow-*
		// （Allow-Origin 回显被允许的那个 Origin，绝不 *）；来源不被允许 → 403 且不回任何 Allow 头。
		// 只新增这个分支，不改变 guardWriteRequest 的任何既有判定（POST/GET 与令牌逻辑原样）。
		const allowDesktopApp = writeOriginPolicy.allowDesktopApp;
		const corsHeaders = corsResponseHeaders(req, { port: args.port, allowDesktopApp });
		if (corsHeaders) res.dshCorsHeaders = corsHeaders; // sendJson 复用它给正式响应补 Allow-Origin + Vary
		const pre = corsPreflightResponse(req, { port: args.port, allowDesktopApp });
		if (pre) {
			res.writeHead(pre.status, pre.message ? { "Content-Type": "application/json; charset=utf-8", ...pre.headers } : { ...pre.headers });
			res.end(pre.message ? JSON.stringify({ ok: false, code: pre.status, error: pre.message }) : "");
			return;
		}
		if (pathname === "/") {
			sendHtml(res, bootPageHtml({ token, enginePort: ENGINE_PORT }));
			return;
		}
		// R7：3081 = 唯一网页入口，且**自身提供完整救援能力**。
		// 救援 API 复用 rescue-daemon 的 handleApi，挂在独立前缀 /rescue/api/* 下，
		// 因此 `/api/status` 的身份语义（app=dsh-open-boot）不受影响（launcherHealth 照旧可用）。
		if (pathname === "/rescue" || pathname === "/rescue/") {
			sendHtml(res, rescuePageHtml({
				apiPrefix: "/rescue", enginePort: ENGINE_PORT, entryUrl: `http://127.0.0.1:${args.port}/`, token
			}));
			return;
		}
		if (pathname === "/rescue/api" || pathname.startsWith("/rescue/api/")) {
			const sub = pathname.slice("/rescue".length) || "/api/status";
			if (req.method === "POST" && rejectWrite(req, res)) return;
			await handleRescueApi(sub, req.method, req, res, url, rescueCtx);
			return;
		}
		// 1.0.0-rc.1：启动器内置插件管理页 —— mod 全被禁用、引擎 UI 没有插件页可用时，
		// 这里是重新打开它们的唯一入口（写 profile 的 dsh.profile.bundles，与引擎同一开关）。
		if (pathname === "/plugins" || pathname === "/plugins/") {
			sendHtml(res, pluginsPageHtml({ token, enginePort: ENGINE_PORT, launcherPort: args.port, engineTheme: engineThemePreference(args.profile) }));
			return;
		}
		if (pathname === "/plugins/api/bundles" && req.method === "GET") {
			// S3 附带：已装插件清单不该裸奔给任意本地网页（DNS 重绑定后可读），GET 也过 Origin+令牌。
			// 页面侧 api() 对 GET 已经带 X-DSH-PM-Token（loadBundles 走 api()），不需要额外改动。
			if (rejectWrite(req, res)) return;
			sendJson(res, 200, listBundles(args.profile));
			return;
		}
		if (pathname === "/plugins/api/bundles" && req.method === "POST") {
			if (rejectWrite(req, res)) return;
			const body = await readJsonBody(req);
			if (body && body.timeout === true) { sendJson(res, 408, { ok: false, code: 408, error: "请求体读取超时（10s）：连接已断开。" }); return; }
			if (!body) { sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON（或超过 64KB）" }); return; }
			const enable = body.action === "enable";
			if (body.action !== "enable" && body.action !== "disable") {
				sendJson(res, 400, { ok: false, error: `action 必须是 "enable" 或 "disable"，收到 ${JSON.stringify(body.action ?? null)}` });
				return;
			}
			sendJson(res, 200, setBundleEnabled(args.profile, body.name, enable));
			return;
		}
		if (pathname === "/plugins/api/updates" && req.method === "GET") {
			// rc.2 P1-6：GET 也过令牌（能读到"该装什么版本"的完整清单，不该裸奔给任意本地网页）
			if (rejectWrite(req, res)) return;
			try { sendJson(res, 200, await checkUpdates(args)); }
			catch (error) { sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
			return;
		}
		if (pathname === "/plugins/api/update" && req.method === "POST") {
			if (rejectWrite(req, res)) return;
			const body = await readJsonBody(req);
			if (body && body.timeout === true) { sendJson(res, 408, { ok: false, code: 408, error: "请求体读取超时（10s）：连接已断开。" }); return; }
			if (!body) { sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON（或超过 64KB）" }); return; }
			if (typeof body.name !== "string" || !body.name.trim()) { sendJson(res, 400, { ok: false, error: "缺少 name 参数" }); return; }
			const enteredPkg = pluginsFlight.tryEnter(`update ${body.name.trim()}`);
			if (!enteredPkg.ok) {
				sendJson(res, 409, { ok: false, code: 409, busy: true, error: `已有更新/卸载事务在执行中（已进行 ${Math.round(enteredPkg.waited / 1000)}s），本次请求被拒（409）。` });
				return;
			}
			try {
				sendJson(res, 200, await updatePackage(args, body.name.trim()));
			} catch (error) {
				sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			} finally {
				pluginsFlight.leave(enteredPkg.entry);
			}
			return;
		}
		if (pathname === "/plugins/api/uninstall" && req.method === "POST") {
			if (rejectWrite(req, res)) return;
			const body = await readJsonBody(req);
			if (body && body.timeout === true) { sendJson(res, 408, { ok: false, code: 408, error: "请求体读取超时（10s）：连接已断开。" }); return; }
			if (!body) { sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON（或超过 64KB）" }); return; }
			if (typeof body.name !== "string" || !body.name.trim()) { sendJson(res, 400, { ok: false, error: "缺少 name 参数" }); return; }
			const enteredPkg = pluginsFlight.tryEnter(`uninstall ${body.name.trim()}`);
			if (!enteredPkg.ok) {
				sendJson(res, 409, { ok: false, code: 409, busy: true, error: `已有更新/卸载事务在执行中（已进行 ${Math.round(enteredPkg.waited / 1000)}s），本次请求被拒（409）。` });
				return;
			}
			try {
				sendJson(res, 200, await uninstallPackageTransactional(args, body.name.trim()));
			} catch (error) {
				sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			} finally {
				pluginsFlight.leave(enteredPkg.entry);
			}
			return;
		}
		if (pathname === "/plugins/api/health" && req.method === "GET") {
			// rc.2 P1-6：体检结果含日志摘录与 bundle 清单，同样过令牌；report 本身有 30s 缓存
			if (rejectWrite(req, res)) return;
			try { sendJson(res, 200, healthReport(args)); }
			catch (error) { sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
			return;
		}
		if (pathname === "/plugins/api/engine/restart" && req.method === "POST") {
			if (rejectWrite(req, res)) return;
			const enteredRestart = flight.tryEnter("open-boot:restart");
			if (!enteredRestart.ok) {
				sendJson(res, 409, { ok: false, code: 409, busy: true, error: `已有启动/重启流程在执行中（已进行 ${Math.round(enteredRestart.waited / 1000)}s），本次请求被拒。` });
				return;
			}
			try {
				sendJson(res, 200, await restartEngine(args, flight, enteredRestart));
			} catch (error) {
				sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		}
		if (pathname === "/api/launcher/stop" && req.method === "POST") {
			// 1.0.0-rc.1 用户可控启停：优雅退出本启动器并清理 pid 文件（引擎不受影响）。
			if (rejectWrite(req, res)) return;
			sendJson(res, 200, { ok: true, pid: process.pid, message: `启动器（pid ${process.pid}）将在 1s 内退出；pid 文件已清理。引擎与浏览器本页不受影响，重新打开 ${args.port} 会重新拉起启动器。` });
			setTimeout(() => {
				// pid 文件可能已被新实例覆写：只有内容仍是本进程时才清理，避免误删别人的归属记录
				try {
					const raw = readFileSync(pidPathOf(args), "utf8").trim();
					if (JSON.parse(raw).pid === process.pid) unlinkSync(pidPathOf(args));
				} catch { /* 已不存在或不可读：无需清理 */ }
				try { supLogRaw(args, `[${stamp()}] [open-boot] 收到 /api/launcher/stop，优雅退出。`); } catch { /* ignore */ }
				process.exit(0);
			}, 1000);
			return;
		}
		if (pathname === "/api/boot" && req.method === "POST") {
			if (rejectWrite(req, res)) return;
			const entered = flight.tryEnter("open-boot:/api/boot");
			if (!entered.ok) {
				// L11 ③：并发第二个写请求 → 409（不会重复拉起引擎/重复弹窗）
				sendJson(res, 409, {
					ok: false, code: 409, busy: true,
					error: `已有启动流程在执行中（已进行 ${Math.round(entered.waited / 1000)}s）：本次请求被拒，不会重复拉起引擎。` +
						`请等待当前流程结束后重试。`
				});
				return;
			}
			try {
				const result = await boot(args);
				sendJson(res, 200, result);
			} catch (error) {
				sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			} finally {
				flight.leave(entered.entry);
			}
			return;
		}
		if (pathname === "/api/status") {
			// app/identity 字段供 enginectl.launcherHealth 做 HTTP 握手身份校验（读取类接口不加防护）
			const engine = await engineHealth(ENGINE_PORT);
			sendJson(res, 200, {
				app: LAUNCHER_APP, identity: LAUNCHER_APP, pid: process.pid, port: args.port,
				profile: args.profile, startedAt, version: readVersion(),
				engineUp: engine.ok, enginePort: ENGINE_PORT,
				engineMarker: engine.marker || null, engineHttpStatus: engine.status ?? null,
				window: args.window,
				pluginsPage: "/plugins", pluginsApiPrefix: "/plugins/api",
				dshLauncherCmd: launcherCmdPath,
				rescuePage: "/rescue", rescueApiPrefix: "/rescue/api"
			});
			return;
		}
		res.writeHead(404, applySecurityHeaders(res, { "Content-Type": "text/plain; charset=utf-8" }));
		res.end("not found");
	});

	server.on("error", async (error) => {
		if (error.code === "EADDRINUSE") {
			// 审计③ L4/L12：不再静默 +1 漂移端口（那会让浏览器主页指向别人的服务）。
			// 注意用二次确认：负载高时单次 1.5s 握手会超时，否则会把"自己的实例"误报成别人的进程。
			const mine = await launcherHealthWithRetry(args.port);
			if (mine.ok) {
				console.error(`[open-boot] 端口 ${args.port} 上已有${mine.identity}在跑（pid ${mine.json?.pid ?? "?"}），本进程退出。`);
				process.exit(0);
			}
			const owner = portOwner(args.port);
			const message = `[open-boot] ✘ 端口 ${args.port} 被${owner ? ` pid ${owner}` : "其他进程"}占用，且它不是本启动器。` +
				`为避免"假健康"，本进程不漂移到其他端口、也不会结束该进程（exit 1）。请结束该进程，或 --port 指定其他端口并同步修改浏览器主页。`;
			console.error(message);
			supLogRaw(args, `[${stamp()}] ${message}`);
			process.exit(1);
		}
		console.error("open-boot error:", error.message);
		process.exit(1);
	});

	server.listen(args.port, "127.0.0.1", () => {
		console.log(`[open-boot] 就绪：http://127.0.0.1:${args.port}/（浏览器主页设为此地址即可"打开即自检启动"）`);
		console.log(`[open-boot] profile: ${args.profile}；引擎端口: ${ENGINE_PORT}；拉起引擎时${args.window ? "弹窗显示进度" : "静默启动"}；cwd: ${process.cwd()}`);
		console.log(`[open-boot] 救援能力（唯一网页入口）：http://127.0.0.1:${args.port}/rescue（/rescue/api/*：verify|fix|start|stop|status）；` +
			`rescue-daemon 备份入口默认 ${RESCUE_DAEMON_PORT}（不再抢占 ${args.port}）`);
		console.log(`[open-boot] 写接口防护：/api/boot 与 /rescue/api/* 的 POST 需同源 Origin + 一次性令牌（页面自动带上，不写日志/不落盘）；` +
			`入口 Host 仅接受回环地址 127.0.0.1/localhost/[::1]:${args.port}（其余 421）`);
	});
	return server;
}

// ---------------------------------------------------------------- 入口
async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help) { console.log(HELP_TEXT); return 0; }
	// 用法错误（如 --profile 缺值/被开关占用）：**在任何动作之前**返回 —— 不装崩溃日志、不 build 目录、
	// 不写日志、不动注册表/pid/进程；用法打 stderr，退出码归入既有的 1=出错。
	if (args.usageError) {
		console.error(`[open-boot] ✘ 用法错误：${args.usageError}`);
		console.error(HELP_TEXT);
		return 1;
	}
	// 未识别 token：全局子命令直接用法错误（t20），其余模式保持"警告并忽略"
	const unknownPolicy = unknownTokenPolicy(args);
	if (unknownPolicy.message) {
		if (unknownPolicy.reject) {
			console.error(`[open-boot] ✘ 用法错误：${unknownPolicy.message}`);
			console.error(HELP_TEXT);
			return 1;
		}
		console.error(`[open-boot] ⚠ ${unknownPolicy.message}`);
	}
	// 只读查询（--status/--autostart-status）不装崩溃日志（那会在退出时写 supervisor 日志）；
	// --uninstall 是短命令，也不需要崩溃落盘（否则清完 pid 又会新写一行日志）。
	// 长命/启动类模式才装崩溃日志并切到稳定 cwd（审计③ L2/L3）。
	const lightRun = args.status || args.autostart === "status" || args.uninstall;
	if (!lightRun) {
		installCrashLogging(args);
		chdirStable(args.cwd);
	}

	// 1.1.0 首启环境探测：装完第一次启动就把宿主形态 + 证据写进 `<DSH_HOME>/.drydock/host-profile.json`。
	// 只做一次（有新鲜缓存就跳过）；**探测/写盘失败绝不阻塞启动** —— 引擎起不来的机器上更要把启动页拉起来。
	// 想彻底关掉：`DSH_DRYDOCK_NO_HOST_PROBE=1`（测试与纯净环境用）。
	if (!lightRun && process.env.DSH_DRYDOCK_NO_HOST_PROBE !== "1") {
		try {
			const probed = ensureHostProfile();
			if (probed.firstLaunch) {
				const where = probed.write?.ok === false ? `（画像写入失败：${probed.write.error}）` : "";
				console.log(`[open-boot] 首启环境探测：${probed.profile.form} · ${String(probed.profile.reason).slice(0, 80)}${where}`);
			}
		} catch (error) {
			console.log(`[open-boot] 环境探测跳过（不影响启动）：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (args.uninstall) { const r = await uninstallLauncher(args); console.log(r.message); return r.exitCode ?? (r.ok ? 0 : 1); }
	if (args.autostart === "install") { const r = installAutostart(args); console.log(r.message); return r.ok ? 0 : 1; }
	if (args.autostart === "uninstall") { const r = uninstallAutostart(args); console.log(r.message); return r.ok ? 0 : 1; }
	if (args.autostart === "status") { const r = await autostartStatus(args); console.log(r.message); return r.ok ? 0 : 1; }
	if (args.status) { const r = await reportStatus(args); console.log(r.message); return r.ok ? 0 : 1; }
	if (args.supervise) { mkdirSync(args.profile, { recursive: true }); ensureLauncherCmd(args); return await supervise(args); }
	if (args.ensure) {
		mkdirSync(args.profile, { recursive: true });
		const result = await ensureServer(args);
		if (result.message) console.log(`[open-boot] ${result.message}`);
		return result.ok ? 0 : 1;
	}
	startServer(args);
	return null; // 常驻：不退出
}

/** 只在"直接运行本文件"时执行入口（被 import 时不执行，便于测试）。 */
function isDirectRun() {
	if (process.env.DSH_LAUNCHER_IMPORT_ONLY === "1") return false;
	const entry = process.argv[1];
	// argv[1] 缺失（`node -e "import(...)"` / `--input-type=module -e`）说明不是"运行脚本"：
	// 此时若判成直接运行，会在 import 时就地启动服务（t9 实测会去 bind 3081）。→ 一律不执行入口。
	if (!entry) return false;
	const norm = (p) => {
		try { return realpathSync(p).replace(/\\/g, "/").toLowerCase(); }
		catch { try { return resolve(p).replace(/\\/g, "/").toLowerCase(); } catch { return p; } }
	};
	return norm(entry) === norm(SELF);
}

if (isDirectRun()) {
	const code = await main();
	if (code !== null) process.exit(code);
}

export {
	HELP_TEXT, autostartStatus, bootPageHtml, buildShimLines, healthLogPath, installAutostart, installCrashLogging,
	main, parseArgs, reportStatus, startServer, uninstallAutostart, writeShim,
	// rc.2 测试面：单测直接驱动这些函数（不经过 HTTP）
	CORE_BUNDLES, MANAGER_SELF_NAME, PKG_NAME_RE, runPnpm, writeFileAtomic, engineBusyGate,
	uninstallPackageTransactional, updatePackage, checkUpdates, healthReport, restartEngine, ensureLauncherCmd,
	// 1.0.3 任务 C 测试面：Host 校验 / 安全响应头 / 有界缓冲 / updates 缓存
	isAllowedHost, SECURITY_HEADERS, PNPM_OUTPUT_CAP, createBoundedBuffer, lockfileStamp, resetUpdatesCacheForTests,
	// U1 测试面：兜底页 HTML 静态断言（test-ux.mjs）直接检查页面结构，不用起浏览器
	pluginsPageHtml
};
