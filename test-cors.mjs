// test-cors.mjs — v1.1.0 M6（S6）：CORS 预检闭环契约测试（S2 遗留 P0 的端到端补齐）
// 用法: node test-cors.mjs            # 单元断言 + 真 HTTP 端到端（起临时服务、非默认端口、跑完清理）
//       node test-cors.mjs --unit-only # 只跑单元断言（不联网、不起进程、不写盘）
//       node test-cors.mjs --help
// 退出码: 0=全绿 / 1=有断言失败
//
// 背景（真包静态分析，S2 遗留 P0）：官方桌面版 `app.asar` 的 `lib/main.js` 用
// `registerSchemesAsPrivileged({ scheme: "dsh-app", privileges: { standard: true, secure: true,
// supportFetchAPI: true, corsEnabled: true, ... } })` 注册自定义协议；桌面页面来源固定是 `dsh-app://app`
// （无末尾斜杠，桌面自己校验来源用的也是这个精确字面量）。页面带自定义头 `X-DSH-PM-Token` 跨源 fetch
// `http://127.0.0.1:3081/...` → `corsEnabled: true` 保证**浏览器必定先发 OPTIONS 预检**。
// S2 只闭环了服务端判定（Origin 白名单 + 令牌），两个 bin 当时不应答 OPTIONS、也不回 Allow-*
// → 预检在浏览器端就失败，正式请求根本到不了服务端。本套件断言的就是这一段闭环：
//
//  ① 预检**只**放行白名单来源（桌面 dsh-app://app / 同机同端口），回显被允许的那个 Origin，绝不 `*`；
//  ② 预检**不放宽**任何既有防线：第三方 http(s)、其他 dsh-app: 页面、Origin: null 的预检一律 403 且无 Allow 头；
//  ③ 预检排在令牌校验**之前**（预检按 CORS 规范不带令牌），但正式请求照旧过 guardWriteRequest；
//  ④ 正式响应也带 Access-Control-Allow-Origin（只修预检不修正式响应，浏览器照样拦）；
//  ⑤ S2 的 guardWriteRequest / allowedOriginsOf 行为**零回归**（并跑一遍 S2 的 test-origin.mjs 复核）；
//  ⑥ 真 HTTP 端到端：临时 profile + 非默认端口的真服务上验证 OPTIONS 204/403 与 POST 正式响应头。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, connect } from "node:net";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	DESKTOP_APP_ORIGIN, allowedOriginsOf, corsAllowedOrigin, corsPreflightResponse, corsResponseHeaders,
	guardWriteRequest, newApiToken, writeOriginPolicyFromEnv
} from "./lib/enginectl.mjs";

