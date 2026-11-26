// test-capabilities.mjs — M1（lib/capabilities.mjs + lib/envprobe.mjs）逐条自测，不依赖真实桌面版。
// 用法: node test-capabilities.mjs        （退出码 0 = 全绿；1 = 有失败）
//
// 覆盖契约 §2/§3/§6：
//   - web 表全开、desktop 表 6 项关掉/受限且每项都有中文理由；
//   - capabilitiesFor(undefined/未知) 退回 web 表本体（网页版零回归的关键断言）；
//   - 能力表冻结（运行时改不动）、assertCapability 的机器可读 code；
//   - fixture 造 profiles/desktop/{package.json,lock,cordis.patch.yml} → 判 desktop、locked、lockText；
//   - 无 desktop 目录 → 判 web 且 confidence 合理；
//   - BOM 的 cordis.patch.yml / lock 被识别并报 bomStripped；
//   - 4 段测试版号原样返回；
//   - resolvePortCandidates 顺序 / 去重 / 上限 8 / 绝不试连。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, CAPABILITY_KINDS, capabilitiesFor, capabilityReason, assertCapability } from "./lib/capabilities.mjs";
import {
	probeEnv,
	detectHomeCandidates,
	detectDesktop,
	probeHostVersion,
	resolvePortCandidates,
	stripBom,
	PORT_CANDIDATE_LIMIT,
	DESKTOP_PROFILE_NAME
} from "./lib/envprobe.mjs";

const CJK = /[\u4e00-\u9fff]/;
const tmpRoots = [];

function tmpRoot(tag) {
	const dir = mkdtempSync(join(tmpdir(), `drydock-${tag}-`));
	tmpRoots.push(dir);
	return dir;
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, msg) {
	if (!Object.is(actual, expected)) throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实测 ${JSON.stringify(actual)}）`);
}
function assertDeepEq(actual, expected, msg) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${msg}（期望 ${b}，实测 ${a}）`);
}
function assertIncludes(haystack, needle, msg) {
	if (typeof haystack !== "string" || !haystack.includes(needle)) {
		throw new Error(`${msg}（未找到 ${JSON.stringify(needle)}，实测 ${JSON.stringify(haystack)}）`);
	}
}
function assertCnReason(text, label) {
	assert(typeof text === "string" && text.trim() !== "", `${label}：理由为空（不许灰着不给理由）`);
	assert(CJK.test(text), `${label}：理由不是中文（${text}）`);
	assert(text.length >= 10, `${label}：理由过短（${text}）`);
}

// ---------------------------------------------------------------- fixtures

function writeProfile(home, opts = {}) {
	const {
		profile = DESKTOP_PROFILE_NAME,
		lockText = "pid=4242\nstarted=2026-11-26T10:00:00Z\n",
		patchText = "plugins:\n  dsh-drydock:\n    enabled: true\n",
		runtimeJson = null,
		profilePackage = { name: "dsh-profile-desktop", version: "0.0.0", dependencies: { "@deepseek-ai/dsh": "0.2.2-rc.5" } }
	} = opts;
	const dir = join(home, "profiles", profile);
	mkdirSync(dir, { recursive: true });
	if (profilePackage !== null) writeFileSync(join(dir, "package.json"), JSON.stringify(profilePackage, null, "\t") + "\n", "utf8");
	if (lockText !== null) writeFileSync(join(dir, "lock"), lockText, "utf8");
	if (patchText !== null) writeFileSync(join(dir, "cordis.patch.yml"), patchText, "utf8");
	if (runtimeJson !== null) writeFileSync(join(dir, "desktop-runtime.json"), JSON.stringify(runtimeJson, null, "\t") + "\n", "utf8");
	return dir;
}

function makeHome(tag, opts = {}) {
	const base = tmpRoot(tag);
	const home = join(base, ".dsh");
	mkdirSync(home, { recursive: true });
	const profile = writeProfile(home, opts);
	return { base, home, profile };
}

let passed = 0;
let failed = 0;

function group(name, fn) {
	try {
		fn();
		passed++;
		console.log(`RESULT: PASS - ${name}`);
	} catch (error) {
		failed++;
		console.error(`RESULT: FAIL - ${name}\n   ${error && error.stack ? error.stack.split("\n").slice(0, 4).join("\n   ") : error}`);
	}
}

