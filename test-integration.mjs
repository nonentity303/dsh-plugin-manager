// test-integration.mjs — v0.8 host 逻辑进程内集成测试（不启动引擎、不占 3080）。
// 覆盖：事务化卸载/回滚/撤销、卸载影响预览、操作历史、来源人工修正、场景方案（预览+应用）、侧车 v2 兼容。
// 用法: node test-integration.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginManagerPro } from "./lib/index.js";

const failures = [];
const ok = (cond, label) => { if (cond) console.log("OK:", label); else { failures.push(label); console.error("FAIL:", label); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profileDir = mkdtempSync(join(tmpdir(), "pm-v08-int-"));
const vendorDir = join(profileDir, "vendor");
mkdirSync(vendorDir);
mkdirSync(join(vendorDir, "dsh-v08-dep"));
mkdirSync(join(vendorDir, "dsh-v08-demo"));

const writePkg = (dir, obj) => writeFileSync(join(dir, "package.json"), JSON.stringify(obj, null, 2), "utf8");
// dep 依赖 demo（反向依赖图：demo ← dep）；用相对 file: 引用避免 registry 解析
writePkg(join(vendorDir, "dsh-v08-dep"), { name: "dsh-v08-dep", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } }, dependencies: { "dsh-v08-demo": "file:../dsh-v08-demo" } });
writeFileSync(join(vendorDir, "dsh-v08-dep", "cordis.patch.yml"), "[]\n", "utf8");
writePkg(join(vendorDir, "dsh-v08-demo"), { name: "dsh-v08-demo", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } });
writeFileSync(join(vendorDir, "dsh-v08-demo", "cordis.patch.yml"), "[]\n", "utf8");

const patchHeader = "# test patch\n";
writeFileSync(join(profileDir, "cordis.patch.yml"), patchHeader + "[]\n", "utf8");
writeFileSync(join(profileDir, "package.json"), JSON.stringify({
	name: "dsh-profile-web-v08",
	private: true,
	dsh: { profile: { bundles: ["dsh-v08-demo", "dsh-v08-dep"] } },
	dependencies: {
		"dsh-v08-demo": `file:${vendorDir.replace(/\\/g, "/")}/dsh-v08-demo`,
		"dsh-v08-dep": `file:${vendorDir.replace(/\\/g, "/")}/dsh-v08-dep`
	}
}, null, 2) + "\n", "utf8");

// 真实 pnpm install：让 pnpm 拥有 node_modules（否则 pnpm remove 会把手工目录当外部包拒绝）
import { execFileSync } from "node:child_process";
const pnpmCmd = process.platform === "win32" ? ["cmd", "/c", "pnpm"] : ["pnpm"];
execFileSync(pnpmCmd[0], [...pnpmCmd.slice(1), "install"], { cwd: profileDir, stdio: "pipe", env: { ...process.env, NO_COLOR: "1" } });

// 动态加载器：entry.disabled 实时读 patch 文件（模拟热重载收敛）
import { parse as parseYaml } from "yaml";
const patchPath = join(profileDir, "cordis.patch.yml");
function disabledOf(configId, moduleName) {
	try {
		const seq = parseYaml(readFileSync(patchPath, "utf8"));
		if (!Array.isArray(seq)) return false;
		const row = seq.find((r) => r && r.id === configId && r.name === moduleName);
		return row?.disabled === true;
	} catch {
		return false;
	}
}

const entryDefs = [
	{ id: "e1", options: { id: "demo-plugin", name: "dsh-v08-demo" } },
	{ id: "e2", options: { id: "dep-plugin", name: "dsh-v08-dep" } },
	{ id: "e3", options: { id: "core-thing", name: "@deepseek-ai/dsh-base" } },
	{ id: "g1", options: { id: "group", group: true, name: "@deepseek-ai/dsh-base" } }
];
const entries = entryDefs.map((def) => {
	// 注意：这里只保留引擎 Entry 真实存在的字段（cordis-plugin-loader 1.0.5 的 Entry =
	// loader,ctx,fiber,parent,options,subgroup,subtree,_initTask）。历史上这里带了 `_disposing: 0`，
	// 而引擎根本没有该字段 —— 它把修复前的 waitFor 误判「喂饱」，导致 H1 在测试里永远测不出来（H11）。
	// 真契约见 tools/test-host-fixes.mjs 段 C（真 loader 上的字段实测）。
	const entry = {
		id: def.id,
		options: def.options,
		fiber: undefined,
		_initTask: undefined
	};
	Object.defineProperty(entry, "disabled", {
		get() { return def.options.group ? false : disabledOf(def.options.id, def.options.name); },
		configurable: true
	});
	return entry;
});

