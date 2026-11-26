// test-security-provenance.mjs — CWE-494（供应链投毒：伪造同名仓库 v999.0.0 赢过官方发布）修复回归。
//
// 修复的两环（详见 lib/aggregate.js / lib/index.js 的注释）：
//  ① 信任分级：aggregateLatest 让 registry 源权威，非 registry 源只在 registry 拿不到版本时
//     作兜底并标记 degraded:true —— 这是"伪造 v999.0.0 能生效"的**根因**。
//  ② dshfind 源整体移除：它把 `topic:dsh-plugin <包名>` 搜索结果里第一个同名仓库当发布源
//     （不校验 owner/repo、不比对 npm 登记的 repository），属于"搜索猜来源"，加固也只能缓解。
//
// 全部用注入的 fake fetch / 临时 profile 夹具，**不联网**。
// 用法: node test-security-provenance.mjs   （PASS 退出码 0，FAIL 退出码 1）
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { aggregateLatest, SOURCE_TRUST } from "./lib/aggregate.js";
import { PluginManagerPro, __internals } from "./lib/index.js";

const failures = [];
const ok = (cond, label) => {
	if (cond) console.log("OK:", label);
	else {
		failures.push(label);
		console.error("FAIL:", label);
	}
};
const makeCtx = (dir) => ({
	loader: { ctx: { baseUrl: pathToFileURL(dir + "/").href }, entries: () => [], resolve: () => void 0 },
	on: () => {},
	inject: (servs, okCb, failCb) => { if (typeof failCb === "function") failCb(); },
	logger: { info: () => {} },
	reflect: { provide: () => {} }
});

//#region A. aggregateLatest 纯函数：registry 权威 + 兜底降级 + 向后兼容
const npmEntry = (version, name = "官方源 (npm)", url = "https://registry.npmjs.org") => ({
	version,
	sourceName: name,
	sourceUrl: url,
	sourceType: "registry",
	type: "registry",
	repo: null
});
const githubEntry = (version, repo = "evil/victim-plugin") => ({
	version,
	sourceName: "GitHub 官方仓库",
	sourceUrl: `https://github.com/${repo}`,
	sourceType: "github",
	type: "github",
	repo
});

// A1：攻击核心 —— 伪造的 github 源 v999.0.0 不能覆盖 registry 的 1.0.2
const a1 = aggregateLatest([npmEntry("1.0.2"), githubEntry("999.0.0")]);
ok(a1.version === "1.0.2" && a1.sourceName === "官方源 (npm)",
	`A1 registry 权威：伪造 github 999.0.0 被忽略，选 registry 的 ${a1.version}（source=${a1.sourceName}）`);
ok(a1.sourceTrust === "registry" && a1.degraded === false && a1.repo === null && a1.sourceType === "registry",
	`A1 返回 sourceTrust=registry / degraded=false / repo=null（实际 ${a1.sourceTrust}/${a1.degraded}/${String(a1.repo)}）`);

// A2：registry 没给出版本 → 才允许兜底，且必须标 degraded
const a2 = aggregateLatest([npmEntry(null), githubEntry("999.0.0")]);
ok(a2.version === "999.0.0" && a2.sourceName === "GitHub 官方仓库" && a2.repo === "evil/victim-plugin",
	`A2 兜底：registry 无版本时才用 github 的 ${a2.version}（repo=${a2.repo}）`);
ok(a2.sourceTrust === "fallback" && a2.degraded === true,
	`A2 兜底必须标 sourceTrust=fallback / degraded=true（实际 ${a2.sourceTrust}/${a2.degraded}）`);

// A3：两个 registry 源（npm + 镜像）之间取最高，仍是 registry 信任层
const a3 = aggregateLatest([
	npmEntry("1.0.2"),
	npmEntry("1.0.3", "npmmirror 镜像", "https://registry.npmmirror.com"),
	githubEntry("999.0.0")
]);
ok(a3.version === "1.0.3" && a3.sourceName === "npmmirror 镜像" && a3.sourceTrust === SOURCE_TRUST.REGISTRY,
	`A3 registry 之间取最高：${a3.version}（source=${a3.sourceName}，trust=${a3.sourceTrust}）`);
const a3r = aggregateLatest([
	npmEntry("1.0.3", "npmmirror 镜像", "https://registry.npmmirror.com"),
	npmEntry("1.0.2")
]);
ok(a3r.version === "1.0.3" && a3r.sourceTrust === SOURCE_TRUST.REGISTRY,
	`A3 registry 取最高与列表顺序无关（倒序仍选 ${a3r.version}）`);