const SELF_DIR = fileURLToPath(new URL(".", import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log("用法: node test-cors.mjs [--unit-only]（v1.1.0 M6 CORS 预检闭环契约测试；默认含真 HTTP 端到端，跑完清理临时服务）");
	process.exit(0);
}
const unitOnly = argv.includes("--unit-only");
/** 真 HTTP 段的结果表（--unit-only 时为空；收尾汇总用）。 */
let httpResults = [];

const failures = [];
let checks = 0;

/** 逐条断言：通过打印 OK，失败累计到 failures 并打印原因。 */
const ok = (name, cond, detail = "") => {
	checks++;
	if (cond) { console.log(`OK: ${name}`); return; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
};

const PORT = 3081;

/** 造一个 IncomingMessage 替身：method + headers（+ 可选 socket/Host）。 */
const mkReq = (method, origin, extraHeaders = {}, socket) => {
	const headers = { ...extraHeaders };
	if (origin !== void 0) headers.origin = origin;
	const req = { method, headers };
	if (socket !== undefined) req.socket = socket;
	return req;
};
/** 预检入口（默认带 port=3081；policy 可覆盖 allowDesktopApp）。 */
const preflight = (origin, policy = {}, extraHeaders = {}, socket) =>
	corsPreflightResponse(mkReq("OPTIONS", origin, extraHeaders, socket), { port: PORT, ...policy });
const statusOf = (result) => (result === null ? 0 : result.status);
const header = (result, name) => {
	if (!result || !result.headers) return void 0;
	const key = Object.keys(result.headers).find((k) => k.toLowerCase() === name.toLowerCase());
	return key === void 0 ? void 0 : result.headers[key];
};
/** 应答里有没有**任何** Access-Control-Allow-* 头（403 时必须一条都没有）。 */
const allowHeaderNames = (result) =>
	(result && result.headers ? Object.keys(result.headers).filter((k) => /^access-control-/i.test(k)) : []);

// ---------------------------------------------------------------- 0. 基线：白名单零回归
console.log("== 0. 基线：allowedOriginsOf 零回归（S2 判定不动） ==");
const LEGACY_ORIGINS = ["http://127.0.0.1:3081", "http://localhost:3081", "http://[::1]:3081"];
ok("allowedOriginsOf(3081) 与 1.0.x 逐字节一致（同序同值）",
	JSON.stringify(allowedOriginsOf(PORT)) === JSON.stringify(LEGACY_ORIGINS),
	JSON.stringify(allowedOriginsOf(PORT)));
ok("allowedOriginsOf(3081,{allowDesktopApp:true}) = 旧三项 + dsh-app://app",
	JSON.stringify(allowedOriginsOf(PORT, { allowDesktopApp: true })) === JSON.stringify([...LEGACY_ORIGINS, DESKTOP_APP_ORIGIN]));
ok("DESKTOP_APP_ORIGIN 精确等于 dsh-app://app（无末尾斜杠，与真包字面量一致）",
	DESKTOP_APP_ORIGIN === "dsh-app://app");
const envDefault = writeOriginPolicyFromEnv({});
ok("writeOriginPolicyFromEnv({}) 仍默认全关（web 零回归）",
	envDefault.allowDesktopApp === false && envDefault.allowNullOrigin === false && envDefault.desktopToken === null,
	JSON.stringify(envDefault));

// ---------------------------------------------------------------- 1. 预检：桌面来源（显式允许）
console.log("== 1. OPTIONS + Origin dsh-app://app + allowDesktopApp:true → 204 + 精确 Allow-Origin ==");
const desktop204 = preflight(DESKTOP_APP_ORIGIN, { allowDesktopApp: true });
ok("状态码 204", statusOf(desktop204) === 204, JSON.stringify(desktop204));
ok("Access-Control-Allow-Origin 精确等于 dsh-app://app（无末尾斜杠）",
	header(desktop204, "Access-Control-Allow-Origin") === "dsh-app://app",
	String(header(desktop204, "Access-Control-Allow-Origin")));
ok("绝不含 Access-Control-Allow-Origin: *（含任何 * 都不行）",
	!Object.values(desktop204.headers || {}).some((v) => String(v).includes("*")),
	JSON.stringify(desktop204.headers));
ok("Access-Control-Allow-Methods = POST, GET, OPTIONS",
	header(desktop204, "Access-Control-Allow-Methods") === "POST, GET, OPTIONS",
	String(header(desktop204, "Access-Control-Allow-Methods")));
ok("Access-Control-Allow-Headers 含 x-dsh-pm-token（S2 的令牌头必须被覆盖）",
	String(header(desktop204, "Access-Control-Allow-Headers")).includes("x-dsh-pm-token"),
	String(header(desktop204, "Access-Control-Allow-Headers")));
ok("Access-Control-Allow-Headers 全小写（含 content-type）",
	String(header(desktop204, "Access-Control-Allow-Headers")) === "content-type, x-dsh-pm-token",
	String(header(desktop204, "Access-Control-Allow-Headers")));
ok("Access-Control-Max-Age = 600", header(desktop204, "Access-Control-Max-Age") === "600");
ok("Vary: Origin（区分缓存键，避免把某个源的预检结果缓存给别的源）", header(desktop204, "Vary") === "Origin");
ok("预检应答**不需要**令牌：带一个错误/缺失令牌头仍 204（规范：预检不带凭据）",
	statusOf(preflight(DESKTOP_APP_ORIGIN, { allowDesktopApp: true }, { "x-dsh-pm-token": "deadbeef" })) === 204
	&& statusOf(preflight(DESKTOP_APP_ORIGIN, { allowDesktopApp: true }, {})) === 204);
for (const variant of ["dsh-app://app/", "Dsh-App://App", "DSH-APP://APP", "Dsh-App://App/"]) {
	const got = preflight(variant, { allowDesktopApp: true });
	ok(`大小写/末尾斜杠变体 ${variant} → 204，且回显规范形 dsh-app://app`,
		statusOf(got) === 204 && header(got, "Access-Control-Allow-Origin") === "dsh-app://app",
		JSON.stringify(got && { status: got.status, acao: header(got, "Access-Control-Allow-Origin") }));
}
for (const method of ["options", "Options", "OPTIONS "]) {
	ok(`方法名大小写/空白变体 ${JSON.stringify(method)} → 仍识别为预检（204）`,
		statusOf(corsPreflightResponse(mkReq(method, DESKTOP_APP_ORIGIN), { port: PORT, allowDesktopApp: true })) === 204);
}

// ---------------------------------------------------------------- 2. 预检：桌面来源未显式允许
console.log("== 2. OPTIONS + Origin dsh-app://app + allowDesktopApp:false → 403 且无 Allow 头 ==");
const desktopDenied = preflight(DESKTOP_APP_ORIGIN, { allowDesktopApp: false });
ok("状态码 403", statusOf(desktopDenied) === 403, JSON.stringify(desktopDenied));
ok("不含任何 Access-Control-Allow-* 头（不许预检半放行）",
	allowHeaderNames(desktopDenied).length === 0, JSON.stringify(allowHeaderNames(desktopDenied)));
ok("Vary: Origin 仍在（403 也要正确缓存语义）", header(desktopDenied, "Vary") === "Origin");
ok("message 是中文原因且提示需要 DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1",
	typeof desktopDenied.message === "string" && /预检来源不被允许/.test(desktopDenied.message)
	&& /DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1/.test(desktopDenied.message), desktopDenied.message);
ok("不传 allowDesktopApp（默认）时同样 403（web 默认零回归）",
	statusOf(preflight(DESKTOP_APP_ORIGIN)) === 403);

// ---------------------------------------------------------------- 3. 预检：第三方源一律 403（不许顺带放开）
console.log("== 3. 第三方源：开了 allowDesktopApp 也照样 403 ==");
for (const origin of [
	"https://evil.example", "http://evil.example", "http://localhost:3082", "http://127.0.0.1:3082",
	"http://localhost.evil.example:3081", "http://0.0.0.0:3081", "https://127.0.0.1:3081",
	"dsh-app://shell", "dsh-app://app:3081", "dsh-app://app@evil.example", "dsh-app://evil",
	"null"
]) {
	const got = preflight(origin, { allowDesktopApp: true });
	ok(`预检 Origin ${origin} → 403 且无 Allow 头`,
		statusOf(got) === 403 && allowHeaderNames(got).length === 0,
		JSON.stringify({ status: got && got.status, allow: allowHeaderNames(got) }));
}
ok("Origin: null 的预检 403（真包页面来源是 dsh-app://app，不是不透明来源；不为它放宽）",
	statusOf(preflight("null", { allowDesktopApp: true })) === 403);
for (const origin of ["HTTPS://EVIL.EXAMPLE", " https://evil.example "]) {
	ok(`绕规范化变体 ${JSON.stringify(origin)} 仍 403`, statusOf(preflight(origin, { allowDesktopApp: true })) === 403);
}

// ---------------------------------------------------------------- 4. 预检：同机同端口（web 页面不退化）
console.log("== 4. OPTIONS + 同机同端口来源 → 204（浏览器里打开 3081/3082 页面仍可用） ==");
for (const origin of LEGACY_ORIGINS) {
	const got = preflight(origin);
	ok(`同机同端口 ${origin} → 204，回显该 Origin`,
		statusOf(got) === 204 && header(got, "Access-Control-Allow-Origin") === origin,
		JSON.stringify({ status: got && got.status, acao: header(got, "Access-Control-Allow-Origin") }));
}
ok("同机同端口 + 末尾斜杠变体 http://127.0.0.1:3081/ → 204，回显规范形",
	statusOf(preflight("http://127.0.0.1:3081/")) === 204
	&& header(preflight("http://127.0.0.1:3081/"), "Access-Control-Allow-Origin") === "http://127.0.0.1:3081");
ok("端口不对 http://127.0.0.1:9999 → 403（端口必须与服务监听端口一致）",
	statusOf(preflight("http://127.0.0.1:9999")) === 403);
ok("socket.localPort 推断：不传 port 也能认出同端口来源（真实 http 请求的用法）",
	statusOf(corsPreflightResponse(mkReq("OPTIONS", "http://localhost:3081", {}, { localPort: 3081 }))) === 204);
ok("Host 头兜底推断：不传 port 且无 socket 时按 Host 端口识别",
	statusOf(corsPreflightResponse(mkReq("OPTIONS", "http://127.0.0.1:3081", { host: "127.0.0.1:3081" }))) === 204);
ok("显式 port 优先于 socket/Host（不按可伪造的 Host 放宽）：socket=9999 + 显式 port=3081 + Origin 9999 → 403",
	statusOf(corsPreflightResponse(mkReq("OPTIONS", "http://127.0.0.1:9999", { host: "127.0.0.1:9999" }, { localPort: 9999 }), { port: 3081 })) === 403);

// ---------------------------------------------------------------- 5. 预检：无 Origin（按判断给 204 但不回 Allow）
console.log("== 5. OPTIONS 无 Origin → 204，但绝不回 * 也不回任何 Allow 头 ==");
const noOrigin = corsPreflightResponse(mkReq("OPTIONS"), { port: PORT, allowDesktopApp: true });
ok("状态码 204（裸 OPTIONS 只是健康探测/命令行探路，没有跨源语境；403 会让监控误报故障）",
	statusOf(noOrigin) === 204, JSON.stringify(noOrigin));
ok("无 Origin 时不含任何 Access-Control-Allow-*（无源可回显；更不可能回 *）",
	allowHeaderNames(noOrigin).length === 0, JSON.stringify(allowHeaderNames(noOrigin)));
ok("无 Origin 时仍带 Vary: Origin", header(noOrigin, "Vary") === "Origin");
ok("空字符串 Origin 与无 Origin 同处理（204 无 Allow 头）",
	statusOf(preflight("")) === 204 && allowHeaderNames(preflight("")) .length === 0);

// ---------------------------------------------------------------- 6. 非 OPTIONS：完全不干预
console.log("== 6. 非 OPTIONS 方法 → corsPreflightResponse 返回 null（不干扰正常路径） ==");
for (const method of ["POST", "GET", "PUT", "DELETE", "HEAD", "PATCH", "post", "get"]) {
	ok(`${method} → null`, corsPreflightResponse(mkReq(method, DESKTOP_APP_ORIGIN), { port: PORT, allowDesktopApp: true }) === null);
}
ok("method 缺失 / undefined → null", corsPreflightResponse({ headers: { origin: DESKTOP_APP_ORIGIN } }, { port: PORT, allowDesktopApp: true }) === null);
ok("空 method → null", corsPreflightResponse(mkReq("", DESKTOP_APP_ORIGIN), { port: PORT, allowDesktopApp: true }) === null);
ok("近似方法名 OPTIONSX → null（不做前缀匹配）",
	corsPreflightResponse(mkReq("OPTIONSX", DESKTOP_APP_ORIGIN), { port: PORT, allowDesktopApp: true }) === null);

// ---------------------------------------------------------------- 7. 正式响应头：预检过了还要过这一关
console.log("== 7. corsResponseHeaders：正式响应补 Allow-Origin + Vary（否则预检过了仍被浏览器拦） ==");
const postDesktop = corsResponseHeaders(mkReq("POST", DESKTOP_APP_ORIGIN), { port: PORT, allowDesktopApp: true });
ok("POST + 桌面来源（允许）→ Allow-Origin 精确 dsh-app://app + Vary: Origin",
	postDesktop && postDesktop["Access-Control-Allow-Origin"] === DESKTOP_APP_ORIGIN && postDesktop.Vary === "Origin",
	JSON.stringify(postDesktop));
ok("POST + 桌面来源（未允许）→ null（不补任何头）",
	corsResponseHeaders(mkReq("POST", DESKTOP_APP_ORIGIN), { port: PORT }) === null);
ok("POST + 第三方来源 → null", corsResponseHeaders(mkReq("POST", "https://evil.example"), { port: PORT, allowDesktopApp: true }) === null);
ok("无 Origin（本地工具）→ null（不回 *）", corsResponseHeaders(mkReq("POST"), { port: PORT, allowDesktopApp: true }) === null);
ok("同机同端口页面 → Allow-Origin 回显该 Origin",
	corsResponseHeaders(mkReq("POST", "http://127.0.0.1:3081"), { port: PORT })["Access-Control-Allow-Origin"] === "http://127.0.0.1:3081");
ok("corsAllowedOrigin 与 corsResponseHeaders 语义一致（同一套白名单）",
	corsAllowedOrigin(mkReq("GET", "http://localhost:3081"), { port: PORT }) === "http://localhost:3081");

// ---------------------------------------------------------------- 8. S2 零回归：guardWriteRequest 判定不变
console.log("== 8. 零回归：guardWriteRequest 既有行为一条不变（S2 子集） ==");
const tokenA = newApiToken();
const tokenB = newApiToken();
const desktopToken = newApiToken();
const guard = (origin, opts = {}) => {
	const { sendToken = tokenA, ...rest } = opts;
	const headers = { "x-dsh-pm-token": sendToken };
	if (origin !== void 0) headers.origin = origin;
	return guardWriteRequest({ headers }, { port: PORT, token: tokenA, ...rest });
};
const guardStatus = (origin, opts = {}) => statusOf(guard(origin, opts));
ok("同机同端口 + 正确令牌 → 通过（null）", guard("http://127.0.0.1:3081") === null);
ok("同机同端口 + 错误令牌 → 401", guardStatus("http://127.0.0.1:3081", { sendToken: tokenB }) === 401);
ok("空 Origin + 正确令牌 → 通过（本地工具既有语义）", guard() === null);
ok("空 Origin + 缺少令牌 → 401", guardStatus(void 0, { sendToken: null }) === 401);
ok("第三方来源 + 正确令牌 → 403（默认）", guardStatus("https://evil.example") === 403);
ok("第三方来源 + 正确令牌 + allowDesktopApp → 仍 403", guardStatus("https://evil.example", { allowDesktopApp: true, desktopToken }) === 403);
ok("桌面来源默认 → 403", guardStatus(DESKTOP_APP_ORIGIN, { desktopToken }) === 403);
ok("桌面来源 + allowDesktopApp + 桌面令牌 → 通过",
	guard(DESKTOP_APP_ORIGIN, { allowDesktopApp: true, desktopToken, sendToken: desktopToken }) === null);
ok("桌面来源 + allowDesktopApp + 错误令牌 → 401（来源放行 ≠ 免令牌）",
	guardStatus(DESKTOP_APP_ORIGIN, { allowDesktopApp: true, desktopToken, sendToken: tokenB }) === 401);
ok("Origin: null 默认 → 403", guardStatus("null", { desktopToken }) === 403);
ok("Origin: null + 两级开关 + 桌面令牌 → 通过（S2 契约原样，M6 不动它）",
	guard("null", { allowDesktopApp: true, allowNullOrigin: true, desktopToken, sendToken: desktopToken }) === null);
ok("端口不对 http://localhost:3082 → 403", guardStatus("http://localhost:3082") === 403);
ok("预检助手不改变 guardWriteRequest 的返回值（同一来源：OPTIONS 走预检 204，POST 仍按 S2 判定通过）",
	statusOf(corsPreflightResponse(mkReq("OPTIONS", DESKTOP_APP_ORIGIN), { port: PORT, allowDesktopApp: true })) === 204
	&& guard(DESKTOP_APP_ORIGIN, { allowDesktopApp: true, desktopToken }) === null
	&& guardStatus(DESKTOP_APP_ORIGIN, { allowDesktopApp: true, desktopToken, sendToken: tokenB }) === 401);

// ---------------------------------------------------------------- 9. 真 HTTP 端到端（临时 profile + 非默认端口）
console.log("== 9. 真 HTTP 端到端（临时 profile / 非默认端口；跑完清理进程与临时目录） ==");
if (unitOnly) {
	console.log("   --unit-only：跳过真 HTTP 段（只跑单元断言；发布前请不带参数跑一次完整套件）");
} else {

/** 取一个空闲端口（bind 0 后立刻释放，随后由子进程监听）。 */
function freePort() {
	return new Promise((resolvePort, rejectPort) => {
		const probe = createNetServer();
		probe.once("error", rejectPort);
		probe.listen(0, "127.0.0.1", () => {
			const port = probe.address().port;
			probe.close(() => resolvePort(port));
		});
	});
}

/** 发一个真 HTTP 请求，返回 {status, headers(小写键), body}；连接失败返回 status:0。 */
function httpCall({ port, method, path, headers = {}, body = null, timeoutMs = 10000 }) {
	return new Promise((resolveCall) => {
		const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => {
				const lower = {};
				for (const [key, value] of Object.entries(res.headers)) lower[key.toLowerCase()] = value;
				resolveCall({ status: res.statusCode, headers: lower, body: text });
			});
		});
		req.on("error", (error) => resolveCall({ status: 0, headers: {}, body: `${error && error.code ? error.code : error}` }));
		req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
		if (body !== null) req.write(body);
		req.end();
	});
}