const ctx = {
	loader: {
		ctx: { baseUrl: pathToFileURL(profileDir + "/").href },
		entries: () => entries,
		resolve: (id) => entries.find((e) => e.id === id)
	},
	on: () => {},
	inject: (servs, okCb, failCb) => { if (typeof failCb === "function") failCb(); },
	logger: { info: () => {} },
	// Service/cordis 注册所需的最小面
	reflect: { provide: () => {} }
};

const svc = new PluginManagerPro(ctx, { protectedEntries: ["core-thing"], settleTimeoutMs: 2000 });

// ---- 1. 启动前自检 & 快照基础 ----
const verify0 = svc.verifyProfile();
ok(verify0.ok === true, "verifyProfile ok on fresh profile");
const snap0 = svc.snapshot();
ok(snap0.entries.filter((e) => !e.archived && !e.protected).length >= 2, "snapshot has entries");
const demoEntry0 = snap0.entries.find((e) => e.configId === "demo-plugin");
ok(demoEntry0 !== undefined && demoEntry0.origin === "user" && demoEntry0.source === "local", "demo entry origin=user source=local(file: derived)");

// ---- 2. 卸载影响预览（依赖感知）----
const preview = await svc.uninstallPreview(["dsh-v08-dep"]);
const pkg = preview.packages[0];
ok(pkg !== undefined && pkg.canUninstall === true, "preview: dep canUninstall");
ok(pkg.affectedEntries.some((e) => e.configId === "dep-plugin"), "preview: affected entry dep-plugin");
ok(pkg.dependents.length === 0, "preview: no dependents of dep");
const previewDemo = await svc.uninstallPreview(["dsh-v08-demo"]);
const d1 = previewDemo.packages[0];
ok(d1.dependents.some((d) => d.packageName === "dsh-v08-dep"), "preview: demo has dependent dsh-v08-dep");
ok(d1.patchRows === 0 && d1.inBundles === true, "preview: patchRows=0 (no toggle yet), inBundles");

// ---- 3. 开关 + 场景保存（含 protected 跳过）----
const tog = await svc.setEnabled("e2", false);
const togItem = tog.items[0];
ok(togItem.status === "changed" && tog.snapshot.entries.find((e) => e.configId === "dep-plugin").enabled === false, "setEnabled dep-plugin -> disabled");
ok(disabledOf("dep-plugin", "dsh-v08-dep") === true, "patch row written for dep-plugin");
const togSkip = await svc.setEnabled("e3", false);
ok(togSkip.items[0].status === "skipped", "protected entry setEnabled skipped");

const scen = await svc.scenarioSave("写作模式");
ok(scen.scenarios.length === 1 && scen.scenarios[0].states["dep-plugin"] === false && scen.scenarios[0].states["demo-plugin"] === true, "scenarioSave states captured");

// ---- 4. 场景应用（preview -> apply）----
const sid = scen.scenarios[0].id;
// 先把 demo 关掉制造差异
await svc.setEnabled("e1", false);
const scenPreview = await svc.scenarioApply(sid, true);
const diffDemo = scenPreview.items.find((i) => i.configId === "demo-plugin");
ok(diffDemo !== undefined && diffDemo.changed === true && diffDemo.status === null, "scenarioApply dryRun shows diff demo-plugin");
const diffProtected = scenPreview.items.find((i) => i.configId === "core-thing");
ok(diffProtected !== undefined && diffProtected.changed === false && diffProtected.protected === true, "scenarioApply dryRun marks protected unchanged entry (changed=false)");
const scenApply = await svc.scenarioApply(sid, false);
const applied = scenApply.items.find((i) => i.configId === "demo-plugin");
ok(applied !== undefined && applied.status === "changed" && disabledOf("demo-plugin", "dsh-v08-demo") === false, "scenarioApply re-enabled demo-plugin");
ok(scenApply.scenarios.length === 1, "scenarioApply returns scenarios");

