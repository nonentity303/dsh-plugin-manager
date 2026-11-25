#!/usr/bin/env node
/**
 * test-extra-ports.mjs — 非默认端口隔离测试引擎（端口补完验收工具）。
 *
 * 用途：在**完全隔离**的临时 DSH_HOME + 临时 profile + 非默认端口上，验证整条启动器工具链
 * 是否随端口覆盖一起搬家：
 *   engine 3180 / launcher 3181 / rescue 3182 / 守护锁 4181
 *
 * 覆盖：
 *   1. `open-boot --ensure` 在自定义端口拉起启动器；`/api/status` 身份 + 端口 + profile 一致
 *   2. `/plugins` 兜底页、`/rescue` 救援页、`/` 启动页可达，且页面里的引擎/启动器/救援链接
 *      全部指向自定义端口（不再残留 3080/3081/3082）
 *   3. `/rescue/api/verify|fix|start|stop` 完整往返（start/stop 用本脚本启动的假引擎，
 *      绝不触碰真实 3080）
 *   4. `--supervise` 单实例锁 = 启动器端口 + 1000（4181），第二个守护因锁被占 exit 0
 *   5. `rescue-daemon` 支持 `DSH_RESCUE_PORT` 环境变量（不传 --port 时落到 3182）
 *   6. `dsh-boot` 退出码语义：0 就绪 / 1 端口被非 dsh 占用 / 2 repair-only 修复不完整
 *   7. `--status` 退出码与端口展示；`--install-autostart` 生成的 vbs 包装里带自定义端口
 *   8. **隔离红线自检**：
 *      · 临时 DSH_HOME 下的 scripts 被生成（dsh-launcher.cmd / dsh-launcher-start.ps1）
 *      · 真实 `~/.dsh/scripts/dsh-launcher*.{cmd,ps1}` 跑前跑后逐字节不变
 *      · 真实 3080/3081 端口占用者 pid 全程不变
 *      · 自启注册表只写测试专用键（HKCU\Software\DSHPluginManagerTest\Run-<pid>），跑完删除
 *   9. 清理：只结束本脚本自己启动的进程（pid 文件 + 身份字段校验），端口全部释放，临时目录删除
 *
 * 用法：
 *   node tools/dev/test-extra-ports.mjs
 *   node tools/dev/test-extra-ports.mjs --keep   # 失败时保留临时目录便于取证（默认成功即删）
 *
 * 退出码：0 = 全绿；1 = 有断言失败；2 = 前置条件不满足（端口被占/环境不支持），未做任何改动
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherUrlFrom, lockPortOf, normalizePort } from "../../lib/ports.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OPEN_BOOT = join(ROOT, "bin", "open-boot.mjs");
const DSH_BOOT = join(ROOT, "bin", "dsh-boot.mjs");
const RESCUE_DAEMON = join(ROOT, "bin", "rescue-daemon.mjs");

const ENGINE_PORT = 3180;
const LAUNCHER_PORT = 3181;
const RESCUE_PORT = 3182;
const LOCK_PORT = 4181;
const PROBE_PORTS = [3183, 3184, 3185];
const REAL_PORTS = [3080, 3081, 3082, 4081];

const KEEP = process.argv.includes("--keep");
const WIN = process.platform === "win32";
const TEST_REG_KEY = `HKCU\\Software\\DSHPluginManagerTest\\Run-${process.pid}`;
const REAL_DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");

const checks = [];
const skipped = [];
let failures = 0;
function check(name, cond, detail = "") {
	checks.push(name);
	if (cond) {
		console.log(`OK: ${name}`);
		return true;
	}
	failures++;
	console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
	return false;
}
function skip(name, detail) {
	skipped.push(`${name} — ${detail}`);
	console.warn(`SKIP: ${name} — ${detail}`);
}

// ---------------------------------------------------------------- 基础工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port, timeoutMs = 350) => new Promise((resolveProbe) => {
	const sock = connect({ host: "127.0.0.1", port });
	let settled = false;
	const done = (value) => {
		if (settled) return;
		settled = true;
		try { sock.destroy(); } catch { /* ignore */ }
		resolveProbe(value);
	};
	sock.setTimeout(timeoutMs);
	sock.once("connect", () => done(true));
	sock.once("timeout", () => done(false));
	sock.once("error", () => done(false));
});

async function waitPort(port, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await portOpen(port)) return true;
		await sleep(150);
	}
	return false;
}

async function waitPortClosed(port, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await portOpen(port))) return true;
		await sleep(150);
	}
	return false;
}

function tempLog(name) {
	const dir = join(TEMP_ROOT, "logs");
	mkdirSync(dir, { recursive: true });
	return join(dir, name);
}

/** 短命子进程：stdio 落文件（不依赖管道），返回退出码与输出。 */
function runNode(args, { env = {}, timeoutMs = 120000 } = {}) {
	const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const out = tempLog(`run-${stamp}.out.log`);
	const err = tempLog(`run-${stamp}.err.log`);
	const fdOut = openSync(out, "w");
	const fdErr = openSync(err, "w");
	const result = spawnSync(process.execPath, args, {
		cwd: ROOT, env: childEnv(env), stdio: ["ignore", fdOut, fdErr], windowsHide: true, timeout: timeoutMs
	});
	closeSync(fdOut);
	closeSync(fdErr);
	return {
		code: result.status,
		signal: result.signal,
		error: result.error ? `${result.error.code || ""} ${result.error.message}`.trim() : null,
		stdout: readText(out),
		stderr: readText(err)
	};
}

