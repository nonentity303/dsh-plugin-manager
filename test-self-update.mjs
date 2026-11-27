#!/usr/bin/env node
/**
 * test-self-update.mjs — 自更新流程的契约测试（离线：无网络、无 pnpm、无真实进程）。
 *
 * 覆盖的"红线"（每条都对应一个真实事故可能性）：
 *   ① 只认 https + SRI 摘要；名字不符 / 无摘要 / http 一律拒（CWE-494 同族）
 *   ② 不做降级（除显式 allowDowngrade）；同版本判 up-to-date，不重复下载
 *   ③ 通道靠 dist-tag 选：web→latest、desktop→desktop（形态未知按 web，宁可不更新）
 *   ④ 本地 tgz 必须显式确认；确认后状态标 source=local-file（明写"未经权威源比对"）
 *   ⑤ 桌面形态**不自己装**（profile 由 Electron 独占）→ 只提示，不给 --now
 *   ⑥ worker 顺序固定：停引擎 → 装 → 健康检查 → 重启；任一步失败必须回滚并落 failed
 *   ⑦ 状态文件原子写 + 坏数据自愈（不沿用半截状态）
 *
 * 用法：node test-self-update.mjs
 * 退出码：0 = 全绿；1 = 有 FAIL。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NPM_REGISTRY,
	SELF_UPDATE_SCHEMA,
	canSelfApply,
	checkForUpdate,
	decide,
	distTagForForm,
	evaluateCandidate,
	localCandidate,
	promptText,
	readState,
	runWorker,
	statePath,
	statusText,
	writeState
} from "./lib/self-update.mjs";

const results = [];
async function verify(name, fn) {
	let detail = "";
	let ok = false;
	try {
		detail = (await fn()) ?? "";
		ok = true;
	} catch (error) {
		detail = error instanceof Error ? error.message : String(error);
	}
	results.push({ name, ok, detail });
}
function eq(actual, expected, label) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const TMP = mkdtempSync(join(tmpdir(), "drydock-self-update-"));
const DSH_HOME = join(TMP, ".dsh");
mkdirSync(DSH_HOME, { recursive: true });
process.on("exit", () => {
	try {
		rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* 清理失败不影响结论 */
	}
});

const NAME = "dsh-drydock";
const INTEGRITY = "sha512-abc123";
const packument = (versions, tags) => ({
	name: NAME,
	"dist-tags": tags,
	versions: Object.fromEntries(
		Object.entries(versions).map(([v, tarball]) => [v, { dist: { tarball, integrity: INTEGRITY, shasum: "a".repeat(40) } }])
	)
});
const goodPackument = packument(
	{ "1.2.0": `https://registry.npmjs.org/${NAME}/-/${NAME}-1.2.0.tgz`, "1.1.0-desktop.3": `https://registry.npmjs.org/${NAME}/-/${NAME}-1.1.0-desktop.3.tgz` },
	{ latest: "1.2.0", next: "1.2.1-rc.1", desktop: "1.1.0-desktop.3" }
);

// ── ① 通道与能力 ──────────────────────────────────────────
await verify("通道 → dist-tag：web=latest / desktop=desktop / unknown=latest", () => {
	eq([distTagForForm("web"), distTagForForm("desktop"), distTagForForm("unknown"), distTagForForm("x")], ["latest", "desktop", "latest", "latest"], "映射");
});

await verify("只有 web 形态允许自己装（桌面 profile 由 Electron 独占）", () => {
	eq([canSelfApply("web"), canSelfApply("desktop"), canSelfApply("unknown")], [true, false, false], "canSelfApply");
});

// ── ② 候选门禁 ────────────────────────────────────────────
await verify("名字不符 → name-mismatch（防同名镜像/拼写劫持）", () => {
	const r = evaluateCandidate({ name: "drx", currentVersion: "1.0.0", form: "web", packument: goodPackument });
	eq(r.code, "name-mismatch", "code");
});

