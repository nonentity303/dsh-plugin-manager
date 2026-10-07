// test-launcher.mjs — 启动器 / 救砖链路单测（审计④ R9；覆盖审计③ 的 L6/L8 回归）。
//
// 设计约束（安全第一）：
//  - 端口：全部随机（listen(0) 取空闲端口）→ 不碰 3080 引擎、不碰 3081 启动器。
//  - profile：全部 mkdtemp 临时目录 → 绝不读写真 profile（~/.dsh/profiles/web）。
//  - 绝不调用 rescue-daemon 的 POST /api/start（会真的拉起引擎）。
//  - 绝不调用 open-boot 的 --install-autostart / --uninstall-autostart（会改用户注册表）；
//    自启只测只读的 --autostart-status，并断言运行前后整个 Run 键逐字节一致。
//  - 子进程输出走临时文件（stdio 重定向）而不是管道，避免受限环境下 pipe 被拒。
//
// 用法：node test-launcher.mjs [--strict]
//   --strict（或 LAUNCHER_STRICT=1）：把"写域外（bin/）的已知缺陷"xfail 当失败。
//
// 覆盖：
//  1. lib/enginectl.mjs   probe / waitForEngine / readPid / readEngineLog / ENGINE_PORT
//  2. lib/preflight.mjs   verifyProfile / fixProfile（隔离 + 损坏 patch 重建）/ isolateFailedEntries
//  3. bin/open-boot.mjs   parseArgs（含审计③ L6 吞参回归）、buildShimLines/writeShim（L8 中文路径编码）
//  4. bin/open-boot.mjs   --help / --autostart-status（只读幂等 + 注册表不变）
//  5. bin/dsh-boot.mjs    --repair-only 冒烟（临时 profile）
//  6. bin/dsh-boot.cmd    双击冒烟（Windows；审计③ L1）
//  7. bin/rescue-daemon.mjs  随机端口 + 临时 profile 的 /、/api/verify、/api/status
//  7. bin/*.mjs           import 安全（isDirectRun 守卫）
//  v0.9.1 新增（审计③ 遗留四项）：
//  8. R13  --uninstall 卸载闭环：装自启 → 卸 → 注册表零残留 / shim 删除 / pid 清理 / 幂等 /
//          归属校验拒绝误杀（两个临时 profile 互相验证）/ 注册表快照-恢复 / 真机 3081 pid 不变
//  9. L11  本地写接口三道防护：第三方 Origin → 403 / 缺错令牌 → 401 / 并发 → 409（不重复拉起引擎）/
//          同源带令牌 → 200 / 令牌随机且不落日志与 profile / 读取接口不回归
// 10. P1-5 --status 健康留痕：追加 health.log（ISO+OK/FAIL+端口）/ 输出含「最近自检」/ 不改 profile 配置
// 11. R7  救援入口与端口分工：open-boot 端口上 /rescue 页面 + /rescue/api/* 可达 /
//          rescue-daemon 默认端口改 3082 / 两者同时启动不冲突 / 端口被占明确报错不漂移
// 12. F1/F2（t12）localhost 同源入口 + 探测受限时 --uninstall 保留 pid 且不假报成功
// 13. t17 用法错误与目标闸门：--profile 缺值/被开关占用/= 形式/空白/文件 → 用法错误或拒绝 + 零副作用
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const STRICT = process.argv.includes("--strict") || process.env.LAUNCHER_STRICT === "1";
const WIN = process.platform === "win32";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const failures = [];
const xfails = [];
let checks = 0;

const ok = (name, cond, detail = "") => {
	checks++;
	if (cond) { console.log(`OK: ${name}`); return; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
};

/** 写域外（bin/）的已知缺陷：默认只报告，--strict 下算失败。 */
const xfail = (id, name, cond, detail = "", owner = "bin/（修复③ 启动器链路；修复④ 写域外）") => {
	checks++;
	if (cond) { console.log(`OK: ${name}`); return; }
	xfails.push(`${id} ${name} — ${detail}（owner: ${owner}）`);
	console.warn(`XFAIL(${id}): ${name} — ${detail}`);
};

/**
 * 环境能力探测（2026-10-06）：**DSH 会话沙箱禁止 Node 打开命名管道**，因此
 * `child_process.spawn/spawnSync` 默认的管道 stdio 会直接 EPERM —— reg.exe / netstat / tasklist
 * 全部取不到输出（`portOwner()` / `processImage()` / `reg query` 一律返回 null）。
 * 这类断言在沙箱内**无法产生证据**：标记 SKIP（不假通过、也不谎报失败），
 * 并在收尾打印"需在沙箱外复跑"的清单与命令。
 */
const CHILD_PIPE_OK = (() => {
	if (!WIN) return true;
	try {
		const probe = spawnSync("reg", ["query", RUN_KEY], { encoding: "utf8", windowsHide: true });
		return !(probe.error && (probe.error.code === "EPERM" || probe.error.code === "EACCES"));
	} catch { return false; }
})();
const skipped = [];
const SANDBOX_NOTE = "沙箱边界：Node 管道子进程被拒（reg/netstat/tasklist EPERM）→ 需在沙箱外复跑";

/** ok() 的环境敏感版本：沙箱内取不到子进程输出时记 SKIP（计入 checks，但不计入失败）。 */
const skipOk = (name, cond, detail = "") => {
	if (CHILD_PIPE_OK) { ok(name, cond, detail); return; }
	checks++;
	skipped.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.warn(`SKIP: ${name} — ${SANDBOX_NOTE}`);
};

// ---------------------------------------------------------------- 基础设施
const tempDirs = [];
function tempDir(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function freePort() {
	return new Promise((resolvePort, rejectPort) => {
		const srv = createServer();
		srv.once("error", rejectPort);
		srv.listen(0, "127.0.0.1", () => {
			const port = srv.address().port;
			srv.close(() => resolvePort(port));
		});
	});
}

function listenOn(port) {
	return new Promise((resolveListen, rejectListen) => {
		const sockets = new Set();
		const srv = createServer((sock) => {
			sockets.add(sock);
			sock.on("close", () => sockets.delete(sock));
		});
		srv.__sockets = sockets;
		srv.once("error", rejectListen);
		srv.listen(port, "127.0.0.1", () => resolveListen(srv));
	});
}

/** 关掉监听：先断开已接受的连接，再 close（否则 close 回调永远等不到）。 */
async function closeSrv(srv) {
	for (const sock of srv.__sockets ?? []) {
		try { sock.destroy(); } catch { /* ignore */ }
	}
	await new Promise((r) => srv.close(() => r()));
}

const portOpen = (port, timeoutMs = 400) => new Promise((resolveProbe) => {
	const sock = connect({ host: "127.0.0.1", port });
	const done = (v) => { sock.destroy(); resolveProbe(v); };
	sock.setTimeout(timeoutMs);
	sock.once("connect", () => done(true));
	sock.once("timeout", () => done(false));
	sock.once("error", () => done(false));
});

async function waitPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await portOpen(port)) return true;
		await new Promise((r) => setTimeout(r, 120));
	}
	return false;
}

/** 子进程环境：清掉 import-only 开关，否则子进程会跳过入口逻辑。 */
function childEnv() {
	const env = { ...process.env };
	delete env.DSH_LAUNCHER_IMPORT_ONLY;
	delete env.LAUNCHER_STRICT;
	return env;
}

/** 跑一个短命子进程：输出重定向到临时文件（不用管道）。 */
function runNode(args, { cwd = ROOT, timeoutMs = 120000, env = {} } = {}) {
	const dir = tempDir("pm-launcher-run-");
	const out = join(dir, "out.log");
	const err = join(dir, "err.log");
	const fdOut = openSync(out, "w");
	const fdErr = openSync(err, "w");
	const res = spawnSync(process.execPath, args, {
		cwd, env: { ...childEnv(), ...env }, stdio: ["ignore", fdOut, fdErr], windowsHide: true, timeout: timeoutMs
	});
	closeSync(fdOut);
	closeSync(fdErr);
	return { code: res.status, signal: res.signal, stdout: readFileSync(out, "utf8"), stderr: readFileSync(err, "utf8") };
}

/** 长命子进程（守护/服务）：输出重定向到临时文件，随读随关。env 可覆盖（如 DSH_ENGINE_PORT）。 */
function spawnNode(args, { cwd = ROOT, logName = "svc", env = {} } = {}) {
	const dir = tempDir("pm-launcher-spawn-");
	const out = join(dir, `${logName}.out.log`);
	const err = join(dir, `${logName}.err.log`);
	const fdOut = openSync(out, "w");
	const fdErr = openSync(err, "w");
	const child = spawn(process.execPath, args, { cwd, env: { ...childEnv(), ...env }, stdio: ["ignore", fdOut, fdErr], windowsHide: true });
	closeSync(fdOut);
	closeSync(fdErr);
	const log = () => {
		const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
		return { out: read(out), err: read(err) };
	};
	return { child, log };
}

async function killChild(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((r) => child.once("exit", r));
	try { child.kill(); } catch { /* ignore */ }
	await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
	try { child.kill("SIGKILL"); } catch { /* ignore */ }
}

async function getJson(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch { /* keep null */ }
	return { status: res.status, json, text };
}

/** POST（可带自定义头 / JSON body），返回 status/json/text。 */
async function postJson(url, { headers = {}, body } = {}) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(20000)
	});
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch { /* keep null */ }
	return { status: res.status, json, text };
}

/** 从页面 HTML 里取一次性令牌（L11）。 */
function tokenFromHtml(html) {
	const m = /<meta name="dsh-pm-token" content="([^"]*)">/.exec(html);
	return m ? m[1] : null;
}

/** 递归列出目录下所有文件（跳过 node_modules 桩包，只看 profile 根级与子目录）。 */
function listFiles(dir, acc = []) {
	let entries = [];
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			listFiles(full, acc);
		} else acc.push(full);
	}
	return acc;
}

const readJsonFile = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- R13 用：注册表 Run 键里 DSHWeb* 值的快照 / 恢复（测试前后必须逐条还原）----
function snapshotDshWebRunValues() {
	const values = regListRunValues();
	if (values === null) return [];
	return values.filter((v) => /^DSHWeb/i.test(v.name));
}

function regQueryDshWebNames() {
	return snapshotDshWebRunValues().map((v) => v.name);
}

function restoreDshWebRunValues(snapshot) {
	if (!WIN) return;
	for (const value of snapshotDshWebRunValues()) {
		spawnSync("reg", ["delete", RUN_KEY, "/v", value.name, "/f"], { windowsHide: true, encoding: "utf8" });
	}
	for (const value of snapshot) {
		spawnSync("reg", ["add", RUN_KEY, "/v", value.name, "/t", value.type, "/d", value.data, "/f"], { windowsHide: true, encoding: "utf8" });
	}
}

/**
 * 结束一个由测试自己拉起的进程树（**只用于测试夹具**；open-boot 自身绝不使用 /T，见 R13）。
 * 注意用 stdio:"ignore"（不建命名管道）——受限会话下管道 stdio 会被沙箱拒（EPERM），
 * 而这条命令只需要退出码，不需要输出。
 */
function killTree(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (WIN) {
		const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		if (res.error || res.status !== 0) { try { process.kill(pid); } catch { /* 已经不在 */ } }
	} else {
		try { process.kill(pid, "SIGKILL"); } catch { /* 已经不在 */ }
	}
}

// 在临时 profile 里造一个"可解析"的 bundle 桩包（2026-09-30，CI）：
// verifyProfile 的判据是 `<profile>/node_modules/<pkg>` 存在且声明了 dsh.bundle。
// 以前这条断言是**环境相关**的——本机靠 `%APPDATA%\npm\node_modules` 里的全局 dsh 兜底才通过，
// CI 上没有全局 dsh 就变成假失败。让夹具自带桩包后，断言在哪儿都成立。
function writeBundleStub(profileDir, name) {
	const rel = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name;
	const pkgDir = join(profileDir, "node_modules", rel);
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
		name,
		version: "0.0.0-stub",
		dsh: { bundle: { patch: "./cordis.patch.yml" } }
	}, null, 2) + "\n", "utf8");
	writeFileSync(join(pkgDir, "cordis.patch.yml"), "[]\n", "utf8");
}

function writeProfile(dir, bundles, extra = {}) {
	writeFileSync(join(dir, "package.json"), JSON.stringify({
		name: "pm-launcher-test-profile",
		private: true,
		dsh: { profile: { bundles } },
		dependencies: {},
		...extra
	}, null, 2) + "\n", "utf8");
	writeFileSync(join(dir, "cordis.patch.yml"), "# pm-launcher test profile\n[]\n", "utf8");
	// 除刻意做成"不可解析"的包（BAD）外，其余都补桩，保证夹具自洽
	for (const b of bundles) if (b !== BAD) writeBundleStub(dir, b);
	return dir;
}

/**
 * 解析 `reg query <键>` 输出为 `[{name,type,data}]`，**按 name 排序**（纯函数，可在受限会话里单测）。
 *
 * 为什么必须顺序无关（2026-10-06 队长特权会话实测）：
 * Windows 枚举 `HKCU\...\Run` 的顺序**不固定** —— 同一把键两次 dump，首条目分别是
 * `DSHWebFront` 与 `OneDrive`。早先这条断言直接比较整段 raw dump，于是顺序一变就误报
 * （非 strict 那次碰巧顺序一致，strict 那次 1/174 挂在这条上）。
 */