function readText(path) {
	try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/** 长命子进程：stdio 落文件；返回 child + read()。 */
function spawnNode(args, { env = {}, name = "svc" } = {}) {
	const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const out = tempLog(`${name}-${stamp}.out.log`);
	const err = tempLog(`${name}-${stamp}.err.log`);
	const fdOut = openSync(out, "w");
	const fdErr = openSync(err, "w");
	const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv(env), stdio: ["ignore", fdOut, fdErr], windowsHide: true });
	closeSync(fdOut);
	closeSync(fdErr);
	return { child, out, err, read: () => ({ out: readText(out), err: readText(err) }) };
}

function childEnv(extra = {}) {
	const env = { ...process.env };
	delete env.LAUNCHER_STRICT;
	delete env.DSH_LAUNCHER_IMPORT_ONLY;
	delete env.DSH_PM_REAL_REGISTRY_TESTS;
	return {
		...env,
		DSH_HOME: DSH_HOME,
		DSH_ENGINE_PORT: String(ENGINE_PORT),
		DSH_LAUNCHER_PORT: String(LAUNCHER_PORT),
		DSH_RESCUE_PORT: String(RESCUE_PORT),
		DSH_PM_SCRIPTS_DIR: SCRIPTS_DIR,
		DSH_PM_RUN_KEY: TEST_REG_KEY,
		...extra
	};
}

async function getJson(url, headers = {}) {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* keep null */ }
		return { status: res.status, json, text, error: null, headers: res.headers };
	} catch (error) {
		return { status: null, json: null, text: "", error: `${error?.cause?.code ?? error?.code ?? "fetch-error"} ${error?.message ?? error}`, headers: null };
	}
}

async function getText(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
		return { status: res.status, text: await res.text(), error: null };
	} catch (error) {
		return { status: null, text: "", error: `${error?.cause?.code ?? error?.code ?? "fetch-error"} ${error?.message ?? error}` };
	}
}

async function postJson(url, { body, token, origin } = {}) {
	const headers = { "content-type": "application/json" };
	if (token) headers["x-dsh-pm-token"] = token;
	if (origin) headers.origin = origin;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(60000)
		});
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* keep null */ }
		return { status: res.status, json, text, error: null };
	} catch (error) {
		return { status: null, json: null, text: "", error: `${error?.cause?.code ?? error?.code ?? "fetch-error"} ${error?.message ?? error}` };
	}
}

function tokenFromHtml(html) {
	const m = /<meta name="dsh-pm-token" content="([^"]*)">/.exec(html);
	return m ? m[1] : null;
}

const sha256 = (path) => {
	try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
};