await verify("通道没有对应 dist-tag → no-channel-version（不猜版本）", () => {
	const p = packument({ "1.2.0": "https://x/y.tgz" }, { latest: "1.2.0" });
	const r = evaluateCandidate({ name: NAME, currentVersion: "1.0.0", form: "desktop", packument: p });
	eq(r.code, "no-channel-version", "code");
});

await verify("tarball 是 http → tarball-not-https", () => {
	const p = packument({ "1.2.0": `http://registry.npmjs.org/${NAME}/-/${NAME}-1.2.0.tgz` }, { latest: "1.2.0" });
	eq(evaluateCandidate({ name: NAME, currentVersion: "1.0.0", form: "web", packument: p }).code, "tarball-not-https", "code");
});

await verify("缺 dist.integrity → no-integrity（没有摘要就无法发现替换）", () => {
	const p = { name: NAME, "dist-tags": { latest: "1.2.0" }, versions: { "1.2.0": { dist: { tarball: `https://r/${NAME}-1.2.0.tgz` } } } };
	eq(evaluateCandidate({ name: NAME, currentVersion: "1.0.0", form: "web", packument: p }).code, "no-integrity", "code");
});

await verify("同版本 → up-to-date（不重复下载）", () => {
	const r = evaluateCandidate({ name: NAME, currentVersion: "1.2.0", form: "web", packument: goodPackument });
	eq(r.code, "up-to-date", "code");
});

await verify("降级默认拒绝；allowDowngrade 才放行", () => {
	const refused = evaluateCandidate({ name: NAME, currentVersion: "1.2.0", form: "desktop", packument: goodPackument });
	eq(refused.code, "downgrade-refused", "code");
	const allowed = evaluateCandidate({ name: NAME, currentVersion: "1.2.0", form: "desktop", packument: goodPackument, allowDowngrade: true });
	eq(allowed.ok, true, "ok");
	eq(allowed.target.version, "1.1.0-desktop.3", "target");
});

await verify("正常更新：web 通道取 latest，desktop 通道取 desktop", () => {
	const web = evaluateCandidate({ name: NAME, currentVersion: "1.1.0-desktop.1", form: "web", packument: goodPackument });
	eq([web.ok, web.target.version, web.channel], [true, "1.2.0", "latest"], "web");
	const desk = evaluateCandidate({ name: NAME, currentVersion: "1.1.0-desktop.1", form: "desktop", packument: goodPackument });
	eq([desk.ok, desk.target.version, desk.channel], [true, "1.1.0-desktop.3", "desktop"], "desktop");
});

// ── ③ 查源（注入 getJson，断言只走 https + 名字编码）─────
await verify("checkForUpdate 只请求 https 权威源且对包名编码", async () => {
	const seen = [];
	const r = await checkForUpdate({
		name: NAME,
		currentVersion: "1.0.0",
		form: "web",
		getJson: async (url) => {
			seen.push(url);
			return goodPackument;
		}
	});
	eq(seen.length, 1, "请求次数");
	if (!seen[0].startsWith(`${NPM_REGISTRY}/${NAME}`)) throw new Error(`URL 不对：${seen[0]}`);
	eq(r.target.version, "1.2.0", "target");
});

// ── ④ 状态文件 ────────────────────────────────────────────
await verify("状态原子写 + 读回一致（不留 .tmp）", () => {
	const state = { phase: "pending", targetVersion: "1.2.0", currentVersion: "1.0.0" };
	const w = writeState(state, { dshHome: DSH_HOME });
	eq(w.ok, true, "write.ok");
	const back = readState({ dshHome: DSH_HOME });
	eq([back.schema, back.phase, back.targetVersion], [SELF_UPDATE_SCHEMA, "pending", "1.2.0"], "读回");
	const leftovers = ["self-update.json.tmp-1"].filter((f) => existsSync(join(DSH_HOME, ".drydock", f)));
	eq(leftovers, [], "无 tmp 残留");
});

