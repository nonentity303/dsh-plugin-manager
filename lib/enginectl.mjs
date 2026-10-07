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
 * v0.9.1（审计③ L11 / P1-5 配套）：
 *  - 新增**本地写接口防护**共享件：`newApiToken()`（一次性令牌）、`guardWriteRequest()`（Origin + token）、
 *    `sameOriginOf()`、`createSingleFlight()`（boot/start 单飞）。open-boot 与 rescue-daemon 共用，
 *    读取类接口（GET /api/status）**不加**防护 —— launcherHealth 的身份握手必须保持可探测。
 *  - `ENGINE_PORT` 支持 `DSH_ENGINE_PORT` 覆盖（测试/多实例逃生门；默认仍为 3080）。
 * v0.9.1-rc2（兼容性审计 C-05 / C-07 修复）：
 *  - **C-07（medium）**：端口归属探测改为**兜底链** `lsof` → `ss -ltnp` → `/proc/net/tcp`（+ inode 反查），
 *    不再是"没有 lsof 就等于探测不可用"（精简发行版/容器/Alpine 常无 lsof，旧实现会让
 *    `--uninstall`/守护流程退化为「归属未确认 → 拒绝处理」，用户被卡死）。
 *    每条路的原始结论都留在 `attempts` 里；三条路都不行时**明确**报「探测不可用」（不静默返回空）。
 *    进程镜像探测补 `/proc/<pid>/comm`（Linux 无 ps 也能判）。
 *  - **C-05（high）**：弹窗启动新增**纯函数命令构造** `bootWindowPlan()`（macOS 不再把 shell 命令行
 *    递给 `open`，改用 `.command` 脚本 + osascript 兜底；Linux 按终端特性给 `--`/`-e` 形态）与
 *    **退出码/错误事件校验** `verifyLauncherExit()` / `launchViaCandidates()` —— 启动器立刻失败
 *    一律 `ok:false` 上报，不再静默假成功。
 * 零新依赖（只用 node 内置模块）。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readlinkSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 引擎端口。契约默认 **3080**。
 * `DSH_ENGINE_PORT` 是显式的**测试/多实例**逃生门：启动器链路里"启动/停止引擎"这类用例
 * 必须能避开真机引擎（否则单测会真的动 3080），CI 里也不该依赖本机 3080 是否在跑。
 */
export const ENGINE_PORT = (() => {
	const override = Number(process.env.DSH_ENGINE_PORT);
	return Number.isInteger(override) && override > 0 && override < 65536 ? override : 3080;
})();
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

/**
 * 端口归属探测（**区分"端口空闲"与"探测本身失败"**）。
 * `ok=false` 表示探测不可用（netstat/lsof/ss//proc 被环境拦截、命令不存在、spawn EPERM 等）——
 * 它与"探测成功但没人监听"是两件不同的事：前者不能用来断言"没有守护"，
 * 否则 `--uninstall` 会在受限环境里假报成功（t8 终审 F2）。
 * @returns {{ok:boolean, pid:number|null, reason:string|null, via?:string|null, attempts?:Array}}
 */
export function portOwnerProbe(port) {
	try {
		if (process.platform === "win32") {
			const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
			if (out.error || out.status !== 0 || !out.stdout) {
				return { ok: false, pid: null, reason: out.error ? `${out.error.code || "spawn-error"} ${out.error.message}`.trim() : `netstat exit ${out.status}` };
			}
			for (const line of out.stdout.split(/\r?\n/)) {
				const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
				if (m && Number(m[1]) === Number(port)) return { ok: true, pid: Number(m[2]), reason: null, via: "netstat -ano" };
			}
			return { ok: true, pid: null, reason: null, via: "netstat -ano" };
		}
		// 非 Windows：lsof → ss → /proc/net/tcp 兜底链（C-07）。win32 的 netstat 无对应兜底需求。
		const chain = resolvePortOwner({ platform: process.platform, port, ...realPortOwnerDeps() });
		return chain.ok
			? { ok: true, pid: chain.pid, reason: null, via: chain.via, attempts: chain.attempts }
			: { ok: false, pid: null, reason: chain.reason, via: null, attempts: chain.attempts };
	} catch (error) {
		return { ok: false, pid: null, reason: error instanceof Error ? error.message : String(error) };
	}
}