/** 轮询到 HTTP 有应答（服务已就绪）或超时。 */
async function waitHttp(port, budgetMs = 20000) {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		const got = await httpCall({ port, method: "GET", path: "/", timeoutMs: 1500 });
		if (got.status > 0) return got;
		await new Promise((r) => setTimeout(r, 120));
	}
	return null;
}

/** 等进程退出（返回是否在预算内退出）。 */
function waitExit(child, budgetMs = 6000) {
	return new Promise((resolveExit) => {
		if (child.exitCode !== null || child.signalCode !== null) { resolveExit(true); return; }
		let done = false;
		const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolveExit(value); } };
		const timer = setTimeout(() => finish(false), budgetMs);
		child.once("exit", () => finish(true));
	});
}

/** 端口是否已无监听（连接被拒绝/不可达）。 */
function portClosed(port, budgetMs = 5000) {
	return new Promise((resolveClosed) => {
		const deadline = Date.now() + budgetMs;
		const attempt = () => {
			const socket = connect({ host: "127.0.0.1", port });
			let settled = false;
			const finish = (closed) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				if (closed) resolveClosed(true);
				else if (Date.now() < deadline) setTimeout(attempt, 150);
				else resolveClosed(false);
			};
			socket.once("connect", () => finish(false));
			socket.once("error", () => finish(true));
			socket.setTimeout(800, () => finish(false));
		};
		attempt();
	});
}