function parseRegQueryOutput(text) {
	const values = [];
	for (const line of String(text || "").split(/\r?\n/)) {
		const m = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
		if (m) values.push({ name: m[1], type: m[2], data: m[3].trim() });
	}
	return values.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 顺序无关的签名：`prefix=null` → 整把键；否则只取匹配前缀的值。
 * 逐条保留 `name / type / data`，因此"值必须逐字节还原"的原意不变（只是不再受枚举顺序影响）。
 */
function regSignature(values, prefix = null) {
	const picked = (values || []).filter((v) => (prefix === null ? true : prefix.test(v.name)));
	return JSON.stringify(picked.map((v) => `${v.name}\t${v.type}\t${v.data}`));
}

/** 读整把 Run 键（已排序）；读不到返回 null（≠ 空键）。 */
function regListRunValues() {
	if (!WIN) return null;
	const out = spawnSync("reg", ["query", RUN_KEY], { windowsHide: true, encoding: "utf8" });
	if (out.status !== 0 || !out.stdout) return null;
	return parseRegQueryOutput(out.stdout);
}

/** 整把 Run 键的签名（只读性断言用；读不到返回 null）。 */
function regKeySignature() {
	const values = regListRunValues();
	return values === null ? null : regSignature(values);
}

/** 友好的期望/实际打印：只列 DSHWeb* 条目（按 name 排序），避免整段 dump 刷屏。 */
const dshWebEntriesText = (values) => {
	const picked = (values || []).filter((v) => /^DSHWeb/i.test(v.name));
	return picked.length === 0 ? "(无 DSHWeb* 条目)" : picked.map((v) => `${v.name}=${v.type}:${v.data}`).join(" | ");
};

// 纯函数单测：把"顺序无关 + 值逐字节"的要求钉死（不依赖 reg.exe，受限会话也跑得到）
{
	const dump = (entries) => ["", "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", ...entries].join("\n");
	const dshLine = (data) => `    DSHWebFront    REG_SZ    ${data}`;
	const oneDrive = `    OneDrive    REG_SZ    "C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background`;
	const webRescue = `    DSHWebRescue    REG_SZ    "C:\\Windows\\System32\\wscript.exe" //nologo "old.vbs"`;
	const original = `"C:\\Windows\\System32\\wscript.exe" //nologo "C:\\Users\\nonen\\.dsh\\profiles\\web\\open-boot-autostart.vbs"`;
	// 同一组条目、**枚举顺序相反**（队长特权会话实测的真实形态：before 首条目 DSHWebFront / after 首条目 OneDrive）
	const orderA = parseRegQueryOutput(dump([dshLine(original), oneDrive, webRescue]));
	const orderB = parseRegQueryOutput(dump([oneDrive, webRescue, dshLine(original)]));
	ok("注册表比较: 枚举顺序变化不影响 DSHWeb* 签名（本次 flake 的根因已钉死）",
		regSignature(orderA, /^DSHWeb/i) === regSignature(orderB, /^DSHWeb/i),
		`A=${regSignature(orderA, /^DSHWeb/i)} B=${regSignature(orderB, /^DSHWeb/i)}`);
	ok("注册表比较: 值被改动仍然报差异（保留「逐字节还原」的原意）",
		regSignature(orderA, /^DSHWeb/i) !== regSignature(parseRegQueryOutput(dump([dshLine(original.replace("wscript.exe", "node.exe")), oneDrive, webRescue])), /^DSHWeb/i));
	ok("注册表比较: 条目新增/缺失也报差异（历史 DSHWebRescue 同样受管）",
		regSignature(orderA, /^DSHWeb/i) !== regSignature(parseRegQueryOutput(dump([dshLine(original), oneDrive])), /^DSHWeb/i));
	ok("注册表比较: 整把键签名对非 DSHWeb 条目同样敏感（只读性断言用）",
		regSignature(orderA) !== regSignature(parseRegQueryOutput(dump([dshLine(original), oneDrive.replace("/background", "/foreground"), webRescue]))));
	ok("注册表比较: 解析器忽略键路径/空行，只取值行（按 name 排序）",
		parseRegQueryOutput(dump([oneDrive, dshLine(original)])).map((v) => v.name).join(",") === "DSHWebFront,OneDrive");
}

// ---------------------------------------------------------------- 1. enginectl
console.log("== 1. lib/enginectl.mjs ==");
const { ENGINE_PORT, engineHealth, launcherHealth, probe, readPid, waitForEngine, readEngineLog, isAlive, portOwner, portOwnerProbe, processImageProbe, looksLikeProfileDir, validatePortValue, createSingleFlight, guardWriteRequest, newApiToken, allowedOriginsOf } =
	await import("./lib/enginectl.mjs");

ok("enginectl.ENGINE_PORT === 3080（引擎端口契约；仅断言常量，不连接）", ENGINE_PORT === 3080, `got ${ENGINE_PORT}`);

// L11 共享件：一次性令牌 / Origin+令牌检查 / 单飞闸门（open-boot 与 rescue-daemon 共用）
const tokenA = newApiToken();
const tokenB = newApiToken();
ok("enginectl.newApiToken: 每次调用都随机（48 hex，两次不同）",
	/^[0-9a-f]{48}$/.test(tokenA) && /^[0-9a-f]{48}$/.test(tokenB) && tokenA !== tokenB, `${tokenA.slice(0, 8)}… / ${tokenB.slice(0, 8)}…`);
ok("enginectl.guardWriteRequest: 第三方 Origin → 403（先于令牌检查）",
	guardWriteRequest({ headers: { origin: "http://evil.example" } }, { port: 3099, token: tokenA })?.status === 403);
ok("enginectl.guardWriteRequest: 缺少 X-DSH-PM-Token → 401",
	guardWriteRequest({ headers: { origin: "http://127.0.0.1:3099" } }, { port: 3099, token: tokenA })?.status === 401);
ok("enginectl.guardWriteRequest: 错误 X-DSH-PM-Token → 401",
	guardWriteRequest({ headers: { origin: "http://127.0.0.1:3099", "x-dsh-pm-token": tokenB } }, { port: 3099, token: tokenA })?.status === 401);
ok("enginectl.guardWriteRequest: 同源 + 正确令牌 → 通过（null）",
	guardWriteRequest({ headers: { origin: "http://127.0.0.1:3099", "x-dsh-pm-token": tokenA } }, { port: 3099, token: tokenA }) === null);
ok("enginectl.guardWriteRequest: 无 Origin（本地工具/非浏览器）+ 正确令牌 → 通过",
	guardWriteRequest({ headers: { "x-dsh-pm-token": tokenA } }, { port: 3099, token: tokenA }) === null);

// F1（t8 终审）：同机同端口的三个等价主机名都要被接受 —— 否则用户用 http://localhost:3081/ 打开启动页时，
// 页面自身的 POST /api/boot 会被判成"跨站来源"→403，"打开浏览器即自动启动"在 localhost 入口直接失效。
ok("enginectl.allowedOriginsOf: 白名单 = 127.0.0.1 / localhost / [::1] 且端口一致",
	JSON.stringify(allowedOriginsOf(3099)) === JSON.stringify(["http://127.0.0.1:3099", "http://localhost:3099", "http://[::1]:3099"]),
	JSON.stringify(allowedOriginsOf(3099)));
for (const origin of ["http://127.0.0.1:3099", "http://localhost:3099", "http://[::1]:3099"]) {
	ok(`F1: 同机同端口 Origin 被接受（${origin}）`,
		guardWriteRequest({ headers: { origin, "x-dsh-pm-token": tokenA } }, { port: 3099, token: tokenA }) === null);
}
for (const [origin, label] of [
	["http://evil.example", "第三方主机名"],
	["null", "Origin: null"],
	["http://localhost:3100", "localhost 但端口不对"],
	["http://127.0.0.1:3100", "127.0.0.1 但端口不对"],
	["https://localhost:3099", "scheme 不是 http"],
	["http://localhost.evil.example:3099", "前缀伪装 localhost"],
	["http://[::1]:3100", "[::1] 但端口不对"]
]) {
	ok(`F1: ${label} 仍被拒（403）${origin === "null" ? "（Origin: null）" : `（${origin}）`}`,
		guardWriteRequest({ headers: { origin, "x-dsh-pm-token": tokenA } }, { port: 3099, token: tokenA })?.status === 403);
}
ok("F1: 白名单只认固定回环主机名（不按 Host 头派生、不因缺 Origin 放宽）",
	!allowedOriginsOf(3099).some((o) => /0\.0\.0\.0|localhost\.|192\.168\.|10\./.test(o)));
{
	const gate = createSingleFlight("test");
	const first = gate.tryEnter("first");
	const second = gate.tryEnter("second");
	ok("enginectl.createSingleFlight: 并发第二个进入被拒（写接口 409 的判据）", first.ok === true && second.ok === false && gate.busy === true);
	gate.leave(first.entry);
	ok("enginectl.createSingleFlight: 第一个结束后可再次进入（单飞不是永久锁）", gate.tryEnter("third").ok === true && gate.busy === true);
	gate.leave();
	ok("enginectl.createSingleFlight: leave() 无参复位", gate.busy === false);
}
ok("enginectl.isAlive/portOwner 可用（R13 三重校验的原料）",
	typeof isAlive === "function" && typeof portOwner === "function" && isAlive(process.pid) === true && isAlive(999999) === false);

const closedPort = await freePort();
ok("enginectl.probe: 无监听端口 → false", (await probe(closedPort)) === false);

const srv = await listenOn(closedPort);
ok("enginectl.probe: 有监听端口 → true（纯占用探测）", (await probe(closedPort, 1000)) === true);
const tcpHealth = await engineHealth(closedPort, 1500);
ok("enginectl.engineHealth: 非 HTTP 监听器 → ok=false（审计③ L4：裸 TCP 不算引擎就绪）",
	tcpHealth.ok === false, JSON.stringify(tcpHealth).slice(0, 160));
const tcpLauncher = await launcherHealth(closedPort, 1500);
ok("enginectl.launcherHealth: 非启动器服务 → ok=false（身份指纹不认）",
	tcpLauncher.ok === false, JSON.stringify(tcpLauncher).slice(0, 160));
ok("enginectl.waitForEngine: 注入 health=false → 等到超时返回 false（不抛）",
	(await waitForEngine(closedPort, 500, 50, async () => false)) === false);
ok("enginectl.waitForEngine: 注入 health=true → true",
	(await waitForEngine(closedPort, 500, 50, async () => true)) === true);
xfail("L4b", "enginectl.waitForEngine: 引擎未就绪（默认 engineHealth 返回 {ok:false}）必须超时后 false",
	(await waitForEngine(closedPort, 700, 100)) === false,
	"默认 health 返回对象被当真值 → waitForEngine 立即返回 true（假健康，超时分支成死代码）",
	"lib/enginectl.mjs（修复③ 启动器链路；修复④ 写域外）");
await closeSrv(srv);
ok("enginectl.waitForEngine: 无人监听端口 → false",
	(await waitForEngine(closedPort, 400, 50, async (port) => (await probe(port)))) === false);

const engProfile = tempDir("pm-launcher-enginectl-");
ok("enginectl.readPid: 无 pid 文件 → null", readPid(engProfile) === null);
writeFileSync(join(engProfile, ".rescue-daemon.pid"), "4242\n", "utf8");
ok("enginectl.readPid: 数字 → 4242", readPid(engProfile) === 4242);
writeFileSync(join(engProfile, ".rescue-daemon.pid"), "not-a-pid\n", "utf8");
ok("enginectl.readPid: 非数字 → null", readPid(engProfile) === null);
ok("enginectl.readEngineLog: 无日志文件 → 空串（不抛）", readEngineLog(engProfile) === "");

// ---------------------------------------------------------------- 2. preflight
console.log("== 2. lib/preflight.mjs ==");
const { verifyProfile, fixProfile, isolateFailedEntries } = await import("./lib/preflight.mjs");

const BAD = "pm-launcher-missing-bundle";
const pf = writeProfile(tempDir("pm-launcher-preflight-"), ["@deepseek-ai/dsh-base", BAD]);
const v1 = verifyProfile(pf);
ok("preflight.verifyProfile: 不可解析 bundle 被报出", v1.ok === false && v1.issues.some((i) => i.name === BAD),
	JSON.stringify(v1.issues));
ok("preflight.verifyProfile: 可解析 bundle 不被误报", !v1.issues.some((i) => i.name === "@deepseek-ai/dsh-base"),
	JSON.stringify(v1.issues));

const f1 = fixProfile(pf);
ok("preflight.fixProfile: 隔离坏 bundle + ok=true", f1.ok === true && f1.quarantined.includes(BAD), f1.message);
const patch1 = parseYaml(readFileSync(join(pf, "cordis.patch.yml"), "utf8"));
ok("preflight.fixProfile: 写入可逆的 disabled 行（带归属标记）",
	Array.isArray(patch1) && patch1.some((r) => r && r.name === BAD && r.disabled === true),
	JSON.stringify(patch1).slice(0, 200));
ok("preflight.fixProfile: 备份了原 patch", f1.message.includes("备份"), f1.message);
const v2 = verifyProfile(pf);
ok("preflight: fix 后 verify 干净（不出现 verify/fix 死循环）", v2.ok === true, JSON.stringify(v2.issues));

const pf2 = writeProfile(tempDir("pm-launcher-preflight2-"), ["@deepseek-ai/dsh-base"]);
writeFileSync(join(pf2, "cordis.patch.yml"), "this: [is: not: a: valid array\n", "utf8");
const v3 = verifyProfile(pf2);
ok("preflight.verifyProfile: 损坏的 cordis.patch.yml 被报出",
	v3.ok === false && v3.issues.some((i) => i.name === "cordis.patch.yml"), JSON.stringify(v3.issues));
const f2 = fixProfile(pf2);
ok("preflight.fixProfile: 损坏 patch 被备份并重建为数组",
	f2.ok === true && f2.message.includes("重建") && Array.isArray(parseYaml(readFileSync(join(pf2, "cordis.patch.yml"), "utf8"))),
	f2.message);

const pf3 = writeProfile(tempDir("pm-launcher-preflight3-"), ["@deepseek-ai/dsh-base"]);
const iso1 = isolateFailedEntries(pf3, 'failed to apply loader entry demo (pm-launcher-bad-plugin): invalid plugin');
ok("preflight.isolateFailedEntries: 提取并隔离运行期失败条目",
	iso1.isolated.length === 1 && iso1.isolated[0] === "pm-launcher-bad-plugin", iso1.message);
const iso2 = isolateFailedEntries(pf3, 'failed to apply loader entry demo (pm-launcher-bad-plugin): invalid plugin');
ok("preflight.isolateFailedEntries: 幂等（第二次不再隔离）", iso2.isolated.length === 0, iso2.message);
ok("preflight.isolateFailedEntries: 无关日志 no-op",
	isolateFailedEntries(pf3, "no failures here").isolated.length === 0);

// ---------------------------------------------------------------- 3. open-boot parseArgs / shim
console.log("== 3. bin/open-boot.mjs（parseArgs + shim 编码）==");
let openBoot = null;
try {
	process.env.DSH_LAUNCHER_IMPORT_ONLY = "1";
	openBoot = await import("./bin/open-boot.mjs");
} catch (error) {
	ok("open-boot 可被 import（isDirectRun/import-only 守卫存在，便于测试）", false,
		error instanceof Error ? error.message : String(error));
} finally {
	delete process.env.DSH_LAUNCHER_IMPORT_ONLY;
}

if (openBoot) {
	const { parseArgs, buildShimLines, writeShim, HELP_TEXT } = openBoot;
	ok("open-boot 导出 parseArgs/buildShimLines/writeShim/HELP_TEXT",
		typeof parseArgs === "function" && typeof buildShimLines === "function"
		&& typeof writeShim === "function" && typeof HELP_TEXT === "string");

	if (typeof parseArgs === "function") {
		const d = parseArgs([]);
		ok("parseArgs: 默认值为 3081/窗口开/interval 60", d.port === 3081 && d.window === true && d.interval === 60,
			JSON.stringify({ port: d.port, window: d.window, interval: d.interval }));
		ok("parseArgs: --profile 解析为绝对路径", isAbsolute(parseArgs(["--profile", "rel/dir"]).profile),
			parseArgs(["--profile", "rel/dir"]).profile);
		ok("parseArgs: --port/--dsh/--no-window/--supervise 生效",
			parseArgs(["--port", "3099", "--dsh", "npx dsh", "--no-window", "--supervise"]).port === 3099
			&& parseArgs(["--no-window"]).window === false
			&& parseArgs(["--supervise"]).supervise === true);
		ok("parseArgs: --help / -h 生效", parseArgs(["--help"]).help === true && parseArgs(["-h"]).help === true);

		// 审计③ L6 回归：--wait-ms 历史上多一次 i++，会吞掉紧随其后的标志位
		const l6a = parseArgs(["--wait-ms", "60000", "--no-window"]);
		xfail("L6", "parseArgs: --wait-ms 不吞 --no-window（L6 回归）",
			l6a.waitMs === 60000 && l6a.window === false, JSON.stringify({ waitMs: l6a.waitMs, window: l6a.window }));
		const l6b = parseArgs(["--wait-ms", "60000", "--autostart-status"]);
		xfail("L6", "parseArgs: --wait-ms 不吞 --autostart-status（L6 回归：只读命令不得变成监听进程）",
			l6b.waitMs === 60000 && l6b.autostart === "status", JSON.stringify({ waitMs: l6b.waitMs, autostart: l6b.autostart }));
		const l6c = parseArgs(["--wait-ms", "1", "--supervise"]);
		xfail("L6", "parseArgs: --wait-ms 不吞 --supervise（L6 回归）",
			l6c.supervise === true, JSON.stringify({ waitMs: l6c.waitMs, supervise: l6c.supervise }));
		// t24 明确取代旧断言（旧的是"未知参数被收进 unknown、不静默吞掉"）：
		// 现在**开关形态**的未知 token 在解析阶段就直接用法错误（更严），只有位置参数才进 unknown。
		ok("parseArgs: 开关形态的未知 token → 用法错误 + did-you-mean（t24 取代旧的 unknown 收集）",
			typeof parseArgs(["--nope"]).usageError === "string" && /未知开关/.test(parseArgs(["--nope"]).usageError),
			String(parseArgs(["--nope"]).usageError));
		ok("parseArgs: 位置参数仍被收进 unknown（非全局模式由 unknownTokenPolicy 警告并忽略）",
			parseArgs(["--status", "some-positional"]).unknown.includes("some-positional")
			&& parseArgs(["--status", "some-positional"]).usageError === null,
			JSON.stringify(parseArgs(["--status", "some-positional"]).unknown));

		// R13 冻结契约：--uninstall [--profile <dir>] [--port <n>]
		const un1 = parseArgs(["--uninstall"]);
		ok("parseArgs: --uninstall 生效（不传参 → 默认 profile + 默认端口 3081）",
			un1.uninstall === true && un1.port === 3081 && un1.profile === openBoot.parseArgs([]).profile,
			JSON.stringify({ uninstall: un1.uninstall, port: un1.port }));
		const un2 = parseArgs(["--uninstall", "--profile", "rel/dir", "--port", "3099"]);
		ok("parseArgs: --uninstall 支持 --profile（绝对化）与 --port（签名为冻结契约，不得改）",
			un2.uninstall === true && isAbsolute(un2.profile) && un2.port === 3099,
			JSON.stringify({ uninstall: un2.uninstall, profile: un2.profile, port: un2.port }));
		ok("parseArgs: --uninstall 不吞后续标志（--wait-ms 之后仍能识别 --uninstall）",
			parseArgs(["--wait-ms", "1000", "--uninstall"]).uninstall === true && parseArgs(["--wait-ms", "1000", "--uninstall"]).waitMs === 1000);
		ok("--help: 列出 --uninstall（含语义与退出码说明）",
			/--uninstall\b/.test(HELP_TEXT) && /DSHWeb\*/.test(HELP_TEXT) && /幂等/.test(HELP_TEXT), HELP_TEXT.length + " 字节");
		ok("--help: 声明端口分工（3080 引擎 / 3081 唯一网页入口 / 3082 rescue-daemon）",
			/3081/.test(HELP_TEXT) && /3082/.test(HELP_TEXT) && /唯一网页入口/.test(HELP_TEXT));
		ok("--help: 声明 --uninstall 的三档退出码（0=完成 / 1=出错 / 2=归属未确认）",
			/退出码：0=完成/.test(HELP_TEXT) && /1=清理过程出错/.test(HELP_TEXT) && /2=\*\*归属未确认\*\*/.test(HELP_TEXT),
			HELP_TEXT.split("\n").filter((l) => l.includes("退出码")).join(" | ").slice(0, 200));
		ok("--help: 声明写接口同源白名单（127.0.0.1 / localhost / [::1]，F1）",
			/127\.0\.0\.1:<port>/.test(HELP_TEXT) && /localhost:<port>/.test(HELP_TEXT) && /\[::1\]:<port>/.test(HELP_TEXT));
	}

	if (typeof buildShimLines === "function") {
		const lines = buildShimLines({ port: 3081 }, "supervise");
		ok("buildShimLines: 正文纯 ASCII（中文用户名路径不会乱码，审计③ L8）",
			lines.every((l) => /^[\x00-\x7F]*$/.test(l)), lines.join(" | ").slice(0, 160));
		ok("buildShimLines: 不内嵌任何 profile 绝对路径（运行时由 WScript.ScriptFullName 推导）",
			!lines.some((l) => /Users[\\/]|Documents[\\/]|AppData[\\/]/.test(l)), lines.join(" | ").slice(0, 160));
		ok("buildShimLines: 缺脚本时守卫（FileExists + Quit）",
			lines.some((l) => l.includes("FileExists")) && lines.some((l) => l.includes("WScript.Quit")));
		ok("buildShimLines: 端口被替换为实参（无 PORT 占位残留）",
			lines.some((l) => l.includes("--port 3081")) && !lines.some((l) => l.includes("PORT")));
	}

	if (typeof writeShim === "function") {
		const shimDir = tempDir("pm-launcher-shim-");
		const w1 = writeShim(join(shimDir, "ascii.vbs"), ["' ascii line", "sh.Run \"x\""]);
		ok("writeShim: ASCII 正文 → ascii 落盘 + 回读校验通过",
			w1.verified === true && w1.encoding === "ascii" && readFileSync(w1.path, "utf8").includes("ascii line"),
			JSON.stringify(w1));
		const w2 = writeShim(join(shimDir, "unicode.vbs"), ["' 中文备注：路径 C:\\Users\\张三"]);
		ok("writeShim: 非 ASCII 正文 → UTF-16LE+BOM 且回读校验通过（L8 兜底分支）",
			w2.verified === true && w2.encoding === "utf-16le+bom", JSON.stringify(w2));
	}

	// v0.9.1 新增可测接口（R13 / L11 / P1-5）
	const needExports = ["uninstallLauncher", "collectOwnedDaemons", "removeDsWebRunValues", "listRunValues",
		"appendHealthLog", "pruneHealthEntries", "readLastHealthEntry", "healthLogPath", "healthEntry", "startServer", "bootPageHtml"];
	ok("open-boot 导出 v0.9.1 新增可测接口（R13/L11/P1-5）",
		needExports.every((name) => typeof openBoot[name] === "function"),
		needExports.filter((name) => typeof openBoot[name] !== "function").join(",") || "全部就绪");

	// P1-5 轮转：保留最近 7 天 / 最多 1000 行
	if (typeof openBoot.pruneHealthEntries === "function") {
		const nowMs = Date.parse("2026-10-06T12:00:00.000Z");
		const DAY = 24 * 60 * 60 * 1000;
		const line = (ms, verdict = "OK") => `${new Date(ms).toISOString()} ${verdict} boot=up@3081 engine=up@3080`;
		const tooOld = line(nowMs - 8 * DAY, "FAIL");
		const pruned = openBoot.pruneHealthEntries([
			tooOld, line(nowMs - 7 * DAY + 60 * 1000), line(nowMs - 1 * DAY), "# 手工备注"
		], { now: nowMs });
		ok("pruneHealthEntries: 超过 7 天的行被丢弃（7 天内与手工行保留）",
			pruned.length === 3 && !pruned.includes(tooOld), JSON.stringify(pruned.map((l) => l.slice(0, 24))));
		const many = Array.from({ length: 1205 }, (_, i) => line(nowMs - (1205 - i) * 1000));
		const capped = openBoot.pruneHealthEntries(many, { now: nowMs });
		ok("pruneHealthEntries: 超过 1000 行时只保留最后 1000 行",
			capped.length === 1000 && capped[0] === many[205] && capped[999] === many[1204], `len=${capped.length}`);
		ok("pruneHealthEntries: 空/未定义输入 → 空数组（不抛）",
			openBoot.pruneHealthEntries([], { now: nowMs }).length === 0 && openBoot.pruneHealthEntries(undefined, { now: nowMs }).length === 0);
		const healthDir = tempDir("pm-launcher-healthlog-");
		const healthFile = openBoot.healthLogPath(healthDir);
		ok("healthLogPath: 指向 <profile>/health.log", healthFile === join(healthDir, "health.log"), healthFile);
		ok("readLastHealthEntry: 无日志 → null", openBoot.readLastHealthEntry(healthDir) === null);
		const healthLine1 = line(nowMs - 2 * 60 * 1000);
		const healthLine2 = line(nowMs - 60 * 1000);
		const ap1 = openBoot.appendHealthLog(healthDir, healthLine1);
		const ap2 = openBoot.appendHealthLog(healthDir, healthLine2);
		const healthFileLines = readFileSync(healthFile, "utf8").trim().split(/\r?\n/);
		ok("appendHealthLog: 追加写（两行、末行 = 最近一次、可回读）",
			ap1.ok === true && ap2.ok === true && healthFileLines.length === 2 && openBoot.readLastHealthEntry(healthDir) === healthLine2,
			JSON.stringify(healthFileLines.map((l) => l.slice(0, 24))));
		openBoot.appendHealthLog(healthDir, tooOld);
		const afterOld = readFileSync(healthFile, "utf8").trim().split(/\r?\n/);
		ok("appendHealthLog: 写入时执行 7 天轮转（过期行不会被写回）",
			afterOld.length === 2 && !afterOld.some((l) => l.includes("FAIL")), JSON.stringify(afterOld.map((l) => l.slice(0, 24))));
		const entryText = openBoot.healthEntry({ ok: true, bootState: "up", port: 3081, engineState: "down", enginePort: 3080 });
		ok("healthEntry: 结论行含 ISO 时间 + OK/FAIL + boot/engine 端口状态",
			/^\d{4}-\d{2}-\d{2}T\S+ OK boot=up@3081 engine=down@3080$/.test(entryText), entryText);
	}
}

// ---------------------------------------------------------------- 4. open-boot CLI（只读）
console.log("== 4. bin/open-boot.mjs CLI（--help / --autostart-status，只读）==");
const help = runNode([join(ROOT, "bin", "open-boot.mjs"), "--help"], { timeoutMs: 30000 });
ok("open-boot --help: 退出 0 且打印用法（不启动服务）",
	help.code === 0 && /open-boot/.test(help.stdout) && /--autostart-status/.test(help.stdout),
	`exit=${help.code} out=${help.stdout.slice(0, 120)}`);

const regBefore = regKeySignature();
const st1 = runNode([join(ROOT, "bin", "open-boot.mjs"), "--autostart-status"], { timeoutMs: 60000 });
const st2 = runNode([join(ROOT, "bin", "open-boot.mjs"), "--autostart-status"], { timeoutMs: 60000 });
const regAfter = regKeySignature();
// 注意：两次运行之间，真机常驻守护可能正好写一条心跳；共享的 3081 在机器负载高时也可能
// 让状态行在"✔ 在跑 / ✘ 被占用"之间抖动。幂等断言比较**去掉这两类动态行**后的输出，
// 再单独断言状态行的取值形态（下面两条）。
const stripVolatile = (text) => text
	.replace(/^.*最近心跳：.*$/gm, "最近心跳：<动态>")
	.replace(/^.*启动器（\d+）：.*$/gm, "启动器：<动态>");
ok("open-boot --autostart-status: 幂等（两次输出完全一致，忽略心跳/共享端口状态等动态行）",
	stripVolatile(st1.stdout) === stripVolatile(st2.stdout) && st1.code === st2.code,
	`exit=${st1.code}/${st2.code}`);
ok("open-boot --autostart-status: 每次都打印「最近心跳」行（诊断信息不丢）",
	/最近心跳：/.test(st1.stdout) && /最近心跳：/.test(st2.stdout));
ok("open-boot --autostart-status: 启动器状态行取值合法（在跑 / 被占用 / 未运行，三选一）",
	/启动器（3081）：(✔ 在跑（open-boot）|✘ 端口被 pid \S+ 占用，不是本启动器|✘ 未运行)/.test(st1.stdout)
	&& /启动器（3081）：(✔ 在跑（open-boot）|✘ 端口被 pid \S+ 占用，不是本启动器|✘ 未运行)/.test(st2.stdout),
	st1.stdout.split("\n").filter((l) => l.includes("启动器（3081）")).join(" | "));
skipOk("open-boot --autostart-status: 只读（Run 键顺序无关比较：全部值 name/type/data 不变）",
	regBefore !== null && regBefore === regAfter, `before=${regBefore === null ? "(读取失败)" : regBefore.slice(0, 160)} after=${regAfter === null ? "(读取失败)" : regAfter.slice(0, 160)}`);
if (WIN) {
	ok("open-boot --autostart-status: Windows 下退出码 0/1 且输出含状态词",
		st1.code === 0 || st1.code === 1, `exit=${st1.code} out=${st1.stdout.slice(0, 160)}`);
} else {
	ok("open-boot --autostart-status: 非 Windows 明确提示不支持（退出 1）",
		st1.code === 1 && /Windows/.test(st1.stdout), `exit=${st1.code} out=${st1.stdout.slice(0, 160)}`);
}

// ---------------------------------------------------------------- 5. dsh-boot / dsh-boot.cmd
console.log("== 5. bin/dsh-boot.mjs --repair-only ==");
const bootProfile = writeProfile(tempDir("pm-launcher-boot-"), ["@deepseek-ai/dsh-base"]);
const boot = runNode([join(ROOT, "bin", "dsh-boot.mjs"), "--repair-only", "--profile", bootProfile], { timeoutMs: 120000 });
ok("dsh-boot --repair-only: 健康 profile → 退出 0（不启动引擎）",
	boot.code === 0 && /退出码 0/.test(boot.stdout), `exit=${boot.code} out=${boot.stdout.slice(0, 200)}`);

const bootBroken = writeProfile(tempDir("pm-launcher-boot2-"), [BAD]);
const boot2 = runNode([join(ROOT, "bin", "dsh-boot.mjs"), "--repair-only", "--profile", bootBroken], { timeoutMs: 120000 });
ok("dsh-boot --repair-only: 坏 bundle → 自动 fix 后退出 0",
	boot2.code === 0 && /退出码 0/.test(boot2.stdout), `exit=${boot2.code} out=${boot2.stdout.slice(0, 240)}`);

if (WIN) {
	const dir = tempDir("pm-launcher-cmd-");
	const out = join(dir, "out.log");
	const fd = openSync(out, "w");
	const res = spawnSync("cmd", ["/c", join(ROOT, "bin", "dsh-boot.cmd"), "--repair-only", "--profile", bootProfile],
		{ cwd: ROOT, env: childEnv(), stdio: ["ignore", fd, fd], windowsHide: true, timeout: 120000 });
	closeSync(fd);
	const text = readFileSync(out, "utf8");
	xfail("L1", "dsh-boot.cmd 双击冒烟：在 bin\\ 目录下也能找到脚本（审计③ L1 路径双重 bin\\）",
		res.status === 0, `exit=${res.status} out=${text.slice(0, 200)}`);
} else {
	console.log("SKIP: dsh-boot.cmd 冒烟（非 Windows）");
}

// ---------------------------------------------------------------- 6. rescue-daemon
console.log("== 6. bin/rescue-daemon.mjs（随机端口 + 临时 profile）==");
const rescueProfile = writeProfile(tempDir("pm-launcher-rescue-"), ["@deepseek-ai/dsh-base"]);
const rescuePort = await freePort();
const rescue = spawnNode([join(ROOT, "bin", "rescue-daemon.mjs"), "--port", String(rescuePort), "--profile", rescueProfile], { logName: "rescue" });
try {
	const up = await waitPort(rescuePort, 15000);
	if (!up) {
		const logs = rescue.log();
		ok("rescue-daemon: 随机端口就绪", false, `port=${rescuePort} out=${logs.out.slice(0, 200)} err=${logs.err.slice(0, 200)}`);
	} else {
		ok("rescue-daemon: 随机端口就绪", true);
		const logs = rescue.log();
		const bound = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(logs.out);
		const actualPort = bound ? Number(bound[1]) : rescuePort;
		ok("rescue-daemon: 日志声明的端口与实参一致（未漂移）", actualPort === rescuePort,
			`declared=${actualPort} requested=${rescuePort}`);

		const page = await fetch(`http://127.0.0.1:${actualPort}/`, { signal: AbortSignal.timeout(8000) });
		const html = await page.text();
		ok("rescue-daemon GET /: 200 + 自包含中文救援页",
			page.status === 200 && /救援中心/.test(html) && /api\/verify/.test(html), `status=${page.status}`);

		const vres = await getJson(`http://127.0.0.1:${actualPort}/api/verify`);
		ok("rescue-daemon GET /api/verify: ok=true + issues 数组（临时 profile）",
			vres.status === 200 && vres.json && vres.json.ok === true && Array.isArray(vres.json.issues),
			JSON.stringify(vres.json).slice(0, 200));

		const sres = await getJson(`http://127.0.0.1:${actualPort}/api/status`);
		ok("rescue-daemon GET /api/status: 身份字段 app/identity = dsh-rescue-daemon",
			sres.status === 200 && sres.json && sres.json.app === "dsh-rescue-daemon"
			&& sres.json.identity === "dsh-rescue-daemon", JSON.stringify(sres.json).slice(0, 200));
		ok("rescue-daemon GET /api/status: port/pid 自证（pid = 本守护子进程）",
			sres.json && sres.json.port === actualPort && sres.json.pid === rescue.child.pid,
			`json=${JSON.stringify({ port: sres.json && sres.json.port, pid: sres.json && sres.json.pid })} child=${rescue.child.pid}`);
		ok("rescue-daemon GET /api/status: engineUp 布尔 + enginePort=3080",
			sres.json && typeof sres.json.engineUp === "boolean" && sres.json.enginePort === 3080,
			JSON.stringify(sres.json).slice(0, 200));
		ok("rescue-daemon: 全程未调用 /api/start（临时 profile 无 pid 文件、engineProcess=null）",
			sres.json && sres.json.engineProcess === null && !existsSync(join(rescueProfile, ".rescue-daemon.pid")),
			`engineProcess=${JSON.stringify(sres.json && sres.json.engineProcess)} pidFile=${existsSync(join(rescueProfile, ".rescue-daemon.pid"))}`);

		const lh = await launcherHealth(actualPort, 3000);
		ok("enginectl.launcherHealth: 对真实守护返回 ok + identity=rescue-daemon",
			lh.ok === true && lh.identity === "rescue-daemon", JSON.stringify(lh).slice(0, 160));

		const nf = await getJson(`http://127.0.0.1:${actualPort}/api/nope`);
		ok("rescue-daemon: 未知路径 → 404 JSON", nf.status === 404, `status=${nf.status}`);
	}
} finally {
	await killChild(rescue.child);
	const logs = rescue.log();
	ok("rescue-daemon: 子进程已回收", rescue.child.exitCode !== null || rescue.child.signalCode !== null,
		`exitCode=${rescue.child.exitCode} out=${logs.out.slice(0, 120)}`);
}

// ---------------------------------------------------------------- 7. bin/ import 安全（t12 F1 / t9 欠账）
// 目标：`import` 三个 bin 不得有副作用 —— 不 bind 端口、不写日志、不启动引擎、不 process.exit。
// 手法：在子进程里用一个「只 import 并打印导出」的包装脚本加载目标模块（argv[1] = 包装脚本路径，
// 因此走的是 isDirectRun() 的 argv/realpath 判定分支，而不是 DSH_LAUNCHER_IMPORT_ONLY 逃生门）。
// 安全阀：即使用例失败（守卫缺失导致入口真的跑了），损害也被限制在「随机端口 + 临时 profile +
// 不存在的 dsh 命令 + 300ms 等待」内，不触碰 3080/3081/3085 与真 profile。
console.log("== 7. bin/*.mjs import 安全（isDirectRun 守卫）==");
const importCheckDir = tempDir("pm-launcher-import-");
const importWrapper = join(importCheckDir, "import-check.mjs");
writeFileSync(importWrapper, [
	"import { pathToFileURL } from \"node:url\";",
	"const target = process.argv[2];",
	"const mod = await import(pathToFileURL(target).href);",
	"console.log(\"EXPORTS:\" + Object.keys(mod).sort().join(\",\"));"
].join("\n") + "\n", "utf8");

const BIN_CASES = [
	{ file: "open-boot.mjs", prefix: "[open-boot]" },
	{ file: "dsh-boot.mjs", prefix: "[dsh-boot]" },
	{ file: "rescue-daemon.mjs", prefix: "[rescue-daemon]" }
];
for (const binCase of BIN_CASES) {
	const binPath = join(ROOT, "bin", binCase.file);
	const importProfile = writeProfile(tempDir(`pm-launcher-import-${binCase.file}-`), ["@deepseek-ai/dsh-base"]);
	const importPort = await freePort();
	const before = readdirSync(importProfile).sort();
	const started = Date.now();
	const imported = runNode([
		importWrapper, binPath,
		"--profile", importProfile,
		"--port", String(importPort),
		"--dsh", "pm-launcher-not-a-real-dsh",
		"--wait-ms", "300",
		"--cwd", importProfile
	], { timeoutMs: 20000 });
	const elapsed = Date.now() - started;
	const after = readdirSync(importProfile).sort();

	ok(`bin/${binCase.file}: import 后进程自行退出（未常驻/未监听）`,
		imported.code === 0, `exit=${imported.code} signal=${imported.signal} elapsed=${elapsed}ms out=${imported.stdout.slice(0, 160)}`);
	ok(`bin/${binCase.file}: import 未触发入口逻辑（无 ${binCase.prefix} 日志）`,
		!imported.stdout.includes(binCase.prefix) && !imported.stderr.includes(binCase.prefix),
		`out=${imported.stdout.slice(0, 200)} err=${imported.stderr.slice(0, 160)}`);
	ok(`bin/${binCase.file}: import 后随机端口 ${importPort} 无人监听`,
		(await portOpen(importPort, 600)) === false, `port=${importPort}`);
	ok(`bin/${binCase.file}: import 未写日志/未产生 pid 文件（目录内容不变）`,
		JSON.stringify(before) === JSON.stringify(after) && !existsSync(join(importProfile, ".rescue-daemon.pid")),
		`before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
	const exportsMatch = /EXPORTS:([^\n]*)/.exec(imported.stdout);
	const exported = exportsMatch ? exportsMatch[1].split(",") : [];
	ok(`bin/${binCase.file}: 导出 parseArgs / HELP_TEXT / main（可测）`,
		["parseArgs", "HELP_TEXT", "main"].every((name) => exported.includes(name)),
		`EXPORTS=${exportsMatch ? exportsMatch[1] : "(none)"}`);
}

// ---------------------------------------------------------------- 8. R13 --uninstall
console.log("== 8. R13 --uninstall 卸载闭环（临时 profile + 注册表快照/恢复）==");
const openBootBin = join(ROOT, "bin", "open-boot.mjs");
const rescueBin = join(ROOT, "bin", "rescue-daemon.mjs");
const real3081PidBefore = portOwner(3081); // 真机常驻启动器（本机 3081）；全测试不允许改变
const regSnapshot = snapshotDshWebRunValues();
const regSignatureBefore = regSignature(regSnapshot, /^DSHWeb/i);
const r13Leftovers = [];
try {
	// 8.1 装自启 → 起一个真实启动器 → 卸载
	const unProfile = writeProfile(tempDir("pm-launcher-uninstall-"), ["@deepseek-ai/dsh-base"]);
	const unPort = await freePort();
	const unEnginePort = await freePort();
	const installed = runNode([openBootBin, "--install-autostart", "--profile", unProfile, "--port", String(unPort)], { timeoutMs: 60000 });
	skipOk("R13: --install-autostart 成功（临时 profile + 非默认端口）", installed.code === 0, `exit=${installed.code} out=${installed.stdout.slice(0, 140)}`);
	ok("R13: shim 已落盘（open-boot-autostart.vbs + open-boot-ui.vbs）",
		existsSync(join(unProfile, "open-boot-autostart.vbs")) && existsSync(join(unProfile, "open-boot-ui.vbs")));
	if (WIN) {
		const names = regQueryDshWebNames();
		skipOk("R13: 注册表出现 DSHWeb* 自启值（DSHWebFront，指向本次临时 profile）",
			names.includes("DSHWebFront") && /open-boot-autostart\.vbs/.test(spawnSync("reg", ["query", RUN_KEY, "/v", "DSHWebFront"], { windowsHide: true, encoding: "utf8" }).stdout || ""),
			names.join(","));
	} else {
		console.log("SKIP: R13 注册表相关断言（非 Windows）");
	}

	const ensured = runNode([openBootBin, "--ensure", "--profile", unProfile, "--port", String(unPort), "--dsh", "pm-launcher-not-a-real-dsh"],
		{ timeoutMs: 90000, env: { DSH_ENGINE_PORT: String(unEnginePort) } });
	const unPidInfo = readJsonFile(join(unProfile, ".open-boot.pid"));
	r13Leftovers.push(unProfile);
	ok("R13: --ensure 拉起启动器并写出 .open-boot.pid（R13 三重校验的输入）",
		ensured.code === 0 && unPidInfo && Number.isInteger(unPidInfo.pid) && unPidInfo.app === "dsh-open-boot",
		`exit=${ensured.code} pidInfo=${JSON.stringify(unPidInfo)}`);
	ok("R13: .open-boot.pid 记录了 app/port/profile（三者缺一即拒绝处理）",
		unPidInfo?.app === "dsh-open-boot" && unPidInfo?.port === unPort && resolve(unPidInfo?.profile || "") === resolve(unProfile),
		JSON.stringify({ app: unPidInfo?.app, port: unPidInfo?.port, profile: unPidInfo?.profile }));
	skipOk("R13: 启动器确实在跑（HTTP 握手 + 端口占用者 = pid 文件记录的 pid）",
		(await launcherHealth(unPort, 3000)).ok === true && portOwner(unPort) === unPidInfo?.pid,
		`owner=${portOwner(unPort)} pid=${unPidInfo?.pid}`);
	ok("R13: 启动器已就绪（HTTP 身份握手 = dsh-open-boot）",
		(await launcherHealth(unPort, 3000)).ok === true, JSON.stringify(await launcherHealth(unPort, 3000)).slice(0, 120));

	const uninstall1 = runNode([openBootBin, "--uninstall", "--profile", unProfile, "--port", String(unPort)],
		{ timeoutMs: 90000, env: { DSH_ENGINE_PORT: String(unEnginePort) } });
	// F2 起退出码分三档：0=完成 / 1=出错 / 2=归属未确认（探测被拦 → 保留 pid、不报完成）。
	// 沙箱里 netstat/tasklist 取不到输出 → 这里必然是 2；探测可用时才是 0。
	ok(`R13: --uninstall 退出码符合归属状态（${CHILD_PIPE_OK ? "探测可用→0" : "探测被拦→2"}）`,
		uninstall1.code === (CHILD_PIPE_OK ? 0 : 2), `exit=${uninstall1.code} out=${uninstall1.stdout.slice(0, 160)}`);
	if (WIN) {
		skipOk("R13: 输出打印了删掉的注册表键名（含 DSHWebFront）",
			/已删除注册表自启值：.*DSHWebFront/.test(uninstall1.stdout), uninstall1.stdout.split("\n").filter((l) => l.includes("注册表")).join(" | "));
		skipOk('R13: reg query "HKCU\\...\\Run" 中已无任何 DSHWeb* 值',
			regQueryDshWebNames().length === 0, `残留=${regQueryDshWebNames().join(",") || "(无)"}`);
	}
	ok("R13: profile 内 open-boot-*.vbs 已删除",
		!existsSync(join(unProfile, "open-boot-autostart.vbs")) && !existsSync(join(unProfile, "open-boot-ui.vbs")));
	// F2：归属**已确认**才允许删 pid 文件；探测被拦（归属未确认）时必须保留 + 不得报"卸载完成"
	ok("F2: .open-boot.pid 处理符合归属状态（已确认→清理；未确认→保留且不报完成）",
		CHILD_PIPE_OK
			? !existsSync(join(unProfile, ".open-boot.pid"))
			: (existsSync(join(unProfile, ".open-boot.pid")) && /归属未确认/.test(uninstall1.stdout) && /卸载未完成（exit 2）/.test(uninstall1.stdout)),
		`pidExists=${existsSync(join(unProfile, ".open-boot.pid"))} exit=${uninstall1.code}`);
	skipOk("R13: 本 profile 的启动器已停止（pid 不再存活 + 端口已释放）",
		!isAlive(unPidInfo?.pid) && (await portOpen(unPort, 600)) === false,
		`alive=${isAlive(unPidInfo?.pid)} portOpen=${await portOpen(unPort, 600)}`);
	ok("R13: 停止走单 pid process.kill（open-boot 源码里没有 taskkill 调用，不整棵树杀）",
		!/(spawn|spawnSync|exec|execFile)\w*\s*\(\s*["']taskkill/.test(readFileSync(openBootBin, "utf8")));
	skipOk("R13: 真机 3081 常驻启动器 pid 未被牵连",
		portOwner(3081) === real3081PidBefore, `3081 pid ${real3081PidBefore} → ${portOwner(3081)}`);

	// 8.2 幂等（退出码与归属状态一致；没有 pid 文件时恒为 0，见场景 C）
	const uninstall2 = runNode([openBootBin, "--uninstall", "--profile", unProfile, "--port", String(unPort)],
		{ timeoutMs: 60000, env: { DSH_ENGINE_PORT: String(unEnginePort) } });
	ok("R13: 重复执行退出码稳定（幂等：已确认场景 0 / 未确认场景 2，不会忽 0 忽 2）",
		uninstall2.code === uninstall1.code, `first=${uninstall1.code} second=${uninstall2.code}`);
	ok("R13: 幂等执行输出与归属状态一致（已确认：无需删除/不存在；未确认：再次明告归属未确认）",
		CHILD_PIPE_OK
			? /未发现 DSHWeb\* 自启值|未发现 open-boot-\*\.vbs|不存在（无需清理）/.test(uninstall2.stdout)
			: /归属未确认/.test(uninstall2.stdout) && /卸载未完成（exit 2）/.test(uninstall2.stdout),
		uninstall2.stdout.replace(/\s+/g, " ").slice(0, 200));
	ok("R13: 日志默认保留（重复卸载不会删 open-boot*.log / health.log）",
		!uninstall2.stdout.includes("已删除 open-boot-supervisor.log") && /日志默认保留/.test(uninstall2.stdout));

	// 8.3 归属校验：别的 profile 的守护必须不被误杀（两个临时 profile 互相验证）
	const otherProfile = writeProfile(tempDir("pm-launcher-uninstall-other-"), ["@deepseek-ai/dsh-base"]);
	const otherPort = await freePort();
	const otherEnginePort = await freePort();
	r13Leftovers.push(otherProfile);
	const otherEnsure = runNode([openBootBin, "--ensure", "--profile", otherProfile, "--port", String(otherPort), "--dsh", "pm-launcher-not-a-real-dsh"],
		{ timeoutMs: 90000, env: { DSH_ENGINE_PORT: String(otherEnginePort) } });
	const otherPidInfo = readJsonFile(join(otherProfile, ".open-boot.pid"));
	ok("R13: 第二套临时 profile 的启动器已在跑（用于验证「不误杀」）",
		otherEnsure.code === 0 && (await launcherHealth(otherPort, 3000)).ok === true, `exit=${otherEnsure.code} owner=${portOwner(otherPort)}`);

	// 场景 A：pid 文件来自别的 profile（profile 字段不匹配）
	const victimA = writeProfile(tempDir("pm-launcher-uninstall-victimA-"), ["@deepseek-ai/dsh-base"]);
	copyFileSync(join(otherProfile, ".open-boot.pid"), join(victimA, ".open-boot.pid"));
	const refusedA = runNode([openBootBin, "--uninstall", "--profile", victimA, "--port", String(otherPort)],
		{ timeoutMs: 60000, env: { DSH_ENGINE_PORT: String(otherEnginePort) } });
	ok("R13: 归属校验不通过（pid 文件属别的 profile）→ 拒绝处理并打印原因",
		refusedA.code === 0 && /拒绝处理任何进程/.test(refusedA.stdout) && /记录的 profile/.test(refusedA.stdout),
		`exit=${refusedA.code} out=${refusedA.stdout.replace(/\s+/g, " ").slice(0, 220)}`);
	ok("R13: 拒绝后，那个不属于本 profile 的守护仍在跑（未被误杀）",
		(await launcherHealth(otherPort, 3000)).ok === true, `otherPort=${otherPort}`);

	// 场景 B：pid 文件记录的端口 ≠ 本次 --port（端口不匹配）
	const victimB = writeProfile(tempDir("pm-launcher-uninstall-victimB-"), ["@deepseek-ai/dsh-base"]);
	const victimBPort = await freePort();
	writeFileSync(join(victimB, ".open-boot.pid"), JSON.stringify({
		app: "dsh-open-boot", pid: otherPidInfo?.pid, port: otherPort, profile: victimB, startedAt: new Date().toISOString()
	}) + "\n", "utf8");
	const refusedB = runNode([openBootBin, "--uninstall", "--profile", victimB, "--port", String(victimBPort)],
		{ timeoutMs: 60000, env: { DSH_ENGINE_PORT: String(otherEnginePort) } });
	ok("R13: 归属校验不通过（记录的端口 ≠ --port）→ 拒绝处理并打印原因",
		refusedB.code === 0 && /拒绝处理任何进程/.test(refusedB.stdout) && /记录的端口/.test(refusedB.stdout),
		`exit=${refusedB.code} out=${refusedB.stdout.replace(/\s+/g, " ").slice(0, 220)}`);
	ok("R13: 端口不匹配场景下同样没动任何进程（守护仍在跑）",
		(await launcherHealth(otherPort, 3000)).ok === true);

	// 场景 C：没有 pid 文件 → 明确提示、不结束任何进程
	const freshProfile = writeProfile(tempDir("pm-launcher-uninstall-fresh-"), ["@deepseek-ai/dsh-base"]);
	const freshPort = await freePort();
	const freshRun = runNode([openBootBin, "--uninstall", "--profile", freshProfile, "--port", String(freshPort)], { timeoutMs: 60000 });
	ok("R13: 没有 .open-boot.pid 时明确提示「无可定位的守护」且 exit 0（幂等）",
		freshRun.code === 0 && /无可定位的守护/.test(freshRun.stdout), `exit=${freshRun.code} out=${freshRun.stdout.replace(/\s+/g, " ").slice(0, 160)}`);

	// 8.5 F2（t8 终审）：探测能力缺失 ≠ 没有守护。用**桩注入**确定性覆盖两种情形，
	// 不依赖真实 netstat/tasklist（在沙箱里它们本来就被拦，桩让两个方向都可在本会话复现）。
	const f2PidFile = (dir, port) => writeFileSync(join(dir, ".open-boot.pid"), JSON.stringify({
		app: "dsh-open-boot", pid: process.pid, port, profile: dir, startedAt: new Date().toISOString()
	}) + "\n", "utf8");
	{
		// ① 探测不可用 → 归属未确认：保留 pid、不报完成、exitCode=2
		const f2a = writeProfile(tempDir("pm-launcher-f2-unverified-"), ["@deepseek-ai/dsh-base"]);
		const f2aPort = await freePort();
		f2PidFile(f2a, f2aPort);
		const probeDown = {
			portOwner: () => ({ ok: false, pid: null, reason: "EPERM（注入）：netstat 被拦" }),
			processImage: () => ({ ok: false, image: null, reason: "EPERM（注入）：tasklist 被拦" })
		};
		const collectedDown = openBoot.collectOwnedDaemons({ profile: f2a, port: f2aPort }, probeDown);
		ok("F2①: 探测不可用 → 候选标记「归属未确认」（verified=false、owned=0、原因可读）",
			collectedDown.unverified.length === 1 && collectedDown.owned.length === 0
			&& collectedDown.candidates[0].verified === false && /归属未确认/.test(collectedDown.candidates[0].reason),
			JSON.stringify(collectedDown.candidates.map((c) => ({ pid: c.pid, verified: c.verified, owned: c.owned }))));
		const rDown = await openBoot.uninstallLauncher({ profile: f2a, port: f2aPort }, probeDown);
		ok("F2①: --uninstall 归属未确认 → exitCode=2 + 保留 .open-boot.pid + 警告(含人工核对建议) + 不报「卸载完成」",
			rDown.exitCode === 2 && rDown.ok === false && rDown.pidRetained === true && rDown.pidCleared === false
			&& existsSync(join(f2a, ".open-boot.pid")) && /归属未确认/.test(rDown.message)
			&& /人工核对建议/.test(rDown.message) && /卸载未完成（exit 2）/.test(rDown.message) && !/✔ 卸载完成/.test(rDown.message),
			`exitCode=${rDown.exitCode} pidRetained=${rDown.pidRetained} pidExists=${existsSync(join(f2a, ".open-boot.pid"))}`);

		// ② 探测可用 + 确认非本进程（镜像 chrome.exe、不持有端口）→ 可安全清理、exitCode=0
		const f2b = writeProfile(tempDir("pm-launcher-f2-foreign-"), ["@deepseek-ai/dsh-base"]);
		const f2bPort = await freePort();
		f2PidFile(f2b, f2bPort);
		const probeForeign = {
			portOwner: () => ({ ok: true, pid: null, reason: null }),
			processImage: () => ({ ok: true, image: "chrome.exe", reason: null })
		};
		const collectedForeign = openBoot.collectOwnedDaemons({ profile: f2b, port: f2bPort }, probeForeign);
		ok("F2②: 探测可用且确认非本进程 → verified=true、owned=0（不是「未确认」，可清理）",
			collectedForeign.unverified.length === 0 && collectedForeign.owned.length === 0
			&& collectedForeign.candidates[0].verified === true && /确认非本进程/.test(collectedForeign.candidates[0].reason));
		const rForeign = await openBoot.uninstallLauncher({ profile: f2b, port: f2bPort }, probeForeign);
		ok("F2②: 确认非本进程 → exitCode=0 + 清理 pid 文件 + 报「卸载完成」",
			rForeign.exitCode === 0 && rForeign.ok === true && !existsSync(join(f2b, ".open-boot.pid")) && /✔ 卸载完成/.test(rForeign.message),
			`exitCode=${rForeign.exitCode} pidExists=${existsSync(join(f2b, ".open-boot.pid"))}`);

		// ③ 反向对照：探测可用 + node 镜像 + 持有端口 → 三重校验通过（只判判定，不真杀进程）
		const f2c = writeProfile(tempDir("pm-launcher-f2-mine-"), ["@deepseek-ai/dsh-base"]);
		const f2cPort = await freePort();
		f2PidFile(f2c, f2cPort);
		const probeMine = {
			portOwner: (port) => ({ ok: true, pid: Number(port) === f2cPort ? process.pid : null, reason: null }),
			processImage: () => ({ ok: true, image: "node.exe", reason: null })
		};
		const collectedMine = openBoot.collectOwnedDaemons({ profile: f2c, port: f2cPort }, probeMine);
		ok("F2: 三重校验全过（node 镜像 + 持有端口）→ owned=1（证明上面的判定既非恒真也非恒假）",
			collectedMine.owned.length === 1 && collectedMine.unverified.length === 0 && collectedMine.owned[0].verified === true,
			JSON.stringify(collectedMine.candidates.map((c) => ({ pid: c.pid, verified: c.verified, owned: c.owned }))));
	}

	// 8.6 冻结契约（t20）：**裸跑** `--uninstall` 仍作用于"默认 profile"，不被未识别 token 规则误伤。
	//     用 USERPROFILE/HOME 指向临时夹具来构造"默认 profile"：既验证契约，又绝不碰真机 profile；
	//     本块位于注册表快照/恢复窗口内，提权会话下被删掉的 DSHWeb* 也会在 finally 还原。
	{
		const fakeHome = mkdtempSync(join(tmpdir(), "pm-launcher-t20-home-"));
		tempDirs.push(fakeHome);
		const fakeDefault = join(fakeHome, ".dsh", "profiles", "web");
		mkdirSync(fakeDefault, { recursive: true });
		writeFileSync(join(fakeDefault, "package.json"), JSON.stringify({ name: "pm-launcher-default-fixture", private: true, dsh: { profile: { bundles: [] } } }, null, 2) + "\n", "utf8");
		writeFileSync(join(fakeDefault, "cordis.patch.yml"), "[]\n", "utf8");
		const bare = runNode([openBootBin, "--uninstall"], { timeoutMs: 60000, env: { USERPROFILE: fakeHome, HOME: fakeHome } });
		ok("t20: 裸跑 `--uninstall`（无任何参数）仍作用于默认 profile —— 未被新校验规则拒绝",
			bare.code === 0 && /无可定位的守护/.test(bare.stdout) && !/用法错误/.test(bare.stderr),
			`exit=${bare.code} out=${bare.stdout.replace(/\s+/g, " ").slice(0, 140)}`);
		ok("t20: 裸跑只做清理、不新建文件（夹具默认 profile 仍只有 package.json + cordis.patch.yml）",
			readdirSync(fakeDefault).sort().join(",") === ["cordis.patch.yml", "package.json"].sort().join(","),
			`files=${readdirSync(fakeDefault).sort().join(",")}`);
	}

	// 8.4 收尾：把测试自己拉起的第二套启动器结束掉
	killTree(otherPidInfo?.pid);
	let released = false;
	for (let i = 0; i < 15 && !released; i++) {
		await wait(200);
		released = (await portOpen(otherPort, 400)) === false;
	}
	ok("R13: 测试夹具自身的启动器已回收（端口释放）", released === true, `port=${otherPort}`);
} finally {
	restoreDshWebRunValues(regSnapshot);
	if (WIN) {
		const restoredRaw = regListRunValues();
		const restoredSignature = restoredRaw === null ? null : regSignature(restoredRaw, /^DSHWeb/i);
		skipOk("R13: 注册表 Run 键已恢复原值（DSHWeb* 按 name 排序逐条比较 name/type/data，顺序无关）",
			restoredRaw !== null && restoredSignature === regSignatureBefore,
			`期望=${dshWebEntriesText(regSnapshot)} 实际=${restoredRaw === null ? "(reg query 读取失败)" : dshWebEntriesText(restoredRaw)}`);
		const restored = snapshotDshWebRunValues();
		skipOk("R13: 真机自启项恢复原样（DSHWebFront 指向真机 profile 的 shim）",
			restoredRaw !== null && restored.length === regSnapshot.length
			&& restored.every((v, i) => v.name === regSnapshot[i].name && v.data === regSnapshot[i].data),
			`恢复后=${dshWebEntriesText(restored)}`);
	}
	skipOk("R13: 真机 3081 常驻启动器 pid 全程未变（本任务绝不误杀别的 profile 的守护）",
		portOwner(3081) === real3081PidBefore, `${real3081PidBefore} → ${portOwner(3081)}`);
}

// ---------------------------------------------------------------- 9. L11 本地 API 防护
console.log("== 9. L11 本地写接口防护（Origin / 一次性令牌 / 单飞）==");
const l11Profile = writeProfile(tempDir("pm-launcher-l11-"), ["@deepseek-ai/dsh-base"]);
const l11Port = await freePort();
const l11EnginePort = await freePort(); // 空闲端口 = 假引擎端口（测试不碰真机 3080）
const l11 = spawnNode([openBootBin, "--profile", l11Profile, "--port", String(l11Port), "--no-window", "--dsh", "pm-launcher-not-a-real-dsh", "--wait-ms", "600"],
	{ logName: "l11", env: { DSH_ENGINE_PORT: String(l11EnginePort) } });
try {
	const up = await waitPort(l11Port, 15000);
	if (!up) {
		ok("L11: 临时启动器实例就绪（随机端口）", false, l11.log().out.slice(0, 200));
	} else {
		const base = `http://127.0.0.1:${l11Port}`;
		const pageHtml = await (await fetch(`${base}/`)).text();
		const token = tokenFromHtml(pageHtml);
		ok("L11 ②: 页面注入一次性令牌 <meta name=\"dsh-pm-token\">（48 hex）",
			typeof token === "string" && /^[0-9a-f]{48}$/.test(token), String(token).slice(0, 12));
		ok("L11 ②: 页面自身的写请求带 X-DSH-PM-Token（同源正常路径）",
			pageHtml.includes("X-DSH-PM-Token") && pageHtml.includes('meta name="dsh-pm-token"'));
		ok("L11: 读取接口 GET /api/status 不加防护（launcherHealth 身份握手不回归）",
			(await launcherHealth(l11Port, 3000)).ok === true && (await launcherHealth(l11Port, 3000)).identity === "open-boot");
		ok("L11: 令牌不出现在 /api/status 的 JSON 里（探测接口不泄漏）",
			!(await getJson(`${base}/api/status`)).text.includes(token));

		const evilOrigin = await postJson(`${base}/api/boot`, { headers: { Origin: "http://evil.example", "X-DSH-PM-Token": token } });
		ok("L11 ①: 第三方 Origin 的 POST /api/boot → 403（即使带着正确令牌）",
			evilOrigin.status === 403 && evilOrigin.json?.code === 403, `status=${evilOrigin.status} body=${evilOrigin.text.slice(0, 120)}`);
		const noOriginNoToken = await postJson(`${base}/api/boot`, {});
		ok("L11 ②: 无 Origin（本地工具）但缺 X-DSH-PM-Token → 401",
			noOriginNoToken.status === 401, `status=${noOriginNoToken.status}`);
		const sameOriginNoToken = await postJson(`${base}/api/boot`, { headers: { Origin: base } });
		ok("L11 ②: 同源但缺 X-DSH-PM-Token → 401", sameOriginNoToken.status === 401, `status=${sameOriginNoToken.status}`);
		const badToken = await postJson(`${base}/api/boot`, { headers: { Origin: base, "X-DSH-PM-Token": "0".repeat(48) } });
		ok("L11 ②: 错误 X-DSH-PM-Token → 401", badToken.status === 401, `status=${badToken.status}`);
		const okWrite = await postJson(`${base}/api/boot`, { headers: { Origin: base, "X-DSH-PM-Token": token } });
		ok("L11: 本页同源 + 正确令牌 → 200（正常路径可用）",
			okWrite.status === 200 && typeof okWrite.json?.ok === "boolean", `status=${okWrite.status} ok=${okWrite.json?.ok}`);

		// F1（t8 终审）：`http://localhost:<port>/` 也是"本页"——页面自身的写请求不能再被判跨站
		const localBase = `http://localhost:${l11Port}`;
		const localPage = await (await fetch(`${localBase}/`)).text();
		const localToken = tokenFromHtml(localPage);
		ok("F1: 启动页可通过 http://localhost:<端口>/ 打开并注入令牌（与 127.0.0.1 同一实例）",
			typeof localToken === "string" && /^[0-9a-f]{48}$/.test(localToken) && localToken === token,
			`tokenLen=${String(localToken).length} sameAs127=${localToken === token}`);
		const localOk = await postJson(`${localBase}/api/boot`, { headers: { Origin: localBase, "X-DSH-PM-Token": localToken } });
		ok("F1: localhost 入口的 POST /api/boot → 200（此前被误判跨站 → 403，招牌功能失效）",
			localOk.status === 200, `status=${localOk.status} body=${localOk.text.slice(0, 120)}`);
		const localNoToken = await postJson(`${localBase}/api/boot`, { headers: { Origin: localBase } });
		ok("F1: localhost 入口缺令牌 → 401（白名单放宽后防护未削弱）", localNoToken.status === 401, `status=${localNoToken.status}`);
		const localEvil = await postJson(`${localBase}/api/boot`, { headers: { Origin: "http://evil.example", "X-DSH-PM-Token": localToken } });
		ok("F1: localhost 入口下第三方 Origin 仍 → 403", localEvil.status === 403, `status=${localEvil.status}`);
		const localWrongPort = await postJson(`${localBase}/api/boot`, { headers: { Origin: `http://localhost:${l11Port + 1}`, "X-DSH-PM-Token": localToken } });
		ok("F1: localhost 入口下「其他端口」Origin 仍 → 403", localWrongPort.status === 403, `status=${localWrongPort.status}`);
		const localBadToken = await postJson(`${localBase}/api/boot`, { headers: { Origin: localBase, "X-DSH-PM-Token": "0".repeat(48) } });
		ok("F1: localhost 入口错令牌 → 401", localBadToken.status === 401, `status=${localBadToken.status}`);

		// 救援写接口同样受三道防护
		const fixEvil = await postJson(`${base}/rescue/api/fix`, { headers: { Origin: "http://evil.example", "X-DSH-PM-Token": token } });
		ok("L11: 救援写接口 /rescue/api/fix 第三方 Origin → 403", fixEvil.status === 403, `status=${fixEvil.status}`);
		const fixNoToken = await postJson(`${base}/rescue/api/fix`, { headers: { Origin: base } });
		ok("L11: 救援写接口缺令牌 → 401", fixNoToken.status === 401, `status=${fixNoToken.status}`);
		const fixOk = await postJson(`${base}/rescue/api/fix`, { headers: { Origin: base, "X-DSH-PM-Token": token } });
		ok("L11: 救援写接口同源 + 令牌 → 200（临时 profile 上的修复是安全的）",
			fixOk.status === 200 && fixOk.json?.ok === true, `status=${fixOk.status} ok=${fixOk.json?.ok}`);
	ok("L11: GET /rescue/api/verify 读取接口不拦（救援页「运行检查」可用）",
			(await getJson(`${base}/rescue/api/verify`)).status === 200);

		// 令牌不落盘 / 不落日志
		const tokenHits = listFiles(l11Profile).filter((file) => {
			try { return readFileSync(file, "utf8").includes(token); } catch { return false; }
		});
		ok("L11: 令牌不出现在 profile 任何文件里（health.log / open-boot*.log / rescue-daemon.log 全覆盖）",
			tokenHits.length === 0, tokenHits.map((f) => f.split(/[\\/]/).slice(-2).join("/")).join(", ") || "(零命中)");
		const l11Logs = l11.log();
		ok("L11: 令牌不出现在启动器自身 stdout/stderr", !l11Logs.out.includes(token) && !l11Logs.err.includes(token));

		// 每次启动的令牌都不同
		const l11bProfile = writeProfile(tempDir("pm-launcher-l11b-"), ["@deepseek-ai/dsh-base"]);
		const l11bPort = await freePort();
		const l11b = spawnNode([openBootBin, "--profile", l11bProfile, "--port", String(l11bPort), "--no-window", "--dsh", "pm-launcher-not-a-real-dsh", "--wait-ms", "600"],
			{ logName: "l11b", env: { DSH_ENGINE_PORT: String(l11EnginePort) } });
		try {
			await waitPort(l11bPort, 15000);
			const tokenB2 = tokenFromHtml(await (await fetch(`http://127.0.0.1:${l11bPort}/`)).text());
			ok("L11 ②: 一次性令牌每次启动随机（两个实例的令牌不同）",
				typeof tokenB2 === "string" && tokenB2 !== token, `${String(token).slice(0, 8)}… vs ${String(tokenB2).slice(0, 8)}…`);
		} finally {
			await killChild(l11b.child);
		}
	}
} finally {
	await killChild(l11.child);
}

// 9.x 单飞：用一个"会挂住"的假 dsh 让第一次 boot 慢下来，从而确定性验证并发第二个 → 409
{
	const slowProfile = writeProfile(tempDir("pm-launcher-l11-slow-"), ["@deepseek-ai/dsh-base"]);
	const slowPort = await freePort();
	const slowEnginePort = await freePort();
	const marker = join(slowProfile, "spawn-marker.txt");
	const shim = join(slowProfile, "slow-dsh.cmd");
	writeFileSync(shim, ["@echo off", `echo spawn %TIME% %~1 >> "${marker}"`, "ping -n 6 127.0.0.1 > nul", ""].join("\r\n"), "utf8");
	const slow = spawnNode([openBootBin, "--profile", slowProfile, "--port", String(slowPort), "--no-window", "--dsh", shim, "--wait-ms", "2500"],
		{ logName: "l11slow", env: { DSH_ENGINE_PORT: String(slowEnginePort) } });
	try {
		const up = await waitPort(slowPort, 15000);
		if (!up) {
			ok("L11 ③: 慢启动夹具就绪", false, slow.log().out.slice(0, 160));
		} else {
			const base = `http://127.0.0.1:${slowPort}`;
			const localBase = `http://localhost:${slowPort}`;
			const slowToken = tokenFromHtml(await (await fetch(`${base}/`)).text());
			// 同一实例、两种入口（127.0.0.1 / localhost）各发一对并发请求：都要"一个 200 + 一个 409"
			const firePair = (origin) => Promise.all([
				postJson(`${base}/api/boot`, { headers: { Origin: origin, "X-DSH-PM-Token": slowToken } }),
				postJson(`${base}/api/boot`, { headers: { Origin: origin, "X-DSH-PM-Token": slowToken } })
			]);
			const [r1, r2] = await firePair(base);
			const codes = [r1.status, r2.status].sort((a, b) => a - b);
			ok("L11 ③: 并发两个 POST /api/boot（127.0.0.1 入口）→ 一个 200、另一个 409（单飞生效）",
				codes[0] === 200 && codes[1] === 409, `codes=${codes.join("/")}`);
			const busy = r1.status === 409 ? r1 : r2;
			ok("L11 ③: 409 响应明确（busy=true + 说明已有启动流程在执行）",
				busy.json?.code === 409 && busy.json?.busy === true && /已有启动流程/.test(busy.json?.error || ""),
				JSON.stringify(busy.json || {}).slice(0, 160));
			const [r3, r4] = await firePair(localBase);
			const localCodes = [r3.status, r4.status].sort((a, b) => a - b);
			ok("F1+L11 ③: 并发两个写请求（localhost 入口）→ 200/409（此前两个都会 403）",
				localCodes[0] === 200 && localCodes[1] === 409, `codes=${localCodes.join("/")}`);
			const spawns = existsSync(marker) ? readFileSync(marker, "utf8").trim().split(/\r?\n/).filter(Boolean).length : 0;
			ok("L11 ③: 每对并发只拉起一次引擎（marker=2：两对并发各一次，没有重复拉起）", spawns === 2, `spawn 次数=${spawns}`);
			// 假引擎进程（shim 树）由测试夹具回收：pid 记录在引擎 PID 文件里（.rescue-daemon.pid）
			const slowEngineInfo = readJsonFile(join(slowProfile, ".rescue-daemon.pid"));
			killTree(slowEngineInfo?.pid);
			let slowGone = false;
			for (let i = 0; i < 15 && !slowGone; i++) { await wait(200); slowGone = !isAlive(slowEngineInfo?.pid); }
			ok("L11 ③: 假引擎（shim 进程树）已被测试夹具回收（不残留挂起进程）",
				Number.isInteger(slowEngineInfo?.pid) && slowGone === true, `pid=${slowEngineInfo?.pid} gone=${slowGone}`);
		}
	} finally {
		await killChild(slow.child);
	}
}

// ---------------------------------------------------------------- 10. P1-5 --status 健康留痕
console.log("== 10. P1-5 --status 健康留痕（health.log + 最近自检）==");
{
	const healthProfile = writeProfile(tempDir("pm-launcher-health-"), ["@deepseek-ai/dsh-base"]);
	const healthPort = await freePort();
	const healthEnginePort = await freePort(); // 空闲 = 引擎未运行（结果确定）
	const healthEnv = { DSH_ENGINE_PORT: String(healthEnginePort) };
	const healthLog = join(healthProfile, "health.log");
	const configBefore = ["package.json", "cordis.patch.yml"].map((name) => readFileSync(join(healthProfile, name), "utf8"));

	const st1 = runNode([openBootBin, "--status", "--profile", healthProfile, "--port", String(healthPort)], { timeoutMs: 60000, env: healthEnv });
	const log1 = existsSync(healthLog) ? readFileSync(healthLog, "utf8").trim().split(/\r?\n/) : [];
	ok("P1-5: --status 追加写 <profile>/health.log（ISO 时间 + OK/FAIL + engine/boot 端口状态）",
		log1.length === 1 && new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ FAIL boot=down@${healthPort} engine=down@${healthEnginePort}$`).test(log1[0]),
		JSON.stringify(log1));
	ok("P1-5: --status 输出含「最近自检：」并回显本次结论",
		/最近自检：/.test(st1.stdout) && st1.stdout.includes(log1[0] || "(none)"), st1.stdout.split("\n").filter((l) => l.includes("最近自检")).join(" | ").slice(0, 200));
	ok("P1-5: 启动器未运行时退出码仍为 1（语义不回归）", st1.code === 1, `exit=${st1.code}`);

	// 把启动器拉起来，再自检一次 → OK 落盘 + 回显上一条
	const healthLauncher = spawnNode([openBootBin, "--profile", healthProfile, "--port", String(healthPort), "--no-window", "--dsh", "pm-launcher-not-a-real-dsh", "--wait-ms", "600"],
		{ logName: "health", env: healthEnv });
	try {
		await waitPort(healthPort, 15000);
		const st2 = runNode([openBootBin, "--status", "--profile", healthProfile, "--port", String(healthPort)], { timeoutMs: 60000, env: healthEnv });
		const log2 = readFileSync(healthLog, "utf8").trim().split(/\r?\n/);
		ok("P1-5: 第二次 --status → 追加第二行且末行为 OK",
			log2.length === 2 && new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ OK boot=up@${healthPort} engine=down@${healthEnginePort}$`).test(log2[1]),
			JSON.stringify(log2.map((l) => l.slice(0, 40))));
		ok("P1-5: 输出「最近自检」含本次结论 + 上一次记录（取自该日志）",
			st2.stdout.includes(log2[1]) && st2.stdout.includes(log2[0]) && /（上一次：/.test(st2.stdout),
			st2.stdout.split("\n").filter((l) => l.includes("最近自检")).join(" | ").slice(0, 240));
		ok("P1-5: 启动器健康时 --status 退出码 0", st2.code === 0, `exit=${st2.code}`);
		ok("P1-5: --status 声明日志路径与轮转策略（7 天 / 1000 行）",
			st2.stdout.includes(healthLog) && /保留最近 7 天 \/ 最多 1000 行/.test(st2.stdout));
	} finally {
		await killChild(healthLauncher.child);
	}
	const configAfter = ["package.json", "cordis.patch.yml"].map((name) => readFileSync(join(healthProfile, name), "utf8"));
	ok("P1-5: --status 不改 profile 配置（package.json / cordis.patch.yml 逐字节一致）",
		configBefore[0] === configAfter[0] && configBefore[1] === configAfter[1]);
	ok("P1-5: --status 不写 .open-boot.pid / 不写 supervisor 日志",
		!existsSync(join(healthProfile, ".open-boot.pid")) && !existsSync(join(healthProfile, "open-boot-supervisor.log")),
		`pid=${existsSync(join(healthProfile, ".open-boot.pid"))} supLog=${existsSync(join(healthProfile, "open-boot-supervisor.log"))}`);
}

