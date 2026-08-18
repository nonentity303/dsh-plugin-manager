/**
 * enginectl.mjs — 引擎生命周期控制（共享逻辑）。
 * 被 bin/rescue-daemon.mjs、bin/open-boot.mjs、bin/dsh-boot.mjs 复用：
 * probe / waitForEngine / startEngine / stopEngine。
 * 零新依赖。
 */
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
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
	const out = createWriteStream(logPath, { flags: "a" });
	const child = spawn(dshCmd, ["web"], {
		detached: true,
		stdio: ["ignore", out, out],
		shell: process.platform === "win32",
		windowsHide: true
	});
	child.unref();
	writeFileSync(join(profileDir, PID_FILE), String(child.pid), "utf8");
	const up = await waitForEngine(ENGINE_PORT, waitMs);
	return {
		ok: up,
		alreadyRunning: false,
		pid: child.pid,
		message: up ? `引擎已启动并就绪（${ENGINE_PORT}）。` : `引擎启动超时（${waitMs / 1000}s），请查看日志。`,
		log: logPath
	};
}

/**
 * 结束引擎（Windows: taskkill 进程树；其他: SIGTERM）。
 * @returns {Promise<{ok, message}>}
 */
export async function stopEngine(profileDir) {
	const pid = readPid(profileDir);
	if (pid === null) return { ok: false, message: "未找到 PID 文件，无法停止。" };
	if (process.platform === "win32") {
		const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
		return { ok: result.status === 0, message: result.status === 0 ? `已结束引擎进程 ${pid}。` : `taskkill 失败（exit ${result.status}）。` };
	}
	try {
		process.kill(pid, "SIGTERM");
		return { ok: true, message: `已发送 SIGTERM 到 ${pid}。` };
	} catch (error) {
		return { ok: false, message: `停止失败：${error.message}` };
	}
}