// ---- 5. 操作历史（setEnabled 可撤销）----
const hist = await svc.operationHistory();
ok(hist.operations.length >= 3, `history records ops (${hist.operations.length})`);
const toggleRecord = hist.operations.find((o) => o.action === "setEnabled");
ok(toggleRecord !== undefined && toggleRecord.undo?.changes?.length === 1, "setEnabled history undo payload");
const undo1 = await svc.undoOperation(hist.operations[1].id);
// 撤销最后一次 setEnabled（关闭 demo）应恢复启用（场景应用前的状态）
ok(undo1.ok === true, "undo setEnabled ok");

// ---- 6. 来源人工修正 ----
const setSrc = await svc.setSourceOverride("dsh-v08-demo", "github");
ok(setSrc.entries.find((e) => e.configId === "demo-plugin").source === "github" && setSrc.entries.find((e) => e.configId === "demo-plugin").sourceOverride === "github", "setSourceOverride github");
const resetSrc = await svc.setSourceOverride("dsh-v08-demo", null);
ok(resetSrc.entries.find((e) => e.configId === "demo-plugin").sourceOverride === null, "setSourceOverride reset to auto");

// ---- 7. 事务化卸载 dep（无依赖者）----
const un = await svc.uninstallPackages(["dsh-v08-dep"], { cascade: true });
const unItem = un.items[0];
ok(unItem.status === "removed" && unItem.verifyOk === true, "transactional uninstall dep removed + verifyOk" + (unItem && unItem.status !== "removed" ? ` [${unItem.status}: ${unItem.message}]` : ""));
const manifestAfter = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
ok(manifestAfter.dependencies["dsh-v08-dep"] === undefined, "dep removed from manifest deps");
ok(!manifestAfter.dsh.profile.bundles.includes("dsh-v08-dep"), "dep removed from bundles");
ok(existsSync(unItem.backupPath), "backup file exists");
const verifyAfterUn = svc.verifyProfile();
ok(verifyAfterUn.ok === true, "verify ok after uninstall (bundles still resolve)");

// ---- 8. 撤销卸载（restore-files + pnpm add）----
const unHist = svc.operationHistory().operations.find((o) => o.action === "uninstall");
ok(unHist !== undefined && unHist.undo?.type === "restore-files", "uninstall history restore-files");
const undo2 = await svc.undoOperation(unHist.id);
ok(undo2.ok === true, "undo uninstall ok");
const manifestRestored = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
ok(manifestRestored.dependencies["dsh-v08-dep"] !== undefined, "dep restored to manifest deps");
ok(manifestRestored.dsh.profile.bundles.includes("dsh-v08-dep"), "dep restored to bundles");
ok(await new Promise((r) => setTimeout(() => r(existsSync(join(profileDir, "node_modules", "dsh-v08-dep"))), 200)), "dep node_modules restored");

// ---- 9. 侧车 v2 持久化（overrides/history/scenarios/pending 字段）----
const sidecar = JSON.parse(readFileSync(join(profileDir, "plugin-manager.json"), "utf8"));
ok(sidecar.version === 2 && Array.isArray(sidecar.history) && sidecar.history.length > 0, "sidecar v2 persisted (history)");
ok(Array.isArray(sidecar.scenarios) && sidecar.scenarios.length === 1, "sidecar v2 persisted (scenarios)");
ok(sidecar.overrides.source["dsh-v08-demo"] === undefined, "sidecar override reset persisted");

// ---- 10. 场景删除 ----
const del = await svc.scenarioDelete(sid);
ok(del.scenarios.length === 0, "scenarioDelete");

// ---- 11. 卸载回滚路径：让备份丢失后卸载失败场景（模拟 pnpm 失败难；改验证 manifest 不存在时不崩）----
const previewMissing = await svc.uninstallPreview(["not-a-pkg"]);
ok(previewMissing.packages[0].canUninstall === false && previewMissing.packages[0].spec === null, "preview unknown pkg => not-managed");

