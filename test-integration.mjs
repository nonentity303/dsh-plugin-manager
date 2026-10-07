// test-integration.mjs — v0.8 host 逻辑进程内集成测试（不启动引擎、不占 3080）。
// 覆盖：事务化卸载/回滚/撤销、卸载影响预览（P1-4 三类体检）、操作历史、来源人工修正、场景方案（预览+应用）、
//      侧车 v2 兼容、L9 卸载管理器自身前的开机自启清理。
// 用法: node test-integration.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PluginManagerPro, __internals } from "./lib/index.js";

const failures = [];
const ok = (cond, label) => { if (cond) console.log("OK:", label); else { failures.push(label); console.error("FAIL:", label); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 受限环境（DSH 文件沙箱禁止子进程使用管道 stdio）下降级执行外部命令：
 * 先按常规捕获输出；若 spawn 因管道被拒（EPERM）→ 用「继承 stdio」重跑一次（无捕获、无副作用，
 * 因为管道被拒时子进程从未启动）。正常环境（CI / 普通 shell）行为不变。
 * 判定口径与 lib/index.js 的 spawnPnpm 降级完全一致（EPERM 且无退出码才算「没起来」），
 * 因此受限环境下测试与宿主走的是同一条退化路径；设计的 ①–⑤ 说明见 lib/index.js 的 spawnPnpm。
 */
const runExternal = (command, args, options = {}) => {
	try {
		return String(execFileSyncProbe(command, args, options)).trim();
	} catch (error) {
		if (error?.code !== "EPERM" || (error?.status !== undefined && error?.status !== null)) throw error;
		const retry = spawnSync(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "inherit", "inherit"],
			windowsHide: true
		});
		if (retry.error) throw retry.error;
		if (retry.status !== 0) throw new Error(`${command} 退出码 ${retry.status}`);
		return "";
	}
};

/** 目录全量快照（相对路径 + 内容 sha256 前 16 位），用于证明「P1-4 体检只读」。 */
const dirSnapshot = (dir) => {
	const lines = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			const label = relative(dir, full).replace(/\\/g, "/");
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) lines.push(`${label}=${createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16)}`);
			else lines.push(`${label}=<${entry.isSymbolicLink() ? "link" : "other"}>`);
		}
	};
	walk(dir);
	return lines.sort().join("\n");
};

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

// —— P1-4 体检夹具 ——
//  ① dsh-p14-dependent 依赖 dsh-p14-target（卸载 target 必须报出「兄弟插件依赖断裂 = 高风险」）
//  ② dsh-p14-target 声明 service p14-service + 端口 3081；dsh-p14-rival 声明同一 service/端口（重复 = 信息级）
mkdirSync(join(vendorDir, "dsh-p14-dependent"));
mkdirSync(join(vendorDir, "dsh-p14-target"));
mkdirSync(join(vendorDir, "dsh-p14-rival"));
mkdirSync(join(vendorDir, "dsh-p14-shared"));
mkdirSync(join(vendorDir, "dsh-p14-consumer"));
writePkg(join(vendorDir, "dsh-p14-dependent"), {
	name: "dsh-p14-dependent", version: "1.0.0",
	dsh: { bundle: { patch: "./cordis.patch.yml" } },
	dependencies: { "dsh-p14-target": "file:../dsh-p14-target" }
});
writeFileSync(join(vendorDir, "dsh-p14-dependent", "cordis.patch.yml"), "[]\n", "utf8");
writePkg(join(vendorDir, "dsh-p14-target"), {
	name: "dsh-p14-target", version: "1.0.0",
	dsh: { bundle: { patch: "./cordis.patch.yml" }, services: ["p14-service"], port: 3081 }
});
writeFileSync(join(vendorDir, "dsh-p14-target", "cordis.patch.yml"), "[]\n", "utf8");
writePkg(join(vendorDir, "dsh-p14-rival"), {
	name: "dsh-p14-rival", version: "1.0.0",
	dsh: { bundle: { patch: "./cordis.patch.yml" }, services: [{ name: "p14-service", port: 3081 }] }
});
writeFileSync(join(vendorDir, "dsh-p14-rival", "cordis.patch.yml"), "[]\n", "utf8");
// shared 依赖 target，但 shared 自己又被 consumer 依赖 → 依赖断裂降级为「警告」
writePkg(join(vendorDir, "dsh-p14-shared"), {
	name: "dsh-p14-shared", version: "1.0.0",
	dsh: { bundle: { patch: "./cordis.patch.yml" } },
	dependencies: { "dsh-p14-target": "file:../dsh-p14-target" }
});
writeFileSync(join(vendorDir, "dsh-p14-shared", "cordis.patch.yml"), "[]\n", "utf8");
writePkg(join(vendorDir, "dsh-p14-consumer"), {
	name: "dsh-p14-consumer", version: "1.0.0",
	dsh: { bundle: { patch: "./cordis.patch.yml" } },
	dependencies: { "dsh-p14-shared": "file:../dsh-p14-shared" }
});
writeFileSync(join(vendorDir, "dsh-p14-consumer", "cordis.patch.yml"), "[]\n", "utf8");

