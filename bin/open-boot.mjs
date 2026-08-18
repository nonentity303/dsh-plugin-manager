#!/usr/bin/env node
/**
 * open-boot.mjs — 浏览器访问即触发自检启动（P0-2）。
 *
 * 用户痛点：外部启动器/快捷方式会被忘记，或下意识刷新浏览器。本服务让
 * "打开网页" 这个动作本身成为触发器。
 *
 * 两种模式：
 * 1) 普通模式（默认，端口 3081）：手动入口。打开 http://127.0.0.1:3081/ →
 *    verify → 有问题自动 fix → 拉起 `dsh web` → 跳转 3080。
 * 2) front 模式（--front）：常驻接管。引擎存活时仅轻量探测（10s）；
 *    引擎挂了 → 自动接管 3080 端口 → 浏览器访问 3080 → 返回引导页 +
 *    后台 verify→fix→spawn 引擎 → 让位 3080 → 引导页轮询到就绪后跳转。
 *    开机自启注册此模式即可实现"打开 3080 自动拉起"。
 *
 * 用法：
 *   node bin/open-boot.mjs [--profile <dir>] [--port <n>] [--dsh <cmd>]
 *   node bin/open-boot.mjs --front [--profile <dir>] [--port <n>] [--dsh <cmd>]
 * 零新依赖（复用 lib/preflight.mjs 与 lib/enginectl.mjs）。
 */
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { verifyProfile, fixProfile } from "../lib/preflight.mjs";
import { ENGINE_PORT, probe, startEngine } from "../lib/enginectl.mjs";

const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");

function parseArgs(argv) {
	const args = { profile: PROFILE_DEFAULT, port: 3081, dsh: "dsh", front: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile" && argv[i + 1]) { args.profile = resolve(argv[++i]); }
		else if (argv[i] === "--port" && argv[i + 1]) { args.port = Number(argv[i + 1]) || 3081; i++; }
		else if (argv[i] === "--dsh" && argv[i + 1]) { args.dsh = argv[++i]; }
		else if (argv[i] === "--front") { args.front = true; }
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
<div class="sub" id="sub">正在执行 自检 → 修复 → 启动，完成后自动打开主界面…</div>
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

/** front 模式引导页：引擎拉起中，JS 轮询 3080 直到就绪后跳转。 */
const FRONT_PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH 启动器</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:40px 24px;display:flex;justify-content:center}
.card{max-width:560px;width:100%;background:#1a1d24;border:1px solid #2a2e38;border-radius:12px;padding:24px;text-align:center}
h1{font-size:20px;color:#fff;margin:0 0 6px}.sub{color:#8b93a3;font-size:13px;margin-bottom:22px}
.spinner{width:34px;height:34px;border:3px solid #2a2e38;border-top-color:#60a5fa;border-radius:50%;margin:0 auto 16px;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.bad{color:#f87171}
</style></head><body><div class="card">
<h1>🚀 DSH 启动器</h1>
<div class="sub">检测到引擎未运行 — 正在自检修复并启动，请稍候…</div>
<div class="spinner" id="spin"></div>
<p class="sub" id="hint">就绪后自动跳转主界面（最长 90 秒）</p>
<script>
const ENGINE = "http://127.0.0.1:${ENGINE_PORT}/";
const deadline = Date.now() + 90000;
async function tryPoll() {
	try {
		const r = await fetch(ENGINE, { cache: "no-store", mode: "no-cors" });
		if (r.type === "opaque" || r.ok || r.status === 200) { location.href = ENGINE; return true; }
	} catch (e) { /* engine not up yet */ }
	return false;
}
(async () => {
	while (Date.now() < deadline) {
		if (await tryPoll()) return;
		await new Promise((res) => setTimeout(res, 1200));
	}
	document.getElementById("spin").style.display = "none";
	document.getElementById("hint").innerHTML = '启动超时。请打开 <a href="http://127.0.0.1:__PORT__/" style="color:#60a5fa">救援中心</a> 手动处理。';
})();
</script>
</div></body></html>`;

/** front 模式：常驻探测 3080，引擎挂时接管并引导拉起。 */
async function runFront(args) {
	console.log(`[open-boot:front] 常驻模式启动。profile: ${args.profile}；引擎端口 ${ENGINE_PORT}；探测间隔 10s`);
	// 尝试附带 3081 手动入口（失败则忽略，仅做 3080 接管）
	const manual = createServer(async (req, res) => {
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
	manual.on("error", (e) => {
		if (e.code === "EADDRINUSE") console.log(`[open-boot:front] 端口 ${args.port} 被占用（可能是 rescue-daemon），跳过手动入口`);
	});
	manual.listen(args.port, "127.0.0.1", () => console.log(`[open-boot:front] 手动入口 http://127.0.0.1:${args.port}/`));

	// 3080 接管循环
	for (;;) {
		if (await probe(ENGINE_PORT, 800)) {
			await new Promise((r) => setTimeout(r, 10000));
			continue;
		}
		console.log(`[open-boot:front] 引擎未运行（${ENGINE_PORT} 无响应），尝试接管 ${ENGINE_PORT}…`);
		let front;
		await new Promise((resolveListen) => {
			front = createServer((req, res) => {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(FRONT_PAGE.replaceAll("__PORT__", String(args.port)));
				// 响应发出后让位，再后台拉起引擎
				front.close(() => {
					console.log(`[open-boot:front] 已让位 ${ENGINE_PORT}，开始自检修复启动…`);
					boot(args.profile, args.dsh)
						.then((r) => console.log(`[open-boot:front] boot 结果: ${r.ok ? "OK" : "FAIL"} ${r.message || ""}`))
						.catch((e) => console.error(`[open-boot:front] boot 异常: ${e.message}`));
				});
			});
			front.once("error", (e) => {
				if (e.code === "EADDRINUSE") console.log(`[open-boot:front] ${ENGINE_PORT} 已被占用（引擎可能刚恢复），继续探测`);
				resolveListen(false);
			});
			front.listen(ENGINE_PORT, "127.0.0.1", () => {
				console.log(`[open-boot:front] 已接管 ${ENGINE_PORT}，等待浏览器访问触发自检启动…`);
				resolveListen(true);
			});
		});
		if (front === undefined) {
			// 接管失败（端口被占）→ 稍后重新探测
			await new Promise((r) => setTimeout(r, 5000));
			continue;
		}
		// 挂起直到收到浏览器请求（handler 会响应引导页、让位并后台 boot）
		await new Promise((r) => front.once("request", r));
		// 等让位与 boot 启动动作落定，再回到探测循环
		await new Promise((r) => setTimeout(r, 1000));
	}
}

// ---- 入口 ----
const args = parseArgs(process.argv.slice(2));

if (args.front) {
	await runFront(args);
} else {
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
		console.log(`[open-boot] 就绪：http://127.0.0.1:${args.port}/（浏览器主页设为此地址即可"打开即启动"）`);
		console.log(`[open-boot] profile: ${args.profile}；引擎端口: ${ENGINE_PORT}`);
	});
}
