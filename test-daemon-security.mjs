// test-daemon-security.mjs — 3082 独立救援守护的 1.0.4 安全收口集成测试。
//
// 覆盖（攻击测试残留②）：
//   1) 正常回环 Host（127.0.0.1 / localhost / [::1]，大小写不敏感）→ 200 救援页 + 四项安全头；
//   2) Host 伪造（外部域名 / 无端口）→ 421 JSON，且 421 响应也带安全头；
//   3) POST 写接口无令牌 → 401（同源 Origin），带安全头；
//   4) 跨站 Origin → 403，带安全头；
//   5) GET /api/verify → 200，带安全头。
//
// 隔离要求：temp profile + temp DSH_HOME + 随机空闲端口；DSH_ENGINE_PORT 指向未占用端口，
// 不碰 3080/3081/3082、不联网。结束 kill 子进程并清理临时目录。
// 用法: node test-daemon-security.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "bin", "rescue-daemon.mjs");

/** 与 lib/index.js / bin/rescue-daemon.mjs 保持一致的期望值（精确字符串比较）。 */
const SECURITY_HEADERS = {
	"content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
	"x-frame-options": "DENY",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer"
};

const failures = [];
const ok = (cond, label) => {
	if (cond) console.log("OK:", label);
	else { failures.push(label); console.error("FAIL:", label); }
};

/** 断言响应头含四项救援安全头（值与期望一致）。 */
function checkSecurityHeaders(res, label) {
	for (const [name, expected] of Object.entries(SECURITY_HEADERS)) {
		ok(res.headers[name] === expected, `${label}: header ${name} = ${JSON.stringify(expected)}`);
	}
}

/** 用 node:http（fetch 不允许自定义 Host 头）发一次回环请求。 */
function httpRequest(port, { method = "GET", path = "/", headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method, path, headers, timeout: 5000 }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { body += chunk; });
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on("timeout", () => req.destroy(new Error("request timeout")));
		req.on("error", reject);
		req.end();
	});
}

/** 取一个当前空闲的回环端口（先 listen 0 再立即关闭；测试单进程内使用）。 */
function freePort() {
	return new Promise((resolvePort, reject) => {
		const srv = createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolvePort(port));
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到救援页可访问或子进程退出/超时。 */
async function waitForDaemon(port, child, readOutput) {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`rescue-daemon 提前退出（code=${child.exitCode} signal=${child.signalCode}）：\n${readOutput()}`);
		}
		try {
			const res = await httpRequest(port, { headers: { host: `127.0.0.1:${port}` } });
			if (res.status === 200) return;
		} catch { /* 还没 listen / 连接被拒：重试 */ }
		await sleep(100);
	}
	throw new Error(`等待 rescue-daemon 就绪超时（15s，端口 ${port}）：\n${readOutput()}`);
}

const profileDir = mkdtempSync(join(tmpdir(), "pm-daemon-profile-"));
const dshHome = mkdtempSync(join(tmpdir(), "pm-daemon-home-"));
mkdirSync(join(dshHome, "profiles"), { recursive: true });

const port = await freePort();
let deadEnginePort = await freePort();
while (deadEnginePort === port) deadEnginePort = await freePort(); // 极端情况（端口复用）下重取
const deadLauncherPort = await freePort();

let child = null;
let output = "";
const killChild = () => {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
};

