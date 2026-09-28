/**
 * tools/test-host-fixes.mjs — host 侧 blocker（H1–H5）修复的独立回归/证据脚本。
 *
 * 覆盖：
 *   A. H5 参数引用单测：pnpm 调用的命令形态 + 含空格路径必须作为「单个」参数传递
 *   B. H4/H5 端到端（真 pnpm，独立 scratch profile）：
 *      - 合法 dsh 插件 tarball（文件名含空格）→ 安装成功（不再被拆参数/不再走 registry）
 *      - 无 dsh 清单的 tarball → 被拒 + 回滚（不落盘）+ 写 .failed stamp
 *      - .zip → 直接拒绝
 *      - 失败文件不会被重复重试（stamp 生效）
 *   C. 真引擎依赖契约（cordis 4.0.4 + cordis-plugin-loader 1.0.5，自动探测，探测不到则 SKIP）：
 *      - Entry 无 _disposing（H1 根因）
 *      - 真 fiber 的 _error 能变成非空错误文本（H2）
 *      - 真引擎不热重载 cordis.patch.yml → setEnabled 如实返回 restart-required（H1）
 *      - autoQuarantine 不会禁用 ui-* 关键条目（H3）
 *   D. 修复前后对比（若本机存在修复前的 profile 安装副本）：同一「已收敛」场景下
 *      旧版固定 restart-required，新版返回 changed。
 *
 * 用法：node tools/test-host-fixes.mjs
 * 环境变量：DSH_HOME（默认 ~/.dsh）、HOST_FIX_SCRATCH（默认 <os.tmpdir()>/dsh-pm-host-fix-scratch）、
 *           HOST_FIX_BASELINE（默认 <DSH_HOME>/profiles/web/node_modules/dsh-plugin-manager-pro/lib/index.js）
 * 写操作只发生在 scratch 目录（默认在系统临时目录，可被 env 覆盖）；不触碰真实 profile / 3080 / 3081。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const failures = [];
const ok = (cond, label) => {
	if (cond) console.log("OK:", label);
	else {
		failures.push(label);
		console.error("FAIL:", label);
	}
};
const skip = (label) => console.log("SKIP:", label);
const info = (label) => console.log("INFO:", label);

const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// 默认落系统临时目录（F2）：不再硬编码本机 rehearsal 路径；仍可用 env 覆盖以便在彩排环境跑。
const scratch = process.env.HOST_FIX_SCRATCH ?? join(tmpdir(), "dsh-pm-host-fix-scratch");
const stagingRoot = join(scratch, "downloads");
const profileA = join(scratch, "profile-a");
const profileB = join(scratch, "profile-b");

const { PluginManagerPro, __internals } = await import(pathToFileURL(join(repoRoot, "lib/index.js")).href);

/** 构造最小 ctx（与 test-integration.mjs 同款假对象）。 */
const makeCtx = (profileDir, entries = []) => ({
	loader: { ctx: { baseUrl: pathToFileURL(profileDir + "/").href }, entries: () => entries, resolve: (id) => entries.find((e) => e.id === id) },
	on: () => {},
	inject: (_servs, _okCb, failCb) => { if (typeof failCb === "function") failCb(); },
	logger: { info: () => {} },
	reflect: { provide: () => {} }
});

const writeProfile = (dir) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `dsh-profile-${dir.split(/[\\/]/).pop()}`, private: true, dsh: { profile: { bundles: [] } }, dependencies: {} }, null, 2) + "\n", "utf8");
	writeFileSync(join(dir, "cordis.patch.yml"), "# host-fix tool\n[]\n", "utf8");
};
const depsOf = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies ?? {};

