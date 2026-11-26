#!/usr/bin/env node
/**
 * rescue-daemon.mjs — 独立救援守护服务（不依赖 DSH 主进程）。
 *
 * 用途：主引擎启动失败时，/rescue 救援页（由主引擎 webServer 注册）会随之瘫痪。
 * 本守护进程独立于 DSH 主进程运行在备用端口（**默认 3082**），提供：
 *   GET  /              → 自包含中文救援页（诊断/修复/启动/重启）
 *   GET  /api/verify    → verifyProfile()（standalone 自检）
 *   POST /api/fix       → fixProfile()（隔离坏 bundle / 恢复损坏补丁）
 *   POST /api/start     → 拉起 `dsh web`（detached，日志+PID 文件）
 *   POST /api/stop      → 按 PID 结束引擎（多重校验；拒绝时可用 {"force":true} 强制）
 *   GET  /api/status    → { app, engineUp, port, pid, ... }（app 字段供身份校验）
 *
 * v0.9.1（审计③ R7 端口分工 + L11 写接口防护）：
 *  - **默认端口 3081 → 3082**：3081 由 `bin/open-boot.mjs` 独家占用（唯一网页入口，且它已内建
 *    完整救援能力：`/rescue` 页面 + `/rescue/api/*`）。本守护退化为**独立备份入口**，
 *    启动时打印迁移提示；两者可同时运行、互不占用，端口被占仍明确报错退出（不静默漂移）。
 *  - 写接口（POST /api/fix|start|stop）加 Origin + 一次性令牌（`<meta name="dsh-pm-token">` +
 *    `X-DSH-PM-Token`），`/api/start` 另加单飞（并发第二个 → 409）。读取接口不加防护。
 *  - `handleApi(pathname, method, req, res, url, ctx)`：ctx 显式传 profile/dsh/cwd/port/flight，
 *    因此 open-boot 可以把它挂到 `/rescue/api/*` 前缀下复用（不再依赖模块级 args）。
 *
 * v0.9.0-2（审计③ 修复 L2/L4/L5）：
 *  - 引擎健康判定 = **HTTP 握手 + dsh 身份指纹**（裸 TCP 不算就绪）；
 *    端口被非 dsh 进程占用时明确报错，不做"假健康"。
 *  - `/api/stop` 先做多重校验（pid 存活 / 进程镜像 / 端口占用者一致），校验不过一律拒绝，
 *    页面会提示并允许显式"强制停止"，避免 PID 复用误杀无关进程树。
 *  - 端口被占用时**直接报错退出**（旧行为是静默 +1，会让救援页落到意料之外的端口）。
 *  - 显式使用稳定 cwd + 崩溃/心跳日志（rescue-daemon-server.log）。
 *
 * 用法：node bin/rescue-daemon.mjs [--profile <dir>] [--port <n>] [--dsh <cmd>] [--cwd <dir>] [--help]
 *   默认 profile: ~/.dsh/profiles/web；默认端口 3082。
 * 零新依赖：node:http / node:net / node:fs / node:path / node:os / node:child_process + yaml（项目已有）。
 */
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyProfile, fixProfile, isolateFailedEntries } from "../lib/preflight.mjs";
import { entryUrlOf, launcherPortFromEnv, rescuePortFromEnv } from "../lib/ports.mjs";
import {
	ENGINE_PORT, RESCUE_APP, chdirStable, corsPreflightResponse, corsResponseHeaders, createSingleFlight, engineHealth, guardWriteRequest, isAlive,
	launcherHealth, newApiToken, portOwner, probe, readPidInfo, startEngineWithQuarantine, stopEngine, validatePortValue,
	writeOriginPolicyFromEnv
} from "../lib/enginectl.mjs";