const childEnv = (extra = {}) => {
	// 先清掉宿主可能残留的三个 drydock 环境变量，再写本次显式值（顺序不能反：先清后写才是隔离）
	const env = { ...process.env };
	for (const key of ["DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN", "DSH_DRYDOCK_ALLOW_NULL_ORIGIN", "DSH_DRYDOCK_DESKTOP_TOKEN"]) delete env[key];
	return { ...env, ...extra };
};

const spawned = [];
const stopChild = async (child) => {
	if (!child || child.exitCode !== null) return;
	try { child.kill(); } catch { /* ignore */ }
	if (await waitExit(child, 4000)) return;
	try {
		const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		await new Promise((r) => killer.once("exit", r));
	} catch { /* ignore */ }
	await waitExit(child, 3000);
};

let tmpDir = null;
let portsToCheck = [];
try {
	tmpDir = mkdtempSync(join(SELF_DIR, ".tmp-cors-"));
	const profileOn = join(tmpDir, "profile-on");
	const profileOff = join(tmpDir, "profile-off");
	const profileRescue = join(tmpDir, "profile-rescue");
	for (const dir of [profileOn, profileOff, profileRescue]) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tmp-cors-profile", version: "0.0.0", dependencies: {} }, null, 2));
	}
	// 引擎端口指到一个空闲端口：既不会碰用户真实的 3080，也不会让临时服务去探测它
	const enginePort = await freePort();
	const pOn = await freePort();
	const pOff = await freePort();
	const pRescue = await freePort();
	portsToCheck = [pOn, pOff, pRescue];
	const desktopToken = newApiToken();
	const baseEnv = {
		DSH_PM_NO_SCRIPTS: "1",
		DSH_PM_SCRIPTS_DIR: join(tmpDir, "scripts"),
		DSH_ENGINE_PORT: String(enginePort),
		DSH_RESCUE_PORT: String(pRescue)
	};
	const envOn = childEnv({
		...baseEnv,
		DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN: "1",
		DSH_DRYDOCK_DESKTOP_TOKEN: desktopToken
	});
	const envOff = childEnv({ ...baseEnv });
	const openBootArgs = (port, profile) => [join(SELF_DIR, "bin", "open-boot.mjs"), "--port", String(port), "--profile", profile, "--cwd", tmpDir, "--no-window"];
	const rescueArgs = [join(SELF_DIR, "bin", "rescue-daemon.mjs"), "--port", String(pRescue), "--profile", profileRescue, "--cwd", tmpDir, "--dsh", "dsh"];

	console.log(`  临时目录: ${tmpDir}`);
	console.log(`  桌面来源开: open-boot :${pOn}；默认关: open-boot :${pOff}；rescue-daemon :${pRescue}；引擎端口 ${enginePort}（未启动）`);
	const serverOn = spawn(process.execPath, openBootArgs(pOn, profileOn), { cwd: SELF_DIR, env: envOn, stdio: "ignore", windowsHide: true });
	const serverOff = spawn(process.execPath, openBootArgs(pOff, profileOff), { cwd: SELF_DIR, env: envOff, stdio: "ignore", windowsHide: true });
	const rescue = spawn(process.execPath, rescueArgs, { cwd: SELF_DIR, env: envOn, stdio: "ignore", windowsHide: true });
	spawned.push(serverOn, serverOff, rescue);

	const readyOn = await waitHttp(pOn);
	const readyOff = await waitHttp(pOff);
	const readyRescue = await waitHttp(pRescue);
	if (!readyOn || !readyOff || !readyRescue) {
		ok("三个临时服务都已就绪（open-boot 开/关 + rescue-daemon）", false,
			JSON.stringify({ on: readyOn && readyOn.status, off: readyOff && readyOff.status, rescue: readyRescue && readyRescue.status }));
	} else {
		ok("三个临时服务都已就绪（open-boot 开/关 + rescue-daemon）", true);

		const preflightHeaders = {
			origin: DESKTOP_APP_ORIGIN,
			"access-control-request-method": "POST",
			"access-control-request-headers": "x-dsh-pm-token"
		};
		// ① 真预检：桌面来源 + 开关开 → 204 + 三个 Allow 头
		const preOn = await httpCall({ port: pOn, method: "OPTIONS", path: "/api/boot", headers: preflightHeaders });
		httpResults.push({ case: "OPTIONS /api/boot（桌面来源，开关开）", port: pOn, status: preOn.status });
		ok("HTTP: OPTIONS /api/boot + Origin dsh-app://app + 开关开 → 204", preOn.status === 204,
			JSON.stringify({ status: preOn.status, headers: preOn.headers }));
		ok("HTTP: Access-Control-Allow-Origin 精确 dsh-app://app", preOn.headers["access-control-allow-origin"] === "dsh-app://app",
			String(preOn.headers["access-control-allow-origin"]));
		ok("HTTP: Access-Control-Allow-Methods = POST, GET, OPTIONS", preOn.headers["access-control-allow-methods"] === "POST, GET, OPTIONS",
			String(preOn.headers["access-control-allow-methods"]));
		ok("HTTP: Access-Control-Allow-Headers 含 x-dsh-pm-token", String(preOn.headers["access-control-allow-headers"]).includes("x-dsh-pm-token"),
			String(preOn.headers["access-control-allow-headers"]));
		ok("HTTP: Access-Control-Max-Age = 600", preOn.headers["access-control-max-age"] === "600");
		ok("HTTP: Vary = Origin", String(preOn.headers["vary"]).toLowerCase() === "origin");
		ok("HTTP: 预检响应体为空（204 无 body）", preOn.body === "", JSON.stringify(preOn.body));

		// ② 真预检：开关关 → 403 且无 Allow 头
		const preOff = await httpCall({ port: pOff, method: "OPTIONS", path: "/api/boot", headers: preflightHeaders });
		httpResults.push({ case: "OPTIONS /api/boot（桌面来源，开关关）", port: pOff, status: preOff.status });
		ok("HTTP: OPTIONS + 开关关 → 403", preOff.status === 403, JSON.stringify({ status: preOff.status, headers: preOff.headers }));
		ok("HTTP: 403 预检不含任何 Access-Control-Allow-* 头",
			!Object.keys(preOff.headers).some((k) => /^access-control-allow-/i.test(k)), JSON.stringify(preOff.headers));

		// ③ 真预检：第三方源 → 403（开关开也不许顺带放开）
		const preEvil = await httpCall({ port: pOn, method: "OPTIONS", path: "/api/boot", headers: { ...preflightHeaders, origin: "https://evil.example" } });
		httpResults.push({ case: "OPTIONS /api/boot（第三方来源）", port: pOn, status: preEvil.status });
		ok("HTTP: 第三方 Origin 预检 → 403 且无 Allow-Origin",
			preEvil.status === 403 && preEvil.headers["access-control-allow-origin"] === void 0,
			JSON.stringify({ status: preEvil.status, acao: preEvil.headers["access-control-allow-origin"] }));

		// ④ 真预检：同机同端口页面 → 204 回显
		const preSame = await httpCall({ port: pOn, method: "OPTIONS", path: "/plugins/api/bundles", headers: { ...preflightHeaders, origin: `http://127.0.0.1:${pOn}` } });
		httpResults.push({ case: "OPTIONS /plugins/api/bundles（同机同端口）", port: pOn, status: preSame.status });
		ok("HTTP: 同机同端口 Origin 预检 → 204 且回显该 Origin",
			preSame.status === 204 && preSame.headers["access-control-allow-origin"] === `http://127.0.0.1:${pOn}`,
			JSON.stringify({ status: preSame.status, acao: preSame.headers["access-control-allow-origin"] }));

		// ⑤ 真 POST（正式响应）：桌面来源 + 正确桌面令牌 → 200 且带 Allow-Origin
		//    /plugins/api/bundles 选一个不存在的 bundle 名：守卫全过、业务返回 200 {ok:false}，不产生任何真实副作用
		const postBody = JSON.stringify({ action: "enable", name: "__s6_no_such_bundle__" });
		const postOk = await httpCall({
			port: pOn, method: "POST", path: "/plugins/api/bundles",
			headers: { origin: DESKTOP_APP_ORIGIN, "content-type": "application/json", "x-dsh-pm-token": desktopToken },
			body: postBody
		});
		httpResults.push({ case: "POST /plugins/api/bundles（桌面来源 + 桌面令牌）", port: pOn, status: postOk.status });
		let postJson = null;
		try { postJson = JSON.parse(postOk.body); } catch { /* 断言里会报 */ }
		ok("HTTP: POST + 桌面来源 + 正确桌面令牌 → 200（未再被 Origin 白名单 403）", postOk.status === 200,
			JSON.stringify({ status: postOk.status, body: postOk.body.slice(0, 200) }));
		ok("HTTP: 正式 POST 响应带 Access-Control-Allow-Origin = dsh-app://app",
			postOk.headers["access-control-allow-origin"] === DESKTOP_APP_ORIGIN,
			String(postOk.headers["access-control-allow-origin"]));
		ok("HTTP: 正式 POST 响应带 Vary: Origin", String(postOk.headers["vary"]).toLowerCase() === "origin");
		ok("HTTP: POST body 是服务端 JSON（业务 ok:false：不存在的 bundle 名，证明请求真的到了服务端）",
			postJson !== null && postJson.ok === false, postJson === null ? postOk.body.slice(0, 200) : JSON.stringify(postJson).slice(0, 200));
		ok("HTTP: 响应里不回显令牌值（令牌纪律）", !postOk.body.includes(desktopToken));

		// ⑥ 真 POST：错误令牌 → 401，但 Origin 允许时仍带 Allow-Origin（桌面页能读到真实 401 原因）
		const postBadToken = await httpCall({
			port: pOn, method: "POST", path: "/plugins/api/bundles",
			headers: { origin: DESKTOP_APP_ORIGIN, "content-type": "application/json", "x-dsh-pm-token": newApiToken() },
			body: postBody
		});
		httpResults.push({ case: "POST /plugins/api/bundles（桌面来源 + 错误令牌）", port: pOn, status: postBadToken.status });
		ok("HTTP: 正式 POST 错误令牌 → 401 且带 Allow-Origin（来源放行 ≠ 免令牌，报错可读）",
			postBadToken.status === 401 && postBadToken.headers["access-control-allow-origin"] === DESKTOP_APP_ORIGIN,
			JSON.stringify({ status: postBadToken.status, acao: postBadToken.headers["access-control-allow-origin"] }));

		// ⑦ 真 POST：第三方来源 + 正确令牌 → 403 且无 Allow-Origin（防线不变）
		const postEvil = await httpCall({
			port: pOn, method: "POST", path: "/plugins/api/bundles",
			headers: { origin: "https://evil.example", "content-type": "application/json", "x-dsh-pm-token": desktopToken },
			body: postBody
		});
		httpResults.push({ case: "POST /plugins/api/bundles（第三方来源 + 桌面令牌）", port: pOn, status: postEvil.status });
		ok("HTTP: 正式 POST 第三方来源 → 403 且无 Allow-Origin",
			postEvil.status === 403 && postEvil.headers["access-control-allow-origin"] === void 0,
			JSON.stringify({ status: postEvil.status, acao: postEvil.headers["access-control-allow-origin"] }));

		// ⑧ 读取类路径：桌面页 GET 也带 Allow-Origin（不在预检之外留死角）
		const getBundles = await httpCall({ port: pOn, method: "GET", path: "/plugins/api/bundles", headers: { origin: DESKTOP_APP_ORIGIN } });
		httpResults.push({ case: "GET /plugins/api/bundles（桌面来源）", port: pOn, status: getBundles.status });
		ok("HTTP: GET + 桌面来源 → 200 且带 Allow-Origin",
			getBundles.status === 200 && getBundles.headers["access-control-allow-origin"] === DESKTOP_APP_ORIGIN,
			JSON.stringify({ status: getBundles.status, acao: getBundles.headers["access-control-allow-origin"] }));

		// ⑨ rescue-daemon：预检 + 守卫放行后的正式响应都带 Allow-Origin
		const preRescue = await httpCall({ port: pRescue, method: "OPTIONS", path: "/api/start", headers: preflightHeaders });
		httpResults.push({ case: "OPTIONS /api/start（rescue-daemon，桌面来源）", port: pRescue, status: preRescue.status });
		ok("HTTP: rescue-daemon 预检 → 204 且 Allow-Origin = dsh-app://app",
			preRescue.status === 204 && preRescue.headers["access-control-allow-origin"] === DESKTOP_APP_ORIGIN,
			JSON.stringify({ status: preRescue.status, acao: preRescue.headers["access-control-allow-origin"] }));
		// POST /api/verify 不是合法路由（GET only）→ 守卫全过后 404；用它证明"正式响应带 Allow-Origin"且无副作用
		const postRescue = await httpCall({
			port: pRescue, method: "POST", path: "/api/verify",
			headers: { origin: DESKTOP_APP_ORIGIN, "content-type": "application/json", "x-dsh-pm-token": desktopToken },
			body: "{}"
		});
		httpResults.push({ case: "POST /api/verify（rescue-daemon，桌面来源 + 桌面令牌）", port: pRescue, status: postRescue.status });
		ok("HTTP: rescue-daemon 正式 POST 过了守卫（404 路由不存在）且带 Allow-Origin",
			postRescue.status === 404 && postRescue.headers["access-control-allow-origin"] === DESKTOP_APP_ORIGIN,
			JSON.stringify({ status: postRescue.status, acao: postRescue.headers["access-control-allow-origin"] }));
		const postRescueEvil = await httpCall({
			port: pRescue, method: "POST", path: "/api/fix",
			headers: { origin: "https://evil.example", "content-type": "application/json", "x-dsh-pm-token": desktopToken },
			body: "{}"
		});
		httpResults.push({ case: "POST /api/fix（rescue-daemon，第三方来源）", port: pRescue, status: postRescueEvil.status });
		ok("HTTP: rescue-daemon 第三方来源 POST → 403 且无 Allow-Origin",
			postRescueEvil.status === 403 && postRescueEvil.headers["access-control-allow-origin"] === void 0,
			JSON.stringify({ status: postRescueEvil.status, acao: postRescueEvil.headers["access-control-allow-origin"] }));
	}
} catch (error) {
	ok("端到端段未抛异常", false, error && error.stack ? String(error.stack).split("\n").slice(0, 3).join(" | ") : String(error));
} finally {
	// 清理：先停子进程，再确认端口无监听，最后删临时目录（顺序不能反：日志文件可能还被子进程持有）
	for (const child of spawned) await stopChild(child);
	for (const port of [...new Set(portsToCheck)]) {
		ok(`清理：端口 ${port} 已无监听（不留监听）`, await portClosed(port));
	}
	if (tmpDir) {
		let removed = false;
		for (let attempt = 0; attempt < 8 && !removed; attempt++) {
			try { rmSync(tmpDir, { recursive: true, force: true }); removed = !existsSync(tmpDir); }
			catch { removed = false; }
			if (!removed) await new Promise((r) => setTimeout(r, 250));
		}
		ok("清理：临时目录已删除", removed, tmpDir);
	}
}
}