// ---------------------------------------------------------------- 1. 能力表

group("能力表：web 全开（布尔全 true，模式为 read-write / own）", () => {
	const web = CAPABILITIES.web;
	for (const key of ["takeoverOfficialPage", "livePnpmOps", "hotToggle", "autostart", "browserLauncher", "market", "rescueDaemon", "offlineDiagnostics"]) {
		assertEq(web[key], true, `web.${key} 应为 true`);
	}
	assertEq(web.scenarios, "read-write", "web.scenarios");
	assertEq(web.engineLifecycle, "own", "web.engineLifecycle");
	assertEq(web.id, "web", "web.id");
	assertDeepEq(Object.keys(web).sort(), Object.keys(CAPABILITIES.desktop).sort(), "web/desktop 能力键集合必须完全一致（否则 UI 渲染会出现没理由的空洞）");
});

group("能力表：desktop 6 项关掉/受限，且每项都有具体中文理由", () => {
	const desktop = CAPABILITIES.desktop;
	const six = ["takeoverOfficialPage", "livePnpmOps", "hotToggle", "autostart", "browserLauncher", "market"];
	for (const key of six) {
		assert(desktop[key] !== true, `desktop.${key} 应为关掉/受限（实测 ${JSON.stringify(desktop[key])}）`);
		assertCnReason(capabilityReason("desktop", key), `desktop.${key}`);
	}
	// 任务点名的接管理由：必须有具体依据 + 替代做法，不是"不支持"这种空话
	assertIncludes(capabilityReason("desktop", "takeoverOfficialPage"), "PROTECTED_PLUGINS", "takeover 理由须点出官方保护集");
	assertIncludes(capabilityReason("desktop", "takeoverOfficialPage"), "桌面版自带插件页", "takeover 理由须给出替代做法");
	assertIncludes(capabilityReason("desktop", "livePnpmOps"), "Electron 完全退出", "livePnpmOps 理由须点出前置条件");
	assertIncludes(capabilityReason("desktop", "autostart"), "拒绝", "autostart 理由须写明拒绝（不是静默跳过）");
	// 全表非 true 项（含 scenarios / engineLifecycle 两个模式降级）一视同仁必须有理由
	const notTrue = Object.entries(desktop)
		.filter(([key, value]) => key !== "id" && value !== true)
		.map(([key]) => key);
	assert(notTrue.length >= 6, `desktop 非 true 项至少 6 个（实测 ${notTrue.length}: ${notTrue.join(",")}）`);
	for (const key of notTrue) assertCnReason(capabilityReason("desktop", key), `desktop.${key}`);
	// web 侧同样每项都有理由（UI 可解释"为什么这里能点"）
	for (const key of Object.keys(CAPABILITIES.web).filter((key) => key !== "id")) assertCnReason(capabilityReason("web", key), `web.${key}`);
});

group("capabilitiesFor：未识别形态退回 web 表本体（网页版零回归）", () => {
	for (const kind of [undefined, null, "", "nope", "desktop ", "WEB", 0, false, {}, [], "__proto__", "constructor", "hasOwnProperty"]) {
		assertEq(capabilitiesFor(kind), CAPABILITIES.web, `capabilitiesFor(${JSON.stringify(kind)}) 必须是 web 表本体`);
	}
	assertEq(capabilitiesFor("desktop"), CAPABILITIES.desktop, "capabilitiesFor('desktop')");
	assertEq(CAPABILITY_KINDS.length, 2, "CAPABILITY_KINDS 只应有 web/desktop");
	assertEq(capabilitiesFor("desktop").takeoverOfficialPage, false, "desktop 表内容未被污染");
});

group("能力表冻结：运行时改不动（表本体 + 每一项）", () => {
	for (const table of [CAPABILITIES, CAPABILITIES.web, CAPABILITIES.desktop]) assert(Object.isFrozen(table), "存在未冻结的表");
	const before = CAPABILITIES.desktop.takeoverOfficialPage;
	try {
		CAPABILITIES.desktop.takeoverOfficialPage = true;
	} catch {
		/* ESM 严格模式 ↔ 冻结对象会抛，忽略：下面断言值没变即可 */
	}
	try {
		CAPABILITIES.web.market = false;
	} catch {
		/* 同上 */
	}
	try {
		CAPABILITIES.evil = { id: "evil" };
	} catch {
		/* 同上 */
	}
	assertEq(CAPABILITIES.desktop.takeoverOfficialPage, before, "desktop.takeoverOfficialPage 被改动了（未冻结）");
	assertEq(CAPABILITIES.web.market, true, "web.market 被改动了（未冻结）");
	assertEq(capabilitiesFor("evil"), CAPABILITIES.web, "新增形态键不应生效；未识别形态必须退回 web");
});

