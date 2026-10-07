#!/usr/bin/env node
/**
 * open-boot.mjs — 浏览器访问即触发自检启动（网页启动器 / 3081 常驻入口）。
 *
 * 在 3081 端口提供常驻网页入口：打开 http://127.0.0.1:3081/ →
 * 自动 verify → 有问题自动 fix（隔离坏 bundle）→ 拉起 `dsh web` → 跳转 3080。
 *
 * 设计取舍：
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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createLockServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProfile, fixProfile, isolateFailedEntries } from "../lib/preflight.mjs";
import { handleApi as handleRescueApi, rescuePageHtml } from "./rescue-daemon.mjs";
import {
	ENGINE_PORT, LAUNCHER_APP, chdirStable, createSingleFlight, engineHealth, guardWriteRequest, isAlive,
	launcherHealth, looksLikeProfileDir, newApiToken, portOwner, portOwnerProbe, probe, processImage,
	processImageProbe, readPidInfo, resolveEngineCwd, startEngineWithQuarantine,
	validateCliValue, validateIntegerValue, validatePortValue, waitForEngine
} from "../lib/enginectl.mjs";

const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");
const SELF = fileURLToPath(import.meta.url);
const AUTOSTART_NAME = "DSHWebFront";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
/** 自启注册表值前缀：本工具写过的一律归它管（含历史遗留 `DSHWebRescue`，审计③ R13）。 */
const RUN_VALUE_PREFIX = /^DSHWeb/i;
const SUP_LOG = "open-boot-supervisor.log";
/** P1-5 健康留痕：`--status` 每次追加一行，保留最近 7 天 / 最多 1000 行。 */
const HEALTH_LOG = "health.log";
const HEALTH_MAX_LINES = 1000;
const HEALTH_MAX_AGE_DAYS = 7;
/** R7 端口分工：3081 = 本启动器（唯一网页入口），3082 = rescue-daemon（独立备份入口）。 */
const ENTRY_URL = "http://127.0.0.1:3081/";
const RESCUE_DAEMON_PORT = 3082;

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
	const args = {
		profile: PROFILE_DEFAULT, port: 3081, dsh: "dsh", cwd: null,
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

const HELP_TEXT = `浏览器启动器 / 3081 常驻入口（dsh-plugin-manager-pro）

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
 */
function spawnBootWindow(args) {
	const bootScript = join(dirname(SELF), "dsh-boot.mjs");
	if (!existsSync(bootScript)) return { ok: false, message: "缺少 bin/dsh-boot.mjs" };
	// 窗口进程的 cwd 用稳定目录（审计③ L2）：不要把 cwd 留在本包/profile 目录里，
	// 否则引擎会继承一个"锁住包目录"的工作目录，pnpm 更新/卸载会 EPERM。
	const workDir = resolveEngineCwd(args.cwd);
	const bootArgs = [bootScript, "--profile", args.profile, "--dsh", args.dsh, "--wait-ms", String(args.waitMs), "--pause"];
	try {
		if (process.platform === "win32") {
			// `cmd /c start "" ...` 是 Windows 上唯一可靠的「新建可见控制台」方式。
			// 注意不要用隐藏 PowerShell（部分杀软会直接拦截并删除脚本）。
			const child = spawn("cmd", ["/c", "start", "", "/D", workDir, process.execPath, ...bootArgs], {
				detached: true, stdio: "ignore", windowsHide: false
			});
			child.unref();
			return { ok: true, message: `已弹出启动窗口（cmd start，工作目录 ${workDir}）` };
		}
		if (process.platform === "darwin") {
			const line = [process.execPath, ...bootArgs].map((part) => `'${String(part).replace(/'/g, "'\\''")}'`).join(" ");
			const child = spawn("open", ["-a", "Terminal", line], { detached: true, stdio: "ignore", cwd: workDir });
			child.unref();
			return { ok: true, message: "已弹出启动窗口（Terminal.app）" };
		}
		// Linux：挑一个存在的终端模拟器
		for (const term of ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"]) {
			if (spawnSync("sh", ["-c", `command -v ${term}`], { stdio: "ignore" }).status !== 0) continue;
			const child = spawn(term, ["-e", process.execPath, ...bootArgs], { detached: true, stdio: "ignore", cwd: workDir });
			child.unref();
			return { ok: true, message: `已弹出启动窗口（${term}）` };
		}
		return { ok: false, message: "未找到可用的终端模拟器" };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
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
		return { ok: true, alreadyRunning: true, healthy: true, message: `引擎已在 ${ENGINE_PORT} 运行（HTTP 握手正常），直接打开主界面。` };
	}
	if (await probe(ENGINE_PORT)) {
		const owner = portOwner(ENGINE_PORT);
		return {
			ok: false, alreadyRunning: false, occupied: true, portOwner: owner, verifyOk: null, issues: [],
			logPath: engineLogPathOf(args),
			message: `端口 ${ENGINE_PORT} 被${owner ? ` pid ${owner}` : "其他进程"}占用，但它不是 dsh 引擎（HTTP 握手失败）：拒绝跳转到坏页面，也不会重复启动。请先用任务管理器确认并结束该进程。`
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
		windowInfo = spawnBootWindow(args);
		onLog(windowInfo.ok ? windowInfo.message : `弹窗失败（${windowInfo.message}），改为静默启动`);
	}

	if (!args.window || !windowInfo.ok) {
		const start = await startEngineWithQuarantine({ profileDir: args.profile, dshCmd: args.dsh, isolateFailedEntries, waitMs: args.waitMs, cwd: args.cwd });
		return {
			ok: start.ok, alreadyRunning: false, verifyOk: verify.ok, issues: verify.issues, fixed,
			window: windowInfo, quarantined: start.quarantined, quarantineMessage: start.quarantineMessage,
			start, logPath: start.log || engineLogPathOf(args),
			message: start.message
		};
	}

	// 窗口模式：等窗口里的启动序列把引擎拉起来（同样用 HTTP 健康判定）
	const up = await waitForEngine(ENGINE_PORT, args.waitMs, 300, engineHealth);
	return {
		ok: up, alreadyRunning: false, verifyOk: verify.ok, issues: verify.issues, fixed,
		window: windowInfo, quarantined: [], logPath: engineLogPathOf(args),
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
	const lockPort = args.port + 1000;
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
					? `3081 正常（${result.identity}${result.pid ? ` pid ${result.pid}` : ""}）`
					: result.state === "foreign" ? `⚠ ${result.message}`
						: result.state === "spawned" ? "已拉起启动器"
							: result.state === "timeout" ? `⚠ 启动器未就绪：${result.message || ""}`
								: `⚠ ${result.message || result.state}`;
				supLog(args, `状态变化：${detail}`);
				lastState = stateKey;
				lastHeartbeatAt = Date.now();
			} else if (Date.now() - lastHeartbeatAt >= heartbeatMs) {
				const engine = await engineHealth(ENGINE_PORT);
				supLog(args, `心跳：3081 ${result.ok ? "正常" : "异常"}（${result.identity || result.state}）；引擎 ${ENGINE_PORT} ${engine.ok ? "正常" : "未就绪"}；pid ${process.pid}`);
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
	const lockPort = args.port + 1000;
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

	const lockOwner = portOwner(lockPort);
	lines.push(`守护：${lockOwner ? `pid ${lockOwner} 持有锁端口 ${lockPort}（守护在跑）` : `无进程持有锁端口 ${lockPort}（守护未运行，或被外部结束过；见下方日志）`}`);

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
		"script = base & \"\\node_modules\\dsh-plugin-manager-pro\\bin\\open-boot.mjs\"",
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
	const body = ["' Generated by dsh-plugin-manager-pro. Safe to delete.", ...runLines].join("\r\n") + "\r\n";
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
 * R13：删除 Run 键下**所有** `DSHWeb*` 值（含历史遗留 `DSHWebRescue`），返回删掉的键名。
 * 幂等：没有匹配项时返回空数组且 ok=true；注册表**读不到**时不谎报"已清干净"，而是明确警告
 * （受限会话/安全策略下 reg.exe 可能不可用 —— 那种情况必须人工核对）。
 */
export function removeDsWebRunValues() {
	if (process.platform !== "win32") {
		return { ok: true, skipped: true, readable: false, removed: [], failed: [], message: "非 Windows：跳过注册表清理" };
	}
	const values = listRunValues();
	if (values === null) {
		return {
			ok: true, skipped: false, readable: false, removed: [], failed: [],
			message: `⚠ 无法读取注册表 ${RUN_KEY}（reg query 失败或被安全策略拦截）：DSHWeb* 自启残留**未确认**，请人工用 reg query 核对`
		};
	}
	const targets = values.filter((value) => RUN_VALUE_PREFIX.test(value.name));
	const removed = [];
	const failed = [];
	for (const value of targets) {
		const out = spawnSync("reg", ["delete", RUN_KEY, "/v", value.name, "/f"], { windowsHide: true, encoding: "utf8", timeout: 10000 });
		if (out.status === 0) removed.push(value.name);
		else failed.push({ name: value.name, message: (out.stderr || out.stdout || (out.error ? out.error.message : "")).trim() });
	}
	return {
		ok: failed.length === 0, skipped: false, readable: true, removed, failed,
		message: removed.length > 0 ? `已删除注册表自启值：${removed.join(", ")}` : "未发现 DSHWeb* 自启值（无需删除）"
	};
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
	const lockPort = args.port + 1000;
	const lockOwner = portOwner(lockPort);
	lines.push(`  守护进程：${lockOwner ? `✔ pid ${lockOwner} 持有锁端口 ${lockPort}` : `✘ 无进程持有锁端口 ${lockPort}（守护未运行；下次登录会由自启拉起）`}`);
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
			`  桌面快捷方式可指向：wscript //nologo "${uiShim}"（确保 3081 后打开浏览器）\n` +
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
	const reg = removeDsWebRunValues();
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
	const lockPort = Number(args.port) + 1000;
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
			lockPortOwner: portOwner(lockPort)
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
		const lockProbe = ownerOf(lockPort) ?? { ok: true, pid: null, reason: null };
		const portProbe = ownerOf(infoPort) ?? { ok: true, pid: null, reason: null };
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
	lines.push(`卸载启动器：profile ${args.profile}；启动器端口 ${args.port}；锁端口 ${args.port + 1000}`);
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

	// 2) 删 HKCU\...\Run 下所有 DSHWeb* 值
	const reg = removeDsWebRunValues();
	result.removedValues = reg.removed;
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
function bootPageHtml({ token = "__DSH_PM_TOKEN__", enginePort = ENGINE_PORT, entryUrl = ENTRY_URL } = {}) {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 启动器</title>
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
<h1>🚀 DSH 启动器</h1>
<div class="sub">正在执行 自检 → 修复 → 启动，完成后自动打开主界面…</div>
<div class="spinner" id="spin"></div>
<pre id="out"></pre>
<div class="sub" style="margin:16px 0 0">引擎起不来？打开 <a href="/rescue">救援中心</a>（检查 / 修复 / 启动 / 停止 / 状态）</div>
<script>
const out = document.getElementById("out");
const TOKEN = (document.querySelector('meta[name="dsh-pm-token"]') || {}).content || "";
function log(line, cls){ out.innerHTML += (cls?'<span class="'+cls+'">':'') + String(line).replace(/</g,'&lt;') + (cls?'</span>':'') + "\\n"; }
(async () => {
	try {
		const r = await fetch("/api/boot", { method: "POST", headers: { "X-DSH-PM-Token": TOKEN } }).then((x) => x.json());
		if (r.ok && r.alreadyRunning) {
			log("✓ " + r.message, "ok");
			location.href = "http://127.0.0.1:${enginePort}/";
			return;
		}
		if (r.code === 409) { log("⚠ " + (r.error || "已有启动流程在执行中"), "warn"); return; }
		if (r.verifyOk === false) log("自检：⚠ 发现 " + (r.issues||[]).length + " 个问题", "warn");
		else if (r.verifyOk === true) log("自检：✓ 配置正常", "ok");
		if (r.fixed) log("修复：" + (r.fixed.message || "完成"), "ok");
		if (r.window && r.window.ok) log("⧉ " + r.window.message + "（窗口里可看到完整进度，结束时按任意键关闭）", "warn");
		if (r.ok) { log("✓ " + (r.message || "引擎已启动"), "ok"); setTimeout(() => location.href = "http://127.0.0.1:${enginePort}/", 600); }
		else if (r.quarantined && r.quarantined.length) { log("⚠ 运行期失败条目已自动隔离：" + r.quarantined.join(", "), "bad"); log("✓ " + (r.message || "重试成功"), "ok"); setTimeout(() => location.href = "http://127.0.0.1:${enginePort}/", 600); }
		else {
			log("✗ " + (r.message || JSON.stringify(r)), "bad");
			if (r.logPath) log("日志：" + r.logPath, "warn");
			log("可运行 node bin/open-boot.mjs --status 查看启动器/守护/引擎状态，或打开 " + location.origin + "/rescue 救援中心", "warn");
			document.getElementById("spin").style.display = "none";
		}
	} catch (e) {
		log("✗ 请求失败：" + e.message, "bad");
		document.getElementById("spin").style.display = "none";
	}
})();
</script>
</div></body></html>`;
}

function startServer(args) {
	const startedAt = new Date().toISOString();
	// L11 ②：一次性令牌（每次启动随机生成）——只注入页面 meta 与请求头，**不写日志、不落 profile 文件**
	const token = newApiToken();
	// L11 ③：boot 与救援 /api/start 共用同一个单飞闸门
	const flight = createSingleFlight("open-boot:boot");
	const rescueCtx = { profile: args.profile, dsh: args.dsh, cwd: args.cwd, port: args.port, flight };
	const sendJson = (res, code, body) => {
		res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(body));
	};
	/** L11 ①②：写接口的 Origin + 令牌检查。返回 true 表示已拒绝并应答。 */
	const rejectWrite = (req, res) => {
		const failure = guardWriteRequest(req, { port: args.port, token });
		if (!failure) return false;
		sendJson(res, failure.status, { ok: false, code: failure.code, error: failure.message });
		return true;
	};
	const sendHtml = (res, html) => {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
		res.end(html);
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const pathname = url.pathname;
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
				rescuePage: "/rescue", rescueApiPrefix: "/rescue/api"
			});
			return;
		}
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
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
		console.log(`[open-boot] 写接口防护：/api/boot 与 /rescue/api/* 的 POST 需同源 Origin + 一次性令牌（页面自动带上，不写日志/不落盘）`);
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

	if (args.uninstall) { const r = await uninstallLauncher(args); console.log(r.message); return r.exitCode ?? (r.ok ? 0 : 1); }
	if (args.autostart === "install") { const r = installAutostart(args); console.log(r.message); return r.ok ? 0 : 1; }
	if (args.autostart === "uninstall") { const r = uninstallAutostart(args); console.log(r.message); return r.ok ? 0 : 1; }
	if (args.autostart === "status") { const r = await autostartStatus(args); console.log(r.message); return r.ok ? 0 : 1; }
	if (args.status) { const r = await reportStatus(args); console.log(r.message); return r.ok ? 0 : 1; }
	if (args.supervise) { mkdirSync(args.profile, { recursive: true }); return await supervise(args); }
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
	main, parseArgs, reportStatus, startServer, uninstallAutostart, writeShim
};
