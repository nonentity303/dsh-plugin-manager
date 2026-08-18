#!/usr/bin/env node
/**
 * rescue-daemon.mjs — 独立救砖守护服务（不依赖 DSH 主进程）。
 *
 * 用途：主引擎启动失败时，/rescue 救援页（由主引擎 webServer 注册）会随之瘫痪。
 * 本守护进程独立于 DSH 主进程运行在备用端口（默认 3081），提供：
 *   GET  /              → 自包含中文救援页（诊断/修复/启动/重启）
 *   GET  /api/verify    → verifyProfile()（standalone 自检）
 *   POST /api/fix       → fixProfile()（隔离坏 bundle / 恢复损坏补丁）
 *   POST /api/start     → 拉起 `dsh web`（detached，日志+PID 文件）
 *   POST /api/stop      → 按 PID 结束引擎
 *   GET  /api/status    → { engineUp, port, pid }
 *
 * 用法：node bin/rescue-daemon.mjs [--profile <dir>] [--port <n>] [--dsh <cmd>]
 *   默认 profile: ~/.dsh/profiles/web；默认端口 3081（被占用自动 +1）。
 * 零新依赖：node:http / node:net / node:fs / node:path / node:os / node:child_process + yaml（项目已有）。
 */
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { verifyProfile, fixProfile } from "../lib/preflight.mjs";
import { ENGINE_PORT, probe, readPid, startEngine, stopEngine } from "../lib/enginectl.mjs";

const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");
const PID_FILE = ".rescue-daemon.pid";

function parseArgs(argv) {
	const args = { profile: PROFILE_DEFAULT, port: 3081, dsh: "dsh" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile" && argv[i + 1]) { args.profile = resolve(argv[++i]); }
		else if (argv[i] === "--port" && argv[i + 1]) { args.port = Number(argv[i + 1]) || 3081; i++; }
		else if (argv[i] === "--dsh" && argv[i + 1]) { args.dsh = argv[++i]; }
	}
	return args;
}

async function handleApi(pathname, method, res) {
	const json = (code, body) => {
		const payload = JSON.stringify(body);
		res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
		res.end(payload);
	};
	if (pathname === "/api/verify" && method === "GET") {
		try {
			const result = verifyProfile(args.profile);
			json(200, { ok: true, ...result });
		} catch (error) {
			json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/fix" && method === "POST") {
		try {
			const result = fixProfile(args.profile);
			json(200, { ok: true, ...result });
		} catch (error) {
			json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/start" && method === "POST") {
		try {
			json(200, await startEngine({ profileDir: args.profile, dshCmd: args.dsh }));
		} catch (error) {
			json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/stop" && method === "POST") {
		try {
			json(200, await stopEngine(args.profile));
		} catch (error) {
			json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (pathname === "/api/status" && method === "GET") {
		json(200, { engineUp: await probe(ENGINE_PORT), enginePort: ENGINE_PORT, pid: readPid(args.profile) });
		return;
	}
	json(404, { ok: false, error: "not found" });
}

const PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 独立救援中心</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px;display:flex;justify-content:center}
.card{max-width:640px;width:100%;background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 4px;color:#fff}.sub{color:#8b93a3;font-size:13px;margin-bottom:20px}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
button{padding:9px 16px;border-radius:8px;border:1px solid #3a4050;background:#242a36;color:#e6e6e6;cursor:pointer;font-size:14px}
button:hover{background:#2d3544}button.danger{background:#7f1d1d;border-color:#a03030}
button.primary{background:#1d4ed8;border-color:#2563eb}
pre{background:#0b0d11;border:1px solid #2a2e38;border-radius:8px;padding:12px;font-size:12px;white-space:pre-wrap;max-height:320px;overflow:auto}
.result{font-size:13px;white-space:pre-wrap}.ok{color:#4ade80}.bad{color:#f87171}
a{color:#60a5fa}
</style></head><body><div class="card">
<h1>🛟 DSH 独立救援中心</h1>
<div class="sub">独立于主引擎的救砖入口 · 引擎挂了这里依然可用</div>
<div class="row">
<button class="primary" onclick="startAndOpen()">启动引擎并打开主界面</button>
<button onclick="runVerify()">运行检查</button>
<button class="danger" onclick="runFix()">修复引擎配置</button>
<button onclick="runStatus()">状态</button>
<button class="danger" onclick="runStop()">停止引擎</button>
</div>
<div class="result" id="out">就绪。先点"运行检查"看 profile 是否健康。</div>
<script>
const out = document.getElementById("out");
function show(html, cls){ out.innerHTML = html; out.className = "result " + (cls||""); }
async function api(path, method, body){
	const r = await fetch(path, { method: method || "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
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
		show("引擎状态： " + (r.engineUp ? "运行中（端口 " + r.enginePort + "）" : "未运行") + "\\n守护 PID： " + (r.pid || "无"));
	} catch(e){ show("请求失败：" + e.message, "bad"); }
}
async function startAndOpen(){
	show("正在启动引擎（自检→启动→等待就绪）…");
	try {
		const r = await api("/api/start", "POST");
		show((r.alreadyRunning ? "引擎已在运行。" : (r.message||"已请求启动。")), r.ok ? "ok" : "bad");
		if (r.ok) setTimeout(() => location.href = "http://127.0.0.1:${ENGINE_PORT}/", 800);
	} catch(e){ show("请求失败：" + e.message, "bad"); }
}
async function runStop(){
	if(!confirm("确认停止引擎？")) return;
	try { const r = await api("/api/stop", "POST"); show(r.message || JSON.stringify(r), "ok"); } catch(e){ show("请求失败：" + e.message, "bad"); }
}
</script>
</div></body></html>`;

const args = parseArgs(process.argv.slice(2));

const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	const pathname = url.pathname;
	if (pathname === "/" || pathname === "/rescue") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(PAGE_HTML);
		return;
	}
	await handleApi(pathname, req.method, res);
});

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		console.error(`端口 ${args.port} 被占用，尝试 ${args.port + 1}…`);
		args.port += 1;
		server.listen(args.port, "127.0.0.1");
	} else {
		console.error("daemon error:", error.message);
		process.exit(1);
	}
});

server.listen(args.port, "127.0.0.1", () => {
	console.log(`[rescue-daemon] 独立救援服务就绪：http://127.0.0.1:${args.port}/`);
	console.log(`[rescue-daemon] profile: ${args.profile}`);
	console.log(`[rescue-daemon] 引擎端口: ${ENGINE_PORT}（/api/start 会拉起 \`${args.dsh} web\`）`);
});