group("capabilityReason / assertCapability：机器可读 code + 中文理由（不许静默）", () => {
	assertIncludes(capabilityReason("weird", "market"), "已按网页版处理", "未识别形态的理由须点明降级");
	assertIncludes(capabilityReason("desktop", "noSuchKey"), "未知能力键", "未知键须明确报出");
	assertIncludes(capabilityReason("desktop", ""), "能力键非法", "空键须明确报出");

	const ok = assertCapability("web", "takeoverOfficialPage");
	assertEq(ok.ok, true, "web.takeoverOfficialPage 应放行");
	assertEq(ok.code, "capability-enabled", "放行 code");
	assertCnReason(ok.message, "放行理由");

	const no = assertCapability("desktop", "takeoverOfficialPage");
	assertEq(no.ok, false, "desktop.takeoverOfficialPage 应拒绝");
	assertEq(no.code, "capability-disabled", "拒绝 code 必须是 capability-disabled");
	assertCnReason(no.message, "拒绝理由");
	assertIncludes(no.message, "桌面版自带插件页", "拒绝理由须给出替代路径");

	const gated = assertCapability("desktop", "hotToggle");
	assertEq(gated.ok, false, "desktop.hotToggle 是 gated，不应默认放行");
	assertEq(gated.code, "capability-disabled", "gated 的 code");
	assertEq(gated.gate, "gated", "gated 的 gate 标记");

	assertEq(assertCapability("desktop", "scenarios").ok, false, "desktop.scenarios=read-only 应拒绝写场景");
	assertEq(assertCapability("desktop", "scenarios").gate, "mode", "模式限制的 gate");
	assertEq(assertCapability("web", "scenarios").ok, true, "web.scenarios=read-write 应放行");
	assertEq(assertCapability("desktop", "engineLifecycle").ok, false, "desktop.engineLifecycle=delegated 应拒绝");
	assertEq(assertCapability("web", "engineLifecycle").ok, true, "web.engineLifecycle=own 应放行");
	assertEq(assertCapability("desktop", "rescueDaemon").ok, true, "desktop.rescueDaemon 应放行（桌面唯一主战场）");
	assertEq(assertCapability("desktop", "offlineDiagnostics").ok, true, "desktop.offlineDiagnostics 应放行");

	const unknown = assertCapability("desktop", "noSuchKey");
	assertEq(unknown.ok, false, "未知键不能当放行");
	assertEq(unknown.code, "capability-unknown", "未知键 code");

	const fallback = assertCapability("weird", "market");
	assertEq(fallback.ok, true, "未识别形态应退回 web 并放行 market");
	assertIncludes(fallback.message, "已按网页版处理", "退回时必须说明");
});

// ---------------------------------------------------------------- 2. 桌面判定