// ---- 12. v0.8 联网更新：file: 安装包（非管理器）应为 managed（可联网更新）；link:/workspace: 除外 ----
const snapManaged = svc.snapshot();
const demoManaged = snapManaged.entries.find((e) => e.configId === "demo-plugin");
ok(demoManaged !== undefined && demoManaged.managed === true, "file: demo package is managed (online update enabled)");

// ---- 13. 救砖：运行期失败条目自动隔离（isolateFailedEntries）----
const { isolateFailedEntries } = await import("./lib/preflight.mjs");
const quarantineDir = mkdtempSync(join(tmpdir(), "pm-v08-q-"));
writeFileSync(join(quarantineDir, "cordis.patch.yml"), "# t\n[]\n", "utf8");
const badLog = 'failed to apply loader entry include (cordis:include): failed to apply loader entry dsh-agent-teams (@nanmicoder/dsh-agent-teams): invalid plugin, received object';
const iso = isolateFailedEntries(quarantineDir, badLog);
ok(iso.isolated.length === 1 && iso.isolated[0] === "@nanmicoder/dsh-agent-teams", "isolateFailedEntries extracts failing entry");
const patchAfter = parseYaml(readFileSync(join(quarantineDir, "cordis.patch.yml"), "utf8"));
const row = patchAfter.find((r) => r && r.name === "@nanmicoder/dsh-agent-teams");
ok(row !== undefined && row.disabled === true, "isolateFailedEntries wrote disabled patch row");
ok(isolateFailedEntries(quarantineDir, badLog).isolated.length === 0, "isolateFailedEntries idempotent (already disabled)");
ok(isolateFailedEntries(quarantineDir, "no matches here").isolated.length === 0, "isolateFailedEntries no-op on clean log");
rmSync(quarantineDir, { recursive: true, force: true });

// ---- 14. host blocker 回归：H1 收敛判据 / H2 错误文本 / H3 自动隔离保护集 ----
// 用「disabled 跟随 patch 文件」的 entry 模拟热重载已收敛，不收敛的 entry 用恒定 false。
const patchRowOf = (configId) => {
	try {
		const seq = parseYaml(readFileSync(patchPath, "utf8"));
		return Array.isArray(seq) ? seq.find((r) => r && r.id === configId) : undefined;
	} catch {
		return undefined;
	}
};
const hEntries = [];
const makeHostEntry = (id, configId, moduleName, followsPatch) => {
	const entry = {
		id,
		options: { id: configId, name: moduleName },
		fiber: undefined,
		_initTask: undefined,
		parent: { ctx: { fiber: { entry: undefined } } }
	};
	Object.defineProperty(entry, "disabled", {
		get() { return followsPatch ? patchRowOf(configId)?.disabled === true : false; },
		configurable: true
	});
	hEntries.push(entry);
	return entry;
};
const hotEntry = makeHostEntry("h1", "hot-plugin", "dsh-v08-demo", true);
const stuckEntry = makeHostEntry("h2", "stuck-plugin", "dsh-v08-dep", false);
const uiCriticalEntry = makeHostEntry("h3", "ui-layout", "@deepseek-ai/dsh-client-ui-layout", false);
const plainEntry = makeHostEntry("h4", "free-search", "dsh-free-search", false);
const hostHandlers = [];
const hostCtx = {
	loader: { ctx: { baseUrl: pathToFileURL(profileDir + "/").href }, entries: () => hEntries, resolve: (id) => hEntries.find((e) => e.id === id) },
	on: (event, handler) => { if (event === "internal/plugin") hostHandlers.push(handler); },
	inject: (_servs, _okCb, failCb) => { if (typeof failCb === "function") failCb(); },
	logger: { info: () => {} },
	reflect: { provide: () => {} }
};
const hostSvc = new PluginManagerPro(hostCtx, { protectedEntries: [], settleTimeoutMs: 400 });

// H1-a：patch 已写入且运行期已收敛 -> 必须立刻返回 changed（修复前固定等满超时并报 restart-required）
const tHot = Date.now();
const hotRes = await hostSvc.setEnabled("h1", false);
const hotMs = Date.now() - tHot;
ok(hotRes.items[0].status === "changed", `H1: 收敛条目返回 changed（实测 ${hotMs}ms, status=${hotRes.items[0].status}）`);
ok(hotMs < 250, `H1: 收敛即返回，不等满 settleTimeoutMs（实测 ${hotMs}ms < 250ms）`);
ok(patchRowOf("hot-plugin")?.disabled === true, "H1: 收敛条目 patch 行确已写入");

