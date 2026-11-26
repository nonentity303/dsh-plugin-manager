// test-diagnostics.mjs — 离线只读诊断报告（M4）自检。
// 用法: node test-diagnostics.mjs
//
// 风格对齐 test-bundle.mjs：逐条断言 + `RESULT: PASS` / `RESULT: FAIL`，退出码 0/1。
// **不依赖真实桌面版**：所有场景都用临时 fixture 目录模拟。
//
// 覆盖（契约 §6 / M4）：
//   · 正常 web profile → 各段 status ok（含"web 场景行为不变"防回归断言）
//   · F6 官方恢复痕迹：0 字节空 patch + cordis.patch.yml.bak-<时间戳> → warning + 建议"恢复后自愈"
//   · 缺 logs 目录 → unavailable，而不是崩
//   · 崩溃报告命名 crash-<UTC>-<source>.log → 解析出 source（host / web-boot / …）
//   · 脱敏：塞假 token / 邮箱进 patch、日志、崩溃报告 → 输出里绝不含原串
//   · 只读：跑完 fixture 的 mtime + SHA256 **完全不变**（最重要的一条）
//   · --help 退出码 0；非法参数退出码 2；--home 指向不存在目录退出码 1
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FAKE_TOKEN = "sk-abcdef123456";
const FAKE_EMAIL = "someone@example.com";

const { collectDiagnostics, renderReport, detectHomeCandidates, parseCrashFilename, SCHEMA } = await import("./lib/diagnostics.mjs");
const { HELP_TEXT } = await import("./bin/drydock-doctor.mjs");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

