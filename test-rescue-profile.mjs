// test-rescue-profile.mjs — S5：救援 profile（官方通道）+ 官方恢复后自愈的可复跑测试
// 用法: node test-rescue-profile.mjs [--keep]
//
// 风格对齐 test-bundle.mjs / test-render.mjs：逐条断言 + `RESULT: PASS|FAIL` 行，退出码 0/1。
// **绝不真跑 dsh**：救援命令一律注入假 `run`，断言命令行拼对了；bin 端到端只用
// 「desktop 场景（必然被安全门拒绝）」或「--dsh 指向不存在的命令（必然 spawn 失败）」来验证分支。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyProfile } from "./lib/preflight.mjs";
import {
	OWNER_MARKER,
	__internals,
	buildRescueProfile,
	detectOfficialRecoveryTraces,
	isEmptyPatch,
	parseBackupTimestamp,
	planSelfHeal,
	resolveDshHome,
	selfHealAfterRecovery,
	stripBom
} from "./lib/rescue-profile.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BIN = join(ROOT, "bin", "dsh-boot.mjs");
const KEEP = process.argv.includes("--keep");
const TEMPS = [];
let assertionCount = 0;

//#region 夹具与断言工具
function tempDir(prefix = "dsh-s5-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	TEMPS.push(dir);
	return dir;
}

function writeText(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
}

function readText(path) {
	return readFileSync(path, "utf8");
}

/** 整个目录的内容哈希（相对路径 + 原始字节）——用来证明「一行都没写」。 */
function dirHash(root) {
	if (!existsSync(root)) return "missing";
	const parts = [];
	const walk = (dir, rel) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			const relPath = rel === "" ? name : `${rel}/${name}`;
			const stat = statSync(full);
			if (stat.isDirectory()) walk(full, relPath);
			else parts.push(`${relPath}\u0000${readFileSync(full).toString("base64")}`);
		}
	};
	walk(root, "");
	return createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

// YAML 夹具：值一律用 JSON 双引号形式（`@deepseek-ai/...` 这类以 @ 开头的裸标量在 YAML 里非法）
const OWNED_ROW = (id, name, disabled = true) =>
	`# ${OWNER_MARKER}\n- id: ${JSON.stringify(id)}\n  name: ${JSON.stringify(name)}\n  disabled: ${String(disabled)}\n`;
const USER_ROW = (id, name, disabled = true) =>
	`- id: ${JSON.stringify(id)}\n  name: ${JSON.stringify(name)}\n  disabled: ${String(disabled)}\n`;

