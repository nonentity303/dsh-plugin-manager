#!/usr/bin/env node
/**
 * test-mod-list.mjs — **3080 管理台与 3081 兜底页的 mod 列表必须一致**（1.1.0 修复的回归护栏）。
 *
 * 背景（用户报的 bug）：同一个 profile，3080 的插件页和 3081 的 `/plugins` 兜底页**数量/成员对不上**。
 * 根因是两页各读一份数据、各算一套分区：
 *   - 3080 = `ctx.loader.entries()` → 只有**已启用**的 bundle 有条目（被禁用的根本不出现）；
 *   - 3081 = profile 清单 `dependencies ∪ dsh.profile.bundles` → 会列出"装了但没启用"和"声明了但没装"的；
 *   - 分区：3080 用官方 `PROTECTED_PLUGINS / HIDDEN_BUNDLES`，3081 曾用硬编码 `CORE_BUNDLES`。
 *
 * 修复后的契约（本文件逐条钉住）：
 *   ① **成员集一致**：3080 = 已加载条目 ∪ 补录行；3081 = 清单三态行 —— 两个名字集合必须逐字相等；
 *   ② **分区一致**：同一个包名，两页判出的 `section`（core / builtin / user）必须相同；
 *   ③ **三态语义明确**：enabled（装且声明）/ disabled（装但没声明）/ dangling（声明了但没装）；
 *   ④ **核心组件两页同一口径**：`@deepseek-ai/dsh-base` / `dsh-web-app` 两边都判 core，且 3081 拒绝禁用；
 *   ⑤ 悬空声明必须在 3080 侧也出现（否则用户永远看不到那个"引擎加载会报错"的隐患）。
 *
 * 用法：node test-mod-list.mjs
 * 退出码：0 = 全绿；1 = 有 FAIL。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginManagerPro, __internals } from "./lib/index.js";
import { FALLBACK_HIDDEN_BUNDLES, classifyBundle, DRYDOCK_LOCKED_CORE_PACKAGES } from "./lib/bundles-official.mjs";
import { classifyProfileBundles, isCoreBundle, listBundles, setBundleEnabled } from "./bin/open-boot.mjs";

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
const sameSet = (actual, expected, label) => {
	const a = [...new Set(actual)].sort();
	const b = [...new Set(expected)].sort();
	if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

// ── 夹具：一个覆盖三态的 profile 清单（形状与真机一致：dependencies + dsh.profile.bundles） ──
const MANIFEST = {
	name: "web",
	dependencies: {
		"dsh-alpha": "1.0.0",
		"dsh-beta": "1.0.0",
		"dsh-gamma": "file:./gamma.tgz"
	},
	dsh: { profile: { bundles: ["dsh-alpha", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-ghost"] } }
};
// 3080 侧"引擎已经加载了这些条目"（loader entries 的最小形状：只需要 packageName/moduleName）
const LOADED_ENTRIES = [{ packageName: "dsh-alpha", moduleName: "dsh-alpha" }, { packageName: "@deepseek-ai/dsh-base", moduleName: "@deepseek-ai/dsh-base" }, { packageName: "@deepseek-ai/dsh-web-app", moduleName: "@deepseek-ai/dsh-web-app" }];

const { mergeProfileOnlyBundles, sectionOfEntry } = __internals;

// ── ① 成员集一致性 ────────────────────────────────────────
check("3080（已加载 ∪ 补录）与 3081（清单三态）成员集逐字相等", () => {
	const patched = mergeProfileOnlyBundles(LOADED_ENTRIES, MANIFEST);
	const hostNames = [...LOADED_ENTRIES.map((e) => e.packageName), ...patched.map((e) => e.packageName)];
	const launcherNames = classifyProfileBundles(MANIFEST).map((row) => row.name);
	sameSet(hostNames, launcherNames, "两页成员集");
	return `共 ${launcherNames.length} 项：${launcherNames.join(", ")}`;
});

check("补录行只补「清单里有、loader 没有」的名字（已加载的不重复）", () => {
	const patched = mergeProfileOnlyBundles(LOADED_ENTRIES, MANIFEST);
	sameSet(patched.map((e) => e.packageName), ["dsh-beta", "dsh-gamma", "dsh-ghost"], "补录集合");
	if (patched.some((e) => e.packageName === "dsh-alpha")) throw new Error("已加载的 dsh-alpha 被重复补录了");
	return `补录 ${patched.length} 行`;
});

// ── ② 分区一致性 ──────────────────────────────────────────
check("同一个包名，两页判出的 section 完全相同", () => {
	const patched = mergeProfileOnlyBundles(LOADED_ENTRIES, MANIFEST);
	const hostSection = new Map([
		...LOADED_ENTRIES.map((e) => [e.packageName, sectionOfEntry(e.packageName, MANIFEST.dependencies[e.packageName] !== void 0 ? "user" : "builtin")]),
		...patched.map((e) => [e.packageName, e.section])
	]);
	const mismatch = [];
	for (const row of classifyProfileBundles(MANIFEST)) {
		if (hostSection.get(row.name) !== row.section) mismatch.push(`${row.name}: host=${hostSection.get(row.name)} / 3081=${row.section}`);
	}
	if (mismatch.length > 0) throw new Error(`分区不一致：${mismatch.join("；")}`);
	return "core / builtin / user 三区对得上";
});

// ── ③ 三态语义 ────────────────────────────────────────────
check("三态分类正确：enabled / disabled / dangling", () => {
	const rows = new Map(classifyProfileBundles(MANIFEST).map((r) => [r.name, r]));
	eq(rows.get("dsh-alpha").state, "enabled", "dsh-alpha（装且声明）");
	eq(rows.get("dsh-beta").state, "disabled", "dsh-beta（装但没声明）");
	eq(rows.get("dsh-gamma").state, "disabled", "dsh-gamma（file: 装但没声明）");
	eq(rows.get("dsh-ghost").state, "dangling", "dsh-ghost（声明了但没装）");
	return "4 种组合都对";
});

check("引擎自带的 core bundle 即使不在 dependencies 里也不算「悬空」（真机实测踩到的误判）", () => {
	const rows = new Map(classifyProfileBundles(MANIFEST).map((r) => [r.name, r]));
	for (const name of DRYDOCK_LOCKED_CORE_PACKAGES) {
		const row = rows.get(name);
		if (!row) throw new Error(`夹具里应有 ${name}`);
		eq(row.installed, false, `${name} 不在 dependencies（这是引擎自带的常态）`);
		eq(row.engineProvided, true, `${name} 应判为引擎自带`);
		eq(row.state, "enabled", `${name} 不应被标成 dangling`);
	}
	return DRYDOCK_LOCKED_CORE_PACKAGES.join(" / ");
});

check("官方 hidden 集里的包声明了但没装 → 也算引擎自带（不是悬空）", () => {
	const hidden = FALLBACK_HIDDEN_BUNDLES.find((name) => !DRYDOCK_LOCKED_CORE_PACKAGES.includes(name));
	const manifest = { dependencies: {}, dsh: { profile: { bundles: [hidden] } } };
	const row = classifyProfileBundles(manifest).find((r) => r.name === hidden);
	eq([row.engineProvided, row.state], [true, "enabled"], `${hidden} 的判定`);
	return hidden;
});

check("真要悬空：声明了、没装、又不是引擎自带 → dangling（两页都必须报出来）", () => {
	const manifest = { dependencies: {}, dsh: { profile: { bundles: ["dsh-nobody"] } } };
	const row = classifyProfileBundles(manifest).find((r) => r.name === "dsh-nobody");
	eq(row.state, "dangling", "3081 判定");
	const patched = mergeProfileOnlyBundles([], manifest);
	const hostRow = patched.find((e) => e.packageName === "dsh-nobody");
	if (!hostRow || !hostRow.entryId.startsWith("dangling:")) throw new Error("3080 侧没把悬空声明标出来");
	return "dsh-nobody";
});

check("被禁用的 bundle 在 3080 侧也出现（只读行 + 明确理由 + 指向 3081 去启用）", () => {
	const patched = mergeProfileOnlyBundles(LOADED_ENTRIES, MANIFEST);
	const beta = patched.find((e) => e.packageName === "dsh-beta");
	if (!beta) throw new Error("3080 侧缺少被禁用的 dsh-beta（这正是用户报的 bug）");
	eq(beta.enabled, false, "enabled");
	eq(beta.protected, true, "protected（只读，避免点了必然失败的开关）");
	if (!/未启用/.test(beta.description)) throw new Error(`描述没写清状态：${beta.description}`);
	if (!/3081/.test(beta.protectionReason)) throw new Error(`理由没指向 3081：${beta.protectionReason}`);
	if (!beta.entryId.startsWith("disabled:")) throw new Error(`entryId 前缀不对：${beta.entryId}`);
	return beta.entryId;
});

check("悬空声明在 3080 侧标成 dangling，并说明「引擎加载会报错」", () => {
	const patched = mergeProfileOnlyBundles(LOADED_ENTRIES, MANIFEST);
	const ghost = patched.find((e) => e.packageName === "dsh-ghost");
	if (!ghost) throw new Error("缺少悬空声明行");
	if (!ghost.entryId.startsWith("dangling:")) throw new Error(`entryId 前缀不对：${ghost.entryId}`);
	if (!/没有安装|未安装/.test(ghost.description)) throw new Error(`描述没说清：${ghost.description}`);
	return ghost.entryId;
});

// ── ④ 核心组件口径 ────────────────────────────────────────
check("核心组件两页同一口径（dsh-base / dsh-web-app）", () => {
	for (const name of DRYDOCK_LOCKED_CORE_PACKAGES) {
		eq(isCoreBundle(name), true, `3081 isCoreBundle(${name})`);
		eq(sectionOfEntry(name, "user"), "core", `3080 section(${name})`);
		eq(classifyBundle(name, { coreSet: DRYDOCK_LOCKED_CORE_PACKAGES, hiddenSet: FALLBACK_HIDDEN_BUNDLES, origin: "user" }), "core", `classifyBundle(${name})`);
	}
	eq(isCoreBundle("dsh-alpha"), false, "普通插件不是核心");
	return DRYDOCK_LOCKED_CORE_PACKAGES.join(" / ");
});

check("官方隐藏集里的包判 builtin（两页一致），不是 core 也不是 user", () => {
	const hidden = FALLBACK_HIDDEN_BUNDLES.find((name) => !DRYDOCK_LOCKED_CORE_PACKAGES.includes(name));
	const manifest = { dependencies: { [hidden]: "1.0.0" }, dsh: { profile: { bundles: [hidden] } } };
	const row = classifyProfileBundles(manifest).find((r) => r.name === hidden);
	eq(row.section, "builtin", `3081 section(${hidden})`);
	eq(sectionOfEntry(hidden, "user"), "builtin", `3080 section(${hidden})`);
	return hidden;
});

// ── ⑤ 3081 侧真实读盘 + 拒绝禁用核心 ─────────────────────
const TMP = mkdtempSync(join(tmpdir(), "drydock-mod-list-"));
process.on("exit", () => {
	try {
		rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* 清理失败不影响结论 */
	}
});