// ---------------------------------------------------------------- 进程归属与清理
/** 只在 Windows 上补一次命令行校验（拿不到命令行时不作为拒绝依据；pid 文件身份字段已校验）。 */
function pidCommandLine(pid) {
	if (!WIN) return null;
	try {
		const out = spawnSync("powershell", ["-NoProfile", "-Command",
			`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`],
			{ encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
		const text = String(out.stdout || "").trim();
		return text === "" ? null : text;
	} catch { return null; }
}

function taskkill(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return { ok: false, detail: "bad pid" };
	const args = WIN ? ["/PID", String(pid), "/F"] : null;
	if (WIN) {
		const out = spawnSync("taskkill", args, { encoding: "utf8", windowsHide: true, timeout: 10000 });
		return { ok: out.status === 0, detail: String(out.stderr || out.stdout || "").trim() };
	}
	try { process.kill(pid, "SIGKILL"); return { ok: true, detail: "" }; }
	catch (error) { return { ok: false, detail: error.message }; }
}

/**
 * 结束一个"我们自己的"进程：只有 pid 存活 + 身份文件字段匹配 + （能拿到时）命令行含标记 才动手。
 * @returns {{ok:boolean, reason:string}}
 */
async function stopOwnedPid(pid, { expectCommand = null } = {}) {
	const target = Number(pid);
	if (!Number.isInteger(target) || target <= 0) return { ok: false, reason: "非法 pid" };
	const alive = isAlive(target);
	if (!alive) return { ok: true, reason: "已不存在" };
	const cmd = pidCommandLine(target);
	if (cmd === null && expectCommand !== null) {
		// 拿不到命令行：保守拒绝（除非目标就是本进程直接 spawn 的子进程，由调用方另行处理）
		return { ok: false, reason: "无法读取命令行，拒绝结束（归属未确认）" };
	}
	if (cmd !== null && expectCommand !== null && !cmd.includes(expectCommand)) {
		return { ok: false, reason: `命令行不含标记 ${expectCommand}：${cmd.slice(0, 160)}` };
	}
	const killed = taskkill(target);
	const gone = await waitGone(target, 8000);
	return { ok: gone, reason: killed.ok ? (gone ? "已结束" : "已发送结束信号但进程仍在") : killed.detail };
}

async function waitGone(pid, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await sleep(200);
	}
	return false;
}

function isAlive(pid) {
	if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
	try { process.kill(Number(pid), 0); return true; }
	catch (error) { return error.code === "EPERM"; }
}

function readPidJson(profile) {
	try { return JSON.parse(readFileSync(join(profile, ".open-boot.pid"), "utf8")); } catch { return null; }
}
function readEnginePidJson(profile) {
	try { return JSON.parse(readFileSync(join(profile, ".rescue-daemon.pid"), "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------- 环境 / 夹具
const TEMP_ROOT = mkdtempSync(join(tmpdir(), "pm-extra-ports-"));
const DSH_HOME = join(TEMP_ROOT, "dsh-home");
const SCRIPTS_DIR = join(DSH_HOME, "scripts");
const LOGS_DIR = join(DSH_HOME, "logs");
const PROFILE_MAIN = join(TEMP_ROOT, "profiles", "web");
const PROFILE_BROKEN = join(TEMP_ROOT, "profiles", "broken");
const PROFILE_BADJSON = join(TEMP_ROOT, "profiles", "badjson");
const PROFILE_BOOT = join(TEMP_ROOT, "profiles", "boot");
const FAKE_CMD = join(TEMP_ROOT, "fake-dsh.cmd");
const FAKE_MJS = join(TEMP_ROOT, "fake-dsh.mjs");

mkdirSync(SCRIPTS_DIR, { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });
for (const dir of [PROFILE_MAIN, PROFILE_BROKEN, PROFILE_BADJSON, PROFILE_BOOT]) mkdirSync(dir, { recursive: true });

function writeProfile(dir, { bundles = [], packageJson = null } = {}) {
	writeFileSync(join(dir, "package.json"), packageJson ?? JSON.stringify({ name: "pm-extra-ports-profile", private: true, dsh: { profile: { bundles } } }, null, 2) + "\n", "utf8");
	writeFileSync(join(dir, "cordis.patch.yml"), "[]\n", "utf8");
}
writeProfile(PROFILE_MAIN, { bundles: [] });
writeProfile(PROFILE_BROKEN, { bundles: ["pm-extra-port-missing-bundle"] });
writeProfile(PROFILE_BADJSON, { bundles: [], packageJson: "{ this is not valid json\n" });
writeProfile(PROFILE_BOOT, { bundles: [] });

// 假引擎：响应 dsh 身份指纹，绝不碰真实 3080
writeFileSync(FAKE_MJS, `import { createServer } from "node:http";
const argv = process.argv.slice(2);
const idx = argv.indexOf("--port");
const port = idx >= 0 ? Number(argv[idx + 1]) : Number(process.env.DSH_ENGINE_PORT || 3080);
const server = createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end("<!doctype html><html><body><div id=\\"__DSH_BOOT__\\">DeepSeek Harness</div><div>dsh fake engine on " + port + "</div></body></html>");
});
server.listen(port, "127.0.0.1", () => console.log("fake dsh web listening on " + port));
`, "utf8");
writeFileSync(FAKE_CMD, `@echo off\r\n"${process.execPath}" "${FAKE_MJS}" %*\r\n`, "utf8");

// 跑前快照：真实 scripts + 真实端口占用者
const REAL_SCRIPTS = [join(REAL_DSH_HOME, "scripts", "dsh-launcher.cmd"), join(REAL_DSH_HOME, "scripts", "dsh-launcher-start.ps1")];
const realScriptSnapshot = REAL_SCRIPTS.map((path) => ({ path, hash: sha256(path), exists: existsSync(path) }));
const realPidSnapshot = new Map();
{
	const probe = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
	if (!probe.error && probe.status === 0) {
		for (const port of [3080, 3081]) {
			const line = String(probe.stdout).split(/\r?\n/).find((l) => new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`, "i").test(l));
			const m = line ? /\sLISTENING\s+(\d+)/i.exec(line) : null;
			realPidSnapshot.set(port, m ? Number(m[1]) : null);
		}
	}
}

let launcherStartedByTest = false;
let superviseChild = null;
let rescueChild = null;
let inProcessBoomServer = null;

function realScriptsUnchanged() {
	return REAL_SCRIPTS.every((path, i) => {
		const snap = realScriptSnapshot[i];
		const now = existsSync(path);
		return snap.exists === now && (snap.exists === false || sha256(path) === snap.hash);
	});
}

// ---------------------------------------------------------------- 主流程
async function main() {
	console.log(`[extra-ports] 临时根目录：${TEMP_ROOT}`);
	console.log(`[extra-ports] 端口：engine ${ENGINE_PORT} / launcher ${LAUNCHER_PORT} / rescue ${RESCUE_PORT} / lock ${LOCK_PORT}`);
	console.log(`[extra-ports] DSH_HOME=${DSH_HOME}（真实 DSH_HOME=${REAL_DSH_HOME}）`);

	// 0) 前置条件：端口必须空闲，且绝不与真实端口重叠
	for (const port of [ENGINE_PORT, LAUNCHER_PORT, RESCUE_PORT, LOCK_PORT, ...PROBE_PORTS]) {
		if (await portOpen(port)) {
			console.error(`ABORT: 端口 ${port} 已被占用，为避免影响其它进程，本测试不做任何改动。`);
			return 2;
		}
	}
	for (const port of REAL_PORTS) {
		if ([ENGINE_PORT, LAUNCHER_PORT, RESCUE_PORT, LOCK_PORT].includes(port)) {
			console.error(`ABORT: 测试端口与真实端口重叠（${port}）`);
			return 2;
		}
	}

	// 0.5) 共享端口推导纯函数自检（lib/ports.mjs —— 全链路的唯一事实来源）
	check(`ports.lockPortOf: ${LAUNCHER_PORT} + 1000 = ${LOCK_PORT}`, lockPortOf(LAUNCHER_PORT) === LOCK_PORT);
	check("ports.lockPortOf: 越界（> 64535）返回 null，不静默夹取", lockPortOf(64536) === null && lockPortOf(65535) === null);
	check("ports.normalizePort: 拒绝非数字 / 0 / 65536", normalizePort("abc") === null && normalizePort(0) === null && normalizePort(65536) === null);
	const byPid = launcherUrlFrom({ pidInfo: { app: "dsh-open-boot", port: LAUNCHER_PORT }, env: {} });
	check("launcherUrlFrom: 优先采用 .open-boot.pid 记录的启动器端口",
		byPid.port === LAUNCHER_PORT && byPid.url === `http://127.0.0.1:${LAUNCHER_PORT}/`);
	check("launcherUrlFrom: 无 pid 文件时读 DSH_LAUNCHER_PORT",
		launcherUrlFrom({ env: { DSH_LAUNCHER_PORT: "3199" } }).port === 3199);
	check("launcherUrlFrom: 都缺失时回退默认 3081", launcherUrlFrom({ env: {} }).port === 3081);
	check("launcherUrlFrom: 坏 pid 身份不被采用（回退环境变量）",
		launcherUrlFrom({ pidInfo: { app: "other", port: 3198 }, env: { DSH_LAUNCHER_PORT: "3199" } }).port === 3199);

	// 1) --ensure 在自定义端口拉起启动器
	const ensure = runNode([OPEN_BOOT, "--ensure", "--profile", PROFILE_MAIN, "--port", String(LAUNCHER_PORT),
		"--dsh", FAKE_CMD, "--wait-ms", "8000", "--no-window"], { timeoutMs: 60000 });
	launcherStartedByTest = true;
	check("open-boot --ensure 在自定义端口拉起启动器（exit 0）", ensure.code === 0,
		`exit=${ensure.code} stderr=${ensure.stderr.replace(/\s+/g, " ").slice(0, 240)}`);

	const launcherUp = await waitPort(LAUNCHER_PORT, 20000);
	check(`启动器在自定义端口 ${LAUNCHER_PORT} 监听`, launcherUp);

	const status = await getJson(`http://127.0.0.1:${LAUNCHER_PORT}/api/status`);
	const st = status.json || {};
	check(`/api/status 身份 = dsh-open-boot`, st.app === "dsh-open-boot", JSON.stringify(st).slice(0, 240));
	check(`/api/status 端口 = ${LAUNCHER_PORT}（不是 3081）`, st.port === LAUNCHER_PORT, `port=${st.port}`);
	check(`/api/status 引擎端口 = ${ENGINE_PORT}（DSH_ENGINE_PORT 生效）`, st.enginePort === ENGINE_PORT, `enginePort=${st.enginePort}`);
	check(`/api/status 上报 profile = 临时 profile`, resolve(String(st.profile || "")) === resolve(PROFILE_MAIN), `profile=${st.profile}`);
	const launcherCmdPath = String(st.dshLauncherCmd || "");
	check("启动器脚本生成在临时 DSH_HOME/scripts（不写真实 ~/.dsh/scripts）",
		launcherCmdPath.toLowerCase().startsWith(SCRIPTS_DIR.toLowerCase()),
		`dshLauncherCmd=${launcherCmdPath}`);
	const tempCmd = join(SCRIPTS_DIR, "dsh-launcher.cmd");
	const tempPs1 = join(SCRIPTS_DIR, "dsh-launcher-start.ps1");
	check("临时 DSH_HOME 下生成了 dsh-launcher.cmd / dsh-launcher-start.ps1",
		existsSync(tempCmd) && existsSync(tempPs1));
	check(`生成的 dsh-launcher.cmd 内嵌自定义启动器端口（set "PORT=${LAUNCHER_PORT}"，且无 3081）`,
		existsSync(tempCmd) && readFileSync(tempCmd, "utf8").includes(`set "PORT=${LAUNCHER_PORT}"`)
		&& readFileSync(tempCmd, "utf8").includes("%PORT%") && !readFileSync(tempCmd, "utf8").includes("3081"));
	check(`生成的 dsh-launcher-start.ps1 内嵌自定义启动器端口（$port = '${LAUNCHER_PORT}'，且无 3081）`,
		existsSync(tempPs1) && readFileSync(tempPs1, "utf8").includes(`$port = '${LAUNCHER_PORT}'`)
		&& !readFileSync(tempPs1, "utf8").includes("3081"));
	check("真实 ~/.dsh/scripts/dsh-launcher*.{cmd,ps1} 跑前跑后逐字节不变", realScriptsUnchanged(),
		REAL_SCRIPTS.map((p) => `${p.split(/[\\/]/).pop()}=${existsSync(p)}`).join(", "));

	// 2) 页面跳转一致性
	const bootPage = await getText(`http://127.0.0.1:${LAUNCHER_PORT}/`);
	check("GET / 启动页可达", bootPage.status === 200 && bootPage.text.includes("DSH 启动器"));
	check("启动页里的引擎链接指向 3180，且无 3080/3081 残留",
		bootPage.text.includes(`:${ENGINE_PORT}/`) && !bootPage.text.includes(":3080") && !bootPage.text.includes(":3081"),
		bootPage.text.includes(":3081") ? "仍含 :3081" : "");
	const pluginsPage = await getText(`http://127.0.0.1:${LAUNCHER_PORT}/plugins`);
	check("GET /plugins 兜底页可达", pluginsPage.status === 200 && pluginsPage.text.includes("引擎与插件管理台"));
	check(`/plugins 页面同时出现启动器端口 ${LAUNCHER_PORT} 与引擎端口 ${ENGINE_PORT}，且无 3080/3081 残留`,
		pluginsPage.text.includes(String(LAUNCHER_PORT)) && pluginsPage.text.includes(`:${ENGINE_PORT}/`)
		&& !pluginsPage.text.includes(":3080") && !pluginsPage.text.includes(":3081"),
		`has3081=${pluginsPage.text.includes(":3081")} has3080=${pluginsPage.text.includes(":3080")}`);
	const rescuePage = await getText(`http://127.0.0.1:${LAUNCHER_PORT}/rescue`);
	check("GET /rescue 救援页可达", rescuePage.status === 200 && rescuePage.text.includes("DSH 独立救援中心"));
	const pageToken = tokenFromHtml(rescuePage.text);
	check("救援页注入一次性令牌", typeof pageToken === "string" && pageToken.length >= 32);
	check(`救援页“唯一网页入口”指向自定义启动器端口 http://127.0.0.1:${LAUNCHER_PORT}/`,
		rescuePage.text.includes(`http://127.0.0.1:${LAUNCHER_PORT}/`) && !rescuePage.text.includes(":3081"));

	// 3) verify / fix / start / stop API 往返（start/stop 只动假引擎）
	const origin = `http://127.0.0.1:${LAUNCHER_PORT}`;
	const verify1 = await getJson(`http://127.0.0.1:${LAUNCHER_PORT}/rescue/api/verify`);
	check("/rescue/api/verify 返回 ok=true 且无问题", verify1.json?.ok === true && Array.isArray(verify1.json?.issues) && verify1.json.issues.length === 0,
		JSON.stringify(verify1.json).slice(0, 200));
	const fixNoToken = await postJson(`http://127.0.0.1:${LAUNCHER_PORT}/rescue/api/fix`, { origin });
	check("/rescue/api/fix 缺令牌 → 401（写接口防护未因端口变化失效）", fixNoToken.status === 401, `status=${fixNoToken.status}`);
	const fix = await postJson(`http://127.0.0.1:${LAUNCHER_PORT}/rescue/api/fix`, { token: pageToken, origin });
	check("/rescue/api/fix 同源+令牌 → ok", fix.json?.ok === true, JSON.stringify(fix.json).slice(0, 200));

	const start = await postJson(`http://127.0.0.1:${LAUNCHER_PORT}/rescue/api/start`, { token: pageToken, origin });
	check(`/rescue/api/start 通过自定义引擎端口 ${ENGINE_PORT} 拉起引擎`, start.json?.ok === true,
		`status=${start.status} ${JSON.stringify(start.json).slice(0, 240)}`);
	const engineUp = await waitPort(ENGINE_PORT, 20000);
	check(`假引擎在 ${ENGINE_PORT} 就绪（HTTP 握手 + 身份指纹）`, engineUp);
	const enginePidInfo = readEnginePidJson(PROFILE_MAIN);
	check("引擎 PID 文件记录 = 本 profile + 自定义端口",
		enginePidInfo?.app === "dsh-web-engine" && enginePidInfo?.port === ENGINE_PORT
		&& resolve(String(enginePidInfo?.cwd || "")) !== "",
		JSON.stringify(enginePidInfo));
	const statusUp = await getJson(`http://127.0.0.1:${LAUNCHER_PORT}/api/status`);
	check("/api/status 在自定义引擎端口上判定 engineUp=true", statusUp.json?.engineUp === true && statusUp.json?.enginePort === ENGINE_PORT,
		JSON.stringify(statusUp.json || {}).slice(0, 240));
	const rescueStatus = await getJson(`http://127.0.0.1:${LAUNCHER_PORT}/rescue/api/status`);
	check("/rescue/api/status（open-boot 挂载）上报正确引擎端口与运行状态",
		rescueStatus.json?.engineUp === true && rescueStatus.json?.enginePort === ENGINE_PORT, JSON.stringify(rescueStatus.json || {}).slice(0, 240));

	const stop = await postJson(`http://127.0.0.1:${LAUNCHER_PORT}/rescue/api/stop`, { token: pageToken, origin, body: {} });
	check("/rescue/api/stop 结束自定义端口上的引擎", stop.json?.ok === true, `status=${stop.status} ${JSON.stringify(stop.json).slice(0, 240)}`);
	check(`引擎端口 ${ENGINE_PORT} 已释放`, await waitPortClosed(ENGINE_PORT, 15000));
	check("引擎 PID 文件已清理", !existsSync(join(PROFILE_MAIN, ".rescue-daemon.pid")));

	// 4) 停止启动器 + --status 退出码
	const stopLauncher = await postJson(`http://127.0.0.1:${LAUNCHER_PORT}/api/launcher/stop`, { token: pageToken, origin });
	check("/api/launcher/stop 优雅停止启动器", stopLauncher.json?.ok === true, JSON.stringify(stopLauncher.json || {}).slice(0, 200));
	check(`启动器端口 ${LAUNCHER_PORT} 已释放`, await waitPortClosed(LAUNCHER_PORT, 15000));
	const statusDown = runNode([OPEN_BOOT, "--status", "--profile", PROFILE_MAIN, "--port", String(LAUNCHER_PORT)], { timeoutMs: 30000 });
	check("--status 在启动器停止后 exit 1（不假健康）", statusDown.code === 1, `exit=${statusDown.code}`);
	check(`--status 输出使用自定义端口 ${LAUNCHER_PORT}/${ENGINE_PORT}/锁端口 ${LOCK_PORT}`,
		statusDown.stdout.includes(`启动器（${LAUNCHER_PORT}）`) && statusDown.stdout.includes(`引擎（${ENGINE_PORT}）`)
		&& statusDown.stdout.includes(`锁端口 ${LOCK_PORT}`), statusDown.stdout.replace(/\s+/g, " ").slice(0, 300));

	// 5) --supervise 单实例锁（启动器端口 + 1000）
	superviseChild = spawnNode([OPEN_BOOT, "--supervise", "--profile", PROFILE_MAIN, "--port", String(LAUNCHER_PORT),
		"--dsh", FAKE_CMD, "--quiet", "--interval", "3600"], { name: "supervise" });
	check(`--supervise 持有锁端口 ${LOCK_PORT}`, await waitPort(LOCK_PORT, 15000));
	check(`--supervise 自动拉起启动器（${LAUNCHER_PORT} 就绪）`, await waitPort(LAUNCHER_PORT, 25000));
	const second = runNode([OPEN_BOOT, "--supervise", "--profile", PROFILE_MAIN, "--port", String(LAUNCHER_PORT),
		"--dsh", FAKE_CMD], { timeoutMs: 30000 });
	check("第二个 --supervise 因锁端口被占 exit 0（单实例）",
		second.code === 0 && second.stdout.includes(`锁端口 ${LOCK_PORT}`), `exit=${second.code} out=${second.stdout.replace(/\s+/g, " ").slice(0, 240)}`);

	// 停掉守护拉起的启动器（优雅），再结束守护本身
	const supStatus = await getJson(`http://127.0.0.1:${LAUNCHER_PORT}/api/status`);
	const supToken = await getText(`http://127.0.0.1:${LAUNCHER_PORT}/rescue`);
	const supPageToken = tokenFromHtml(supToken.text);
	if (supStatus.json?.app === "dsh-open-boot" && supPageToken) {
		await postJson(`http://127.0.0.1:${LAUNCHER_PORT}/api/launcher/stop`, { token: supPageToken, origin });
	}
	await waitPortClosed(LAUNCHER_PORT, 10000);
	const supStop = superviseChild ? await stopOwnedPid(superviseChild.child.pid, { expectCommand: "open-boot.mjs" }) : { ok: true };
	check("测试启动的 --supervise 进程已结束（只结束自己的 pid）", supStop.ok, supStop.reason);
	check(`锁端口 ${LOCK_PORT} 已释放`, await waitPortClosed(LOCK_PORT, 10000));

	// 6) rescue-daemon：DSH_RESCUE_PORT 环境变量 + 页面入口 URL 跟随 DSH_LAUNCHER_PORT
	rescueChild = spawnNode([RESCUE_DAEMON, "--profile", PROFILE_BROKEN], { name: "rescue" });
	const rescueUp = await waitPort(RESCUE_PORT, 15000);
	check(`rescue-daemon 不传 --port 时读取 DSH_RESCUE_PORT=${RESCUE_PORT}`, rescueUp);
	const rescueStatusOwn = await getJson(`http://127.0.0.1:${RESCUE_PORT}/api/status`);
	check("rescue-daemon /api/status 身份 = dsh-rescue-daemon 且端口 = 3182",
		rescueStatusOwn.json?.app === "dsh-rescue-daemon" && rescueStatusOwn.json?.port === RESCUE_PORT,
		JSON.stringify(rescueStatusOwn.json || {}).slice(0, 240));
	const rescuePageOwn = await getText(`http://127.0.0.1:${RESCUE_PORT}/`);
	const rescueToken = tokenFromHtml(rescuePageOwn.text);
	check(`rescue-daemon 自身页面入口 URL 跟随 DSH_LAUNCHER_PORT（${LAUNCHER_PORT}）`,
		rescuePageOwn.text.includes(`http://127.0.0.1:${LAUNCHER_PORT}/`) && !rescuePageOwn.text.includes(":3081"));
	const verifyBroken = await getJson(`http://127.0.0.1:${RESCUE_PORT}/api/verify`);
	check("rescue-daemon /api/verify 发现临时 profile 的坏 bundle（ok=true 表示检查完成，healthy=false）",
		verifyBroken.status === 200 && verifyBroken.json?.ok === true && verifyBroken.json?.healthy === false
		&& (verifyBroken.json?.issues?.length ?? 0) > 0,
		JSON.stringify(verifyBroken.json).slice(0, 240));
	const fixBroken = await postJson(`http://127.0.0.1:${RESCUE_PORT}/api/fix`, { token: rescueToken, origin: `http://127.0.0.1:${RESCUE_PORT}` });
	check("rescue-daemon /api/fix 隔离坏 bundle", fixBroken.json?.ok === true && (fixBroken.json?.quarantined?.length ?? 0) > 0,
		JSON.stringify(fixBroken.json).slice(0, 240));
	const verifyFixed = await getJson(`http://127.0.0.1:${RESCUE_PORT}/api/verify`);
	check("fix 后 /api/verify 无问题（patch 生效）", verifyFixed.json?.ok === true && (verifyFixed.json?.issues?.length ?? 0) === 0,
		JSON.stringify(verifyFixed.json).slice(0, 240));
	const rescueStop = await stopOwnedPid(rescueChild.child.pid, { expectCommand: "rescue-daemon.mjs" });
	check("测试启动的 rescue-daemon 已结束", rescueStop.ok, rescueStop.reason);
	rescueChild = null;
	check(`救援端口 ${RESCUE_PORT} 已释放`, await waitPortClosed(RESCUE_PORT, 10000));

	// 7) dsh-boot 退出码语义
	const healthyRepair = runNode([DSH_BOOT, "--repair-only", "--profile", PROFILE_MAIN], { timeoutMs: 30000 });
	check("dsh-boot --repair-only 健康 profile → exit 0", healthyRepair.code === 0, `exit=${healthyRepair.code}`);
	const brokenJson = runNode([DSH_BOOT, "--repair-only", "--profile", PROFILE_BADJSON], { timeoutMs: 30000 });
	check("dsh-boot --repair-only package.json 不可解析 → exit 2（修复不完整）", brokenJson.code === 2, `exit=${brokenJson.code}`);

	inProcessBoomServer = await new Promise((resolveListen, rejectListen) => {
		const srv = createServer((sock) => sock.destroy());
		srv.once("error", rejectListen);
		srv.listen(PROBE_PORTS[0], "127.0.0.1", () => resolveListen(srv));
	});
	const occupied = runNode([DSH_BOOT, "--profile", PROFILE_BOOT, "--dsh", FAKE_CMD, "--wait-ms", "800"], {
		timeoutMs: 30000, env: { DSH_ENGINE_PORT: String(PROBE_PORTS[0]) }
	});
	check(`dsh-boot 在引擎端口被非 dsh 进程占用（${PROBE_PORTS[0]}）→ exit 1`, occupied.code === 1, `exit=${occupied.code}`);
	await new Promise((r) => inProcessBoomServer.close(r));
	inProcessBoomServer = null;

	const bootStart = runNode([DSH_BOOT, "--profile", PROFILE_BOOT, "--dsh", FAKE_CMD, "--wait-ms", "20000", "--cwd", TEMP_ROOT], {
		timeoutMs: 60000, env: { DSH_ENGINE_PORT: String(PROBE_PORTS[1]) }
	});
	check(`dsh-boot 通过 --dsh 假引擎在 ${PROBE_PORTS[1]} 启动并就绪 → exit 0`, bootStart.code === 0,
		`exit=${bootStart.code} out=${bootStart.stdout.replace(/\s+/g, " ").slice(0, 240)}`);
	const bootEngineUp = await waitPort(PROBE_PORTS[1], 5000);
	check(`dsh-boot 拉起的假引擎确实监听 ${PROBE_PORTS[1]}`, bootEngineUp);
	const bootPidInfo = readEnginePidJson(PROFILE_BOOT);
	const bootStop = bootPidInfo ? await stopOwnedPid(bootPidInfo.pid, { expectCommand: "fake-dsh.mjs" }) : { ok: false, reason: "无 PID 文件" };
	check("dsh-boot 拉起的假引擎已结束（按 PID 文件 + 命令行校验）", bootStop.ok, bootStop.reason);
	check(`假引擎端口 ${PROBE_PORTS[1]} 已释放`, await waitPortClosed(PROBE_PORTS[1], 10000));

	// 8) 自启安装：只写测试专用注册表键 + 临时 profile 里的 vbs（不碰真实 Run / 真实 profile）
	if (WIN) {
		const regProbe = spawnSync("reg", ["query", TEST_REG_KEY], { encoding: "utf8", windowsHide: true, timeout: 8000 });
		const regReadable = !(regProbe.error && (regProbe.error.code === "EPERM" || regProbe.error.code === "EACCES"));
		if (!regReadable) {
			skip("自启安装包装端口校验", "当前会话无法调用 reg.exe（沙箱边界），未写任何注册表");
		} else {
			const installed = runNode([OPEN_BOOT, "--install-autostart", "--profile", PROFILE_MAIN, "--port", String(LAUNCHER_PORT)], { timeoutMs: 60000 });
			const shim = join(PROFILE_MAIN, "open-boot-autostart.vbs");
			const uiShim = join(PROFILE_MAIN, "open-boot-ui.vbs");
			check("--install-autostart 在临时 profile 写包装脚本（exit 0）", installed.code === 0 && existsSync(shim) && existsSync(uiShim),
				`exit=${installed.code} ${installed.stdout.replace(/\s+/g, " ").slice(0, 200)}`);
			check("自启包装 vbs 内嵌自定义启动器端口（--port 3181 与 http://127.0.0.1:3181/）",
				existsSync(shim) && readFileSync(shim, "ascii").includes(`--port ${LAUNCHER_PORT}`)
				&& readFileSync(uiShim, "ascii").includes(`http://127.0.0.1:${LAUNCHER_PORT}/`));
			const regValue = spawnSync("reg", ["query", TEST_REG_KEY, "/v", "DSHWebFront"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
			check("自启项只写入测试专用注册表键（HKCU\\Software\\DSHPluginManagerTest\\Run-<pid>）",
				regValue.status === 0 && String(regValue.stdout || "").includes(shim),
				`status=${regValue.status} out=${String(regValue.stdout || "").replace(/\s+/g, " ").slice(0, 180)}`);
			const autostartStatus = runNode([OPEN_BOOT, "--autostart-status", "--profile", PROFILE_MAIN, "--port", String(LAUNCHER_PORT)], { timeoutMs: 30000 });
			check(`--autostart-status 展示自定义锁端口 ${LOCK_PORT}`, autostartStatus.stdout.includes(`锁端口 ${LOCK_PORT}`),
				autostartStatus.stdout.replace(/\s+/g, " ").slice(0, 240));
			const uninstalled = runNode([OPEN_BOOT, "--uninstall-autostart", "--profile", PROFILE_MAIN, "--port", String(LAUNCHER_PORT)], { timeoutMs: 60000 });
			const regAfter = spawnSync("reg", ["query", TEST_REG_KEY, "/v", "DSHWebFront"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
			check("--uninstall-autostart 删除测试键值与临时 profile 包装脚本",
				uninstalled.code === 0 && regAfter.status !== 0 && !existsSync(shim) && !existsSync(uiShim),
				`exit=${uninstalled.code} regStatus=${regAfter.status}`);
		}
	} else {
		skip("自启安装包装端口校验", "非 Windows 平台");
	}

	// 9) 收尾自检：真实端口未被动过、临时端口全释放
	await sleep(300);
	for (const [port, pidBefore] of realPidSnapshot) {
		const now = await realPortPid(port);
		if (pidBefore === null || now === null) {
			skip(`真实端口 ${port} 占用者未变`, `快照=${pidBefore} 现在=${now}（探测不可用）`);
		} else {
			check(`真实端口 ${port} 占用者 pid 全程未变（${pidBefore}）`, pidBefore === now, `${pidBefore} → ${now}`);
		}
	}
	check("真实 ~/.dsh/scripts 启动器脚本仍未被改写", realScriptsUnchanged(),
		REAL_SCRIPTS.map((p) => `${p.split(/[\\/]/).pop()}=${existsSync(p)}`).join(", "));
	// 先清理，再断言自定义端口全部释放（清理只动本测试自己的进程）
	await cleanup();
	const leaked = [];
	for (const port of [ENGINE_PORT, LAUNCHER_PORT, RESCUE_PORT, LOCK_PORT, ...PROBE_PORTS]) {
		if (await portOpen(port)) leaked.push(port);
	}
	check("测试结束时自定义端口全部释放（无残留监听）", leaked.length === 0, `仍占用：${leaked.join(", ")}`);
}

async function realPortPid(port) {
	const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
	if (out.error || out.status !== 0) return null;
	const line = String(out.stdout || "").split(/\r?\n/).find((l) => new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`, "i").test(l));
	const m = line ? /\sLISTENING\s+(\d+)/i.exec(line) : null;
	return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- 清理（只收自己的进程）
async function cleanup() {
	console.log("\n[cleanup] 收尾（只结束本测试启动的进程，其他进程一律不动）…");
	// 1) 先尝试优雅停止还在跑的启动器（有 pid 文件 + 身份才动）
	for (const profile of [PROFILE_MAIN, PROFILE_BOOT]) {
		const info = readPidJson(profile);
		if (!info || info.app !== "dsh-open-boot" || info.port !== LAUNCHER_PORT || resolve(String(info.profile || "")) !== resolve(profile)) continue;
		if (!(await portOpen(LAUNCHER_PORT))) continue;
		const page = await getText(`http://127.0.0.1:${LAUNCHER_PORT}/rescue`);
		const token = tokenFromHtml(page.text);
		if (token) await postJson(`http://127.0.0.1:${LAUNCHER_PORT}/api/launcher/stop`, { token, origin: `http://127.0.0.1:${LAUNCHER_PORT}` });
		await waitPortClosed(LAUNCHER_PORT, 8000);
		if (await portOpen(LAUNCHER_PORT)) await stopOwnedPid(info.pid, { expectCommand: "open-boot.mjs" });
	}
	// 2) 守护：本测试直接 spawn 的子进程
	if (superviseChild && superviseChild.child.pid) {
		const pid = superviseChild.child.pid;
		try { superviseChild.child.kill(); } catch { /* ignore */ }
		if (!(await waitGone(pid, 4000))) await stopOwnedPid(pid, { expectCommand: "open-boot.mjs" });
		superviseChild = null;
	}
	// 3) 救援守护：本测试直接 spawn 的子进程
	if (rescueChild && rescueChild.child.pid) {
		const pid = rescueChild.child.pid;
		try { rescueChild.child.kill(); } catch { /* ignore */ }
		if (!(await waitGone(pid, 4000))) await stopOwnedPid(pid, { expectCommand: "rescue-daemon.mjs" });
		rescueChild = null;
	}
	// 4) 假引擎：按 PID 文件 + 身份字段 + 命令行校验
	for (const profile of [PROFILE_MAIN, PROFILE_BOOT, PROFILE_BROKEN]) {
		const info = readEnginePidJson(profile);
		if (!info || info.app !== "dsh-web-engine" || !Number.isInteger(info.pid)) continue;
		if (!isAlive(info.pid)) {
			// PID 文件是死指针（引擎已按 PID 文件校验正常结束）→ 删掉线索文件
			try { unlinkSync(join(profile, ".rescue-daemon.pid")); } catch { /* ignore */ }
			continue;
		}
		const cmd = pidCommandLine(info.pid);
		if (cmd === null || !cmd.toLowerCase().includes(TEMP_ROOT.toLowerCase())) {
			console.warn(`[cleanup] 跳过引擎 pid ${info.pid}：命令行无法确认属于本测试（归属未确认）`);
			continue;
		}
		await stopOwnedPid(info.pid, { expectCommand: "fake-dsh.mjs" });
	}
	// 5) 仍在监听的自定义端口：只按占用者命令行含临时目录才结束
	for (const port of [ENGINE_PORT, LAUNCHER_PORT, RESCUE_PORT]) {
		if (!(await portOpen(port))) continue;
		const pid = await realPortPid(port);
		if (!pid) continue;
		const cmd = pidCommandLine(pid);
		if (cmd !== null && cmd.includes(TEMP_ROOT)) {
			console.warn(`[cleanup] 端口 ${port} 仍被 pid ${pid} 占用（命令行属于本测试）→ 结束`);
			await stopOwnedPid(pid, { expectCommand: null });
		} else {
			console.warn(`[cleanup] 端口 ${port} 被 pid ${pid} 占用，但命令行不属于本测试 → 保留不动`);
		}
	}
	// 6) 进程内监听器
	if (inProcessBoomServer) {
		try { await new Promise((r) => inProcessBoomServer.close(r)); } catch { /* ignore */ }
		inProcessBoomServer = null;
	}
	// 7) 测试专用注册表键（只删本 pid 的测试键，绝不碰真实 Run）
	if (WIN) {
		spawnSync("reg", ["delete", TEST_REG_KEY, "/f"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
	}
	// 8) 端口释放复核
	const leaked = [];
	for (const port of [ENGINE_PORT, LAUNCHER_PORT, RESCUE_PORT, LOCK_PORT, ...PROBE_PORTS]) {
		if (await portOpen(port)) leaked.push(port);
	}
	if (leaked.length > 0) console.warn(`[cleanup] ⚠ 端口仍被占用：${leaked.join(", ")}`);
	else console.log("[cleanup] 自定义端口全部释放");
}

// ---------------------------------------------------------------- 入口
let exitCode = 0;
try {
	exitCode = await main();
} catch (error) {
	console.error("UNEXPECTED:", error && error.stack ? error.stack : error);
	exitCode = 1;
} finally {
	await cleanup().catch((error) => console.error("[cleanup] 异常:", error?.message ?? error));
}

const anyFailures = failures + (exitCode === 1 ? 1 : 0);
console.log(`\n[result] checks=${checks.length} failed=${failures} skipped=${skipped.length}`);
if (skipped.length > 0) for (const item of skipped) console.log(`  SKIP: ${item}`);
if (anyFailures > 0 || exitCode === 2) {
	console.log(`[result] FAIL（临时目录保留：${TEMP_ROOT}）`);
	process.exit(exitCode === 2 ? 2 : 1);
}
console.log("[result] PASS");
if (KEEP) console.log(`[keep] 临时目录：${TEMP_ROOT}`);
else {
	try { rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch (error) { console.warn(`[cleanup] 删除临时目录失败：${error.message}`); }
}
process.exit(0);
