#!/usr/bin/env node
/**
 * test-boot-diff.mjs — 启动配置快照与差异告警的契约测试（离线，零网络、零真实引擎）。
 *
 * 对齐 `docs/review/DESIGN_1.0.5_启动配置差异感知.md`。钉住的契约：
 *   ① 快照落盘：`<profile>/.plugin-manager/boot-snapshot.json`，**按 engine 端口分键**、原子写、坏数据自愈；
 *   ② 差异计算：新增 / 少了 / 版本变了 / patch 行数变了；没有变化必须 `empty:true`；
 *   ③ 定性：history 命中 → "上次管理台操作后未重启"；未命中 → "未经插件管理器的变更，请确认来源"；
 *   ④ 复现 wallpaper 实测案例：启用态快照 → 在 3081 禁用 → 下次启动应报"少了 wallpaper"且定性为用户操作；
 *   ⑤ 快照自身问题**永不拦启动**（读不到/写一半 → 当无快照，只写不比）。
 *
 * 用法：node test-boot-diff.mjs
 * 退出码：0 = 全绿；1 = 有 FAIL。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BOOT_SNAPSHOT_SCHEMA,
	bootSnapshotPath,
	captureEngineState,
	classifyDiff,
	diffEngineState,
	engineKeyOf,
	readBootSnapshot,
	updateEngineSnapshot,
	writeBootSnapshot
} from "./lib/boot-snapshot.mjs";

const results = [];
function check(name, fn) {
	let detail = "";
	let ok = false;
	try {
		detail = fn() ?? "";
		ok = true;
	} catch (error) {
		detail = error instanceof Error ? error.message : String(error);
	}
	results.push({ name, ok, detail });
}
const eq = (actual, expected, label) => {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${label}：期望 ${b}，实际 ${a}`);
};

const TMP = mkdtempSync(join(tmpdir(), "drydock-boot-diff-"));
process.on("exit", () => {
	try {
		rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* 清理失败不影响结论 */
	}
});
const PROFILE = join(TMP, "profiles", "web");
mkdirSync(PROFILE, { recursive: true });

const manifestOf = (deps, bundles) => ({ name: "web", dependencies: deps, dsh: { profile: { bundles } } });

// ── ① 落盘与自愈 ──────────────────────────────────────────
check("快照按 engine 分键落盘，另一引擎的键不被覆盖", () => {
	let snapshot = updateEngineSnapshot(null, { port: "3080", state: captureEngineState({ manifest: manifestOf({ "dsh-a": "1.0.0" }, ["dsh-a"]), port: "3080", patchRows: 1, now: () => 0 }) });
	snapshot = updateEngineSnapshot(snapshot, { port: "3081", state: captureEngineState({ manifest: manifestOf({ "dsh-a": "1.0.0" }, ["dsh-a"]), port: "3081", patchRows: 2, now: () => 0 }) });
	const w = writeBootSnapshot(snapshot, { profileDir: PROFILE });
	eq(w.ok, true, "write.ok");
	const back = readBootSnapshot({ profileDir: PROFILE });
	eq(Object.keys(back.engines).sort(), ["3080", "3081"], "两个键都在");
	eq(back.engines["3080"].patchRows, 1, "3080 的 patch 行数");
	eq(back.engines["3081"].patchRows, 2, "3081 的 patch 行数");
	if (!bootSnapshotPath(PROFILE).endsWith("boot-snapshot.json")) throw new Error("路径不对");
	return bootSnapshotPath(PROFILE);
});