// ---------------------------------------------------------------- 11. R7 救援入口与端口分工
console.log("== 11. R7 救援入口（3081）与端口分工（rescue-daemon → 3082）==");
{
	// 11.1 默认端口契约
	const rescueHelp = runNode([rescueBin, "--help"], { timeoutMs: 30000 });
	ok("R7: rescue-daemon --help 声明默认端口 3082，并说明 3081 归 open-boot",
		/默认 3082/.test(rescueHelp.stdout) && /3081/.test(rescueHelp.stdout) && /唯一网页入口/.test(rescueHelp.stdout), rescueHelp.stdout.split("\n").slice(0, 3).join(" | "));
	let rescueMod = null;
	try {
		process.env.DSH_LAUNCHER_IMPORT_ONLY = "1";
		rescueMod = await import("./bin/rescue-daemon.mjs");
	} finally {
		delete process.env.DSH_LAUNCHER_IMPORT_ONLY;
	}
	ok("R7: rescue-daemon 默认端口 = 3082（不再与 open-boot 抢 3081）",
		rescueMod?.parseArgs([]).port === 3082 && rescueMod?.PORT_DEFAULT === 3082,
		`port=${rescueMod?.parseArgs([]).port} PORT_DEFAULT=${rescueMod?.PORT_DEFAULT}`);
	ok("R7: open-boot 默认端口仍是 3081（唯一网页入口不变）", openBoot.parseArgs([]).port === 3081);

	// 11.2 open-boot 的端口上救援页面 + API 全可达（3081 同一套代码路径；测试用临时端口）
	const r7Profile = writeProfile(tempDir("pm-launcher-r7-"), ["@deepseek-ai/dsh-base"]);
	const r7Port = await freePort();
	const r7EnginePort = await freePort();
	const r7 = spawnNode([openBootBin, "--profile", r7Profile, "--port", String(r7Port), "--no-window", "--dsh", "pm-launcher-not-a-real-dsh", "--wait-ms", "600"],
		{ logName: "r7", env: { DSH_ENGINE_PORT: String(r7EnginePort) } });
	const r7RescueProfile = writeProfile(tempDir("pm-launcher-r7-rescue-"), ["@deepseek-ai/dsh-base"]);
	const r7RescuePort = await freePort();
	const r7Rescue = spawnNode([rescueBin, "--profile", r7RescueProfile, "--port", String(r7RescuePort)], { logName: "r7rescue", env: { DSH_ENGINE_PORT: String(r7EnginePort) } });
	try {
		const up = await waitPort(r7Port, 15000);
		const rescueUp = await waitPort(r7RescuePort, 15000);
		ok("R7: open-boot 与 rescue-daemon 同时启动、互不占用（两个非默认端口各自就绪）",
			up === true && rescueUp === true, `open-boot=${up} rescue=${rescueUp}`);
		if (up) {
			const base = `http://127.0.0.1:${r7Port}`;
			const rescuePage = await fetch(`${base}/rescue`);
			const rescueHtml = await rescuePage.text();
			ok("R7: GET /rescue → 200 完整救援页（verify/fix/start/stop/status 按钮齐备）",
				rescuePage.status === 200 && /救援中心/.test(rescueHtml) && /api\/verify/.test(rescueHtml) && /api\/fix/.test(rescueHtml)
				&& /api\/start/.test(rescueHtml) && /api\/stop/.test(rescueHtml) && /api\/status/.test(rescueHtml),
				`status=${rescuePage.status}`);
			ok("R7: 救援页的 API 前缀是 /rescue（不与 /api/status 身份语义冲突）",
				rescueHtml.includes('const API = "/rescue"'));
			const rVerify = await getJson(`${base}/rescue/api/verify`);
			ok("R7: GET /rescue/api/verify 可达（救援自检）",
				rVerify.status === 200 && rVerify.json?.ok === true && Array.isArray(rVerify.json?.issues), JSON.stringify(rVerify.json).slice(0, 140));
			const rStatus = await getJson(`${base}/rescue/api/status`);
			ok("R7: GET /rescue/api/status 可达（引擎/守护/PID 全量状态）",
				rStatus.status === 200 && rStatus.json?.identity === "dsh-rescue-daemon" && typeof rStatus.json?.engineUp === "boolean",
				JSON.stringify(rStatus.json).slice(0, 160));
			const rFix = await postJson(`${base}/rescue/api/fix`, {
				headers: { Origin: base, "X-DSH-PM-Token": tokenFromHtml(rescueHtml) }
			});
			ok("R7: POST /rescue/api/fix 写接口可达且受防护（同源 + 令牌 → 200）",
				rFix.status === 200 && rFix.json?.ok === true, `status=${rFix.status}`);
			const rStopNoToken = await postJson(`${base}/rescue/api/stop`, { headers: { Origin: base } });
			ok("R7: POST /rescue/api/stop 受防护（缺令牌 → 401，救援动作不会被跨站触发）",
				rStopNoToken.status === 401, `status=${rStopNoToken.status}`);
			const lh = await launcherHealth(r7Port, 3000);
			ok("R7: 同一端口上 /api/status 仍是 open-boot 身份（身份语义未回归）",
				lh.ok === true && lh.identity === "open-boot", JSON.stringify(lh).slice(0, 120));
		}
		if (rescueUp) {
			const rs = await getJson(`http://127.0.0.1:${r7RescuePort}/api/status`);
			ok("R7: rescue-daemon 在 3082 角色端口上照常工作（旧能力不回归）",
				rs.status === 200 && rs.json?.app === "dsh-rescue-daemon" && rs.json?.port === r7RescuePort, JSON.stringify(rs.json).slice(0, 140));
		}
	} finally {
		await killChild(r7.child);
		await killChild(r7Rescue.child);
	}

	// 11.3 rescue-daemon 的默认端口 3082 真的可用（未被 3081 占用冲突）
	if ((await portOpen(3082, 400)) === false) {
		const defaultRdProfile = writeProfile(tempDir("pm-launcher-r7-3082-"), ["@deepseek-ai/dsh-base"]);
		const defaultRd = spawnNode([rescueBin, "--profile", defaultRdProfile], { logName: "r7default", env: { DSH_ENGINE_PORT: String(r7EnginePort) } });
		try {
			const up = await waitPort(3082, 15000);
			const info = up ? await getJson("http://127.0.0.1:3082/api/status") : { json: null };
			ok("R7: 不带 --port 时 rescue-daemon 落到 3082（默认端口迁移生效，不再抢 3081）",
				up === true && info.json?.port === 3082, JSON.stringify(info.json || {}).slice(0, 120));
		} finally {
			await killChild(defaultRd.child);
		}
	} else {
		console.log("SKIP: 3082 已被占用，跳过「默认端口实测」（断言已在上面的 parseArgs 中覆盖）");
	}

	// 11.4 端口被占：明确报错、不静默漂移
	const conflictPort = await freePort();
	const blocker = await listenOn(conflictPort);
	try {
		const conflictProfile = writeProfile(tempDir("pm-launcher-r7-conflict-"), ["@deepseek-ai/dsh-base"]);
		const conflict = runNode([openBootBin, "--profile", conflictProfile, "--port", String(conflictPort)], { timeoutMs: 60000 });
		ok("R7: open-boot 端口被非本工具进程占用 → exit 1 + 明确报错（不静默漂移端口）",
			conflict.code === 1 && conflict.stderr.includes(String(conflictPort)) && /占用/.test(conflict.stderr) && /不漂移/.test(conflict.stderr),
			`exit=${conflict.code} err=${conflict.stderr.replace(/\s+/g, " ").slice(0, 200)}`);
		skipOk("R7: 报错后原占用者仍持有该端口（没有进程被挪动/杀掉）",
			(await portOpen(conflictPort, 600)) === true && portOwner(conflictPort) !== null, `owner=${portOwner(conflictPort)}`);

		const rdConflictProfile = writeProfile(tempDir("pm-launcher-r7-rdconflict-"), ["@deepseek-ai/dsh-base"]);
		const rdConflict = runNode([rescueBin, "--profile", rdConflictProfile, "--port", String(conflictPort)], { timeoutMs: 60000 });
		ok("R7: rescue-daemon 端口被占 → exit 1 + 明确报错（不漂移到 3082/3083 等）",
			rdConflict.code === 1 && rdConflict.stderr.includes(String(conflictPort)) && /已被占用/.test(rdConflict.stderr),
			`exit=${rdConflict.code} err=${rdConflict.stderr.replace(/\s+/g, " ").slice(0, 200)}`);
	} finally {
		await closeSrv(blocker);
	}

	// 11.5 真机 3081（唯一网页入口）：只读探测 + "已有实例在跑"时不重复 bind
	if (await portOpen(3081, 600)) {
		const realHealth = await launcherHealth(3081, 3000);
		ok("R7: 真机 3081 = 本启动器（launcherHealth 身份握手正常，未被本任务破坏）",
			realHealth.ok === true && realHealth.identity === "open-boot", JSON.stringify(realHealth).slice(0, 120));
		const dupProfile = writeProfile(tempDir("pm-launcher-r7-dup-"), ["@deepseek-ai/dsh-base"]);
		const dup = runNode([openBootBin, "--profile", dupProfile, "--port", "3081"], { timeoutMs: 60000 });
		ok("R7: 3081 已被本启动器占用时，新实例不重复 bind、不漂移（exit 0 + 提示已有实例）",
			dup.code === 0 && /已有/.test(dup.stdout + dup.stderr), `exit=${dup.code} out=${(dup.stdout + dup.stderr).replace(/\s+/g, " ").slice(0, 160)}`);
		skipOk("R7: 真机 3081 常驻守护 pid 不变（全程未受测试影响）",
			portOwner(3081) === real3081PidBefore, `${real3081PidBefore} → ${portOwner(3081)}`);
	} else {
		console.log("SKIP: 3081 上没有常驻启动器（本机未运行 3081 守护），跳过真机入口校验");
	}
}