group("detectDesktop：fixture 判 desktop、locked:true、lockText 被读到（0.9 用注入链，不枚举真进程）", () => {
	const { home, profile } = makeHome("desk");
	const d = detectDesktop({ dshHome: home, env: {} });
	assertEq(d.isDesktop, true, "fixture 应判 desktop");
	assertEq(d.confidence, 0.8, "无 Electron 环境时 confidence 取 0.8 档（profile 存在且已初始化）");
	assertEq(d.locked, true, "locked 应为 true");
	assertIncludes(d.lockText, "pid=4242", "lockText 应被读到");
	assertEq(d.lockText.length <= 200, true, "lockText 必须截断 200 字符");
	assertEq(d.initialized, true, "initialized 应为 true");
	assertEq(d.profileDir, profile, "profileDir");
	assert(d.reasons.some((r) => r.code === "desktop:profile-initialized" && r.matched), "须记录命中的 0.8 证据");
	assert(d.reasons.some((r) => r.code === "desktop:no-electron-env" && !r.matched), "须记录未命中的 0.9 证据（全部记录 reason）");

	const d9 = detectDesktop({
		dshHome: home,
		env: { ELECTRON_RUN_AS_NODE: "1" },
		processTree: [
			{ pid: 100, ppid: 200, name: "node.exe" },
			{ pid: 200, ppid: 1, name: "DeepSeek Harness.exe" }
		]
	});
	assertEq(d9.confidence, 0.9, "ELECTRON_RUN_AS_NODE + 父进程链含桌面可执行 → 0.9");
	assert(d9.electron.matched.length > 0, "应记录匹配到的桌面进程");

	const unverified = detectDesktop({ dshHome: home, env: { ELECTRON_RUN_AS_NODE: "1" } });
	assertEq(unverified.confidence, 0.8, "父进程链不可核实不得按 0.9 判定");
	assert(unverified.warnings.some((w) => w.code === "electron-env-unverified"), "必须报 electron-env-unverified，不许静默");
	// {selfPid, processes} 形态也要能走通
	const d9b = detectDesktop({
		dshHome: home,
		env: { ELECTRON_RUN_AS_NODE: "1" },
		processTree: { selfPid: 100, processes: [{ pid: 100, ppid: 200, name: "node.exe" }, { pid: 200, ppid: 1, name: "dsh-desktop.exe" }] }
	});
	assertEq(d9b.confidence, 0.9, "selfPid/processes 形态的注入链也要命中 0.9");
	// 辅助证据不单独定罪
	const auxOnly = detectDesktop({ dshHome: home, env: {}, observedPorts: [39001] });
	assertEq(auxOnly.isDesktop, true, "本例 profile 已初始化，仍判 desktop（辅助仅用于加分）");
	assertEq(auxOnly.confidence, 0.8, "辅助证据不得把 confidence 抬到主判之上");
	assertEq(auxOnly.strength, "strong", "主判命中 → strong");

	const dNoHome = detectDesktop({ dshHome: null, env: {} });
	assertEq(dNoHome.isDesktop, false, "缺 dshHome 不判桌面");
	assert(dNoHome.warnings.some((w) => w.code === "desktop-probe-no-home"), "缺 dshHome 必须明确报错（不能当「不是桌面版」）");
});

// ---------------------------------------------------------------- 3. probeEnv

group("probeEnv：桌面 fixture → kind=desktop、confidence=0.8、契约字段齐全", () => {
	const { base, home, profile } = makeHome("probe-desk");
	const p = probeEnv({ env: { DSH_HOME: home }, homeDir: base });
	assertEq(p.kind, "desktop", "kind");
	assertEq(p.confidence, 0.8, "confidence");
	assertEq(p.dshHome, home, "dshHome");
	assertEq(p.profileName, "desktop", "profileName");
	assertEq(p.profileDir, profile, "profileDir");
	assertEq(p.desktopLockPresent, true, "desktopLockPresent");
	assertIncludes(p.desktopLockText, "pid=4242", "desktopLockText");
	assertCnReason(p.reason, "probeEnv.reason");
	assert(p.portCandidates.includes(3080), "端口候选应含默认 3080");
	assertEq(p.hostVersion, "0.2.2-rc.5", "hostVersion 应来自 package.json 依赖");
	assertEq(p.hostVersionSource, "package.json", "hostVersionSource");
	assert(p.homeCandidates.every((c) => c.includes("（来源：")), "每个候选 home 都要带来源说明");
	assertIncludes(p.homeCandidateMessage, "检测到 1 个候选", "候选数量必须如实报出（DSH_HOME 与默认 ~/.dsh 同路径会去重）");
	assert(p.reasons.length > 0, "reasons 不能为空");
	assertEq(p.portVerify.invoked, false, "端口候选不得试连");
	assert(p.codes.includes("desktop:profile-initialized"), "codes 应含命中的机器码");
});