// cordis.patch.yml：与 dsh-p14-target 关联、但**不由管理器管理**的开关行 + insert 行（体检应报 patch 残留）
const patchHeader = "# test patch\n";
writeFileSync(join(profileDir, "cordis.patch.yml"), patchHeader + [
	"# 与 dsh-p14-target 关联的非管理器开关行（P1-4 夹具）",
	"- id: p14-extra",
	"  name: dsh-p14-target",
	"  disabled: true",
	"",
	"- id: p14-insert-row",
	"  insert:",
	"    - id: p14-target-helper",
	"      name: dsh-p14-target",
	""
].join("\n"), "utf8");
// 固定 pnpm 的 virtual store 位置（2026-09-30，CI）：不写这一条时，pnpm 在 Windows runner 上
// 会一边把 node_modules 记成 `C:\Users\runneradmin\…`，一边把 virtual store 报成
// `C:\Users\RUNNER~1\…`（8.3 短名），于是后续的 `pnpm remove` 认为"两个 store 不一致"而拒绝执行：
//   The dependencies at …node_modules are currently symlinked from the virtual store directory at …
//   pnpm now wants to use the virtual store at …node_modules/.pnpm to link dependencies from the store.
// 明确写死 virtualStoreDir 后，两次调用看到的是同一个路径。
writeFileSync(join(profileDir, "pnpm-workspace.yaml"), ["packages:", "  - .", "virtualStoreDir: node_modules/.pnpm", ""].join("\n"), "utf8");
writeFileSync(join(profileDir, "package.json"), JSON.stringify({
	name: "dsh-profile-web-v08",
	private: true,
	dsh: { profile: { bundles: ["dsh-v08-demo", "dsh-v08-dep", "dsh-p14-dependent", "dsh-p14-target", "dsh-p14-rival", "dsh-p14-shared", "dsh-p14-consumer"] } },
	dependencies: {
		"dsh-v08-demo": `file:${vendorDir.replace(/\\/g, "/")}/dsh-v08-demo`,
		"dsh-v08-dep": `file:${vendorDir.replace(/\\/g, "/")}/dsh-v08-dep`,
		"dsh-p14-dependent": `file:${vendorDir.replace(/\\/g, "/")}/dsh-p14-dependent`,
		"dsh-p14-target": `file:${vendorDir.replace(/\\/g, "/")}/dsh-p14-target`,
		"dsh-p14-rival": `file:${vendorDir.replace(/\\/g, "/")}/dsh-p14-rival`,
		"dsh-p14-shared": `file:${vendorDir.replace(/\\/g, "/")}/dsh-p14-shared`,
		"dsh-p14-consumer": `file:${vendorDir.replace(/\\/g, "/")}/dsh-p14-consumer`
	}
}, null, 2) + "\n", "utf8");