// ---------------------------------------------------------------- 端口归属兜底链（C-07）

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` 的输出 → pid（纯函数；无监听者 → null）。 */
export function parseLsofListenerPid(stdout) {
	const first = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "")[0] ?? "";
	const pid = Number.parseInt(first, 10);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * `ss -ltnp` 的输出 → `{listening, pid}`（纯函数）。
 * 形态：`LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=1234,fd=22))`；
 * 没有权限看别的用户进程时，ss 会给出该行但**没有 users:(...)** → `{listening:true, pid:null}`。
 * 列位在 iproute2 各版本间有微调，因此这里不按固定下标取地址，而是**取第一个 `…:<数字>` 字段**当本地地址。
 */
export function parseSsListener(stdout, port) {
	const wanted = Number(port);
	for (const raw of String(stdout ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!/^LISTEN\b/i.test(line)) continue;
		const parts = line.split(/\s+/);
		let localPort = null;
		for (const part of parts) {
			const m = /^(.+):(\d+)$/.exec(part);
			if (m) { localPort = Number(m[2]); break; }
		}
		if (localPort !== wanted) continue;
		const pidMatch = /pid=(\d+)/.exec(line);
		return { listening: true, pid: pidMatch ? Number(pidMatch[1]) : null };
	}
	return { listening: false, pid: null };
}

/**
 * 解析 `/proc/net/tcp`（或 `/proc/net/tcp6`）→ 只保留 LISTEN(0A) 行（纯函数）。
 * 行形态：`0: 0100007F:0C08 00000000:0000 0A … 1000 0 <inode> 1`（inode = 第 10 个字段下标 9）。
 */
export function parseProcNetTcpListeners(text) {
	const rows = [];
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || /^sl\b/i.test(line)) continue;
		const parts = line.split(/\s+/);
		if (parts.length < 10) continue;
		const [localAddress, localPortHex] = parts[1].split(":");
		const port = Number.parseInt(localPortHex ?? "", 16);
		const inode = Number.parseInt(parts[9] ?? "", 10);
		if (parts[3] !== "0A") continue; // 0A = LISTEN
		if (!Number.isInteger(port) || !Number.isInteger(inode)) continue;
		rows.push({ port, inode, localAddress, state: parts[3] });
	}
	return rows;
}

/** 从 `/proc/net/tcp` 的 LISTEN 行里挑出目标端口的 inode（纯函数）。 */
export function pickProcListenerInode(rows, port) {
	for (const row of Array.isArray(rows) ? rows : []) {
		if (row && Number(row.port) === Number(port) && Number.isInteger(row.inode)) return row.inode;
	}
	return null;
}

/** inode → pid：扫 `/proc/<pid>/fd` 找 `socket:[inode]`（纯逻辑 + 注入式 IO，便于单测）。 */
export function findPidBySocketInode(inode, { listPids, listFds, readLink } = {}) {
	if (!Number.isInteger(inode) || typeof listPids !== "function") return null;
	const needle = `socket:[${inode}]`;
	for (const pid of listPids() ?? []) {
		let fds = [];
		try { fds = listFds(pid) ?? []; } catch { continue; }
		for (const fd of fds) {
			let target = null;
			try { target = readLink(`/proc/${pid}/fd/${fd}`); } catch { target = null; }
			if (target === needle) return Number(pid);
		}
	}
	return null;
}

/**
 * 端口归属**兜底链**（lsof → `ss -ltnp` → `/proc/net/tcp` + inode 反查）。
 *
 * 为什么需要（审计 C-07）：精简发行版/容器/Alpine 常常**没有 lsof**，旧实现只有 lsof 一条路
 * → 直接 `ok:false`（这是保守正确的，但没有任何替代探测，用户被"归属未确认 → 拒绝处理"卡住）。
 *
 * 返回语义：
 *   `{ok:true, pid:number|null}`   探测成功；`pid=null` = **确认端口空闲**（可据此断言"没有守护"）
 *   `{ok:false, pid:null, reason}` 三条路都不可用 → 调用方**不得**据此断言端口空闲
 * `attempts` 逐条记录每条路的原始结论（命令 + 错误 + pid），失败原因不隐藏。
 */
export function resolvePortOwner({ platform = process.platform, port, run = null, readText = null, listPids = null, listFds = null, readLink = null } = {}) {
	const attempts = [];
	const portNumber = Number(port);
	if (typeof run !== "function") {
		return { ok: false, pid: null, via: null, attempts, reason: `端口 ${portNumber} 归属探测不可用：未注入命令执行器（run）` };
	}
	// 1) lsof（macOS 系统自带；Linux 常缺）
	const lsof = run("lsof", ["-nP", `-iTCP:${portNumber}`, "-sTCP:LISTEN", "-t"]);
	if (lsof?.error) {
		attempts.push({ tool: "lsof", ok: false, reason: `${lsof.error.code || "spawn-error"} ${lsof.error.message}`.trim() });
	} else if (lsof?.status === 0 || lsof?.status === 1) {
		// lsof -t：有监听者 → exit 0 + pid；没有 → exit 1 + 空输出（**探测成功**，不是失败）
		const pid = parseLsofListenerPid(lsof.stdout);
		attempts.push({ tool: "lsof", ok: true, pid });
		return { ok: true, pid, via: "lsof", attempts, reason: null };
	} else {
		const firstErr = String(lsof?.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "";
		attempts.push({ tool: "lsof", ok: false, reason: `lsof exit ${lsof?.status}${firstErr ? `：${firstErr}` : ""}` });
	}
	// 2) ss -ltnp（iproute2；Linux）
	const ss = run("ss", ["-ltnp"]);
	if (ss?.error) {
		attempts.push({ tool: "ss", ok: false, reason: `${ss.error.code || "spawn-error"} ${ss.error.message}`.trim() });
	} else if (ss?.status === 0) {
		const hit = parseSsListener(ss.stdout, portNumber);
		if (!hit.listening) {
			attempts.push({ tool: "ss", ok: true, pid: null });
			return { ok: true, pid: null, via: "ss -ltnp", attempts, reason: null };
		}
		if (hit.pid !== null) {
			attempts.push({ tool: "ss", ok: true, pid: hit.pid });
			return { ok: true, pid: hit.pid, via: "ss -ltnp", attempts, reason: null };
		}
		// 端口在监听但拿不到 pid（别的用户 / 受限容器）→ 继续用 /proc 反查（不把"拿不到 pid"当成功）
		attempts.push({ tool: "ss", ok: false, reason: `ss 检测到 ${portNumber} 在监听但拿不到 pid（权限/容器限制）` });
	} else {
		const firstErr = String(ss?.stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "";
		attempts.push({ tool: "ss", ok: false, reason: `ss exit ${ss?.status}${firstErr ? `：${firstErr}` : ""}` });
	}
	// 3) /proc/net/tcp（Linux 内核直接暴露，无需外部命令）+ inode → /proc/<pid>/fd 反查
	if (typeof readText !== "function" || typeof listPids !== "function" || typeof listFds !== "function" || typeof readLink !== "function") {
		attempts.push({ tool: "/proc/net/tcp", ok: false, reason: "无 /proc 读取能力（非 Linux 或依赖未注入）" });
	} else {
		let text = null;
		try { text = readText("/proc/net/tcp"); } catch { text = null; }
		if (typeof text !== "string") {
			attempts.push({ tool: "/proc/net/tcp", ok: false, reason: "读取 /proc/net/tcp 失败（未挂载 /proc 或超出权限）" });
		} else {
			const inode = pickProcListenerInode(parseProcNetTcpListeners(text), portNumber);
			if (inode === null) {
				attempts.push({ tool: "/proc/net/tcp", ok: true, pid: null });
				return { ok: true, pid: null, via: "/proc/net/tcp", attempts, reason: null };
			}
			const pid = findPidBySocketInode(inode, { listPids, listFds, readLink });
			if (pid !== null && Number.isInteger(pid)) {
				attempts.push({ tool: "/proc/net/tcp", ok: true, pid });
				return { ok: true, pid, via: "/proc/net/tcp(inode)", attempts, reason: null };
			}
			attempts.push({ tool: "/proc/net/tcp", ok: false, reason: `inode ${inode} 在 /proc/*/fd 里没找到属主（进程刚退出 / 无权限）` });
		}
	}
	return {
		ok: false, pid: null, via: null, attempts,
		reason: `端口 ${portNumber} 归属探测不可用（lsof/ss//proc 均不可用，**不能据此断言端口空闲**）：`
			+ attempts.map((a) => `${a.tool} → ${a.ok ? (a.pid === null ? "无监听者" : `pid ${a.pid}`) : a.reason}`).join("；")
	};
}

/** 真实 IO 依赖（运行期用；单测注入假 IO 即可在 Windows 上覆盖 Linux 分支）。 */
export function realPortOwnerDeps() {
	return {
		run: (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 5000, windowsHide: true }),
		readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
		listPids: () => {
			try {
				return readdirSync("/proc", { withFileTypes: true })
					.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
					.map((entry) => Number(entry.name));
			} catch { return []; }
		},
		listFds: (pid) => { try { return readdirSync(`/proc/${pid}/fd`); } catch { return []; } },
		readLink: (path) => { try { return readlinkSync(path); } catch { return null; } }
	};
}