try {
	child = spawn(process.execPath, [
		DAEMON,
		"--profile", profileDir,
		"--port", String(port),
		"--dsh", "definitely-not-a-real-dsh-binary"
	], {
		env: {
			...process.env,
			DSH_HOME: dshHome,
			DSH_ENGINE_PORT: String(deadEnginePort),
			DSH_LAUNCHER_PORT: String(deadLauncherPort)
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true
	});
	child.stdout.on("data", (chunk) => { output += String(chunk); });
	child.stderr.on("data", (chunk) => { output += String(chunk); });
	const readOutput = () => output.slice(-4000);

	await waitForDaemon(port, child, readOutput);
	ok(true, `rescue-daemon 已就绪（隔离端口 ${port}）`);

	// 1) 正常回环 Host → 200 救援页 + 安全头。
	{
		const res = await httpRequest(port, { headers: { host: `127.0.0.1:${port}` } });
		ok(res.status === 200, "正常 Host 127.0.0.1:<port> → 200");
		ok(res.body.includes("DSH 独立救援中心"), "200 body 是救援页");
		checkSecurityHeaders(res, "页面 200");
	}

	// 2) localhost 大小写不敏感 → 200。
	{
		const res = await httpRequest(port, { headers: { host: `LOCALHOST:${port}` } });
		ok(res.status === 200, "大小写不敏感的 localhost:<port> → 200");
		checkSecurityHeaders(res, "页面 200 (localhost)");
	}

	// 3) IPv6 回环 [::1]:<port> → 200（Host 头允许，实际连接仍走 127.0.0.1）。
	{
		const res = await httpRequest(port, { headers: { host: `[::1]:${port}` } });
		ok(res.status === 200, "回环 [::1]:<port> → 200");
	}

	// 4) Host 伪造 → 421 JSON（放在路由之前），421 也带安全头。
	{
		const res = await httpRequest(port, { headers: { host: `evil.example.com:${port}` } });
		ok(res.status === 421, "Host 伪造 evil.example.com:<port> → 421");
		let json = null;
		try { json = JSON.parse(res.body); } catch { /* 非 JSON 由断言暴露 */ }
		ok(json?.ok === false && json?.code === 421, "421 JSON 含 ok:false / code:421");
		ok(json?.error === "Host 不被允许（仅接受回环地址）", "421 JSON error 文案符合规格");
		checkSecurityHeaders(res, "421");
	}

	// 5) Host 不带端口 → 421（规格：必须带端口）。
	{
		const res = await httpRequest(port, { headers: { host: "127.0.0.1" } });
		ok(res.status === 421, "Host 无端口 127.0.0.1 → 421");
	}

	// 6) API 读取接口也带安全头（GET /api/verify 无需令牌）。
	{
		const res = await httpRequest(port, { headers: { host: `127.0.0.1:${port}` }, path: "/api/verify" });
		ok(res.status === 200, "GET /api/verify（正常 Host）→ 200");
		checkSecurityHeaders(res, "API 200");
	}

	// 7) 写接口：同源 Origin + 无令牌 → 401，带安全头。
	{
		const res = await httpRequest(port, {
			method: "POST",
			path: "/api/fix",
			headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }
		});
		ok(res.status === 401, "POST /api/fix 无令牌 → 401");
		let json = null;
		try { json = JSON.parse(res.body); } catch { /* ignore */ }
		ok(json?.code === 401, "401 JSON 含 code:401");
		checkSecurityHeaders(res, "401");
	}

	// 8) 写接口：跨站 Origin → 403，带安全头（既有 Origin 判定未被 Host 校验破坏）。
	{
		const res = await httpRequest(port, {
			method: "POST",
			path: "/api/fix",
			headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example" }
		});
		ok(res.status === 403, "POST /api/fix 跨站 Origin → 403");
		let json = null;
		try { json = JSON.parse(res.body); } catch { /* ignore */ }
		ok(json?.code === 403, "403 JSON 含 code:403");
		checkSecurityHeaders(res, "403");
	}
} catch (error) {
	failures.push(`集成测试异常：${error instanceof Error ? error.message : String(error)}`);
	console.error("FAIL:", error);
} finally {
	killChild();
	if (child) {
		await new Promise((resolveExit) => {
			if (child.exitCode !== null || child.signalCode !== null) resolveExit();
			else {
				child.once("exit", resolveExit);
				setTimeout(resolveExit, 3000);
			}
		});
	}
	rmSync(profileDir, { recursive: true, force: true });
	rmSync(dshHome, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	process.exit(1);
}
console.log("\n全部通过");