// A4：向后兼容 —— 老夹具没有 type 字段时退化为全局取最高，且不带信任字段
const a4 = aggregateLatest([
	{ version: "1.0.0", sourceName: "npm" },
	{ version: "999.0.0", sourceName: "github", repo: "evil/x" }
]);
ok(a4.version === "999.0.0" && a4.sourceName === "github" && a4.sourceTrust === void 0 && a4.degraded === void 0,
	`A4 无 type 字段 → 原行为（全局取最高 ${a4.version}，不带 sourceTrust/degraded）`);

// A5：全 null → version=null，不伪造信任层
const a5 = aggregateLatest([npmEntry(null), githubEntry(null)]);
ok(a5.version === null && a5.sourceTrust === null && a5.degraded === false,
	`A5 全部无版本 → version=null（trust=${String(a5.sourceTrust)}, degraded=${a5.degraded}）`);

// A6：并列随机语义仍在（同一信任层内）
const seen = new Set();
for (let i = 0; i < 200; i += 1) {
	const pick = aggregateLatest([npmEntry("1.0.0", "源A", "https://a.test"), npmEntry("1.0.0", "源B", "https://b.test")]);
	if (pick.version !== "1.0.0") { seen.clear(); break; }
	seen.add(pick.sourceName);
}
ok(seen.size === 2, `A6 registry 层内并列随机（200 次覆盖 ${seen.size}/2 个源：${[...seen].join(",")}）`);
const seenFallback = new Set();
for (let i = 0; i < 200; i += 1) {
	const pick = aggregateLatest([npmEntry(null), githubEntry("2.0.0", "a/one"), githubEntry("2.0.0", "b/two")]);
	if (pick.version !== "2.0.0" || pick.degraded !== true) { seenFallback.clear(); break; }
	seenFallback.add(pick.repo);
}
ok(seenFallback.size === 2, `A6 兜底层内并列随机（200 次覆盖 ${seenFallback.size}/2 个 repo：${[...seenFallback].join(",")}）`);

// A7：显式 trustTiers:false 只用于兼容，仍可复现旧行为
const a7 = aggregateLatest([npmEntry("1.0.2"), githubEntry("999.0.0")], { trustTiers: false });
ok(a7.version === "999.0.0", `A7 trustTiers:false → 旧行为（全局取最高 ${a7.version}，仅兼容用）`);
//#endregion

//#region 夹具：一个模拟"升级前用户"的临时 profile（侧车里还存着 enabled:true 的 dshfind 源）
const net = __internals.network;
const profileDir = mkdtempSync(join(tmpdir(), "pm-secb-"));
writeFileSync(join(profileDir, "package.json"), JSON.stringify({ name: "secb-profile", private: true, dependencies: {} }, null, 2) + "\n", "utf8");
writeFileSync(join(profileDir, "plugin-manager.json"), JSON.stringify({
	version: 2,
	sources: [
		{ name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, type: "registry" },
		{ name: "插件超市 (dshfind)", url: "https://dshfind.com/zh/plugins", enabled: true, official: false, type: "dshfind" },
		{ name: "GitHub 官方仓库", url: "https://github.com/deepseek-ai/deepseek-harness", enabled: false, official: true, type: "github" }
	]
}, null, 2) + "\n", "utf8");
const svc = new PluginManagerPro(makeCtx(profileDir), { protectedEntries: [], settleTimeoutMs: 200 });
//#endregion

//#region B. fetchLatestAcross 端到端：注入 fake fetch，验证 type 真的传进聚合
const realFetch = globalThis.fetch;
let fetchLog = [];
let registryStatus = 200;
let registryLatest = "1.0.2";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : input?.url ?? String(input);
	fetchLog.push(url);
	if (url.startsWith("https://registry.test/")) {
		if (registryStatus !== 200) return json({ error: "boom" }, registryStatus);
		return json({ "dist-tags": { latest: registryLatest } });
	}
	if (url.startsWith("https://raw.githubusercontent.com/")) return json({ name: "victim-plugin", version: "9.9.9" });
	if (url.startsWith("https://api.github.com/") && url.includes("/releases/latest")) return json({ tag_name: "v999.0.0" });
	return json({}, 404);
};