await verify("坏 JSON / schema 不符 → 自愈为 null（不沿用半截状态）", () => {
	writeFileSync(statePath(DSH_HOME), "{ 坏掉");
	eq(readState({ dshHome: DSH_HOME }), null, "坏 JSON");
	writeFileSync(statePath(DSH_HOME), JSON.stringify({ schema: 999, phase: "pending", targetVersion: "9.9.9" }));
	eq(readState({ dshHome: DSH_HOME }), null, "schema 不符");
	writeFileSync(statePath(DSH_HOME), JSON.stringify({ schema: SELF_UPDATE_SCHEMA, phase: "nonsense", targetVersion: "9.9.9" }));
	eq(readState({ dshHome: DSH_HOME }), null, "阶段非法");
});

// ── ⑤ 决策与提示文案 ──────────────────────────────────────
await verify("决策：later 放行；web 上 now 放行；桌面 now 拒绝", () => {
	const web = { form: "web", targetVersion: "1.2.0", currentVersion: "1.0.0" };
	eq(decide(web, "later").ok, true, "later");
	eq(decide(web, "now").state.decision, "now", "now");
	const desk = { form: "desktop", targetVersion: "1.2.0", currentVersion: "1.0.0" };
	const d = decide(desk, "now");
	eq([d.ok, d.code], [false, "desktop-delegated"], "桌面拒绝");
	eq(decide(web, "tomorrow").code, "bad-decision", "非法决策");
});

await verify("提示文案：web 给「现在/稍后」+ 重启影响；桌面明说不自动装", () => {
	const web = promptText({ form: "web", targetVersion: "1.2.0", currentVersion: "1.0.0", channel: "latest", registry: NPM_REGISTRY, integrity: INTEGRITY });
	if (!/\[现在\].*--now/.test(web) || !/\[稍后\].*--later/.test(web)) throw new Error(`web 文案缺现在/稍后：${web}`);
	if (!/3080/.test(web)) throw new Error("web 文案没写重启影响");
	const desk = promptText({ form: "desktop", targetVersion: "1.1.0-desktop.3", currentVersion: "1.1.0-desktop.1", channel: "desktop", registry: NPM_REGISTRY, integrity: INTEGRITY });
	if (!/桌面形态/.test(desk) || !/不会自己装|不会自己/.test(desk)) throw new Error(`桌面文案不对：${desk}`);
	if (/\[现在\]/.test(desk)) throw new Error("桌面文案不该出现「现在」按钮");
	return "两套文案正确";
});

await verify("本地 tgz：不给 --accept-local 就拒；给了标 source=local-file", async () => {
	const file = join(TMP, "dsh-drydock-1.2.0.tgz");
	writeFileSync(file, "not-a-real-tgz");
	const no = await localCandidate({ file, name: NAME, currentVersion: "1.0.0", form: "web", dshHome: DSH_HOME });
	eq([no.ok, no.code], [false, "local-needs-ack"], "未确认");
	const yes = await localCandidate({ file, name: NAME, currentVersion: "1.0.0", form: "web", acceptLocal: true, dshHome: DSH_HOME });
	eq([yes.ok, yes.target.local], [true, true], "已确认");
	// 版本号从文件名解析（否则 UI 会显示 "1.2.0 → local:C:\..." 这种没法看的东西）
	eq([yes.target.version, yes.target.versionFromFilename], ["1.2.0", true], "文件名解析版本");
	const missing = await localCandidate({ file: join(TMP, "nope.tgz"), name: NAME, currentVersion: "1.0.0", form: "web", acceptLocal: true, dshHome: DSH_HOME });
	eq(missing.code, "local-missing", "文件不存在");
});

await verify("本地 tgz 文件名带通道后缀也能解出完整版本；解析不出就退回 local:<文件名>（不假装知道）", async () => {
	const desk = join(TMP, "dsh-drydock-1.1.0-desktop.2.tgz");
	writeFileSync(desk, "x");
	const a = await localCandidate({ file: desk, name: NAME, currentVersion: "1.1.0-desktop.1", form: "desktop", acceptLocal: true, dshHome: DSH_HOME });
	eq([a.target.version, a.target.versionFromFilename], ["1.1.0-desktop.2", true], "通道后缀");
	const weird = join(TMP, "some-build.tgz");
	writeFileSync(weird, "x");
	const b = await localCandidate({ file: weird, name: NAME, currentVersion: "1.0.0", form: "web", acceptLocal: true, dshHome: DSH_HOME });
	eq([b.target.version, b.target.versionFromFilename], ["local:some-build.tgz", false], "退回文件名");
});