group("probeEnv：无 desktop 目录 → kind=web（零回归）、中文理由、能力表全开", () => {
	const base = tmpRoot("probe-web");
	const home = join(base, ".dsh");
	mkdirSync(join(home, "profiles", "web"), { recursive: true });
	const p = probeEnv({ env: {}, homeDir: base });
	assertEq(p.kind, "web", "kind");
	assertEq(p.confidence, 0.7, "无桌面证据时 confidence 取 0.7 档");
	assertEq(p.desktopLockPresent, false, "desktopLockPresent");
	assertEq(p.desktopLockText, null, "desktopLockText 应为 null");
	assertEq(p.profileName, "web", "profileName 默认 web");
	assertEq(p.profileDir, join(home, "profiles", "web"), "profileDir");
	assertCnReason(p.reason, "probeEnv.reason");
	assertIncludes(p.reason, "按网页版处理", "理由须说明按网页版处理");
	assertEq(p.portCandidates[0], 3080, "默认引擎端口应排第一");
	assertEq(capabilitiesFor(p.kind), CAPABILITIES.web, "web 形态必须拿到 web 表本体（零回归）");
	assert(capabilitiesFor(p.kind).takeoverOfficialPage && capabilitiesFor(p.kind).livePnpmOps && capabilitiesFor(p.kind).hotToggle, "web 能力全开");
});

group("probeEnv：profiles/desktop 存在但未初始化 → unknown（不猜、不启用桌面行为）", () => {
	const base = tmpRoot("probe-uninit");
	const home = join(base, ".dsh");
	mkdirSync(join(home, "profiles", "desktop"), { recursive: true });
	const p = probeEnv({ env: { DSH_HOME: home }, homeDir: base });
	assertEq(p.kind, "unknown", "未初始化目录不能判 desktop，也不能静默判 web");
	assertEq(p.confidence, 0.4, "unknown 的 confidence");
	assertCnReason(p.reason, "unknown 的理由");
	assert(p.codes.includes("unknown-desktop-profile-uninitialized"), "须有机器码");
	assertEq(p.desktopLockPresent, false, "无 lock");
});

// ---------------------------------------------------------------- 4. BOM

group("BOM：cordis.patch.yml / lock 带 BOM → 剥离并上报（bomStripped + warning，不静默）", () => {
	const { base, home, profile } = makeHome("bom", {
		lockText: "\uFEFFpid=7777\n",
		patchText: "\uFEFFplugins:\n  dsh-drydock:\n    enabled: true\n"
	});
	const d = detectDesktop({ dshHome: home, env: {} });
	assertEq(d.patch.bomStripped, true, "patch 的 BOM 应被识别并上报 bomStripped");
	assert(d.bomStrippedPaths.includes(join(profile, "cordis.patch.yml")), "bomStrippedPaths 应含 patch 路径");
	assertEq(d.lockBomStripped, true, "lock 的 BOM 应被识别");
	assertIncludes(d.lockText, "pid=7777", "lockText 应已剥离 BOM");
	assertEq(d.lockText.startsWith("\uFEFF"), false, "lockText 不许残留 BOM");
	assert(d.warnings.some((w) => w.code === "bom-stripped"), "必须有 bom-stripped warning，不许静默");
	assertEq(d.hasPatch, true, "patch 文件存在性正常");

	const p = probeEnv({ env: { DSH_HOME: home }, homeDir: base });
	assertEq(p.kind, "desktop", "带 BOM 也要能正常判 desktop");
	assertEq(p.bomStripped.found, true, "EnvProbe.bomStripped.found");
	assert(p.bomStripped.files.some((f) => f.endsWith("cordis.patch.yml")), "EnvProbe.bomStripped.files 应含 patch");

	const s = stripBom("\uFEFF\uFEFF{ \"a\": 1 }");
	assertEq(s.text, '{ "a": 1 }', "stripBom 剥离结果");
	assertEq(s.bomStripped, true, "stripBom.bomStripped");
	assertEq(s.bomCount, 2, "重复 BOM 也要计数");
	assertEq(stripBom('{"a":1}').bomStripped, false, "无 BOM 时不误报");
});

// ---------------------------------------------------------------- 5. DSH_HOME 权威化