const SELF = fileURLToPath(import.meta.url);
const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");
const SERVER_LOG = "rescue-daemon-server.log";
/**
 * v0.9.1：3081 归 open-boot（唯一网页入口），本守护退到 3082。
 * 端口可用 `DSH_RESCUE_PORT` 覆盖（默认 3082）；`--port` 优先。
 */
const PORT_DEFAULT = rescuePortFromEnv();

// ---------------------------------------------------------------- drydock 品牌内联素材
// 素材源：docs/images/logo-mark.svg（主题自适应 mark）/ docs/images/logo.svg（徽章）。
// 三个页面（启动页 / /plugins / /rescue）与 open-boot import 本文件时共用同一套内联 SVG 常量：
// 鲸形与货箱全部 currentColor（内联进页面时跟随文字色，深浅主题自适应；眼睛是路径镂空）；
// favicon 用徽章版（蓝底白鲸货箱）——currentColor 在 favicon 里会解析成黑色，不可用于 favicon。
const DRYDOCK_LOGO_PATH = `M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45`;
/** 主题自适应 mark（内联 SVG，全 currentColor，尺寸可指定，默认 20px）。 */
const drydockLogoMarkSvg = (size = 20) => `<svg class="drydock-logo-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" fill="currentColor" role="img" aria-label="drydock logo" style="flex:none;vertical-align:-.15em"><g transform="translate(9.5,14) scale(1.85)"><path d="${DRYDOCK_LOGO_PATH}"/></g><g><rect x="19" y="16.5" width="6.2" height="5.5" rx="0.5"/><rect x="26.4" y="16.5" width="6.2" height="5.5" rx="0.5"/><rect x="19" y="9.8" width="6.2" height="5.5" rx="0.5"/></g></svg>`;
/** 徽章版（#4D6BFE 圆角方底 + 白鲸货箱），专供 favicon：currentColor 在 favicon 里会解析成黑色。 */
const DRYDOCK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="1" y="1" width="62" height="62" rx="15" fill="#4D6BFE"/><g transform="translate(9.5,14) scale(1.85)" fill="#FFFFFF"><path d="${DRYDOCK_LOGO_PATH}"/></g><g fill="#FFFFFF"><rect x="19" y="16.5" width="6.2" height="5.5" rx="0.5"/><rect x="26.4" y="16.5" width="6.2" height="5.5" rx="0.5"/><rect x="19" y="9.8" width="6.2" height="5.5" rx="0.5"/></g></svg>`;
/** data: URI favicon <link>，注入各页面 <head>。 */
const DRYDOCK_FAVICON_LINK = `<link class="drydock-logo-favicon" rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(DRYDOCK_FAVICON_SVG)}">`;

const HELP_TEXT = `DSH 独立救援守护（默认 3082 = 备用救援入口）

用法：
  node bin/rescue-daemon.mjs [选项]

选项：
  --profile <dir>   profile 目录（默认 ~/.dsh/profiles/web）
  --port <n>        监听端口（默认 3082；被其他进程占用时直接报错退出，不漂移）
                    也可用环境变量 DSH_RESCUE_PORT 覆盖（--port 优先）
  --dsh <cmd>       启动引擎的命令（默认 dsh；含空格的路径也可用）
  --cwd <dir>       引擎/守护工作目录（默认用户主目录）
  --help            显示本帮助

环境变量：
  DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1  允许桌面版页面来源 dsh-app://app 的写请求（默认关；网页版不要开）
  DSH_DRYDOCK_DESKTOP_TOKEN=<48hex>   桌面版令牌（宿主用 mintDesktopToken() 生成，同时交给本服务与桌面页面）
  DSH_DRYDOCK_ALLOW_NULL_ORIGIN=1     桌面页面确实发 Origin: null 时再开（需同时开上面第一项；只认桌面令牌）

端口分工（v0.9.1 起）：
  3080 = dsh 引擎；3081 = open-boot（唯一网页入口，已含 /rescue 页面 + /rescue/api/* 完整救援能力）；
  3082 = 本守护（独立备份入口）。浏览器主页/桌面快捷方式请指向 3081。
  以上端口均可覆盖：DSH_ENGINE_PORT / DSH_LAUNCHER_PORT / DSH_RESCUE_PORT。

页面按钮：启动引擎并打开主界面 / 运行检查 / 修复引擎配置 / 状态 / 停止引擎（带校验，可强制）

写接口防护：POST /api/fix|start|stop 需要同源 Origin + 一次性令牌（页面会自动带上）；
桌面版（1.1.0）页面来源是 dsh-app://app，需显式 DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1 才放行（令牌照旧校验）。
CORS 预检（1.1.0 M6）：桌面页带 X-DSH-PM-Token 跨源 fetch 时浏览器先发 OPTIONS —— 本守护直接应答
  204 + Access-Control-Allow-Origin/Methods/Headers/Max-Age（只回显被允许的那个 Origin，绝不 *）；
  来源不被允许的 OPTIONS → 403 且不回任何 Allow 头；预检排在令牌校验之前（规范要求，预检不带令牌）。
读取接口 GET /api/status|verify 保持开放，供本地工具探测。
`;

