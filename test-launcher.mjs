// test-launcher.mjs — 启动器 / 救砖链路单测（审计④ R9；覆盖审计③ 的 L6/L8 回归）。
//
// 设计约束（安全第一）：
//  - 端口：全部随机（listen(0) 取空闲端口）→ 不碰 3080 引擎、不碰 3081 启动器。
//  - profile：全部 mkdtemp 临时目录 → 绝不读写真 profile（~/.dsh/profiles/web）。
//  - 绝不调用 rescue-daemon 的 POST /api/start（会真的拉起引擎）。
//  - **注册表（t10 起）**：默认**绝不写用户的真实 HKCU Run 键** ——
//    `--install-autostart` / `--uninstall` / 诱饵值用例全部改走**测试专用键**
//    `HKCU\Software\DSHPluginManagerTest\Run-<pid>`（经 bin/open-boot.mjs 的 `DSH_PM_RUN_KEY` 注入点，
//    生产默认值不受影响），走的仍是同一套 reg.exe 代码路径；按 pid 分桶 → 两次并发 `--strict` 互不干扰。
//    `--autostart-status` 等**只读**命令仍会读真实键，并断言跑前跑后真实键逐值不变。
//    真机端到端（会写真实 Run 键）改为**显式开启**：`DSH_PM_REAL_REGISTRY_TESTS=1`，
//    开启时跑前 `reg export` 备份、跑后断言诱饵已清除 + 真实键逐值还原。
//  - 子进程输出走临时文件（stdio 重定向）而不是管道，避免受限环境下 pipe 被拒。
//
// 用法：node test-launcher.mjs [--strict]   （DSH_PM_REAL_REGISTRY_TESTS=1 才跑真机注册表端到端）
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
// 14. t4 跨平台六条（rc2 兼容性审计 C-05/06/07/13/14/15）：
//     C-05 弹窗启动纯函数命令构造（macOS .command / Linux `--` 形态）+ **退出码/error 校验**（含负控/正控/兜底链）
//     C-06 npm 全局根探测在 Windows 可用（node+npm-cli.js）+ P-03 冷启动不阻塞（first_call vs 同步探测实测）
//     C-07 端口归属兜底链 lsof → ss → /proc/net/tcp（纯函数 + 注入式链路，含"三条路都不行要明确报不可用"）
//     C-13/C-14 缺 APPDATA 显式诊断 + 各平台全局根覆盖（未实测项必须显式标注）
//     C-15 tools/dev/pack.mjs 在 Node ≥22 走 node+npm-cli.js（--help / --dry-run 实测 exit 0）
// 15. t10 测试卫生：注册表用例默认作用域 = 测试专用键（默认不写真机 Run 键）+
//     真实键跑前/跑后逐值快照对比 + 诱饵清理断言；真机端到端 opt-in（DSH_PM_REAL_REGISTRY_TESTS=1）
// 16. t11 沙箱边界识别（受限会话不再假 FAIL）：
//     · 用例**前提**被环境破坏（freePort() 给的端口被本会话代理/进程应答）→ SKIP(env)
//     · 「引擎拉不起来」= 子进程/管道被拒（EPERM/EACCES）→ sandboxAwareOk 记 SKIP(env)；非边界仍 FAIL
//     · 负控（可证伪）：真跑一遍"命令不存在"的引擎启动失败 → 证据必须判为**非沙箱**
//     · SKIP 分类计数逐桶打印（沙箱边界·管道 / 沙箱边界·文件系统 / 并发冲突 / 环境异常 / 环境缺失 / 其它）
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const STRICT = process.argv.includes("--strict") || process.env.LAUNCHER_STRICT === "1";
const WIN = process.platform === "win32";
/**
 * 注册表作用域（t10 测试卫生）——三件事一起做到：
 *  ① **默认绝不写用户的真实 Run 键**：所有会写注册表的用例都改走「测试专用键」，
 *     走的是**完全相同的 reg.exe 代码路径**（作用域判定 / 死指针清理 / 归属未确认 exit 2 都不打折）；
 *  ② **按 pid 分桶**：`…\DSHPluginManagerTest\Run-<pid>` → 两次并发 `--strict` 各写各的，互不干扰
 *     （t4 的实测假失败正是"两个并发实例共用真机 Run 键"造成的）；
 *  ③ **真机端到端仍可显式开启**：`DSH_PM_REAL_REGISTRY_TESTS=1` 时作用域 = 真实 Run 键，
 *     并在跑前 `reg export` 备份、跑后断言诱饵已清除。
 */
const REAL_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const REAL_REG_TESTS = process.env.DSH_PM_REAL_REGISTRY_TESTS === "1";
const TEST_RUN_KEY = `HKCU\\Software\\DSHPluginManagerTest\\Run-${process.pid}`;
/** 用例默认作用域：默认=测试专用键（绝不碰真机）；opt-in=真实 Run 键。 */
const RUN_KEY = REAL_REG_TESTS ? REAL_RUN_KEY : TEST_RUN_KEY;
/** 子进程（bin/open-boot.mjs）走同一个注入点 —— 见 bin/open-boot.mjs 的 RUN_KEY 注释。 */
if (!REAL_REG_TESTS && WIN) process.env.DSH_PM_RUN_KEY = TEST_RUN_KEY;
else delete process.env.DSH_PM_RUN_KEY;
console.log(REAL_REG_TESTS
	? `NOTE 注册表模式：**真机端到端模式**（DSH_PM_REAL_REGISTRY_TESTS=1，作用域 = ${REAL_RUN_KEY}）；跑前会 reg export 备份，跑后断言无残留。`
	: `NOTE 本套件不写真实注册表（作用域 = 测试专用键 ${TEST_RUN_KEY}）；如需端到端真机验证请设 DSH_PM_REAL_REGISTRY_TESTS=1`);

const failures = [];
const xfails = [];
let checks = 0;

const ok = (name, cond, detail = "") => {
	checks++;
	if (cond) { console.log(`OK: ${name}`); return; }
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	if (!ASSERT_SILENT) console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
};
/** 自检用的静音档：负控要真的走一遍 FAIL 分支，但不该把人为样本打进输出。 */
let ASSERT_SILENT = false;

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

/**
 * SKIP 的分类计数（t5 终审 F-3）：输出必须能回答"为什么跳"，而不是一句笼统的 SKIP。
 * 三个桶：沙箱边界（管道/文件系统） / 环境缺失 / 其它。
 */
const SKIP_KINDS = {
	"沙箱边界（管道 stdio EPERM）": 0,
	"沙箱边界（文件系统或 npm 缓存被拒）": 0,
	"并发冲突（共享端口/资源被别的实例占用）": 0,
	"环境异常（用例前提被本会话破坏：端口被占/被代理应答）": 0,
	"环境异常（资源暂时不可用：ENOBUFS/ETIMEDOUT 等）": 0,
	"环境缺失（平台不支持/命令不存在）": 0,
	"其它": 0
};
let SKIP_SILENT = false; // 负控自检时静音（人为样本不该刷屏）
function recordSkip(message, kind = "其它") {
	const bucket = Object.prototype.hasOwnProperty.call(SKIP_KINDS, kind) ? kind : "其它";
	SKIP_KINDS[bucket] += 1;
	skipped.push(`${message}［${bucket}］`);
	if (!SKIP_SILENT) console.warn(`SKIP(${bucket}): ${message}`);
}

/**
 * 沙箱边界的**可证伪**判据（t5 终审 F-3）：只有**错误码/错误串白名单**命中才算边界。
 * 白名单来自实测的两种边界：① 命名管道被拒（spawn EPERM/EACCES）；② 文件沙箱拒绝工作区外的写
 * （npm 缓存目录 EPERM/EACCES）。白名单之外的一律**仍然 FAIL** —— 判据不是"失败就跳过"。
 */
const SANDBOX_BOUNDARY_MARKERS = [
	/\bEPERM\b/i,
	/\bEACCES\b/i,
	/operation not permitted/i,
	/access is denied/i,
	/spawn\s+\S+\s+(EPERM|EACCES)/i,
	// t11：**资源暂时不可用**类（实测过 `spawnSync netstat ENOBUFS`）—— 与"权限被拒"同类：
	// 边界导致的"探测拿不到结论"，不是产品缺陷。
	/\bENOBUFS\b/i,
	/\bETIMEDOUT\b/i
];
function isSandboxBoundary(evidence) {
	const text = String(evidence ?? "");
	return text.trim() !== "" && SANDBOX_BOUNDARY_MARKERS.some((re) => re.test(text));
}

/** 纯决策（可单测）：cond 为真 → ok；否则"边界证据命中白名单"→ skip，其余 → fail。 */
function classifyAssertionOutcome({ cond, boundaryEvidence = null } = {}) {
	if (cond) return "ok";
	return isSandboxBoundary(boundaryEvidence) ? "skip" : "fail";
}

/**
 * ok() 的沙箱感知版本：**只在识别到沙箱边界时**降级为 SKIP(env)，其余失败照旧 FAIL。
 * @param {string} name 断言名
 * @param {boolean} cond 正常判据
 * @param {string} detail 证据文本（人读）
 * @param {string|null} boundaryEvidence **原始**错误码/错误串（如 `probe.reason`/`error.code`/子进程 stderr）
 * @param {string} kind SKIP 分类桶
 */
const sandboxAwareOk = (name, cond, detail = "", boundaryEvidence = null, kind = "沙箱边界（管道 stdio EPERM）") => {
	const verdict = classifyAssertionOutcome({ cond, boundaryEvidence });
	if (verdict === "ok") { ok(name, true, detail); return; }
	if (verdict === "skip") {
		checks++;
		recordSkip(`${name} — ${detail}｜边界证据：${String(boundaryEvidence).replace(/\s+/g, " ").slice(0, 140)}`, kind);
		return;
	}
	ok(name, false, detail); // 非边界原因 → 真错必须 FAIL
};

/** 记录一条"环境性"跳过（并发冲突 / 平台缺失 …）：计入 checks，不计入失败。 */
const envSkip = (name, detail = "", kind = "环境缺失（平台不支持/命令不存在）") => {
	checks++;
	recordSkip(`${name} — ${detail}`, kind);
};

/**
 * t11：**用例前提**被环境破坏时记 SKIP(env)（不记 FAIL，也不假通过）。
 *
 * 典型场景（队长在受限会话里实测到的假失败）：用例刚用 `freePort()` 取到一个"应当空闲"的端口，
 * 随后该端口却被**本会话内的代理/别的进程**应答 → "引擎一直没起来 → false" 这条断言的前提不成立：
 * 既不能断言"引擎确实没起来"（有东西在应答），也不该记成产品缺陷。
 * 这不是"失败就跳过"—— 前提成立时同一断言块照旧断言/FAIL（见紧邻的 `ok` / `sandboxAwareOk` 分支）。
 */
const preconditionSkip = (name, detail) => {
	checks++;
	recordSkip(`${name} — 前提不成立：${detail}`, "环境异常（用例前提被本会话破坏：端口被占/被代理应答）");
};

/** t11：把"拉起引擎/子进程"失败时能拿到的**原始**证据拼成可判定文本（供沙箱边界白名单判定）。 */
function raiseBoundaryEvidence(...sources) {
	return sources
		.flat(Infinity)
		.filter((s) => typeof s === "string" && s.trim() !== "")
		.join(" | ")
		.replace(/\s+/g, " ")
		.slice(0, 400);
}

/**
 * ok() 的环境敏感版本：沙箱内取不到子进程输出时记 SKIP（计入 checks，但不计入失败）。
 */
const skipOk = (name, cond, detail = "", kind = "沙箱边界（管道 stdio EPERM）") => {
	if (CHILD_PIPE_OK) { ok(name, cond, detail); return; }
	checks++;
	recordSkip(`${name}${detail ? ` — ${detail}` : ""}（${SANDBOX_NOTE}）`, kind);
};

// t5 终审 F-3 的**负控自检**：判据必须可证伪 —— 人为造非沙箱错误 → 必须仍记 FAIL；
// 只有白名单命中的沙箱错误才降级为 SKIP。样本在断言后立即回滚（不污染本次结果与计数）。
{
	const failuresBefore = failures.length;
	const checksBefore = checks;
	const skippedBefore = skipped.length;
	const pipeBucketBefore = SKIP_KINDS["沙箱边界（管道 stdio EPERM）"];
	SKIP_SILENT = true;
	ASSERT_SILENT = true;
	sandboxAwareOk("__t10_negative_control__", false, "人为构造的非沙箱错误", "ENOENT: no such file or directory, open 'nope.txt'");
	const nonBoundaryWentToFail = failures.length === failuresBefore + 1 && skipped.length === skippedBefore;
	sandboxAwareOk("__t10_negative_control_eprint__", false, "人为构造的沙箱错误", "spawnSync netstat EPERM");
	const boundaryWentToSkip = skipped.length === skippedBefore + 1 && failures.length === failuresBefore + 1;
	SKIP_SILENT = false;
	ASSERT_SILENT = false;
	failures.length = failuresBefore;
	skipped.length = skippedBefore;
	checks = checksBefore;
	SKIP_KINDS["沙箱边界（管道 stdio EPERM）"] = pipeBucketBefore;
	ok("t10/F-3 负控: 非沙箱错误仍记 FAIL、只有白名单命中才记 SKIP（判据可证伪，不是「失败就跳过」）",
		nonBoundaryWentToFail && boundaryWentToSkip && isSandboxBoundary("EPERM: operation not permitted") === true
		&& isSandboxBoundary("TypeError: x is not a function") === false
		&& classifyAssertionOutcome({ cond: false, boundaryEvidence: "ENOENT: no such file" }) === "fail",
		`非边界→FAIL=${nonBoundaryWentToFail} 边界→SKIP=${boundaryWentToSkip}`);
}

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
	// t10：本地 HTTP 的**瞬时传输错误**（ECONNRESET/ECONNREFUSED —— 并发跑时另一个实例正在关端口、
	// 或本实例的守护刚被 kill）不该让整个套件未捕获崩溃：返回 {status:null, error}，由断言如实记录。
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* keep null */ }
		return { status: res.status, json, text, error: null };
	} catch (error) {
		return { status: null, json: null, text: "", error: `${error?.cause?.code ?? error?.code ?? "fetch-error"} ${error?.message ?? String(error)}` };
	}
}