group("detectHomeCandidates：DSH_HOME 与桌面 userData/harness 并存且不同 → 都进候选 + warning", () => {
	const base = tmpRoot("homes");
	const envHome = join(base, "envhome");
	mkdirSync(envHome, { recursive: true });
	const userData = join(base, "userdata");
	const desktopHome = join(userData, "harness");
	mkdirSync(desktopHome, { recursive: true });
	const homeDir = join(base, "user");
	const env = { DSH_HOME: envHome, DSH_DESKTOP_USERDATA: userData };
	const r = detectHomeCandidates({ env, homeDir, platform: "win32" });
	assertEq(r.authoritative, envHome, "权威 home 必须取环境变量");
	assertEq(r.candidates.length, 3, "env + 默认 ~/.dsh + 桌面 userData/harness 共 3 个候选");
	assertIncludes(r.message, "检测到 3 个候选", "必须报出「检测到 N 个候选」");
	for (const c of r.candidates) assert(typeof c.source === "string" && c.source !== "", `候选 ${c.path} 缺来源说明`);
	assert(r.candidates.some((c) => c.path === desktopHome && c.source.includes("userData/harness")), "桌面 home 必须进候选并标注来源");
	assertEq(r.candidates.filter((c) => c.authoritative).length, 1, "权威候选只能有一个");
	const conflict = r.warnings.find((w) => w.code === "home-candidates-conflict");
	assert(Boolean(conflict), "并存且不同必须置一条 warning");
	assertCnReason(conflict.message, "home-candidates-conflict.message");

	const p = probeEnv({ env, homeDir, platform: "win32" });
	assert(p.homeCandidates.length >= 2, "homeCandidates 至少 2 项");
	assert(p.homeCandidates.every((c) => c.includes("（来源：")), "homeCandidates 每项都带来源说明");
	assertIncludes(p.homeCandidateMessage, "检测到 3 个候选", "probeEnv 也要报候选数");
	assert(p.warnings.some((w) => w.code === "home-candidates-conflict"), "probeEnv 的 warnings 也要带上冲突");

	// 显式 DSH_HOME 指向不存在的目录 → 必须报，不许静默
	const missing = detectHomeCandidates({ env: { DSH_HOME: join(base, "nope") }, homeDir, platform: "win32" });
	assert(missing.warnings.some((w) => w.code === "home-missing"), "DSH_HOME 不存在时必须警告");
});

// ---------------------------------------------------------------- 6. 宿主版本

group("probeHostVersion：4 段测试版号原样返回（desktop-runtime.json 优先，不做 semver 解析）", () => {
	const { home } = makeHome("ver", { runtimeJson: { appVersion: "0.1.7-rc.1.20260924.1" } });
	const v = probeHostVersion({ dshHome: home });
	assertEq(v.version, "0.1.7-rc.1.20260924.1", "4 段测试版号必须原样返回");
	assertEq(v.source, "desktop-runtime.json", "source 应为 desktop-runtime.json");
	assertEq(v.field, "appVersion", "field");
	assertEq(v.code, "host-version-found", "code");
	assertIncludes(v.message, "原样返回", "须说明未做 semver 解析");
	const p = probeEnv({ env: { DSH_HOME: home }, homeDir: join(home, "..") });
	assertEq(p.hostVersion, "0.1.7-rc.1.20260924.1", "probeEnv 也要拿到 4 段版号");
	assertEq(p.hostVersionSource, "desktop-runtime.json", "probeEnv.hostVersionSource");
});

group("probeHostVersion：package.json 依赖兜底 + 无产物时明确报 code（不拿 npm 版本冒充）", () => {
	const { home } = makeHome("ver-pkg");
	const v = probeHostVersion({ dshHome: home });
	assertEq(v.version, "0.2.2-rc.5", "package.json 依赖里的宿主版本");
	assertEq(v.source, "package.json", "source");
	assertEq(v.field, "dependencies['@deepseek-ai/dsh']", "field 应指向依赖项");

	const emptyHome = tmpRoot("ver-empty");
	const none = probeHostVersion({ dshHome: emptyHome });
	assertEq(none.version, null, "无产物时 version 必须 null（不拿 npm 全局 dsh 冒充）");
	assertEq(none.source, null, "source 必须 null");
	assertEq(none.code, "host-version-unavailable", "code");
	assertCnReason(none.message, "host-version-unavailable.message");
	assert(none.checked.length === 3, "三个 app 侧产物都要记录尝试过");
});

// ---------------------------------------------------------------- 7. 端口候选