// 真实 pnpm install：让 pnpm 拥有 node_modules（否则 pnpm remove 会把手工目录当外部包拒绝）
//
// 环境前提（2026-09-30）：本套件的「事务化卸载 / 撤销」断言依赖 **pnpm 的真实解析行为**
// （卸载会把 file: 依赖真删掉、撤销会真装回来）。所以 pnpm 缺失时**不能**用假垫片糊过去——
// 那样只会把断言推到一个 undefined 上崩掉。正确做法是：
//   · 本机：装了 pnpm（用户环境本来就有，见 docs/RELEASING.md §0）
//   · CI：workflow 里显式装 pnpm（pnpm/action-setup）——见 .github/workflows/release.yml
// 缺失时这里给出**明确的环境错误**，而不是让后续断言以 TypeError 的形式误导排查。
import { execFileSync as execFileSyncProbe } from "node:child_process";
const pnpmProbe = (() => {
	try {
		// 注意：必须在**仓库之外**探测。仓库 package.json 钉了 packageManager: npm，
		// pnpm 11 在 cwd 落在这种工程里时会直接拒绝运行（"[ERROR] This project is configured to use npm"），
		// 那不是"没装 pnpm"，只是"这里不归它管"。
		return runExternal(process.platform === "win32" ? "cmd" : "pnpm", process.platform === "win32" ? ["/c", "pnpm", "--version"] : ["--version"], { cwd: tmpdir() }).split("\n").pop().trim();
	} catch {
		return null;
	}
})();
if (pnpmProbe === null) {
	console.error("✘ 环境缺少 pnpm —— 本套件的卸载/撤销断言需要真实的 pnpm 行为。");
	console.error("  · 本机请安装 pnpm（npm i -g pnpm）或核对 PATH");
	console.error("  · CI 请确认 workflow 里有 pnpm/action-setup 步骤");
	process.exit(2);
}
console.log(`（pnpm ${pnpmProbe === "" ? "已探测到（受限环境未捕获版本号）" : pnpmProbe}）`);

const pnpmCmd = process.platform === "win32" ? ["cmd", "/c", "pnpm"] : ["pnpm"];
// 两个 guard 都要关掉，否则 pnpm 11 会因为「祖先目录里声明了别的 packageManager / 工作区根」
// 而拒绝在临时 profile 里安装（[ERROR] This project is configured to use npm）；
// 这里操作的是**一次性临时 profile**，与仓库自身的 npm 约定无关。
//
// `--force`（2026-09-30）：必须让本次安装与后续管理器内部调用的 `pnpm remove` 使用**同一个
// virtual store 位置**。否则 pnpm 会报 "The dependencies at …node_modules are currently symlinked
// from the virtual store directory at … / pnpm now wants to use …node_modules/.pnpm"，
// 卸载被拒 → 管理器如实回滚 → 断言失败（假失败，环境问题而非代码缺陷）。
const pnpmInstallEnv = { ...process.env, NO_COLOR: "1", COREPACK_ENABLE_STRICT: "0", npm_config_ignore_workspace_root_check: "true" };
runExternal(pnpmCmd[0], [...pnpmCmd.slice(1), "install", "--force"], { cwd: profileDir, env: pnpmInstallEnv });

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
	// P1-4 体检夹具条目（依赖断裂 / 重复 service·端口）
	{ id: "p1", options: { id: "p14-target", name: "dsh-p14-target" } },
	{ id: "p2", options: { id: "p14-dependent", name: "dsh-p14-dependent" } },
	{ id: "p3", options: { id: "p14-rival", name: "dsh-p14-rival" } },
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

// ---- 12b. P1-4 卸载前体检：三类检查 + 结论行 + 只读证明 ----
//      夹具：① dsh-p14-dependent 依赖 dsh-p14-target（依赖断裂=高风险）
//            ② dsh-p14-shared 也依赖 target，但它自己被 dsh-p14-consumer 依赖 → 降级为警告
//            ③ target 与 dsh-p14-rival 声明同一 service/端口 → 信息级
//            ④ cordis.patch.yml 里有与 target 关联的非管理器开关行 + insert 行 → 提示
const readOnlyBefore = dirSnapshot(profileDir);
const previewP14 = await svc.uninstallPreview(["dsh-p14-target"]);
const previewP14Safe = await svc.uninstallPreview(["dsh-p14-consumer"]);
const previewP14Self = await svc.uninstallPreview(["dsh-plugin-manager-pro"]);
const readOnlyAfter = dirSnapshot(profileDir);
const p14 = previewP14.packages[0];
const checkOf = (list, id) => (list ?? []).find((check) => check.id === id);
const breakHigh = (p14.checks ?? []).find((check) => check.id === "dependency-break" && check.title.includes("dsh-p14-dependent"));
ok(breakHigh !== undefined && breakHigh.severity === "high", `P1-4①: A 依赖 B → 依赖断裂命中（severity=${breakHigh?.severity}，${breakHigh?.title}）`);
const breakDowngraded = (p14.checks ?? []).find((check) => check.id === "dependency-break" && check.title.includes("dsh-p14-shared"));
ok(breakDowngraded !== undefined && breakDowngraded.severity === "warning" && breakDowngraded.detail.includes("dsh-p14-consumer"),
	`P1-4①: 依赖方同时被别的包依赖 → 降级为警告（severity=${breakDowngraded?.severity}）`);