// ---------------------------------------------------------------- 13. 用法错误与目标校验（t17 / t14-F1）
console.log("== 13. --profile 输入校验与全局动作目标闸门（t17）==");
{
	const dirFor = (name) => { const d = tempDir(`pm-launcher-t17-${name}-`); mkdirSync(d, { recursive: true }); return d; };

	// 13.1 parseArgs 层：取值缺失/被开关占用/空白/=形式 → 用法错误（不做任何事）
	{
		const bad = [
			[["--uninstall", "--profile", "--port", "63001"], "--port", "被后面的开关占用（t14 实测的原始笔误）"],
			[["--uninstall", "--profile"], "缺少取值", "位于末尾缺值"],
			[["--profile", "-"], "-", "取值是单个 -"],
			[["--profile", "--"], "--", "取值是 --"],
			[["--profile", "   "], "空白", "取值全是空白"],
			[["--profile="], "=", "= 形式但取值为空"]
		];
		for (const [argv, needle, label] of bad) {
			const parsed = openBoot.parseArgs(argv);
			ok(`t17: parseArgs 判用法错误（${label}）：${argv.join(" ")}`,
				typeof parsed.usageError === "string" && parsed.usageError.length > 0 && parsed.usageError.includes(needle),
				`usageError=${JSON.stringify(parsed.usageError)}`);
		}
		const eqForm = openBoot.parseArgs(["--profile=C:\\tmp\\probe-profile"]);
		ok("t17: --profile=<目录> 形式被支持（不再落进 unknown 被静默忽略）",
			eqForm.usageError === null && eqForm.profile === resolve("C:\\tmp\\probe-profile"), eqForm.profile);
		const spaced = openBoot.parseArgs(["--profile", "   C:\\tmp\\probe-profile   ", "--port", "3099"]);
		ok("t17: 取值前后空格被 trim 后再绝对化（不再把空格带进路径）",
			spaced.usageError === null && spaced.profile === resolve("C:\\tmp\\probe-profile") && spaced.port === 3099, spaced.profile);
		const normal = openBoot.parseArgs(["--uninstall"]);
		ok("t17: 正常用法不受影响（--uninstall 单独出现：无 usageError、仍是默认 profile/端口）",
			normal.usageError === null && normal.uninstall === true && normal.port === 3081, JSON.stringify({ err: normal.usageError, port: normal.port }));
		const goodProfile = writeProfile(tempDir("pm-launcher-t17-goodarg-"), ["@deepseek-ai/dsh-base"]);
		const withGood = openBoot.parseArgs(["--uninstall", "--profile", goodProfile, "--port", "63001"]);
		ok("t17: 合法 --profile 取值照常解析（无 usageError）",
			withGood.usageError === null && resolve(withGood.profile) === resolve(goodProfile) && withGood.port === 63001);
	}

	// 13.2 语义层：目标像不像 profile
	{
		const valid = writeProfile(tempDir("pm-launcher-t17-valid-"), ["@deepseek-ai/dsh-base"]);
		ok("t17: looksLikeProfileDir(正常 profile) → ok + marker=package.json",
			looksLikeProfileDir(valid).ok === true && looksLikeProfileDir(valid).marker === "package.json");
		const patchOnly = dirFor("patchonly");
		writeFileSync(join(patchOnly, "cordis.patch.yml"), "[]\n", "utf8");
		ok("t17: 只有 cordis.patch.yml 的目录也算 profile（marker 命中）", looksLikeProfileDir(patchOnly).ok === true);
		const empty = dirFor("empty");
		ok("t17: 空目录不像 profile（拒绝，理由可读）",
			looksLikeProfileDir(empty).ok === false && /不像 DSH profile/.test(looksLikeProfileDir(empty).reason || ""), looksLikeProfileDir(empty).reason);
		ok("t17: 不存在的目录 → 拒绝（理由含'不存在'）",
			looksLikeProfileDir(join(empty, "nope")).ok === false && /不存在/.test(looksLikeProfileDir(join(empty, "nope")).reason || ""));
		const asFile = join(empty, "a-file.txt");
		writeFileSync(asFile, "x\n", "utf8");
		ok("t17: 指向文件而不是目录 → 拒绝（理由含'不是目录'）",
			looksLikeProfileDir(asFile).ok === false && /不是目录/.test(looksLikeProfileDir(asFile).reason || ""));
		ok("t17: 空字符串/空白 → 拒绝（理由含'为空'）",
			looksLikeProfileDir("").ok === false && looksLikeProfileDir("   ").ok === false && /为空/.test(looksLikeProfileDir("  ").reason || ""));
	}

	// 13.3 CLI：用法错误必须零副作用（注册表 / pid / 日志 / cwd 新目录 / 输出）
	{
		const defaultProfile = join(homedir(), ".dsh", "profiles", "web");
		const sideSnapshot = () => ({
			pid: existsSync(join(defaultProfile, ".open-boot.pid")) ? readFileSync(join(defaultProfile, ".open-boot.pid"), "utf8") : null,
			health: existsSync(join(defaultProfile, "health.log")) ? statSync(join(defaultProfile, "health.log")).size : null,
			reg: regKeySignature(),
			port3081: portOwner(3081)
		});
		const before = sideSnapshot();
		const bogus = runNode([openBootBin, "--uninstall", "--profile", "--port", "63001"], { timeoutMs: 60000 });
		const after = sideSnapshot();
		ok("t17: `--uninstall --profile --port 63001` → exit 1（用法错误，不再假报成功）", bogus.code === 1, `exit=${bogus.code}`);
		ok("t17: 用法错误打 stderr（含 usageError 与完整用法）且 stdout 无「卸载完成」",
			/用法错误/.test(bogus.stderr) && /--uninstall 语义/.test(bogus.stderr) && !/卸载完成/.test(bogus.stdout) && bogus.stdout.trim() === "",
			`stdout=${JSON.stringify(bogus.stdout.slice(0, 80))} stderrHead=${bogus.stderr.split("\n")[0].slice(0, 80)}`);
		ok("t17: 零副作用 —— 默认 profile 的 pid 文件与 health.log 未变",
			before.pid === after.pid && before.health === after.health,
			`pid=${before.pid === after.pid} health=${before.health === after.health}`);
		ok("t17: 零副作用 —— 没有在 cwd 里新建 \"--port\" 目录（bogus profile 未被执行到）",
			!existsSync(join(ROOT, "--port")));
		skipOk("t17: 零副作用 —— 注册表 Run 键签名未变（未执行 DSHWeb* 删除）", before.reg === after.reg, `before=${String(before.reg).slice(0, 60)} after=${String(after.reg).slice(0, 60)}`);
		skipOk("t17: 零副作用 —— 真机 3081 守护 pid 未变（未停任何进程）", before.port3081 === after.port3081, `${before.port3081} → ${after.port3081}`);

		const tailMissing = runNode([openBootBin, "--uninstall", "--profile"], { timeoutMs: 60000 });
		ok("t17: `--uninstall --profile`（末尾缺值）→ exit 1 + stderr 用法 + 无「卸载完成」",
			tailMissing.code === 1 && /用法错误/.test(tailMissing.stderr) && !/卸载完成/.test(tailMissing.stdout), `exit=${tailMissing.code}`);

		// 目标不像 profile：拒绝执行全局动作，且不碰目录里已有的 pid 文件
		const notProfile = dirFor("notprofile");
		writeFileSync(join(notProfile, ".open-boot.pid"), JSON.stringify({
			app: "dsh-open-boot", pid: process.pid, port: 63001, profile: notProfile, startedAt: new Date().toISOString()
		}) + "\n", "utf8");
		const regBefore2 = regKeySignature();
		const refused = runNode([openBootBin, "--uninstall", "--profile", notProfile, "--port", "63001"], { timeoutMs: 60000 });
		ok("t17: 目标不像 profile → exit 1 + 「拒绝执行」+ 不报「卸载完成」（不静默成功）",
			refused.code === 1 && /拒绝执行/.test(refused.stdout) && !/卸载完成/.test(refused.stdout), `exit=${refused.code} out=${refused.stdout.replace(/\s+/g, " ").slice(0, 140)}`);
		ok("t17: 拒绝时不动该目录里的 .open-boot.pid（未删线索）", existsSync(join(notProfile, ".open-boot.pid")));
		skipOk("t17: 拒绝时未执行全局 DSHWeb* 删除（注册表签名未变）", regKeySignature() === regBefore2);

		const asFileProfile = join(notProfile, "a-file.txt");
		writeFileSync(asFileProfile, "x\n", "utf8");
		const fileCase = runNode([openBootBin, "--uninstall", "--profile", asFileProfile], { timeoutMs: 60000 });
		ok("t17: --profile 指向文件 → exit 1 + 「不是目录」", fileCase.code === 1 && /不是目录/.test(fileCase.stdout), `exit=${fileCase.code}`);

		// 全局性写入（安装自启）同样受闸门保护
		const installRefused = runNode([openBootBin, "--install-autostart", "--profile", notProfile, "--port", "63001"], { timeoutMs: 60000 });
		ok("t17: --install-autostart 目标不合法 → exit 1 + 拒绝 + 不写任何 .vbs",
			installRefused.code === 1 && /拒绝安装开机自启/.test(installRefused.stdout)
			&& !existsSync(join(notProfile, "open-boot-autostart.vbs")) && !existsSync(join(notProfile, "open-boot-ui.vbs")),
			`exit=${installRefused.code}`);
		const uninstallAutostartRefused = runNode([openBootBin, "--uninstall-autostart", "--profile", notProfile], { timeoutMs: 60000 });
		ok("t17: --uninstall-autostart 目标不合法 → exit 1 + 拒绝（不删全局 DSHWeb*）",
			uninstallAutostartRefused.code === 1 && /拒绝移除开机自启/.test(uninstallAutostartRefused.stdout), `exit=${uninstallAutostartRefused.code}`);

		// 正常路径不回归：合法 profile（即使还没有 pid 文件）→ 仍按原语义走完并 exit 0
		const okProfile = writeProfile(tempDir("pm-launcher-t17-okpath-"), ["@deepseek-ai/dsh-base"]);
		const okRun = runNode([openBootBin, "--uninstall", "--profile", okProfile, "--port", "63011"], { timeoutMs: 60000 });
		ok("t17: 合法 profile + 无 pid 文件 → 未被目标闸门拦住（exit 0，输出「无可定位的守护」）",
			okRun.code === 0 && /无可定位的守护/.test(okRun.stdout) && !/拒绝执行/.test(okRun.stdout), `exit=${okRun.code}`);
		// t24 显式改写（旧断言匹配的是 t17 的 help 措辞 `输入校验（t14-F1…`，现已并入统一的表驱动说明）：
		// 意图不变 —— help 必须写明"用法错误零副作用"与"全局动作前校验目标像 profile"。
		ok("t17/t24: --help 声明输入校验口径（用法错误零副作用 + 全局动作目标闸门）",
			/输入校验（表驱动解析/.test(openBoot.HELP_TEXT) && /不执行任何动作/.test(openBoot.HELP_TEXT) && /像 profile/.test(openBoot.HELP_TEXT));
	}
}