function parseArgs(argv) {
	const args = { profile: PROFILE_DEFAULT, port: rescuePortFromEnv(), dsh: "dsh", cwd: null, help: false, unknown: [], usageError: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile" && argv[i + 1]) { args.profile = resolve(argv[++i]); }
		else if (argv[i] === "--port" || argv[i].startsWith("--port=")) {
			const raw = argv[i].startsWith("--port=") ? argv[i].slice("--port=".length) : argv[i + 1];
			const error = validatePortValue(raw);
			if (error) { args.usageError = error; return args; }
			args.port = Number(String(raw).trim());
			if (!argv[i].startsWith("--port=")) i++;
		}
		else if (argv[i] === "--dsh" && argv[i + 1]) { args.dsh = argv[++i]; }
		else if (argv[i] === "--cwd" && argv[i + 1]) { args.cwd = resolve(argv[++i]); }
		else if (argv[i] === "--help" || argv[i] === "-h") { args.help = true; }
		else if (argv[i].startsWith("-")) { args.unknown.push(argv[i]); }
	}
	return args;
}

let args = null; // 由 main() 赋值：被 import 时保持 null，任何地方都不会启动服务/写日志

function serverLog(message) {
	if (args === null) return;
	try { appendFileSync(join(args.profile, SERVER_LOG), `[${new Date().toISOString()}] ${message}\n`, "utf8"); } catch { /* ignore */ }
}

function readBody(req, limit = 8192) {
	return new Promise((resolveBody) => {
		let data = "";
		req.on("data", (chunk) => { if (data.length < limit) data += chunk; });
		req.on("end", () => resolveBody(data));
		req.on("error", () => resolveBody(""));
	});
}

/**
 * 救援 API 路由。
 * @param {string} pathname 形如 "/api/verify"（open-boot 挂载时会先剥掉 "/rescue" 前缀）
 * @param {object} ctx {profile, dsh, cwd, port, flight?} —— **显式传入**，不再依赖模块级 args，
 *   这样 open-boot 可以直接把它挂在 `/rescue/api/*` 下复用（审计③ R7）。
 *   写接口的 Origin/令牌检查由调用方在进入本函数前完成（两道服务器共用 enginectl 的 guard）。
 */