const residues = (p14.checks ?? []).filter((check) => check.id === "patch-residue");
ok(residues.length === 2 && residues.every((check) => check.severity === "warning") && residues.some((check) => check.title.includes("insert")),
	`P1-4②: cordis.patch.yml 残留提示（${residues.map((check) => check.title).join("；")}）`);
const dupService = checkOf(p14.checks, "duplicate-service");
const dupPort = checkOf(p14.checks, "duplicate-port");
ok(dupService !== undefined && dupService.severity === "info" && dupService.detail.includes("dsh-p14-rival"), `P1-4③: 重复 service 提示（info，${dupService?.title}）`);
ok(dupPort !== undefined && dupPort.severity === "info" && dupPort.detail.includes("3081"), `P1-4③: 重复端口提示（info，${dupPort?.title}）`);
ok(p14.verdict === "risky" && /高风险/.test(p14.verdictReason), `P1-4 结论行=有风险 + 理由（${p14.verdict}：${p14.verdictReason}）`);
ok(previewP14Safe.packages[0].verdict === "safe" && previewP14Safe.packages[0].checks.length === 0, "P1-4 结论行=安全（无命中时）");
ok(previewP14Self.packages[0].isSelf === true && (previewP14Self.packages[0].checks ?? []).some((check) => check.id === "self-uninstall"),
	"P1-4: 卸载管理器自身时预览提示 L9 自启清理（self-uninstall）");
ok(readOnlyBefore === readOnlyAfter, `P1-4 只读：预览前后 profile 全量文件快照一致（${readOnlyBefore.split("\n").length} 个条目）`);

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

// ---- 15. L9：卸载管理器自身前清理开机自启（三种分支 + 级联卸载自身）----
//      独立小 profile（避免污染上面的夹具）；包内 bin/open-boot.mjs 用**桩**替换 ——
//      真实 open-boot --uninstall 会删本机 HKCU Run 的 DSHWeb* 自启值，测试里绝不能真跑。
const selfProfile = mkdtempSync(join(tmpdir(), "pm-l9-self-"));
const selfVendor = join(selfProfile, "vendor");
const managerPkg = join(selfVendor, "dsh-plugin-manager-pro");
const rivalPkg = join(selfVendor, "l9-rival");
const stubPath = join(managerPkg, "bin", "open-boot.mjs");
mkdirSync(join(managerPkg, "bin"), { recursive: true });
mkdirSync(rivalPkg, { recursive: true });
/** 生成启动器桩：记录 argv 到 DSH_PM_L9_PROBE，并按给定退出码/延迟退出。 */
const writeStub = (body) => writeFileSync(stubPath, [
	'import { appendFileSync } from "node:fs";',
	"const probe = process.env.DSH_PM_L9_PROBE;",
	"if (probe) appendFileSync(probe, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + \"\\n\");",
	body,
	"// 能力探测标记：--uninstall（args.uninstall）",
	""
].join("\n"), "utf8");
writePkg(managerPkg, {
	name: "dsh-plugin-manager-pro", version: "0.9.1",
	dsh: { bundle: { patch: "./cordis.patch.yml" } },
	dependencies: { "l9-rival": "file:../l9-rival" }
});
writeFileSync(join(managerPkg, "cordis.patch.yml"), "[]\n", "utf8");
writePkg(rivalPkg, { name: "l9-rival", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } });
writeFileSync(join(rivalPkg, "cordis.patch.yml"), "[]\n", "utf8");
writeStub("process.exit(1);");
writeFileSync(join(selfProfile, "pnpm-workspace.yaml"), ["packages:", "  - .", "virtualStoreDir: node_modules/.pnpm", ""].join("\n"), "utf8");
writeFileSync(join(selfProfile, "cordis.patch.yml"), "# l9\n[]\n", "utf8");
const selfDeps = {
	"dsh-plugin-manager-pro": `file:${selfVendor.replace(/\\/g, "/")}/dsh-plugin-manager-pro`,
	"l9-rival": `file:${selfVendor.replace(/\\/g, "/")}/l9-rival`
};
writeFileSync(join(selfProfile, "package.json"), JSON.stringify({
	name: "dsh-profile-l9-self", private: true,
	dsh: { profile: { bundles: ["dsh-plugin-manager-pro", "l9-rival"] } },
	dependencies: { ...selfDeps }
}, null, 2) + "\n", "utf8");
runExternal(pnpmCmd[0], [...pnpmCmd.slice(1), "install", "--force"], { cwd: selfProfile, env: pnpmInstallEnv });

