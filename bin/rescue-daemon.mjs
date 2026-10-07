#!/usr/bin/env node
/**
 * rescue-daemon.mjs — 独立救砖守护服务（不依赖 DSH 主进程）。
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
import {
	ENGINE_PORT, RESCUE_APP, chdirStable, createSingleFlight, engineHealth, guardWriteRequest, isAlive,
	launcherHealth, newApiToken, portOwner, probe, readPidInfo, startEngineWithQuarantine, stopEngine
} from "../lib/enginectl.mjs";

const SELF = fileURLToPath(import.meta.url);
const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");
const SERVER_LOG = "rescue-daemon-server.log";
/** v0.9.1：3081 归 open-boot（唯一网页入口），本守护退到 3082。 */
const PORT_DEFAULT = 3082;

const HELP_TEXT = `DSH 独立救砖守护（默认 3082 = 备用救援入口）

用法：
  node bin/rescue-daemon.mjs [选项]

选项：
  --profile <dir>   profile 目录（默认 ~/.dsh/profiles/web）
  --port <n>        监听端口（默认 3082；被其他进程占用时直接报错退出，不漂移）
  --dsh <cmd>       启动引擎的命令（默认 dsh；含空格的路径也可用）
  --cwd <dir>       引擎/守护工作目录（默认用户主目录）
  --help            显示本帮助

端口分工（v0.9.1 起）：
  3080 = dsh 引擎；3081 = open-boot（唯一网页入口，已含 /rescue 页面 + /rescue/api/* 完整救援能力）；
  3082 = 本守护（独立备份入口）。浏览器主页/桌面快捷方式请指向 3081。

页面按钮：启动引擎并打开主界面 / 运行检查 / 修复引擎配置 / 状态 / 停止引擎（带校验，可强制）

写接口防护：POST /api/fix|start|stop 需要同源 Origin + 一次性令牌（页面会自动带上）；
读取接口 GET /api/status|verify 保持开放，供本地工具探测。
`;