const SOURCE_LIST = [
	{ name: "官方源 (npm)", url: "https://registry.test", enabled: true, official: true, type: "registry" },
	{ name: "GitHub 官方仓库", url: "https://github.com/evil/victim-plugin", enabled: true, official: false, type: "github" }
];
const reset = () => { net.resetNetworkState(); fetchLog = []; registryStatus = 200; registryLatest = "1.0.2"; };

// B1：正常网络 —— registry 1.0.2 vs 伪造 github 999.0.0 → 选 1.0.2，信任层 registry
reset();
const b1 = await net.fetchLatestAcross("victim-plugin", SOURCE_LIST, { force: true });
ok(b1.version === "1.0.2" && b1.sourceName === "官方源 (npm)",
	`B1 端到端：registry 1.0.2 胜过伪造 github 999.0.0 → ${b1.version}（source=${b1.sourceName}）`);
ok(b1.sourceTrust === "registry" && b1.degraded === false && b1.repo === null && b1.sourceUrl === "https://registry.test",
	`B1 结果携带 sourceTrust=registry / degraded=false / repo=null / sourceUrl=${b1.sourceUrl}`);
ok(fetchLog.some((u) => u.includes("raw.githubusercontent.com/evil/victim-plugin")) && fetchLog.some((u) => u.includes("/releases/latest")),
	"B1 伪造 github 源确实被查询过（999.0.0 是被信任分级拦下的，不是源没响应）");

// B2：registry 404（确定性无版本）→ github 兜底，必须标 degraded
reset();
registryStatus = 404;
const b2 = await net.fetchLatestAcross("victim-plugin", SOURCE_LIST, { force: true });
ok(b2.version === "999.0.0" && b2.sourceTrust === "fallback" && b2.degraded === true,
	`B2 registry 404 → 兜底 ${b2.version}，sourceTrust=fallback / degraded=${b2.degraded}`);
ok(b2.repo === "evil/victim-plugin", `B2 兜底结果保留 repo（下载器要用）：${b2.repo}`);

// B3：registry 5xx（不确定）→ 仍按兜底处理并标 degraded
reset();
registryStatus = 500;
const b3 = await net.fetchLatestAcross("victim-plugin", SOURCE_LIST, { force: true });
ok(b3.version === "999.0.0" && b3.degraded === true && b3.reason === net.REASON.OK,
	`B3 registry 5xx 时 github 兜底仍可用（${b3.version}, degraded=${b3.degraded}），registry 的 network 原因不会冒充"无更新"`);

// B4：registry 源被停用 → 只剩 github，兜底 + degraded
reset();
const b4 = await net.fetchLatestAcross("victim-plugin", SOURCE_LIST.map((s) => s.type === "registry" ? { ...s, enabled: false } : s), { force: true });
ok(b4.version === "999.0.0" && b4.sourceTrust === "fallback" && b4.degraded === true,
	`B4 只有非 registry 源时版本可用但明确降级（trust=${b4.sourceTrust}, degraded=${b4.degraded}）`);

// B5：没有任何启用源 → 不伪造版本/信任层
reset();
const b5 = await net.fetchLatestAcross("victim-plugin", [], { force: true });
ok(b5.version === null && b5.reason === net.REASON.NO_SOURCE && b5.sourceTrust === null && b5.degraded === false,
	`B5 无启用源 → version=null / reason=${b5.reason} / trust=${String(b5.sourceTrust)}`);

// B6：refreshLatest 写进 LATEST_CACHE 的 best 自然携带 sourceTrust；
//     project() 把信任层摊平到快照条目（UI 可据此提示「未经 npm 校验」）
reset();
const b6 = await net.refreshLatest("victim-plugin", SOURCE_LIST, { force: true });
ok(b6.sourceTrust === "registry" && b6.degraded === false, "B6 refreshLatest 返回的 best 携带 sourceTrust/degraded");
const projected = svc.project({ id: "secb-x", options: { id: "secb-x", name: "victim-plugin" }, fiber: void 0, disabled: false });
ok(projected.updateSourceTrust === "registry" && projected.updateDegraded === false && projected.latestVersion === "1.0.2",
	`B6 project() 暴露 updateSourceTrust=${projected.updateSourceTrust} / updateDegraded=${projected.updateDegraded}`);

globalThis.fetch = realFetch;
//#endregion