async function handleApi(pathname, method, req, res, url, ctx = args) {
	const json = (code, body) => {
		// v1.1.0 M6（S6）：正式响应补 CORS 头（预检过了、正式响应没带 Access-Control-Allow-Origin 浏览器照样拦）。
		// 头由调用方（本守护/挂载它的 open-boot）在 handler 入口按同一套 Origin 白名单算好，只回显被允许的 Origin，绝不 *
		res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...(res.dshCorsHeaders || {}) });
		res.end(JSON.stringify(body));
	};
	if (!ctx || typeof ctx !== "object" || !ctx.profile) {
		json(503, { ok: false, error: "救援 API 未初始化（缺少 profile/port 上下文）" });
		return;
	}
	const flight = ctx.flight || null;
	if (pathname === "/api/verify" && method === "GET") {
		try {
			const result = verifyProfile(ctx.profile);
			// API 语义：ok 表示"检查请求完成"；profile 是否健康看 healthy（避免救援页把"不健康"
			// 误读成"检查失败：未知错误"，那样坏 bundle 列表反而显示不出来）。
			json(200, { ok: true, healthy: result.ok, issues: result.issues });
		} catch (error) {
			json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fix" && method === "POST") {
		try {
			const result = fixProfile(ctx.profile);
			json(200, { ok: true, ...result });
		} catch (error) {
			json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/start" && method === "POST") {
		// 写接口防护③：单飞 —— 并发第二次 start 直接 409，不会重复拉起引擎
		const entered = flight ? flight.tryEnter("rescue:/api/start") : { ok: true, entry: null };
		if (!entered.ok) {
			json(409, {
				ok: false, code: 409, busy: true,
				error: `已有启动流程在执行中（已进行 ${Math.round(entered.waited / 1000)}s）：本次请求被拒，不会重复拉起引擎。请等待当前流程结束后重试。`
			});
			return;
		}
		try {
			// 带运行期失败条目自动隔离：启动失败 → 解析日志隔离坏条目 → 重试一次
			const result = await startEngineWithQuarantine({ profileDir: ctx.profile, dshCmd: ctx.dsh, isolateFailedEntries, cwd: ctx.cwd });
			serverLog(result.ok ? `引擎启动成功：${result.message}` : `引擎启动失败：${result.message}`);
			json(200, result);
		} catch (error) {
			json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (flight) flight.leave(entered.entry);
		}
		return;
	}
	if (pathname === "/api/stop" && method === "POST") {
		let force = url.searchParams.get("force") === "1";
		try {
			const body = JSON.parse((await readBody(req)) || "{}");
			if (body && body.force === true) force = true;
		} catch { /* 无 body / 非 JSON：按非强制处理 */ }
		try {
			const result = await stopEngine(ctx.profile, { force, port: ENGINE_PORT });
			serverLog(result.ok ? `停止引擎成功：${result.message}` : `停止引擎被拒/失败：${result.message}`);
			json(200, result);
		} catch (error) {
			json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/status" && method === "GET") {
		const engine = await engineHealth(ENGINE_PORT);
		const engineTcp = engine.ok ? true : await probe(ENGINE_PORT);
		const pidInfo = readPidInfo(ctx.profile);
		const launcher = await launcherHealth(ctx.port);
		json(200, {
			app: RESCUE_APP, identity: RESCUE_APP, pid: process.pid, port: ctx.port,
			profile: ctx.profile, startedAt: startedAt, version: null,
			engineUp: engine.ok, enginePort: ENGINE_PORT,
			engineMarker: engine.marker || null, engineHttpStatus: engine.status ?? null,
			engineOccupiedByOther: !engine.ok && engineTcp ? portOwner(ENGINE_PORT) : null,
			engineProcess: pidInfo ? { ...pidInfo, alive: isAlive(pidInfo.pid) } : null,
			launcherPortIdentity: launcher.ok ? launcher.identity : null
		});
		return;
	}
	json(404, { ok: false, error: "not found" });
}

/**
 * 救援页 HTML（自包含，无外部资源）。
 * @param {object} opts
 *   - apiPrefix：API 前缀（rescue-daemon 自身为 ""；open-boot 挂载时为 "/rescue"）
 *   - enginePort：引擎端口（页面跳转目标）
 *   - entryUrl：启动器入口地址（来自 DSH_LAUNCHER_PORT，默认 http://127.0.0.1:3081/，仅作提示）
 *   - token：一次性令牌，注入 `<meta name="dsh-pm-token">`（**只进页面与请求头，不落盘、不落日志**）
 * 导出给 open-boot 复用（审计③ R7：3081 一个入口提供完整救援能力）。
 */
function rescuePageHtml({ apiPrefix = "", enginePort = ENGINE_PORT, entryUrl = entryUrlOf(launcherPortFromEnv()), token = "__DSH_PM_TOKEN__" } = {}) {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 独立救援中心</title>${DRYDOCK_FAVICON_LINK}
<meta name="dsh-pm-token" content="${token}">
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px;display:flex;justify-content:center}
.card{max-width:640px;width:100%;background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 4px;color:#fff}.sub{color:#8b93a3;font-size:13px;margin-bottom:20px}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
button{padding:9px 16px;border-radius:8px;border:1px solid #3a4050;background:#242a36;color:#e6e6e6;cursor:pointer;font-size:14px}
button:hover{background:#2d3544}button.danger{background:#7f1d1d;border-color:#a03030}
button:disabled{opacity:.55;cursor:progress}button.done{animation:doneflash .9s ease-out}
@keyframes doneflash{0%{box-shadow:0 0 0 0 rgba(96,165,250,0)}30%{box-shadow:0 0 0 3px #2563eb}100%{box-shadow:0 0 0 0 rgba(96,165,250,0)}}
button.primary{background:#1d4ed8;border-color:#2563eb}
pre{background:#0b0d11;border:1px solid #2a2e38;border-radius:8px;padding:12px;font-size:12px;white-space:pre-wrap;max-height:320px;overflow:auto}
.result{font-size:13px;white-space:pre-wrap}.ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}
a{color:#60a5fa}
</style></head><body><div class="card">
<h1>${drydockLogoMarkSvg(22)} 🛟 DSH 独立救援中心</h1>
<div class="sub">独立于主引擎的救援入口 · 引擎挂了这里依然可用 · 停止引擎前会校验 pid 与端口归属 · 写操作需同源 + 一次性令牌</div>
<div class="row">
<button class="primary" onclick="startAndOpen(this)">启动引擎并打开主界面</button>
<button onclick="runVerify(this)">运行检查</button>
<button class="danger" onclick="runFix(this)">修复引擎配置</button>
<button onclick="runStatus(this)">状态</button>
<button class="danger" onclick="runStop(this)">停止引擎</button>
</div>
<div class="result" id="out">就绪。先点"运行检查"看 profile 是否健康。</div>
<script>
const API = ${JSON.stringify(apiPrefix)};
const TOKEN = (document.querySelector('meta[name="dsh-pm-token"]') || {}).content || "";
const out = document.getElementById("out");
function show(html, cls){ out.innerHTML = html; out.className = "result " + (cls||""); }
// U1：每次点击先让按钮进入 loading 态（禁用 + 文案），结束还原并闪一下 —— 用户能看出"点到了/还在跑"
function busy(btn, label){
	if (!btn) return function(){};
	const old = btn.textContent;
	btn.disabled = true;
	btn.textContent = label || "处理中…";
	return function(){ btn.disabled = false; btn.textContent = old; };
}
async function withBusy(btn, label, fn){
	const done = busy(btn, label);
	let result;
	try { result = await fn(); } finally { done(); }
	if (btn) {
		btn.classList.remove("done");
		void btn.offsetWidth;
		btn.classList.add("done");
		setTimeout(function(){ btn.classList.remove("done"); }, 1000);
	}
	return result;
}
async function api(path, method, body){
	const r = await fetch(API + path, { method: method || "GET", headers: { "Content-Type": "application/json", "X-DSH-PM-Token": TOKEN }, body: body ? JSON.stringify(body) : undefined });
	return r.json();
}
async function runVerify(btn){
	return withBusy(btn, "检查中…", async function(){
		show("检查中…（读取 profile 与 bundle 可解析性）");
		try {
			const r = await api("/api/verify");
			if (r.ok === true && Array.isArray(r.issues) && r.issues.length === 0) show("✓ profile 配置正常，引擎可以正常启动。", "ok");
			else if (r.ok === true) show("⚠ 发现 " + r.issues.length + " 个问题：\\n" + r.issues.map(i=>"• "+i.name+": "+i.reason).join("\\n"), "bad");
			else show("检查失败：" + (r.error||"服务端未返回原因"), "bad");
		} catch(e){ show("请求失败：" + e.message, "bad"); }
	});
}
async function runFix(btn){
	return withBusy(btn, "修复中…", async function(){
		if(!confirm("确认执行修复？将隔离损坏的 bundle 并还原损坏的补丁文件（均带备份）。")) { show("已取消修复（未改动任何文件）。", "warn"); return; }
		show("修复中…（隔离损坏 bundle → 还原补丁 → 逐项验证，均带备份）");
		try {
			const r = await api("/api/fix", "POST");
			if (r.ok === true) show("✓ 修复完成\\n" + (r.message||""), "ok");
			else show("修复失败：" + (r.error || JSON.stringify(r)), "bad");
		} catch(e){ show("请求失败：" + e.message, "bad"); }
	});
}
async function runStatus(btn){
	return withBusy(btn, "读取中…", async function(){
		show("正在读取引擎 / 守护 / 端口状态…");
		try {
			const r = await api("/api/status");
			let text = "引擎：" + (r.engineUp ? "运行中（HTTP 握手正常，端口 " + r.enginePort + "）" : "未运行");
			if (r.engineOccupiedByOther) text += "\\n⚠ 端口 " + r.enginePort + " 被 pid " + r.engineOccupiedByOther + " 占用，但它不是 dsh 引擎";
			if (r.engineProcess) text += "\\n引擎 PID 文件：" + JSON.stringify(r.engineProcess);
			text += "\\n救援守护 PID：" + r.pid + "（端口 " + r.port + "）";
			show(text, r.engineUp ? "ok" : "warn");
		} catch(e){ show("请求失败：" + e.message, "bad"); }
	});
}
async function startAndOpen(btn){
	return withBusy(btn, "启动中…", async function(){
		show("正在启动引擎（自检→启动→等待就绪）…启动期间本按钮保持禁用，避免重复拉起。");
		try {
			const r = await api("/api/start", "POST");
			show((r.alreadyRunning ? "引擎已在运行。" : (r.message||"已请求启动。")), r.ok ? "ok" : "bad");
			if (r.ok) setTimeout(() => location.href = "http://127.0.0.1:${enginePort}/", 800);
		} catch(e){ show("请求失败：" + e.message, "bad"); }
	});
}
async function runStop(btn){
	return withBusy(btn, "停止中…", async function(){
		if(!confirm("确认停止引擎？会先校验 PID 与端口归属，校验不过会被拒绝。")) { show("已取消停止（引擎未被动过）。", "warn"); return; }
		show("正在停止引擎（先校验 PID 与端口归属）…");
		try {
			let r = await api("/api/stop", "POST", {});
			if (r.refused) {
				if (!confirm("已拒绝结束：\\n" + r.message + "\\n\\n确认强制结束该进程树？（仅在确认 pid 就是本机的 dsh 引擎时使用）")) { show(r.message, "warn"); return; }
				show("正在强制结束进程树（已确认 pid 归属）…");
				r = await api("/api/stop", "POST", { force: true });
			}
			show(r.message || JSON.stringify(r), r.ok ? "ok" : "bad");
		} catch(e){ show("请求失败：" + e.message, "bad"); }
	});
}
</script>
<div class="sub" style="margin:14px 0 0">唯一网页入口（浏览器主页 / 桌面快捷方式）：<a href="${entryUrl}">${entryUrl}</a></div>
</div></body></html>`;
}

const startedAt = new Date().toISOString();

/**
 * 启动救援守护（常驻）。只在直接运行时调用；被 import 时不执行（便于测试）。
 * @returns {number|null} 退出码，或 null 表示常驻不退出。
 */
function main() {
	args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(HELP_TEXT);
		return 0;
	}
	if (args.usageError) {
		console.error(`[rescue-daemon] ✘ 用法错误：${args.usageError}`);
		console.error(HELP_TEXT);
		return 1;
	}
	if (args.unknown.length > 0) console.error(`[rescue-daemon] ⚠ 无法识别的参数（已忽略）：${args.unknown.join(" ")}`);
	mkdirSync(args.profile, { recursive: true });
	chdirStable(args.cwd); // 审计③ L2：不要把 profile/包目录当 cwd

	// L11：一次性令牌（每次启动随机生成）只注入页面 meta 与请求头，**不写日志、不落 profile 文件**
	const token = newApiToken();
	// v1.1.0 M2（契约 F1/F2）：桌面版渲染进程的页面来源是自定义协议 `dsh-app://app`，桌面页发来的写请求
	// Origin 会被同源白名单判成"跨站"→403。默认全关，只有 DSH_DRYDOCK_ALLOW_DESKTOP_ORIGIN=1 才多认这一个
	// 固定来源；令牌照旧校验（桌面令牌由宿主经 DSH_DRYDOCK_DESKTOP_TOKEN 同时交给服务与桌面页面）。
	const writeOriginPolicy = writeOriginPolicyFromEnv();
	const flight = createSingleFlight("rescue-write");
	const ctx = { profile: args.profile, dsh: args.dsh, cwd: args.cwd, port: args.port, flight };
	const entryUrl = entryUrlOf(launcherPortFromEnv()) || "http://127.0.0.1:3081/";
	const pageHtml = rescuePageHtml({ apiPrefix: "", enginePort: ENGINE_PORT, entryUrl, token });

	process.on("uncaughtException", (error) => {
		serverLog(`✗ 未捕获异常：${error && error.stack ? error.stack : String(error)}`);
		console.error(error);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => serverLog(`✗ 未处理的 Promise 拒绝：${reason && reason.stack ? reason.stack : String(reason)}`));
	process.on("exit", (code) => serverLog(`进程退出：code ${code}（pid ${process.pid}，cwd ${process.cwd()}）`));

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const pathname = url.pathname;
		// v1.1.0 M6（S6，P0 收尾）：CORS 预检分支 —— 必须排在路由与 `guardWriteRequest` **之前**
		// （预检请求按 CORS 规范不带令牌；桌面版页面来源 dsh-app://app 带 X-DSH-PM-Token 跨源 fetch 本端口时
		// 浏览器必定先发 OPTIONS）。来源被允许 → 204 + Allow-*（回显被允许的 Origin，绝不 *）；
		// 来源不被允许 → 403 且不回任何 Allow 头。既有 guardWriteRequest 判定一行未改。
		const allowDesktopApp = writeOriginPolicy.allowDesktopApp;
		const corsHeaders = corsResponseHeaders(req, { port: args.port, allowDesktopApp });
		if (corsHeaders) res.dshCorsHeaders = corsHeaders; // handleApi 的 json() 复用它给正式响应补 Allow-Origin + Vary
		const pre = corsPreflightResponse(req, { port: args.port, allowDesktopApp });
		if (pre) {
			res.writeHead(pre.status, pre.message ? { "Content-Type": "application/json; charset=utf-8", ...pre.headers } : { ...pre.headers });
			res.end(pre.message ? JSON.stringify({ ok: false, code: pre.status, error: pre.message }) : "");
			return;
		}
		if (pathname === "/" || pathname === "/rescue") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(pageHtml);
			return;
		}
		// 写接口防护①②（L11）：Origin + 一次性令牌；读取接口（GET /api/status|verify）保持可被本地工具探测
		if (req.method === "POST") {
			const failure = guardWriteRequest(req, { port: args.port, token, ...writeOriginPolicy });
			if (failure) {
				res.writeHead(failure.status, { "Content-Type": "application/json; charset=utf-8", ...(res.dshCorsHeaders || {}) });
				res.end(JSON.stringify({ ok: false, code: failure.code, error: failure.message }));
				return;
			}
		}
		await handleApi(pathname, req.method, req, res, url, ctx);
	});

	server.on("error", (error) => {
		if (error.code === "EADDRINUSE") {
			// 审计③ L4/L12：不静默 +1 漂移端口（那会让救援页落到意料之外的端口）
			const owner = portOwner(args.port);
			const message = `[rescue-daemon] ✘ 端口 ${args.port} 已被占用（pid ${owner ?? "未知"}）。` +
				`为避免救援页落到意料之外的端口，本进程退出（exit 1）：请结束该进程，或 --port 指定其他端口。`;
			console.error(message);
			serverLog(message);
			process.exit(1);
		}
		console.error("daemon error:", error.message);
		serverLog(`daemon error: ${error.message}`);
		process.exit(1);
	});

	server.listen(args.port, "127.0.0.1", () => {
		console.log(`[rescue-daemon] 独立救援服务就绪：http://127.0.0.1:${args.port}/`);
		console.log(`[rescue-daemon] profile: ${args.profile}；cwd: ${process.cwd()}`);
		console.log(`[rescue-daemon] 引擎端口: ${ENGINE_PORT}（/api/start 会拉起 \`${args.dsh} web\`）`);
		console.log(`[rescue-daemon] 端口分工：启动器网页入口 = ${entryUrl}（已含 /rescue + /rescue/api/* 完整救援能力）；` +
			`本守护端口 ${args.port}（可用 --port / DSH_RESCUE_PORT 覆盖），仅作独立备份入口。浏览器主页请指向 ${entryUrl}`);
		serverLog(`服务就绪：http://127.0.0.1:${args.port}/（profile ${args.profile}，cwd ${process.cwd()}；启动器入口 ${entryUrl}）`);
	});

	// 心跳：让"守护是否还活着"有据可查（审计③ L3 同类问题）
	const heartbeat = setInterval(async () => {
		const engine = await engineHealth(ENGINE_PORT);
		serverLog(`心跳：${args.port} 救援页正常；引擎 ${ENGINE_PORT} ${engine.ok ? "正常" : "未就绪"}；pid ${process.pid}`);
	}, 10 * 60 * 1000);
	heartbeat.unref?.();

	return null; // 常驻
}

/** 只在"直接运行本文件"时执行入口（被 import 时不执行，便于测试）。语义与 bin/open-boot.mjs:776-792 完全对齐。 */
function isDirectRun() {
	if (process.env.DSH_LAUNCHER_IMPORT_ONLY === "1") return false;
	const entry = process.argv[1];
	// argv[1] 缺失（`node -e "import(...)"` / `--input-type=module -e`）说明不是"运行脚本"：
	// 此时若判成直接运行，会在 import 时就 bind 3081 / 写 profile 日志 / 占用事件循环。→ 一律不执行入口。
	if (!entry) return false;
	const norm = (p) => {
		try { return realpathSync(p).replace(/\\/g, "/").toLowerCase(); }
		catch { try { return resolve(p).replace(/\\/g, "/").toLowerCase(); } catch { return p; } }
	};
	return norm(entry) === norm(SELF);
}

if (isDirectRun()) {
	const code = main();
	if (code !== null) process.exit(code);
}

export { HELP_TEXT, PORT_DEFAULT, DRYDOCK_FAVICON_LINK, drydockLogoMarkSvg, handleApi, main, parseArgs, rescuePageHtml };