/** 侧车 v2 夹具：一条 patch-state 历史记录 + 一个只有 configId 的场景（故意留成「恢复不了」的那类）。 */
function sidecarFixture({ history = true, scenarios = true } = {}) {
	return {
		version: 2,
		sources: [{ name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, type: "registry" }],
		rescue: { autoQuarantine: true },
		overrides: { source: { dshmarket: "npm" } },
		history: history
			? [{
				id: "h-1",
				at: "2026-11-20T10:00:00.000Z",
				action: "toggle",
				label: "停用 dsh-free-search",
				detail: "",
				result: "ok",
				undone: false,
				undo: {
					type: "patch-state",
					manifest: null,
					patch: null,
					packageName: null,
					spec: null,
					changes: [{ configId: "free-search", moduleName: "dsh-free-search", enabled: false }]
				}
			}]
			: [],
		scenarios: scenarios
			? [{ id: "s-1", name: "省电模式", createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z", states: { "vision-router": true, "ui-trajectory": false } }]
			: [],
		pendingRemovals: [],
		failureStreak: {}
	};
}

/**
 * 造一个 profile 目录（fixture）。
 * @param {object} [options]
 * @param {string} [options.profileName] 目录名（desktop / web / rescue…）
 * @param {string} [options.home] 复用同一个 DSH_HOME
 * @param {string|null} [options.patch] cordis.patch.yml 内容（null = 不建）
 * @param {object} [options.extra] 额外文件（相对 profileDir 的文件名 → 内容）
 * @param {string[]} [options.bundles] package.json 的 dsh.profile.bundles
 * @param {boolean} [options.lock] 是否建 profiles/<name>/lock
 */
function makeProfile({ profileName = "web", home = null, patch = null, extra = {}, bundles = [], lock = false } = {}) {
	const root = home ?? tempDir();
	const dir = join(root, "profiles", profileName);
	mkdirSync(dir, { recursive: true });
	writeText(join(dir, "package.json"), JSON.stringify({
		name: `dsh-profile-${profileName}`,
		version: "0.0.0",
		private: true,
		dsh: { profile: { bundles } }
	}, null, 2) + "\n");
	if (patch !== null) writeText(join(dir, "cordis.patch.yml"), patch);
	if (lock) writeText(join(dir, "lock"), JSON.stringify({ pid: 1234, startedAt: "2026-11-26T00:00:00.000Z" }));
	for (const [name, content] of Object.entries(extra)) writeText(join(dir, name), content);
	return { home: root, dir, patchPath: join(dir, "cordis.patch.yml") };
}

function makeChecks(section) {
	const problems = [];
	const check = (name, condition, detail = "") => {
		assertionCount += 1;
		if (condition !== true) problems.push(`${name}${detail ? `（实际：${detail}）` : ""}`);
	};
	const checkEqual = (name, actual, expected) => {
		assertionCount += 1;
		if (actual !== expected) problems.push(`${name}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
	};
	const finish = () => {
		if (problems.length > 0) {
			console.error(`RESULT: FAIL - ${section}`);
			for (const problem of problems) console.error(` - ${problem}`);
			cleanup();
			process.exit(1);
		}
		console.log(`RESULT: PASS - ${section}`);
	};
	return { check, checkEqual, finish };
}

function cleanup() {
	if (KEEP) { console.log(`（--keep：临时目录保留在 ${TEMPS.join(", ")}）`); return; }
	for (const dir of TEMPS) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
	}
}

/** 跑一个短命子进程：输出重定向到临时文件（不用管道——受限会话里管道 stdio 会 EPERM）。 */
function runNode(args, { env = {}, timeoutMs = 60000 } = {}) {
	const dir = tempDir("dsh-s5-run-");
	const out = join(dir, "out.log");
	const err = join(dir, "err.log");
	const fdOut = openSync(out, "w");
	const fdErr = openSync(err, "w");
	const base = { ...process.env };
	for (const key of ["DSH_LAUNCHER_IMPORT_ONLY", "DSH_HOME", "DSH_ENGINE_PORT"]) delete base[key];
	const result = spawnSync(process.execPath, args, {
		cwd: ROOT,
		env: { ...base, ...env },
		stdio: ["ignore", fdOut, fdErr],
		windowsHide: true,
		timeout: timeoutMs
	});
	closeSync(fdOut);
	closeSync(fdErr);
	return {
		code: result.status,
		signal: result.signal,
		stdout: existsSync(out) ? readText(out) : "",
		stderr: existsSync(err) ? readText(err) : ""
	};
}

try {
	//#region 0) 基础工具（BOM / 空 patch / 时间戳 / DSH_HOME）
	{
		const { check, checkEqual, finish } = makeChecks("0) 基础工具：BOM / 空 patch / 备份时间戳 / DSH_HOME 解析");
		const bom = stripBom("\uFEFF[]\n");
		checkEqual("stripBom 报告 BOM", bom.hadBom, true);
		checkEqual("stripBom 剥离 BOM", bom.text, "[]\n");
		checkEqual("无 BOM 时 hadBom=false", stripBom("[]\n").hadBom, false);

		checkEqual("0 字节算空 patch", isEmptyPatch(""), true);
		checkEqual("只有换行算空 patch", isEmptyPatch("\n\n"), true);
		checkEqual("只有注释算空 patch", isEmptyPatch("# 注释\n# 又一行\n"), true);
		checkEqual("[] 算空 patch", isEmptyPatch("[]\n"), true);
		checkEqual("BOM + [] 算空 patch", isEmptyPatch("\uFEFF[]\n"), true);
		checkEqual("非空 patch 不算空", isEmptyPatch(OWNED_ROW("a", "b")), false);

		const epoch = parseBackupTimestamp("1764000000000");
		check("13 位时间戳解析成 ISO", typeof epoch.iso === "string" && epoch.iso.startsWith("2025-"), String(epoch.iso));
		checkEqual("10 位时间戳按秒解析", parseBackupTimestamp("1764000000").value, 1764000000000);
		checkEqual("非数字时间戳不炸", parseBackupTimestamp("不是时间").value, null);

		const home = tempDir("dsh-s5-home-");
		const explicit = resolveDshHome({ dshHome: home, env: { DSH_HOME: join(home, "other") } });
		checkEqual("显式 dshHome 优先于环境变量", explicit.home, home);
		const byEnv = resolveDshHome({ env: { DSH_HOME: join(home, "env-home") } });
		checkEqual("环境变量 DSH_HOME 次之", byEnv.home, join(home, "env-home"));
		const byProfile = resolveDshHome({ env: {}, profileDir: join(home, "profiles", "web") });
		checkEqual("由 profile 目录推导 DSH_HOME", byProfile.home, home);
		finish();
	}
	//#endregion

	//#region 1) buildRescueProfile：dryRun 只给命令（官方 help 的用法，逐字一致）
	{
		const { check, checkEqual, finish } = makeChecks("1) buildRescueProfile：dryRun 的命令串精确等于官方 help 示例，且不执行");
		const home = tempDir("dsh-s5-home-");
		const calls = [];
		const result = await buildRescueProfile({
			dshHome: home,
			dryRun: true,
			run: (options) => { calls.push(options); return 0; }
		});
		checkEqual("命令精确等于 dsh rescue --from-default-profile web", result.command, "dsh rescue --from-default-profile web");
		checkEqual("ok=true", result.ok, true);
		checkEqual("code=dry-run", result.code, "dry-run");
		checkEqual("dryRun 下 executed=false", result.executed, false);
		checkEqual("dryRun 下 run 一次都没调用", calls.length, 0);
		checkEqual("目标 profile 名", result.profileName, "rescue");
		checkEqual("目标 profile 目录", result.profileDir, join(home, "profiles", "rescue"));
		checkEqual("模板", result.sourceTemplate, "web");
		check("steps 逐条可读（≥4 条）", Array.isArray(result.steps) && result.steps.length >= 4, String(result.steps?.length));
		check("steps 里明确写了命令", result.steps.some((step) => step.includes("dsh rescue --from-default-profile web")));
		check("steps 里明确写了不碰 desktop", result.steps.some((step) => step.includes("desktop")));
		check("reason 说明走官方通道", typeof result.reason === "string" && result.reason.includes("官方"), String(result.reason));
		check("dryRun 没在磁盘上建 profile 目录", !existsSync(join(home, "profiles", "rescue")));
		finish();
	}
	//#endregion

	//#region 2) buildRescueProfile：注入 run 后真正「执行」（绝不真跑 dsh）
	{
		const { check, checkEqual, finish } = makeChecks("2) buildRescueProfile：注入的 run 收到正确 argv（不真跑 dsh）");
		const home = tempDir("dsh-s5-home-");
		const calls = [];
		const result = await buildRescueProfile({
			dshHome: home,
			dshCmd: "dsh",
			extraArgs: ["--port", "3080", "--no-open"],
			dryRun: false,
			run: (options) => { calls.push(options); return { ok: true, pending: true, pid: 4321, logPath: join(home, "logs", "rescue.log") }; }
		});
		checkEqual("run 被调用一次", calls.length, 1);
		checkEqual("argv 形如 [<profile>, --from-default-profile, <template>, ...extra]", JSON.stringify(calls[0]?.argv), JSON.stringify(["rescue", "--from-default-profile", "web", "--port", "3080", "--no-open"]));
		check("command 以官方主体开头", result.command.startsWith("dsh rescue --from-default-profile web"), result.command);
		checkEqual("ok=true", result.ok, true);
		checkEqual("code=booting（detached 启动，就绪由调用方判）", result.code, "booting");
		checkEqual("executed=true", result.executed, true);
		checkEqual("pid 透传", result.pid, 4321);
		checkEqual("run 收到 dshHome", calls[0]?.dshHome, home);
		checkEqual("run 收到 profileDir", calls[0]?.profileDir, join(home, "profiles", "rescue"));

		const failed = await buildRescueProfile({ dshHome: home, dryRun: false, run: () => 1 });
		checkEqual("run 返回非 0 时 ok=false", failed.ok, false);
		checkEqual("run 返回非 0 时 code=boot-exit", failed.code, "boot-exit");
		checkEqual("退出码透传", failed.exitCode, 1);

		const thrown = await buildRescueProfile({ dshHome: home, dryRun: false, run: () => { throw new Error("假装 spawn 失败"); } });
		checkEqual("run 抛错时 code=spawn-failed", thrown.code, "spawn-failed");
		check("run 抛错时 reason 含原因", String(thrown.reason).includes("假装 spawn 失败"), String(thrown.reason));
		finish();
	}
	//#endregion

	//#region 3) buildRescueProfile：安全门（desktop 拒绝 / 未知模板）
	{
		const { check, checkEqual, finish } = makeChecks("3) buildRescueProfile：desktop 拒绝 + 未知模板拒绝（都不执行）");
		const home = tempDir("dsh-s5-home-");
		const calls = [];
		const desktop = await buildRescueProfile({ dshHome: home, profileName: "desktop", dryRun: false, run: (options) => { calls.push(options); return 0; } });
		checkEqual("desktop 时 ok=false", desktop.ok, false);
		checkEqual("desktop 时 code=desktop-delegated", desktop.code, "desktop-delegated");
		checkEqual("desktop 时没有 spawn", calls.length, 0);
		check("desktop 时 reason 提到 Electron 或托盘", String(desktop.reason).includes("Electron") || String(desktop.reason).includes("托盘"), String(desktop.reason));

		const badTemplate = await buildRescueProfile({ dshHome: home, sourceTemplate: "rescue", dryRun: false, run: (options) => { calls.push(options); return 0; } });
		checkEqual("未知模板时 code=unknown-template", badTemplate.code, "unknown-template");
		checkEqual("未知模板时没有 spawn", calls.length, 0);
		check("未知模板时 reason 指出现有模板（没有 rescue 模板）", String(badTemplate.reason).includes("没有 rescue 模板"), String(badTemplate.reason));
		finish();
	}
	//#endregion

	//#region 4) detectOfficialRecoveryTraces：空 patch + .bak-<ts> → detected
	{
		const { check, checkEqual, finish } = makeChecks("4) detectOfficialRecoveryTraces：空 patch + cordis.patch.yml.bak-<ts> → detected:true 且 evidence 指向具体文件");
		const stamp = "1764000000000";
		const bakName = `cordis.patch.yml.bak-${stamp}`;
		const fixture = makeProfile({
			profileName: "web",
			patch: "[]\n",
			bundles: ["@deepseek-ai/dsh-base"],
			extra: { [bakName]: OWNED_ROW("free-search", "dsh-free-search") }
		});
		writeText(join(fixture.dir, "plugin-manager.json"), JSON.stringify(sidecarFixture(), null, 2) + "\n");
		const traces = detectOfficialRecoveryTraces({ profileDir: fixture.dir });
		checkEqual("detected=true", traces.detected, true);
		check("confidence ≥ 0.75", traces.confidence >= 0.75, String(traces.confidence));
		const emptyEvidence = traces.evidence.find((item) => item.code === "patch-empty");
		checkEqual("patch-empty 指向 cordis.patch.yml", emptyEvidence?.path, fixture.patchPath);
		const bakEvidence = traces.evidence.find((item) => item.code === "recovery-bak");
		checkEqual("recovery-bak 指向具体备份文件", bakEvidence?.path, join(fixture.dir, bakName));
		checkEqual("备份文件名", bakEvidence?.file, bakName);
		check("备份时间戳解析成 ISO", typeof bakEvidence?.iso === "string" && bakEvidence.iso.startsWith("2025-"), String(bakEvidence?.iso));
		check("reason 提到空 patch 与备份文件名", String(traces.reason).includes("空 patch") && String(traces.reason).includes(bakName), String(traces.reason));
		check("evidence 里所有条目都带绝对 path", traces.evidence.every((item) => typeof item.path === "string" && item.path.length > 0));
		finish();
	}
	//#endregion

	//#region 5) detectOfficialRecoveryTraces：正常 patch → 不误报
	{
		const { check, checkEqual, finish } = makeChecks("5) detectOfficialRecoveryTraces：正常 patch（有归属行、无备份）→ detected:false（不误报）");
		const fixture = makeProfile({
			profileName: "web",
			patch: OWNED_ROW("free-search", "dsh-free-search"),
			bundles: ["@deepseek-ai/dsh-base", "dsh-free-search"]
		});
		const traces = detectOfficialRecoveryTraces({ profileDir: fixture.dir });
		checkEqual("detected=false", traces.detected, false);
		checkEqual("confidence=0", traces.confidence, 0);
		check("有 patch-present 证据", traces.evidence.some((item) => item.code === "patch-present"));
		check("没有任何 recovery-bak 证据", traces.evidence.every((item) => item.code !== "recovery-bak"));
		check("reason 明说未检测到", String(traces.reason).includes("未检测到"), String(traces.reason));
		checkEqual("details.patch.empty=false", traces.details.patch.empty, false);
		finish();
	}
	//#endregion

	//#region 6) detectOfficialRecoveryTraces：bundles 被摘（对比 drydock 的 package.json.rescue-bak）
	{
		const { check, checkEqual, finish } = makeChecks("6) detectOfficialRecoveryTraces：package.json.bundles 被摘（对比 package.json.rescue-bak-<ts>）→ 证据指向 manifest");
		const fixture = makeProfile({
			profileName: "web",
			patch: OWNED_ROW("free-search", "dsh-free-search"),
			bundles: ["@deepseek-ai/dsh-base"],
			extra: {
				"package.json.rescue-bak-1764000000000": JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-free-search", "dshmarket"] } } }, null, 2)
			}
		});
		const traces = detectOfficialRecoveryTraces({ profileDir: fixture.dir });
		checkEqual("detected=true（bundles 被摘）", traces.detected, true);
		const shrank = traces.evidence.find((item) => item.code === "bundles-shrank");
		checkEqual("bundles-shrank 指向 package.json", shrank?.path, join(fixture.dir, "package.json"));
		checkEqual("被摘的 bundle 列表", JSON.stringify(traces.details.manifest.removed), JSON.stringify(["dsh-free-search", "dshmarket"]));
		finish();
	}
	//#endregion

	//#region 7) planSelfHeal：纯预览，前后目录哈希一致
	{
		const { check, checkEqual, finish } = makeChecks("7) planSelfHeal：纯预览（前后目录哈希完全一致）+ 三分区分类正确");
		const fixture = makeProfile({
			profileName: "web",
			patch: "[]\n",
			bundles: ["@deepseek-ai/dsh-base"],
			extra: {
				"cordis.patch.yml.bak-1764000000000": [
					OWNED_ROW("cordis:web", "web", false),
					OWNED_ROW("x-builtin", "@deepseek-ai/dsh-web-app"),
					OWNED_ROW("free-search", "dsh-free-search"),
					USER_ROW("my-plugin", "my-plugin")
				].join("")
			}
		});
		writeText(join(fixture.dir, "plugin-manager.json"), JSON.stringify(sidecarFixture(), null, 2) + "\n");
		const before = dirHash(fixture.dir);
		const plan = planSelfHeal({ profileDir: fixture.dir });
		const after = dirHash(fixture.dir);
		checkEqual("目录哈希前后一致（一行都没写）", after, before);
		checkEqual("plan.ok=true", plan.ok, true);
		check("willRestore 恢复第三方归属行", plan.willRestore.some((row) => row.name === "dsh-free-search"), JSON.stringify(plan.willRestore.map((row) => row.name)));
		check("preservedCore 保留核心条目", plan.preservedCore.some((row) => row.id === "cordis:web"), JSON.stringify(plan.preservedCore));
		check("preservedBuiltin 保留内置条目", plan.preservedBuiltin.some((row) => row.name === "@deepseek-ai/dsh-web-app"));
		check("skipped 报告用户自有行（没有归属标记）", plan.skipped.some((row) => row.name === "my-plugin" && row.reason.includes("归属标记")));
		check("skipped 报告只有 configId 的场景恢复不了", plan.skipped.some((row) => row.id === "vision-router" && row.reason.includes("configId")), JSON.stringify(plan.skipped));
		check("willAdd 不与备份里的行重复", plan.willAdd.every((row) => row.name !== "dsh-free-search"), JSON.stringify(plan.willAdd.map((row) => row.name)));
		check("message 是中文可读计划", String(plan.message).includes("目标 profile") && String(plan.message).includes("保留核心条目"), String(plan.message).slice(0, 200));
		checkEqual("plan 里 patchEmpty=true", plan.patchEmpty, true);
		finish();
	}
	//#endregion

	//#region 8) planSelfHeal + 侧车历史（没有备份时的唯一来源）
	{
		const { checkEqual, finish } = makeChecks("8) planSelfHeal：没有备份时按侧车历史重建 willAdd（能重建的那部分）");
		const fixture = makeProfile({ profileName: "web", patch: "[]\n", bundles: ["@deepseek-ai/dsh-base"] });
		writeText(join(fixture.dir, "plugin-manager.json"), JSON.stringify(sidecarFixture({ scenarios: false }), null, 2) + "\n");
		const before = dirHash(fixture.dir);
		const plan = planSelfHeal({ profileDir: fixture.dir });
		checkEqual("目录哈希前后一致", dirHash(fixture.dir), before);
		checkEqual("willRestore 为空（没有备份）", plan.willRestore.length, 0);
		checkEqual("willAdd 1 条", plan.willAdd.length, 1);
		checkEqual("willAdd 来自侧车历史", plan.willAdd[0]?.from, "sidecar:history");
		checkEqual("willAdd 的 id", plan.willAdd[0]?.id, "free-search");
		checkEqual("willAdd 的 name", plan.willAdd[0]?.name, "dsh-free-search");
		checkEqual("willAdd 的 disabled（历史记的是曾停用 → 重建为 disabled）", plan.willAdd[0]?.disabled, true);
		finish();
	}
	//#endregion

	//#region 9) selfHealAfterRecovery：desktop + lock → desktop-locked，目录零变化
	{
		const { check, checkEqual, finish } = makeChecks("9) selfHealAfterRecovery：desktop 持锁 → code:desktop-locked，目录哈希完全不变");
		const fixture = makeProfile({
			profileName: "desktop",
			lock: true,
			patch: "[]\n",
			bundles: ["@deepseek-ai/dsh-base"],
			extra: { "cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search") }
		});
		const before = dirHash(fixture.dir);
		const healed = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false, confirm: "desktop", allowDesktop: true });
		checkEqual("ok=false", healed.ok, false);
		checkEqual("code=desktop-locked", healed.code, "desktop-locked");
		checkEqual("目录哈希完全不变（连备份都没产生）", dirHash(fixture.dir), before);
		check("message 给出中文原因（Electron 独占）", String(healed.message).includes("Electron"), String(healed.message).slice(0, 120));
		check("message 要求从系统托盘完全退出", String(healed.message).includes("从系统托盘完全退出"));
		check("message 写明本次未做任何改动", String(healed.message).includes("本次未做任何改动"));
		check("message 列出解锁后会做什么", String(healed.message).includes("解锁后会自动执行"));
		checkEqual("preview 只读预览带 wouldRestore", healed.preview?.wouldRestore?.[0]?.name, "dsh-free-search");
		finish();
	}
	//#endregion

	//#region 10) selfHealAfterRecovery：desktop 未持锁 + 无 confirm → confirm-required，不写盘
	{
		const { check, checkEqual, finish } = makeChecks("10) selfHealAfterRecovery：desktop 未持锁 + dryRun:false + 无 confirm → confirm-required，不写盘");
		const fixture = makeProfile({
			profileName: "desktop",
			patch: "[]\n",
			bundles: ["@deepseek-ai/dsh-base"],
			extra: { "cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search") }
		});
		const before = dirHash(fixture.dir);
		const healed = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false });
		checkEqual("ok=false", healed.ok, false);
		checkEqual("code=confirm-required", healed.code, "confirm-required");
		checkEqual("目录哈希完全不变", dirHash(fixture.dir), before);
		check("message 给出 --confirm desktop 提示", String(healed.message).includes("--confirm desktop"), String(healed.message).slice(0, 200));

		const mismatched = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false, confirm: "web" });
		checkEqual("confirm 不匹配 → confirm-required", mismatched.code, "confirm-required");
		checkEqual("目录哈希仍然不变", dirHash(fixture.dir), before);

		const notAllowed = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false, confirm: "desktop" });
		checkEqual("confirm 正确但未允许 → desktop-not-allowed", notAllowed.code, "desktop-not-allowed");
		checkEqual("目录哈希还是不变", dirHash(fixture.dir), before);

		const safeDefault = selfHealAfterRecovery({ profileDir: fixture.dir });
		checkEqual("默认 dryRun=true → code=dry-run", safeDefault.code, "dry-run");
		checkEqual("默认 dryRun 不写盘", dirHash(fixture.dir), before);
		finish();
	}
	//#endregion

	//#region 11) selfHealAfterRecovery：desktop 未持锁 + confirm + allowDesktop → 可逆写成功
	{
		const { check, checkEqual, finish } = makeChecks("11) selfHealAfterRecovery：desktop 未持锁 + confirm + allowDesktop → 只写 cordis.patch.yml 级可逆改动");
		const fixture = makeProfile({
			profileName: "desktop",
			patch: "[]\n",
			bundles: ["@deepseek-ai/dsh-base"],
			extra: {
				"cordis.patch.yml.bak-1764000000000": [
					OWNED_ROW("free-search", "dsh-free-search"),
					// 带嵌套 config 的归属行：重建时必须整块带回来，不能只剩标量
					`# ${OWNER_MARKER}\n- id: "browser-bridge"\n  name: "@caob23/dsh-browser-control"\n  disabled: false\n  config:\n    enabled: true\n    port: 9777\n`,
					OWNED_ROW("cordis:web", "web", false),
					USER_ROW("my-plugin", "my-plugin")
				].join("")
			}
		});
		const healed = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false, confirm: "desktop", allowDesktop: true });
		checkEqual("ok=true", healed.ok, true);
		checkEqual("code=healed", healed.code, "healed");
		check("写盘前产生了备份文件", typeof healed.backupPath === "string" && existsSync(healed.backupPath));
		const written = readText(fixture.patchPath);
		check("恢复的归属行写进了 patch", written.includes("dsh-free-search"), written);
		check("写出的行带归属标记", written.includes("Managed by dsh-drydock"));
		check("嵌套 config 整块被恢复（不是只剩标量）", written.includes("config:") && written.includes("port: 9777"), written);
		check("核心条目没有被写回", !written.includes("cordis:web"), written);
		check("用户自有行没有被写回", !written.includes("my-plugin"), written);
		checkEqual("verify 通过", healed.verify?.ok, true);
		checkEqual("applied 只有 2 条（两个第三方归属行）", healed.applied?.length, 2);
		check("message 说明只做 patch 级可逆写", String(healed.message).includes("可逆"), String(healed.message).slice(0, 200));
		finish();
	}
	//#endregion

	//#region 12) web profile：零回归
	{
		const { check, checkEqual, finish } = makeChecks("12) web profile 零回归：无需 confirm/allowDesktop、dry-run 默认、heal 后 profile 仍健康");
		const fixture = makeProfile({
			profileName: "web",
			patch: "[]\n",
			bundles: [],
			extra: { "cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search") }
		});
		const before = dirHash(fixture.dir);
		checkEqual("改前 profile 健康", verifyProfile(fixture.dir).ok, true);

		const dry = selfHealAfterRecovery({ profileDir: fixture.dir });
		checkEqual("web 默认 dry-run", dry.code, "dry-run");
		checkEqual("web 默认 dry-run 不写盘", dirHash(fixture.dir), before);

		const healed = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false });
		checkEqual("web 不需要 confirm（行为与现状一致）", healed.ok, true);
		checkEqual("web heal code=healed", healed.code, "healed");
		checkEqual("改后 profile 仍健康", verifyProfile(fixture.dir).ok, true);
		check("写出的 patch 结尾有换行", readText(fixture.patchPath).endsWith("\n"));
		check("写出的 patch 无 BOM", readText(fixture.patchPath).startsWith("\uFEFF") === false);
		// 官方恢复后 patch 是 `[]`（flow 序列）：写回时必须改回 block 风格，与 profile 里既有 patch 一致
		check("写出的 patch 是 block 风格（一行一条，不是 [] flow 序列）",
			/^- id: /m.test(readText(fixture.patchPath)) && readText(fixture.patchPath).trimStart().startsWith("[") === false,
			readText(fixture.patchPath));

		const hashAfter = dirHash(fixture.dir);
		const again = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false });
		checkEqual("重复执行 → nothing-to-do", again.code, "nothing-to-do");
		checkEqual("重复执行不改文件", dirHash(fixture.dir), hashAfter);
		finish();
	}
	//#endregion

	//#region 13) BOM
	{
		const { check, checkEqual, finish } = makeChecks("13) BOM 防护：patch 与侧车带 BOM 必须报告 + 剥离；写盘一律无 BOM");
		const fixture = makeProfile({
			profileName: "web",
			patch: "\uFEFF[]\n",
			bundles: [],
			extra: { "cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search") }
		});
		writeText(join(fixture.dir, "plugin-manager.json"), "\uFEFF" + JSON.stringify(sidecarFixture({ scenarios: false }), null, 2) + "\n");
		const traces = detectOfficialRecoveryTraces({ profileDir: fixture.dir });
		check("detect 报告 patch 带 BOM", traces.evidence.some((item) => item.code === "patch-bom"));
		check("detect 报告侧车带 BOM", traces.evidence.some((item) => item.code === "sidecar-bom"));

		const plan = planSelfHeal({ profileDir: fixture.dir });
		check("plan 的 bomStripped 至少记录 2 处（patch + 侧车）", plan.bomStripped.length >= 2, JSON.stringify(plan.bomStripped.map((item) => item.kind)));
		checkEqual("BOM patch 被正确判为空 patch", plan.patchEmpty, true);

		const healed = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false });
		checkEqual("带 BOM 也能成功自愈", healed.ok, true);
		const written = readText(fixture.patchPath);
		check("写出的文件无 BOM", written.startsWith("\uFEFF") === false);
		check("写出的文件含恢复的归属行", written.includes("dsh-free-search"));
		finish();
	}
	//#endregion

	//#region 14) 写盘失败 → 自动回滚
	{
		const { check, checkEqual, finish } = makeChecks("14) 复检/写盘失败 → 自动回滚到写前状态（不让引擎拿到半成品 patch）");
		const fixture = makeProfile({
			profileName: "web",
			patch: OWNED_ROW("keep-me", "keep-me"),
			bundles: [],
			extra: { "cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search") }
		});
		const beforeText = readText(fixture.patchPath);
		const brokenFs = {
			writeFileSync(path, content, encoding) {
				if (String(path).endsWith(".tmp")) throw new Error("假装磁盘满");
				return writeFileSync(path, content, encoding);
			}
		};
		const healed = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false, fsx: brokenFs });
		checkEqual("写失败 → code=write-failed", healed.code, "write-failed");
		checkEqual("回滚后 patch 内容与写前完全一致", readText(fixture.patchPath), beforeText);
		finish();
	}
	//#endregion

	//#region 15) bin --help 与参数解析（零回归）
	{
		const { check, checkEqual, finish } = makeChecks("15) bin/dsh-boot.mjs --help：退出码 0 且含全部新参数名；原有参数仍在");
		const help = runNode([BIN, "--help"]);
		checkEqual("--help 退出码 0", help.code, 0);
		for (const flag of ["--rescue-profile", "--heal-recovery", "--apply", "--confirm", "--allow-desktop"]) {
			check(`--help 含 ${flag}`, help.stdout.includes(flag));
		}
		for (const flag of ["--profile", "--dsh", "--repair-only", "--wait-ms", "--pause", "--cwd"]) {
			check(`--help 仍含原有参数 ${flag}`, help.stdout.includes(flag));
		}
		check("--help 写了退出码 3 的语义", help.stdout.includes("3=被安全门拒绝"), help.stdout.slice(0, 200));
		check("--help 是中文", help.stdout.includes("退出码"));

		const bin = await import("./bin/dsh-boot.mjs");
		const parsed = bin.parseArgs(["--heal-recovery", "--apply", "--confirm", "web", "--allow-desktop", "--profile", join(tmpdir(), "x")]);
		checkEqual("parseArgs: healRecovery", parsed.healRecovery, true);
		checkEqual("parseArgs: apply", parsed.apply, true);
		checkEqual("parseArgs: confirm", parsed.confirm, "web");
		checkEqual("parseArgs: allowDesktop", parsed.allowDesktop, true);
		checkEqual("parseArgs: profile", parsed.profile, join(tmpdir(), "x"));
		const parsedRescue = bin.parseArgs(["--rescue-profile"]);
		checkEqual("parseArgs: rescueProfile", parsedRescue.rescueProfile, true);
		const parsedConfirmEmpty = bin.parseArgs(["--confirm", "--apply"]);
		checkEqual("parseArgs: --confirm 缺值不吞开关", parsedConfirmEmpty.confirm, "");
		checkEqual("parseArgs: --confirm 缺值时 --apply 仍生效", parsedConfirmEmpty.apply, true);
		const legacy = bin.parseArgs(["--repair-only", "--wait-ms", "1234"]);
		checkEqual("parseArgs 零回归: repairOnly", legacy.repairOnly, true);
		checkEqual("parseArgs 零回归: waitMs", legacy.waitMs, 1234);
		finish();
	}
	//#endregion

	//#region 16) bin：非法参数与参数冲突
	{
		const { check, checkEqual, finish } = makeChecks("16) bin：未知参数走现有「忽略并提示」路径；--rescue-profile 与 --heal-recovery 冲突 → 退出码 2");
		const fixture = makeProfile({ profileName: "web", patch: "[]\n", bundles: [] });
		const unknown = runNode([BIN, "--profile", fixture.dir, "--repair-only", "--bogus-flag"]);
		checkEqual("未知参数不改变退出码语义（健康 profile → 0）", unknown.code, 0);
		check("未知参数有中文提示", unknown.stdout.includes("无法识别的参数"), unknown.stdout.slice(0, 300));
		check("提示里带了那个参数名", unknown.stdout.includes("--bogus-flag"));

		const conflict = runNode([BIN, "--profile", fixture.dir, "--rescue-profile", "--heal-recovery"]);
		checkEqual("互斥参数 → 退出码 2", conflict.code, 2);
		check("互斥有中文说明", conflict.stdout.includes("参数冲突"), conflict.stdout.slice(0, 300));
		finish();
	}
	//#endregion

	//#region 17) bin --heal-recovery：默认 dry-run 只打印计划
	{
		const { check, checkEqual, finish } = makeChecks("17) bin --heal-recovery：默认 dry-run 打印检测+计划，一个字节都不写");
		const home = tempDir("dsh-s5-bin-");
		const fixture = makeProfile({
			profileName: "web",
			home,
			patch: "[]\n",
			bundles: [],
			extra: { "cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search") }
		});
		const before = dirHash(fixture.dir);
		const run = runNode([BIN, "--profile", fixture.dir, "--heal-recovery"], { env: { DSH_HOME: home, DSH_ENGINE_PORT: "63999" } });
		checkEqual("dry-run 退出码 0", run.code, 0);
		check("打印了恢复痕迹结论", run.stdout.includes("检测到官方恢复痕迹"), run.stdout.slice(0, 400));
		check("打印了计划里的归属行", run.stdout.includes("dsh-free-search"));
		check("明说没写盘", run.stdout.includes("未写盘") || run.stdout.includes("dry-run"));
		check("给了下一步命令（--apply --confirm web）", run.stdout.includes("--apply --confirm web"));
		checkEqual("dry-run 目录哈希完全不变", dirHash(fixture.dir), before);
		finish();
	}
	//#endregion

	//#region 18) bin --heal-recovery --apply
	{
		const { check, checkEqual, finish } = makeChecks("18) bin --heal-recovery --apply：未确认 → 退出码 3 且零写入；--confirm web → 真写成功");
		const home = tempDir("dsh-s5-bin-");
		const fixture = makeProfile({
			profileName: "web",
			home,
			patch: "[]\n",
			bundles: [],
			extra: { "cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search") }
		});
		const before = dirHash(fixture.dir);
		const noConfirm = runNode([BIN, "--profile", fixture.dir, "--heal-recovery", "--apply"], { env: { DSH_HOME: home, DSH_ENGINE_PORT: "63999" } });
		checkEqual("缺 --confirm → 退出码 3", noConfirm.code, 3);
		check("缺 --confirm 有中文原因", noConfirm.stdout.includes("二次确认"), noConfirm.stdout.slice(0, 400));
		checkEqual("缺 --confirm 零写入", dirHash(fixture.dir), before);

		const wrongConfirm = runNode([BIN, "--profile", fixture.dir, "--heal-recovery", "--apply", "--confirm", "desktop"], { env: { DSH_HOME: home, DSH_ENGINE_PORT: "63999" } });
		checkEqual("confirm 不匹配 → 退出码 3", wrongConfirm.code, 3);
		checkEqual("confirm 不匹配零写入", dirHash(fixture.dir), before);

		const ok = runNode([BIN, "--profile", fixture.dir, "--heal-recovery", "--apply", "--confirm", "web"], { env: { DSH_HOME: home, DSH_ENGINE_PORT: "63999" } });
		checkEqual("--apply --confirm web → 退出码 0", ok.code, 0);
		check("输出自愈完成", ok.stdout.includes("自愈完成"), ok.stdout.slice(-600));
		check("写出的 patch 含归属行", readText(fixture.patchPath).includes("dsh-free-search"));
		check("写出的 patch 带归属标记", readText(fixture.patchPath).includes("Managed by dsh-drydock"));
		check("打印了写前备份路径", ok.stdout.includes(".rescue-bak-"));
		finish();
	}
	//#endregion

	//#region 19) bin --heal-recovery：desktop 安全门
	{
		const { check, checkEqual, finish } = makeChecks("19) bin --heal-recovery：desktop 未 --allow-desktop → 退出码 3；持锁 → 退出码 3（desktop-locked）");
		const home = tempDir("dsh-s5-bin-");
		const unlocked = makeProfile({
			profileName: "desktop",
			home,
			patch: "[]\n",
			bundles: [],
			extra: { "cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search") }
		});
		const before = dirHash(unlocked.dir);
		const notAllowed = runNode([BIN, "--profile", unlocked.dir, "--heal-recovery", "--apply", "--confirm", "desktop"], { env: { DSH_HOME: home, DSH_ENGINE_PORT: "63999" } });
		checkEqual("desktop 未允许 → 退出码 3", notAllowed.code, 3);
		check("有中文原因（--allow-desktop）", notAllowed.stdout.includes("--allow-desktop"), notAllowed.stdout.slice(0, 400));
		checkEqual("desktop 未允许零写入", dirHash(unlocked.dir), before);

		const home2 = tempDir("dsh-s5-bin-");
		const locked = makeProfile({
			profileName: "desktop",
			home: home2,
			lock: true,
			patch: "[]\n",
			bundles: [],
			extra: { "cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search") }
		});
		const lockedBefore = dirHash(locked.dir);
		const lockedRun = runNode([BIN, "--profile", locked.dir, "--heal-recovery", "--apply", "--confirm", "desktop", "--allow-desktop"], { env: { DSH_HOME: home2, DSH_ENGINE_PORT: "63999" } });
		checkEqual("持锁 → 退出码 3", lockedRun.code, 3);
		check("持锁输出包含 desktop-locked", lockedRun.stdout.includes("desktop-locked"), lockedRun.stdout.slice(-800));
		check("持锁输出要求从系统托盘完全退出", lockedRun.stdout.includes("从系统托盘完全退出"));
		checkEqual("持锁目录哈希完全不变", dirHash(locked.dir), lockedBefore);
		finish();
	}
	//#endregion

	//#region 20) bin --rescue-profile
	{
		const { check, checkEqual, finish } = makeChecks("20) bin --rescue-profile：desktop → code:desktop-delegated + 退出码 3；web → 真的拼了官方命令");
		const home = tempDir("dsh-s5-bin-");
		const desktopDir = join(home, "profiles", "desktop");
		mkdirSync(desktopDir, { recursive: true });
		const desktop = runNode([BIN, "--profile", desktopDir, "--rescue-profile"], { env: { DSH_HOME: home, DSH_ENGINE_PORT: "63999" } });
		checkEqual("desktop + --rescue-profile → 退出码 3", desktop.code, 3);
		check("输出 code: desktop-delegated", desktop.stdout.includes("desktop-delegated"), desktop.stdout.slice(0, 400));
		check("输出要求从系统托盘完全退出", desktop.stdout.includes("从系统托盘完全退出"));
		check("给出替代路径 --heal-recovery", desktop.stdout.includes("--heal-recovery"));
		checkEqual("desktop 目录里什么都没多出来", readdirSync(desktopDir).length, 0);

		// web：--dsh 指向不存在的命令 → 官方命令必然失败，用来验证「真的执行了官方命令形态」
		const webRun = runNode([BIN, "--rescue-profile", "--dsh", "dsh-s5-nonexistent-cmd", "--wait-ms", "2000"], { env: { DSH_HOME: home, DSH_ENGINE_PORT: "63999" } });
		checkEqual("救援命令失败 → 退出码 1（不假成功）", webRun.code, 1);
		check("失败信息贴了官方命令形态", webRun.stdout.includes("dsh-s5-nonexistent-cmd rescue --from-default-profile web"), webRun.stdout.slice(-900));
		check("失败时给了手动重跑命令", webRun.stdout.includes("可手动重跑官方命令"));
		checkEqual("没有真的造出 rescue profile", existsSync(join(home, "profiles", "rescue")), false);
		finish();
	}
	//#endregion

	//#region 21) 内部件与红线自检
	{
		const { check, checkEqual, finish } = makeChecks("21) 内部件暴露 + 红线自检（不 import electron / 不写 desktop 的 node_modules / 不碰 open-boot）");
		checkEqual("__internals.spawnRescueDetached 是函数", typeof __internals.spawnRescueDetached, "function");
		checkEqual("__internals.fsAdapter 是函数", typeof __internals.fsAdapter, "function");
		checkEqual("__internals.verifyHealedPatch 是函数", typeof __internals.verifyHealedPatch, "function");
		checkEqual("__internals.desktopLockedMessage 是函数", typeof __internals.desktopLockedMessage, "function");
		const source = readText(join(ROOT, "lib", "rescue-profile.mjs"));
		check("模块没有 import electron", source.includes('from "electron"') === false);
		check("模块顶层没有 import child_process（spawn 走动态 import，便于注入）", source.includes('from "node:child_process"') === false);
		check("模块没有 pnpm remove 这类包管理器操作", source.includes("pnpm remove") === false);
		check("模块的写盘目标只有 cordis.patch.yml 及其 .rescue-bak-*", /writeFileSync\(\s*backupPath/.test(source) || source.includes("writeFileSync(backupPath"), "找不到备份写盘点");
		finish();
	}
	//#endregion

	//#region 22) planSelfHeal：bundles 被摘时如实提示（不擅自改 package.json）
	{
		const { check, checkEqual, finish } = makeChecks("22) planSelfHeal：package.json 的 bundles 被摘过时如实提示，且不写 package.json");
		const fixture = makeProfile({
			profileName: "web",
			patch: "[]\n",
			bundles: ["@deepseek-ai/dsh-base"],
			extra: {
				"cordis.patch.yml.bak-1764000000000": OWNED_ROW("free-search", "dsh-free-search"),
				"package.json.rescue-bak-1764000000000": JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-free-search"] } } }, null, 2)
			}
		});
		const manifestBefore = readText(join(fixture.dir, "package.json"));
		const plan = planSelfHeal({ profileDir: fixture.dir });
		checkEqual("plan.bundlesRemoved 记录了被摘的 bundle", JSON.stringify(plan.bundlesRemoved), JSON.stringify(["dsh-free-search"]));
		check("message 明说不会把 bundle 加回 bundles", String(plan.message).includes("自愈不写 package.json"), String(plan.message));
		const healed = selfHealAfterRecovery({ profileDir: fixture.dir, dryRun: false });
		checkEqual("自愈成功（只写 patch）", healed.ok, true);
		checkEqual("package.json 一个字节都没变", readText(join(fixture.dir, "package.json")), manifestBefore);
		finish();
	}
	//#endregion

	cleanup();
	console.log(`\n全部断言 ${assertionCount} 条通过。`);
	console.log("RESULT: PASS - S5 救援 profile（官方通道）+ 恢复后自愈（22 组）");
	process.exit(0);
} catch (error) {
	console.error("RESULT: FAIL - 测试过程抛出异常");
	console.error(error?.stack ?? String(error));
	cleanup();
	process.exit(1);
}