check("坏快照 / schema 不符 → 当无快照（绝不拦启动）", () => {
	writeFileSync(bootSnapshotPath(PROFILE), "{ 半个 JSON");
	eq(readBootSnapshot({ profileDir: PROFILE }), null, "坏 JSON");
	writeFileSync(bootSnapshotPath(PROFILE), JSON.stringify({ schema: 999, engines: {} }));
	eq(readBootSnapshot({ profileDir: PROFILE }), null, "schema 不符");
	writeFileSync(bootSnapshotPath(PROFILE), JSON.stringify({ schema: BOOT_SNAPSHOT_SCHEMA, engines: "nope" }));
	eq(readBootSnapshot({ profileDir: PROFILE }), null, "engines 不是对象");
	const leftovers = [".tmp-1", ".tmp-999"].filter((suffix) => existsSync(`${bootSnapshotPath(PROFILE)}${suffix}`));
	eq(leftovers, [], "无 tmp 残留");
});

check("只写不比：无快照时 diffEngineState 返回 empty 且说明「只记录、不比对」", () => {
	const cur = captureEngineState({ manifest: manifestOf({ "dsh-a": "1.0.0" }, ["dsh-a"]), port: "3080" });
	const diff = diffEngineState(null, cur);
	eq(diff.empty, true, "empty");
	if (!/无上次启动快照/.test(diff.summary)) throw new Error(`文案不对：${diff.summary}`);
});

// ── ② 差异计算 ────────────────────────────────────────────
check("差异四类齐全：新增 / 少了 / 版本变了 / patch 行数变了", () => {
	const prev = captureEngineState({ manifest: manifestOf({ "dsh-a": "1.0.0", "dsh-b": "1.0.0" }, ["dsh-a", "dsh-b"]), port: "3080", patchRows: 1, now: () => 0 });
	const cur = captureEngineState({ manifest: manifestOf({ "dsh-a": "1.1.0", "dsh-c": "3.0.0" }, ["dsh-a", "dsh-c"]), port: "3080", patchRows: 3, now: () => 0 });
	const diff = diffEngineState(prev, cur);
	eq(diff.added, ["dsh-c"], "added");
	eq(diff.removed, ["dsh-b"], "removed");
	// 已在 added/removed 里报过的名字不再重复报"版本变化"（同一件事报两条是噪音）
	eq(diff.versionChanged.map((v) => v.name), ["dsh-a"], "versionChanged");
	eq(diff.versionChanged[0], { name: "dsh-a", from: "1.0.0", to: "1.1.0" }, "versionChanged 明细");
	eq(diff.patchChanged, { from: 1, to: 3 }, "patchChanged");
	eq(diff.empty, false, "非空");
	return diff.summary;
});

check("配置没变 → empty:true（不能天天报警）", () => {
	const m = manifestOf({ "dsh-a": "1.0.0" }, ["dsh-a"]);
	const prev = captureEngineState({ manifest: m, port: "3080", patchRows: 1, now: () => 0 });
	const cur = captureEngineState({ manifest: m, port: "3080", patchRows: 1, now: () => 0 });
	const diff = diffEngineState(prev, cur);
	eq(diff.empty, true, "empty");
	return diff.summary;
});

// ── ③ 定性（history 交叉核对） ────────────────────────────
check("history 命中 → 定性为「上次管理台操作后未重启」", () => {
	const prev = captureEngineState({ manifest: manifestOf({ "dsh-a": "1.0.0", "dsh-wallpaper": "1.0.0" }, ["dsh-a", "dsh-wallpaper"]), port: "3080", now: () => 0 });
	const cur = captureEngineState({ manifest: manifestOf({ "dsh-a": "1.0.0", "dsh-wallpaper": "1.0.0" }, ["dsh-a"]), port: "3080", now: () => 0 });
	const diff = diffEngineState(prev, cur);
	// 真实 sidecar 形状：没有 packageNames，包名在 label/detail/undo 文本里
	const verdict = classifyDiff(diff, [{ id: "1", at: "2026-11-27T07:00:00.000Z", action: "setEnabled", label: "禁用 dsh-wallpaper", detail: "dsh-wallpaper 1.0.0", undo: { packageNames: ["dsh-wallpaper"] } }]);
	eq(verdict.tone, "user-action", "tone");
	if (!/未重启|本次启动已按当前状态加载/.test(verdict.text)) throw new Error(`文案不对：${verdict.text}`);
	return verdict.text;
});

