/**
 * enginectl.mjs — 引擎生命周期控制（共享逻辑）。
 * 被 bin/rescue-daemon.mjs、bin/open-boot.mjs、bin/dsh-boot.mjs 复用：
 * probe / httpProbe / engineHealth / launcherHealth / waitForEngine /
 * startEngine / stopEngine / readPid / readPidInfo / portOwner。
 *
 * v0.9.0-2（审计③ 修复 L2/L4/L5/L7）：
 *  - **健康判定 = HTTP 握手 + 身份指纹**（不再只看"TCP 能连"）：裸 TCP 监听器一律判不健康，
 *    端口被非 dsh 进程占用时明确报错并拒绝进入"假健康"。
 *    `probe()` 保留为"端口是否有监听者"的纯占用探测（日志/报错用）。
 *  - **稳定 cwd**：引擎与启动器显式使用用户主目录（可用 DSH_ENGINE_CWD 或 --cwd 覆盖），
 *    不再把 cwd 落在本包 node_modules 内（否则插件自我更新/卸载会 EPERM）。
 *  - **PID 文件升级为 JSON**（app/pid/port/dshCmd/cwd/startedAt/launcherPid），
 *    `stopEngine` 前做多重校验（存活 + 进程镜像 + 端口占用者一致），
 *    校验不过一律拒绝（可用 force 显式绕过），避免 PID 复用误杀无关进程树。
 *  - **启动即监听子进程 exit/error**：引擎立刻失败时马上返回，不再空等整个超时；
 *    失败信息带日志绝对路径与日志尾部。
 * 零新依赖（只用 node 内置模块）。
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const ENGINE_PORT = 3080;
const LOG_FILE = "rescue-daemon.log";
const PID_FILE = ".rescue-daemon.pid";

/** PID 文件里的身份标记：只有本工具启动的引擎才带它。 */
export const PID_APP = "dsh-web-engine";
/** 启动器（open-boot）写进 /api/status 的身份标记。 */
export const LAUNCHER_APP = "dsh-open-boot";
/** 救砖守护（rescue-daemon）写进 /api/status 的身份标记。 */
export const RESCUE_APP = "dsh-rescue-daemon";
/** 引擎 HTTP 身份指纹：带 token 打开是 200，未带 token 时是 401 + 这段说明。 */
const ENGINE_MARKERS = ["dsh web authentication required", "__DSH_BOOT__", "DeepSeek Harness", "dsh-api-gateway"];

// ---------------------------------------------------------------- 端口 / 进程

/** 纯占用探测：127.0.0.1:port 是否有监听者（不判断是不是 dsh，也不判断是否健康）。 */
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

/**
 * HTTP 握手探测：必须真的用 HTTP 应答（200–499），且命中 markers 里的身份指纹才算健康。
 * 裸 TCP 监听器（accept 但不回包）会超时、立刻断开的会 ECONNRESET → 一律 false。
 * @returns {Promise<{ok, status?, marker?, body?, sample?, error?}>}
 */
export function httpProbe(port, { path = "/", timeoutMs = 1500, markers = [], host = "127.0.0.1" } = {}) {
	return new Promise((resolveProbe) => {
		let settled = false;
		const finish = (result) => { if (!settled) { settled = true; resolveProbe(result); } };
		const evaluate = (status, body) => {
			const httpOk = typeof status === "number" && status >= 200 && status < 500;
			const marker = markers.find((needle) => body.includes(needle)) || null;
			const ok = httpOk && (markers.length === 0 || marker !== null);
			return {
				ok, status, marker,
				body: body.slice(0, 4096),
				sample: body.slice(0, 120).replace(/\s+/g, " ")
			};
		};
		const req = httpGet({ host, port, path, agent: false, headers: { connection: "close" } }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { if (body.length < 64 * 1024) body += chunk; });
			res.on("end", () => finish(evaluate(res.statusCode, body)));
			res.on("error", (error) => finish({ ok: false, status: res.statusCode, error: error.message }));
		});
		req.setTimeout(timeoutMs, () => { req.destroy(new Error("HTTP 握手超时")); });
		req.on("error", (error) => finish({ ok: false, error: error.message }));
	});
}

/** 引擎健康：HTTP 握手 + dsh 身份指纹。 */
export function engineHealth(port = ENGINE_PORT, timeoutMs = 1500) {
	return httpProbe(port, { path: "/", timeoutMs, markers: ENGINE_MARKERS });
}

