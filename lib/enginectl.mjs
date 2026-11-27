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
 * v1.1.0（桌面版支持 M2，契约 F1/F2）：
 *  - `allowedOriginsOf(port, { allowDesktopApp })` 与 `guardWriteRequest(..., { allowDesktopApp, allowNullOrigin,
 *    desktopToken })` 支持桌面版渲染进程的页面来源 `dsh-app://app`（Electron 从打包静态资源加载，**不是 HTTP 源**）。
 *    **默认关**：只有显式允许时才多认这一个固定自定义协议源；web 场景返回值与判定结果逐字节不变。
 *  - 新增 `mintDesktopToken()` / `guardDesktopToken()` / `writeOriginPolicyFromEnv()`：桌面版页面拿不到
 *    `<meta name="dsh-pm-token">` 里的令牌，令牌改由宿主进程生成后经环境变量同时交付服务与桌面页面。
 *    令牌纪律不变：只存在于内存/请求头，**绝不写日志、绝不写 profile 文件**。
 * v1.1.0（桌面版 CORS 预检闭环 M6 / S6，S2 遗留 P0）：
 *  - 新增 `corsPreflightResponse(req, { allowDesktopApp, port })` / `corsAllowedOrigin()` /
 *    `corsResponseHeaders()`：真包 `main.js` 把 `dsh-app` 注册为 `corsEnabled: true`，桌面页面
 *    （来源 `dsh-app://app`）带自定义头 `X-DSH-PM-Token` 跨源 fetch 3081/3082 时**浏览器必定先发
 *    OPTIONS 预检**；旧实现不应答 OPTIONS、也不回 `Access-Control-Allow-*`，请求在浏览器端就被拦掉。
 *    **只新增导出**，S2 的 `allowedOriginsOf` / `guardWriteRequest` 判定与令牌逻辑一行未改；
 *    预检分支必须排在令牌校验**之前**（CORS 规范：预检请求不带凭据/令牌）。
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
import { enginePortFromEnv, LAUNCHER_PID_APP } from "./ports.mjs";

/**
 * 引擎端口。契约默认 **3080**。
 * `DSH_ENGINE_PORT` 是显式的**测试/多实例**逃生门：启动器链路里"启动/停止引擎"这类用例
 * 必须能避开真机引擎（否则单测会真的动 3080），CI 里也不该依赖本机 3080 是否在跑。
 * 推导逻辑集中在 `lib/ports.mjs`（与启动器/救援守护共用同一份事实来源）。
 */
export const ENGINE_PORT = enginePortFromEnv();
const LOG_FILE = "rescue-daemon.log";
const PID_FILE = ".rescue-daemon.pid";

/** PID 文件里的身份标记：只有本工具启动的引擎才带它。 */
export const PID_APP = "dsh-web-engine";
/** 启动器（open-boot）写进 /api/status 的身份标记。 */
export const LAUNCHER_APP = LAUNCHER_PID_APP;
/** 救援守护（rescue-daemon）写进 /api/status 的身份标记。 */
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

/** 端口上的服务是不是本工具的启动器/救援守护（HTTP 握手 + /api/status 身份字段）。 */
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

/**
 * 1.0.0-rc.1：引擎 stdout/stderr 的追加落盘位置 —— `<DSH_HOME>/logs/web.log`。
 * 引擎把带 token 的入口 URL 只打印在 stdout 上；不落盘的话启动器/升级脚本就拿不到
 * 可验证的登录链接（401 空窗的根因）。路径一律从 DSH_HOME（缺省 ~/.dsh）推导，不硬编码。
 */
export function engineWebLogPath() {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "logs", "web.log");
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
	// logFd 支持 [stdoutFd, stderrFd] 双 fd（1.0.0-rc.1：stdout→web.log 保 token URL，stderr→rescue-daemon.log 保诊断），
	// 也兼容单 fd（两路同写）与 null（全 ignore）。
	const stdio = logFd === null ? "ignore" : Array.isArray(logFd) ? ["ignore", ...logFd] : ["ignore", logFd, logFd];
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
	// 1.0.0-rc.1：stdout 追加写 <DSH_HOME>/logs/web.log（引擎把带 token 的入口 URL 只打在 stdout，
	// 落盘后启动器/升级脚本才有可验证的登录链接）；stderr 仍进 profile 的 rescue-daemon.log（诊断用）。
	const logPath = join(profileDir, LOG_FILE);
	let logFd;
	try { logFd = openSync(logPath, "a"); }
	catch (error) { return { ok: false, message: `无法打开引擎日志 ${logPath}：${error.message}`, log: logPath }; }
	let webLogFd = null;
	try { webLogFd = openSync(engineWebLogPath(), "a"); }
	catch { webLogFd = null; /* web.log 打不开不阻塞启动：stderr 仍有诊断日志 */ }

	let child;
	try {
		child = spawnEngineProcess({ dshCmd, args: ["web", "--port", String(port), "--no-open"], cwd: engineCwd, logFd: webLogFd === null ? logFd : [webLogFd, logFd] });
	} catch (error) {
		try { closeSync(logFd); } catch { /* ignore */ }
		try { if (webLogFd !== null) closeSync(webLogFd); } catch { /* ignore */ }
		return { ok: false, message: `无法启动引擎（${dshCmd}）：${error.message}`, log: logPath };
	}
	try { closeSync(logFd); } catch { /* 子进程已继承 fd */ }
	try { if (webLogFd !== null) closeSync(webLogFd); } catch { /* 子进程已继承 fd */ }
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
 * 读进程创建时间（Windows：Win32_Process.CreationDate；其他平台返回 ok:false=无法比对）。
 * rc.2 P0-1/P2-7：与 PID 文件里本工具写入的 `startedAt` 做 ±10s 比对，pid 被系统复用时会暴露。
 */