// ---------------------------------------------------------------- 10. S2 套件复核（零回归的第二道保险）
console.log("== 10. 复核 S2 的 test-origin.mjs（不改它，只跑一遍确认零回归） ==");
const originSuite = join(SELF_DIR, "test-origin.mjs");
if (existsSync(originSuite)) {
	const code = await new Promise((resolveCode) => {
		const child = spawn(process.execPath, [originSuite], { cwd: SELF_DIR, stdio: "ignore", windowsHide: true });
		child.once("exit", (exitCode) => resolveCode(exitCode));
		child.once("error", () => resolveCode(-1));
	});
	ok("test-origin.mjs 退出码 0（S2 的 58 条写接口来源防护断言全绿，零回归）", code === 0, `exit=${code}`);
} else {
	ok("test-origin.mjs 存在（缺失则无法复核 S2 零回归）", false, originSuite);
}

// ---------------------------------------------------------------- 收尾
console.log("");
if (httpResults.length > 0) {
	console.log("真 HTTP 状态码表：");
	for (const row of httpResults) console.log(`  ${String(row.status).padStart(3)}  ${row.case}  [127.0.0.1:${row.port}]`);
	console.log("");
}
if (failures.length > 0) {
	console.error(`RESULT: FAIL - ${failures.length}/${checks} 条断言失败`);
	for (const item of failures) console.error(`  - ${item}`);
	process.exit(1);
}
console.log(`RESULT: PASS - CORS 预检闭环契约（${checks} 条断言：桌面 dsh-app://app 预检 204 / 未允许与第三方 403 无 Allow 头 / 同机同端口不退化 / 正式响应带 Allow-Origin / S2 零回归 / 真 HTTP 端到端）`);
process.exit(0);