//#region C. dshfind 源已移除：源码不变量 + 旧侧车迁移 + 源定位防错配
const indexSrc = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
ok(!indexSrc.includes("fetchLatestDshfindVersion"), "C1 源码里已无 fetchLatestDshfindVersion（不留死代码）");
ok(!indexSrc.includes("DSFFIND_SEARCH_CACHE") && !indexSrc.includes("DSFFIND_SEARCH_TTL_MS"), "C1 源码里已无 DSFFIND_SEARCH_CACHE / DSFFIND_SEARCH_TTL_MS");
const dshfindTypeChecks = (indexSrc.match(/type === "dshfind"/g) ?? []).length;
ok(dshfindTypeChecks === 1, `C1 唯一保留的 dshfind 判断是旧侧车/旧客户端的迁移剔除（实际 ${dshfindTypeChecks} 处）`);
const defaultBlock = /const DEFAULT_SOURCES = \[([\s\S]*?)\n\];/.exec(indexSrc)?.[1] ?? "";
ok(defaultBlock !== "" && !/dshfind/i.test(defaultBlock), "C2 DEFAULT_SOURCES 已不含 dshfind 条目");
ok(!/dshfind\.com\/zh\/plugins/.test(defaultBlock), "C2 DEFAULT_SOURCES 不再预置 dshfind.com URL");
ok(!indexSrc.includes("source.type === \"dshfind\""), "C2 更新流程里已无 dshfind 分支（fetchLatestVersion / resolveSourceDownloadUrl / updateOne 都不再分派）");

ok(svc.sources.length === 2 && !svc.sources.some((s) => s.type === "dshfind" || /dshfind\.com/.test(s.url)),
	`C3 旧侧车里的 enabled:true dshfind 源被剔除（剩 ${svc.sources.length} 个：${svc.sources.map((s) => s.name).join(" / ")}）`);
ok(svc.sources.some((s) => s.type === "registry" && s.url === "https://registry.npmjs.org"), "C3 registry 源保留");
ok(svc.sources.some((s) => s.type === "github"), "C3 github 源保留");

// C4：setSources 也不再接受 dshfind 类型（旧客户端仍可能提交）
const afterSave = await svc.setSources([
	{ name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, type: "registry" },
	{ name: "插件超市 (dshfind)", url: "https://dshfind.com/zh/plugins", enabled: true, official: false, type: "dshfind" }
]);
ok(afterSave.sources.length === 1 && afterSave.sources.every((s) => s.type === "registry" && !/dshfind\.com/.test(s.url)),
	`C4 setSources 丢弃旧 dshfind 条目（保存后 ${afterSave.sources.length} 个源）`);

// C5：源定位防错配 —— 同名源时按 URL/类型定位，绝不能把 github 版本交给 registry 装法
const mixDir = mkdtempSync(join(tmpdir(), "pm-secb-mix-"));
writeFileSync(join(mixDir, "package.json"), JSON.stringify({ name: "secb-mix", private: true, dependencies: {} }, null, 2) + "\n", "utf8");
writeFileSync(join(mixDir, "plugin-manager.json"), JSON.stringify({
	version: 2,
	sources: [
		{ name: "同名源", url: "https://registry.test", enabled: true, official: false, type: "registry" },
		{ name: "同名源", url: "https://github.com/good/victim-plugin", enabled: true, official: false, type: "github" }
	]
}, null, 2) + "\n", "utf8");
const mixSvc = new PluginManagerPro(makeCtx(mixDir), { protectedEntries: [], settleTimeoutMs: 200 });
const matched = mixSvc.bestSourceOf({ version: "9.9.9", sourceName: "同名源", sourceUrl: "https://github.com/good/victim-plugin", sourceType: "github", repo: "good/victim-plugin" });
ok(matched.source?.type === "github" && matched.source.url === "https://github.com/good/victim-plugin",
	`C5 同名源按 URL 定位到 github 源（实际 ${matched.source?.type ?? "undefined"}），不会错配成 registry`);
const missing = mixSvc.bestSourceOf({ version: "9.9.9", sourceName: "已删除的源", sourceUrl: "https://github.com/gone/x", sourceType: "github" });
ok(missing.source === void 0 && typeof missing.message === "string" && missing.message.includes("重新检查更新"),
	`C5 源已不存在时明确报"配置可能已变更"（message=${missing.message}），不随便拿一个启用源兜底`);

rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
rmSync(mixDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
//#endregion

if (failures.length > 0) {
	console.error(`RESULT: FAIL (${failures.length} 项)\n - ` + failures.join("\n - "));
	process.exit(1);
}
console.log("RESULT: PASS — registry 权威（伪造 v999.0.0 不再生效）/ registry 缺失时才兜底并标 degraded / dshfind 源已移除且旧侧车被迁移 / 源定位不再错配");
process.exit(0);