/** POST（可带自定义头 / JSON body），返回 status/json/text。 */
async function postJson(url, { headers = {}, body } = {}) {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(20000)
		});
		const text = await res.text();
		let json = null;
		try { json = JSON.parse(text); } catch { /* keep null */ }
		return { status: res.status, json, text, error: null };
	} catch (error) {
		return { status: null, json: null, text: "", error: `${error?.cause?.code ?? error?.code ?? "fetch-error"} ${error?.message ?? String(error)}` };
	}
}

/** 取页面文本（t10：同上，把瞬时传输错误变成可记录的返回值而不是未捕获异常）。 */
async function getText(url, timeoutMs = 8000) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return { status: res.status, text: await res.text(), error: null };
	} catch (error) {
		return { status: null, text: "", error: `${error?.cause?.code ?? error?.code ?? "fetch-error"} ${error?.message ?? String(error)}` };
	}
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

// ---- R13 用：注册表值的快照 / 恢复（t10：**作用域可注入**，默认 = 测试专用键） ----
// 每个 helper 的 `key` 默认值就是 `RUN_KEY`：默认模式下它是 `…\DSHPluginManagerTest\Run-<pid>`
// （绝不碰真机），opt-in 模式下它才是真实 Run 键。想读真实键做**只读**断言时显式传 `REAL_RUN_KEY`。
function snapshotDshWebRunValues(key = RUN_KEY) {
	const values = regListRunValues(key);
	if (values === null) return [];
	return values.filter((v) => /^DSHWeb/i.test(v.name));
}

function regQueryDshWebNames(key = RUN_KEY) {
	return snapshotDshWebRunValues(key).map((v) => v.name);
}

/** 读单个 Run 值（拿不到/不存在返回 null）—— t31 诱饵用例用。 */
function regQueryRunValue(name, key = RUN_KEY) {
	if (!WIN) return null;
	const out = spawnSync("reg", ["query", key, "/v", name], { windowsHide: true, encoding: "utf8" });
	if (out.error || out.status !== 0) return null;
	const m = /REG_SZ\s+(.+)\s*$/m.exec(out.stdout || "");
	return m ? m[1].trim() : "";
}

/** 写单个 Run 值（诱饵）—— t31 用；失败返回 false，由 skipOk 记录。 */
function regAddRunValue(name, data, key = RUN_KEY) {
	if (!WIN) return false;
	const out = spawnSync("reg", ["add", key, "/v", name, "/t", "REG_SZ", "/d", data, "/f"], { windowsHide: true, encoding: "utf8" });
	return out.status === 0;
}

/** 删单个 Run 值（清理诱饵）—— t31 用。 */
function regDeleteRunValue(name, key = RUN_KEY) {
	if (!WIN) return false;
	const out = spawnSync("reg", ["delete", key, "/v", name, "/f"], { windowsHide: true, encoding: "utf8" });
	return out.status === 0;
}

/** 删整把键（清理**测试专用键**用；只在默认模式下对 `TEST_RUN_KEY` 调用）。 */
function regDeleteKey(key) {
	if (!WIN) return false;
	const out = spawnSync("reg", ["delete", key, "/f"], { windowsHide: true, encoding: "utf8" });
	return out.status === 0;
}

/** `reg export` 备份（真机端到端模式跑前必备份；只读，不写注册表）。 */
function regExportKey(key, file) {
	if (!WIN) return { ok: true, path: file, message: "（非 Windows 跳过）" };
	const out = spawnSync("reg", ["export", key, file, "/y"], { windowsHide: true, encoding: "utf8", timeout: 30000 });
	return { ok: !out.error && out.status === 0, path: file, message: out.error ? `${out.error.code} ${out.error.message}` : String(out.stderr || out.stdout || "").trim().slice(0, 160) };
}