// ---------- A. H5：参数引用单测 ----------
console.log("\n=== A. H5 pnpm 参数引用 ===");
const spec = __internals.pnpmSpawnSpec(["add", "C:/tmp/dl/my plugin 1.0.0.tgz"]);
info(`命令形态: ${spec.printable}`);
ok(spec.shell === false, "A: shell:false（不再用 Node 的裸拼接，也不再触发 DEP0190）");
ok(process.platform !== "win32" || /^cmd\.exe|\bcmd\.exe$/i.test(spec.command.split(/[\\/]/).pop()), "A: win32 下经 cmd.exe 调用（pnpm 是 .cmd，Node 24 不能直接 spawn）");
ok(spec.args.at(-1).includes('"C:/tmp/dl/my plugin 1.0.0.tgz"'), "A: 含空格路径被整体引用为单个参数");
ok(!spec.args.at(-1).includes("plugin 1.0.0.tgz\" "), "A: 未产生参数拆分（无裸空格分隔）");
let rejectedPercent = false;
try {
	__internals.pnpmSpawnSpec(["add", "C:/tmp/100%/x.tgz"]);
} catch {
	rejectedPercent = true;
}
ok(rejectedPercent, "A: 含 % 的参数直接拒绝（cmd 会做变量展开，不做静默改写）");

// ---------- B. H4/H5：真 pnpm 端到端 ----------
console.log("\n=== B. H4/H5 下载目录安装（真 pnpm） ===");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });
writeProfile(profileA);
writeProfile(profileB);
process.env.DSH_HOME = scratch;

/**
 * 用 npm pack 现场生成夹具 tarball（不依赖仓库里的历史 tgz）。
 * npm 在 Windows 上同样是 .cmd：经 cmd.exe 调用（与 H5 修复同一手法）；npm 不可用时
 * 用 tar 手工构造 npm-pack 布局（package/ 前缀）兜底。
 */