// ── ⑥ worker 状态机 ───────────────────────────────────────
function makeRecorder({ failInstall = false, unhealthy = false } = {}) {
	const calls = [];
	const run = async (cmd, args) => {
		calls.push({ kind: "run", cmd, args: [...args] });
		// failInstall：**只让第一次安装失败**，之后的回滚照常成功 —— 这是现实里最常见的形态
		// （新版本装不上，旧版本还能装回去）。全失败的极端情况由下一条断言覆盖。
		if (failInstall && calls.filter((c) => c.kind === "run").length === 1) return { ok: false, code: 1 };
		return { ok: true, code: 0 };
	};
	const deps = {
		run,
		stopEngine: async () => {
			calls.push({ kind: "stop" });
			return { ok: true, message: "已停" };
		},
		startEngine: async () => {
			calls.push({ kind: "start" });
			return { ok: true, message: "已起" };
		},
		waitForEngine: async () => {
			calls.push({ kind: "wait" });
			return unhealthy ? false : true;
		},
		health: async () => {
			calls.push({ kind: "health" });
			return { ok: true };
		}
	};
	return { calls, deps };
}

const baseState = (over = {}) => ({
	phase: "pending",
	form: "web",
	currentVersion: "1.1.0-desktop.1",
	targetVersion: "1.2.0",
	stagedFile: join(TMP, "dsh-drydock-1.2.0.tgz"),
	...over
});

await verify("worker 顺序：停引擎 → 装新包 → 重启 → 等健康；安装参数含暂存 tgz 与最小发布年龄豁免", async () => {
	writeState(baseState(), { dshHome: DSH_HOME });
	const { calls, deps } = makeRecorder();
	const r = await runWorker({ state: readState({ dshHome: DSH_HOME }), dshHome: DSH_HOME, profileDir: join(DSH_HOME, "profiles", "web"), deps });
	eq(r.ok, true, "ok");
	const order = calls.map((c) => c.kind);
	const iStop = order.indexOf("stop");
	const iRun = order.indexOf("run");
	const iStart = order.indexOf("start");
	if (!(iStop >= 0 && iRun > iStop && iStart > iRun)) throw new Error(`顺序不对：${order.join(" → ")}`);
	const install = calls.find((c) => c.kind === "run");
	if (!install.args.includes("--config.minimumReleaseAge=0")) throw new Error(`安装参数缺最小发布年龄豁免：${install.args.join(" ")}`);
	if (!install.args.includes(baseState().stagedFile)) throw new Error("安装参数里没有暂存 tgz");
	eq(readState({ dshHome: DSH_HOME }).phase, "applied", "落 applied");
	return order.join(" → ");
});

await verify("安装失败 → 自动回滚到 currentVersion，落 failed", async () => {
	writeState(baseState(), { dshHome: DSH_HOME });
	const { calls, deps } = makeRecorder({ failInstall: true });
	const r = await runWorker({ state: readState({ dshHome: DSH_HOME }), dshHome: DSH_HOME, profileDir: join(DSH_HOME, "profiles", "web"), deps });
	eq(r.ok, false, "ok=false");
	const rollbackCall = calls.filter((c) => c.kind === "run").at(-1);
	if (!rollbackCall.args.join(" ").includes("dsh-drydock@1.1.0-desktop.1")) throw new Error(`回滚命令不对：${rollbackCall.args.join(" ")}`);
	const state = readState({ dshHome: DSH_HOME });
	eq([state.phase, state.rollback?.ok], ["failed", true], "落 failed + 回滚成功");
});