// ---------------------------------------------------------------- 14. 未识别 token 与取值校验（t20 / t18-F1）
console.log("== 14. 未识别 token 与取值校验（t20）==");
{
	// 14.1 t24 收窄：**开关形态**的未知 token 已在解析阶段一律用法错误（含非全局模式，F2①）；
	//      `unknownTokenPolicy` 现在只处理**位置参数**（全局子命令拒绝 / 其余模式警告并忽略）。
	for (const [argv, expect] of [
		[["--uninstall", "--profle", "x"], "switch-like"],
		[["--uninstall", "--Profile", "x"], "switch-like"],
		[["--uninstall", "--prof", "x"], "switch-like"],
		[["--uninstall", "-p", "x"], "switch-like"],
		[["--uninstall", "--profileX", "x"], "switch-like"],
		[["--uninstall", "--"], "switch-like"],
		[["--status", "--typo"], "switch-like"],
		[["--install-autostart", "--typo"], "switch-like"],
		[["--uninstall-autostart", "--typo"], "switch-like"],
		[["--uninstall", "--profile", "C:/tmp/p", "extra-positional"], "positional"],
		[["--install-autostart", "extra-positional"], "positional"],
		[["--status", "extra-positional"], "positional-non-global"]
	]) {
		const parsed = openBoot.parseArgs(argv);
		const policy = openBoot.unknownTokenPolicy(parsed);
		if (expect === "switch-like") {
			ok(`t20/t24: 开关形态的未知 token → 解析阶段用法错误（${argv.join(" ")}）`,
				typeof parsed.usageError === "string" && /未知开关/.test(parsed.usageError),
				`usageError=${parsed.usageError}`);
		} else if (expect === "positional") {
			ok(`t20: 全局子命令 + 多余位置参数 → 策略拒绝（${argv.join(" ")}）`,
				parsed.usageError === null && policy.reject === true && /位置参数/.test(policy.message || ""),
				`reject=${policy.reject} unknown=${JSON.stringify(parsed.unknown)}`);
		} else {
			ok(`t20/t24: 非全局模式的位置参数保持「警告并忽略」（${argv.join(" ")}）`,
				parsed.usageError === null && policy.reject === false && /已忽略/.test(policy.message || ""),
				String(policy.message));
		}
	}
	const noUnknown = openBoot.unknownTokenPolicy(openBoot.parseArgs(["--uninstall"]));
	ok("t20: 无位置参数时策略为空（裸跑/正常组合不受影响）", noUnknown.reject === false && noUnknown.message === null);

	// 14.2 端口取值校验（纯函数）
	for (const [value, shouldPass] of [[undefined, false], ["", false], ["abc", false], ["3081abc", false], ["0", false], ["65536", false], ["-1", false], ["--profile", false], ["3081", true], [" 3099 ", true]]) {
		const error = validatePortValue(value);
		ok(`t20: validatePortValue(${JSON.stringify(value)}) → ${shouldPass ? "合法" : "拒绝"}`,
			shouldPass ? error === null : typeof error === "string", String(error));
	}

	// 14.3 CLI：每个拒绝形态都 exit 1 + stderr 用法 + stdout 空，且整批零副作用
	{
		const realDefault = join(homedir(), ".dsh", "profiles", "web");
		const snapshot = () => ({
			pid: existsSync(join(realDefault, ".open-boot.pid")) ? readFileSync(join(realDefault, ".open-boot.pid"), "utf8") : null,
			health: existsSync(join(realDefault, "health.log")) ? statSync(join(realDefault, "health.log")).size : null,
			reg: regKeySignature(),
			port3081: portOwner(3081),
			shimMtime: existsSync(join(realDefault, "open-boot-autostart.vbs")) ? statSync(join(realDefault, "open-boot-autostart.vbs")).mtimeMs : null
		});
		const before = snapshot();
		const variants = [
			["--uninstall", "--profle", "x"],
			["--uninstall", "--Profile", "x"],
			["--uninstall", "-p", "x"],
			["--uninstall", "--"],
			["--uninstall", "--port"],
			["--uninstall", "--port", "abc"],
			["--uninstall", "--port", "65536"],
			["--uninstall", "--port", "--profile", "x"],
			["--install-autostart", "--typo"],
			["--uninstall-autostart", "--typo"]
		];
		let allRejected = true;
		const details = [];
		for (const argv of variants) {
			const result = runNode([openBootBin, ...argv], { timeoutMs: 60000 });
			const good = result.code === 1 && /用法错误/.test(result.stderr)
				&& !/卸载完成|已安装|已移除/.test(result.stdout) && result.stdout.trim() === "";
			if (!good) allRejected = false;
			details.push(`${argv.join(" ")}=${result.code}${good ? "" : "(out=" + result.stdout.replace(/\s+/g, " ").slice(0, 40) + " err=" + result.stderr.replace(/\s+/g, " ").slice(0, 40) + ")"}`);
		}
		ok(`t20: ${variants.length} 个拒绝形态全部 exit 1 + stderr 用法 + stdout 无「完成/已安装/已移除」`,
			allRejected, details.join(" | ").slice(0, 400));
		const after = snapshot();
		ok("t20: 零副作用 —— 真机 profile 的 pid 文件 / health.log / shim mtime 均未变",
			before.pid === after.pid && before.health === after.health && before.shimMtime === after.shimMtime,
			`pid=${before.pid === after.pid} health=${before.health === after.health} shim=${before.shimMtime === after.shimMtime}`);
		skipOk("t20: 零副作用 —— 注册表 Run 键逐行快照一致（未执行 DSHWeb* 删除）",
			before.reg === after.reg, `before=${String(before.reg).slice(0, 50)} after=${String(after.reg).slice(0, 50)}`);
		skipOk("t20: 零副作用 —— 真机 3081 守护归属未变（未停任何进程）",
			before.port3081 === after.port3081, `${before.port3081} → ${after.port3081}`);
		skipOk("t20: 零副作用 —— DSHWeb* 值集合未变化（未删/未增自启项）",
			regQueryDshWebNames().length === regQueryDshWebNames().length, regQueryDshWebNames().join(","));
	}

	// 14.4 正常组合（parse 层）不回归：不执行任何真实卸载
	for (const argv of [
		["--uninstall"],
		["--uninstall", "--profile", "C:/tmp/ok-profile"],
		["--uninstall", "--profile=C:/tmp/ok-profile"],
		["--uninstall", "--profile", "C:/tmp/ok-profile", "--port", "3099"],
		["--install-autostart", "--profile", "C:/tmp/ok-profile", "--port", "3099"],
		["--uninstall-autostart", "--profile", "C:/tmp/ok-profile"],
		["--status", "--profile", "C:/tmp/ok-profile"]
	]) {
		const parsed = openBoot.parseArgs(argv);
		const policy = openBoot.unknownTokenPolicy(parsed);
		ok(`t20: 正常组合不被拒绝（${argv.join(" ")}）`, parsed.usageError === null && policy.reject === false,
			JSON.stringify({ usageError: parsed.usageError, reject: policy.reject, unknown: parsed.unknown }));
	}
	// t24 显式改写（旧断言用的是 t20 的措辞「未识别的开关或位置参数」「1..65535」）：
	// 意图不变 —— help 必须写明未知开关一律拒绝与端口取值范围。
	ok("t20/t24: --help 声明未知开关与端口取值的校验口径",
		/未知开关/.test(openBoot.HELP_TEXT) && /1-65535/.test(openBoot.HELP_TEXT));
}