function parseArgs(argv) {
	const args = { profile: PROFILE_DEFAULT, port: PORT_DEFAULT, dsh: "dsh", cwd: null, help: false, unknown: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile" && argv[i + 1]) { args.profile = resolve(argv[++i]); }
		else if (argv[i] === "--port" && argv[i + 1]) { args.port = Number(argv[++i]) || PORT_DEFAULT; }
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
		res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
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
			json(200, { ok: true, ...result });
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
 *   - entryUrl：唯一网页入口地址（3081，仅作提示）
 *   - token：一次性令牌，注入 `<meta name="dsh-pm-token">`（**只进页面与请求头，不落盘、不落日志**）
 * 导出给 open-boot 复用（审计③ R7：3081 一个入口提供完整救援能力）。
 */
function rescuePageHtml({ apiPrefix = "", enginePort = ENGINE_PORT, entryUrl = "http://127.0.0.1:3081/", token = "__DSH_PM_TOKEN__" } = {}) {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 独立救援中心</title>
<meta name="dsh-pm-token" content="${token}">
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px;display:flex;justify-content:center}
.card{max-width:640px;width:100%;background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 4px;color:#fff}.sub{color:#8b93a3;font-size:13px;margin-bottom:20px}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
button{padding:9px 16px;border-radius:8px;border:1px solid #3a4050;background:#242a36;color:#e6e6e6;cursor:pointer;font-size:14px}
button:hover{background:#2d3544}button.danger{background:#7f1d1d;border-color:#a03030}
button.primary{background:#1d4ed8;border-color:#2563eb}
pre{background:#0b0d11;border:1px solid #2a2e38;border-radius:8px;padding:12px;font-size:12px;white-space:pre-wrap;max-height:320px;overflow:auto}
.result{font-size:13px;white-space:pre-wrap}.ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}
a{color:#60a5fa}
</style></head><body><div class="card">
<h1>🛟 DSH 独立救援中心</h1>
<div class="sub">独立于主引擎的救砖入口 · 引擎挂了这里依然可用 · 停止引擎前会校验 pid 与端口归属 · 写操作需同源 + 一次性令牌</div>
<div class="row">
<button class="primary" onclick="startAndOpen()">启动引擎并打开主界面</button>
<button onclick="runVerify()">运行检查</button>
<button class="danger" onclick="runFix()">修复引擎配置</button>
<button onclick="runStatus()">状态</button>
<button class="danger" onclick="runStop()">停止引擎</button>
</div>
<div class="result" id="out">就绪。先点"运行检查"看 profile 是否健康。</div>
<script>
const API = ${JSON.stringify(apiPrefix)};
const TOKEN = (document.querySelector('meta[name="dsh-pm-token"]') || {}).content || "";
const out = document.getElementById("out");
function show(html, cls){ out.innerHTML = html; out.className = "result " + (cls||""); }
async function api(path, method, body){
	const r = await fetch(API + path, { method: method || "GET", headers: { "Content-Type": "application/json", "X-DSH-PM-Token": TOKEN }, body: body ? JSON.stringify(body) : undefined });
	return r.json();
}
async function runVerify(){
	show("检查中…");
	try {
		const r = await api("/api/verify");
		if (r.ok === true && Array.isArray(r.issues) && r.issues.length === 0) show("✓ profile 配置正常，引擎可以正常启动。", "ok");
		else if (r.ok === true) show("⚠ 发现 " + r.issues.length + " 个问题：\\n" + r.issues.map(i=>"• "+i.name+": "+i.reason).join("\\n"), "bad");
		else show("检查失败：" + (r.error||"未知错误"), "bad");
	} catch(e){ show("请求失败：" + e.message, "bad"); }
}
async function runFix(){
	if(!confirm("确认执行修复？将隔离损坏的 bundle 并还原损坏的补丁文件（均带备份）。")) return;
	show("修复中…");
	try {
		const r = await api("/api/fix", "POST");
		if (r.ok === true) show("✓ 修复完成\\n" + (r.message||""), "ok");
		else show("修复失败：" + JSON.stringify(r), "bad");
	} catch(e){ show("请求失败：" + e.message, "bad"); }
}
async function runStatus(){
	try {
		const r = await api("/api/status");
		let text = "引擎：" + (r.engineUp ? "运行中（HTTP 握手正常，端口 " + r.enginePort + "）" : "未运行");
		if (r.engineOccupiedByOther) text += "\\n⚠ 端口 " + r.enginePort + " 被 pid " + r.engineOccupiedByOther + " 占用，但它不是 dsh 引擎";
		if (r.engineProcess) text += "\\n引擎 PID 文件：" + JSON.stringify(r.engineProcess);
		text += "\\n救援守护 PID：" + r.pid + "（端口 " + r.port + "）";
		show(text, r.engineUp ? "ok" : "warn");
	} catch(e){ show("请求失败：" + e.message, "bad"); }
}
async function startAndOpen(){
	show("正在启动引擎（自检→启动→等待就绪）…");
	try {
		const r = await api("/api/start", "POST");
		show((r.alreadyRunning ? "引擎已在运行。" : (r.message||"已请求启动。")), r.ok ? "ok" : "bad");
		if (r.ok) setTimeout(() => location.href = "http://127.0.0.1:${enginePort}/", 800);
	} catch(e){ show("请求失败：" + e.message, "bad"); }
}
async function runStop(){
	if(!confirm("确认停止引擎？会先校验 PID 与端口归属，校验不过会被拒绝。")) return;
	try {
		let r = await api("/api/stop", "POST", {});
		if (r.refused) {
			if (!confirm("已拒绝结束：\\n" + r.message + "\\n\\n确认强制结束该进程树？（仅在确认 pid 就是本机的 dsh 引擎时使用）")) { show(r.message, "warn"); return; }
			r = await api("/api/stop", "POST", { force: true });
		}
		show(r.message || JSON.stringify(r), r.ok ? "ok" : "bad");
	} catch(e){ show("请求失败：" + e.message, "bad"); }
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
	if (args.unknown.length > 0) console.error(`[rescue-daemon] ⚠ 无法识别的参数（已忽略）：${args.unknown.join(" ")}`);
	mkdirSync(args.profile, { recursive: true });
	chdirStable(args.cwd); // 审计③ L2：不要把 profile/包目录当 cwd

	// L11：一次性令牌（每次启动随机生成）只注入页面 meta 与请求头，**不写日志、不落 profile 文件**
	const token = newApiToken();
	const flight = createSingleFlight("rescue-write");
	const ctx = { profile: args.profile, dsh: args.dsh, cwd: args.cwd, port: args.port, flight };
	const pageHtml = rescuePageHtml({ apiPrefix: "", enginePort: ENGINE_PORT, entryUrl: "http://127.0.0.1:3081/", token });

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
		if (pathname === "/" || pathname === "/rescue") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(pageHtml);
			return;
		}
		// 写接口防护①②（L11）：Origin + 一次性令牌；读取接口（GET /api/status|verify）保持可被本地工具探测
		if (req.method === "POST") {
			const failure = guardWriteRequest(req, { port: args.port, token });
			if (failure) {
				res.writeHead(failure.status, { "Content-Type": "application/json; charset=utf-8" });
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
		console.log(`[rescue-daemon] 端口分工（v0.9.1）：3081 = open-boot 唯一网页入口（已含 /rescue + /rescue/api/* 完整救援能力）；` +
			`本守护默认端口已从 3081 迁移到 ${PORT_DEFAULT}，仅作独立备份入口。浏览器主页请指向 http://127.0.0.1:3081/`);
		serverLog(`服务就绪：http://127.0.0.1:${args.port}/（profile ${args.profile}，cwd ${process.cwd()}；3081 归 open-boot）`);
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

export { HELP_TEXT, PORT_DEFAULT, handleApi, main, parseArgs, rescuePageHtml };