const selfEntries = [];
const selfCtx = {
	loader: { ctx: { baseUrl: pathToFileURL(selfProfile + "/").href }, entries: () => selfEntries, resolve: () => undefined },
	on: () => {},
	inject: (_servs, _okCb, failCb) => { if (typeof failCb === "function") failCb(); },
	logger: { info: () => {} },
	reflect: { provide: () => {} }
};
const probeFile = join(selfProfile, "l9-probe.jsonl");
// 反向依赖图缓存 30s（模块级）—— 换了 profile 夹具必须显式清空，否则看到的是上一个 profile 的图
__internals.resetDependencyCache();
const selfSvc = new PluginManagerPro(selfCtx, { protectedEntries: [], settleTimeoutMs: 200, selfPackageDir: managerPkg, autostartTimeoutMs: 4000 });

// 15a：级联卸载自身 —— 目标 l9-rival 的依赖方正是管理器自身 → removal 含 self → 先清理自启
writeStub("process.exit(1);");
process.env.DSH_PM_L9_PROBE = probeFile;
const cascadeSelf = await selfSvc.uninstallPackages(["l9-rival"], { cascade: true });
const cascadeItem = cascadeSelf.items[0];
ok(cascadeItem.status === "removed", `L9: 级联卸载自身成功（清理失败不阻断；status=${cascadeItem.status}：${cascadeItem.message}）`);
ok(cascadeItem.isSelf === true && cascadeItem.dependentPackages.includes("dsh-plugin-manager-pro"),
	`L9: 级联把管理器自身算进移除集（dependentPackages=${JSON.stringify(cascadeItem.dependentPackages)}）`);
ok(cascadeItem.autostartCleanup?.status === "failed" && cascadeItem.autostartCleanup.exitCode === 1,
	`L9 分支②失败不阻断：autostartCleanup=${JSON.stringify(cascadeItem.autostartCleanup)}`);
