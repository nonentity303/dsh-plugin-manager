// verify-v08.mjs — v0.8 E2E（独立端口 3082 + 独立 profile web-v08，不影响 3080 主实例）。
// 覆盖：list / 卸载预览 / 场景方案（预览+应用+撤销）/ 来源覆盖 / 事务化卸载 / 撤销卸载 / 救援页 / 自检。
// Pure ASCII. Usage: VERIFY_PORT=3082 node verify-v08.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.VERIFY_PORT || "3082";
const PROFILE_DIR = process.env.VERIFY_PROFILE_DIR || "C:\\Users\\nonen\\.dsh\\profiles\\web-v08";

const post = async (method, args) => {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "client-request", rpcId: "v08-" + Date.now(), method, payload: { args } })
	});
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { return { http: res.status, raw: text.slice(0, 200) }; }
	return json;
};

const failures = [];
const ok = (cond, label) => { if (cond) console.log("OK:", label); else { failures.push(label); console.error("FAIL:", label); } };

// ---- 1. 快照基础 ----
const list = await post("pluginManagerPro/list", {});
ok(list.result?.ok === true, "list ok");
const entries = list.result?.value?.entries ?? [];
const pm = entries.find((e) => e.configId === "plugin-manager-pro");
ok(pm !== undefined && pm.phase === "active" && pm.origin === "user", "plugin-manager-pro active origin=user");
ok(entries.every((e) => ["builtin", "local", "github", "npm"].includes(e.source)), "all entries carry source");
// demo 为 package-only fixture：无 loader 条目（条目级断言由进程内集成测试覆盖）
ok(entries.every((e) => e.packageName !== "dsh-v08-demo"), "demo pkg has no loader entries (package-only fixture)");

// ---- 2. 卸载影响预览 ----
const preview = await post("pluginManagerPro/uninstallPreview", { packageNames: ["dsh-v08-demo"] });
const pkg = preview.result?.value?.packages?.[0];
ok(preview.result?.ok === true && pkg?.canUninstall === true, "uninstallPreview ok + canUninstall");
ok(typeof pkg?.spec === "string" && pkg.spec.startsWith("file:"), "preview spec is file: (" + (pkg?.spec ?? "?") + ")");
ok(pkg.inBundles === true, "preview inBundles");

// ---- 3. 场景方案：保存当前状态 -> dryRun 预览 -> 应用 -> 撤销 ----
const scen = await post("pluginManagerPro/scenarioSave", { name: "v08-e2e" });
const sid = scen.result?.value?.scenarios?.[0]?.id;
ok(scen.result?.ok === true && sid !== undefined, "scenarioSave ok");
// 找一个非保护非架构条目制造差异
const target = entries.find((e) => !e.protected && !e.archived);
ok(target !== undefined, "found toggle target " + (target ? target.configId : "?"));
if (target) {
	const flip = await post("pluginManagerPro/setEnabled", { entryId: target.entryId, enabled: !target.enabled });
	ok(flip.result?.ok === true, `flip ${target.configId} -> ${flip.result?.value?.items?.[0]?.status}`);
}
const dry = await post("pluginManagerPro/scenarioApply", { id: sid, dryRun: true });
ok(dry.result?.ok === true, "scenarioApply dryRun ok");
const changedDry = (dry.result?.value?.items ?? []).filter((i) => i.changed);
ok(changedDry.length >= (target ? 1 : 0), `dryRun shows ${changedDry.length} changes`);
const apply = await post("pluginManagerPro/scenarioApply", { id: sid, dryRun: false });
ok(apply.result?.ok === true, "scenarioApply ok");
const changedReal = (apply.result?.value?.items ?? []).filter((i) => i.status === "changed");
ok(changedReal.length === (target ? 1 : 0), `apply changed ${changedReal.length} of ${target ? 1 : 0}`);

// ---- 4. 来源人工修正（包级：读侧车确认持久化）----
const src1 = await post("pluginManagerPro/setSourceOverride", { packageName: "dsh-v08-demo", source: "github" });
const sidecar1 = JSON.parse(readFileSync(join(PROFILE_DIR, "plugin-manager.json"), "utf8"));
ok(src1.result?.ok === true && sidecar1.overrides?.source?.["dsh-v08-demo"] === "github", "source override github persisted to sidecar");
const src2 = await post("pluginManagerPro/setSourceOverride", { packageName: "dsh-v08-demo", source: null });
const sidecar2 = JSON.parse(readFileSync(join(PROFILE_DIR, "plugin-manager.json"), "utf8"));
ok(src2.result?.ok === true && sidecar2.overrides?.source?.["dsh-v08-demo"] === undefined, "source override reset persisted");