check("listBundles 读真实清单：三态 + catalog 来源都在（读不到官方包时回落，不崩）", () => {
	const profile = join(TMP, "profiles", "web");
	mkdirSync(profile, { recursive: true });
	writeFileSync(join(profile, "package.json"), JSON.stringify(MANIFEST, null, 2));
	const result = listBundles(profile);
	eq(result.ok, true, "ok");
	const byName = new Map(result.bundles.map((b) => [b.name, b]));
	eq(byName.get("dsh-beta").state, "disabled", "dsh-beta");
	eq(byName.get("dsh-ghost").state, "dangling", "dsh-ghost");
	eq(byName.get("@deepseek-ai/dsh-base").core, true, "base 是核心");
	if (typeof result.catalog?.source !== "string") throw new Error("缺 catalog.source（页面要显示分区来源）");
	return `catalog=${result.catalog.source}`;
});

check("3081 拒绝对核心组件关开关（且写明原因）", () => {
	const profile = join(TMP, "profiles", "web");
	const before = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
	const r = setBundleEnabled(profile, "@deepseek-ai/dsh-base", false);
	eq(r.ok, false, "拒绝");
	if (!/核心组件/.test(r.error)) throw new Error(`理由不对：${r.error}`);
	const after = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
	eq(after, before, "被拒绝后清单没被改动");
	return r.error.slice(0, 40);
});

check("3081 认不出未安装的名字（悬空声明不能当正常 bundle 开关）", () => {
	const profile = join(TMP, "profiles", "web");
	const r = setBundleEnabled(profile, "dsh-not-installed", true);
	eq(r.ok, false, "拒绝");
	return r.error.slice(0, 40);
});

// host 侧的快照补录不依赖 loader：这里用一个最小 ctx 直接驱动 snapshot 相关纯函数已足够，
// 完整 snapshot 由 test-integration 覆盖（那边有真 ctx）。

// ── 汇总 ──────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`[${r.ok ? "OK  " : "FAIL"}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
if (failed.length > 0) {
	console.error(`\n${failed.length} 项失败`);
	process.exit(1);
}
console.log(`\nALL MOD-LIST TESTS PASSED (${results.length} checks)`);
