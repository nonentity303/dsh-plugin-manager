#!/usr/bin/env node
/**
 * open-boot.mjs — 浏览器访问即触发自检启动（网页启动入口）。
 *
 * 在 3081 端口提供常驻网页入口：打开 http://127.0.0.1:3081/ →
 * 自动 verify → 有问题自动 fix（隔离坏 bundle）→ 拉起 `dsh web` → 跳转 3080。
 *
 * 设计取舍：v0.7.0 曾实现 "--front" 模式（引擎挂时接管 3080 端口返回引导页），
 * 因端口争抢/keep-alive 等竞态导致引导页无限循环，已移除。3081 独立入口
 * 无端口争抢，稳定可靠——把浏览器主页/书签设为 http://127.0.0.1:3081/ 即可
 * 实现"打开网页即自检启动"。
 *
 * 用法：
 *   node bin/open-boot.mjs [--profile <dir>] [--port <n>] [--dsh <cmd>]
 * 零新依赖（复用 lib/preflight.mjs 与 lib/enginectl.mjs）。
 */
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { verifyProfile, fixProfile } from "../lib/preflight.mjs";
import { ENGINE_PORT, probe, startEngine } from "../lib/enginectl.mjs";

const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");

function parseArgs(argv) {
	const args = { profile: PROFILE_DEFAULT, port: 3081, dsh: "dsh" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile" && argv[i + 1]) { args.profile = resolve(argv[++i]); }
		else if (argv[i] === "--port" && argv[i + 1]) { args.port = Number(argv[i + 1]) || 3081; i++; }
		else if (argv[i] === "--dsh" && argv[i + 1]) { args.dsh = argv[++i]; }
		else if (argv[i] === "--front") { /* 已移除 3080 接管模式，忽略该参数 */ }
	}
	return args;
}

/** boot 流程：verify → fix → start → 返回结果。 */
async function boot(profileDir, dshCmd) {
	if (await probe(ENGINE_PORT)) {
		return { ok: true, alreadyRunning: true, message: `引擎已在 ${ENGINE_PORT} 运行，直接打开主界面。` };
	}
	const verify = verifyProfile(profileDir);
	let fixed = null;
	if (!verify.ok && verify.issues.length > 0) {
		fixed = fixProfile(profileDir);
	}
	const start = await startEngine({ profileDir, dshCmd });
	return {
		ok: start.ok,
		alreadyRunning: false,
		verifyOk: verify.ok,
		issues: verify.issues,
		fixed,
		start
	};
}

const PAGE_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 启动器</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:40px 24px;display:flex;justify-content:center}
.card{max-width:560px;width:100%;background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:24px;text-align:center}
h1{font-size:20px;color:#fff;margin:0 0 6px}.sub{color:#8b93a3;font-size:13px;margin-bottom:22px}
.spinner{width:34px;height:34px;border:3px solid #2a2e38;border-top-color:#60a5fa;border-radius:50%;margin:0 auto 16px;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
pre{background:#0b0d11;border:1px solid #2a2e38;border-radius:8px;padding:12px;font-size:12px;text-align:left;white-space:pre-wrap;max-height:280px;overflow:auto}
.ok{color:#4ade80}.bad{color:#f87171}
</style></head><body><div class="card">
<h1>🚀 DSH 启动器</h1>
<div class="sub">正在执行 自检 → 修复 → 启动，完成后自动打开主界面…</div>
<div class="spinner" id="spin"></div>
<pre id="out"></pre>
<script>
const out = document.getElementById("out");
function log(line, cls){ out.innerHTML += (cls?'<span class="'+cls+'">':'') + line.replace(/</g,'&lt;') + (cls?'</span>':'') + "\\n"; }
(async () => {
	try {
		const r = await fetch("/api/boot", { method: "POST" }).then((x) => x.json());
		if (r.ok && r.alreadyRunning) {
			log("✓ " + r.message, "ok");
			location.href = "http://127.0.0.1:${ENGINE_PORT}/";
			return;
		}
		log("自检：" + (r.verifyOk ? "✓ 配置正常" : "⚠ 发现 " + (r.issues||[]).length + " 个问题"), r.verifyOk ? "ok" : "bad");
		if (r.fixed) log("修复：" + (r.fixed.message || "完成"), "ok");
		if (r.start && r.start.ok) { log("✓ " + (r.start.message || "引擎已启动"), "ok"); setTimeout(() => location.href = "http://127.0.0.1:${ENGINE_PORT}/", 600); }
		else { log("✗ 启动失败：" + JSON.stringify(r.start || r), "bad"); document.getElementById("spin").style.display = "none"; }
	} catch (e) {
		log("✗ 请求失败：" + e.message, "bad");
		document.getElementById("spin").style.display = "none";
	}
})();
</script>
</div></body></html>`;

// ---- 入口 ----
const args = parseArgs(process.argv.slice(2));

const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://127.0.0.1");
	if (url.pathname === "/" || url.pathname === "/rescue") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(PAGE_HTML);
		return;
	}
	if (url.pathname === "/api/boot" && req.method === "POST") {
		try {
			const result = await boot(args.profile, args.dsh);
			res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(result));
		} catch (error) {
			res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
		}
		return;
	}
	if (url.pathname === "/api/status") {
		res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ engineUp: await probe(ENGINE_PORT), enginePort: ENGINE_PORT }));
		return;
	}
	res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
	res.end("not found");
});

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		console.error(`端口 ${args.port} 被占用，尝试 ${args.port + 1}…`);
		args.port += 1;
		server.listen(args.port, "127.0.0.1");
	} else {
		console.error("open-boot error:", error.message);
		process.exit(1);
	}
});

server.listen(args.port, "127.0.0.1", () => {
	console.log(`[open-boot] 就绪：http://127.0.0.1:${args.port}/（浏览器主页设为此地址即可"打开即自检启动"）`);
	console.log(`[open-boot] profile: ${args.profile}；引擎端口: ${ENGINE_PORT}`);
});
