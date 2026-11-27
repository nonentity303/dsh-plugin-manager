// test-admission.mjs — 救援路由的宿主准入（ctx.connection.requestRejection）单元测试。
// 覆盖：无 Connection 服务时保留旧行为；401/403 拒绝；放行；判定抛错 fail-closed；
//      headers 原样透传给宿主判定；方法检查在准入之后（先认证再 405）。
// 1.0.4 追加：/rescue 200/401/403 与 /plugins-launcher 200 必须携带救援安全响应头
//      （CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy）。
// 用法: node test-admission.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginManagerPro, RESCUE_SECURITY_HEADERS } from "./lib/index.js";

const failures = [];
const ok = (cond, label) => { if (cond) console.log("OK:", label); else { failures.push(label); console.error("FAIL:", label); } };

const SECURITY_HEADER_NAMES = Object.keys(RESCUE_SECURITY_HEADERS);
/** 断言响应头包含四项救援安全头，且值与 lib/index.js 的常量一致。 */
function checkSecurityHeaders(res, label) {
	const headers = res.headers || {};
	for (const name of SECURITY_HEADER_NAMES) {
		ok(headers[name] === RESCUE_SECURITY_HEADERS[name], `${label}: header ${name} = ${JSON.stringify(RESCUE_SECURITY_HEADERS[name])}`);
	}
}

const profileDir = mkdtempSync(join(tmpdir(), "pm-admission-"));
mkdirSync(join(profileDir, "node_modules"), { recursive: true });
writeFileSync(join(profileDir, "package.json"), JSON.stringify({
	name: "dsh-profile-test",
	private: true,
	dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
	dependencies: { "@deepseek-ai/dsh-base": "0.2.2-rc.5", "@deepseek-ai/dsh-web-app": "0.2.2-rc.5" }
}, null, 2), "utf8");

/** 记录 writeHead / end 的最小响应替身。 */
function makeRes() {
	return {
		status: 0,
		headers: null,
		body: "",
		writeHead(status, headers) { this.status = status; this.headers = headers ?? null; return this; },
		end(body) { this.body = body === undefined ? "" : String(body); return this; }
	};
}

/** 最小宿主 ctx：get("connection") 返回注入的 Connection 替身（undefined 表示无该服务）。 */
function makeCtx(connectionFactory) {
	return {
		loader: {
			ctx: { baseUrl: pathToFileURL(profileDir + "/").href },
			entries: () => [],
			resolve: () => undefined
		},
		on: () => {},
		inject: (_servs, _okCb, failCb) => { if (typeof failCb === "function") failCb(); },
		logger: { info: () => {} },
		reflect: { provide: () => {} },
		get: (name) => (name === "connection" ? connectionFactory() : undefined)
	};
}

const req = (method = "GET", headers = { host: "127.0.0.1:33080" }) => ({ method, headers });

// 1) 没有 Connection 服务（headless / 更早引擎）：保留旧行为，放行。
{
	const svc = new PluginManagerPro(makeCtx(() => undefined));
	ok(svc.hostAdmissionRejection(req()) === null, "no connection service → admitted (legacy fallback)");
	const res = makeRes();
	svc.serveRescue(req(), res);
	ok(res.status === 200 && /text\/html/.test(String(res.headers?.["content-type"])), "no connection → /rescue 200 html");
	checkSecurityHeaders(res, "/rescue 200");
	const res2 = makeRes();
	svc.serveLauncherInfo(req(), res2);
	ok(res2.status === 200 && /json/.test(String(res2.headers?.["content-type"])), "no connection → /plugins-launcher 200 json");
	checkSecurityHeaders(res2, "/plugins-launcher 200");
}

// 2) 401 未认证：两条路由都拒绝，且 headers 原样透传给宿主判定。
{
	let seen = null;
	const svc = new PluginManagerPro(makeCtx(() => ({ requestRejection(payload) { seen = payload; return 401; } })));
	const headers = { host: "127.0.0.1:33080", cookie: "dsh-browser-x=abc" };
	const res = makeRes();
	svc.serveRescue(req("GET", headers), res);
	ok(res.status === 401, "401 → /rescue refused with 401");
	ok(res.body.includes("未认证"), "401 body explains authentication (zh)");
	checkSecurityHeaders(res, "/rescue 401");
	ok(seen?.headers === headers, "request headers passed through to requestRejection");
	const res2 = makeRes();
	svc.serveLauncherInfo(req("GET", headers), res2);
	ok(res2.status === 401, "401 → /plugins-launcher refused with 401");
	checkSecurityHeaders(res2, "/plugins-launcher 401");
}

// 3) 403 Host/Origin 校验失败。
{
	const svc = new PluginManagerPro(makeCtx(() => ({ requestRejection: () => 403 })));
	const res = makeRes();
	svc.serveRescue(req(), res);
	ok(res.status === 403, "403 → /rescue refused with 403");
	ok(res.body.includes("已拒绝"), "403 body explains the refusal (zh)");
	checkSecurityHeaders(res, "/rescue 403");
}

// 3b) CSP 内容本身必须包含关键指令（防"空头"或误删 unsafe-inline 导致救援页脚本失效）。
{
	const csp = RESCUE_SECURITY_HEADERS["content-security-policy"];
	for (const directive of ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) {
		ok(csp.includes(directive), `CSP includes ${directive}`);
	}
	ok(SECURITY_HEADER_NAMES.length === 4, "exactly 4 rescue security headers");
}

// 4) 放行（undefined）。
{
	const svc = new PluginManagerPro(makeCtx(() => ({ requestRejection: () => undefined })));
	const res = makeRes();
	svc.serveRescue(req(), res);
	ok(res.status === 200, "admitted → /rescue 200");
	checkSecurityHeaders(res, "/rescue 200 (admitted)");
	const res2 = makeRes();
	svc.serveLauncherInfo(req(), res2);
	ok(res2.status === 200, "admitted → /plugins-launcher 200");
	checkSecurityHeaders(res2, "/plugins-launcher 200 (admitted)");
}

// 5) 宿主判定自身抛错：fail-closed（403），不能因为校验坏了就敞开。
{
	const svc = new PluginManagerPro(makeCtx(() => ({ requestRejection() { throw new Error("boom"); } })));
	const res = makeRes();
	svc.serveRescue(req(), res);
	ok(res.status === 403, "requestRejection throws → fail-closed 403");
}

// 6) 先准入后方法检查：已认证但方法不对 → 405（行为不变）。
{
	const svc = new PluginManagerPro(makeCtx(() => ({ requestRejection: () => undefined })));
	const res = makeRes();
	svc.serveRescue(req("POST"), res);
	ok(res.status === 405, "admitted POST → 405 (method check still runs after admission)");
	const res2 = makeRes();
	svc.serveLauncherInfo(req("POST"), res2);
	ok(res2.status === 405, "admitted POST → 405 for /plugins-launcher");
}

// 7) 只记一次「宿主无准入」日志（避免每请求刷屏）。
{
	const infos = [];
	const ctx = makeCtx(() => undefined);
	ctx.logger = { info: (m) => infos.push(String(m)) };
	const svc = new PluginManagerPro(ctx);
	svc.serveRescue(req(), makeRes());
	svc.serveRescue(req(), makeRes());
	svc.serveLauncherInfo(req(), makeRes());
	ok(infos.filter((m) => m.includes("host admission unavailable")).length === 1, "admission-unavailable warning logged once");
}

rmSync(profileDir, { recursive: true, force: true });

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	process.exit(1);
}
console.log("\n全部通过");