await verify("回滚本身也失败 → 如实落 failed（不谎报已回滚），并写明错误", async () => {
	writeState(baseState(), { dshHome: DSH_HOME });
	const calls = [];
	const deps = {
		run: async (cmd, args) => {
			calls.push(args.join(" "));
			return { ok: false, code: 1 };
		},
		health: async () => ({ ok: true }),
		stopEngine: async () => ({ ok: true })
	};
	const r = await runWorker({ state: readState({ dshHome: DSH_HOME }), dshHome: DSH_HOME, profileDir: join(DSH_HOME, "profiles", "web"), deps });
	eq([r.ok, r.code], [false, "install-failed"], "结论");
	const state = readState({ dshHome: DSH_HOME });
	eq([state.phase, state.rollback?.ok], ["failed", false], "回滚失败如实记录");
	if (!String(state.lastError ?? "").includes("安装失败")) throw new Error(`lastError 没写清：${state.lastError}`);
	return `${calls.length} 次子进程尝试均失败，状态如实`;
});

await verify("新版本重启后不健康 → 回滚并落 failed（不让用户卡在坏版本上）", async () => {
	writeState(baseState(), { dshHome: DSH_HOME });
	const { calls, deps } = makeRecorder({ unhealthy: true });
	const r = await runWorker({ state: readState({ dshHome: DSH_HOME }), dshHome: DSH_HOME, profileDir: join(DSH_HOME, "profiles", "web"), deps });
	eq([r.ok, r.code], [false, "unhealthy"], "结论");
	const rollbacks = calls.filter((c) => c.kind === "run").filter((c) => c.args.join(" ").includes("@1.1.0-desktop.1"));
	eq(rollbacks.length, 1, "回滚一次");
	eq(readState({ dshHome: DSH_HOME }).phase, "failed", "落 failed");
});

await verify("桌面形态 worker 直接拒绝（不碰引擎、不装东西）", async () => {
	const { calls, deps } = makeRecorder();
	const r = await runWorker({ state: baseState({ form: "desktop" }), dshHome: DSH_HOME, profileDir: join(DSH_HOME, "profiles", "desktop"), deps });
	eq([r.ok, r.code], [false, "desktop-delegated"], "结论");
	eq(calls.length, 0, "零外部动作");
});

await verify("没有暂存包 → 直接 failed，不执行任何引擎操作", async () => {
	writeState(baseState({ stagedFile: null }), { dshHome: DSH_HOME });
	const { calls, deps } = makeRecorder();
	const r = await runWorker({ state: readState({ dshHome: DSH_HOME }), dshHome: DSH_HOME, profileDir: join(DSH_HOME, "profiles", "web"), deps });
	eq([r.ok, r.code], [false, "no-staged-file"], "结论");
	eq(calls.length, 0, "零外部动作");
});

// ── ⑦ status 文案 ─────────────────────────────────────────
await verify("statusText：无状态 / pending / running 三种形态可读", () => {
	eq(statusText(null), "没有待处理的自更新（self-update.json 不存在或已失效）", "无状态");
	const pending = statusText({ phase: "pending", currentVersion: "1.0.0", targetVersion: "1.2.0", channel: "latest", form: "web", fetchedAt: new Date().toISOString(), stagedFile: "/x/y.tgz" });
	if (!pending.includes("1.0.0 → 1.2.0") || !pending.includes("未决定")) throw new Error(`pending 文案不对：${pending}`);
	const running = statusText({ phase: "running", currentVersion: "1.0.0", targetVersion: "1.2.0", channel: "latest", form: "web", fetchedAt: new Date().toISOString() });
	if (!running.includes("手动回滚")) throw new Error(`running 文案缺回滚提示：${running}`);
});

// ── 汇总 ──────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`[${r.ok ? "OK  " : "FAIL"}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
if (failed.length > 0) {
	console.error(`\n${failed.length} 项失败`);
	process.exit(1);
}
console.log(`\nALL SELF-UPDATE TESTS PASSED (${results.length} checks)`);