/** 判断 /api/status 的 JSON 归属（open-boot / rescue-daemon，含旧版无 app 字段的形态）。 */
function identifyLauncherJson(json) {
	if (!json || typeof json !== "object") return null;
	if (json.app === LAUNCHER_APP) return "open-boot";
	if (json.app === RESCUE_APP) return "rescue-daemon";
	if (typeof json.engineUp === "boolean" && typeof json.enginePort === "number") {
		return json.window === void 0 ? "rescue-daemon-legacy" : "open-boot-legacy";
	}
	return null;
}

/** 端口上的服务是不是本工具的启动器/救砖守护（HTTP 握手 + /api/status 身份字段）。 */
export async function launcherHealth(port, timeoutMs = 1500) {
	const res = await httpProbe(port, { path: "/api/status", timeoutMs });
	if (!res.ok) return { ok: false, identity: null, ...res };
	let json = null;
	try { json = JSON.parse(res.body); } catch { /* 非 JSON */ }
	const identity = identifyLauncherJson(json);
	if (identity === null) {
		return {
			ok: false, identity: null, status: res.status, sample: res.sample,
			error: `端口 ${port} 上的 HTTP 服务不是 open-boot/rescue-daemon（/api/status 缺少身份字段）`
		};
	}
	return { ok: true, identity, json, status: res.status };
}

/** 端口当前的 LISTENING 占用者 pid（取不到返回 null）。 */
export function portOwner(port) {
	try {
		if (process.platform === "win32") {
			const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
			if (out.status !== 0 || !out.stdout) return null;
			for (const line of out.stdout.split(/\r?\n/)) {
				const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
				if (m && Number(m[1]) === Number(port)) return Number(m[2]);
			}
			return null;
		}
		const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 5000 });
		if (out.status !== 0 || !out.stdout) return null;
		const pid = Number.parseInt(out.stdout.trim().split(/\s+/)[0], 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch { return null; }
}

/** 进程镜像名（小写，Windows 带 .exe；取不到返回 null）。 */
export function processImage(pid) {
	try {
		if (process.platform === "win32") {
			const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
			const m = /^"([^"]+)"/.exec((out.stdout || "").trim());
			return m ? m[1].toLowerCase() : null;
		}
		const out = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 5000 });
		const name = (out.stdout || "").trim().split(/\r?\n/)[0];
		return name ? name.toLowerCase() : null;
	} catch { return null; }
}

/** pid 是否存活（EPERM 也算存活：进程在但没权限发信号）。 */
export function isAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return Boolean(error) && error.code === "EPERM"; }
}

/** 一个 pid 是不是"引擎样"的进程（node/dsh），用于拒绝明显无关的 pid。 */
function looksLikeEngineImage(image) {
	if (image === null || image === void 0) return true; // 取不到镜像名时不据此拒绝
	return /^node(\.exe)?$/.test(image) || /^dsh(\.exe|\.cmd)?$/.test(image);
}

// ---------------------------------------------------------------- 工作目录

/** 引擎/启动器的稳定工作目录：默认用户主目录，可用 DSH_ENGINE_CWD 或 --cwd 覆盖。 */
export function resolveEngineCwd(explicit) {
	const candidate = explicit || process.env.DSH_ENGINE_CWD || homedir();
	try {
		const full = resolve(candidate);
		if (existsSync(full)) return full;
	} catch { /* 落到 homedir */ }
	return homedir();
}

/**
 * 把自己（长命进程：启动器/守护）的 cwd 挪到稳定目录。
 * 目的：不要把 cwd 留在 profile 目录或本包 node_modules 内（那会锁住目录，
 * 使 pnpm/npm 更新或卸载本插件时报 ERR_PNPM_EPERM / 目录被占用）。
 */
export function chdirStable(explicit) {
	const target = resolveEngineCwd(explicit);
	const before = process.cwd();
	try {
		if (resolve(before) !== target) process.chdir(target);
		return { ok: true, from: before, cwd: target, changed: resolve(before) !== target };
	} catch (error) {
		return { ok: false, from: before, cwd: before, message: error instanceof Error ? error.message : String(error) };
	}
}

// ---------------------------------------------------------------- PID 文件

/** 读 PID 文件（兼容旧的"纯数字"格式），返回完整信息；无文件/解析失败返回 null。 */
export function readPidInfo(profileDir) {
	let raw;
	try { raw = readFileSync(join(profileDir, PID_FILE), "utf8").trim(); } catch { return null; }
	if (!raw) return null;
	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && Number.isInteger(parsed.pid) && parsed.pid > 0) return { ...parsed, legacy: false };
		} catch { /* 落到旧格式解析 */ }
	}
	const pid = Number.parseInt(raw, 10);
	return Number.isInteger(pid) && pid > 0 ? { pid, legacy: true } : null;
}