export function processCreationDate(pid) {
	try {
		if (process.platform !== "win32") return { ok: false, date: null, reason: "非 Windows 平台无法读取 CreationDate" };
		const target = Number(pid);
		if (!Number.isInteger(target) || target <= 0) return { ok: false, date: null, reason: `非法 pid：${pid}` };
		const out = spawnSync("powershell", ["-NoProfile", "-Command",
			`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${target}').CreationDate.ToString('o')`],
			{ windowsHide: true, encoding: "utf8", timeout: 10000 });
		if (out.error) return { ok: false, date: null, reason: `powershell 不可用（${out.error.code ?? "spawn-error"}）` };
		const text = String(out.stdout || "").trim();
		if (out.status !== 0 || !text) return { ok: false, date: null, reason: `CreationDate 查询失败（exit ${out.status}）` };
		const date = new Date(text);
		if (Number.isNaN(date.getTime())) return { ok: false, date: null, reason: `CreationDate 无法解析：${text.slice(0, 60)}` };
		return { ok: true, date, reason: null };
	} catch (error) {
		return { ok: false, date: null, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 结束一个**已通过身份校验**的引擎 pid，并清理它的直接子进程（rc.2 P0-1 树杀收敛）：
 *   ① 主进程：taskkill /PID <pid> /F —— **绝不带 /T**（审计③ 装机教训：/T 会连整棵树一起杀）；
 *   ② 子进程：Get-CimInstance 枚举 ParentProcessId = <pid> 的直接子进程，**逐个**校验
 *      （映像名是 node 且命令行包含本 profile 目录路径）后才单独 taskkill——任何一项不过就跳过。
 * @returns {{ ok, killed: number[], skipped: {pid,name,reason}[], error: string|null }}
 */
export function killEngineTreeChecked(profileDir, pid) {
	const killOne = (target) => spawnSync("taskkill", ["/PID", String(target), "/F"], { windowsHide: true, encoding: "utf8" });
	const main = killOne(pid);
	if (main.status !== 0) {
		return { ok: false, killed: [], skipped: [], error: `taskkill ${pid} 失败（exit ${main.status}）：${String(main.stderr || main.stdout || "").trim()}` };
	}
	const killed = [Number(pid)];
	const skipped = [];
	try {
		const out = spawnSync("powershell", ["-NoProfile", "-Command",
			`Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${Number(pid)}' | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`],
			{ windowsHide: true, encoding: "utf8", timeout: 10000 });
		let rows = [];
		if (out.status === 0 && String(out.stdout || "").trim()) {
			const parsed = JSON.parse(out.stdout);
			rows = Array.isArray(parsed) ? parsed : [parsed];
		}
		const profileNorm = String(profileDir || "").replace(/\//g, "\\").toLowerCase();
		for (const row of rows) {
			const childPid = Number(row?.ProcessId);
			const name = String(row?.Name || "");
			const cmdLine = String(row?.CommandLine || "");
			if (!Number.isInteger(childPid) || childPid <= 0) continue;
			const looksNode = /^node(\.exe)?$/i.test(name);
			const inProfile = profileNorm !== "" && cmdLine.replace(/\//g, "\\").toLowerCase().includes(profileNorm);
			if (looksNode && inProfile) {
				const childKill = killOne(childPid);
				if (childKill.status === 0) killed.push(childPid);
				else skipped.push({ pid: childPid, name, reason: `taskkill 失败（exit ${childKill.status}）` });
			} else {
				skipped.push({ pid: childPid, name, reason: looksNode ? "命令行不含本 profile 路径" : "映像不是 node" });
			}
		}
	} catch { /* 子进程枚举失败不影响"主进程已结束"这一事实，主流程继续 */ }
	return { ok: true, killed, skipped, error: null };
}

/**
 * rc.2 P1-4：结束**本函数自己启动**的 pnpm 子树（超时兜底，唯一允许 /T 的场景——
 * 子树是自己的，/T 不会连坐任何无关进程）。win32 taskkill /PID <pid> /T /F；
 * 非 win32 对进程组发 SIGKILL。调用方必须自己确认死亡（isAlive 循环），本函数只负责"动手"。
 */
export function killTreeForce(pid) {
	try {
		if (process.platform === "win32") {
			const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
			return { ok: r.status === 0, detail: String(r.stderr || r.stdout || "").trim() };
		}
		try { process.kill(-pid, "SIGKILL"); return { ok: true, detail: "" }; }
		catch { try { process.kill(pid, "SIGKILL"); return { ok: true, detail: "" }; } catch (e) { return { ok: false, detail: e.message }; } }
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 结束引擎。多重校验后才动手，避免 PID 复用误杀无关进程树：
 *   ① pid 存活  ② 进程镜像像 dsh/node  ③ 端口占用者与记录 pid 一致（有监听者时）；
 *   端口无监听者时，只在"PID 文件由本工具写入（带 app 标记）"的情况下才允许结束；
 *   ④ startedAt ↔ CreationDate ±10s 比对（rc.2 P2-7）：不符 = pid 几乎肯定被系统复用。
 * 校验不过 → 拒绝并返回 reasons（可传 force:true 显式强制）；
 * 其中 ④ 属**致命校验**：即使 force:true 也拒绝（P0-1：复用 pid 的 force 杀就是误杀）。
 * 结束动作（rc.2 P0-1）：win32 用 killEngineTreeChecked（主 pid 不带 /T，子进程逐个校验后杀），
 * 不再把整棵进程树连坐。
 */
export async function stopEngine(profileDir, { force = false, port = ENGINE_PORT } = {}) {
	const info = readPidInfo(profileDir);
	if (!info) {
		return { ok: false, refused: true, message: `未找到 PID 文件（${join(profileDir, PID_FILE)}），无法确认引擎进程，未执行任何结束操作。` };
	}
	const pid = Number(info.pid);
	const ownerProbe = portOwnerProbe(port);
	const owner = ownerProbe.ok ? ownerProbe.pid : null;
	const image = processImage(pid);
	const alive = isAlive(pid);
	const identity = describeEngineProcess(pid, port);
	const reasons = [];
	const fatalReasons = [];

	if (!alive) reasons.push(`pid ${pid} 已不存在（PID 文件陈旧，或 pid 已被系统复用）`);
	if (!looksLikeEngineImage(image)) reasons.push(`pid ${pid} 的进程镜像是 ${image}，不是 dsh/node`);
	if (!ownerProbe.ok) reasons.push(`端口 ${port} 占用探测不可用（${ownerProbe.reason ?? "未知"}）：读不到端口归属 ≠ 没有占用者，不据此放行`);
	else if (owner !== null && owner !== pid) reasons.push(`端口 ${port} 的占用者是 pid ${owner}，与记录的 pid ${pid} 不一致`);
	else if (owner === null && alive) {
		if (info.legacy || info.app !== PID_APP) reasons.push(`端口 ${port} 没有监听者，且 PID 文件缺少本工具的身份标记（旧格式/非本工具写入），无法确认 pid ${pid} 就是上次启动的引擎`);
	}
	// ④ startedAt ↔ CreationDate（致命）：本工具写 PID 时记录了 startedAt，进程复用会在 ±10s 之外现形。
	if (!info.legacy && typeof info.startedAt === "string" && info.startedAt) {
		const recorded = new Date(info.startedAt);
		if (!Number.isNaN(recorded.getTime())) {
			const creation = processCreationDate(pid);
			if (creation.ok) {
				const skewMs = Math.abs(creation.date.getTime() - recorded.getTime());
				if (skewMs > 10000) {
					fatalReasons.push(`PID 文件记录的启动时间（${info.startedAt}）与进程 ${pid} 的实际创建时间（${creation.date.toISOString()}）相差 ${Math.round(skewMs / 1000)}s —— pid 极可能已被系统复用，即使 force 也拒绝结束`);
				}
			} else if (alive) {
				reasons.push(`无法读取进程 ${pid} 的创建时间（${creation.reason}），本次跳过 startedAt 身份比对`);
			}
		}
	}

	if (fatalReasons.length > 0 || (reasons.length > 0 && !force)) {
		return {
			ok: false, refused: true, pid, port, owner, image, identity: identity.text,
			reasons: [...fatalReasons, ...reasons], fatal: fatalReasons.length > 0,
			message: `拒绝结束进程：${[...fatalReasons, ...reasons].join("；")}。${identity.text}。\n` +
				`（这是防止 PID 复用误杀无关进程的保护。${fatalReasons.length > 0
					? "上面标致命的比对不过时强制也不会放行：请人工在任务管理器里确认该 pid 的身份后再处理。"
					: "确认无误后可强制结束：rescue 页面点\"强制停止\"，或调用 stopEngine(dir,{force:true}) / POST /api/stop {\"force\":true}。"}）`
		};
	}

	try {
		if (process.platform === "win32") {
			const tree = killEngineTreeChecked(profileDir, pid);
			if (!tree.ok) {
				return { ok: false, refused: false, pid, port, owner, image, identity: identity.text, checks: reasons, message: tree.error };
			}
			removePidIfMatches(profileDir, pid);
			const treeNote = tree.killed.length > 1
				? `，连同 ${tree.killed.length - 1} 个已校验的 node 子进程（profile 路径匹配）`
				: "";
			const skipNote = tree.skipped.length > 0
				? `；跳过 ${tree.skipped.length} 个不匹配校验的子进程（${tree.skipped.map((s) => `${s.pid}:${s.reason}`).join("，")}）`
				: "";
			return {
				ok: true, force, pid, port, owner, image, identity: identity.text, checks: reasons,
				killed: tree.killed, skipped: tree.skipped,
				message: `${force && reasons.length > 0 ? "已强制结束" : "已结束"}引擎进程 ${pid}（${identity.text}）${treeNote}${skipNote}。`
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
 *  ① Origin：为空（非浏览器/本地工具）或属于本服务的**同机同端口白名单**（见 allowedOriginsOf）；
 *     桌面版（v1.1.0 M2，契约 F1/F2）在**显式允许**（allowDesktopApp）时额外接受自定义协议源
 *     `dsh-app://app`；`Origin: null` 要再显式开一级（allowNullOrigin）且只认桌面令牌；其他一律 403。
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
 * 桌面版渲染进程的页面来源（v1.1.0 M2，契约 F1/F2）。
 *
 * 依据（官方一手文档 `apps/desktop/README.zh.md` L40/L42，见 `docs/桌面版移植-1.1.0设计.md` F1/F2）：
 *  - "桌面应用是完整 dsh Web 应用外的一层 Electron 壳……Electron 立即从 `dsh-app://app/` 加载打包内的
 *    Web 入口" → 桌面页面的来源是**自定义协议 `dsh-app://app`**，不是任何 `http(s)://` 源；
 *  - "Desktop 默认监听系统分配的端口" → 桌面 Host 端口随机，桌面页面调**本模块守护的固定端口**
 *    （3081 启动器 / 3082 救援守护）时是跨源请求，`Origin` 就是 `dsh-app://app`（或 Chromium 对
 *    不透明来源序列化出的 `null`）。
 *
 * 后果（P0）：不改的话，桌面版里救援球 / 维护页签 / `/plugins` 的启停/重启会被自家白名单判成
 * "跨站来源"全部 403 —— 桌面版变成只读空壳。
 *
 * 为什么只加**这一个固定来源**、且默认关闭：
 *  - 它是自定义协议源，普通网页无法把 `Origin` 伪造成 `dsh-app://app`（`Origin` 由浏览器按页面
 *    自身的源填写；网页只能伪造自己的源，伪造不了别人的源），因此不会把"允许任意网页触发写操作"放开；
 *  - 但仍可能撞上 `PROTECTED_PLUGINS` / 第三方 `dsh-app:` 页面，所以**默认关**、只认固定 host；
 *    **绝不**通配 `http(s)://` 第三方源，也**不**拿"没有 Origin 就放行"（DNS rebinding 面）兜底。
 */
export const DESKTOP_APP_ORIGIN = "dsh-app://app";

/** `Origin: null`（沙箱 iframe / file:// 页面把不透明来源序列化成 null）——比桌面来源危险得多。 */
const NULL_ORIGIN = "null";

/**
 * Origin 规范形：去首尾空白、大小写折叠（scheme/host 大小写不敏感，RFC 3986 §3.1/§3.2.2）、
 * 去末尾的 "/"（`dsh-app://app/` 与 `dsh-app://app` 是同一个源；HTTP 源同理）。
 * 只做这四种规范化，**不解析路径/端口**：其他任何差异都落回"不在白名单"。
 */
function normalizeOrigin(value) {
	if (typeof value !== "string") return "";
	let origin = value.trim().toLowerCase();
	while (origin.endsWith("/")) origin = origin.slice(0, -1);
	return origin;
}

/**
 * 写接口允许的同源 Origin 白名单（**同机 + 同端口**的等价主机名）—— web 场景的唯一来源集合。
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
 *  - 因此这里默认只认**固定的三个回环主机名 + 服务自己的端口**，其余一律 403；
 *    桌面版要靠 `DESKTOP_APP_ORIGIN` 的**显式开关**（allowDesktopApp）才多认一个自定义协议源。
 * @param {number|string} port 本服务监听端口
 * @param {{allowDesktopApp?: boolean}} [options] 桌面版（v1.1.0 M2）：为 true 时在末尾追加
 *   `dsh-app://app`（唯一允许的桌面自定义协议源）；**默认 false**。
 */
export function allowedOriginsOf(port, { allowDesktopApp = false } = {}) {
	const loopback = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
	// **零回归硬断言**：不传选项时必须与 1.0.x 逐字节一致（同序同值，见 test-origin.mjs 第一条）。
	if (allowDesktopApp !== true) return loopback;
	return [...loopback, DESKTOP_APP_ORIGIN];
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
 * 桌面版令牌（契约 F2）：桌面版页面拿不到浏览器里的 `<meta name="dsh-pm-token">` —— 那个 meta 只在
 * 3081/3082 自己吐出的 HTML 里，而桌面页面的来源是 `dsh-app://app`，跨源读不到本服务页面的 meta。
 *
 * 交付路径（**不在本模块实现**，由宿主进程负责，契约 F2）：宿主拉起启动器/救援守护时用本函数生成令牌，
 * 一边把同一个值放进 `DSH_DRYDOCK_DESKTOP_TOKEN` 交给服务，一边经命令行/环境变量 + preload 交给桌面页面；
 * 页面把它放进 `X-DSH-PM-Token` 请求头。
 *
 * 纪律与 `newApiToken()` 相同（见上方 ② 的说明）：令牌只存在于内存、请求头与宿主交付通道，
 * **绝不写日志、绝不写 profile 文件**；本模块的报错信息也不打印令牌值。
 * @returns {string} 48 hex（与 newApiToken 同格式/同强度：24 字节 CSPRNG）
 */
export function mintDesktopToken() {
	return randomBytes(24).toString("hex");
}

/**
 * 校验桌面版令牌（`X-DSH-PM-Token`）。供需要"只认桌面令牌"的调用点单独使用。
 * @returns {null|{status:number, code:number, message:string}} null = 通过；否则 401 + 中文原因
 */
export function guardDesktopToken(req, expected) {
	const headers = req && req.headers ? req.headers : {};
	const got = headers["x-dsh-pm-token"];
	if (typeof got !== "string" || got.trim() === "") {
		return { status: 401, code: 401, message: "缺少 X-DSH-PM-Token（桌面版令牌由宿主进程经 DSH_DRYDOCK_DESKTOP_TOKEN 注入桌面页面后放进该请求头）" };
	}
	if (!tokenEquals(got.trim(), expected)) {
		return { status: 401, code: 401, message: "X-DSH-PM-Token 与桌面版令牌不匹配（宿主每次启动都会重新生成，请重新注入）" };
	}
	return null;
}

/**
 * 写接口防护①②：Origin + 一次性令牌。
 *
 * v1.1.0 M2（契约 F1/F2）：桌面版渲染进程的页面来源是自定义协议 `dsh-app://app`，它发往本服务的写请求
 * 会被"同机同端口"白名单判成跨站 → 403（救援球 / 维护页签 / `/plugins` 的启停/重启全废）。
 * 显式允许（`allowDesktopApp: true`）时**只**多认 `DESKTOP_APP_ORIGIN` 这一个来源，且**照常校验令牌**；
 * `allowDesktopApp` 为假时行为与 1.0.x 完全一致（web 零回归）。
 * @param {object|{headers:object}} req http.IncomingMessage（或测试里的 `{headers}`）
 * @param {object} options
 * @param {number|string} options.port 本服务监听端口
 * @param {string} options.token 页面令牌（newApiToken）
 * @param {boolean} [options.allowDesktopApp] 是否允许桌面版页面来源（默认 false）
 * @param {boolean} [options.allowNullOrigin] 是否允许 `Origin: null`（默认 false；需同时开 allowDesktopApp，
 *   且**只认桌面令牌** —— `Origin: null` 任何网页的沙箱 iframe 都能发，唯一的分界是它拿不到的密钥）
 * @param {string|null} [options.desktopToken] 期望的桌面版令牌（来自宿主）
 * @returns {null|{status:number, message:string, code:number}} null = 通过；否则是应答码与原因
 */
export function guardWriteRequest(req, { port, token, allowDesktopApp = false, allowNullOrigin = false, desktopToken = null } = {}) {
	const headers = req && req.headers ? req.headers : {};
	const rawOrigin = headers.origin;
	const origin = typeof rawOrigin === "string" ? rawOrigin.trim() : "";
	const allowed = allowedOriginsOf(port);
	const desktopTokenConfigured = typeof desktopToken === "string" && desktopToken !== "";

	// ① 来源分类（顺序 = 判定优先级；只做固定白名单比较，绝不按 Host/Referer 派生）
	let originKind = "none";
	if (origin !== "") {
		const norm = normalizeOrigin(origin);
		if (allowed.some((item) => normalizeOrigin(item) === norm)) originKind = "same-origin";
		else if (norm === normalizeOrigin(DESKTOP_APP_ORIGIN)) originKind = "desktop-app";
		else if (norm === NULL_ORIGIN) originKind = "opaque";
		else if (norm.startsWith("dsh-app:")) originKind = "desktop-other";
		else originKind = "cross-site";
	}

	// ② Origin 闸门（仍然先于令牌检查：跨站请求不告诉它"令牌对不对"这一位信息）
	if (originKind === "desktop-app" && !allowDesktopApp) {
		return {
			status: 403, code: 403,
			message: `疑似桌面版来源但本次未允许：Origin=${origin}。桌面版渲染进程的页面来源是 ${DESKTOP_APP_ORIGIN}（Electron 从打包静态资源加载，不是 HTTP 源）；` +
				`如果这是桌面版发来的写请求，需要设置 DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1 重启启动器/救援守护；网页版不要开。`
		};
	}
	if (originKind === "desktop-other") {
		return {
			status: 403, code: 403,
			message: `桌面来源不在固定白名单：Origin=${origin}（只认自定义协议源 ${DESKTOP_APP_ORIGIN}，其他 dsh-app 页面一律拒绝）`
		};
	}
	if (originKind === "opaque" && !(allowDesktopApp && allowNullOrigin)) {
		return {
			status: 403, code: 403,
			message: `不透明来源被拒：Origin=${origin}（沙箱 iframe / file:// 页面会把来源序列化为 null，普通网页也能造成这种请求）。` +
				`桌面版若确实发 null，需显式设置 DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1 + DSH_DRYDOCK_ALLOW_NULL_ORIGIN=1，且请求必须携带桌面令牌。`
		};
	}
	if (originKind === "cross-site") {
		const desktopNote = allowDesktopApp ? `；桌面版页面的来源请用 ${DESKTOP_APP_ORIGIN}` : "";
		return {
			status: 403, code: 403,
			message: `跨站来源被拒：Origin=${origin}（只允许同机同端口 ${allowed.join(" / ")}${desktopNote}，或没有 Origin 的非浏览器请求）`
		};
	}

	// ③ 令牌闸门：桌面来源也**必须**过令牌（来源放行 ≠ 免令牌）
	const got = headers["x-dsh-pm-token"];
	const gotToken = typeof got === "string" ? got.trim() : "";
	if (gotToken === "") {
		return { status: 401, code: 401, message: "缺少 X-DSH-PM-Token（页面 meta[name=dsh-pm-token] 里的一次性令牌；桌面版由宿主进程经 DSH_DRYDOCK_DESKTOP_TOKEN 注入同一请求头）" };
	}
	const pageTokenOk = tokenEquals(gotToken, token);
	const desktopTokenOk = desktopTokenConfigured && tokenEquals(gotToken, desktopToken);
	if (originKind === "opaque") {
		// 不透明来源只认桌面令牌（理由见 options.allowNullOrigin）
		if (!desktopTokenOk) {
			return { status: 401, code: 401, message: "Origin: null 的请求只接受桌面版令牌（X-DSH-PM-Token 必须等于宿主注入的 DSH_DRYDOCK_DESKTOP_TOKEN）" };
		}
		return null;
	}
	const tokenOk = originKind === "desktop-app" ? (pageTokenOk || desktopTokenOk) : pageTokenOk;
	if (!tokenOk) {
		return {
			status: 401, code: 401,
			message: originKind === "desktop-app"
				? "X-DSH-PM-Token 不匹配（桌面来源仍要校验令牌：请让宿主进程把 DSH_DRYDOCK_DESKTOP_TOKEN 注入桌面页面，作为 X-DSH-PM-Token 发送；服务重启后令牌会变）"
				: "X-DSH-PM-Token 不匹配（服务重启后令牌会变，请刷新页面重试）"
		};
	}
	return null;
}

// ---------------------------------------------------------------- CORS 预检（v1.1.0 M6 / S6，P0 收尾）
/**
 * 背景（S2 遗留 P0，真包静态分析证实）：官方桌面版 `app.asar` 的 `lib/main.js` 用
 * `protocol.registerSchemesAsPrivileged([{ scheme: "dsh-app", privileges: { standard: true, secure: true,
 * supportFetchAPI: true, corsEnabled: true, ... } }])` 注册自定义协议，桌面页面来源固定为 `dsh-app://app`
 * （无末尾斜杠；桌面自己校验来源用的也是这个精确字面量）。`corsEnabled: true` + 自定义请求头
 * `X-DSH-PM-Token` 意味着桌面页跨源 fetch `http://127.0.0.1:3081/...` 时**浏览器必定先发 OPTIONS 预检**。
 *
 * S2 只闭环了"服务端判定"（Origin 白名单 + 令牌），但两个 bin 当时**既不应答 OPTIONS、也不回
 * `Access-Control-Allow-*`**：预检在浏览器端直接失败，正式请求根本到不了服务端 —— 端到端仍是断的。
 * 本小节补的就是这一段（**只新增导出**，`allowedOriginsOf` / `guardWriteRequest` 的既有判定与令牌逻辑
 * 一行未改，调用方只是在其**前面**多插一个预检分支）。
 *
 * 纪律（与 S2 同源，绝不放松）：
 *  - `Access-Control-Allow-Origin` **只回显被允许的那个 Origin**，永远不写 `*`；来源不被允许时
 *    连一个 `Access-Control-Allow-*` 头都不回（浏览器据此拒绝，服务端泄露的信息也最少）；
 *  - 预检放行的来源集合与写请求白名单**完全一致**：同机同端口（`allowedOriginsOf(port)`）或
 *    显式允许时的 `dsh-app://app`；第三方 http(s) 源、其他 `dsh-app:` 页面、`Origin: null` 预检一律 403
 *    （`Origin: null` 在真机上用不上：桌面页面来源是 `dsh-app://app`，不是不透明来源）；
 *  - 预检分支必须排在令牌校验**之前**：预检请求按 CORS 规范不带凭据/自定义头，若先查令牌就永远 401；
 *    这不等于放松防线 —— OPTIONS 本身不改任何状态，正式请求仍然照常过 `guardWriteRequest`。
 */

/** 预检结果里允许的方法（写接口只用 POST；GET 供 /api/status|verify，OPTIONS 是预检本身）。 */
const CORS_ALLOW_METHODS = "POST, GET, OPTIONS";
/** 预检结果里允许的请求头（**小写**；必须覆盖 S2 用的令牌头 `X-DSH-PM-Token`）。 */
const CORS_ALLOW_HEADERS = "content-type, x-dsh-pm-token";
/** 预检缓存 600s（Chromium 上限 2h；10 分钟足够减少噪音又不至于让策略变更长时间滞留）。 */
const CORS_MAX_AGE = "600";

/**
 * 取本服务监听端口：显式传入优先 → 内核分配的本地端口（`req.socket.localPort`，不可伪造）→
 * `Host` 头里的端口（仅测试/极简 req 兜底，**不作为安全判据**的来源）。拿不到时返回 null。
 */
function requestPortOf(req) {
	const local = req && req.socket ? req.socket.localPort : void 0;
	if (Number.isInteger(local) && local > 0 && local < 65536) return local;
	const host = req && req.headers ? req.headers.host : void 0;
	if (typeof host === "string") {
		const matched = /:(\d+)$/.exec(host.trim());
		if (matched) {
			const port = Number(matched[1]);
			if (Number.isInteger(port) && port > 0 && port < 65536) return port;
		}
	}
	return null;
}

/**
 * 请求来源是否在**写接口白名单**内；返回要回显的 Origin（白名单里的规范形），否则 null。
 *
 * 为什么回显白名单里的规范形而**不是**原始请求头字面量：浏览器按字符串精确比对
 * `Access-Control-Allow-Origin` 与页面自身序列化出的 Origin（scheme/host 小写、无末尾斜杠）。
 * 请求头里的 `Dsh-App://App/` 这类变体只有非浏览器客户端能发，回显规范形 `dsh-app://app`
 * 既与真实浏览器请求逐字节一致，也不会把变体原样"反射"回响应。
 *
 * 无 `Origin` 头（非浏览器本地工具/健康探测）→ 返回 null：CORS 头只服务于跨源浏览器请求，
 * 对无源请求回任何 Allow 头都没有意义（更不允许回 `*`）。
 * @param {object|{headers:object,socket?:object,method?:string}} req http.IncomingMessage（或测试里的替身）
 * @param {{port?:number|string, allowDesktopApp?:boolean}} [options] 与 guardWriteRequest 同源：
 *   `port` 缺省时按 requestPortOf 推断；`allowDesktopApp` 默认 false（web 零回归）
 * @returns {string|null} 允许时返回规范 Origin（`dsh-app://app` 或 `http://127.0.0.1:<port>` 等）
 */
export function corsAllowedOrigin(req, { port, allowDesktopApp = false } = {}) {
	const headers = req && req.headers ? req.headers : {};
	const raw = typeof headers.origin === "string" ? headers.origin.trim() : "";
	if (raw === "") return null; // 无 Origin：不是 CORS 请求，不回任何 Allow 头（绝不 *）
	const norm = normalizeOrigin(raw);
	// ① 桌面版页面来源（也必须先过 S2 的显式开关）：只认固定 host，回显无末尾斜杠的精确字面量
	if (allowDesktopApp === true && norm === normalizeOrigin(DESKTOP_APP_ORIGIN)) return DESKTOP_APP_ORIGIN;
	// ② 同机同端口（web 场景）：浏览器里直接打开 3081/3082 页面时不能因为预检缺失而功能退化
	const effectivePort = port !== void 0 && port !== null && `${port}` !== "" ? port : requestPortOf(req);
	if (effectivePort !== null && effectivePort !== void 0 && `${effectivePort}` !== "") {
		const hit = allowedOriginsOf(effectivePort).find((item) => normalizeOrigin(item) === norm);
		if (hit) return hit;
	}
	// ③ 其余一律不放行：第三方 http(s) 源、其他 dsh-app: 页面、Origin: null（真包场景用不到）
	return null;
}

/**
 * CORS 预检应答描述（S6 主入口）。**只处理 `OPTIONS`**（大小写不敏感），其他方法一律返回 null，
 * 因此不会干扰任何正常请求路径。
 *
 * 返回值的形状（调用方负责写状态码 + 头）：
 *  - `{ status: 204, headers: {...} }`：来源被允许，headers 含
 *    `Access-Control-Allow-Origin`（回显**被允许的那个** Origin，绝不是 `*`）、`Access-Control-Allow-Methods`、
 *    `Access-Control-Allow-Headers`、`Access-Control-Max-Age`、`Vary: Origin`；
 *  - `{ status: 403, headers: { Vary: "Origin" }, message: "<中文原因>" }`：来源不被允许，
 *    **不带任何 `Access-Control-Allow-*` 头**（浏览器据此拒绝，预检不会"半放行"）；
 *  - `OPTIONS` 但**没有 `Origin`**：返回 `{ status: 204, headers: { Vary: "Origin" } }`。
 *    理由：真正的预检一定带 `Origin`；裸 OPTIONS 只是健康探测/命令行工具在探路，没有跨源浏览器语境，
 *    此时既无 Origin 可回显（更不允许回 `*`），也没有任何状态变更可保护 —— 204 是最诚实的答复，
 *    回 403 只会让 `curl -X OPTIONS`、监控探测误报服务故障。
 * @param {object} req http.IncomingMessage（或 `{method, headers, socket?}`）
 * @param {{allowDesktopApp?:boolean, port?:number|string}} [options] 见 corsAllowedOrigin
 * @returns {null|{status:number, headers:Object<string,string>, message?:string}}
 */
export function corsPreflightResponse(req, { allowDesktopApp = false, port } = {}) {
	const method = req && typeof req.method === "string" ? req.method.trim().toUpperCase() : "";
	if (method !== "OPTIONS") return null; // 非 OPTIONS：完全不干预（POST/GET 走既有路径）
	const allowedOrigin = corsAllowedOrigin(req, { port, allowDesktopApp });
	if (allowedOrigin === null) {
		const raw = req && req.headers && typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
		if (raw === "") {
			// 无 Origin 的 OPTIONS：按上文理由给 204，但**不回**任何 Access-Control-Allow-*（更没有 *）
			return { status: 204, headers: { Vary: "Origin" } };
		}
		return {
			status: 403,
			headers: { Vary: "Origin" },
			message: `CORS 预检来源不被允许：Origin=${raw}（只允许同机同端口 ${allowedOriginsOf(port ?? requestPortOf(req) ?? 3081).join(" / ")}` +
				`${allowDesktopApp === true
					? `，或桌面版页面来源 ${DESKTOP_APP_ORIGIN}`
					: `${normalizeOrigin(raw).startsWith("dsh-app:") ? `；桌面版页面来源需要 DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1 才放行` : ""}`}` +
				`；浏览器不会把正式请求发出来）`
		};
	}
	return {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": allowedOrigin,
			"Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
			"Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
			"Access-Control-Max-Age": CORS_MAX_AGE,
			Vary: "Origin"
		}
	};
}

/**
 * 正式（非预检）响应要补的 CORS 头：来源被允许时返回
 * `{ "Access-Control-Allow-Origin": <规范 Origin>, Vary: "Origin" }`，否则 null。
 *
 * 为什么要补在正式响应上：预检只是"问一句能不能发"，浏览器对**真正的响应**还会再检查一次
 * `Access-Control-Allow-Origin`；只修预检不修正式响应，桌面页读到的仍是 network error。
 * 只回显被允许的 Origin、不写 `*`；来源不被允许的请求什么都不加（本来也会被 guardWriteRequest 拒）。
 * @param {object} req http.IncomingMessage（或替身）
 * @param {{allowDesktopApp?:boolean, port?:number|string}} [options] 见 corsAllowedOrigin
 * @returns {null|Object<string,string>}
 */
export function corsResponseHeaders(req, options = {}) {
	const allowedOrigin = corsAllowedOrigin(req, options);
	if (allowedOrigin === null) return null;
	return { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" };
}

/**
 * 从环境变量读取写接口来源策略（M2 的**调用点**用；bin/open-boot.mjs 与 bin/rescue-daemon.mjs 各一行）。
 * 默认全关 → web/未配置场景行为与 1.0.x 逐字节一致。
 *  - `DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1`：允许桌面版页面来源 `dsh-app://app`；
 *  - `DSH_DRYDOCK_DESKTOP_TOKEN=<48hex>`：宿主生成的桌面令牌（mintDesktopToken）；
 *  - `DSH_DRYDOCK_ALLOW_NULL_ORIGIN=1`：桌面页面确实发 `Origin: null` 时再开（需同时开第一项；只认桌面令牌）。
 */
export function writeOriginPolicyFromEnv(env = process.env) {
	const allowDesktopApp = env?.DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN === "1";
	return {
		allowDesktopApp,
		allowNullOrigin: allowDesktopApp && env?.DSH_DRYDOCK_ALLOW_NULL_ORIGIN === "1",
		desktopToken: typeof env?.DSH_DRYDOCK_DESKTOP_TOKEN === "string" && env.DSH_DRYDOCK_DESKTOP_TOKEN !== ""
			? env.DSH_DRYDOCK_DESKTOP_TOKEN
			: null
	};
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
export function buildBootWindowScript({ execPath = process.execPath, bootArgs = [], workDir = "", label = "dsh-drydock" } = {}) {
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
