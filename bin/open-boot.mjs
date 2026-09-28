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
 *   node bin/open-boot.mjs --status         打印启动器/守护/引擎状态（退出码 0=启动器健康）
 *   node bin/open-boot.mjs --install-autostart | --uninstall-autostart | --autostart-status
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
import {
	ENGINE_PORT, LAUNCHER_APP, chdirStable, engineHealth, isAlive, launcherHealth,
	portOwner, probe, processImage, readPidInfo, resolveEngineCwd,
	startEngineWithQuarantine, waitForEngine
} from "../lib/enginectl.mjs";

const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");
const SELF = fileURLToPath(import.meta.url);
const AUTOSTART_NAME = "DSHWebFront";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const SUP_LOG = "open-boot-supervisor.log";

function readVersion() {
	try { return JSON.parse(readFileSync(join(dirname(SELF), "..", "package.json"), "utf8")).version || null; }
	catch { return null; }
}

function parseArgs(argv) {
	const args = {
		profile: PROFILE_DEFAULT, port: 3081, dsh: "dsh", cwd: null,
		supervise: false, ensure: false, status: false, help: false,
		interval: 60, heartbeatMin: 10, quiet: false, window: true, waitMs: 90000,
		autostart: null, unknown: []
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--profile" && argv[i + 1]) { args.profile = resolve(argv[++i]); }
		else if (arg === "--port" && argv[i + 1]) { args.port = Number(argv[++i]) || 3081; }
		else if (arg === "--dsh" && argv[i + 1]) { args.dsh = argv[++i]; }
		else if (arg === "--cwd" && argv[i + 1]) { args.cwd = resolve(argv[++i]); }
		else if (arg === "--interval" && argv[i + 1]) { args.interval = Math.max(5, Number(argv[++i]) || 60); }
		// 注意：这里只能自增一次（历史 bug：多了一个 i++，会把紧跟其后的标志位吞掉，见审计③ L6）
		else if (arg === "--wait-ms" && argv[i + 1]) { args.waitMs = Number(argv[++i]) || 90000; }
		else if (arg === "--heartbeat-min" && argv[i + 1]) { args.heartbeatMin = Math.max(1, Number(argv[++i]) || 10); }
		else if (arg === "--supervise") { args.supervise = true; }
		else if (arg === "--ensure") { args.ensure = true; }
		else if (arg === "--status") { args.status = true; }
		else if (arg === "--quiet") { args.quiet = true; }
		else if (arg === "--no-window") { args.window = false; }
		else if (arg === "--install-autostart") { args.autostart = "install"; }
		else if (arg === "--uninstall-autostart") { args.autostart = "uninstall"; }
		else if (arg === "--autostart-status") { args.autostart = "status"; }
		else if (arg === "--help" || arg === "-h") { args.help = true; }
		else if (arg === "--front") { /* v0.7.1 起已移除 3080 接管模式，忽略该参数 */ }
		else { args.unknown.push(arg); }
	}
	return args;
}