check("history 未命中 → 定性为「未经插件管理器的变更，请确认来源」", () => {
	const prev = captureEngineState({ manifest: manifestOf({ "dsh-a": "1.0.0", "dsh-new": "9.9.9" }, ["dsh-a", "dsh-new"]), port: "3080", now: () => 0 });
	const cur = captureEngineState({ manifest: manifestOf({ "dsh-a": "1.0.0", "dsh-new": "9.9.9" }, ["dsh-a"]), port: "3080", now: () => 0 });
	const verdict = classifyDiff(diffEngineState(prev, cur), []);
	eq(verdict.tone, "unmanaged", "tone");
	if (!/请确认来源/.test(verdict.text)) throw new Error(`文案不对：${verdict.text}`);
	return verdict.text;
});

check("没有差异 → tone=clean，不产生噪音告警", () => {
	const verdict = classifyDiff({ empty: true, added: [], removed: [], versionChanged: [], summary: "与上次成功启动相比，配置没有变化" }, []);
	eq(verdict.tone, "clean", "tone");
	eq(verdict.text, "与上次成功启动相比，配置没有变化", "文案");
});

// ── ④ 复现 wallpaper 实测案例 ─────────────────────────────
check("复现 wallpaper 案例：启用态快照 → 3081 禁用 → 下次启动报「少了 wallpaper」且定性为用户操作", () => {
	const enabledManifest = manifestOf({ "dsh-a": "1.0.0", "dsh-plugin-wallpaper-engine": "1.4.3" }, ["dsh-a", "dsh-plugin-wallpaper-engine"]);
	const disabledManifest = manifestOf({ "dsh-a": "1.0.0", "dsh-plugin-wallpaper-engine": "1.4.3" }, ["dsh-a"]);
	let snapshot = updateEngineSnapshot(null, { port: "3080", state: captureEngineState({ manifest: enabledManifest, port: "3080", patchRows: 1, now: () => 0 }) });
	const prev = snapshot.engines["3080"];
	const cur = captureEngineState({ manifest: disabledManifest, port: "3080", patchRows: 1, now: () => 1000 });
	const diff = diffEngineState(prev, cur);
	eq(diff.removed, ["dsh-plugin-wallpaper-engine"], "少了 wallpaper");
	const verdict = classifyDiff(diff, [{ id: "1", at: "2026-11-27T07:00:00.000Z", action: "setEnabled", label: "禁用 dsh-plugin-wallpaper-engine", detail: null, undo: null }]);
	eq(verdict.tone, "user-action", "tone");
	// 304 引擎的键不受 3081 写入影响
	snapshot = updateEngineSnapshot(snapshot, { port: "3081", state: captureEngineState({ manifest: enabledManifest, port: "3081", patchRows: 1, now: () => 1000 }), diff });
	eq(snapshot.engines["3080"].bundles.includes("dsh-plugin-wallpaper-engine"), true, "3080 的历史快照仍是启用态（用于下次 diff）");
	eq(snapshot.lastDiff.removed, ["dsh-plugin-wallpaper-engine"], "lastDiff 记下来给页面看");
	return verdict.text;
});

check("engineKeyOf：端口是唯一键（空值不产生键，避免覆盖）", () => {
	eq([engineKeyOf(3080), engineKeyOf("3081"), engineKeyOf(null), engineKeyOf("")], ["3080", "3081", "", ""], "映射");
	const snapshot = updateEngineSnapshot(null, { port: "", state: captureEngineState({ manifest: manifestOf({}, []) }) });
	eq(Object.keys(snapshot.engines), [], "空键不写入");
});

// ── 汇总 ──────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`[${r.ok ? "OK  " : "FAIL"}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
if (failed.length > 0) {
	console.error(`\n${failed.length} 项失败`);
	process.exit(1);
}
console.log(`\nALL BOOT-DIFF TESTS PASSED (${results.length} checks)`);