// ---- 5. 操作历史 + 撤销场景应用 ----
const hist = await post("pluginManagerPro/operationHistory", {});
const ops = hist.result?.value?.operations ?? [];
ok(hist.result?.ok === true && ops.length >= 2, `history has ${ops.length} ops`);
const scenOp = ops.find((o) => o.action === "scenario-apply");
ok(scenOp !== undefined && scenOp.undo?.type === "patch-state", "scenario-apply history undo payload");
if (scenOp) {
	const undo = await post("pluginManagerPro/undoOperation", { id: scenOp.id });
	ok(undo.result?.ok === true, "undo scenario-apply ok, message=" + (undo.result?.value?.message ?? "?")?.slice(0, 40));
}

// ---- 6. 事务化卸载 demo（此时 demo 无依赖者）----
const un = await post("pluginManagerPro/uninstallPackages", { packageNames: ["dsh-v08-demo"], options: { cascade: true } });
const unItem = un.result?.value?.items?.[0];
ok(un.result?.ok === true && unItem?.status === "removed" && unItem?.verifyOk === true, "transactional uninstall removed + verifyOk" + (unItem ? ` [${unItem.status}${unItem.verifyOk ? "" : " verify=false"}]` : ""));
const manifestAfter = JSON.parse(readFileSync(join(PROFILE_DIR, "package.json"), "utf8"));
ok(manifestAfter.dependencies?.["dsh-v08-demo"] === void 0, "demo removed from manifest");
ok(!(manifestAfter.dsh?.profile?.bundles ?? []).includes("dsh-v08-demo"), "demo removed from bundles");
ok(existsSync(unItem?.backupPath ?? "\\0"), "backup file exists");
const vp1 = await post("pluginManagerPro/verifyProfile", {});
ok(vp1.result?.ok === true && vp1.result?.value?.ok === true, "verifyProfile ok after uninstall");

// ---- 7. 撤销卸载（restore-files + pnpm reinstall）----
const hist2 = await post("pluginManagerPro/operationHistory", {});
const unOp = (hist2.result?.value?.operations ?? []).find((o) => o.action === "uninstall");
ok(unOp !== undefined && unOp.undo?.type === "restore-files", "uninstall history restore-files");
if (unOp) {
	const undo2 = await post("pluginManagerPro/undoOperation", { id: unOp.id });
	ok(undo2.result?.ok === true, "undo uninstall ok, message=" + (undo2.result?.value?.message ?? "?")?.slice(0, 50));
}
const manifestRestored = JSON.parse(readFileSync(join(PROFILE_DIR, "package.json"), "utf8"));
ok(manifestRestored.dependencies?.["dsh-v08-demo"] !== void 0, "demo restored to manifest");
ok(manifestRestored.dsh?.profile?.bundles?.includes("dsh-v08-demo") === true, "demo restored to bundles");
const vp2 = await post("pluginManagerPro/verifyProfile", {});
ok(vp2.result?.ok === true && vp2.result?.value?.ok === true, "verifyProfile ok after undo");

// ---- 8. 救援页 / 自检（基线）----
const rescuePage = await fetch(`http://127.0.0.1:${PORT}/rescue`);
ok(rescuePage.status === 200 && (await rescuePage.text()).includes("rescue"), "GET /rescue 200");

// ---- 9. 场景删除（清理）----
const del = await post("pluginManagerPro/scenarioDelete", { id: sid });
ok(del.result?.ok === true && (del.result?.value?.scenarios ?? []).length === 0, "scenarioDelete cleanup");

writeFileSync(join(process.env.WORKSPACE_DIR ?? "C:\\Users\\nonen\\Documents\\harness\\plugin-manager", ".v08-e2e.json"), JSON.stringify({
	port: PORT, profile: "web-v08",
	entries: entries.length,
	uninstall: unItem ? { status: unItem.status, verifyOk: unItem.verifyOk } : null,
	failures
}, null, 2), "utf8");

if (failures.length > 0) { console.error("E2E FAILED (" + failures.length + "):\n - " + failures.join("\n - ")); process.exit(1); }
console.log("V0.8 E2E OK (port " + PORT + ")");