const HELP_TEXT = `浏览器启动器 / 3081 常驻入口（dsh-plugin-manager-pro）

用法：
  node bin/open-boot.mjs [选项]                 启动 3081 网页入口（前台）
  node bin/open-boot.mjs --supervise            常驻守护：静默确保 3081 有服务（推荐自启）
  node bin/open-boot.mjs --ensure               一次性确保 3081 有服务（桌面快捷方式用）
  node bin/open-boot.mjs --status               打印启动器/守护/引擎状态（退出码 0=启动器健康）
  node bin/open-boot.mjs --install-autostart    写开机自启（Windows：HKCU Run + 包装 .vbs）
  node bin/open-boot.mjs --uninstall-autostart  移除开机自启
  node bin/open-boot.mjs --autostart-status     查看自启状态（含包装脚本/守护存活校验）
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

/** 读一个 JSON 文件（不存在/坏格式返回 null）。 */
function readJsonFile(path) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function modeOf(args) {
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
	const launcher = await launcherHealth(args.port);
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
	const tail = readSupTail(args, 5);
	if (tail) lines.push(`日志尾部：\n${tail}`);
	return { ok: launcher.ok, message: lines.join("\n") };
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
	const launcher = await launcherHealth(args.port);
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
	const out = spawnSync("reg", ["add", RUN_KEY, "/v", AUTOSTART_NAME, "/t", "REG_SZ", "/d", value, "/f"], { windowsHide: true, encoding: "utf8" });
	if (out.status !== 0) return { ok: false, message: `写入注册表失败：${(out.stderr || out.stdout || "").trim()}` };
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
	if (process.platform !== "win32") return { ok: false, message: "开机自启管理目前仅支持 Windows。" };
	const shim = autostartShimPath(args);
	const out = spawnSync("reg", ["delete", RUN_KEY, "/v", AUTOSTART_NAME, "/f"], { windowsHide: true, encoding: "utf8" });
	for (const file of [shim, uiShimPath(args)]) {
		try { if (existsSync(file)) unlinkSync(file); } catch { /* 删不掉不影响主流程 */ }
	}
	return { ok: out.status === 0, message: out.status === 0 ? `开机自启已移除：${AUTOSTART_NAME}（常驻守护进程会在注销/重启后消失）` : "开机自启未安装（无需移除）" };
}

// ---------------------------------------------------------------- 网页入口
const PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 启动器</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:40px 24px;display:flex;justify-content:center}
.card{max-width:560px;width:100%;background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:24px;text-align:center}
h1{font-size:20px;color:#fff;margin:0 0 6px}.sub{color:#8b93a3;font-size:13px;margin-bottom:22px}
.spinner{width:34px;height:34px;border:3px solid #2a2e38;border-top-color:#60a5fa;border-radius:50%;margin:0 auto 16px;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
pre{background:#0b0d11;border:1px solid #2a2e38;border-radius:8px;padding:12px;font-size:12px;text-align:left;white-space:pre-wrap;max-height:280px;overflow:auto}
.ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}
</style></head><body><div class="card">
<h1>🚀 DSH 启动器</h1>
<div class="sub">正在执行 自检 → 修复 → 启动，完成后自动打开主界面…</div>
<div class="spinner" id="spin"></div>
<pre id="out"></pre>
<script>
const out = document.getElementById("out");
function log(line, cls){ out.innerHTML += (cls?'<span class="'+cls+'">':'') + String(line).replace(/</g,'&lt;') + (cls?'</span>':'') + "\\n"; }
(async () => {
	try {
		const r = await fetch("/api/boot", { method: "POST" }).then((x) => x.json());
		if (r.ok && r.alreadyRunning) {
			log("✓ " + r.message, "ok");
			location.href = "http://127.0.0.1:${ENGINE_PORT}/";
			return;
		}
		if (r.verifyOk === false) log("自检：⚠ 发现 " + (r.issues||[]).length + " 个问题", "warn");
		else if (r.verifyOk === true) log("自检：✓ 配置正常", "ok");
		if (r.fixed) log("修复：" + (r.fixed.message || "完成"), "ok");
		if (r.window && r.window.ok) log("⧉ " + r.window.message + "（窗口里可看到完整进度，结束时按任意键关闭）", "warn");
		if (r.ok) { log("✓ " + (r.message || "引擎已启动"), "ok"); setTimeout(() => location.href = "http://127.0.0.1:${ENGINE_PORT}/", 600); }
		else if (r.quarantined && r.quarantined.length) { log("⚠ 运行期失败条目已自动隔离：" + r.quarantined.join(", "), "bad"); log("✓ " + (r.message || "重试成功"), "ok"); setTimeout(() => location.href = "http://127.0.0.1:${ENGINE_PORT}/", 600); }
		else {
			log("✗ " + (r.message || JSON.stringify(r)), "bad");
			if (r.logPath) log("日志：" + r.logPath, "warn");
			log("可运行 node bin/open-boot.mjs --status 查看启动器/守护/引擎状态", "warn");
			document.getElementById("spin").style.display = "none";
		}
	} catch (e) {
		log("✗ 请求失败：" + e.message, "bad");
		document.getElementById("spin").style.display = "none";
	}
})();
</script>
</div></body></html>`;

function startServer(args) {
	const startedAt = new Date().toISOString();
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		if (url.pathname === "/" || url.pathname === "/rescue") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(PAGE_HTML);
			return;
		}
		if (url.pathname === "/api/boot" && req.method === "POST") {
			try {
				const result = await boot(args);
				res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(result));
			} catch (error) {
				res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
			}
			return;
		}
		if (url.pathname === "/api/status") {
			// app/identity 字段供 enginectl.launcherHealth 做 HTTP 握手身份校验
			const engine = await engineHealth(ENGINE_PORT);
			res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({
				app: LAUNCHER_APP, identity: LAUNCHER_APP, pid: process.pid, port: args.port,
				profile: args.profile, startedAt, version: readVersion(),
				engineUp: engine.ok, enginePort: ENGINE_PORT,
				engineMarker: engine.marker || null, engineHttpStatus: engine.status ?? null,
				window: args.window
			}));
			return;
		}
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("not found");
	});

	server.on("error", async (error) => {
		if (error.code === "EADDRINUSE") {
			// 审计③ L4/L12：不再静默 +1 漂移端口（那会让浏览器主页指向别人的服务）。
			const mine = await launcherHealth(args.port);
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
	});
	return server;
}

// ---------------------------------------------------------------- 入口
async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help) { console.log(HELP_TEXT); return 0; }
	if (args.unknown.length > 0) {
		console.error(`[open-boot] ⚠ 无法识别的参数（已忽略）：${args.unknown.join(" ")}（用 --help 查看用法）`);
	}
	// 只读查询（--status/--autostart-status）不改 profile、不写日志；
	// 长命/启动类模式才装崩溃日志并切到稳定 cwd（审计③ L2/L3）。
	const queryOnly = args.status || args.autostart === "status";
	if (!queryOnly) {
		installCrashLogging(args);
		chdirStable(args.cwd);
	}

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

export { HELP_TEXT, autostartStatus, buildShimLines, installAutostart, installCrashLogging, main, parseArgs, reportStatus, uninstallAutostart, writeShim };
