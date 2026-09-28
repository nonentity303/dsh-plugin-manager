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
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
function runNode(args, { cwd = ROOT, timeoutMs = 120000 } = {}) {
	const dir = tempDir("pm-launcher-run-");
	const out = join(dir, "out.log");
	const err = join(dir, "err.log");
	const fdOut = openSync(out, "w");
	const fdErr = openSync(err, "w");
	const res = spawnSync(process.execPath, args, {
		cwd, env: childEnv(), stdio: ["ignore", fdOut, fdErr], windowsHide: true, timeout: timeoutMs
	});
	closeSync(fdOut);
	closeSync(fdErr);
	return { code: res.status, signal: res.signal, stdout: readFileSync(out, "utf8"), stderr: readFileSync(err, "utf8") };
}

/** 长命子进程（守护/服务）：输出重定向到临时文件，随读随关。 */
function spawnNode(args, { cwd = ROOT, logName = "svc" } = {}) {
	const dir = tempDir("pm-launcher-spawn-");
	const out = join(dir, `${logName}.out.log`);
	const err = join(dir, `${logName}.err.log`);
	const fdOut = openSync(out, "w");
	const fdErr = openSync(err, "w");
	const child = spawn(process.execPath, args, { cwd, env: childEnv(), stdio: ["ignore", fdOut, fdErr], windowsHide: true });
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

function writeProfile(dir, bundles, extra = {}) {
	writeFileSync(join(dir, "package.json"), JSON.stringify({
		name: "pm-launcher-test-profile",
		private: true,
		dsh: { profile: { bundles } },
		dependencies: {},
		...extra
	}, null, 2) + "\n", "utf8");
	writeFileSync(join(dir, "cordis.patch.yml"), "# pm-launcher test profile\n[]\n", "utf8");
	return dir;
}

function regRunKey() {
	if (!WIN) return "";
	const out = spawnSync("reg", ["query", RUN_KEY], { windowsHide: true, encoding: "utf8" });
	return `${out.status}\n${out.stdout || ""}`;
}

// ---------------------------------------------------------------- 1. enginectl
console.log("== 1. lib/enginectl.mjs ==");
const { ENGINE_PORT, engineHealth, launcherHealth, probe, readPid, waitForEngine, readEngineLog } =
	await import("./lib/enginectl.mjs");

ok("enginectl.ENGINE_PORT === 3080（引擎端口契约；仅断言常量，不连接）", ENGINE_PORT === 3080, `got ${ENGINE_PORT}`);

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
		ok("parseArgs: 未知参数被收集（不静默吞掉）",
			Array.isArray(parseArgs(["--nope"]).unknown) && parseArgs(["--nope"]).unknown.includes("--nope"),
			JSON.stringify(parseArgs(["--nope"]).unknown));
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
}

// ---------------------------------------------------------------- 4. open-boot CLI（只读）
console.log("== 4. bin/open-boot.mjs CLI（--help / --autostart-status，只读）==");
const help = runNode([join(ROOT, "bin", "open-boot.mjs"), "--help"], { timeoutMs: 30000 });
ok("open-boot --help: 退出 0 且打印用法（不启动服务）",
	help.code === 0 && /open-boot/.test(help.stdout) && /--autostart-status/.test(help.stdout),
	`exit=${help.code} out=${help.stdout.slice(0, 120)}`);

const regBefore = regRunKey();
const st1 = runNode([join(ROOT, "bin", "open-boot.mjs"), "--autostart-status"], { timeoutMs: 60000 });
const st2 = runNode([join(ROOT, "bin", "open-boot.mjs"), "--autostart-status"], { timeoutMs: 60000 });
const regAfter = regRunKey();
ok("open-boot --autostart-status: 幂等（两次输出完全一致）",
	st1.stdout === st2.stdout && st1.code === st2.code, `exit=${st1.code}/${st2.code}`);
ok("open-boot --autostart-status: 只读（注册表 Run 键运行前后逐字节一致）",
	regBefore === regAfter, `before=${regBefore.slice(0, 120)} after=${regAfter.slice(0, 120)}`);
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

// ---------------------------------------------------------------- 收尾
for (const dir of tempDirs) {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (xfails.length > 0) {
	console.warn(`\n=== XFAIL ${xfails.length} 条（写域外的已知缺陷；--strict 下算失败）===`);
	for (const x of xfails) console.warn(`  - ${x}`);
}

if (STRICT && xfails.length > 0) {
	for (const x of xfails) failures.push(`[strict] ${x}`);
}

if (failures.length > 0) {
	console.error(`\nLAUNCHER TESTS FAILED (${failures.length}/${checks}):\n - ` + failures.join("\n - "));
	process.exit(1);
}
console.log(`\nALL LAUNCHER TESTS PASSED (${checks} checks${xfails.length > 0 ? `, ${xfails.length} xfail` : ""})`);
process.exit(0);