const packFixture = (name, manifest, extraFiles = {}) => {
	const dir = join(scratch, "fixtures", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
	for (const [file, content] of Object.entries(extraFiles)) writeFileSync(join(dir, file), content, "utf8");
	try {
		const out = process.platform === "win32"
			? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm pack "${dir}" --pack-destination "${stagingRoot}"`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
			: execFileSync("npm", ["pack", dir, "--pack-destination", stagingRoot], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const line = out.trim().split(/\r?\n/).filter((l) => l.trim() !== "").at(-1).trim();
		if (line !== "" && existsSync(join(stagingRoot, line))) return line;
	} catch { /* 落到 tar 兜底 */ }
	const layout = join(scratch, "fixtures", `${name}-layout`, "package");
	mkdirSync(layout, { recursive: true });
	writeFileSync(join(layout, "package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
	for (const [file, content] of Object.entries(extraFiles)) writeFileSync(join(layout, file), content, "utf8");
	const tarball = `${manifest.name}-${manifest.version}.tgz`;
	execFileSync("tar", ["-czf", join(stagingRoot, tarball), "-C", join(scratch, "fixtures", `${name}-layout`), "package"], { stdio: ["ignore", "pipe", "pipe"] });
	return tarball;
};

let fixturesReady = true;
let legalName = null;
let spaceName = "with space host-fix-legal.tgz";
try {
	// 合法夹具：声明 dsh.bundle（与 marketInstall 的校验口径一致）
	legalName = packFixture("host-fix-legal", { name: "host-fix-legal", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }, { "cordis.patch.yml": "[]\n" });
} catch (error) {
	fixturesReady = false;
	skip(`B: npm pack 不可用（${error instanceof Error ? error.message.split("\n")[0] : String(error)}），跳过真 pnpm 用例`);
}

if (fixturesReady && legalName !== null) {
	copyFileSync(join(stagingRoot, legalName), join(stagingRoot, spaceName));
	const svcB = new PluginManagerPro(makeCtx(profileB), { protectedEntries: [], settleTimeoutMs: 300 });
	const resSpace = await svcB.checkDownloads();
	info(`B(空格名) 安装结果: ${JSON.stringify({ installed: resSpace.installed, failed: resSpace.failed })}`);
	ok(resSpace.installed.includes(spaceName), "B/H5: 含空格文件名的 dsh 插件 tarball 安装成功（修复前会被拆参数并转向 registry）");
	ok(depsOf(profileB)["host-fix-legal"] !== undefined, "B/H5: 依赖已写入 scratch profile");
	ok(!JSON.stringify(resSpace.failed).includes("registry.npmjs.org"), "B/H5: 失败信息中不再出现 registry 解析同名包");
	ok(existsSync(join(stagingRoot, `.${spaceName}.installed`)), "B/H5: 成功文件写下 .installed stamp");

	// 关键回归：装完后 profile 仍可正常 pnpm install（依赖里不得留悬空的 file:<临时路径>）
	const reinstall = process.platform === "win32"
		? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm install"], { cwd: profileB, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
		: execFileSync("pnpm", ["install"], { cwd: profileB, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	info(`B(重装) pnpm install 退出正常: ${String(reinstall).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ""}`);
	ok(true, "B/H4: 安装后 profile 仍可 pnpm install（无悬空 file: 依赖）");
	const specOfLegal = depsOf(profileB)["host-fix-legal"];
	const stagedFile = typeof specOfLegal === "string" ? specOfLegal.replace(/^file:/, "") : "";
	ok(
		typeof specOfLegal === "string" && /vendor[\\/]downloads[\\/]/.test(stagedFile) && existsSync(stagedFile),
		`B/H4: 依赖 spec 指向 profile 内稳定路径且文件仍在（${specOfLegal}）`
	);

	// 非法包：合法 npm 包但未声明 dsh 清单 -> 拒绝 + 回滚 + .failed stamp
	const badTarball = packFixture("host-fix-not-a-plugin", { name: "host-fix-not-a-plugin", version: "1.0.0", description: "no dsh manifest" });
	if (badTarball !== null) {
		const beforePatch = readFileSync(join(profileA, "cordis.patch.yml"), "utf8");
		const svcA = new PluginManagerPro(makeCtx(profileA), { protectedEntries: [], settleTimeoutMs: 300 });
		const resBad = await svcA.checkDownloads();
		info(`B(无清单) 安装结果: ${JSON.stringify({ installed: resBad.installed, failed: resBad.failed })}`);
		ok(resBad.installed.length === 0, "B/H4: 无 dsh 清单的 tarball 未被计入 installed");
		ok(resBad.failed.some((f) => f.name === badTarball && /dsh/.test(f.message)), "B/H4: 拒绝原因明确提到缺少 dsh 清单");
		ok(depsOf(profileA)["host-fix-not-a-plugin"] === undefined, "B/H4: 拒绝后依赖未落盘（已回滚）");
		ok(!existsSync(join(profileA, "node_modules", "host-fix-not-a-plugin")), "B/H4: 拒绝后 node_modules 无残留");
		ok(existsSync(join(stagingRoot, `.${badTarball}.failed`)), "B/H4: 写下 .failed stamp");
		ok(readFileSync(join(profileA, "cordis.patch.yml"), "utf8") === beforePatch, "B/H4: 回滚未破坏 cordis.patch.yml");
		const again = await svcA.checkDownloads();
		ok(again.failed.length === 0 && again.installed.length === 0, "B/H4: .failed stamp 生效，不再每次重试");
	}

	// .zip 直接拒绝
	writeFileSync(join(stagingRoot, "some-archive.zip"), "PK\u0003\u0004not-a-tarball", "utf8");
	const svcZip = new PluginManagerPro(makeCtx(profileA), { protectedEntries: [], settleTimeoutMs: 300 });
	const resZip = await svcZip.checkDownloads();
	ok(resZip.installed.length === 0 && resZip.failed.some((f) => f.name === "some-archive.zip"), "B/H4: .zip 被拒绝而非直装");
}

// ---------- C. 真引擎依赖契约 ----------
console.log("\n=== C. 真引擎（cordis 4.0.4 + loader 1.0.5）契约 ===");
const engineCandidates = [
	process.env.DSH_REAL_MODULES,
	join(dshHome, "profiles", "node_modules", "@deepseek-ai"),
	process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai") : null
].filter(Boolean);
const engineModules = engineCandidates.find((dir) => existsSync(join(dir, "cordis", "lib", "index.js")) && existsSync(join(dir, "cordis-plugin-loader", "lib", "index.js")));
if (engineModules === undefined) {
	skip(`C: 未找到引擎依赖（尝试过 ${engineCandidates.join(" | ")}）`);
} else {
	info(`C: 使用引擎依赖 ${engineModules}`);
	const engineDir = join(scratch, "engine");
	mkdirSync(engineDir, { recursive: true });
	writeFileSync(join(engineDir, "ok-plugin.mjs"), 'export const name = "ok";\nexport function apply() {}\n', "utf8");
	writeFileSync(join(engineDir, "bad-plugin.mjs"), 'export const name = "bad";\nexport function apply() { throw new Error("host-fix: intentional startup failure"); }\n', "utf8");
	writeFileSync(join(engineDir, "ui-bad-plugin.mjs"), 'export const name = "ui-bad";\nexport function apply() { throw new Error("host-fix: ui plugin startup failure"); }\n', "utf8");
	writeFileSync(join(engineDir, "plain-bad-plugin.mjs"), 'export const name = "plain-bad";\nexport function apply() { throw new Error("host-fix: plain plugin startup failure"); }\n', "utf8");
	const { Context } = await import(pathToFileURL(join(engineModules, "cordis", "lib", "index.js")).href);
	const { default: Loader } = await import(pathToFileURL(join(engineModules, "cordis-plugin-loader", "lib", "index.js")).href);
	const realCtx = new Context();
	realCtx.baseUrl = pathToFileURL(engineDir + "/").href;
	try {
		await realCtx.plugin(Loader, { baseUrl: realCtx.baseUrl });
	} catch (error) {
		info(`C: loader 启动异常 ${error instanceof Error ? error.message : String(error)}`);
	}
	await realCtx.get("loader").root.update([
		{ id: "ok-entry", name: "./ok-plugin.mjs" },
		{ id: "bad-entry", name: "./bad-plugin.mjs" },
		{ id: "ui-layout", name: "./ui-bad-plugin.mjs" },
		{ id: "plain-bad", name: "./plain-bad-plugin.mjs" }
	]);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const okEntry = realCtx.get("loader").entries().find((e) => e.options.id === "ok-entry");
	const badFiber = realCtx.get("loader").entries().find((e) => e.options.id === "bad-entry")?.fiber;
	ok("_disposing" in okEntry === false, `C/H1: 真 Entry 无 _disposing（字段=${Object.keys(okEntry).join(",")}）`);
	const realMgr = realCtx.plugin(PluginManagerPro, { protectedEntries: [], settleTimeoutMs: 800 });
	try {
		await realMgr;
	} catch (error) {
		info(`C: 管理器挂载异常 ${error instanceof Error ? error.message : String(error)}`);
	}
	const realSvc = realCtx.get("pluginManagerPro");
	if (realSvc === undefined) {
		ok(false, "C: 真 ctx 上未注册 pluginManagerPro 服务");
	} else {
		const realIssues = realSvc.diagnose().issues;
		const badReport = realIssues.find((i) => i.configId === "bad-entry");
		ok(badReport !== undefined && typeof badReport.error === "string" && badReport.error.includes("intentional startup failure"), `C/H2: 真 fiber 的 _error 变成非空错误文本（${badReport?.error}）`);
		ok(badFiber?._error instanceof Error && realSvc.snapshot().entries.find((e) => e.configId === "bad-entry")?.error !== null, "C/H2: 投影 error 非空（真引擎）");
		const t0 = Date.now();
		const realRes = await realSvc.setEnabled("ok-entry", false);
		const ms = Date.now() - t0;
		info(`C: 真引擎 setEnabled -> status=${realRes.items[0].status} ${ms}ms`);
		ok(realRes.items[0].status === "restart-required", `C/H1: 不热重载的引擎如实报 restart-required（不再因 _disposing 而被误判）`);
		ok(ms < 2500, `C/H1: 判定耗时受 settleTimeoutMs 约束（${ms}ms < 2500ms）`);
		ok(typeof realRes.items[0].message === "string" && realRes.items[0].message.includes("重启"), "C/H1: 返回可执行的说明");
		// H3：真引擎 ctx 上自动隔离不碰 ui-*（用真实失败 fiber 触发 internal/plugin）
		await realSvc.setRescueConfig({ autoQuarantine: true });
		const uiPatch = join(engineDir, "cordis.patch.yml");
		const uiEntry = realCtx.get("loader").entries().find((e) => e.options.id === "ui-layout");
		const plainEntry = realCtx.get("loader").entries().find((e) => e.options.id === "plain-bad");
		ok(uiEntry?.fiber?.state === 3, `C/H3: ui-layout 真 fiber 状态为 failed（state=${uiEntry?.fiber?.state}）`);
		// 让 autoQuarantine 看到真实失败（重挂同一条目会再次 emit internal/plugin）
		await realCtx.get("loader").root.update([
			{ id: "ok-entry", name: "./ok-plugin.mjs" },
			{ id: "bad-entry", name: "./bad-plugin.mjs" },
			{ id: "ui-layout", name: "./ui-bad-plugin.mjs" },
			{ id: "plain-bad", name: "./plain-bad-plugin.mjs" }
		]);
		await new Promise((resolve) => setTimeout(resolve, 400));
		const patchText = existsSync(uiPatch) ? readFileSync(uiPatch, "utf8") : "";
		ok(!/ui-layout/.test(patchText), "C/H3: 真引擎 ctx 上 ui-* 失败未被写禁用行（受保护）");
		ok(realSvc.snapshot().entries.some((e) => e.configId === "ui-layout" && e.protected === true), "C/H3: ui-layout 仍被投影为 protected（界面自救入口保留）");
		info(`C/H3: plain-bad 失败计数=${JSON.stringify((JSON.parse(readFileSync(join(engineDir, "plugin-manager.json"), "utf8"))).failureStreak ?? null)}；ui-layout 是否写入 patch=${/ui-layout/.test(patchText)}`);
		ok(plainEntry !== undefined, "C: plain-bad 条目存在（非保护对照）");
	}
}

// ---------- D. 修复前后对比 ----------
console.log("\n=== D. 修复前后对比（同一「已收敛」场景） ===");
const baselinePath = process.env.HOST_FIX_BASELINE ?? join(dshHome, "profiles", "web", "node_modules", "dsh-plugin-manager-pro", "lib", "index.js");
const repoIndex = join(repoRoot, "lib", "index.js");
const sameFile = existsSync(baselinePath) && readFileSync(baselinePath, "utf8") === readFileSync(repoIndex, "utf8");
if (!existsSync(baselinePath) || sameFile) {
	skip(`D: 无修复前副本可比（${baselinePath}${sameFile ? " 与仓库版本相同" : " 不存在"}）`);
} else {
	const beforeMod = await import(pathToFileURL(baselinePath).href);
	const scenario = async (Cls, label) => {
		const dir = join(scratch, `cmp-${label}`);
		writeProfile(dir);
		const patchFile = join(dir, "cordis.patch.yml");
		const rowOf = (configId) => {
			const text = readFileSync(patchFile, "utf8");
			return new RegExp(`id:\\s*${configId}[\\s\\S]*?disabled:\\s*true`).test(text);
		};
		const entry = { id: "cmp-1", options: { id: "cmp-plugin", name: "dsh-demo" }, fiber: undefined, _initTask: undefined, parent: { ctx: { fiber: { entry: undefined } } } };
		Object.defineProperty(entry, "disabled", { get: () => rowOf("cmp-plugin"), configurable: true });
		const svc = new Cls(makeCtx(dir, [entry]), { protectedEntries: [], settleTimeoutMs: 2000 });
		const t = Date.now();
		const res = await svc.setEnabled("cmp-1", false);
		return { status: res.items[0].status, ms: Date.now() - t, patchRowWritten: rowOf("cmp-plugin") };
	};
	const before = await scenario(beforeMod.PluginManagerPro, "before");
	const after = await scenario(PluginManagerPro, "after");
	info(`D: 修复前 status=${before.status} ${before.ms}ms（patch 已写入=${before.patchRowWritten}）`);
	info(`D: 修复后 status=${after.status} ${after.ms}ms（patch 已写入=${after.patchRowWritten}）`);
	ok(before.patchRowWritten === true, "D: 修复前 patch 行同样写入了（证明旧状态是谎报）");
	ok(after.status === "changed" && after.ms < before.ms, "D: 修复后同一场景返回 changed 且明显更快");
}

// ---------- E. 机器路径归零（全目录扫描，含未跟踪文件） ----------
// 取代旧的 `git grep` 口径：git grep 只看已跟踪文件，会漏掉新增/未纳管文件（F2 实测漏检）。
console.log("\n=== E. 机器路径归零（全目录扫描，含未跟踪文件） ===");
const USER_NAME = basename(homedir());
/** 占位/示例用户名（文档与单测夹具里的合法写法）。 */
const PLACEHOLDER = /^(x|u|user|you|yourname|<[^>]*>|%USERNAME%|\$\{[^}]*\}|张三|李四|demo|test)$/i;
const TEXT_EXT = /\.(mjs|cjs|js|json|md|ps1|cmd|bat|vbs|yml|yaml|ts|tsx|jsx|html|txt)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".e2e"]);
const TEAM_ARTIFACTS = /[\\/]tools[\\/]dev[\\/]artifacts[\\/]/i;
// 历史机器标识（拼接构造：避免本扫描器把自己的检测串当成命中）
const LEGACY_USER = `35${"129"}`;

const machinePathHits = [];
let scannedFiles = 0;
const scanDir = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			scanDir(full);
			continue;
		}
		if (!TEXT_EXT.test(entry.name) || TEAM_ARTIFACTS.test(full)) continue;
		let text = "";
		try {
			text = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		scannedFiles += 1;
		text.split(/\r?\n/).forEach((line, index) => {
			const flags = [];
			for (const match of line.matchAll(/[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'`)]+)/g)) {
				if (!PLACEHOLDER.test(match[1]) && match[1].toLowerCase() === USER_NAME.toLowerCase()) flags.push(`windowsUserPath:${match[1]}`);
			}
			for (const match of line.matchAll(/\/(?:Users|home)\/([^/\s"'`)]+)/g)) {
				if (!PLACEHOLDER.test(match[1]) && match[1].toLowerCase() === USER_NAME.toLowerCase()) flags.push(`posixUserPath:${match[1]}`);
			}
			if (line.includes(LEGACY_USER)) flags.push(`legacyUser:${LEGACY_USER}`);
			if (flags.length > 0) machinePathHits.push(`${relative(repoRoot, full).replace(/\\/g, "/")}:${index + 1} [${[...new Set(flags)].join(",")}] ${line.trim().slice(0, 120)}`);
		});
	}
};
scanDir(repoRoot);
info(`E: 扫描 ${scannedFiles} 个文本文件（含未跟踪文件；跳过 .git/node_modules/.e2e 与 tgz 制品），当前用户名=${USER_NAME}`);
for (const hit of machinePathHits.slice(0, 20)) info(`E: 命中 ${hit}`);
ok(machinePathHits.length === 0, `E: 全目录（含未跟踪文件）无本机用户路径/遗留机器标识（命中 ${machinePathHits.length} 处）`);

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? "ALL HOST-FIX TESTS PASSED" : `HOST-FIX FAILED (${failures.length}):\n - ${failures.join("\n - ")}`}`);
if (failures.length > 0) process.exit(1);