// H1-b：运行期确实没收敛 -> 如实报 restart-required，且消息可执行
const tStuck = Date.now();
const stuckRes = await hostSvc.setEnabled("h2", false);
const stuckMs = Date.now() - tStuck;
ok(stuckRes.items[0].status === "restart-required", `H1: 不收敛条目如实报 restart-required（实测 ${stuckMs}ms）`);
ok(typeof stuckRes.items[0].message === "string" && stuckRes.items[0].message.includes("重启"), "H1: restart-required 带可执行说明（提示重启 profile）");
ok(stuckMs >= 300, `H1: 未收敛时按 settleTimeoutMs 收敛判定（实测 ${stuckMs}ms >= 300ms）`);

// H1-c：同一判据用于隔离路径（quarantine 不再因 waitFor 抛错而报 failed）
const qRes = await hostSvc.quarantine(["h1"]);
ok(qRes.items[0].status === "skipped" || qRes.items[0].status === "disabled", `H1: quarantine 使用真实判据（status=${qRes.items[0].status}）`);

// H2：cordis Fiber 只有 _error —— 错误文本必须非空（修复前读 fiber.error 恒为 null）
const badEntry = makeHostEntry("h5", "bad-plugin", "dsh-bad-plugin", false);
badEntry.fiber = { state: 3, _error: new Error("invalid plugin, received object") };
const legacyEntry = makeHostEntry("h6", "legacy-plugin", "dsh-legacy-plugin", false);
legacyEntry.options.error = "loader exploded";
const diag = hostSvc.diagnose();
const badIssue = diag.issues.find((i) => i.configId === "bad-plugin");
ok(badIssue !== undefined, "H2: diagnose 识别失败条目");
ok(badIssue !== undefined && typeof badIssue.error === "string" && badIssue.error.includes("invalid plugin"), `H2: diagnose 错误文本非空（${badIssue?.error}）`);
const badProjected = hostSvc.snapshot().entries.find((e) => e.configId === "bad-plugin");
ok(badProjected !== undefined && typeof badProjected.error === "string" && badProjected.error.length > 0, `H2: 投影 error 非空（${badProjected?.error}）`);
ok(badProjected !== undefined && badProjected.phase === "failed", "H2: 投影 phase=failed");
ok(hostSvc.snapshot().entries.find((e) => e.configId === "legacy-plugin")?.error === "loader exploded", "H2: 回退读 entry.options.error");

// H3：自动隔离必须过保护集，且同一 id 需 >= 2 次稳定失败
await hostSvc.setRescueConfig({ autoQuarantine: true });
const emitFiber = (entry, state) => { for (const handler of hostHandlers) handler({ entry, state, _error: state === 3 ? new Error("boot failed") : undefined }); };
const flushHost = () => new Promise((resolve) => setTimeout(resolve, 200));
for (let i = 0; i < 3; i += 1) emitFiber(uiCriticalEntry, 3);
await flushHost();
ok(patchRowOf("ui-layout")?.disabled !== true, "H3: UI_CRITICAL 条目连续失败 3 次也不被持久禁用");
emitFiber(plainEntry, 3);
await flushHost();
ok(patchRowOf("free-search")?.disabled !== true, "H3: 首次失败不隔离（阈值 >= 2 次）");
emitFiber(plainEntry, 3);
await flushHost();
ok(patchRowOf("free-search")?.disabled === true, "H3: 第 2 次失败才写入禁用行");
ok(readdirSync(profileDir).some((f) => f.includes(".rescue-bak-")), "H3: 写禁用行前已备份 cordis.patch.yml");
const hostSidecar = JSON.parse(readFileSync(join(profileDir, "plugin-manager.json"), "utf8"));
ok(hostSidecar.failureStreak?.["free-search"] >= 2, "H3: 连续失败计数已持久化到侧车（跨启动累计）");

rmSync(profileDir, { recursive: true, force: true });
if (failures.length > 0) {
	console.error(`INTEGRATION FAILED (${failures.length}):\n - ` + failures.join("\n - "));
	process.exit(1);
}
console.log("ALL INTEGRATION TESTS PASSED");