let checks = 0;
let failures = 0;
const fail = (name, message) => {
	failures += 1;
	console.error(`FAIL  ${name}\n      ${message}`);
};
const check = async (name, fn) => {
	checks += 1;
	try {
		const detail = await fn();
		console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
	} catch (error) {
		fail(name, error && error.message ? error.message : String(error));
	}
};
const ok = (condition, message) => {
	if (!condition) throw new Error(message);
};
const eq = (actual, expected, message) => {
	if (actual !== expected) throw new Error(`${message}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
};

// ------------------------------------------------------------------ fixture 构造

const tmpRoot = mkdtempSync(join(tmpdir(), "drydock-diag-"));
const fixtureHome = join(tmpRoot, "home");
const webDir = join(fixtureHome, "profiles", "web");
const desktopDir = join(fixtureHome, "profiles", "desktop");
const fixtureUserData = join(tmpRoot, "user-data");
const fixtureResources = join(tmpRoot, "resources");
const archiveResources = join(tmpRoot, "resources-archive");
const emptyAppData = join(tmpRoot, "empty-appdata");
const fakeAppData = join(tmpRoot, "fake-appdata");

/** 真包 `resources/app.asar/dsh/desktop-runtime.json` 的结构（只取 release；files 故意造大）。 */
const HOST_RELEASE = { schemaVersion: 1, version: "0.2.3-alpha.2", hostProtocolVersion: 4, nodeVersion: "24.21.0", pnpmVersion: "11.28.5" };

function put(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content, "utf8");
}
function putJson(file, value) {
	put(file, `${JSON.stringify(value, null, 2)}\n`);
}

const WEB_PATCH = [
	"# fixture patch（前 400 字符内必须能看到假 token，供脱敏断言用）",
	"- id: demo-plugin",
	"  config:",
	`    apiKey: ${FAKE_TOKEN}`,
	"  disabled: false",
	"- id: other-plugin",
	"  disabled: true",
	""
].join("\n");

const OPERATION_SETTLED = {
	runId: "run-fixture-1",
	transportDropped: 0,
	operation: {
		id: "op-1",
		time: "2026-11-26T09:00:00.000Z",
		reason: "install",
		target: "dsh-demo",
		stage: "install",
		version: "1.2.3",
		phase: "settled",
		application: "restart-required",
		changed: true,
		restartReason: "no-hmr"
	}
};
const OPERATION_STARTED = {
	runId: "run-fixture-1",
	transportDropped: 2,
	operation: {
		id: "op-2",
		time: "2026-11-26T09:05:00.000Z",
		reason: "plugin",
		target: "dsh-demo",
		stage: "enable",
		enabled: false,
		phase: "started"
	}
};
const OPERATION_PREVIOUS = {
	runId: "run-fixture-0",
	transportDropped: 0,
	operation: {
		id: "op-0",
		time: "2026-11-26T08:00:00.000Z",
		reason: "remove",
		target: "old-pkg",
		stage: "remove",
		phase: "unknown"
	}
};

function buildFixture() {
	// 正常 web profile：package.json / patch / 侧车 / pid / market state / 引擎日志 / 备份
	putJson(join(webDir, "package.json"), {
		name: "dsh-profile-web",
		private: true,
		dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-drydock"] } },
		dependencies: { "dsh-drydock": "1.0.1" }
	});
	put(join(webDir, "cordis.patch.yml"), WEB_PATCH);
	putJson(join(webDir, "plugin-manager.json"), {
		version: 2,
		sources: [],
		rescue: { autoQuarantine: true },
		overrides: { source: {} },
		history: [
			{ id: "h1", at: "2026-11-25T08:00:00.000Z", action: "setEnabled", label: "demo-plugin → 停用", result: "ok", undone: false },
			{ id: "h2", at: "2026-11-26T08:30:00.000Z", action: "install", label: "安装 dsh-demo", result: "ok", undone: false }
		],
		scenarios: [{ id: "s1", name: "平时用", createdAt: "2026-11-25T08:00:00.000Z", updatedAt: "2026-11-25T08:00:00.000Z", states: {} }],
		pendingRemovals: [],
		failureStreak: {}
	});
	putJson(join(webDir, ".open-boot.pid"), { app: "dsh-open-boot", pid: 4242, port: 6560, profile: webDir, startedAt: "2026-11-26T03:00:00.000Z", launcherPid: 4243 });
	putJson(join(webDir, ".dsh-market", "state.json"), { disabled: [], groups: {}, groupOrder: [], region: "china", regionAuto: true });
	put(join(webDir, "rescue-daemon.log"), `engine stderr line\napiKey=${FAKE_TOKEN}\n[error] something failed\n`);
	put(join(webDir, "cordis.patch.yml.rescue-bak-1791461181655"), "# drydock 救援备份\n[]\n");
	put(join(webDir, "package.json.rescue-bak-1791461181654"), "{}\n");

	// 桌面 profile：**官方恢复后留下的 0 字节空 patch** + 官方备份 + lock + 侧车
	putJson(join(desktopDir, "package.json"), {
		name: "dsh-profile-desktop",
		private: true,
		dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-desktop-app", "dsh-drydock"] } }
	});
	put(join(desktopDir, "cordis.patch.yml"), ""); // 0 字节：官方恢复后下次启动创建的空 patch（F6）
	put(join(desktopDir, "cordis.patch.yml.bak-20261126T100000Z"), "# 官方恢复前的 patch\n- id: demo-plugin\n  disabled: false\n");
	putJson(join(desktopDir, "lock"), { pid: 9999, hostRunId: "run-fixture-desktop", startedAt: "2026-11-26T10:00:00.000Z" });
	putJson(join(desktopDir, "plugin-manager.json"), { version: 2, rescue: { autoQuarantine: false }, overrides: { source: {} }, history: [], scenarios: [], pendingRemovals: [] });

	// 崩溃报告：官方命名 crash-<UTC>-<source>.log；4 份，只有最新 3 份应被采集
	const crashDir = join(fixtureUserData, "logs");
	const crashBody = (title) => [
		`[crash] ${title}`,
		"backend ready: false",
		"app version: 0.2.3-alpha.2",
		"error: listen EADDRINUSE 127.0.0.1:3080",
		`token: ${FAKE_TOKEN}`,
		`contact: ${FAKE_EMAIL}`,
		""
	].join("\n");
	const crashFiles = [
		["crash-2026-11-20T09-00-00-000Z-main.log", "main", "2026-11-20T09:00:00.000Z"],
		["crash-2026-11-24T09-00-00-000Z-renderer.log", "renderer", "2026-11-24T09:00:00.000Z"],
		["crash-2026-11-26T10-00-00-000Z-host.log", "host", "2026-11-26T10:00:00.000Z"],
		["crash-2026-11-26T11-00-00-000Z-web-boot.log", "web-boot", "2026-11-26T11:00:00.000Z"]
	];
	for (const [name, source, iso] of crashFiles) {
		const file = join(crashDir, name);
		put(file, crashBody(source));
		utimesSync(file, new Date(iso), new Date(iso));
	}

	// 插件操作记录：官方 NDJSON 记录形状 + 一条坏行（应计入 invalid，不能让整段失败）
	put(join(fixtureUserData, "plugin-operations", "operations.jsonl"), `${JSON.stringify(OPERATION_SETTLED)}\n{"broken":\n${JSON.stringify(OPERATION_STARTED)}\n`);
	put(join(fixtureUserData, "plugin-operations", "operations.previous.jsonl"), `${JSON.stringify(OPERATION_PREVIOUS)}\n`);

	// BOM fixture：patch 带 UTF-8 BOM（契约要求报告并剥离，不许静默）
	const bomDir = join(tmpRoot, "bom-home", "profiles", "web");
	putJson(join(bomDir, "package.json"), { name: "dsh-profile-web" });
	writeFileSync(join(bomDir, "cordis.patch.yml"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("- id: from-bom\n  disabled: false\n", "utf8")]));

	// 空 patch 但**没有**官方备份：可能是手工清空 → 也要 warning（F6 的另一半）
	const emptyDir = join(tmpRoot, "empty-home", "profiles", "desktop");
	putJson(join(emptyDir, "package.json"), { name: "dsh-profile-desktop" });
	put(join(emptyDir, "cordis.patch.yml"), "");

	// 桌面安装目录 fixture：真包结构是 `resources/app.asar`（归档）里的 dsh/desktop-runtime.json。
	// 这里用"目录形态"模拟已解包的样子，release 在文件前部，files 故意造 3000 条（>300 KB）用于
	// 断言"只读前部、绝不整读"。
	const bigFiles = [];
	for (let index = 0; index < 3000; index += 1) {
		bigFiles.push({ path: `lib/entry-${index}.js`, bytes: 1000 + index, sha256: "0".repeat(64), executable: false });
	}
	put(
		join(fixtureResources, "app.asar", "dsh", "desktop-runtime.json"),
		JSON.stringify({ schemaVersion: 1, release: HOST_RELEASE, platform: "win32", arch: "x64", sharedPackages: [], files: bigFiles })
	);
	putJson(join(fixtureResources, "runtime", "versions.json"), { node: "24.21.0", pnpm: "11.28.5" });
	put(join(fixtureResources, "runtime", "cli", "bin", "dsh.cmd"), "@echo off\r\nrem 桌面自带 CLI\r\n");

	// 打包态 fixture：app.asar 是**单个归档文件**（普通 Node 进程读不到内部路径）→ 必须降级成 warning
	put(join(archiveResources, "app.asar"), "PK\u0003\u0004 fake asar archive（不是真归档，只用于测降级分支）\n");
	putJson(join(archiveResources, "runtime", "versions.json"), { node: "24.21.0", pnpm: "11.28.5" });

	// 系统 dsh（npm 全局）fixture：与桌面自带运行时是两个包
	putJson(join(fakeAppData, "npm", "node_modules", "@deepseek-ai", "dsh", "package.json"), { name: "@deepseek-ai/dsh", version: "0.2.2-rc.5" });

	// profiles/node_modules 不是 profile → 应出现在"已跳过"里
	mkdirSync(join(fixtureHome, "profiles", "node_modules", "some-pkg"), { recursive: true });
	mkdirSync(emptyAppData, { recursive: true });
}

function snapshot(root) {
	const rows = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const rel = relative(root, full).replace(/\\/g, "/");
			if (entry.isDirectory()) {
				rows.push({ rel, type: "dir" });
				walk(full);
			} else if (entry.isFile()) {
				const stat = statSync(full);
				rows.push({
					rel,
					type: "file",
					size: stat.size,
					mtimeMs: stat.mtimeMs,
					sha256: createHash("sha256").update(readFileSync(full)).digest("hex")
				});
			}
		}
	};
	walk(root);
	rows.sort((a, b) => a.rel.localeCompare(b.rel));
	return rows;
}

/** 统一的只读收集参数（fixture 注入；绝不碰真实 ~/.dsh 与真实端口）。 */
function collect(overrides = {}) {
	return collectDiagnostics({
		env: { DSH_HOME: fixtureHome, DSH_ENGINE_PORT: "6561" },
		homeDir: join(tmpRoot, "fake-home"),
		userDataDirs: [fixtureUserData],
		resourcesDirs: [fixtureResources],
		profile: "web",
		includeLogs: true,
		probePort: async () => false,
		now: () => new Date("2026-11-26T12:00:00.000Z"),
		...overrides
	});
}

function sectionOf(diag, id) {
	const found = diag.sections.find((section) => section.id === id);
	ok(found, `缺少段落 id=${id}（实际：${diag.sections.map((section) => section.id).join(",")}）`);
	return found;
}
function itemText(section, needle) {
	return section.items.find((item) => item.k.includes(needle) || String(item.v).includes(needle));
}
function statusLine(diag) {
	return diag.sections.map((section) => `${section.id}=${section.status}`).join(" ");
}

/** 跑 CLI：输出重定向到文件（沙箱下 spawnSync 用管道会 EPERM，test-launcher.mjs 同款做法）。 */
function runCli(args, { env = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "drydock-diag-cli-"));
	const outFile = join(dir, "out.log");
	const errFile = join(dir, "err.log");
	const fdOut = openSync(outFile, "w");
	const fdErr = openSync(errFile, "w");
	const childEnv = { ...process.env, ...env };
	delete childEnv.DSH_LAUNCHER_IMPORT_ONLY;
	const result = spawnSync(process.execPath, [join(ROOT, "bin", "drydock-doctor.mjs"), ...args], {
		cwd: ROOT,
		env: childEnv,
		stdio: ["ignore", fdOut, fdErr],
		windowsHide: true,
		timeout: 120000
	});
	closeSync(fdOut);
	closeSync(fdErr);
	return {
		code: result.status,
		stdout: readFileSync(outFile, "utf8"),
		stderr: readFileSync(errFile, "utf8"),
		dir
	};
}

const fixtureEnv = {
	DSH_HOME: fixtureHome,
	DSH_DESKTOP_USER_DATA_DIR: fixtureUserData,
	DSH_DESKTOP_RESOURCES_DIR: fixtureResources,
	APPDATA: emptyAppData
};

// ------------------------------------------------------------------ 只读快照（最先取，最后比）

buildFixture();
const before = snapshot(tmpRoot);
console.log(`fixture: ${tmpRoot}（${before.filter((row) => row.type === "file").length} 个文件）\n`);

// ------------------------------------------------------------------ 正常 web profile

const diag = await collect();

await check("C-01 报告骨架：schema / tool / environment / sections 齐全", () => {
	eq(diag.schema, SCHEMA, "schema 不对");
	eq(diag.mode, "read-only", "mode 必须是 read-only");
	eq(diag.tool.version, PACKAGE.version, "drydock 版本应读自本包 package.json");
	eq(diag.tool.name, PACKAGE.name, "工具名应读自 package.json");
	eq(diag.environment.node, process.versions.node, "Node 版本应来自 process.versions");
	eq(diag.environment.userHome, "~", "用户主目录应缩写为 ~（不上报用户名）");
	eq(diag.generatedAt, "2026-11-26T12:00:00.000Z", "now 注入未生效");
	ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/.test(diag.generatedAtLocal), `本地时间格式异常：${diag.generatedAtLocal}`);
	const ids = diag.sections.map((section) => section.id);
	eq(new Set(ids).size, ids.length, "section id 重复");
	for (const required of ["env", "home", "profiles", "desktop", "desktop-host", "recovery", "crash", "operations", "engine-logs", "ports", "drydock"]) {
		ok(ids.includes(required), `缺少必需段落 ${required}`);
	}
	for (const section of diag.sections) {
		ok(["ok", "warning", "unavailable"].includes(section.status), `段落 ${section.id} 的 status 非法：${section.status}`);
		ok(section.title && section.title.trim() !== "", `段落 ${section.id} 缺中文标题`);
		for (const item of section.items) {
			ok(typeof item.k === "string" && item.k !== "", `段落 ${section.id} 有空 k`);
			ok(item.v !== undefined, `段落 ${section.id} 的「${item.k}」缺 v`);
		}
	}
	return `${diag.sections.length} 段`;
});

await check("C-02 正常 web profile：各段 status 全部 ok（无 unavailable）", () => {
	const bad = diag.sections.filter((section) => section.status !== "ok");
	ok(bad.length === 0, `以下段落不是 ok：${bad.map((section) => `${section.id}=${section.status}`).join(", ")}（${statusLine(diag)}）`);
	return statusLine(diag);
});

await check("C-03 DSH_HOME 解析：权威值 + 全部候选 + 无歧义 warning", () => {
	eq(diag.home.resolved, true, "fixture home 应解析成功");
	ok(diag.home.authoritative.includes("home"), `权威值应指向 fixture：${diag.home.authoritative}`);
	eq(diag.home.source, "环境变量 DSH_HOME", "解析依据应是环境变量");
	const candidates = diag.home.candidates.map((candidate) => candidate.path);
	ok(candidates.some((path) => path === diag.home.authoritative), "候选里必须包含权威值");
	ok(candidates.length >= 2, `候选太少：${candidates.length}`);
	ok(!diag.warnings.some((message) => message.includes("候选") || message.includes("权威")), `DSH_HOME 不该有歧义 warning：${diag.warnings.join(" / ")}`);
	return `${candidates.length} 个候选`;
});

await check("C-04 profile 清单：package.json / patch / lock / pid / 侧车 / market 全报到", async () => {
	const section = sectionOf(diag, "profiles");
	ok(itemText(section, "web / package.json"), "缺 package.json 项");
	ok(itemText(section, "web / cordis.patch.yml"), "缺 patch 项");
	const patchItem = section.items.find((item) => item.k === "web / cordis.patch.yml");
	ok(/2 个顶层条目/.test(patchItem.v), `patch 条目数异常：${patchItem.v}`);
	ok(/无 BOM/.test(patchItem.v), `BOM 判定异常：${patchItem.v}`);
	ok(itemText(section, "web / lock")?.v === "不存在", "lock 应为不存在");
	const pidItem = section.items.find((item) => item.k === "web / .open-boot.pid");
	ok(/port=6560/.test(pidItem.v), `pid 解析异常：${pidItem.v}`);
	const sidecar = section.items.find((item) => item.k.includes("plugin-manager.json"));
	ok(/历史 2 条/.test(sidecar.v) && /场景 1 个/.test(sidecar.v), `侧车统计异常：${sidecar.v}`);
	const market = section.items.find((item) => item.k.includes(".dsh-market/state.json"));
	ok(/region china/.test(market.v), `market state 解析异常：${market.v}`);
	const unfocused = await collect({ profile: null });
	const skipped = sectionOf(unfocused, "profiles").items.find((item) => item.k === "已跳过");
	ok(skipped && skipped.v === "node_modules", `应跳过 profiles/node_modules：${skipped ? skipped.v : "（没有已跳过项）"}`);
	return "web profile 字段齐全";
});

await check("C-05 桌面 profile：已初始化 / lock 内容 / dsh.profile.bundles", () => {
	const section = sectionOf(diag, "desktop");
	eq(section.status, "ok", "已初始化的桌面 profile 应为 ok");
	const init = section.items.find((item) => item.k === "初始化");
	ok(/已初始化/.test(init.v), `初始化判定异常：${init.v}`);
	const lock = section.items.find((item) => item.k === "lock（进程生命周期单实例锁）");
	eq(lock.v, "存在", "lock 应存在");
	const lockText = section.items.find((item) => item.k === "lock 内容");
	ok(/"pid":9999|"pid": 9999/.test(lockText.v), `lock 内容应有 pid：${lockText.v}`);
	const bundles = section.items.find((item) => item.k === "dsh.profile.bundles");
	ok(/3 个/.test(bundles.v) && /@deepseek-ai\/dsh-desktop-app/.test(bundles.v), `bundles 列表异常：${bundles.v}`);
	ok(diag.warnings.some((message) => message.includes("lock")), "lock 存在时应有「持锁禁写」的 warning");
	return "lock + bundles 正常";
});

await check("C-06 引擎日志：复用 readEngineLog，只取尾部且脱敏", () => {
	const section = sectionOf(diag, "engine-logs");
	eq(section.status, "ok", "web 有日志时 engine-logs 应为 ok");
	const tail = section.items.find((item) => item.k.includes("rescue-daemon.log 尾部"));
	ok(tail, "缺日志尾部项");
	ok(/engine stderr line/.test(tail.v), "尾部内容不对");
	return "有尾部";
});

await check("C-07 端口事实：候选清单 + 监听与否，且明确不断言引擎健康", () => {
	const section = sectionOf(diag, "ports");
	const ports = section.items.filter((item) => /^端口 \d+$/.test(item.k));
	ok(ports.length === 3, `候选端口数应为 3（env 6561 / pid 6560 / 默认 3080），实际 ${ports.length}`);
	ok(ports.every((item) => item.v === "无监听"), "注入的 probePort=false 应让所有端口都无监听");
	const rule = section.items.find((item) => item.k === "判定口径");
	ok(/不代表引擎健康/.test(rule.v), "必须写明端口有监听不代表引擎健康（契约红线 3）");
	return ports.map((item) => item.k).join("、");
});

await check("C-08 崩溃报告：最新 3 份 + 前 4 KiB + source 解析", () => {
	const section = sectionOf(diag, "crash");
	eq(section.status, "ok", "有崩溃报告时 crash 应为 ok");
	const reports = section.items.filter((item) => /^崩溃报告 \d+$/.test(item.k));
	eq(reports.length, 3, "官方口径：只取最新 3 份");
	ok(reports.some((item) => /来源=host/.test(item.v)), "缺 host 来源");
	ok(reports.some((item) => /来源=web-boot/.test(item.v)), "缺 web-boot 来源");
	ok(!reports.some((item) => /来源=main/.test(item.v)), "最早的 main 报告不该被采集",);
	const heads = section.items.filter((item) => /^崩溃报告 \d+ \/ 前 4 KiB$/.test(item.k));
	eq(heads.length, 3, "每份都要有前 4 KiB 摘录");
	ok(heads.every((item) => /EADDRINUSE/.test(item.v)), "摘录应包含崩溃内容");
	ok(section.items.some((item) => item.k === "更早的报告" && /另有 1 份/.test(item.v)), "应说明还有更早的报告未展开");
	eq(diag.stats.crashReportsFound, 4, "crashReportsFound 应为 4");
	return `最新 3 份 / 共 ${diag.stats.crashReportsFound} 份`;
});

await check("C-09 插件操作记录：官方 NDJSON 形状 + 100 条 / 64 KiB 预算 + 坏行不致命", () => {
	const section = sectionOf(diag, "operations");
	eq(section.status, "ok", "有记录时 operations 应为 ok");
	eq(diag.stats.operationRecords, 3, "应解析出 3 条记录");
	const records = section.items.filter((item) => /^记录 \d+$/.test(item.k));
	eq(records.length, 3, "记录条数异常");
	ok(/卸载/.test(records[0].v), `记录应按旧→新排列，第 1 条应是更早的 remove：${records[0].v}`);
	ok(/已结束/.test(records[1].v) && /下次启动生效/.test(records[1].v), `settled 记录渲染异常：${records[1].v}`);
	ok(/开始记录/.test(records[2].v) && /停用/.test(records[2].v), `started 记录渲染异常：${records[2].v}`);
	ok(section.items.some((item) => item.k === "无法解析的记录" && /1 条/.test(item.v)), "坏行应计入无法解析但与其它记录共存");
	ok(itemText(section, "口径"), "官方口径说明缺失");
	return "3 条 + 1 条坏行";
});

// ------------------------------------------------------------------ F6 官方恢复痕迹

await check("C-10 F6 官方恢复痕迹：0 字节空 patch + .bak-<时间戳> → warning + 建议恢复后自愈", async () => {
	const focused = await collect({ profile: "desktop" });
	const section = sectionOf(focused, "recovery");
	eq(section.title, "检测到官方恢复痕迹", "标题必须是「检测到官方恢复痕迹」");
	eq(section.status, "warning", `应报 warning，实际 ${section.status}`);
	ok(section.items.some((item) => /0 字节/.test(String(item.v))), "应报出 0 字节空 patch");
	ok(section.items.some((item) => /cordis\.patch\.yml\.bak-20261126T100000Z/.test(String(item.v))), "应报出官方恢复备份名");
	const advice = section.items.find((item) => item.k.includes("建议"));
	ok(advice && /恢复后自愈/.test(advice.v), "建议里必须出现「恢复后自愈」");
	ok(focused.warnings.some((message) => message.includes("官方恢复痕迹")), "warning 汇总里没有官方恢复痕迹");
	return "warning + 恢复后自愈建议";
});

await check("C-11 空 patch 但无官方备份：也要 warning（可能是手工清空）", async () => {
	const focused = await collect({ dshHome: join(tmpRoot, "empty-home"), profile: "desktop" });
	const section = sectionOf(focused, "recovery");
	eq(section.status, "warning", "空 patch 应报 warning");
	ok(section.items.some((item) => /手工清空/.test(String(item.v))), "应提示可能是手工清空");
	return "warning";
});

await check("C-12 BOM 检测：带 UTF-8 BOM 的 patch → warning 且不是静默", async () => {
	const focused = await collect({ dshHome: join(tmpRoot, "bom-home"), profile: "web" });
	const profiles = sectionOf(focused, "profiles");
	eq(profiles.status, "warning", "BOM 应让 profiles 段变 warning");
	const patchItem = profiles.items.find((item) => item.k === "web / cordis.patch.yml");
	ok(/带 UTF-8 BOM/.test(patchItem.v), `BOM 未报告：${patchItem.v}`);
	ok(focused.warnings.some((message) => message.includes("BOM")), "warnings 里应有 BOM 条目");
	return "warning + BOM";
});

// ------------------------------------------------------------------ 缺日志 / 崩溃命名 / 脱敏

await check("C-13 缺少 logs 目录：unavailable 而不是崩", async () => {
	const focused = await collect({ userDataDirs: [join(tmpRoot, "no-such-userdata")] });
	eq(focused.sections.length, 11, "段落数量不应因缺目录而减少");
	const crash = sectionOf(focused, "crash");
	eq(crash.status, "unavailable", "缺日志目录应为 unavailable");
	ok(typeof crash.reason === "string" && crash.reason.length > 0, "unavailable 段必须有中文原因");
	const operations = sectionOf(focused, "operations");
	eq(operations.status, "unavailable", "缺操作记录目录应为 unavailable");
	ok(operations.reason.length > 0, "unavailable 段必须有中文原因");
	eq(sectionOf(focused, "profiles").status, "ok", "缺 logs 不应影响 profile 段");
	return "crash/operations 均 unavailable";
});

await check("C-14 崩溃报告命名解析：crash-<UTC>-<source>.log", () => {
	const host = parseCrashFilename("crash-2026-11-26T10-00-00-000Z-host.log");
	eq(host.source, "host", "host 来源解析失败");
	eq(host.known, true, "官方命名应 known");
	eq(host.iso, "2026-11-26T10:00:00.000Z", "时间戳应还原为 ISO");
	const webBoot = parseCrashFilename("crash-2026-11-26T11-00-00-000Z-web-boot.log");
	eq(webBoot.source, "web-boot", "web-boot 来源解析失败（来源名里带连字符）");
	const renderer = parseCrashFilename("crash-2026-11-24T09-00-00-000Z-renderer.log");
	eq(renderer.source, "renderer", "renderer 来源解析失败");
	const main = parseCrashFilename("crash-2026-11-20T09-00-00-000Z-main.log");
	eq(main.source, "main", "main 来源解析失败");
	eq(parseCrashFilename("not-a-crash.log"), null, "非崩溃报告应返回 null");
	return "host / web-boot / renderer / main";
});

await check("C-15 脱敏：假 token / 邮箱绝不出现在 JSON 与中文报告里", () => {
	const json = JSON.stringify(diag);
	const human = renderReport(diag);
	ok(!json.includes(FAKE_TOKEN), `JSON 里出现明文 token（patch/日志/崩溃报告泄露）`);
	ok(!json.includes(FAKE_EMAIL), "JSON 里出现明文邮箱");
	ok(!human.includes(FAKE_TOKEN), "中文报告里出现明文 token");
	ok(!human.includes(FAKE_EMAIL), "中文报告里出现明文邮箱");
	ok(!json.includes(homedir()), "JSON 里出现真实用户主目录（用户名未打码）");
	const kinds = diag.redacted.map((entry) => entry.kind).join("、");
	ok(kinds.includes("API Key"), `redacted 未登记 API Key：${kinds}`);
	ok(kinds.includes("邮箱"), `redacted 未登记邮箱：${kinds}`);
	ok(diag.redacted.every((entry) => entry.count >= 1 && entry.kind), "redacted 条目结构异常");
	return `${diag.redacted.length} 类脱敏`;
});

await check("C-16 --include-logs 开关生效：默认不含日志尾部", async () => {
	const focused = await collect({ includeLogs: false });
	const section = sectionOf(focused, "engine-logs");
	eq(section.status, "ok", "默认（不含日志）engine-logs 应为 ok");
	ok(section.items.some((item) => item.k === "采集开关" && /未采集/.test(item.v)), "默认应说明未采集日志");
	ok(!section.items.some((item) => item.k.includes("尾部")), "默认不该出现日志尾部");
	return "默认不含日志";
});

await check("C-17 web 场景行为不变：web fixture 不触发任何桌面专属 warning", async () => {
	const focused = await collect({ profile: "web" });
	const recovery = sectionOf(focused, "recovery");
	eq(recovery.status, "ok", "web profile 不应有恢复痕迹");
	eq(sectionOf(focused, "profiles").status, "ok", "web profile 段应为 ok");
	ok(!focused.warnings.some((message) => message.includes("恢复痕迹")), "web 场景不该出现恢复痕迹 warning");
	ok(
		focused.warnings.every((message) => message.includes("lock") || message.includes("崩溃报告")),
		`web 场景只应留下事实类提示（lock / 崩溃报告），实际：${focused.warnings.join(" / ")}`
	);
	return "web 行为不变";
});

// ------------------------------------------------------------------ 只读断言（最重要）

await check("C-18 只读：跑完全部收集后 fixture 的 mtime + SHA256 完全不变", async () => {
	// 设计契约 §6 + 任务红线：只读是硬要求，所以这里覆盖"单元调用 + CLI 调用"两种入口。
	const cli = runCli(["--json", "--include-logs", "--home", fixtureHome, "--profile", "web"], { env: fixtureEnv });
	eq(cli.code, 0, `CLI 只读运行应退出 0（实际 ${cli.code}）`);
	const cliOut = join(cli.dir, "report.json");
	const cliOutRun = runCli(["--out", cliOut, "--home", fixtureHome, "--profile", "web"], { env: fixtureEnv });
	eq(cliOutRun.code, 0, `CLI --out 运行应退出 0（实际 ${cliOutRun.code}）`);
	await collect({ profile: "web" });
	await collect({ profile: "desktop" });
	await collect({ includeLogs: false });

	const after = snapshot(tmpRoot);
	eq(after.length, before.length, `fixture 条目数变了（${before.length} → ${after.length}）`);
	for (let index = 0; index < before.length; index += 1) {
		const expected = before[index];
		const actual = after[index];
		eq(actual.rel, expected.rel, `第 ${index} 条路径变了`);
		eq(actual.type, expected.type, `${expected.rel} 类型变了`);
		if (expected.type !== "file") continue;
		eq(actual.size, expected.size, `${expected.rel} 大小变了`);
		eq(actual.mtimeMs, expected.mtimeMs, `${expected.rel} mtime 变了（只读被破坏）`);
		eq(actual.sha256, expected.sha256, `${expected.rel} 内容哈希变了（只读被破坏）`);
	}
	return `${after.filter((row) => row.type === "file").length} 个文件 mtime+哈希不变`;
});

await check("C-19 只读：模块源码里没有任何写盘 / 进程 API", () => {
	const source = readFileSync(join(ROOT, "lib", "diagnostics.mjs"), "utf8");
	const forbidden = [
		"writeFileSync", "writeFile(", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync",
		"renameSync", "unlinkSync", "copyFileSync", "createWriteStream", "openSync(path, \"w",
		"child_process", "spawnSync", "spawn(", "execSync", "execFileSync"
	];
	const hits = forbidden.filter((needle) => source.includes(needle));
	ok(hits.length === 0, `lib/diagnostics.mjs 里出现了写盘/进程 API：${hits.join("、")}`);
	return "无写入 / 无进程 API";
});

// ------------------------------------------------------------------ CLI 行为

await check("C-20 --help 退出码 0，且列出关键选项", () => {
	const result = runCli(["--help"]);
	eq(result.code, 0, `--help 应退出 0（实际 ${result.code}）`);
	for (const needle of ["用法：", "--json", "--out", "--profile", "--home", "--include-logs", "--no-logs", "退出码"]) {
		ok(result.stdout.includes(needle), `--help 缺少 ${needle}`);
	}
	ok(HELP_TEXT === result.stdout, "导出的 HELP_TEXT 应与 --help 输出一致");
	return "exit 0";
});

await check("C-21 非法参数退出码 2（未知参数 / 缺取值 / 互斥开关）", () => {
	const cases = [
		[["--bogus"], "无法识别的参数"],
		[["--out"], "缺少取值"],
		[["--profile"], "缺少取值"],
		[["--home"], "缺少取值"],
		[["--include-logs", "--no-logs"], "互斥"],
		[["extra-positional"], "多余的位置参数"]
	];
	for (const [args, message] of cases) {
		const result = runCli(args);
		eq(result.code, 2, `${args.join(" ")} 应退出 2（实际 ${result.code}）`);
		ok(result.stderr.includes(message), `${args.join(" ")} 的 stderr 应包含「${message}」：${result.stderr.trim()}`);
	}
	return `${cases.length} 种非法参数`;
});

await check("C-22 --json：机器可读、聚焦 profile、默认不含日志", () => {
	const result = runCli(["--json", "--home", fixtureHome, "--profile", "web"], { env: fixtureEnv });
	eq(result.code, 0, `--json 应退出 0（实际 ${result.code}：${result.stderr.trim()}）`);
	const parsed = JSON.parse(result.stdout);
	eq(parsed.schema, SCHEMA, "schema 不对");
	eq(parsed.home.focus?.name, "web", "聚焦 profile 没生效");
	const engineLogs = parsed.sections.find((section) => section.id === "engine-logs");
	ok(engineLogs.items.some((item) => /未采集/.test(item.v)), "默认不该采集日志尾部");
	ok(!result.stderr.includes("[drydock-doctor] 报告已写入"), "没用 --out 时不该报告落盘");
	return "JSON 可解析";
});

await check("C-23 --out：落盘内容与 stdout 一致、无 BOM、明确打印路径到 stderr", () => {
	const outDir = join(tmpRoot, "cli-out");
	mkdirSync(outDir, { recursive: true });
	const target = join(outDir, "doctor.json");
	const result = runCli(["--out", target, "--home", fixtureHome, "--profile", "web"], { env: fixtureEnv });
	eq(result.code, 0, `--out 应退出 0（实际 ${result.code}：${result.stderr.trim()}）`);
	const bytes = readFileSync(target);
	ok(!(bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), "落盘文件不应带 BOM");
	const written = bytes.toString("utf8");
	ok(written.trimEnd() === result.stdout.trimEnd(), "落盘内容应与 stdout 一致");
	ok(result.stderr.includes(target), `stderr 应明确落盘路径（含 ${target}）：${result.stderr.trim()}`);
	return "一致 + 无 BOM";
});

await check("C-24 --home 指向不存在的目录：退出码 1（无法定位 DSH_HOME）", () => {
	const result = runCli(["--json", "--home", join(tmpRoot, "no-such-home")], { env: fixtureEnv });
	eq(result.code, 1, `应退出 1（实际 ${result.code}）`);
	ok(result.stderr.includes("无法定位 DSH_HOME"), `stderr 应说明无法定位 DSH_HOME：${result.stderr.trim()}`);
	const parsed = JSON.parse(result.stdout);
	eq(parsed.home.resolved, false, "报告里应标记 resolved=false");
	return "exit 1";
});

await check("C-25 --include-logs：引擎日志尾部进报告且已脱敏", () => {
	const result = runCli(["--json", "--include-logs", "--home", fixtureHome, "--profile", "web"], { env: fixtureEnv });
	eq(result.code, 0, `--include-logs 应退出 0（实际 ${result.code}）`);
	const parsed = JSON.parse(result.stdout);
	ok(!result.stdout.includes(FAKE_TOKEN), "--include-logs 的 JSON 里出现明文 token");
	const engineLogs = parsed.sections.find((section) => section.id === "engine-logs");
	const tail = engineLogs.items.find((item) => item.k.includes("尾部"));
	ok(tail && /engine stderr line/.test(tail.v), "应包含日志尾部");
	ok(/已脱敏/.test(tail.note ?? ""), "尾部应标注已脱敏");
	return "尾部 + 脱敏";
});

// ------------------------------------------------------------------ 单元：DSH_HOME 候选语义

await check("C-26 detectHomeCandidates：多候选同时存在 → 两个都报 + warning；空白 DSH_HOME 视为未设置", async () => {	const bothHome = join(tmpRoot, "both-home");
	const bothUserData = join(tmpRoot, "both-user-data");
	mkdirSync(join(bothHome, "profiles"), { recursive: true });
	mkdirSync(join(bothUserData, "harness", "profiles"), { recursive: true });
	const detection = detectHomeCandidates({
		env: { DSH_HOME: bothHome },
		homeDir: join(tmpRoot, "fake-home"),
		userDataDirs: [bothUserData]
	});
	eq(detection.authoritative, bothHome, "权威值应取环境变量");
	const sources = detection.candidates.map((candidate) => candidate.source).join("、");
	ok(sources.includes("环境变量 DSH_HOME") && sources.includes("桌面 userData/harness"), `候选来源不全：${sources}`);
	ok(detection.warnings.length >= 1 && detection.warnings[0].includes("候选"), `多候选应产生 warning：${detection.warnings.join(" / ")}`);

	const blank = detectHomeCandidates({
		env: { DSH_HOME: "   " },
		homeDir: join(tmpRoot, "fake-home"),
		userDataDirs: []
	});
	eq(blank.authoritative, join(tmpRoot, "fake-home", ".dsh"), "空白 DSH_HOME 必须视为未设置（回退 ~/.dsh）");
	const tilde = detectHomeCandidates({ env: { DSH_HOME: "~/custom-dsh" }, homeDir: join(tmpRoot, "fake-home"), userDataDirs: [] });
	eq(tilde.authoritative, join(tmpRoot, "fake-home", "custom-dsh"), "~ 前缀应按用户主目录展开");
	return "多候选 + 空白 + ~ 展开";
});

// ------------------------------------------------------------------ 桌面宿主（真包静态分析一手证据）

await check("C-27 桌面宿主：release 字段齐全 + 只读前部（不整读 4.7 MB）", () => {
	const section = sectionOf(diag, "desktop-host");
	eq(section.status, "ok", `桌面宿主应为 ok：${section.reason ?? ""}`);
	eq(section.title, "桌面宿主", "段落标题应为「桌面宿主」");
	const releaseVersion = section.items.find((item) => item.k === "release.version");
	eq(releaseVersion.v, HOST_RELEASE.version, "release.version 不对");
	const protocol = section.items.find((item) => item.k === "release.hostProtocolVersion");
	eq(String(protocol.v), String(HOST_RELEASE.hostProtocolVersion), "hostProtocolVersion 不对");
	ok(/关键字段/.test(protocol.note ?? ""), "hostProtocolVersion 必须标注为兼容性关键字段");
	ok(section.items.some((item) => item.k === "release.nodeVersion" && item.v === "24.21.0"), "release.nodeVersion 不对");
	ok(section.items.some((item) => item.k === "release.pnpmVersion" && item.v === "11.28.5"), "release.pnpmVersion 不对");
	const versions = section.items.find((item) => item.k.includes("桌面自带运行时"));
	ok(/node 24\.21\.0/.test(versions.v) && /pnpm 11\.28\.5/.test(versions.v), `自带运行时版本不对：${versions.v}`);
	const cli = section.items.find((item) => item.k === "桌面自带 CLI");
	ok(/dsh\.cmd/.test(cli.v), `桌面自带 CLI 未报到：${cli.v}`);
	ok(/不是 npm 的 dsh/.test(cli.note ?? ""), "必须说明桌面自带 CLI 不是 npm 的 dsh");
	// 有界读取：fixture 的 desktop-runtime.json > 300 KB，但只读前部
	eq(diag.desktopHost.found, true, "desktopHost.found 应为 true");
	eq(diag.desktopHost.release.version, HOST_RELEASE.version, "payload 里的 release 不对");
	ok(diag.desktopHost.read.fileBytes > 300 * 1024, `fixture 应造得足够大：${diag.desktopHost.read.fileBytes}`);
	ok(diag.desktopHost.read.readBytes < diag.desktopHost.read.fileBytes / 2, `只应读前部：读 ${diag.desktopHost.read.readBytes} / 共 ${diag.desktopHost.read.fileBytes}`);
	return `release ${diag.desktopHost.release.version} / protocol ${diag.desktopHost.release.hostProtocolVersion} / 读 ${diag.desktopHost.read.readBytes} 字节`;
});

await check("C-28 桌面宿主找不到安装目录：unavailable + 中文原因，不崩", async () => {
	const focused = await collect({ resourcesDirs: [join(tmpRoot, "no-resources")] });
	const section = sectionOf(focused, "desktop-host");
	eq(section.status, "unavailable", "找不到安装目录应为 unavailable");
	ok(typeof section.reason === "string" && section.reason.includes("桌面安装目录"), `原因应说明找不到安装目录：${section.reason}`);
	eq(focused.desktopHost.found, false, "desktopHost.found 应为 false");
	eq(sectionOf(focused, "profiles").status, "ok", "宿主缺失不应影响 profile 段");
	return "unavailable";
});

await check("C-29 打包态 app.asar（单个归档文件）：读不到内部路径时降级 warning + 说明", async () => {
	const focused = await collect({ resourcesDirs: [archiveResources] });
	const section = sectionOf(focused, "desktop-host");
	eq(section.status, "warning", `打包态应为 warning，实际 ${section.status}`);
	eq(focused.desktopHost.found, true, "有 app.asar / versions.json 时应算找到安装目录");
	eq(focused.desktopHost.release, null, "打包态读不到 release");
	const runtimeItem = section.items.find((item) => item.k === "desktop-runtime.json");
	ok(runtimeItem, "缺 desktop-runtime.json 项");
	ok(/app\.asar 是打包归档/.test(runtimeItem.note ?? ""), `应提示 app.asar 是归档、普通 Node 读不到内部路径：${runtimeItem.note ?? "（无 note）"}`);
	ok(focused.desktopHost.asarBytes > 0, "应报出 app.asar 文件大小（只读事实）");
	return "warning + 归档说明";
});

await check("C-30 系统 dsh（npm 全局）与桌面自带运行时分开报，不混为一个", async () => {
	const focused = await collect({ env: { DSH_HOME: fixtureHome, DSH_ENGINE_PORT: "6561", APPDATA: fakeAppData } });
	eq(focused.environment.systemDsh.found, true, "应探测到 npm 全局的 dsh");
	eq(focused.environment.systemDsh.version, "0.2.2-rc.5", "系统 dsh 版本不对");
	const envSection = sectionOf(focused, "env");
	const systemItem = envSection.items.find((item) => item.k === "系统 dsh（npm 全局）");
	ok(/0\.2\.2-rc\.5/.test(systemItem.v), `环境段应单独列出系统 dsh：${systemItem.v}`);
	eq(focused.desktopHost.release.version, HOST_RELEASE.version, "桌面宿主 release 应单独报");
	ok(focused.desktopHost.release.version !== focused.environment.systemDsh.version, "两个版本必须分开报（样例故意不同）");
	return `系统 dsh ${focused.environment.systemDsh.version} ｜ 桌面宿主 ${focused.desktopHost.release.version}`;
});

await check("C-31 只读红线：--out 落在桌面安装目录时拒绝（exit 2，且不创建文件）", () => {
	const target = join(fixtureResources, "doctor-evil.json");
	const result = runCli(["--json", "--out", target, "--home", fixtureHome], { env: fixtureEnv });
	eq(result.code, 2, `写安装目录应退出 2（实际 ${result.code}）`);
	ok(result.stderr.includes("拒绝把报告写进桌面安装目录"), `stderr 应说明拒绝原因：${result.stderr.trim()}`);
	ok(!existsSync(target), "安装目录里不该出现任何新文件");
	return "exit 2 + 未落盘";
});

// ------------------------------------------------------------------ C-32..C-37 自定义安装目录发现
// 背景（2026-11-26 真实反馈）：用户把桌面版装在 %LOCALAPPDATA%\Programs\DSH NEXT，
// doctor 却在普通 Node 进程里用 process.execPath（node.exe）反推出 C:\apps\node22\resources，
// 报 desktopHost.found:false → 用户以为工具不支持桌面版。

await check("C-32 looksLikeDesktopExecutable：node.exe 不触发 resources 反推", async () => {
	const { looksLikeDesktopExecutable } = await import("./lib/diagnostics.mjs");
	for (const exe of ["C:\\Program Files\\nodejs\\node.exe", "C:\\apps\\node22\\node.exe", "/usr/bin/node", "C:\\x\\nodejs.exe"]) {
		eq(looksLikeDesktopExecutable(exe), false, `不应把 ${exe} 当桌面壳`);
	}
	for (const exe of ["C:\\Users\\u\\AppData\\Local\\Programs\\DSH NEXT\\DSH NEXT.exe", "C:\\apps\\DeepSeek Harness\\DeepSeek Harness.exe", "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness", "C:\\x\\electron.exe"]) {
		eq(looksLikeDesktopExecutable(exe), true, `应把 ${exe} 当桌面壳`);
	}
	eq(looksLikeDesktopExecutable(""), false, "空字符串应为 false");
	eq(looksLikeDesktopExecutable(null), false, "null 应为 false");
	return "node/nodejs 全部排除，dsh/deepseek/harness/electron 全认";
});

await check("C-33 defaultResourcesDirs：execPath=node.exe 时不产出 <node目录>/resources", async () => {
	const { defaultResourcesDirs } = await import("./lib/diagnostics.mjs");
	const dirs = defaultResourcesDirs({
		env: {},
		homeDir: "C:\\Users\\u",
		platform: "win32",
		execPath: "C:\\apps\\node22\\node.exe",
		resourcesPath: undefined
	});
	eq(dirs.length, 0, `不该产出任何候选（实际 ${JSON.stringify(dirs)}）`);
	ok(!dirs.some((d) => /node22/i.test(d)), "绝不能出现 C:\\apps\\node22\\resources 这类误导候选");
	const deskDirs = defaultResourcesDirs({
		env: {},
		homeDir: "C:\\Users\\u",
		platform: "win32",
		execPath: "C:\\Users\\u\\AppData\\Local\\Programs\\DSH NEXT\\DSH NEXT.exe",
		resourcesPath: undefined
	});
	ok(deskDirs.some((d) => /DSH NEXT[\\/]resources$/i.test(d)), `桌面壳 execPath 应推出 resources：${JSON.stringify(deskDirs)}`);
	return "node.exe → 0 候选；DSH NEXT.exe → 推出 resources";
});

await check("C-34 discoverDesktopInstalls：认出自定义安装名 `DSH NEXT`（用户实测场景）", async () => {
	const { discoverDesktopInstalls } = await import("./lib/diagnostics.mjs");
	// discoverDesktopInstalls 扫的是 <LOCALAPPDATA>\Programs\*，所以夹具要摆成这个形状
	const localAppData = join(tmpRoot, "probe-localappdata");
	const root = join(localAppData, "Programs");
	// ① 自定义命名：DSH NEXT
	mkdirSync(join(root, "DSH NEXT", "resources"), { recursive: true });
	writeFileSync(join(root, "DSH NEXT", "resources", "app.asar"), "x", "utf8");
	// ② 完全不像 DSH 的 Electron 应用（Xmind）：只有 resources/app.asar，必须排除
	mkdirSync(join(root, "Xmind", "resources"), { recursive: true });
	writeFileSync(join(root, "Xmind", "resources", "app.asar"), "x", "utf8");
	// ③ 名字不像 DSH，但有官方解包特征 app.asar.unpacked/dsh/
	mkdirSync(join(root, "WeirdName", "resources", "app.asar.unpacked", "dsh"), { recursive: true });
	writeFileSync(join(root, "WeirdName", "resources", "app.asar.unpacked", "dsh", "package.json"), "{}", "utf8");
	// ④ 名字不像 DSH，但有 app-update.yml 指向 deepseek
	mkdirSync(join(root, "Another", "resources"), { recursive: true });
	writeFileSync(join(root, "Another", "resources", "app-update.yml"), "provider: generic\nurl: https://download.deepseek.com/dsh-desk/feeds/win-x64/\n", "utf8");
	// ⑤ 只有 resources 目录、什么都不像的
	mkdirSync(join(root, "PlainApp", "resources"), { recursive: true });
	writeFileSync(join(root, "PlainApp", "resources", "app.asar"), "x", "utf8");

	const found = discoverDesktopInstalls({ env: { LOCALAPPDATA: localAppData }, platform: "win32" });
	const norm = found.map((d) => d.replace(/\\/g, "/").toLowerCase());
	ok(norm.some((d) => d.endsWith("/dsh next/resources")), `应认出 DSH NEXT：${JSON.stringify(found)}`);
	ok(norm.some((d) => d.endsWith("/weirdname/resources")), "应靠 app.asar.unpacked/dsh 认出解包特征");
	ok(norm.some((d) => d.endsWith("/another/resources")), "应靠 app-update.yml 的 deepseek 域认出");
	ok(!norm.some((d) => d.includes("/xmind/")), `绝不能把 Xmind 当成 DSH 桌面版：${JSON.stringify(found)}`);
	ok(!norm.some((d) => d.includes("/plainapp/")), `纯 resources 目录不够：${JSON.stringify(found)}`);
	return `认出 ${found.length} 个，Xmind/PlainApp 正确排除`;
});

await check("C-35 discoverDesktopInstalls：目录不存在/无权限时安静返回空数组", async () => {
	const { discoverDesktopInstalls } = await import("./lib/diagnostics.mjs");
	eq(discoverDesktopInstalls({ env: { LOCALAPPDATA: join(tmpRoot, "nope-does-not-exist") }, platform: "win32" }).length, 0, "不存在的根应返回空");
	eq(discoverDesktopInstalls({ env: {}, platform: "win32" }).length, 0, "没有任何安装根时应返回空");
	eq(discoverDesktopInstalls({ env: {}, platform: "linux" }).length >= 0, true, "linux 分支不应抛");
	return "全部安静返回";
});

await check("C-36 collectDiagnostics：自定义安装的桌面版能被报告认出", async () => {
	// 用真实 fixture 走一遍完整收集：LOCALAPPDATA 指向含 `DSH NEXT` 的目录
	const localAppData = join(tmpRoot, "CustomRoot");
	const installDir = join(localAppData, "Programs", "DSH NEXT");
	mkdirSync(join(installDir, "resources", "app.asar.unpacked", "dsh"), { recursive: true });
	// 放一个最小的 desktop-runtime.json（有界读取会取 release 段）
	writeFileSync(
		join(installDir, "resources", "app.asar.unpacked", "dsh", "desktop-runtime.json"),
		JSON.stringify({ schemaVersion: 1, release: { version: "9.9.9-custom", hostProtocolVersion: 4, nodeVersion: "24.0.0", pnpmVersion: "11.0.0" }, platform: "win32", arch: "x64", sharedPackages: [], files: [] }),
		"utf8"
	);
	// ⚠️ 必须把 fixtureEnv 里预设的 DSH_DESKTOP_RESOURCES_DIR 去掉，否则它会优先命中旧夹具
	const env = { ...fixtureEnv, LOCALAPPDATA: localAppData };
	delete env.DSH_DESKTOP_RESOURCES_DIR;
	delete env.DSH_DESKTOP_USER_DATA_DIR;
	const diag = await collectDiagnostics({ env, homeDir: fixtureHome, platform: "win32" });
	ok(diag.desktopHost.found === true, `自定义安装的桌面版应被认出（found=${diag.desktopHost.found}）`);
	eq(diag.desktopHost.release?.version, "9.9.9-custom", `应报出自定义安装的宿主版本：${JSON.stringify(diag.desktopHost.release)}`);
	eq(diag.desktopHost.release?.hostProtocolVersion, 4, "hostProtocolVersion 应被读出（兼容性判断关键字段）");
	return `found=true，版本 ${diag.desktopHost.release?.version}`;
});

await check("C-37 `C:\\apps\\node22\\resources` 类误导候选不再出现在报告里", async () => {
	const env = { ...fixtureEnv, LOCALAPPDATA: join(tmpRoot, "no-programs") };
	delete env.DSH_DESKTOP_RESOURCES_DIR;
	delete env.DSH_DESKTOP_USER_DATA_DIR;
	const diag = await collectDiagnostics({ env, homeDir: fixtureHome, platform: "win32" });
	const probed = (diag.desktopHost.probed ?? []).map((entry) => String(entry.dir ?? ""));
	ok(!probed.some((d) => /node22|nodejs/i.test(d)), `不该探查 node 安装目录：${JSON.stringify(probed)}`);
	eq(diag.desktopHost.found, false, "没有桌面版时应如实报 found=false");
	return "报告里无 node 安装目录候选";
});

// ------------------------------------------------------------------ 汇总

try {
	rmSync(tmpRoot, { recursive: true, force: true });
} catch {
	/* 临时目录清不掉不影响结论 */
}

if (failures > 0) {
	console.error(`\nRESULT: FAIL（${failures} / ${checks} 项失败）`);
	process.exit(1);
}
console.log(`\nRESULT: PASS（${checks} 项断言全绿）`);
process.exit(0);