/** 端口当前的 LISTENING 占用者 pid（取不到返回 null）。旧 API，语义不变。 */
export function portOwner(port) {
	return portOwnerProbe(port).pid;
}

/**
 * 进程镜像名探测（小写；**区分"进程不存在"与"探测不可用"**）。
 * `ok=false` = tasklist/ps//proc 被环境拦截；`ok=true, image=null` = 探测成功但该 pid 不存在。
 * 非 Windows 顺序（C-07 配套）：Linux 先读 `/proc/<pid>/comm`（内核直接暴露，不依赖 ps），
 * 读不到再退 `ps -p <pid> -o comm=`；macOS 无 /proc，直接走 ps。
 * @returns {{ok:boolean, image:string|null, reason:string|null, via?:string|null}}
 */
export function processImageProbe(pid) {
	try {
		if (process.platform === "win32") {
			const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
			if (out.error || out.status !== 0 || !out.stdout) {
				return { ok: false, image: null, reason: out.error ? `${out.error.code || "spawn-error"} ${out.error.message}`.trim() : `tasklist exit ${out.status}` };
			}
			const m = /^"([^"]+)"/.exec(out.stdout.trim());
			return { ok: true, image: m ? m[1].toLowerCase() : null, reason: null, via: "tasklist" };
		}
		return resolveProcessImage({
			platform: process.platform,
			pid,
			hasProc: process.platform === "linux",
			run: (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 5000 }),
			readText: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } }
		});
	} catch (error) {
		return { ok: false, image: null, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 进程镜像兜底链（纯逻辑 + 注入式依赖）：`/proc/<pid>/comm`（Linux）→ `ps -p <pid> -o comm=`。
 * `/proc` 读失败**不当成"进程不存在"**（可能是权限/容器），继续走 ps；两条都不行才 `ok:false`。
 */
export function resolveProcessImage({ platform = process.platform, pid, hasProc = false, run = null, readText = null } = {}) {
	const attempts = [];
	if (typeof run !== "function") return { ok: false, image: null, via: null, attempts, reason: "未注入命令执行器（run）" };
	if (hasProc && typeof readText === "function") {
		let text = null;
		try { text = readText(`/proc/${pid}/comm`); } catch { text = null; }
		if (typeof text === "string") {
			const name = text.trim().split(/\r?\n/)[0] ?? "";
			attempts.push({ tool: "/proc/<pid>/comm", ok: true, image: name });
			return { ok: true, image: name === "" ? null : name.toLowerCase(), via: "/proc/<pid>/comm", attempts, reason: null };
		}
		attempts.push({ tool: "/proc/<pid>/comm", ok: false, reason: `读取失败（pid ${pid} 不存在或无权限）` });
	}
	const out = run("ps", ["-p", String(pid), "-o", "comm="]);
	if (out?.error) {
		attempts.push({ tool: "ps", ok: false, reason: `${out.error.code || "spawn-error"} ${out.error.message}`.trim() });
		return { ok: false, image: null, via: null, attempts, reason: `进程镜像探测不可用（/proc 与 ps 都不可用）：${attempts.map((a) => `${a.tool} → ${a.ok ? a.image : a.reason}`).join("；")}` };
	}
	const name = String(out?.stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
	attempts.push({ tool: "ps", ok: true, image: name });
	return { ok: true, image: name === "" ? null : name.toLowerCase(), via: "ps", attempts, reason: null };
}

/** 进程镜像名（小写，Windows 带 .exe；取不到返回 null）。旧 API，语义不变。 */
export function processImage(pid) {
	return processImageProbe(pid).image;
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

// ---------------------------------------------------------------- 命令行取值校验（共享件）

/**
 * **通用取值校验**（所有"取值开关"共用）：缺失 / 全空白 / 以 `-` 开头 → 返回错误文案；合法 → null。
 *
 * 为什么所有取值开关都必须过这一关（t21-F1，high）：旧解析对取值开关是"无条件吞掉下一个 token"，
 * 于是 `--uninstall --dsh --profile` 里 `--dsh` 把 `--profile` 吞成自己的取值 —— 后面的开关**凭空消失**、
 * `args.unknown` 保持为空、于是静默回落到**默认 profile + 3081**，并对全局 `DSHWeb*` 自启项执行删除后
 * 以 exit 0 报成功。取值以 `-` 开头一定不是真取值（那是下一个开关），必须当场判用法错误。
 *
 * @param {unknown} raw 原始取值（undefined 表示缺失）
 * @param {{flag?:string, hint?:string}} [opts] flag = 开关名（写进报错）；hint = 写法提示
 * @returns {string|null} 错误文案或 null
 */
export function validateCliValue(raw, { flag = "取值", hint = null } = {}) {
	const how = hint ? `（${hint}）` : "";
	if (raw === void 0) return `${flag} 缺少取值${how}`;
	const text = String(raw).trim();
	if (text === "") return `${flag} 取值为空白${how}`;
	if (text.startsWith("-")) return `${flag} 缺少取值：下一个 token 是 ${JSON.stringify(raw)}（像是被后面的开关占用了）${how}`;
	return null;
}

/**
 * **整数取值校验**（在通用校验之上加"纯数字 + 范围"）。越界 → 错误文案（不再静默夹取/回落默认值）。
 * @param {{flag?:string, min?:number, max?:number, hint?:string}} [opts]
 */
export function validateIntegerValue(raw, { flag = "取值", min = 0, max = Number.MAX_SAFE_INTEGER, hint = null } = {}) {
	const base = validateCliValue(raw, { flag, hint: hint || `写法：${flag} <${min}-${max}>` });
	if (base) return base;
	const text = String(raw).trim();
	if (!/^\d+$/.test(text)) return `${flag} 取值必须是纯数字（${min}..${max}）：${JSON.stringify(raw)}`;
	const value = Number(text);
	if (!Number.isInteger(value) || value < min || value > max) return `${flag} 取值越界（应在 ${min}..${max}）：${raw}`;
	return null;
}

/**
 * 端口取值校验（`--port` 专用：1..65535 的纯数字）。
 * 为什么必须校验（t18-F1 同族）：旧写法 `Number(argv[++i]) || 3081` 会把
 * `--port --profile X`（`Number("--profile")` 是 NaN）、`--port abc`、空白 一律静默落回默认端口，
 * 于是"本想给 --port 传值"的笔误，就变成"对**默认 profile + 默认端口**执行动作"——
 * 在 `--uninstall` 这种会删全局 `DSHWeb*` 的命令上，这是破坏性的静默回落。
 */
export function validatePortValue(raw, { flag = "--port", min = 1, max = 65535 } = {}) {
	return validateIntegerValue(raw, { flag, min, max });
}

// ---------------------------------------------------------------- 目标校验

/**
 * 目标目录是不是一个**像样的 DSH profile**？
 *
 * 为什么需要它（t14 实测的破坏性缺口）：`--uninstall` 除了停本 profile 的守护，还会删
 * `HKCU\...\Run` 下**全局**的 `DSHWeb*` 自启值。如果 `--profile` 漏了取值（例如
 * `--uninstall --profile --port 63001` 会把 `"--port"` 当 profile、端口回落默认 3081），
 * 命令仍会走到那一步并以 exit 0 报"卸载完成" —— 在不受限会话里这就是一次**全局注册表删除**。
 * 因此执行任何全局性动作前，先确认目标真的存在、是目录、且有 profile 的身份文件。
 *
 * 判定：存在 + 是目录 + 至少有 `package.json` / `cordis.yml` / `cordis.yaml` / `cordis.patch.yml` 之一。
 * @returns {{ok:boolean, reason:string|null, marker:string|null}}
 */
export function looksLikeProfileDir(dir) {
	if (typeof dir !== "string" || dir.trim() === "") {
		return { ok: false, reason: "profile 路径为空", marker: null };
	}
	let stat;
	try { stat = statSync(dir); }
	catch { return { ok: false, reason: `目标不存在：${dir}`, marker: null }; }
	if (!stat.isDirectory()) return { ok: false, reason: `目标不是目录（是文件？）：${dir}`, marker: null };
	for (const marker of ["package.json", "cordis.yml", "cordis.yaml", "cordis.patch.yml"]) {
		if (existsSync(join(dir, marker))) return { ok: true, reason: null, marker };
	}
	return { ok: false, reason: `目录里没有 package.json / cordis*.yml（不像 DSH profile）：${dir}`, marker: null };
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

// ---------------------------------------------------------------- 本地 API 防护（审计③ L11）
/**
 * 背景（审计③ L11）：open-boot 的 `/api/boot` 与救援页的 `/api/start|stop|fix` 原来只校验 method，
 * 于是**用户浏览的任意网页**都能用简单 POST 触发"启动引擎 / 隔离插件 / 杀引擎"（响应读不到，
 * 副作用照旧）；同时 `/api/boot` 没有单飞，刷新/双击可并发拉起多个启动窗口与多个引擎。
 *
 * 三道检查（①②在 guardWriteRequest，③在 createSingleFlight）：
 *  ① Origin：为空（非浏览器/本地工具）或属于本服务的**同机同端口白名单**（见 allowedOriginsOf）；其他一律 403。
 *  ② 一次性令牌：服务启动时随机生成，注入页面 `<meta name="dsh-pm-token">`，写请求带 `X-DSH-PM-Token`；
 *     缺失/不匹配 → 401。令牌**只**存在于内存、页面 meta 与请求头，绝不写日志或 profile 文件。
 *  ③ 单飞：同一时刻只允许一个 boot/start，并发第二个 → 409（不会重复拉起引擎）。
 * 读取类接口（GET /api/status、/api/verify）**不做**这三道检查。
 */

/** 一次性 API 令牌：每次服务启动随机生成（48 hex 字符）。 */
export function newApiToken() {
	return randomBytes(24).toString("hex");
}

/**
 * 写接口允许的同源 Origin 白名单（**同机 + 同端口**的等价主机名）。
 *
 * 为什么把 `localhost` 与 `127.0.0.1`（以及 `[::1]`）视为等价：
 *  - 三者都指向本机回环接口 —— `localhost` 通常解析到 `127.0.0.1`（或 `::1`），浏览器
 *    在地址栏输入 `http://localhost:3081/` 时，页面自身发出的 POST 带的是
 *    `Origin: http://localhost:3081`。若只认 `127.0.0.1`，用户在**自己的机器**上打开
 *    启动页反而被判成"跨站来源"→ 403，"打开浏览器即自动 自检→修复→启动"直接失效（t8 终审 F1）。
 *  - **端口必须与本服务监听端口一致**：`http://localhost:其他端口` 仍按第三方处理。
 *
 * 为什么不能改成"按 Host 头派生白名单"或"没有 Origin 就放行"：
 *  - 跨站页面可以伪造 `Host`/`Referer`，也可以发起不带 Origin 的简单请求；按它们放开
 *    等于把"只允许本机自身页面"降级成"允许任意网页触发启动/隔离/杀引擎"（DNS rebinding 面）。
 *  - 因此这里只认**固定的三个回环主机名 + 服务自己的端口**，其余一律 403。
 */
export function allowedOriginsOf(port) {
	return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

/** 同源 Origin 的主入口写法（保留旧 API：白名单第一项 = 规范形式）。 */
export function sameOriginOf(port) {
	return allowedOriginsOf(port)[0];
}

/** 定长常量时间比较，避免令牌逐字符早退。 */
function tokenEquals(got, expected) {
	if (typeof got !== "string" || typeof expected !== "string") return false;
	const a = Buffer.from(got, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length === 0 || a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * 写接口防护①②：Origin + 一次性令牌。
 * @returns {null|{status:number, message:string, code:number}} null = 通过；否则是应答码与原因
 */
export function guardWriteRequest(req, { port, token } = {}) {
	const headers = req && req.headers ? req.headers : {};
	const origin = headers.origin;
	const allowed = allowedOriginsOf(port);
	if (typeof origin === "string" && origin.trim() !== "" && !allowed.includes(origin.trim())) {
		return {
			status: 403, code: 403,
			message: `跨站来源被拒：Origin=${origin}（只允许同机同端口 ${allowed.join(" / ")}，或没有 Origin 的非浏览器请求）`
		};
	}
	const got = headers["x-dsh-pm-token"];
	if (typeof got !== "string" || got.trim() === "") {
		return { status: 401, code: 401, message: "缺少 X-DSH-PM-Token（页面 meta[name=dsh-pm-token] 里的一次性令牌）" };
	}
	if (!tokenEquals(got.trim(), token)) {
		return { status: 401, code: 401, message: "X-DSH-PM-Token 不匹配（服务重启后令牌会变，请刷新页面重试）" };
	}
	return null;
}

/**
 * 单飞闸门（写接口防护③）：boot/start 同一时刻只允许一个在跑。
 * tryEnter() 同步占位（在第一个 await 之前），因此并发请求里后到者一定看到 busy。
 */
export function createSingleFlight(label = "boot") {
	let current = null;
	return {
		get busy() { return current !== null; },
		get current() { return current; },
		/** @returns {{ok:true, entry:object}|{ok:false, waited:number, current:object}} */
		tryEnter(tag = label) {
			if (current !== null) return { ok: false, waited: Date.now() - current.startedAt, current };
			const entry = { tag, label, startedAt: Date.now(), pid: process.pid };
			current = entry;
			return { ok: true, entry, current: entry };
		},
		leave(entry) {
			if (entry === void 0 || entry === current) current = null;
		}
	};
}

// ---------------------------------------------------------------- 弹窗启动（C-05）

/** 弹窗启动的「立即失败」观察窗口：这段时间内出现 error / 非 0 退出 → 判失败。 */
export const LAUNCH_GRACE_MS = 3000;

/** POSIX 单引号转义（写 `.command` 脚本用；Windows 分支不用它）。 */
export function shQuote(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * macOS 弹窗启动脚本（`.command`，Terminal.app 可直接双击/被 `open` 打开）。
 *
 * **为什么不再把 shell 命令行递给 `open`（审计 C-05，high）**：
 * `open` 的参数必须是**文件/路径/URL**。旧代码 `open -a Terminal "<一串 shell 命令行>"` 把命令串
 * （还带着自己加的引号）当成了文件名 → `open` 报错退出，而旧代码照样 `return {ok:true}` —— **静默假成功**：
 * 救砖面板/日志显示"已弹出启动窗口"，实际上引擎根本没被拉起来。
 * 正确姿势：把命令写成 `.command` 脚本（`chmod 755`），再让 `open` 打开**那个文件**。
 * 脚本正文**纯 ASCII**（避免不同终端/区域设置下的编码歧义）。
 */
export function buildBootWindowScript({ execPath = process.execPath, bootArgs = [], workDir = "", label = "dsh-plugin-manager-pro" } = {}) {
	const lines = [
		"#!/bin/sh",
		`# ${label} boot window (generated by bin/open-boot.mjs; ASCII only on purpose)`,
		workDir ? `cd ${shQuote(workDir)} || exit 1` : null,
		`exec ${shQuote(execPath)} ${(Array.isArray(bootArgs) ? bootArgs : []).map(shQuote).join(" ")}`
	];
	return lines.filter((line) => line !== null).join("\n") + "\n";
}

/**
 * Linux 终端候选表：**每一家用它自己支持的参数形态**（C-05 的关键修正）。
 *  - `gnome-terminal`：`-e` 在 GNOME 42+/gnome-terminal 3.44+ **已被移除** → 必须用 `--`；
 *  - `x-terminal-emulator`：Debian/Ubuntu 的 alternatives 包装器按 Debian 政策**必须支持 `-e`**
 *    （Ubuntu 上它指向 `gnome-terminal.wrapper`，会把 `-e` 翻译成 `--`）→ 首选；
 *  - `konsole` / `xfce4-terminal` / `xterm`：`-e` 形态仍然有效。
 * 顺序 = 先"适配过 `-e` 的包装器/兼容性最好的入口"，再退到具体终端。
 */
export const BOOT_TERMINALS = [
	{ name: "x-terminal-emulator", args: (cmd) => ["-e", ...cmd], form: "-e（Debian/Ubuntu alternatives 包装器）" },
	{ name: "gnome-terminal", args: (cmd) => ["--", ...cmd], form: "--（GNOME 42+ 已移除 -e）" },
	{ name: "konsole", args: (cmd) => ["-e", ...cmd], form: "-e" },
	{ name: "xfce4-terminal", args: (cmd) => ["-e", ...cmd], form: "-e" },
	{ name: "xterm", args: (cmd) => ["-e", ...cmd], form: "-e" }
];

/**
 * 弹窗启动的**命令构造（纯函数）**——macOS/Linux 分支在 Windows 上也能单测（C-05 的验收要求）。
 * @param {object} [options]
 * @param {string} [options.platform] process.platform
 * @param {string} [options.execPath] 用来跑启动序列的 node 可执行文件
 * @param {string[]} [options.bootArgs] dsh-boot.mjs 及其参数
 * @param {string} [options.workDir] 窗口进程的工作目录（稳定目录，见 L2）
 * @param {string|null} [options.scriptPath] darwin：`.command` 脚本的绝对路径（**必填**）
 * @param {string[]|null} [options.available] linux：`command -v` 探测到的终端名（null = 未探测 → 按默认全列）
 * @param {string} [options.comspec] win32：cmd.exe 路径（默认 ComSpec）
 * @returns {{ok:boolean, kind:string, candidates:Array<{command:string,args:string[],via:string,form:string}>, script:string|null, scriptPath:string|null, reason:string|null}}
 */
export function bootWindowPlan({
	platform = process.platform,
	execPath = process.execPath,
	bootArgs = [],
	workDir = "",
	scriptPath = null,
	available = null,
	comspec = null
} = {}) {
	const args = Array.isArray(bootArgs) ? bootArgs : [];
	if (platform === "win32") {
		return {
			ok: true, kind: "windows", script: null, scriptPath: null, reason: null,
			// `cmd /c start "" ...` 是 Windows 上唯一可靠的「新建可见控制台」方式。
			// 注意不要用隐藏 PowerShell（部分杀软会直接拦截并删除脚本）。
			candidates: [{
				command: comspec || process.env.ComSpec || "cmd.exe",
				args: ["/c", "start", "", "/D", workDir, execPath, ...args],
				via: "cmd /c start", form: "新建可见控制台窗口"
			}]
		};
	}
	if (platform === "darwin") {
		if (typeof scriptPath !== "string" || scriptPath === "") {
			return {
				ok: false, kind: "darwin", candidates: [], script: null, scriptPath: null,
				reason: "缺少 macOS 启动脚本路径（.command）——不能退回 `open -a Terminal <shell 命令行>`：open 只接受文件/路径/URL（C-05）"
			};
		}
		const escaped = scriptPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return {
			ok: true, kind: "darwin", scriptPath, reason: null,
			script: buildBootWindowScript({ execPath, bootArgs: args, workDir }),
			candidates: [
				{ command: "open", args: ["-a", "Terminal", scriptPath], via: "open -a Terminal <script.command>", form: "让 Terminal 打开脚本文件（不是命令行）" },
				{ command: "osascript", args: ["-e", `tell application "Terminal" to do script "${escaped}"`, "-e", 'tell application "Terminal" to activate'], via: "osascript Terminal do script", form: "AppleScript 兜底" }
			]
		};
	}
	if (platform === "linux") {
		const names = Array.isArray(available) ? available : BOOT_TERMINALS.map((term) => term.name);
		const candidates = BOOT_TERMINALS
			.filter((term) => names.includes(term.name))
			.map((term) => ({ command: term.name, args: term.args([execPath, ...args]), via: `终端 ${term.name}`, form: term.form }));
		if (candidates.length === 0) {
			return {
				ok: false, kind: "linux", candidates: [], script: null, scriptPath: null,
				reason: `未找到可用的终端模拟器（已探测：${BOOT_TERMINALS.map((term) => term.name).join(" / ")}）`
			};
		}
		return { ok: true, kind: "linux", candidates, script: null, scriptPath: null, reason: null };
	}
	// 未知平台（freebsd / aix …）：给出**明确结论**，不假装成功（调用方会退回静默启动）
	return {
		ok: false, kind: platform, candidates: [], script: null, scriptPath: null,
		reason: `不支持的平台 ${platform}：弹窗启动不可用（引擎仍可静默启动）`
	};
}

/** Linux：用 `command -v` 探测可用终端（名字来自硬编码表，无注入面）。 */
export function detectAvailableTerminals({ run = (command, cmdArgs) => spawnSync(command, cmdArgs, { stdio: "ignore" }), candidates = BOOT_TERMINALS } = {}) {
	const found = [];
	for (const term of candidates) {
		let result = null;
		try { result = run("sh", ["-c", `command -v ${term.name}`]); } catch { result = null; }
		if (result && !result.error && result.status === 0) found.push(term.name);
	}
	return found;
}

/**
 * 等待并**校验**启动器子进程的结局：只看真事实（`error` 事件 / 退出码 / 端口是否真的出现监听者）。
 * 语义：立即非 0 退出或 spawn error → `ok:false`；仍在运行或在观察窗口内正常退出 → `ok:true`。
 * @returns {Promise<{ok:boolean, verdict:"exit-0"|"still-running"|"port-listening"|"exit-nonzero"|"spawn-error"|"no-child", exitCode:number|null, signal:string|null, reason:string|null}>}
 */
export function verifyLauncherExit(child, { label = "弹窗启动器", graceMs = LAUNCH_GRACE_MS, probePort = null, probeFn = null, stepMs = 250 } = {}) {
	return new Promise((resolveVerdict) => {
		if (!child || typeof child.once !== "function") {
			resolveVerdict({ ok: false, verdict: "no-child", exitCode: null, signal: null, reason: `${label}没有拿到子进程对象` });
			return;
		}
		let settled = false;
		let timer = null;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearInterval(timer);
			resolveVerdict(result);
		};
		// **必须先挂监听再判断 pid**：`spawn` 打不开可执行文件时（ENOENT/EINVAL）返回的 child 是
		// `pid === undefined`，而 error 事件是**异步**发出的；若此时提前 resolve 而不挂 error 监听，
		// Node 会以"未处理的 error 事件"**直接崩掉宿主进程**（实测：spawn 一个不存在的终端命令）。
		child.once("error", (error) => finish({
			ok: false, verdict: "spawn-error", exitCode: null, signal: null,
			reason: `${label}启动失败：${error?.code ? `${error.code} ` : ""}${error?.message ?? String(error)}`
		}));
		child.once("exit", (code, signal) => {
			if (code === 0) finish({ ok: true, verdict: "exit-0", exitCode: 0, signal: null, reason: null });
			else finish({
				ok: false, verdict: "exit-nonzero", exitCode: code ?? null, signal: signal ?? null,
				reason: `${label}退出异常（exit ${code}${signal ? ` / ${signal}` : ""}）`
			});
		});
		const deadline = Date.now() + Math.max(200, graceMs);
		timer = setInterval(async () => {
			if (settled) return;
			if (child.pid === void 0 || child.pid === null) {
				// 既没有 pid、error 事件也一直没来（异常情形）→ 过了窗口就明确判失败，绝不假成功
				if (Date.now() >= deadline) {
					finish({ ok: false, verdict: "no-child", exitCode: null, signal: null, reason: `${label}没有拿到子进程（spawn 未返回 pid，且没有 error 事件）` });
				}
				return;
			}
			if (probePort !== null && typeof probeFn === "function") {
				let up = false;
				try { up = Boolean(await probeFn(probePort)); } catch { up = false; }
				if (settled) return;
				if (up) { finish({ ok: true, verdict: "port-listening", exitCode: null, signal: null, reason: null }); return; }
			}
			if (Date.now() >= deadline) finish({ ok: true, verdict: "still-running", exitCode: null, signal: null, reason: null });
		}, stepMs);
	});
}

/**
 * 逐个尝试候选启动命令，**校验子进程的 error/exit**：只有确认"没有立刻失败"才报成功。
 * 每个候选失败都会把原因（含 stderr 尾巴）记进 `attempts`，全部失败 → `ok:false`（调用方退回静默启动）。
 * @returns {Promise<{ok:boolean, via:string|null, verdict:object|null, attempts:Array, reason:string|null, evidence:string|null}>}
 */
export async function launchViaCandidates(candidates, {
	spawnFn = spawn,
	cwd = void 0,
	graceMs = LAUNCH_GRACE_MS,
	probePort = null,
	probeFn = null,
	stderrPath = null,
	readStderrText = null
} = {}) {
	const attempts = [];
	const list = Array.isArray(candidates) ? candidates : [];
	if (list.length === 0) {
		return { ok: false, via: null, verdict: null, attempts, reason: "没有可用的启动命令候选（终端/启动器都没找到）", evidence: null };
	}
	for (const candidate of list) {
		if (!candidate || typeof candidate.command !== "string" || candidate.command === "") {
			attempts.push({ via: candidate?.via ?? "?", ok: false, reason: "候选命令为空" });
			continue;
		}
		let fd = null;
		let stdio = "ignore";
		if (typeof stderrPath === "string" && stderrPath !== "") {
			// stderr 落盘而不是走管道：受限会话里 Node 的默认管道 stdio 会 EPERM（仓库既有约定）
			try { fd = openSync(stderrPath, "w"); stdio = ["ignore", "ignore", fd]; } catch { fd = null; stdio = "ignore"; }
		}
		let child = null;
		try {
			child = spawnFn(candidate.command, candidate.args, { detached: true, stdio, cwd: cwd === "" ? void 0 : cwd, windowsHide: false });
		} catch (error) {
			if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
			attempts.push({ via: candidate.via, ok: false, reason: `spawn 抛错：${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		if (fd !== null) { try { closeSync(fd); } catch { /* 子进程已继承该 fd */ } }
		const verdict = await verifyLauncherExit(child, { label: candidate.via, graceMs, probePort, probeFn });
		try { child.unref(); } catch { /* 已退出 */ }
		const stderrTail = typeof readStderrText === "function"
			? String(readStderrText() ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")
			: "";
		if (verdict.ok) {
			const evidence = verdict.verdict === "port-listening"
				? `端口 ${probePort} 已出现监听者`
				: verdict.verdict === "exit-0" ? "启动器 exit 0" : "启动器仍在运行（未立即失败）";
			attempts.push({ via: candidate.via, ok: true, verdict: verdict.verdict, exitCode: verdict.exitCode });
			return { ok: true, via: candidate.via, verdict, attempts, reason: null, evidence };
		}
		attempts.push({ via: candidate.via, ok: false, reason: verdict.reason, detail: stderrTail || null });
	}
	return {
		ok: false, via: null, verdict: null, attempts, evidence: null,
		reason: attempts.map((item) => `${item.via}：${item.reason}${item.detail ? `（stderr: ${item.detail}）` : ""}`).join("；")
	};
}