ok(!existsSync(join(selfProfile, "node_modules", "dsh-plugin-manager-pro")), "L9: 包目录已删除（说明清理发生在 pnpm remove 之前的真实调用）");
const probeLines = existsSync(probeFile) ? readFileSync(probeFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const stripSep = (value) => String(value ?? "").replace(/[\\/]+$/, "");
ok(probeLines.length >= 1 && probeLines[0].argv[0] === "--uninstall" && probeLines[0].argv[1] === "--profile" && stripSep(probeLines[0].argv[2]) === stripSep(selfProfile),
	`L9: 桩实测 argv（${JSON.stringify(probeLines[0]?.argv)}）`);
ok(probeLines.length >= 1 && stripSep(probeLines[0].cwd) === stripSep(selfProfile), `L9: 子进程 cwd=profile 目录（不锁包目录，审计 L2；实测 ${probeLines[0]?.cwd}）`);
const l9History = selfSvc.operationHistory().operations[0];
ok(typeof l9History?.detail === "string" && l9History.detail.includes("开机自启清理") && l9History.detail.includes("未成功"),
	`L9: 清理结果写入操作历史（${l9History?.detail}）`);

// 15b：直接卸载自身 + 分支①成功（exit 0）
writeStub("process.exit(0);");
runExternal(pnpmCmd[0], [...pnpmCmd.slice(1), "add", `dsh-plugin-manager-pro@${selfDeps["dsh-plugin-manager-pro"]}`], { cwd: selfProfile, env: pnpmInstallEnv });
writeFileSync(probeFile, "", "utf8");
__internals.resetDependencyCache();
selfSvc.profileDeps = JSON.parse(readFileSync(join(selfProfile, "package.json"), "utf8")).dependencies ?? {};
const directSelf = await selfSvc.uninstallPackages(["dsh-plugin-manager-pro"], { cascade: false });
const directItem = directSelf.items[0];
ok(directItem.status === "removed" && directItem.isSelf === true, `L9: 直接卸载自身成功（status=${directItem.status}）`);
ok(directItem.autostartCleanup?.status === "cleaned" && directItem.autostartCleanup.exitCode === 0,
	`L9 分支①成功（exit 0）：autostartCleanup=${JSON.stringify(directItem.autostartCleanup)}`);
const directHistory = selfSvc.operationHistory().operations[0];
ok(typeof directHistory?.detail === "string" && directHistory.detail.includes("已完成"), `L9: 成功分支写入历史（${directHistory?.detail}）`);

// 15c：分支④旧版本（包内没有 --uninstall 子命令）→ 跳过并注明
writeStub("process.exit(0);");
writeFileSync(stubPath, '// 旧版本：只有 --uninstall-autostart\nprocess.exit(0);\n', "utf8");
const legacyCleanup = await selfSvc.cleanupOwnAutostart();
ok(legacyCleanup.status === "skipped" && legacyCleanup.message.includes("旧版本") && legacyCleanup.command === null,
	`L9 分支④跳过（旧版本）：${legacyCleanup.message}`);

// 15d：分支⑤包内没有 bin/open-boot.mjs → 跳过并注明
rmSync(stubPath, { force: true });
const missingCleanup = await selfSvc.cleanupOwnAutostart();
ok(missingCleanup.status === "skipped" && missingCleanup.message.includes("没有"), `L9 分支⑤跳过（无该文件）：${missingCleanup.message}`);

// 15e：分支③超时 → 终止子进程、不阻断、如实上报
writeStub("await new Promise((resolve) => setTimeout(resolve, 10000));");
const slowSvc = new PluginManagerPro(selfCtx, { protectedEntries: [], settleTimeoutMs: 200, selfPackageDir: managerPkg, autostartTimeoutMs: 300 });
const tSlow = Date.now();
const slowCleanup = await slowSvc.cleanupOwnAutostart();
const slowMs = Date.now() - tSlow;
ok(slowCleanup.status === "timeout" && /未返回/.test(slowCleanup.message), `L9 分支③超时：${slowCleanup.message}（实测 ${slowMs}ms）`);
ok(slowMs < 4000, `L9: 超时受 autostartTimeoutMs 约束（${slowMs}ms，注入 300ms）`);

// 15f：默认值 + 与包内启动器 CLI 契约的耦合（只做静态断言：真实 --uninstall 会删本机 DSHWeb* 自启，测试里绝不执行）
const defaultSvc = new PluginManagerPro(selfCtx, { protectedEntries: [] });
const repoRoot = dirname(fileURLToPath(import.meta.url));
ok(defaultSvc.autostartTimeoutMs === 20000, `L9: 默认超时 20s（实测 ${defaultSvc.autostartTimeoutMs}ms）`);
ok(defaultSvc.ownPackageDirectory() === repoRoot, `L9: 默认按 lib/index.js 反推包目录（${defaultSvc.ownPackageDirectory()}）`);
const shippedLauncher = readFileSync(join(repoRoot, "bin", "open-boot.mjs"), "utf8");
ok(/--uninstall(?!-)/.test(shippedLauncher) && shippedLauncher.includes("args.uninstall"),
	"L9: 包内启动器声明 --uninstall（能力探测通过 → 生产环境会真的调用；旧版本只认 --uninstall-autostart 会被跳过）");

// 超时分支的子进程刚被 kill：等它真正退出，否则它仍以 profile 为 cwd（Windows 会锁住目录，rm 报 EPERM）
await sleep(600);
rmSync(selfProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
if (failures.length > 0) {
	console.error(`INTEGRATION FAILED (${failures.length}):\n - ` + failures.join("\n - "));
	process.exit(1);
}
console.log("ALL INTEGRATION TESTS PASSED");