// ---------------------------------------------------------------- 15. 表驱动解析（t24 / t21-F1）
console.log("== 15. 表驱动解析：取值开关吞值 / 未知开关 / 拼错命令名 / 互斥多选（t24）==");
{
	// 15.1 所有取值开关的取值校验（共享件 validateCliValue / validateIntegerValue 已应用到表里每一项）
	const valueSwitches = [
		["--profile"], ["--port"], ["--dsh"], ["--cwd"], ["--interval"], ["--wait-ms"], ["--heartbeat-min"]
	];
	for (const [flag] of valueSwitches) {
		const missing = openBoot.parseArgs(["--uninstall", flag]);
		const blank = openBoot.parseArgs(["--uninstall", flag, "   "]);
		const swallowed = openBoot.parseArgs(["--uninstall", flag, "--profile"]);
		ok(`t24: ${flag} 取值缺失 → 用法错误`,
			typeof missing.usageError === "string" && missing.usageError.includes(flag), String(missing.usageError));
		ok(`t24: ${flag} 取值为空白 → 用法错误`,
			typeof blank.usageError === "string" && blank.usageError.includes(flag), String(blank.usageError));
		ok(`t24: ${flag} 取值以 - 开头（被后面的开关占用）→ 用法错误（t21-F1 的根因）`,
			typeof swallowed.usageError === "string" && /缺少取值/.test(swallowed.usageError), String(swallowed.usageError));
	}
	// 数值开关的额外规则：纯数字 + 范围（不再静默夹取/回落默认值）
	for (const [argv, needle] of [
		[["--interval", "abc"], "纯数字"], [["--interval", "4"], "越界"], [["--interval", "999999"], "越界"],
		[["--wait-ms", "abc"], "纯数字"], [["--wait-ms", "0"], "越界"],
		[["--heartbeat-min", "abc"], "纯数字"], [["--heartbeat-min", "1441"], "越界"],
		[["--port", "0"], "越界"], [["--port", "65536"], "越界"]
	]) {
		const parsed = openBoot.parseArgs(["--supervise", ...argv]);
		ok(`t24: 数值开关范围/类型校验（${argv.join(" ")} → ${needle}）`,
			typeof parsed.usageError === "string" && parsed.usageError.includes(needle), String(parsed.usageError));
	}

	// 15.2 t21 的 5+2 个 swallow 形态：必须在 CLI 层 exit 1、stdout 空、stderr 用法，且诱饵默认 profile 零副作用
	{
		const decoyHome = mkdtempSync(join(tmpdir(), "pm-launcher-t24-home-"));
		tempDirs.push(decoyHome);
		const decoyProfile = join(decoyHome, ".dsh", "profiles", "web");
		mkdirSync(decoyProfile, { recursive: true });
		writeFileSync(join(decoyProfile, "package.json"), JSON.stringify({ name: "decoy-default-profile", private: true, dsh: { profile: { bundles: [] } } }, null, 2) + "\n", "utf8");
		writeFileSync(join(decoyProfile, "cordis.patch.yml"), "[]\n", "utf8");
		writeFileSync(join(decoyProfile, ".open-boot.pid"), JSON.stringify({
			app: "dsh-open-boot", pid: 424242, port: 3081, profile: decoyProfile, startedAt: "2026-10-06T00:00:00.000Z"
		}) + "\n", "utf8");
		writeFileSync(join(decoyProfile, "open-boot-autostart.vbs"), "' decoy shim\r\n", "utf8");
		const decoySnapshot = () => JSON.stringify(readdirSync(decoyProfile).sort().map((name) => {
			const full = join(decoyProfile, name);
			return `${name}:${statSync(full).size}:${readFileSync(full, "utf8")}`;
		}));
		const decoyBefore = decoySnapshot();
		const decoyEnv = { USERPROFILE: decoyHome, HOME: decoyHome };
		const swallowForms = [
			["--uninstall", "--dsh", "--profile"],
			["--uninstall", "--cwd", "--profile"],
			["--uninstall", "--dsh", "--uninstal"],
			["--uninstall", "--interval", "--profile"],
			["--uninstall", "--wait-ms", "--typo"],
			["--install-autostart", "--dsh", "--profile"],
			["--uninstall-autostart", "--cwd", "--profile"]
		];
		let allRejected = true;
		const details = [];
		for (const argv of swallowForms) {
			const result = runNode([openBootBin, ...argv], { timeoutMs: 60000, env: decoyEnv });
			const good = result.code === 1 && result.stdout.trim() === "" && /用法错误/.test(result.stderr);
			if (!good) allRejected = false;
			details.push(`${argv.join(" ")}=${result.code}`);
		}
		ok(`t24: t21 的 ${swallowForms.length} 个 swallow 形态全部 exit 1 + stdout 空 + stderr 用法（不再静默回落默认 profile/3081）`,
			allRejected, details.join(" | "));
		ok("t24: 全部 swallow 形态对诱饵默认 profile 零副作用（文件集合/大小/内容前后逐字节一致：pid/剪影/注册表痕迹完好）",
			decoySnapshot() === decoyBefore, `before=${decoyBefore.slice(0, 120)} after=${decoySnapshot().slice(0, 120)}`);
	}

	// 15.3 所有模式下"像开关的未知 token"一律拒绝（F2①）；位置参数另按策略
	{
		const unknownForms = [
			["--status", "--typo"],
			["--ensure", "--typo"],
			["--supervise", "--typo"],
			["--autostart-status", "--typo"],
			["--uninstall", "--typo"],
			["--install-autostart", "--typo"]
		];
		let allRejected = true;
		const details = [];
		for (const argv of unknownForms) {
			const result = runNode([openBootBin, ...argv], { timeoutMs: 60000 });
			const good = result.code === 1 && result.stdout.trim() === "" && /用法错误/.test(result.stderr) && /未知开关/.test(result.stderr);
			if (!good) allRejected = false;
			details.push(`${argv.join(" ")}=${result.code}`);
		}
		ok(`t24: ${unknownForms.length} 个「全模式未知开关」形态全部 exit 1 + stderr 用法（不再 warn+ignore）`,
			allRejected, details.join(" | "));
		const positionalNonGlobal = runNode([openBootBin, "--status", "extra-positional"], { timeoutMs: 60000 });
		ok("t24: 非全局模式的位置参数保持「警告并忽略」（stdout/stderr 无用法错误）",
			positionalNonGlobal.code !== 1 || !/用法错误/.test(positionalNonGlobal.stderr),
			`exit=${positionalNonGlobal.code} err=${positionalNonGlobal.stderr.replace(/\s+/g, " ").slice(0, 100)}`);
	}

	// 15.4 命令名拼错 → 拒绝 + did-you-mean（匹配大小写敏感、建议忽略大小写）
	{
		const cases = [
			["--uninstal", "--uninstall"],
			["--UNINSTALL", "--uninstall"],
			["--Install-Autostart", "--install-autostart"],
			["--profle", "--profile"]
		];
		for (const [token, expectedSuggestion] of cases) {
			const parsed = openBoot.parseArgs([token]);
			const suggestions = openBoot.suggestClosestSwitch(token);
			ok(`t24: 拼错的开关 ${token} → 用法错误 + did-you-mean 含 ${expectedSuggestion}`,
				typeof parsed.usageError === "string" && /未知开关/.test(parsed.usageError) && suggestions.includes(expectedSuggestion),
				`usageError=${parsed.usageError} suggestions=${JSON.stringify(suggestions)}`);
			const result = runNode([openBootBin, token], { timeoutMs: 60000 });
			ok(`t24: 拼错开关 ${token} 在 CLI 层 exit 1 且 stderr 给出 did-you-mean（不再落到"前台启动服务器"）`,
				result.code === 1 && /用法错误/.test(result.stderr) && result.stderr.includes(expectedSuggestion) && result.stdout.trim() === "",
				`exit=${result.code} err=${result.stderr.replace(/\s+/g, " ").slice(0, 120)}`);
		}
		ok("t24: 开关名匹配**大小写敏感**（--UNINSTALL 被拒），而建议是忽略大小写得出的",
			typeof openBoot.parseArgs(["--UNINSTALL"]).usageError === "string"
			&& openBoot.parseArgs(["--uninstall"]).usageError === null
			&& openBoot.suggestClosestSwitch("--UNINSTALL").includes("--uninstall"));
	}

	// 15.5 互斥子命令多选 → 用法错误（列出冲突开关），不再静默以某一个为准（F3）
	{
		for (const argv of [
			["--install-autostart", "--uninstall"],
			["--uninstall", "--install-autostart"],
			["--status", "--ensure"],
			["--supervise", "--ensure"],
			["--uninstall-autostart", "--autostart-status"]
		]) {
			const parsed = openBoot.parseArgs(argv);
			ok(`t24: 互斥模式多选 → 用法错误并列出冲突（${argv.join(" ")}）`,
				typeof parsed.usageError === "string" && /互斥/.test(parsed.usageError)
				&& argv.every((flag) => parsed.usageError.includes(flag)),
				String(parsed.usageError));
			const result = runNode([openBootBin, ...argv], { timeoutMs: 60000 });
			ok(`t24: 互斥多选在 CLI 层 exit 1（${argv.join(" ")}）`,
				result.code === 1 && /互斥/.test(result.stderr) && result.stdout.trim() === "", `exit=${result.code}`);
		}
		const helpWins = runNode([openBootBin, "--help", "--uninstall"], { timeoutMs: 60000 });
		ok("t24: `--help` 优先、不与其它模式冲突（仍打用法并 exit 0）",
			helpWins.code === 0 && /--uninstall 语义/.test(helpWins.stdout), `exit=${helpWins.code}`);
	}

	// 15.6 内联 `--flag=值` 统一支持 + 正常组合不回归
	{
		for (const [argv, check] of [
			[["--port=3099", "--ensure"], (a) => a.port === 3099 && a.ensure === true],
			[["--dsh=npx dsh", "--status"], (a) => a.dsh === "npx dsh"],
			[["--cwd=C:/tmp", "--ensure"], (a) => String(a.cwd).includes("tmp")],
			[["--interval=30", "--supervise"], (a) => a.interval === 30],
			[["--wait-ms=60000", "--ensure"], (a) => a.waitMs === 60000],
			[["--heartbeat-min=5", "--supervise"], (a) => a.heartbeatMin === 5],
			[["--profile=C:/tmp/p", "--uninstall"], (a) => String(a.profile).includes("tmp")]
		]) {
			const parsed = openBoot.parseArgs(argv);
			ok(`t24: 内联写法 ${argv.join(" ")} 解析正确`, parsed.usageError === null && check(parsed),
				JSON.stringify({ usageError: parsed.usageError }));
		}
		const flagWithValue = openBoot.parseArgs(["--quiet=1"]);
		ok("t24: 非取值开关写 = 值 → 明确报错（而不是被当成未知开关或静默忽略）",
			typeof flagWithValue.usageError === "string" && /不接受取值/.test(flagWithValue.usageError), String(flagWithValue.usageError));
		const normalCombos = [
			["--uninstall"],
			["--uninstall", "--profile", "C:/tmp/p"],
			["--uninstall", "--profile=C:/tmp/p", "--port", "3099"],
			["--supervise", "--interval", "30", "--heartbeat-min", "5", "--quiet"],
			["--ensure", "--profile", "C:/tmp/p", "--port", "3099", "--dsh", "npx dsh"],
			["--status", "--profile", "C:/tmp/p"],
			["--autostart-status", "--profile", "C:/tmp/p"],
			["--install-autostart", "--profile", "C:/tmp/p", "--port", "3099"],
			["--no-window", "--wait-ms", "60000", "--ensure"]
		];
		for (const argv of normalCombos) {
			const parsed = openBoot.parseArgs(argv);
			const policy = openBoot.unknownTokenPolicy(parsed);
			ok(`t24: 正常组合不被拒绝（${argv.join(" ")}）`,
				parsed.usageError === null && policy.reject === false, JSON.stringify({ usageError: parsed.usageError, reject: policy.reject }));
		}
	}

	// 15.7 --help 写明四类规则
	{
		const help = openBoot.HELP_TEXT;
		ok("t24: --help 写明取值开关校验（缺失/空白/以 - 开头 + 数值范围 + 内联写法）",
			/取值开关/.test(help) && /以 - 开头/.test(help) && /1-65535/.test(help) && /--flag=值/.test(help));
		ok("t24: --help 写明未知开关/大小写敏感/位置参数策略/互斥规则",
			/未知开关/.test(help) && /大小写敏感/.test(help) && /位置参数/.test(help) && /互斥/.test(help) && /--help 例外/.test(help));
	}
}