group("resolvePortCandidates：顺序 / 去重 / 上限 8 / 绝不试连", () => {
	const { home, profile } = makeHome("ports");
	writeFileSync(join(profile, ".open-boot.pid"), JSON.stringify({ app: "dsh-open-boot", pid: 4242, port: 3999 }) + "\n", "utf8");
	let healthCalls = 0;
	const r = resolvePortCandidates({
		env: { DSH_ENGINE_PORT: "3090" },
		profileDir: profile,
		healthFn: () => {
			healthCalls++;
			return Promise.resolve({ ok: true });
		},
		observedPorts: [3091, "3090", 3091, 3092, 3093, 3094, 3095, 3096, 3097, 3098]
	});
	assertDeepEq(r.ports, [3090, 3999, 3080, 3091, 3092, 3093, 3094, 3095], "端口候选顺序必须是 env → .open-boot.pid → 默认 3080 → 观测，且去重后取前 8");
	assertEq(r.ports.length, PORT_CANDIDATE_LIMIT, "上限必须是 PORT_CANDIDATE_LIMIT（8）");
	assertDeepEq(r.dropped.map((d) => d.port), [3096, 3097, 3098], "超限候选进 dropped，不静默丢弃");
	assert(r.warnings.some((w) => w.code === "port-candidates-truncated"), "超限必须告警");
	assertEq(healthCalls, 0, "resolvePortCandidates 不许试连（注入的 healthFn 调用次数必须为 0）");
	assertEq(r.verify.invoked, false, "verify.invoked 必须为 false");
	assertEq(r.verify.required, "engineHealth", "健康判定必须交给 engineHealth");
	assertIncludes(r.message, "engineHealth", "说明里要点名 engineHealth");
	assertIncludes(r.message, "裸 TCP", "说明里要点名「裸 TCP 不算」");
	const envNote = r.notes.find((n) => n.port === 3090);
	assert(envNote.alsoFrom.some((s) => s.includes("观测")), "重复端口要合并来源（alsoFrom），不是重复出现");
	assertIncludes(r.notes.find((n) => n.port === 3999).source, ".open-boot.pid", "pid 端口来源说明");
	// 本仓库 .open-boot.pid 的 port 实际是启动器端口（实测 3081），来源说明必须写清角色，不能冒充引擎端口
	assertIncludes(r.notes.find((n) => n.port === 3999).source, "启动器端口", "pid 端口来源须标明是启动器端口");
	assertIncludes(r.notes.find((n) => n.port === 3080).source, "默认端口", "默认端口来源说明");

	const bad = resolvePortCandidates({ env: {}, observedPorts: ["abc", 70000] });
	assert(bad.warnings.some((w) => w.code === "observed-port-invalid"), "非法观测端口必须告警");
	assert(bad.warnings.some((w) => w.code === "port-env-absent"), "未设 DSH_ENGINE_PORT 时须说明（桌面版正常形态）");
	assert(bad.ports.includes(3080), "没有其它来源时仍给默认 3080");

	const { home: home2, profile: profile2 } = makeHome("ports-bom");
	writeFileSync(join(profile2, ".open-boot.pid"), "\uFEFF" + JSON.stringify({ app: "dsh-open-boot", port: 4100 }) + "\n", "utf8");
	const bomr = resolvePortCandidates({ env: {}, profileDir: profile2 });
	assert(bomr.ports.includes(4100), "BOM 的 .open-boot.pid 也要能解析出端口");
	assert(bomr.bomStrippedPaths.some((p) => p.endsWith(".open-boot.pid")), "BOM 必须上报路径");

	// 桌面版若在 pid 侧车写 enginePort，应优先采信它（在 port 之前进候选）
	const { home: home3, profile: profile3 } = makeHome("ports-engine");
	writeFileSync(join(profile3, ".open-boot.pid"), JSON.stringify({ app: "dsh-open-boot", port: 4310, enginePort: 4320 }) + "\n", "utf8");
	const engineR = resolvePortCandidates({ env: {}, profileDir: profile3 });
	assertDeepEq(engineR.ports, [4320, 4310, 3080], "enginePort 应排在 port 之前进候选（都只是候选，须 engineHealth 验证）");
});

// ---------------------------------------------------------------- 汇总

try {
	for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
} catch {
	/* 临时目录清理失败不影响结论 */
}

if (failed > 0) {
	console.error(`\nRESULT: FAIL — M1 能力门控 + 环境探测：${failed} 组失败 / ${passed + failed} 组`);
	process.exit(1);
}
console.log(`\nRESULT: PASS — M1 能力门控 + 环境探测（${passed} 组断言全部通过）`);
process.exit(0);