/** 旧 API：只取 pid（保留给外部调用方）。 */
export function readPid(profileDir) {
	const info = readPidInfo(profileDir);
	return info ? info.pid : null;
}

/** 写 PID 文件（JSON：app/pid/port/dshCmd/cwd/startedAt/launcherPid）。 */
export function writePidInfo(profileDir, info) {
	writeFileSync(join(profileDir, PID_FILE), JSON.stringify(info) + "\n", "utf8");
}

function removePidIfMatches(profileDir, pid) {
	const info = readPidInfo(profileDir);
	if (info && info.pid === pid) {
		try { unlinkSync(join(profileDir, PID_FILE)); } catch { /* 清不掉不影响主流程 */ }
	}
}

/** 读日志尾部（最多 maxBytes，返回最后 lineCount 行）。 */
export function readLogTail(profileDir, lineCount = 12, maxBytes = 16 * 1024) {
	let text = "";
	try { text = readFileSync(join(profileDir, LOG_FILE), "utf8"); } catch { return ""; }
	const tail = text.length > maxBytes ? text.slice(-maxBytes) : text;
	const lines = tail.split(/\r?\n/).filter((line) => line.trim() !== "");
	return lines.slice(-lineCount).join("\n");
}

/** 读取引擎启动日志（尾部 maxBytes，供运行期失败条目隔离用）。 */
export function readEngineLog(profileDir, maxBytes = 64 * 1024) {
	try {
		const text = readFileSync(join(profileDir, LOG_FILE), "utf8");
		return text.length > maxBytes ? text.slice(-maxBytes) : text;
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------- 启动引擎

/** 解析 Windows 上的命令（.cmd/.bat 必须经 cmd.exe；.exe/.com 直接起，避免含空格路径被 shell 拆开）。 */
function resolveWindowsCommand(command) {
	// cmd.exe 不认正斜杠路径（C:/tools/dsh.cmd 会被当成开关）→ 统一转成反斜杠
	const normalized = command.replace(/\//g, "\\");
	if (/\.(cmd|bat)$/i.test(normalized)) return { kind: "shim", path: normalized };
	if (/\.(exe|com)$/i.test(normalized)) return { kind: "exe", path: normalized };
	if (/[\\/]/.test(normalized)) return { kind: "other", path: normalized };
	const out = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true, timeout: 5000 });
	const candidates = (out.stdout || "").split(/\r?\n/).map((line) => line.trim().replace(/\//g, "\\")).filter(Boolean);
	const shim = candidates.find((candidate) => /\.(cmd|bat)$/i.test(candidate));
	if (shim) return { kind: "shim", path: shim };
	const exe = candidates.find((candidate) => /\.(exe|com)$/i.test(candidate));
	if (exe) return { kind: "exe", path: exe };
	return { kind: "other", path: normalized };
}

function quoteForCmd(part) {
	const text = String(part);
	return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 启动引擎子进程（供 startEngine 使用，也供测试直接调用）。
 * - cwd 默认稳定目录（绝不会是本包 node_modules）
 * - .cmd/.bat 经 `cmd /d /s /c ""<shim>" <args>"`（命令整体加引号 → 含空格路径可用）
 * - .exe/.com 直接 spawn（不经 shell → 含空格路径可用）
 */
export function spawnEngineProcess({ dshCmd = "dsh", args = ["web"], cwd = resolveEngineCwd(), logFd = null, windowsHide = true } = {}) {
	const stdio = logFd === null ? "ignore" : ["ignore", logFd, logFd];
	const options = { cwd, detached: true, stdio, windowsHide };
	if (process.platform !== "win32") return spawn(dshCmd, args, options);
	const resolved = resolveWindowsCommand(dshCmd);
	if (resolved.kind === "shim") {
		const comspec = process.env.ComSpec || join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
		const line = `"${resolved.path}" ${args.map(quoteForCmd).join(" ")}`;
		// windowsVerbatimArguments 必须为 true：命令行要原样交给 cmd（""<path>" <args>"），
		// 否则 Node 会把内层引号转义成 \"，cmd 收到字面量 \" 后报"不是内部或外部命令"。
		return spawn(comspec, ["/d", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true });
	}
	if (resolved.kind === "exe") return spawn(resolved.path, args, options);
	return spawn(dshCmd, args, options);
}

/**
 * 等目标就绪：默认用引擎 HTTP 健康判定；可传入 failureProbe 在子进程立刻退出时提前终止。
 * 注意：health 可以是"返回布尔"的函数，也可以是 engineHealth/launcherHealth 这种
 * 返回 {ok,...} 的函数——两种都支持（否则 `await health()` 的返回值恒为真，必然误判就绪）。
 * @returns {Promise<boolean>}
 */
export async function waitForEngine(port = ENGINE_PORT, waitMs = 45000, stepMs = 300, health = engineHealth, failureProbe = null) {
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const result = await health(port);
		if (result === true) return true;
		if (result !== null && typeof result === "object" && result.ok === true) return true;
		if (typeof failureProbe === "function" && failureProbe()) return false;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	return false;
}

/**
 * 启动一次 + 失败自动隔离（运行期失败条目）+ 重试一次。
 * 端口被"非 dsh 进程"占用时不做日志隔离（否则会把无辜插件当成坏条目隔离掉）。
 */
export async function startEngineWithQuarantine({ profileDir, dshCmd = "dsh", isolateFailedEntries, waitMs = 45000, cwd } = {}) {
	const start = await startEngine({ profileDir, dshCmd, waitMs, cwd });
	if (start.ok) return { ...start, quarantined: [] };
	if (start.occupied) return { ...start, quarantined: [], quarantineMessage: "端口被非 dsh 进程占用，未做插件隔离。" };
	const isolated = isolateFailedEntries
		? isolateFailedEntries(profileDir, readEngineLog(profileDir))
		: { isolated: [], message: "" };
	if (isolated.isolated.length > 0) {
		const retry = await startEngine({ profileDir, dshCmd, waitMs, cwd });
		return { ...retry, quarantined: isolated.isolated, quarantineMessage: isolated.message, firstStart: start };
	}
	return { ...start, quarantined: [], quarantineMessage: isolated.message };
}

/**
 * 启动 `dsh web`（detached，日志落盘到 profileDir，PID 文件记录身份）。
 * @returns {Promise<{ok, alreadyRunning, occupied?, pid?, message, log?}>}
 */
export async function startEngine({ profileDir, dshCmd = "dsh", waitMs = 45000, cwd, port = ENGINE_PORT } = {}) {
	// 1) 已经是健康引擎 → 直接复用
	const health = await engineHealth(port);
	if (health.ok) {
		return { ok: true, alreadyRunning: true, healthy: true, message: `引擎已在 ${port} 运行（HTTP 握手正常：${health.marker || `HTTP ${health.status}`}）。` };
	}

	// 2) 端口有监听者但不是 dsh → 明确报错，拒绝"假健康"，也不重复启动
	if (await probe(port)) {
		const owner = portOwner(port);
		return {
			ok: false, alreadyRunning: false, occupied: true, portOwner: owner,
			message: `端口 ${port} 已被${owner ? ` pid ${owner}` : "其他进程"}占用，但它不是 dsh 引擎（HTTP 握手失败）——拒绝把它当成"引擎已就绪"。请先结束该进程或改用其他端口。`
		};
	}

	// 3) 真正启动
	const engineCwd = resolveEngineCwd(cwd);
	const logPath = join(profileDir, LOG_FILE);
	let logFd;
	try { logFd = openSync(logPath, "a"); }
	catch (error) { return { ok: false, message: `无法打开引擎日志 ${logPath}：${error.message}`, log: logPath }; }

	let child;
	try {
		child = spawnEngineProcess({ dshCmd, args: ["web"], cwd: engineCwd, logFd });
	} catch (error) {
		try { closeSync(logFd); } catch { /* ignore */ }
		return { ok: false, message: `无法启动引擎（${dshCmd}）：${error.message}`, log: logPath };
	}
	try { closeSync(logFd); } catch { /* 子进程已继承 fd */ }
	child.unref();

	let failure = null;
	let settled = false;
	child.once("error", (error) => { failure = { kind: "spawn-error", message: error.message }; });
	child.once("exit", (code, signal) => { if (!settled) failure = { kind: "exit", code, signal }; });

	const info = {
		app: PID_APP, pid: child.pid, port, dshCmd, cwd: engineCwd,
		startedAt: new Date().toISOString(), launcherPid: process.pid
	};
	writePidInfo(profileDir, info);

	const up = await waitForEngine(port, waitMs, 300, engineHealth, () => failure);
	settled = true;

	if (!up) {
		if (failure) removePidIfMatches(profileDir, child.pid);
		const tail = readLogTail(profileDir);
		const reason = failure
			? failure.kind === "exit"
				? `引擎进程已退出（exit ${failure.code}${failure.signal ? ` / ${failure.signal}` : ""}）`
				: `引擎进程启动失败：${failure.message}`
			: `引擎在 ${Math.round(waitMs / 1000)}s 内未通过 HTTP 健康检查（端口 ${port}）`;
		return {
			ok: false, alreadyRunning: false, pid: child.pid, failedEarly: Boolean(failure),
			message: `${reason}。日志：${logPath}${tail ? `\n最近日志：\n${tail}` : ""}`,
			log: logPath, logTail: tail
		};
	}

	// 4) 就绪：把 PID 校正为真正持有端口的进程（经 cmd 包装启动时 child.pid 是包装进程）
	const owner = portOwner(port);
	const realPid = owner && owner !== child.pid ? owner : child.pid;
	if (realPid !== child.pid) {
		writePidInfo(profileDir, { ...info, pid: realPid, wrapperPid: child.pid, pidSource: "portOwner" });
	}
	return {
		ok: true, alreadyRunning: false, pid: realPid, spawnPid: child.pid,
		message: `引擎已启动并就绪（${port}，pid ${realPid}）。`, log: logPath, cwd: engineCwd
	};
}

// ---------------------------------------------------------------- 停止引擎

/** 描述一个 pid 与端口的对应关系（诊断文本）。 */
export function describeEngineProcess(pid, port = ENGINE_PORT) {
	const image = processImage(pid);
	const owner = portOwner(port);
	const parts = [`进程镜像 ${image || "未知"}`];
	if (owner === null) parts.push(`端口 ${port} 当前无监听者`);
	else if (owner === Number(pid)) parts.push(`持有端口 ${port}`);
	else parts.push(`端口 ${port} 的占用者是 pid ${owner}（≠ 记录 pid ${pid}）`);
	return { image, owner, text: parts.join("；") };
}

/**
 * 结束引擎。多重校验后才动手，避免 PID 复用误杀无关进程树：
 *   ① pid 存活  ② 进程镜像像 dsh/node  ③ 端口占用者与记录 pid 一致（有监听者时）；
 *   端口无监听者时，只在"PID 文件由本工具写入（带 app 标记）"的情况下才允许结束。
 * 校验不过 → 拒绝并返回 reasons（可传 force:true 显式强制）。
 */
export async function stopEngine(profileDir, { force = false, port = ENGINE_PORT } = {}) {
	const info = readPidInfo(profileDir);
	if (!info) {
		return { ok: false, refused: true, message: `未找到 PID 文件（${join(profileDir, PID_FILE)}），无法确认引擎进程，未执行任何结束操作。` };
	}
	const pid = Number(info.pid);
	const owner = portOwner(port);
	const image = processImage(pid);
	const alive = isAlive(pid);
	const identity = describeEngineProcess(pid, port);
	const reasons = [];

	if (!alive) reasons.push(`pid ${pid} 已不存在（PID 文件陈旧，或 pid 已被系统复用）`);
	if (!looksLikeEngineImage(image)) reasons.push(`pid ${pid} 的进程镜像是 ${image}，不是 dsh/node`);
	if (owner !== null && owner !== pid) reasons.push(`端口 ${port} 的占用者是 pid ${owner}，与记录的 pid ${pid} 不一致`);
	if (owner === null && alive) {
		if (info.legacy || info.app !== PID_APP) reasons.push(`端口 ${port} 没有监听者，且 PID 文件缺少本工具的身份标记（旧格式/非本工具写入），无法确认 pid ${pid} 就是上次启动的引擎`);
	}

	if (reasons.length > 0 && !force) {
		return {
			ok: false, refused: true, pid, port, owner, image, identity: identity.text, reasons,
			message: `拒绝结束进程：${reasons.join("；")}。${identity.text}。\n` +
				`（这是防止 PID 复用误杀无关进程的保护。确认无误后可强制结束：rescue 页面点"强制停止"，或调用 stopEngine(dir,{force:true}) / POST /api/stop {"force":true}。）`
		};
	}

	try {
		if (process.platform === "win32") {
			const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
			const ok = result.status === 0;
			if (ok) removePidIfMatches(profileDir, pid);
			return {
				ok, force, pid, port, owner, image, identity: identity.text, checks: reasons,
				message: ok
					? `${force && reasons.length > 0 ? "已强制结束" : "已结束"}引擎进程 ${pid}（${identity.text}）。`
					: `taskkill 失败（exit ${result.status}）：${(result.stderr || result.stdout || "").trim()}`
			};
		}
		process.kill(pid, "SIGTERM");
		removePidIfMatches(profileDir, pid);
		return { ok: true, force, pid, port, owner, image, identity: identity.text, checks: reasons, message: `已发送 SIGTERM 到 ${pid}（${identity.text}）。` };
	} catch (error) {
		return { ok: false, refused: false, pid, message: `停止失败：${error.message}` };
	}
}