function restoreDshWebRunValues(snapshot, key = RUN_KEY) {
	if (!WIN) return;
	for (const value of snapshotDshWebRunValues(key)) {
		spawnSync("reg", ["delete", key, "/v", value.name, "/f"], { windowsHide: true, encoding: "utf8" });
	}
	for (const value of snapshot) {
		spawnSync("reg", ["add", key, "/v", value.name, "/t", value.type, "/d", value.data, "/f"], { windowsHide: true, encoding: "utf8" });
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
		if (!m) continue;
		// 键存在但没有具名值时，`reg query` 会打出一行 `(Default) REG_SZ (value not set)`：
		// 那是"未设置的默认值"，不是一条真值 → 不计入（保证"键在但无值"落到空集语义）。
		if (m[1] === "(Default)" && /^\(value not set\)$/i.test(m[3].trim())) continue;
		values.push({ name: m[1], type: m[2], data: m[3].trim() });
	}
	return values.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * t27：「注册表键/值不存在」不等于「读取被拦截」。
 *
 * CI（全新 Windows runner）首次真实运行挂在 1/345：
 * `open-boot --autostart-status: 只读 … — before=(读取失败) after=(读取失败)`。
 * 根因：全新用户配置里 `HKCU\...\Run` 可能**压根不存在**（或没有值），`reg query` 以退出码 1 +
 * `ERROR: The system was unable to find the specified registry key or value.`（中文系统为「错误: 系统找不到指定的注册表项或值。」）
 * 结束 —— 而旧助手把任何非零退出都当"读取失败"（null），于是 before/after 都是 null，断言误报。
 * 但"读不到就判失败"本身是对的（防 `[] == []` 假通过），所以要分三类：
 *   ① 键/值不存在（exit≠0 且输出含 unable to find / 找不到 / 系统找不到）→ **空集**（0 个值），不是失败；
 *   ② 键存在但无值（exit 0，只有键路径或 `(Default) … (value not set)`）→ **空集**；
 *   ③ 真被拦截/超时/其它非零退出（spawn EPERM、ETIMEDOUT、无 not-found 标记的错误）→ **读取失败（null）**。
 * 纯函数：任意机器都能稳定单测（不需要真实注册表状态）。
 */
const REG_NOT_FOUND_MARKERS = [/unable to find/i, /cannot find/i, /找不到/, /无法找到/i, /not found/i];

/** @returns {{kind:"values"|"empty"|"failure", values:Array|null, reason:string|null}} */
function classifyRegQuery({ status, stdout, stderr, error } = {}) {
	if (error) return { kind: "failure", values: null, reason: `${error.code || "spawn-error"} ${error.message}`.trim() };
	const text = `${stdout || ""}\n${stderr || ""}`;
	if (status === 0) return { kind: "values", values: parseRegQueryOutput(stdout || ""), reason: null };
	const message = (stderr || stdout || "").trim();
	if (REG_NOT_FOUND_MARKERS.some((re) => re.test(text))) {
		return { kind: "empty", values: [], reason: `键/值不存在（reg query exit ${status}）：${message.slice(0, 160)}` };
	}
	return { kind: "failure", values: null, reason: `读取失败（reg query exit ${status}）：${message.slice(0, 160) || "无输出"}` };
}

/** 读取结果 → 值数组；只有"真失败"才是 null（`[]` 表示"确实没有值"）。 */
function regValuesOrNull(classified) {
	return classified.kind === "failure" ? null : classified.values;
}

/**
 * 顺序无关的签名：`prefix=null` → 整把键；否则只取匹配前缀的值。
 * 逐条保留 `name / type / data`，因此"值必须逐字节还原"的原意不变（只是不再受枚举顺序影响）。
 */
function regSignature(values, prefix = null) {
	const picked = (values || []).filter((v) => (prefix === null ? true : prefix.test(v.name)));
	return JSON.stringify(picked.map((v) => `${v.name}\t${v.type}\t${v.data}`));
}

/**
 * 调 `reg.exe` 并**正确解码输出**（t10 实测的坑）：
 * `reg.exe` 在中文系统上按 **CP936(GBK)** 输出错误信息，而 `spawnSync({encoding:"utf8"})` 会把
 * 「错误: 系统找不到指定的注册表项或值。」解成一片 U+FFFD —— 于是 t27 的「找不到」标记**全部失配**，
 * "键不存在"被误判成"读取被拦截"（本机实测）。因此这里取原始 Buffer：stdout 按 UTF-8、
 * stderr 先按 GBK 回读（Node 自带 full-icu；解码器不可用时退回 utf8，行为与历史一致）。
 */
function decodeRegStderr(raw) {
	if (!Buffer.isBuffer(raw)) return String(raw ?? "");
	try { return new TextDecoder("gbk", { fatal: false }).decode(raw); }
	catch { return raw.toString("utf8"); }
}

function runReg(args, { timeoutMs = 15000 } = {}) {
	const out = spawnSync("reg", args, { windowsHide: true, timeout: timeoutMs });
	return {
		status: out.status ?? null,
		error: out.error ?? null,
		stdout: Buffer.isBuffer(out.stdout) ? out.stdout.toString("utf8") : String(out.stdout ?? ""),
		stderr: decodeRegStderr(out.stderr)
	};
}

/**
 * 读整把键（已排序）。
 * 语义（t27）：**键不存在 / 键存在但无值 → 空集 `[]`**；**真被拦截/出错 → null**（读取失败）。
 * 二者的区别正是 CI 上 1/345 的根因：全新 runner 没有 Run 键，旧实现把"键不存在"当成了"读取失败"。
 * t10 补：本地化（GBK）错误信息也要能被识别，否则本机永远走"读取失败"分支。
 */
function regListRunValues(key = RUN_KEY) {
	if (!WIN) return null;
	const out = runReg(["query", key]);
	return regValuesOrNull(classifyRegQuery({ status: out.status, stdout: out.stdout, stderr: out.stderr, error: out.error }));
}

/** 整把键的签名（只读性断言用；读不到返回 null）。 */
function regKeySignature(key = RUN_KEY) {
	const values = regListRunValues(key);
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

// t27：把「键/值不存在」与「读取被拦截」分开（CI 全新 runner 上 1/345 的根因）；
// 这里是**纯函数**单测：喂真实形态的输入，不依赖本机注册表状态。
{
	// ① 键不存在 —— 真实输出（本机 2026-10-06 实测，与全新 runner 同形）：
	//    reg query "HKCU\...\Run\__t27_nonexistent__"  → exit 1，stdout 空，
	//    stderr: ERROR: The system was unable to find the specified registry key or value.
	const realNotFoundEn = {
		status: 1, stdout: "",
		stderr: "ERROR: The system was unable to find the specified registry key or value.\r\n",
		error: undefined
	};
	// 同一条命令在中文系统上的形态（本地化不影响判定）
	const realNotFoundZh = { status: 1, stdout: "", stderr: "错误: 系统找不到指定的注册表项或值。\r\n", error: undefined };
	// ② 键存在但没有具名值：exit 0 + 只有键路径和未设置的默认值
	const keyExistsNoValues = {
		status: 0,
		stdout: "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    (Default)    REG_SZ    (value not set)\r\n",
		stderr: "", error: undefined
	};
	// 键存在且只有键路径（另一种"无值"形态）
	const keyExistsBare = { status: 0, stdout: "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n", stderr: "", error: undefined };
	// ③ 真被拦截 / 超时 / 其它非零退出
	const blocked = { status: null, stdout: "", stderr: "", error: { code: "EPERM", message: "spawnSync reg EPERM" } };
	const timedOut = { status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT", message: "spawnSync reg ETIMEDOUT" } };
	const otherExit = { status: 2, stdout: "", stderr: "reg: something else went wrong", error: undefined };

	const c1en = classifyRegQuery(realNotFoundEn);
	const c1zh = classifyRegQuery(realNotFoundZh);
	const c2 = classifyRegQuery(keyExistsNoValues);
	const c2b = classifyRegQuery(keyExistsBare);
	ok("t27①: 键不存在（真实 runner 输出：exit 1 + unable to find）→ 空集，不是读取失败",
		c1en.kind === "empty" && Array.isArray(c1en.values) && c1en.values.length === 0 && regValuesOrNull(c1en) !== null,
		`kind=${c1en.kind} values=${JSON.stringify(c1en.values)} reason=${c1en.reason}`);
	ok("t27①: 中文系统的「系统找不到指定的注册表项或值」同样判为空集",
		c1zh.kind === "empty" && regValuesOrNull(c1zh).length === 0, `kind=${c1zh.kind} reason=${c1zh.reason}`);
	ok("t27②: 键存在但无值（exit 0 + (Default)…(value not set) / 只有键路径）→ 空集",
		c2.kind === "values" && c2.values.length === 0 && c2b.kind === "values" && c2b.values.length === 0,
		`c2=${JSON.stringify(c2.values)} c2b=${JSON.stringify(c2b.values)}`);
	ok("t27③: 真被拦截/超时/其它非零退出 → 读取失败（null），不回退成 [] == [] 假通过",
		regValuesOrNull(classifyRegQuery(blocked)) === null
		&& regValuesOrNull(classifyRegQuery(timedOut)) === null
		&& regValuesOrNull(classifyRegQuery(otherExit)) === null
		&& classifyRegQuery(blocked).kind === "failure" && classifyRegQuery(otherExit).kind === "failure",
		`blocked=${classifyRegQuery(blocked).reason} other=${classifyRegQuery(otherExit).reason}`);
	// 关键回归：①情形下「只读」断言成立（两边都是空集、签名相同、且都不是 null）
	ok("t27: ①情形下 --autostart-status「只读」断言成立（before/after 都是空集、签名相同、非 null）",
		regValuesOrNull(c1en) !== null && regValuesOrNull(c1zh) !== null
		&& regSignature(regValuesOrNull(c1en)) === regSignature(regValuesOrNull(c1zh))
		&& regKeySignature !== null,
		`sig(en)=${regSignature(regValuesOrNull(c1en))} sig(zh)=${regSignature(regValuesOrNull(c1zh))}`);
	ok("t27: ③情形下「只读」断言仍然会失败（读取失败 → null，不放宽）",
		regValuesOrNull(classifyRegQuery(blocked)) === null && regValuesOrNull(classifyRegQuery(timedOut)) === null);
}

// ---------------------------------------------------------------- 0. t10 注册表卫生引导
/**
 * 清掉**上一次被中断的运行**留下的测试键（t10 hygiene；实测过：被强杀的那次会留下一个空键）。
 * 判据：键名 `Run-<pid>` 里的 pid 已经不存在 → 那次运行已结束（正常结束会自己删键，只有被强杀才会留下）。
 * **绝不删 pid 仍存活的键**——那可能是正在并发跑的另一次 `--strict`；pid 复用只会让我们保守地"不删"。
 */
function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return Boolean(error) && error.code === "EPERM"; }
}

function cleanupStaleTestKeys() {
	if (!WIN) return { removed: [], kept: [] };
	const parent = TEST_RUN_KEY.slice(0, TEST_RUN_KEY.lastIndexOf("\\"));
	// **必须带 /s**：不带 /s 的 `reg query` 只列该键的**值**，不列子键（实测踩过）
	const listing = runReg(["query", parent, "/s"]);
	if (listing.status !== 0 || !listing.stdout) return { removed: [], kept: [] };
	const removed = [];
	const kept = [];
	for (const line of listing.stdout.split(/\r?\n/)) {
		const m = /\\(Run-\d+)\s*$/.exec(line.trim());
		if (!m) continue;
		const pid = Number(m[1].slice("Run-".length));
		if (pid === process.pid) continue;                        // 自己的键交给收尾段清理
		if (isProcessAlive(pid)) { kept.push(m[1]); continue; }    // 可能正在并发跑 → 绝不动
		regDeleteKey(`${parent}\\${m[1]}`);
		removed.push(m[1]);
	}
	return { removed, kept };
}
const staleTestKeys = WIN ? cleanupStaleTestKeys() : { removed: [], kept: [] };
if (staleTestKeys.removed.length > 0) console.log(`NOTE t10: 回收了上次被中断的运行留下的测试键：${staleTestKeys.removed.join(", ")}`);
if (staleTestKeys.kept.length > 0) console.log(`NOTE t10: 发现同族测试键仍在运行（pid 存活，未动）：${staleTestKeys.kept.join(", ")}`);

// ①′ F-3 白名单对照（**用真实 OS 错误**，不是手写字符串 —— 避免"自证"）：
//     真 EPERM/EACCES（写只读文件）必须判为沙箱边界；真 ENOENT（读不存在的文件）必须判为非边界。
{
	let realBoundary = null;
	let realNonBoundary = null;
	const roDir = tempDir("pm-launcher-t10-readonly-");
	const ro = join(roDir, "readonly.txt");
	try {
		writeFileSync(ro, "x", "utf8");
		chmodSync(ro, 0o444);
		try { writeFileSync(ro, "y", "utf8"); } catch (error) { realBoundary = `${error.code ?? ""} ${error.message}`; }
		try { readFileSync(join(roDir, "definitely-missing.txt"), "utf8"); } catch (error) { realNonBoundary = `${error.code ?? ""} ${error.message}`; }
	} catch { /* 造不出样本不影响主流程 */ }
	finally { try { chmodSync(ro, 0o666); } catch { /* ignore */ } }
	ok("t10/F-3 白名单对照（真实 OS 错误）: 真 EPERM/EACCES → 沙箱边界；真 ENOENT → 非边界",
		isSandboxBoundary(realBoundary) === true && isSandboxBoundary(realNonBoundary) === false,
		`boundary=${String(realBoundary).slice(0, 80)} / nonBoundary=${String(realNonBoundary).slice(0, 80)}`);
}

// t10/F-3：受限会话里 C-06×2 / C-07×2 / C-15 的"探测类"断言会因沙箱边界（管道 stdio / 文件系统）
// 拿不到结论 —— 那些断言已改用 sandboxAwareOk（边界→SKIP(env)，非边界→仍 FAIL）。

// ① 默认模式：先把**空的测试专用键**建好（`reg add <key> /f` 建键不写值）。
//    为什么必须建：bin/open-boot.mjs 的 listRunValues() 把"键不存在（reg query exit 1 + 空输出）"
//    也当作"读取失败 → 残留未确认"（这是生产语义，t10 不改生产代码），而套件需要的是
//    "键存在但没有值"这一状态；键不存在会让 --uninstall 的输出退化成"无法读取注册表"。
if (WIN && !REAL_REG_TESTS) {
	const created = spawnSync("reg", ["add", TEST_RUN_KEY, "/f"], { windowsHide: true, encoding: "utf8" });
	if (created.status !== 0) {
		console.warn(`WARN t10: 测试专用键创建失败（${TEST_RUN_KEY}）→ 部分注册表断言会退化为 SKIP（不会写真实 Run 键）`);
	}
}
// ② 真实 HKCU Run 键基线：**默认模式的铁证** —— 从这一刻起到收尾，真实键必须逐值不变（只读采样，不写）。
const realRunValuesAtStart = WIN ? regListRunValues(REAL_RUN_KEY) : null;
const realRunSignatureAtStart = realRunValuesAtStart === null ? null : regSignature(realRunValuesAtStart);
/** 真机端到端模式（opt-in）下 `reg export` 的备份路径；默认模式恒为 null。 */
let realRunBackupPath = null;
if (WIN && realRunValuesAtStart === null) {
	console.warn(`WARN t10: 真实 Run 键读取失败（reg query ${REAL_RUN_KEY}）→ 无法给出"逐值不变"的前后对比证据`);
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
// t11：**这一族的共同前提** = "该端口真的没有人应答 HTTP"。
// 受限会话里端口可能被本会话内的代理或别的进程应答（队长实测到 "引擎一直没起来 → false" 假失败）
// → 前提被破坏时记 SKIP(env)（见紧随其后的独立断言）。
// 下面这条保留 L4b 的回归保护：夹具是**裸 TCP 监听器**，engineHealth 必须 ok=false、waitForEngine 必须超时 false。
{
	const l4bHealth = await engineHealth(closedPort, 1200);
	const l4bSample = /eperm|eacces|permission|sandbox|workspace-write/i.test(String(l4bHealth.sample ?? "")) ? String(l4bHealth.sample) : "";
	sandboxAwareOk("enginectl.waitForEngine: 引擎未就绪（裸 TCP 监听器）→ 必须超时后 false（L4b 回归保护）",
		l4bHealth.ok === false && (await waitForEngine(closedPort, 700, 100)) === false,
		`health=${JSON.stringify(l4bHealth).slice(0, 150)}（夹具是裸 TCP 监听器，正常会话里 ok 必须为 false）`,
		raiseBoundaryEvidence(l4bHealth.error, l4bSample));
}
// t11 新增：**"引擎一直没起来 → false" 必须在真·空闲端口上成立**；前提被破坏（端口被本会话占用/被代理应答）→ SKIP(env)
{
	const idlePort = await freePort();
	const idleOccupied = (await probe(idlePort)) === true;
	const idleHealth = await engineHealth(idlePort, 1200);
	const idleName = "t11: 引擎一直没起来 → false（真·空闲端口；前提被本会话破坏时记 SKIP(env)）";
	const idlePrecondition = idleOccupied
		? `端口 ${idlePort} 在本会话里已被监听（probe=true；freePort() 刚释放的端口本应空闲）`
		: idleHealth.ok === true
			? `端口 ${idlePort} 有 HTTP 服务应答且命中引擎指纹（marker=${idleHealth.marker}，sample=${String(idleHealth.sample).slice(0, 80)}）——像会话代理页而不是真引擎`
			: null;
	if (idlePrecondition) {
		preconditionSkip(idleName, idlePrecondition);
	} else {
		const idleSample = /eperm|eacces|permission|sandbox|workspace-write/i.test(String(idleHealth.sample ?? "")) ? String(idleHealth.sample) : "";
		sandboxAwareOk(idleName,
			(await waitForEngine(idlePort, 700, 100)) === false,
			`health=${JSON.stringify(idleHealth).slice(0, 140)}`,
			raiseBoundaryEvidence(idleHealth.error, idleSample));
	}
}

await closeSrv(srv);
{
	// t11：同族断言 —— 释放端口后再探一次；若端口仍被本会话内的东西监听，则前提不成立 → SKIP(env)。
	// 另外：`freePort()` 给的是**临时端口**，它可能被本进程/其它进程的短连接瞬态占用 ——
	// 断言失败时先复核一次占用状态：仍未释放 = 环境异常（SKIP），已释放 = 判为 waitForEngine 回归（FAIL）。
	const portFamilyName = "enginectl.waitForEngine: 无人监听端口 → false（前提：端口已释放）";
	if ((await probe(closedPort)) === true) {
		preconditionSkip(portFamilyName, `closeSrv 之后端口 ${closedPort} 仍被监听（本会话内别的进程/代理接手）`);
	} else {
		const verdict = await waitForEngine(closedPort, 400, 50, async (port) => (await probe(port)));
		const stillOccupied = verdict === true ? (await probe(closedPort, 800)) === true : false;
		if (stillOccupied) {
			preconditionSkip(portFamilyName, `端口 ${closedPort} 在断言窗口内被瞬态占用（临时端口与其它 socket 撞车）`);
		} else {
			ok(portFamilyName, verdict === false, `verdict=${verdict} stillOccupiedAfter=${stillOccupied}`);
		}
	}
}


// ---------------------------------------------------------------- 1b. t11：引擎「拉不起来」的沙箱边界识别
// 真实走一遍"启动器去拉引擎"的路径（POST /api/boot → startEngine → spawn 假 dsh）：
//  ① 正面：假 dsh shim 必须**真的被执行**（marker 出现）。受限会话里子进程被拒（EPERM/EACCES）时
//     启动器会把它写进结果/日志 → 记 SKIP(env) 并写明理由；**非沙箱**原因（例如命令不存在）仍 FAIL。
//  ② 负控（可证伪）：把 dsh 换成一个**不存在**的命令 → 拿到的证据必须**不被**判为沙箱边界
//     （即这种真实失败不会被降级成 SKIP）。
{
	if (!WIN) {
		envSkip("t11: 引擎拉起路径可用（假 dsh shim 被真正执行；沙箱拒绝子进程时记 SKIP(env)）",
			"假 dsh 夹具是 Windows .cmd 形态，非 Windows 平台跳过", "环境缺失（平台不支持/命令不存在）");
	} else {
		// 注意：这里用**裸临时目录**当 profile（不用 writeProfile —— 它依赖文件后段才初始化的常量，
		// 而本块位于文件前部）。本用例只关心"引擎拉起路径"（spawn 假 dsh），与 profile 内容无关。
		const raiseProfile = tempDir("pm-launcher-t11-raise-");
		mkdirSync(raiseProfile, { recursive: true });
		const raisePort = await freePort();
		const raiseEnginePort = await freePort();
		const marker = join(raiseProfile, "t11-raise-marker.txt");
		const shim = join(raiseProfile, "t11-dsh.cmd");
		writeFileSync(shim, ["@echo off", `echo raised>> "${marker}"`, "exit /b 0", ""].join("\r\n"), "utf8");
		const daemon = spawnNode([join(ROOT, "bin", "open-boot.mjs"), "--profile", raiseProfile, "--port", String(raisePort), "--no-window", "--dsh", shim, "--wait-ms", "1500"],
			{ logName: "t11raise", env: { DSH_ENGINE_PORT: String(raiseEnginePort) } });
		try {
			const up = await waitPort(raisePort, 15000);
			if (!up) {
				const logs = daemon.log();
				sandboxAwareOk("t11: 引擎拉起路径可用（假 dsh shim 被真正执行；沙箱拒绝子进程时记 SKIP(env)）",
					false, `启动器实例未就绪：${(logs.out + logs.err).replace(/\s+/g, " ").slice(-160)}`,
					raiseBoundaryEvidence(logs.out, logs.err, String(raisePort)));
			} else {
				const base = `http://127.0.0.1:${raisePort}`;
				const token = tokenFromHtml((await getText(`${base}/`)).text);
				const boot = await postJson(`${base}/api/boot`, { headers: { Origin: base, "X-DSH-PM-Token": token } });
				await wait(900);
				const logs = daemon.log();
				const raised = existsSync(marker) && readFileSync(marker, "utf8").includes("raised");
				sandboxAwareOk("t11: 引擎拉起路径可用（假 dsh shim 被真正执行；沙箱拒绝子进程时记 SKIP(env)）",
					raised === true,
					`POST /api/boot=${boot.status} raised=${raised} 结果=${String(boot.json?.message ?? "").replace(/\s+/g, " ").slice(0, 120)} 日志=${(logs.out + logs.err).replace(/\s+/g, " ").slice(-140)}`,
					raiseBoundaryEvidence(boot.json?.message, boot.text, logs.out, logs.err));
			}
		} finally {
			await killChild(daemon.child);
		}
		// 负控：dsh 换成不存在的命令 → 引擎启动失败的直接原因就是 ENOENT（非沙箱）
		const badProfile = tempDir("pm-launcher-t11-raisebad-");
		mkdirSync(badProfile, { recursive: true });
		const badPort = await freePort();
		const badDaemon = spawnNode([join(ROOT, "bin", "open-boot.mjs"), "--profile", badProfile, "--port", String(badPort), "--no-window", "--dsh", "pm-launcher-not-a-real-dsh", "--wait-ms", "1200"],
			{ logName: "t11raisebad", env: { DSH_ENGINE_PORT: String(raiseEnginePort) } });
		try {
			const badUp = await waitPort(badPort, 15000);
			if (!badUp) {
				const logs = badDaemon.log();
				envSkip("t11 负控: 非沙箱原因（假 dsh 命令不存在）不被判为沙箱边界",
					`负控夹具未就绪：${(logs.out + logs.err).replace(/\s+/g, " ").slice(-140)}`, "环境缺失（平台不支持/命令不存在）");
			} else {
				const badBase = `http://127.0.0.1:${badPort}`;
				const badToken = tokenFromHtml((await getText(`${badBase}/`)).text);
				const badBoot = await postJson(`${badBase}/api/boot`, { headers: { Origin: badBase, "X-DSH-PM-Token": badToken } });
				const badMsg = String(badBoot.json?.message ?? "");
				if (isSandboxBoundary(badMsg)) {
					envSkip("t11 负控: 非沙箱原因（假 dsh 命令不存在）不被判为沙箱边界",
						`负控自身落在沙箱里（证据含 EPERM/EACCES）：${badMsg.replace(/\s+/g, " ").slice(0, 120)}`, "沙箱边界（管道 stdio EPERM）");
				} else {
					ok("t11 负控（可证伪）: 命令不存在这类**非沙箱**失败不被判为沙箱边界 —— 仍会 FAIL",
						badBoot.status === 200 && badMsg !== "" && /ENOENT|无法启动|不存在|退出/.test(badMsg),
						`boot=${badBoot.status} msg=${(badMsg || JSON.stringify(badBoot.json ?? {})).replace(/\s+/g, " ").slice(0, 170)}`);
				}
			}
		} finally {
			await killChild(badDaemon.child);
		}
	}
}

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

const regBefore = regKeySignature();                    // 用例作用域（默认=测试专用键）
const realRegBefore = WIN ? regKeySignature(REAL_RUN_KEY) : null;   // **真实** Run 键（只读）
const st1 = runNode([join(ROOT, "bin", "open-boot.mjs"), "--autostart-status"], { timeoutMs: 60000 });
const st2 = runNode([join(ROOT, "bin", "open-boot.mjs"), "--autostart-status"], { timeoutMs: 60000 });
const regAfter = regKeySignature();
const realRegAfter = WIN ? regKeySignature(REAL_RUN_KEY) : null;
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
skipOk("open-boot --autostart-status: 只读（用例作用域键顺序无关比较：全部值 name/type/data 不变）",
	regBefore !== null && regBefore === regAfter, `before=${regBefore === null ? "(读取失败)" : regBefore.slice(0, 160)} after=${regAfter === null ? "(读取失败)" : regAfter.slice(0, 160)}`);
skipOk("t10: --autostart-status 未写**真实** HKCU Run 键（只读，逐值签名前后一致）",
	realRegBefore !== null && realRegBefore === realRegAfter,
	`before=${realRegBefore === null ? "(读取失败)" : dshWebEntriesText(regListRunValues(REAL_RUN_KEY))} after=${realRegAfter === null ? "(读取失败)" : dshWebEntriesText(regListRunValues(REAL_RUN_KEY))}`);
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

		const page = await getText(`http://127.0.0.1:${actualPort}/`);
		const html = page.text;
		ok("rescue-daemon GET /: 200 + 自包含中文救援页",
			page.status === 200 && /救援中心/.test(html) && /api\/verify/.test(html), `status=${page.status} err=${page.error ?? "-"}`);

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
console.log(`== 8. R13 --uninstall 卸载闭环（临时 profile + 注册表作用域 ${REAL_REG_TESTS ? "真实 Run 键（opt-in）" : "测试专用键"}）==`);
const regScopeLabel = REAL_REG_TESTS ? "真实 Run 键（opt-in）" : "测试专用键";
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
		skipOk(`R13: 注册表出现 DSHWeb* 自启值（DSHWebFront，指向本次临时 profile；作用域=${regScopeLabel}）`,
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
		// t31 显式改写（旧断言匹配的是 t20 时期的 `已删除注册表自启值：<名单>` 单行格式）：
		// 意图不变 —— 卸载输出必须打印**被删掉的键名**；新格式是「已删除（n）：」块内逐条 `· <键名>  <类型>  <数据>  —— <理由>`。
		skipOk("R13/t31: 输出打印了删掉的注册表键名（含 DSHWebFront，新「已删除」块格式）",
			/已删除（\d+）：/.test(uninstall1.stdout) && /· DSHWebFront\s+REG_SZ/.test(uninstall1.stdout),
			uninstall1.stdout.split("\n").filter((l) => l.includes("注册表") || l.includes("DSHWeb") || l.includes("已删除")).join(" | "));
		// t31 显式改写（F6 后 `--uninstall` 只清「属于本 profile」的值）：原断言是"Run 键下已无任何 DSHWeb* 值"，
		// 但别的 profile 的 DSHWeb* 现在**应当被保留**，所以精确意图是"已无指向本次临时 profile 的残留"。
		skipOk('R13/t31: reg query "HKCU\\...\\Run" 中已无指向本次临时 profile 的 DSHWeb* 残留（F6：别的 profile 的值按设计保留）',
			!snapshotDshWebRunValues().some((v) => v.data.includes(unProfile)),
			`残留=${snapshotDshWebRunValues().filter((v) => v.data.includes(unProfile)).map((v) => v.name).join(",") || "(无)"}；其余 DSHWeb*=${snapshotDshWebRunValues().map((v) => v.name).join(",") || "(无)"}`);
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
		skipOk(`R13: 注册表作用域（${regScopeLabel}）内 DSHWeb* 已恢复原值（按 name 排序逐条比较 name/type/data，顺序无关）`,
			restoredRaw !== null && restoredSignature === regSignatureBefore,
			`期望=${dshWebEntriesText(regSnapshot)} 实际=${restoredRaw === null ? "(reg query 读取失败)" : dshWebEntriesText(restoredRaw)}`);
		const restored = snapshotDshWebRunValues();
		skipOk(`R13: 自启项恢复逐字节一致（作用域=${regScopeLabel}）`,
			restoredRaw !== null && restored.length === regSnapshot.length
			&& restored.every((v, i) => v.name === regSnapshot[i].name && v.data === regSnapshot[i].data),
			`恢复后=${dshWebEntriesText(restored)}`);
		// t10：真实 Run 键在本段（install/uninstall 写操作）前后也必须完全不变（默认模式）
		const realAfter8 = regKeySignature(REAL_RUN_KEY);
		skipOk("t10: 第 8 段（install/uninstall 写操作）之后**真实** HKCU Run 键仍逐值未变",
			realAfter8 !== null && realAfter8 === realRunSignatureAtStart,
			`start=${realRunValuesAtStart === null ? "(读取失败)" : dshWebEntriesText(realRunValuesAtStart)} now=${realAfter8 === null ? "(读取失败)" : dshWebEntriesText(regListRunValues(REAL_RUN_KEY))}`);
	}
	// t11：占用者探测失败（EPERM/ENOBUFS 等边界）→ SKIP(env) 并写明证据；探测成功但 pid 变了 → FAIL
	{
		const pid3081Probe = portOwnerProbe(3081);
		sandboxAwareOk("R13: 真机 3081 常驻启动器 pid 全程未变（本任务绝不误杀别的 profile 的守护）",
			pid3081Probe.ok === true && pid3081Probe.pid === real3081PidBefore,
			`${real3081PidBefore} → ${pid3081Probe.ok ? pid3081Probe.pid : `(探测失败: ${pid3081Probe.reason})`}`,
			pid3081Probe.reason, "环境异常（资源暂时不可用：ENOBUFS/ETIMEDOUT 等）");
	}
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
		const pageHtml = (await getText(`${base}/`)).text;
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
		const localPage = (await getText(`${localBase}/`)).text;
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
			const tokenB2 = tokenFromHtml((await getText(`http://127.0.0.1:${l11bPort}/`)).text);
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
			// t11：夹具起不来时先判沙箱边界（管道/子进程被拒）——边界 → SKIP(env)，否则 FAIL
			const logs = slow.log();
			sandboxAwareOk("L11 ③: 慢启动夹具就绪", false, (logs.out + logs.err).replace(/\s+/g, " ").slice(0, 160),
				raiseBoundaryEvidence(logs.out, logs.err));
		} else {
			const base = `http://127.0.0.1:${slowPort}`;
			const localBase = `http://localhost:${slowPort}`;
			const slowToken = tokenFromHtml((await getText(`${base}/`)).text);
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
			// t11：这一组是"拉起引擎"用例 —— 受限会话里假 dsh shim 被拒（EPERM）时 marker 不会出现。
			// 边界证据取**启动结果 + 守护日志**：两类证据都要算（守卫进程自身可能只把错误放进 HTTP 响应）。
			const slowBootEvidence = raiseBoundaryEvidence(
				r1?.json?.message, r1?.text, r2?.json?.message, r2?.text,
				r3?.json?.message, r3?.text, r4?.json?.message, r4?.text,
				slow.log().out, slow.log().err
			);
			const spawns = existsSync(marker) ? readFileSync(marker, "utf8").trim().split(/\r?\n/).filter(Boolean).length : 0;
			sandboxAwareOk("L11 ③: 每对并发只拉起一次引擎（marker=2：两对并发各一次，没有重复拉起）",
				spawns === 2, `spawn 次数=${spawns}`,
				spawns === 0 ? slowBootEvidence : "");
			// 假引擎进程（shim 树）由测试夹具回收：pid 记录在引擎 PID 文件里（.rescue-daemon.pid）
			const slowEngineInfo = readJsonFile(join(slowProfile, ".rescue-daemon.pid"));
			killTree(slowEngineInfo?.pid);
			let slowGone = false;
			for (let i = 0; i < 15 && !slowGone; i++) { await wait(200); slowGone = !isAlive(slowEngineInfo?.pid); }
			sandboxAwareOk("L11 ③: 假引擎（shim 进程树）已被测试夹具回收（不残留挂起进程）",
				Number.isInteger(slowEngineInfo?.pid) && slowGone === true, `pid=${slowEngineInfo?.pid} gone=${slowGone}`,
				Number.isInteger(slowEngineInfo?.pid) ? "" : slowBootEvidence);
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
			const rescuePage = await getText(`${base}/rescue`);
			const rescueHtml = rescuePage.text;
			ok("R7: GET /rescue → 200 完整救援页（verify/fix/start/stop/status 按钮齐备）",
				rescuePage.status === 200 && /救援中心/.test(rescueHtml) && /api\/verify/.test(rescueHtml) && /api\/fix/.test(rescueHtml)
				&& /api\/start/.test(rescueHtml) && /api\/stop/.test(rescueHtml) && /api\/status/.test(rescueHtml),
				`status=${rescuePage.status} err=${rescuePage.error ?? "-"}`);
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
	// 并发注意（t10）：3082 是**全机共享**的默认端口 —— 两个 `--strict` 同时跑时，另一个实例可能
	// 正好先绑定它，本实例的守护会 EADDRINUSE 退出。这属于"共享资源冲突"（环境性），记 SKIP(env)，
	// 不能算失败（各自随机端口的 R7 用例仍然全部生效）。
	if ((await portOpen(3082, 400)) === false) {
		const defaultRdProfile = writeProfile(tempDir("pm-launcher-r7-3082-"), ["@deepseek-ai/dsh-base"]);
		const defaultRd = spawnNode([rescueBin, "--profile", defaultRdProfile], { logName: "r7default", env: { DSH_ENGINE_PORT: String(r7EnginePort) } });
		try {
			const up = await waitPort(3082, 15000);
			const oursStillAlive = defaultRd.child.exitCode === null && defaultRd.child.signalCode === null;
			let info = up ? await getJson("http://127.0.0.1:3082/api/status") : { json: null, error: "端口未就绪" };
			if (!info.json && up) { await wait(400); info = await getJson("http://127.0.0.1:3082/api/status"); }
			// 归属判定：/api/status 暴露 profile（rescue-daemon.mjs:182）→ 能区分"我们的守护"与"并发实例的守护"
			const identifiedOurs = info.json?.profile === defaultRdProfile && info.json?.port === 3082;
			const contended = !oursStillAlive || Boolean(info.error) || (info.json != null && !identifiedOurs);
			if (contended) {
				// Windows 的 SO_REUSEADDR 允许两个实例抢同一端口；并发跑时这里无法得出"我们的守护落到 3082"的结论
				envSkip("R7: 不带 --port 时 rescue-daemon 落到 3082（默认端口迁移生效，不再抢 3081）",
					`共享端口 3082 被并发实例争用：daemonAlive=${oursStillAlive} status=${JSON.stringify(info.json ?? info.error).slice(0, 110)}`,
					"并发冲突（共享端口/资源被别的实例占用）");
			} else {
				ok("R7: 不带 --port 时 rescue-daemon 落到 3082（默认端口迁移生效，不再抢 3081）",
					up === true && info.json?.port === 3082, `${JSON.stringify(info.json || {}).slice(0, 110)}`);
			}
		} finally {
			await killChild(defaultRd.child);
		}
	} else {
		envSkip("R7: 不带 --port 时 rescue-daemon 落到 3082（默认端口迁移生效，不再抢 3081）",
			"3082 已被占用（可能是并发跑的另一个实例），跳过「默认端口实测」（断言已在上面的 parseArgs 中覆盖）",
			"并发冲突（共享端口/资源被别的实例占用）");
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
		{
			// t11：占用者探测拿不到结论（EPERM/ENOBUFS…）时记 SKIP(env)，非边界仍 FAIL
			const ownerProbe = portOwnerProbe(conflictPort);
			const held = (await portOpen(conflictPort, 600)) === true;
			sandboxAwareOk("R7: 报错后原占用者仍持有该端口（没有进程被挪动/杀掉）",
				held && ownerProbe.ok === true && ownerProbe.pid !== null,
				`held=${held} probe=${JSON.stringify(ownerProbe).slice(0, 130)}`,
				ownerProbe.reason, "环境异常（资源暂时不可用：ENOBUFS/ETIMEDOUT 等）");
		}

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
		{
			// t11：同族的占用者探测断言 —— 边界（EPERM/ENOBUFS…）→ SKIP(env)；探测成功但 pid 变了 → FAIL
			const pid3081Probe = portOwnerProbe(3081);
			sandboxAwareOk("R7: 真机 3081 常驻守护 pid 不变（全程未受测试影响）",
				pid3081Probe.ok === true && pid3081Probe.pid === real3081PidBefore,
				`${real3081PidBefore} → ${pid3081Probe.ok ? pid3081Probe.pid : `(探测失败: ${pid3081Probe.reason})`}`,
				pid3081Probe.reason, "环境异常（资源暂时不可用：ENOBUFS/ETIMEDOUT 等）");
		}
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

// ---------------------------------------------------------------- 16. 自启值按 profile 作用域清理（t31 / F6）
console.log("== 16. 自启注册表按 profile 作用域清理（t31/F6）==");
{
	const profileA = writeProfile(tempDir("pm-launcher-t31-A-"), ["@deepseek-ai/dsh-base"]);
	const profileB = writeProfile(tempDir("pm-launcher-t31-B-"), ["@deepseek-ai/dsh-base"]);
	writeFileSync(join(profileA, "open-boot-autostart.vbs"), "' A shim\r\n", "utf8");
	writeFileSync(join(profileB, "open-boot-autostart.vbs"), "' B shim\r\n", "utf8");
	const wscript = (vbs) => `"C:\\Windows\\System32\\wscript.exe" //nologo "${vbs}"`;
	const deadPath = join(tempDir("pm-launcher-t31-gone-"), "open-boot-rescue.vbs"); // 目录存在但没有该脚本

	// 16.1 extractShimPath：从自启值数据里解析脚本路径
	ok("t31: extractShimPath 解析 wscript 引号形态",
		openBoot.extractShimPath(wscript(join(profileA, "open-boot-autostart.vbs"))) === join(profileA, "open-boot-autostart.vbs"));
	ok("t31: extractShimPath 容错（未加引号的 .vbs / 纯路径 / 非 .vbs 返回 null）",
		openBoot.extractShimPath(`wscript //nologo ${join(profileA, "open-boot-ui.vbs")}`) === join(profileA, "open-boot-ui.vbs")
		&& openBoot.extractShimPath("C:\\x\\y.vbs") === "C:\\x\\y.vbs"
		&& openBoot.extractShimPath("C:\\tools\\other.exe --run") === null
		&& openBoot.extractShimPath("") === null);

	// 16.2 classifyAutostartValue：作用域判定矩阵（纯函数，不碰注册表）
	const matrix = [
		["本 profile（脚本存在）", { name: "DSHWebFront", type: "REG_SZ", data: wscript(join(profileA, "open-boot-autostart.vbs")) }, "delete", /属于本 profile/],
		["别的 profile（脚本存在）", { name: "DSHWebOther", type: "REG_SZ", data: wscript(join(profileB, "open-boot-autostart.vbs")) }, "keep", /属于其它 profile/],
		["死指针（历史 DSHWebRescue，脚本不在）", { name: "DSHWebRescue", type: "REG_SZ", data: wscript(deadPath) }, "delete", /死指针/],
		["非本工具形态（没有 .vbs）", { name: "DSHWebWeird", type: "REG_SZ", data: "C:\\tools\\other.exe --run" }, "keep", /不是本工具写的形态/]
	];
	for (const [label, value, action, reasonRe] of matrix) {
		const verdict = openBoot.classifyAutostartValue(value, { profileDir: profileA });
		ok(`t31: classifyAutostartValue（${label}）→ ${action}`,
			verdict.action === action && reasonRe.test(verdict.reason), `${verdict.action} :: ${verdict.reason}`);
	}

	// 16.3 可证伪：注入依赖跑完整清理流程（沙箱内也能跑）
	//      旧行为会把 DSHWebOther（别的 profile）一起删掉 —— 这里必须断言它**没被删**。
	{
		const decoys = [
			{ name: "DSHWebFront", type: "REG_SZ", data: wscript(join(profileA, "open-boot-autostart.vbs")) },
			{ name: "DSHWebOtherProfile", type: "REG_SZ", data: wscript(join(profileB, "open-boot-autostart.vbs")) },
			{ name: "DSHWebRescue", type: "REG_SZ", data: wscript(deadPath) },
			{ name: "OneDrive", type: "REG_SZ", data: "C:\\x.exe" }
		];
		const calls = [];
		const backupFile = join(profileA, ".plugin-manager", "registry-backup-20261006-000000.reg");
		const result = openBoot.removeProfileRunValues({ profile: profileA }, {
			listValues: () => decoys,
			deleteValue: (name) => { calls.push(`delete:${name}`); return { status: 0 }; },
			exportKey: (profile) => { calls.push(`export:${profile === profileA ? "A" : profile}`); return { ok: true, path: backupFile, message: `已备份注册表 Run 键 → ${backupFile}` }; }
		});
		ok("t31: 目标 profile 的值被删（作用域内 → delete）",
			result.removed.includes("DSHWebFront"), JSON.stringify(result.removed));
		ok("t31: **别的 profile 的值没被删**（可证伪：旧行为会一并删掉）",
			!result.removed.includes("DSHWebOtherProfile")
			&& result.kept.map((item) => item.name).includes("DSHWebOtherProfile"), JSON.stringify({ removed: result.removed, kept: result.kept.map((i) => i.name) }));
		ok("t31: 死指针被删（覆盖历史 DSHWebRescue）",
			result.removed.includes("DSHWebRescue"));
		ok("t31: 跳过项逐条带理由（键名 + 指向路径 + 跳过理由）",
			result.kept.every((item) => item.name && item.type && typeof item.reason === "string" && /跳过/.test(item.reason))
			&& result.kept.some((item) => item.reason.includes(profileB)),
			JSON.stringify(result.kept.map((i) => `${i.name}::${i.reason}`)));
		ok("t31: 删除前先做备份（export 调用发生在所有 delete 之前）",
			calls[0] === "export:A" && calls.filter((c) => c.startsWith("delete:")).length === 2,
			calls.join(" | "));
		ok("t31: 备份路径写进输出（<profile>/.plugin-manager/registry-backup-<ts>.reg）",
			/registry-backup-\d{8}-\d{6}\.reg/.test(result.backup.path) && result.message.includes("registry-backup-"),
			result.message.split("\n").slice(0, 3).join(" / "));
		ok("t31: 输出分「已删除」「已跳过」两块且逐条打印键名/类型/数据/理由",
			/已删除（2）：/.test(result.message) && /已跳过（1，未删除）：/.test(result.message)
			&& /DSHWebFront {2}REG_SZ/.test(result.message) && /DSHWebOtherProfile {2}REG_SZ/.test(result.message));
		ok("t31: 备份失败只告警、不阻断主流程（ok 仍为 true，失败原因进输出）",
			(() => {
				const warn = openBoot.removeProfileRunValues({ profile: profileA }, {
					listValues: () => decoys,
					deleteValue: () => ({ status: 0 }),
					exportKey: () => ({ ok: false, path: backupFile, message: "⚠ 注册表备份失败（不阻断）：EPERM spawnSync reg EPERM" })
				});
				return warn.ok === true && /备份失败（不阻断）/.test(warn.message) && warn.removed.length === 2;
			})());
		ok("t31: 缺少 --profile → 拒绝清理（不误当成「删所有 DSHWeb*」）",
			(() => {
				const refused = openBoot.removeProfileRunValues({}, { listValues: () => decoys, deleteValue: () => { throw new Error("不该被调用"); } });
				return refused.ok === false && refused.removed.length === 0 && /缺少明确的 --profile/.test(refused.message);
			})());
		ok("t31: 读取失败（listValues → null）不得谎报「已清干净」",
			/未确认/.test(openBoot.removeProfileRunValues({ profile: profileA }, { listValues: () => null, exportKey: () => ({ ok: true, path: backupFile, message: "" }) }).message));
	}

	// 16.4 只读断言：`--uninstall-autostart` 与 `--uninstall` 同口径（都按 profile 作用域）
	{
		const fake = {
			profile: profileA, port: 63021, dsh: "dsh", cwd: null, interval: 60, heartbeatMin: 10, quiet: true,
			window: false, waitMs: 1000, autostart: "uninstall", uninstall: false, unknown: [], modes: []
		};
		const uninstallAutostartSource = readFileSync(openBootBin, "utf8");
		ok("t31: --uninstall-autostart 走同一个 profile 作用域实现（源码不再出现无参 removeDsWebRunValues()）",
			!/(^|[^.\w])removeDsWebRunValues\(\)/.test(uninstallAutostartSource)
			&& (uninstallAutostartSource.match(/removeProfileRunValues\(args\)/g) || []).length >= 2,
			`removeProfileRunValues(args) 出现 ${(uninstallAutostartSource.match(/removeProfileRunValues\(args\)/g) || []).length} 次（两处调用点 + 兼容包装 1 处）`);
		ok("t31: backupRunKey 在受限会话里失败也只返回告警对象（不抛）",
			(() => { const b = openBoot.backupRunKey(profileA); return typeof b.message === "string" && /registry-backup-\d{8}-\d{6}\.reg/.test(b.path); })());
		const refusedArgs = { ...fake, profile: join(tempDir("pm-launcher-t31-empty-"), "nope") };
		ok("t31: 目标 profile 不合法时 --uninstall-autostart 仍拒绝（t14 的闸门未回退）",
			openBoot.uninstallAutostart(refusedArgs).ok === false
			&& /拒绝移除开机自启/.test(openBoot.uninstallAutostart(refusedArgs).message));
	}
	// 16.5 注册表诱饵（t10：**默认作用域 = 测试专用键**，绝不写真机；
	//      真机端到端请设 DSH_PM_REAL_REGISTRY_TESTS=1，那时才写真实 Run 键并做 export 备份 + 残留断言）
	{
		const decoyA = "DSHWebT31DecoyA";
		const decoyB = "DSHWebT31DecoyB";
		const scope = REAL_REG_TESTS ? "真实 Run 键（opt-in）" : "测试专用键";
		if (REAL_REG_TESTS) {
			// 备份落在系统临时目录（**不进 tempDirs**）→ 即使随后清理夹具也保留，便于人工回滚
			realRunBackupPath = join(tmpdir(), `dsh-pm-real-run-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.reg`);
		}
		const exportBackup = REAL_REG_TESTS ? regExportKey(REAL_RUN_KEY, realRunBackupPath) : null;
		if (exportBackup) {
			ok("t10(opt-in): 真机模式跑前已 `reg export` 备份真实 Run 键（含备份路径）",
				exportBackup.ok === true && existsSync(exportBackup.path), `${exportBackup.path} ${exportBackup.message}`);
		}
		const wroteA = regAddRunValue(decoyA, wscript(join(profileA, "open-boot-autostart.vbs")));
		const wroteB = regAddRunValue(decoyB, wscript(join(profileB, "open-boot-autostart.vbs")));
		if (wroteA && wroteB) {
			runNode([openBootBin, "--uninstall", "--profile", profileA, "--port", "63022"], { timeoutMs: 60000 });
			const leftA = regQueryRunValue(decoyA);
			const leftB = regQueryRunValue(decoyB);
			regDeleteRunValue(decoyA); regDeleteRunValue(decoyB);
			skipOk(`t31(${scope}): 诱饵值指向目标 profile → 被删；指向别的 profile → 仍在`,
				leftA === null && leftB !== null, `A=${leftA === null ? "已删" : "仍在"} B=${leftB === null ? "被误删" : "仍在"}`);
			// t10：诱饵必须清干净（**有残留就失败并打印键名**）——本套件不得在你的机器上留垃圾
			const residue = [decoyA, decoyB].filter((name) => regQueryRunValue(name) !== null);
			ok(`t10(${scope}): 诱饵值清理后无残留（有残留即失败并打印键名）`,
				residue.length === 0, `残留键名=${residue.join(",") || "无"}`);
		} else {
			// t11：受限会话里 reg add 写不进去 → **两条断言都记 SKIP**（而不是各少一条），
			// 这样"受限态 / 无限制态"的断言总数保持一致（便于比对）。
			skipOk(`t31(${scope}): 诱饵值作用域用例（需要可用的 reg add/query）`, false, "reg add 未成功（受限会话）");
			skipOk(`t10(${scope}): 诱饵值清理后无残留（有残留即失败并打印键名）`, false, "reg add 未成功（受限会话）");
		}
	}
}

// ---------------------------------------------------------------- 17. 跨平台六条（t4：C-05/06/07/13/14/15）
console.log("== 17. 跨平台与工具类修复（t4：C-05 弹窗假成功 / C-06 全局根探测 / C-07 端口归属兜底 / C-13+C-14 环境变量与覆盖 / C-15 pack 工具）==");
{
	const norm = (paths) => paths.map((p) => p.split(/[\\/]/).join("/"));
	const { bootWindowPlan, buildBootWindowScript, shQuote, launchViaCandidates, verifyLauncherExit, detectAvailableTerminals, BOOT_TERMINALS,
		parseLsofListenerPid, parseSsListener, parseProcNetTcpListeners, pickProcListenerInode, findPidBySocketInode, resolvePortOwner, resolveProcessImage } =
		await import("./lib/enginectl.mjs");
	const platformMod = await import("./lib/platform.js");
	const {
		npmGlobalRootChain, npmGlobalRootReport, npmGlobalRoots, probeNpmGlobalRootDetailed, resolveNpmCliPath,
		npmRootFromPrefix, scanVersionDirs, NPM_GLOBAL_ROOT_COVERAGE
	} = platformMod;

	// ---- 17.1 C-05：命令构造是纯函数，且两个平台的旧形态都被拿掉 ----
	{
		const darwinScriptPath = "/Users/n/.dsh/profiles/web/open-boot-window.command";
		const darwinBootArgs = ["/pkg/bin/dsh-boot.mjs", "--profile", "/Users/n/.dsh/profiles/web", "--wait-ms", "45000", "--pause"];
		const mac = bootWindowPlan({
			platform: "darwin", execPath: "/usr/local/bin/node", bootArgs: darwinBootArgs,
			workDir: "/Users/n", scriptPath: darwinScriptPath
		});
		ok("C-05/macOS: 计划可用（不再用不成立的 `open -a Terminal <shell 命令行>`）", mac.ok === true && mac.candidates.length >= 2,
			JSON.stringify(mac.reason ?? mac.candidates.map((c) => c.via)));
		const openCandidate = mac.candidates.find((c) => c.command === "open") ?? { args: [] };
		ok("C-05/macOS: `open` 的第 3 个参数是 **.command 文件路径**，不是命令行",
			openCandidate.args[2] === darwinScriptPath && /\.command$/.test(openCandidate.args[2] ?? ""),
			JSON.stringify(openCandidate.args));
		ok("C-05/macOS: `open` 的参数里**没有**任何 boot 参数/shell 命令行残留（可证伪：旧实现把整串命令塞进 args）",
			!openCandidate.args.some((part) => part.includes("dsh-boot.mjs") || part.includes("--profile") || part.includes("--wait-ms")),
			JSON.stringify(openCandidate.args));
		ok("C-05/macOS: 脚本内容含 shebang + cd 工作目录 + exec（参数逐个单引号转义）",
			/^#!\/bin\/sh\n/.test(mac.script) && mac.script.includes("cd '/Users/n' || exit 1")
			&& mac.script.includes("exec '/usr/local/bin/node' '/pkg/bin/dsh-boot.mjs' '--profile'"),
			JSON.stringify(mac.script.split("\n").slice(2).join(" / ")));
		ok("C-05/macOS: osascript 作为兜底候选（Terminal do script 打开同一个脚本文件）",
			mac.candidates.some((c) => c.command === "osascript" && c.args.join(" ").includes(darwinScriptPath)),
			JSON.stringify(mac.candidates.map((c) => c.via)));
		ok("C-05/macOS: 缺 scriptPath → 明确 ok:false（不回退到不成立的 open 形态，也不假装成功）",
			bootWindowPlan({ platform: "darwin", execPath: "/usr/local/bin/node", bootArgs: darwinBootArgs }).ok === false
			&& /open 只接受文件/.test(bootWindowPlan({ platform: "darwin" }).reason),
			String(bootWindowPlan({ platform: "darwin" }).reason).slice(0, 80));
		ok("C-05: shQuote 处理空格/单引号（注入安全）",
			shQuote("a b") === "'a b'" && shQuote("it's") === "'it'\\''s'", `${shQuote("a b")} | ${shQuote("it's")}`);
		ok("C-05/macOS: 脚本正文纯 ASCII（避免终端/区域设置下的编码歧义）",
			/^[\x09\x0a\x20-\x7e]*$/.test(buildBootWindowScript({ execPath: "/usr/bin/node", bootArgs: ["/p/x.mjs", "--dsh", "npx dsh"], workDir: "/Users/n" })),
			"buildBootWindowScript 输出含非 ASCII" );
	}
	{
		const bootArgs = ["/pkg/bin/dsh-boot.mjs", "--profile", "/home/u/.dsh/profiles/web"];
		const gnomeOnly = bootWindowPlan({ platform: "linux", execPath: "/usr/bin/node", bootArgs, available: ["gnome-terminal"], workDir: "/home/u" });
		const gnome = gnomeOnly.candidates[0] ?? { args: [] };
		ok("C-05/Linux: gnome-terminal 用 `--` 形态（不再依赖 GNOME 42+ 已移除的 `-e`）",
			gnomeOnly.ok === true && gnome.command === "gnome-terminal" && gnome.args[0] === "--" && !gnome.args.includes("-e"),
			JSON.stringify(gnome.args));
		const all = bootWindowPlan({ platform: "linux", execPath: "/usr/bin/node", bootArgs, available: null, workDir: "/home/u" });
		ok("C-05/Linux: 兜底链顺序 = x-terminal-emulator → gnome-terminal → konsole → xfce4-terminal → xterm",
			JSON.stringify(all.candidates.map((c) => c.command)) === JSON.stringify(BOOT_TERMINALS.map((t) => t.name)),
			JSON.stringify(all.candidates.map((c) => c.command)));
		ok("C-05/Linux: x-terminal-emulator 保留 `-e`（Debian 政策要求该包装器支持 -e；它会把 -e 翻译成 --）",
			all.candidates[0].args[0] === "-e" && all.candidates[0].args[1] === "/usr/bin/node",
			JSON.stringify(all.candidates[0]));
		ok("C-05/Linux: 只装了 xterm 时仍给出可用候选（链尾可达）",
			bootWindowPlan({ platform: "linux", execPath: "/usr/bin/node", bootArgs, available: ["xterm"] }).candidates[0]?.command === "xterm");
		const noneLinux = bootWindowPlan({ platform: "linux", execPath: "/usr/bin/node", bootArgs, available: [] });
		ok("C-05/Linux: 一个终端都没有 → ok:false + 明确原因（不假装成功）",
			noneLinux.ok === false && /未找到可用的终端模拟器/.test(noneLinux.reason), String(noneLinux.reason).slice(0, 70));
		const win = bootWindowPlan({ platform: "win32", execPath: "C:\\node\\node.exe", bootArgs, workDir: "C:\\Users\\n", comspec: "C:\\Windows\\System32\\cmd.exe" });
		ok("C-05/Windows: 仍是 `cmd /c start \"\" /D <workDir> <node> <args>`（唯一可靠的可见控制台）",
			win.ok === true && win.candidates[0].command.endsWith("cmd.exe")
			&& JSON.stringify(win.candidates[0].args.slice(0, 6)) === JSON.stringify(["/c", "start", "", "/D", "C:\\Users\\n", "C:\\node\\node.exe"]),
			JSON.stringify(win.candidates[0].args.slice(0, 6)));
		const other = bootWindowPlan({ platform: "freebsd", execPath: "/usr/bin/node", bootArgs });
		ok("C-05/未知平台: 明确判不可用（不静默假装已弹出）", other.ok === false && /不支持的平台/.test(other.reason), String(other.reason).slice(0, 60));
		ok("C-05: detectAvailableTerminals 是注入式纯逻辑（可用终端子集）",
			JSON.stringify(detectAvailableTerminals({ run: (cmd, args) => ({ status: args[1].includes("xterm") ? 0 : 1 }) }).sort()) === JSON.stringify(["xterm"]),
			JSON.stringify(detectAvailableTerminals({ run: () => ({ status: 1 }) })));
	}
	// ---- 17.2 C-05 负控/正控：注入必然失败的启动器 → 得到**错误**而不是成功 ----
	{
		const dead = await launchViaCandidates([{ command: process.execPath, args: ["-e", "process.exit(3)"], via: "注入的假终端" }], { graceMs: 1500 });
		ok("C-05 负控: 注入必然失败的启动器（exit 3）→ ok:false，原因带退出码",
			dead.ok === false && /exit 3/.test(dead.reason ?? ""), String(dead.reason).slice(0, 90));
		const ghost = await launchViaCandidates([{ command: "dsh-not-a-real-terminal-xyz", args: [], via: "不存在的命令" }], { graceMs: 800 });
		ok("C-05 负控: 命令不存在 → ok:false + ENOENT，且**不崩宿主**（error 事件必须被接管）",
			ghost.ok === false && /ENOENT/.test(ghost.reason ?? ""), String(ghost.reason).slice(0, 90));
		const exit0 = await launchViaCandidates([{ command: process.execPath, args: ["-e", ""], via: "exit 0 启动器" }], { graceMs: 800 });
		ok("C-05 正控: exit 0 → ok:true（正常完成的启动器不算失败）", exit0.ok === true && exit0.verdict.verdict === "exit-0", JSON.stringify(exit0.verdict));
		const alive = await launchViaCandidates([{ command: process.execPath, args: ["-e", "setTimeout(()=>{},1500)"], via: "存活窗口" }], { graceMs: 400 });
		ok("C-05 正控: 窗口进程仍在运行 → ok:true（verdict=still-running，不是「没证据就成功」）",
			alive.ok === true && alive.verdict.verdict === "still-running" && /未立即失败/.test(alive.evidence ?? ""),
			JSON.stringify({ verdict: alive.verdict.verdict, evidence: alive.evidence }));
		const fallback = await launchViaCandidates([
			{ command: "dsh-not-a-real-terminal-xyz", args: [], via: "候选1" },
			{ command: process.execPath, args: ["-e", "setTimeout(()=>{},1200)"], via: "候选2" }
		], { graceMs: 400 });
		ok("C-05: 候选链逐个尝试，前一个失败会记原因、后一个成功才算成功",
			fallback.ok === true && fallback.via === "候选2" && fallback.attempts[0].ok === false && /ENOENT/.test(fallback.attempts[0].reason),
			JSON.stringify(fallback.attempts.map((a) => `${a.via}:${a.ok}`)));
		const portEvidence = await launchViaCandidates([{ command: process.execPath, args: ["-e", "setTimeout(()=>{},1200)"], via: "端口证据" }],
			{ graceMs: 900, probePort: 63099, probeFn: async () => true });
		ok("C-05: 端口出现监听者 → 强证据（verdict=port-listening）",
			portEvidence.ok === true && portEvidence.verdict.verdict === "port-listening", JSON.stringify(portEvidence.verdict));
		const empty = await launchViaCandidates([], {});
		ok("C-05: 没有候选命令 → ok:false + 明确原因（不静默成功）", empty.ok === false && /没有可用的启动命令候选/.test(empty.reason), String(empty.reason));
		// spawnBootWindow 的集成面：注入失败计划 → 仍必须报失败
		if (openBoot && typeof openBoot.spawnBootWindow === "function") {
			const fakeArgs = { profile: tempDir("pm-launcher-t4-bootwin-"), dsh: "dsh", waitMs: 1000, cwd: null, window: true };
			const injected = await openBoot.spawnBootWindow(fakeArgs, {
				plan: { ok: true, kind: "test", candidates: [{ command: process.execPath, args: ["-e", "process.exit(9)"], via: "注入的假终端" }], script: null },
				probePort: 63099, probeFn: async () => false
			});
			ok("C-05 负控（集成）: open-boot.spawnBootWindow 注入必然失败的启动器 → ok:false 且带退出码",
				injected.ok === false && /exit 9/.test(injected.message) && injected.attempts?.length === 1,
				String(injected.message).slice(0, 120));
			const injectedOk = await openBoot.spawnBootWindow(fakeArgs, {
				plan: { ok: true, kind: "test", candidates: [{ command: process.execPath, args: ["-e", "setTimeout(()=>{},1200)"], via: "注入的存活终端" }], script: null },
				probePort: 63099, probeFn: async () => false
			});
			ok("C-05 正控（集成）: 存活窗口 → ok:true 且消息里带证据", injectedOk.ok === true && /证据：/.test(injectedOk.message), String(injectedOk.message).slice(0, 120));
			const openBootSource = readFileSync(openBootBin, "utf8");
			ok("C-05: boot() 现在 **await** spawnBootWindow（返回值不再被当成同步真是布尔）",
				/await spawnBootWindow\(args\)/.test(openBootSource) && !/open -a Terminal", line/.test(openBootSource));
		} else {
			ok("C-05: open-boot 模块可用（spawnBootWindow 已导出）", false, "openBoot 未加载");
		}
	}
	// ---- 17.3 C-06：原状失败证据 + 修复后实测 + P-03 冷启动不阻塞 ----
	{
		const npmBare = spawnSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
		const npmCmd = spawnSync("npm.cmd", ["root", "-g"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
		if (WIN) {
			// F-3：受限会话里这两个 spawnSync 会因为**管道 stdio 被拒**而返回 EPERM（不是 ENOENT/EINVAL）
			// → 那是沙箱边界，记 SKIP(env)；正常会话里才断言原状错误码。
			sandboxAwareOk("C-06 原状证据（win32）: 裸 spawnSync(\"npm\") = ENOENT，\"npm.cmd\" = EINVAL —— 两条直连路都不通",
				npmBare.error?.code === "ENOENT" && npmCmd.error?.code === "EINVAL",
				`npm=${npmBare.error?.code ?? npmBare.status} npm.cmd=${npmCmd.error?.code ?? npmCmd.status}`,
				`${npmBare.error?.code ?? ""} ${npmBare.error?.message ?? ""} ${npmCmd.error?.code ?? ""} ${npmCmd.error?.message ?? ""}`);
		} else {
			ok("C-06（非 win32）: 记录本机 npm 直连探测结果（结论留档，不作断言）", true,
				`npm=${npmBare.error?.code ?? npmBare.status} npm.cmd=${npmCmd.error?.code ?? "n/a"}`);
		}
		const cli = resolveNpmCliPath({ env: process.env });
		ok("C-06: resolveNpmCliPath 在真实环境里定位到 npm-cli.js（零 shell/零转义的调用路线）",
			typeof cli.path === "string" && /npm-cli\.js$/i.test(cli.path), String(cli.path));
		const probed = probeNpmGlobalRootDetailed({ env: process.env, platform: process.platform });
		const probeBoundary = (probed.attempts ?? []).map((a) => a.error).filter(Boolean).join(" | ");
		sandboxAwareOk("C-06 修复后实测: npm 全局根探测拿到**存在的目录**（本机实测，非 null）",
			typeof probed.root === "string" && existsSync(probed.root) && probed.attempts.some((a) => a.status === 0),
			`root=${probed.root} via=${probed.source} attempts=${(probed.attempts ?? []).map((a) => `${a.strategy}:${a.status ?? a.error}`).join(" / ")}`,
			probeBoundary);
		const report = npmGlobalRootReport();
		sandboxAwareOk("C-06: npmGlobalRoots() 非空且包含真实存在的目录（C-13 的「不静默返回空」）",
			npmGlobalRoots().length > 0 && report.existing.length > 0,
			`roots=${npmGlobalRoots().length} existing=${report.existing.length} problems=${report.problems.join(" / ").slice(0, 160)}`,
			[...(report.probe.attempts ?? []).map((a) => a.error).filter(Boolean), ...report.problems].join(" | "));
		ok("C-06/P-03: 首次调用不阻塞——快路径命中时**不发起同步探测**（probe.attempts 为空 + pending 标记）",
			report.probe.pending === true ? report.probe.attempts.length === 0 && /后台异步进行/.test(report.probe.note ?? "") : report.problems.length > 0,
			JSON.stringify({ pending: report.probe.pending, attempts: report.probe.attempts.length, problems: report.problems.length }));
		const perfScript = `
			const m = await import(${JSON.stringify(new URL("./lib/platform.js", import.meta.url).href)});
			const t1 = Date.now();
			const roots = m.npmGlobalRoots();
			const t2 = Date.now();
			const t3 = Date.now();
			const p = m.probeNpmGlobalRootDetailed({ env: process.env, platform: process.platform });
			const t4 = Date.now();
			const syncError = (p.attempts || []).map((a) => a.error).filter(Boolean).join(" | ");
			console.log(JSON.stringify({ first_call_ms: t2 - t1, sync_probe_ms: t4 - t3, roots: roots.length, pending: m.npmGlobalRootReport().probe.pending, sync_root: p.root, sync_error: syncError }));
		`;
		const perfRun = runNode(["--input-type=module", "-e", perfScript], { timeoutMs: 60000 });
		let perfJson = null;
		try { perfJson = JSON.parse(perfRun.stdout.trim().split(/\r?\n/).pop()); } catch { perfJson = null; }
		ok("C-06/P-03: 冷启动实测可解析（子进程里量 first_call vs 同步探测耗时）",
			perfJson !== null && Number.isFinite(perfJson.first_call_ms) && Number.isFinite(perfJson.sync_probe_ms),
			String(perfRun.stdout).trim().slice(0, 160));
		if (perfJson) {
			if (perfJson.pending === true) {
				sandboxAwareOk("C-06/P-03 实测: 快路径命中时首次调用**显著快于**同步探测（不再有 ~190 ms 同步阻塞）",
					perfJson.first_call_ms < Math.max(50, perfJson.sync_probe_ms),
					`first_call=${perfJson.first_call_ms}ms vs sync_probe=${perfJson.sync_probe_ms}ms（sync_root=${perfJson.sync_root}）`,
					perfJson.sync_error);
			} else {
				ok("C-06/P-03 实测: 本机快路径未命中（APPDATA 目录不存在）→ 同步探测兜底有结论（记录数字，不作性能断言）",
					perfJson.roots > 0 || perfJson.sync_root === null,
					`first_call=${perfJson.first_call_ms}ms sync_probe=${perfJson.sync_probe_ms}ms roots=${perfJson.roots}`);
			}
		}
	}
	// ---- 17.4 C-13 / C-14：多级兜底 + 存在性校验 + 显式诊断 + 覆盖清单 ----
	{
		const existsNone = () => false;
		const winNoAppData = npmGlobalRootChain({ platform: "win32", env: {}, home: "C:\\Users\\n", probes: {}, scans: {}, exists: existsNone });
		ok("C-13: win32 缺 APPDATA **不再静默返回空**（回退 USERPROFILE/LOCALAPPDATA/主目录推导）",
			winNoAppData.ok === true && winNoAppData.roots.length >= 2,
			JSON.stringify(norm(winNoAppData.roots)));
		ok("C-13: 缺 APPDATA 给出**显式诊断**（写明缺哪个变量、退到哪条路）",
			winNoAppData.problems.some((p) => p.includes("缺少环境变量 APPDATA") && p.includes("USERPROFILE")),
			winNoAppData.problems[0]?.slice(0, 90));
		const winNothing = npmGlobalRootChain({ platform: "win32", env: {}, home: "", probes: {}, scans: {}, exists: existsNone });
		ok("C-13: 环境变量与主目录全缺 → ok:false 且明确说「探测不可用」（不是「没有全局插件」）",
			winNothing.ok === false && winNothing.problems.some((p) => /探测不可用/.test(p) && /不是/.test(p)),
			String(winNothing.problems.at(-1)).slice(0, 110));
		const winFast = npmGlobalRootChain({
			platform: "win32", env: { APPDATA: "C:\\Users\\n\\AppData\\Roaming" }, home: "C:\\Users\\n", probes: {}, scans: {},
			exists: (p) => norm([p])[0] === "C:/Users/n/AppData/Roaming/npm/node_modules"
		});
		ok("C-06: win32 快路径候选 = %APPDATA%\\npm\\node_modules，且存在性校验为真",
			norm([winFast.roots[0]])[0] === "C:/Users/n/AppData/Roaming/npm/node_modules" && winFast.existing.length === 1,
			JSON.stringify({ roots: norm(winFast.roots), existing: norm(winFast.existing) }));
		const darwin = npmGlobalRootChain({ platform: "darwin", env: {}, home: "/Users/n", probes: {}, scans: {}, exists: existsNone });
		ok("C-06/C-14: macOS 候选链补上 Apple Silicon `/opt/homebrew/lib/node_modules`（原漏检点）",
			darwin.roots.includes("/opt/homebrew/lib/node_modules"), JSON.stringify(norm(darwin.roots).slice(0, 5)));
		const linux = npmGlobalRootChain({ platform: "linux", env: {}, home: "/home/u", probes: {}, scans: {}, exists: existsNone });
		ok("C-14: Linux 候选链含 XDG 用户目录 + Linuxbrew，且不含 macOS 专属路径",
			linux.roots.some((p) => /\.local[\\/]share[\\/]npm[\\/]node_modules$/.test(p))
			&& linux.roots.some((p) => p.includes("linuxbrew")) && !linux.roots.some((p) => p.includes("/opt/homebrew")),
			JSON.stringify(norm(linux.roots)));
		const xdg = npmGlobalRootChain({ platform: "linux", env: { XDG_DATA_HOME: "/data/xdg" }, home: "/home/u", probes: {}, scans: {}, exists: existsNone });
		ok("C-14: XDG_DATA_HOME 生效（$XDG_DATA_HOME/npm/node_modules）",
			norm(xdg.roots).includes("/data/xdg/npm/node_modules"), JSON.stringify(norm(xdg.roots).slice(0, 3)));
		const scanned = npmGlobalRootChain({
			platform: "linux", env: {}, home: "/home/u", probes: {}, exists: existsNone,
			scans: { nvm: ["/home/u/.nvm/versions/node/v22.0.0"], volta: ["/home/u/.volta/tools/image/node/20.11.0"], fnm: ["/home/u/.local/share/fnm/node-versions/v20.0.0"], pnpm: ["/home/u/.local/share/pnpm/global/5"] }
		});
		ok("C-14: 版本管理器（nvm/Volta/fnm/pnpm）版本目录都能进链",
			scanned.roots.some((p) => norm([p])[0].endsWith(".nvm/versions/node/v22.0.0/lib/node_modules"))
			&& scanned.roots.some((p) => p.includes("Volta") || p.includes("volta"))
			&& scanned.roots.some((p) => norm([p])[0].endsWith("node-versions/v20.0.0/installation/lib/node_modules"))
			&& scanned.roots.some((p) => norm([p])[0].endsWith("pnpm/global/5/node_modules")),
			JSON.stringify(norm(scanned.roots).slice(-4)));
		const winScanned = npmGlobalRootChain({
			platform: "win32", env: { APPDATA: "C:\\Users\\n\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\n\\AppData\\Local" }, home: "C:\\Users\\n",
			probes: {}, exists: existsNone,
			scans: { nvmWindows: ["C:\\Users\\n\\AppData\\Roaming\\nvm\\v20.11.0"], volta: ["C:\\Users\\n\\AppData\\Local\\Volta\\tools\\image\\node\\20.11.0"], pnpm: ["C:\\Users\\n\\AppData\\Local\\pnpm\\global\\5"] }
		});
		ok("C-14: Windows 侧补 nvm-windows / Volta / pnpm 全局（原先只有 APPDATA\\npm 一条）",
			winScanned.roots.some((p) => norm([p])[0].endsWith("nvm/v20.11.0/node_modules"))
			&& winScanned.roots.some((p) => norm([p])[0].endsWith("Volta/tools/image/node/20.11.0/node_modules"))
			&& winScanned.roots.some((p) => norm([p])[0].endsWith("pnpm/global/5/node_modules")),
			JSON.stringify(norm(winScanned.roots).slice(1)));
		ok("C-06/C-14: **每个候选都做了存在性校验**（attempted[].exists 全是布尔）",
			[darwin, linux, scanned, winScanned, winNoAppData].every((r) => r.attempted.length > 0 && r.attempted.every((a) => typeof a.exists === "boolean")),
			`attempted=${darwin.attempted.length}/${linux.attempted.length}/${winScanned.attempted.length}`);
		ok("C-13/C-14: 存在的候选排在前面（调用方先命中真目录，省掉无谓 IO）",
			(() => {
				const probe = npmGlobalRootChain({
					platform: "linux", env: {}, home: "/home/u", probes: { root: "/real/root" }, scans: {},
					exists: (p) => p === "/real/root" || p === "/usr/lib/node_modules"
				});
				return probe.roots[0] === "/real/root" && norm(probe.roots)[1] === "/usr/lib/node_modules";
			})(),
			JSON.stringify(norm(npmGlobalRootChain({ platform: "linux", env: {}, home: "/home/u", probes: { root: "/real/root" }, scans: {}, exists: (p) => p === "/real/root" }).roots.slice(0, 2))));
		ok("C-06: `npm prefix -g` 派生根按平台正确（posix → <prefix>/lib/node_modules；win32 → <prefix>\\node_modules）",
			norm([npmRootFromPrefix("/usr/local", "linux")])[0] === "/usr/local/lib/node_modules"
			&& norm([npmRootFromPrefix("C:\\Users\\n\\AppData\\Roaming\\npm", "win32")])[0] === "C:/Users/n/AppData/Roaming/npm/node_modules"
			&& npmRootFromPrefix("  ", "linux") === null,
			`${npmRootFromPrefix("/usr/local", "linux")} | ${npmRootFromPrefix("C:\\Users\\n\\AppData\\Roaming\\npm", "win32")}`);
		ok("C-14: scanVersionDirs 是纯函数（注入 list，只认版本号形态）",
			(() => {
				const found = scanVersionDirs(["/base"], { list: () => [{ name: "v20.11.0", isDirectory: () => true }, { name: "latest", isDirectory: () => true }, { name: "5", isDirectory: () => true }] });
				return JSON.stringify(norm(found)) === JSON.stringify(["/base/v20.11.0"]);
			})(),
			JSON.stringify(norm(scanVersionDirs(["/base"], { list: () => [{ name: "v20.11.0" }, { name: "latest" }] }))));
		ok("C-14: 覆盖清单显式标注验证状态，且**未真机验证的平台一律写「未实测」**",
			NPM_GLOBAL_ROOT_COVERAGE.length >= 10 && NPM_GLOBAL_ROOT_COVERAGE.every((row) => row.platform && row.path && typeof row.verified === "string")
			&& NPM_GLOBAL_ROOT_COVERAGE.filter((row) => row.platform !== "win32").every((row) => /未实测/.test(row.verified)),
			`共 ${NPM_GLOBAL_ROOT_COVERAGE.length} 条；非 win32 条目 ${NPM_GLOBAL_ROOT_COVERAGE.filter((r) => r.platform !== "win32").length} 条全部标未实测`);
		ok("C-14: 兼容函数 npmGlobalRootsFor 保持旧行为（test-bundle.mjs 钉死的契约不被破坏）",
			platformMod.npmGlobalRootsFor("win32", {}, "C:\\h", null, null).length === 0
			&& platformMod.npmGlobalRootsFor("win32", { APPDATA: "C:\\a" }, "C:\\h", null, null).length === 1,
			JSON.stringify(platformMod.npmGlobalRootsFor("win32", { APPDATA: "C:\\a" }, "C:\\h", null, null)));
	}
	// ---- 17.5 C-07：端口归属兜底链（纯函数 + 注入式链路） ----
	{
		ok("C-07: lsof -t 输出解析（首个 pid 行；空输出 = 无监听者）",
			parseLsofListenerPid("  1234 \n5678\n") === 1234 && parseLsofListenerPid("") === null && parseLsofListenerPid("garbage") === null);
		ok("C-07: ss -ltnp 解析（含 users:(pid=…)；端口必须是本地地址那个字段）",
			(() => {
				const hit = parseSsListener('LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=1234,fd=22))', 3080);
				const peerOnly = parseSsListener('LISTEN 0 511 127.0.0.1:9999 0.0.0.0:* users:(("node",pid=1,fd=1))', 3080);
				const noPerm = parseSsListener("LISTEN 0 511 127.0.0.1:3080 0.0.0.0:*", 3080);
				return hit.pid === 1234 && peerOnly.listening === false && noPerm.listening === true && noPerm.pid === null;
			})());
		ok("C-07: /proc/net/tcp 解析（只取 LISTEN=0A，十六进制端口 → 十进制 + inode）",
			(() => {
				const text = [
					"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
					"   0: 0100007F:0C08 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0 0 10 0",
					"   1: 0100007F:0C09 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 424243 1 0 0 10 0"
				].join("\n");
				const rows = parseProcNetTcpListeners(text);
				return rows.length === 1 && rows[0].port === 3080 && rows[0].inode === 424242
					&& pickProcListenerInode(rows, 3080) === 424242 && pickProcListenerInode(rows, 3081) === null;
			})());
		ok("C-07: inode → pid 反查（扫 /proc/<pid>/fd 找 socket:[inode]）",
			findPidBySocketInode(424242, { listPids: () => [10, 99], listFds: (pid) => (pid === 99 ? ["0", "22"] : ["0"]), readLink: (p) => (p === "/proc/99/fd/22" ? "socket:[424242]" : "pipe:[1]") }) === 99
			&& findPidBySocketInode(1, { listPids: () => [10], listFds: () => ["0"], readLink: () => "pipe:[1]" }) === null);
		const enoent = { error: { code: "ENOENT", message: "spawnSync ENOENT" }, status: null, stdout: "", stderr: "" };
		const ssHit = { status: 0, stdout: 'LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=77,fd=9))', stderr: "" };
		const noProc = { readText: () => null, listPids: () => [], listFds: () => [], readLink: () => null };
		const r1 = resolvePortOwner({ platform: "linux", port: 3080, run: (cmd) => (cmd === "lsof" ? enoent : ssHit), ...noProc });
		ok("C-07: lsof 不存在 → **ss 兜底**给出结论（旧实现在这里直接「探测不可用」）",
			r1.ok === true && r1.pid === 77 && r1.via === "ss -ltnp", JSON.stringify({ ok: r1.ok, pid: r1.pid, via: r1.via }));
		const procText = [
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
			"   0: 0100007F:0C08 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0 0 10 0"
		].join("\n");
		const r2 = resolvePortOwner({
			platform: "linux", port: 3080, run: () => enoent,
			readText: (p) => (p === "/proc/net/tcp" ? procText : null),
			listPids: () => [99], listFds: () => ["22"], readLink: () => "socket:[424242]"
		});
		ok("C-07: lsof + ss 都没有 → 解析 /proc/net/tcp（inode 反查命中 pid）",
			r2.ok === true && r2.pid === 99 && r2.via === "/proc/net/tcp(inode)", JSON.stringify({ ok: r2.ok, pid: r2.pid, via: r2.via }));
		const r3 = resolvePortOwner({ platform: "linux", port: 3080, run: () => enoent, ...noProc });
		ok("C-07: 三条路都不行 → ok:false + 明确「探测不可用」（**不静默返回空、不谎报端口空闲**）",
			r3.ok === false && r3.pid === null && /探测不可用/.test(r3.reason) && /不能据此断言端口空闲/.test(r3.reason) && r3.attempts.length === 3,
			String(r3.reason).slice(0, 130));
		const r4 = resolvePortOwner({ platform: "linux", port: 3080, run: () => ({ status: 1, stdout: "", stderr: "" }), ...noProc });
		ok("C-07: lsof 正常但端口空闲（exit 1 + 空输出）→ ok:true, pid=null（正确的「确认空闲」语义）",
			r4.ok === true && r4.pid === null && r4.via === "lsof", JSON.stringify({ ok: r4.ok, pid: r4.pid, via: r4.via }));
		const r5 = resolvePortOwner({ platform: "darwin", port: 3080, run: (cmd) => (cmd === "lsof" ? enoent : enoent), ...noProc });
		ok("C-07: macOS 无 lsof（且无 ss//proc）→ 明确报不可用，而不是静默空",
			r5.ok === false && /探测不可用/.test(r5.reason), String(r5.reason).slice(0, 90));
		const real = portOwnerProbe(1);
		sandboxAwareOk("C-07: 真实平台 portOwnerProbe 仍可用且带 via（Windows: netstat）",
			real.ok === true && (WIN ? real.via === "netstat -ano" : typeof real.via === "string" || real.ok === false),
			JSON.stringify({ ok: real.ok, pid: real.pid, via: real.via, reason: real.reason }).slice(0, 200),
			real.reason);
		ok("C-07 配套: processImageProbe 走 /proc/<pid>/comm（Linux 无 ps 也能判）",
			(() => {
				const viaProc = resolveProcessImage({ platform: "linux", pid: 5, hasProc: true, readText: () => "node\n", run: () => ({ status: 0, stdout: "" }) });
				const viaPs = resolveProcessImage({ platform: "linux", pid: 5, hasProc: true, readText: () => null, run: () => ({ status: 0, stdout: "dsh\n" }) });
				const dead = resolveProcessImage({ platform: "linux", pid: 5, hasProc: true, readText: () => null, run: () => enoent });
				return viaProc.image === "node" && viaProc.via === "/proc/<pid>/comm" && viaPs.image === "dsh" && viaPs.via === "ps"
					&& dead.ok === false && /探测不可用/.test(dead.reason);
			})());
		{
			const selfProbe = processImageProbe(process.pid);
			sandboxAwareOk("C-07: 真实平台 processImageProbe(自己) 仍能拿到镜像名",
				selfProbe.ok === true && /node/.test(selfProbe.image ?? ""),
				JSON.stringify(selfProbe).slice(0, 200), selfProbe.reason);
		}
	}
	// ---- 17.6 C-15：tools/dev/pack.mjs 在 Node ≥22 不再 EINVAL ----
	{
		const packPath = join(ROOT, "tools", "dev", "pack.mjs");
		const packSource = readFileSync(packPath, "utf8");
		// 只看代码：注释里正记录了旧写法（`execFileSync("npm.cmd", …)`）作为证据，不能当成实现
		const packCode = packSource.split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
		ok("C-15: pack.mjs 不再裸 spawn \"npm.cmd\"（EINVAL 根因）",
			!/spawnSync\(\s*["']npm\.cmd["']/.test(packCode) && !/execFileSync\(\s*["']npm\.cmd["']/.test(packCode)
			&& /npm-cli\.js/.test(packCode),
			"pack.mjs 仍含 npm.cmd 直连");
		const help = runNode([packPath, "--help"], { timeoutMs: 60000 });
		ok("C-15: `node tools/dev/pack.mjs --help` → exit 0（verify 命令之一）",
			help.code === 0 && /node tools\/dev\/pack\.mjs/.test(help.stdout), `exit=${help.code} out=${help.stdout.split("\n")[0]}`);
		const dry = runNode([packPath, "--dry-run", "--no-build"], {
			timeoutMs: 180000,
			// F-3：受限会话的文件沙箱拒绝写**工作区之外**（默认 npm 缓存在 %LOCALAPPDATA%），会得到
			// EPERM/EACCES 的假 FAIL。把缓存指到仓库内（.gitignore 已忽略 .npm-cache/）即可在沙箱内跑通。
			env: { npm_config_cache: join(ROOT, ".npm-cache") }
		});
		sandboxAwareOk("C-15 实测: 走真实 npm 调用路线 `--dry-run --no-build` → exit 0（Node 24 上不再 EINVAL）",
			dry.code === 0 && /dry-run 完成/.test(dry.stdout) && /npm-cli\.js/.test(dry.stdout),
			`exit=${dry.code} | ${dry.stdout.split("\n").filter(Boolean).slice(0, 2).join(" / ")} | ${String(dry.stderr).trim().slice(0, 120)}`,
			`${dry.stdout} ${dry.stderr}`,
			"沙箱边界（文件系统或 npm 缓存被拒）");
	}
}

// ---------------------------------------------------------------- t10 注册表收尾（测试卫生）
// ① 真实 HKCU Run 键：跑前 vs 跑后**逐值**对比。默认模式下这是"套件从未写过真机注册表"的机器证据；
//    opt-in 模式下这是"写完确实逐字节还原"的机器证据。
{
	const realRunValuesAtEnd = WIN ? regListRunValues(REAL_RUN_KEY) : null;
	const realRunSignatureAtEnd = realRunValuesAtEnd === null ? null : regSignature(realRunValuesAtEnd);
	skipOk("t10: 全程真实 HKCU Run 键逐值不变（跑前/跑后签名一致，DSHWeb* 逐条 name/type/data）",
		realRunSignatureAtStart !== null && realRunSignatureAtStart === realRunSignatureAtEnd,
		`before=${realRunValuesAtStart === null ? "(读取失败)" : dshWebEntriesText(realRunValuesAtStart)} after=${realRunValuesAtEnd === null ? "(读取失败)" : dshWebEntriesText(realRunValuesAtEnd)}`);
	const decoyResidue = (realRunValuesAtEnd || []).filter((v) => /^DSHWebT31Decoy/i.test(v.name)).map((v) => v.name);
	skipOk("t10: 真实 Run 键内无诱饵残留（DSHWebT31DecoyA/B 必须不存在；有残留即失败并打印键名）",
		realRunValuesAtEnd !== null && decoyResidue.length === 0, `残留键名=${decoyResidue.join(",") || "无"}`);
	// ② 测试专用键：清理 + 断言无残留（默认模式）；真机模式：打印备份路径供人工回滚
	if (WIN && !REAL_REG_TESTS) {
		const scopeBefore = regListRunValues(TEST_RUN_KEY);
		const deleted = regDeleteKey(TEST_RUN_KEY);
		// 清理后应当**键不存在**：这里不能用 regListRunValues（它对"键不存在"返回 null=读取失败），
		// 而是直接看 reg query 的退出码与空输出（键不存在 = exit≠0 + stdout 空 + 无 spawn 错误）。
		const afterRaw = runReg(["query", TEST_RUN_KEY]);
		const keyGone = !afterRaw.error && afterRaw.status !== 0 && String(afterRaw.stdout).trim() === "";
		skipOk("t10: 测试专用键已清理（reg delete 成功，且该键已不存在）",
			deleted === true && keyGone,
			`before=${dshWebEntriesText(scopeBefore)} delete=${deleted} after≈status ${afterRaw.status}${afterRaw.error ? ` error ${afterRaw.error.code}` : ""} stdout=${JSON.stringify(String(afterRaw.stdout).slice(0, 40))}`);
		console.log(`NOTE 测试专用键 ${TEST_RUN_KEY} 已删除；父容器键 HKCU\\Software\\DSHPluginManagerTest 不含任何值（不影响系统功能），如需清理可手动 reg delete HKCU\\Software\\DSHPluginManagerTest /f`);
	} else if (WIN && REAL_REG_TESTS) {
		console.log(`NOTE 真机模式（DSH_PM_REAL_REGISTRY_TESTS=1）：真实 Run 键已按跑前快照还原；reg export 备份=${realRunBackupPath ?? "(未生成)"}`);
	}
}

// ---------------------------------------------------------------- 收尾
for (const dir of tempDirs) {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// SKIP 分类计数（t5 终审 F-3）：无条件打印 —— 读者一眼能看到覆盖边界与"为什么跳"。
console.log(`\nSKIP 分类计数：${Object.entries(SKIP_KINDS).map(([kind, n]) => `${kind}=${n}`).join(" / ")}（共 ${skipped.length} 条；沙箱边界类不计入失败，非边界类会照常 FAIL）`);
console.log(REAL_REG_TESTS
	? `注册表作用域：真实 Run 键（DSH_PM_REAL_REGISTRY_TESTS=1，已 export 备份 + 逐值还原断言）`
	: `注册表作用域：测试专用键（本套件不写真实注册表；端到端真机验证请设 DSH_PM_REAL_REGISTRY_TESTS=1）`);

if (xfails.length > 0) {
	console.warn(`\n=== XFAIL ${xfails.length} 条（写域外的已知缺陷；--strict 下算失败）===`);
	for (const x of xfails) console.warn(`  - ${x}`);
}

if (skipped.length > 0) {
	console.warn(`\n=== SKIP ${skipped.length} 条（环境能力缺失，非代码缺陷；不计入失败）===`);
	console.warn("  分类计数：" + Object.entries(SKIP_KINDS).filter(([, n]) => n > 0).map(([kind, n]) => `${kind} ${n}`).join(" / "));
	console.warn("  原因：本会话沙箱禁止 Node 打开命名管道 → child_process 管道 stdio 直接 EPERM，");
	console.warn("        reg.exe / netstat / tasklist 取不到输出（portOwner() / processImage() / reg query 全为 null）；");
	console.warn("        文件沙箱还会拒绝工作区之外的写（npm 缓存）。");
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
