/**
 * enginectl.mjs — 引擎生命周期控制（共享逻辑）。
 * 被 bin/rescue-daemon.mjs、bin/open-boot.mjs、bin/dsh-boot.mjs 复用：
 * probe / waitForEngine / startEngine / stopEngine。
 * 零新依赖。
 */
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ENGINE_PORT = 3080;
const LOG_FILE = "rescue-daemon.log";
const PID_FILE = ".rescue-daemon.pid";

/** TCP 探测 127.0.0.1:port 是否可连（引擎就绪判定）。 */
export function probe(port = ENGINE_PORT, timeoutMs = 500) {
	return new Promise((resolveProbe) => {
		const socket = connect({ host: "127.0.0.1", port }, () => {
			socket.destroy();
			resolveProbe(true);
		});
		socket.setTimeout(timeoutMs);
		socket.on("timeout", () => { socket.destroy(); resolveProbe(false); });
		socket.on("error", () => resolveProbe(false));
	});
}

/** 等引擎就绪，最长 waitMs，步进 stepMs。 */
export async function waitForEngine(port = ENGINE_PORT, waitMs = 45000, stepMs = 300) {
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		if (await probe(port)) return true;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	return false;
}

export function readPid(profileDir) {
	try {
		const raw = readFileSync(join(profileDir, PID_FILE), "utf8").trim();
		return Number(raw) || null;
	} catch { return null; }
}

/**
 * 启动 `dsh web`（detached，日志落盘到 profileDir，记录 PID）。
 * @param {object} opts { profileDir, dshCmd }
 * @returns {Promise<{ok, alreadyRunning, pid, message, log}>}
 */
export async function startEngine({ profileDir, dshCmd = "dsh", waitMs = 45000 }) {
	if (await probe(ENGINE_PORT)) {
		return { ok: true, alreadyRunning: true, message: `引擎已在 ${ENGINE_PORT} 运行。` };
	}
	const logPath = join(profileDir, LOG_FILE);
	// stdio 必须用数字 fd（WriteStream 对象的 fd 为 null 时 spawn 报 "argument 'stdio' is invalid"）
	const logFd = openSync(logPath, "a");
	// --no-open：引擎启动时不要抢焦点开 3080 标签页。启动器（3081）/看门狗会各自
	// 拉起引擎，自动开浏览器会连开多个标签页并顶掉用户正在看的页面。
	const child = spawn(dshCmd, ["web", "--no-open"], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		shell: process.platform === "win32",
		windowsHide: true
	});
	child.unref();
	writeFileSync(join(profileDir, PID_FILE), String(child.pid), "utf8");
	const up = await waitForEngine(ENGINE_PORT, waitMs);
	// shell:true 时 child.pid 是 cmd.exe；真正监听 3080 的是它的子进程。就绪后
	// 落盘「真实监听 PID」，stopEngine 与状态页才拿得到可用 PID。
	const realPid = up ? listenerPid(ENGINE_PORT) : null;
	if (realPid !== null) writeFileSync(join(profileDir, PID_FILE), String(realPid), "utf8");
	return {
		ok: up,
		alreadyRunning: false,
		pid: child.pid,
		message: up ? `引擎已启动并就绪（${ENGINE_PORT}）。` : `引擎启动超时（${waitMs / 1000}s），请查看日志。`,
		log: logPath
	};
}

/**
 * 解析「谁在监听 port」的进程 PID（Windows: netstat -ano）。
 * 端口所有者才是真引擎，用于绕开 PID 复用（陈旧 PID 文件一律不作首选）。
 */
export function listenerPid(port = ENGINE_PORT) {
	if (process.platform !== "win32") return null;
	const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
	if (out.status !== 0 || typeof out.stdout !== "string") return null;
	for (const line of out.stdout.split(/\r?\n/)) {
		const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
		if (!m || Number(m[2]) !== port) continue;
		if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])$/.test(m[1])) continue;
		return Number(m[3]);
	}
	return null;
}

/** 进程映像名（Windows: tasklist CSV），确认 PID 不是被复用的无关进程。 */
function imageNameOf(pid) {
	if (process.platform !== "win32") return null;
	const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
	const m = typeof out.stdout === "string" ? out.stdout.match(/^"([^"]+)"/m) : null;
	return m === null ? null : m[1].toLowerCase();
}

/** 进程命令行（仅在没有监听者时作兜底判定）。 */
function commandLineOf(pid) {
	if (process.platform !== "win32") return null;
	const out = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: "utf8", windowsHide: true });
	return typeof out.stdout === "string" ? out.stdout.trim() : null;
}

/**
 * 结束引擎。
 * Windows：优先按「3080 的监听进程」定位真身 → 校验映像名 → taskkill 进程树；
 * PID 文件只作兜底，且必须同时通过「映像是 node/cmd/powershell」+「命令行含 dsh
 * bin.js」两项校验，否则拒绝执行——陈旧 PID 被复用时会误杀无关进程树。
 * @returns {Promise<{ok, message}>}
 */
export async function stopEngine(profileDir) {
	if (process.platform !== "win32") {
		const pid = readPid(profileDir);
		if (pid === null) return { ok: false, message: "未找到 PID 文件，无法停止。" };
		try {
			process.kill(pid, "SIGTERM");
			return { ok: true, message: `已发送 SIGTERM 到 ${pid}。` };
		} catch (error) {
			return { ok: false, message: `停止失败：${error.message}` };
		}
	}
	const live = listenerPid(ENGINE_PORT);
	const pid = live ?? readPid(profileDir);
	if (pid === null) return { ok: false, message: `${ENGINE_PORT} 没有监听进程，也没有 PID 文件，无需停止。` };
	const image = imageNameOf(pid);
	if (image === null) return { ok: false, message: `PID ${pid} 已不存在（疑似陈旧 PID），未执行任何操作。` };
	if (image !== "node.exe" && image !== "cmd.exe" && image !== "powershell.exe") {
		return { ok: false, message: `拒绝执行：PID ${pid} 的映像是 ${image}，不可能是 DSH 引擎（PID 被复用时这里会误杀无关进程）。` };
	}
	if (live === null) {
		const cmdline = commandLineOf(pid);
		if (cmdline === null || !/bin\.js/i.test(cmdline)) {
			return { ok: false, message: `拒绝执行：PID ${pid} 未监听 ${ENGINE_PORT} 且命令行里没有 dsh bin.js，疑似陈旧 PID。` };
		}
	}
	const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
	return {
		ok: result.status === 0,
		message: result.status === 0
			? `已结束引擎进程 ${pid}（${image}，来源：${live !== null ? `${ENGINE_PORT} 监听者` : "PID 文件"}）。`
			: `taskkill 失败（exit ${result.status}）。`
	};
}