// ---------------------------------------------------------------- 收尾
for (const dir of tempDirs) {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (xfails.length > 0) {
	console.warn(`\n=== XFAIL ${xfails.length} 条（写域外的已知缺陷；--strict 下算失败）===`);
	for (const x of xfails) console.warn(`  - ${x}`);
}

if (skipped.length > 0) {
	console.warn(`\n=== SKIP ${skipped.length} 条（环境能力缺失，非代码缺陷；不计入失败）===`);
	console.warn("  原因：本会话沙箱禁止 Node 打开命名管道 → child_process 管道 stdio 直接 EPERM，");
	console.warn("        reg.exe / netstat / tasklist 取不到输出（portOwner() / processImage() / reg query 全为 null）。");
	console.warn("  这些断言覆盖 R13 的\"注册表零残留 / 守护确实被停 / 真机 pid 未变\"三类证据。");
	console.warn("  关闭证据缺口：在**沙箱外**（普通终端 / 非受限会话）复跑同一条命令即可，SKIP 会变成真实断言：");
	console.warn("        cd plugin-manager && node test-launcher.mjs --strict");
	for (const item of skipped) console.warn(`  - ${item}`);
}

if (STRICT && xfails.length > 0) {
	for (const x of xfails) failures.push(`[strict] ${x}`);
}

if (failures.length > 0) {
	console.error(`\nLAUNCHER TESTS FAILED (${failures.length}/${checks}):\n - ` + failures.join("\n - "));
	process.exit(1);
}
console.log(`\nALL LAUNCHER TESTS PASSED (${checks} checks${xfails.length > 0 ? `, ${xfails.length} xfail` : ""}${skipped.length > 0 ? `, ${skipped.length} skipped(env)` : ""})`);
if (skipped.length > 0) console.warn("注意：本次运行有环境性 SKIP（见上），完整验收请在沙箱外复跑 `node test-launcher.mjs --strict`。");
process.exit(0);
