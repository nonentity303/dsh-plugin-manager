// test-security-provenance.mjs — CWE-494（供应链投毒：伪造同名仓库 v999.0.0 赢过官方发布）修复回归。
//
// 修复的两环（详见 lib/aggregate.js / lib/index.js 的注释）：
//  ① 信任分级：aggregateLatest 让服务端判定的权威源权威，非权威源只在权威源拿不到版本时
//     作兜底并标记 degraded:true —— 这是"伪造 v999.0.0 能生效"的**根因**。
//  ② dshfind 源整体移除：它把 `topic:dsh-plugin <包名>` 搜索结果里第一个同名仓库当发布源
//     （不校验 owner/repo、不比对 npm 登记的 repository），属于"搜索猜来源"，加固也只能缓解。
//
// 1.0.3 追加（A 报告 S1/S3、B 报告 S1）：
//  D. official 由服务端白名单判定、自定义源默认非权威、显式 authoritative（http 需 allowInsecure）；
//  E. dist-tags.next 只给 @deepseek-ai/* + 权威源，其余包只取 latest 且过滤 prerelease；
//  F. downloads 目录 provenance：没有 sidecar 记录的归档拒绝，记录+摘要匹配才安装。
//
// 全部用注入的 fake fetch / 临时 profile 夹具，**不联网**。
// 用法: node test-security-provenance.mjs   （PASS 退出码 0，FAIL 退出码 1）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

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
ok(a1.sourceTrust === SOURCE_TRUST.AUTHORITATIVE && a1.degraded === false && a1.repo === null && a1.sourceType === "registry",
	`A1 返回 sourceTrust=authoritative / degraded=false / repo=null（实际 ${a1.sourceTrust}/${a1.degraded}/${String(a1.repo)}）`);

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
ok(b1.sourceTrust === SOURCE_TRUST.AUTHORITATIVE && b1.degraded === false && b1.repo === null && b1.sourceUrl === "https://registry.test",
	`B1 结果携带 sourceTrust=authoritative / degraded=false / repo=null / sourceUrl=${b1.sourceUrl}`);
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
ok(b6.sourceTrust === SOURCE_TRUST.AUTHORITATIVE && b6.degraded === false, "B6 refreshLatest 返回的 best 携带 sourceTrust/degraded");
const projected = svc.project({ id: "secb-x", options: { id: "secb-x", name: "victim-plugin" }, fiber: void 0, disabled: false });
ok(projected.updateSourceTrust === SOURCE_TRUST.AUTHORITATIVE && projected.updateDegraded === false && projected.latestVersion === "1.0.2",
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

//#region D. A1 信任模型：official 由服务端白名单判定，authoritative 需显式升级（客户端自报无效）
// 从这一节开始不再恢复 realFetch：装一个"永不联网"的桩（后台 refresh 在无 loader 条目时也不发请求）。
globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : input?.url ?? String(input);
	if (url.startsWith("https://registry.npmjs.org/")) return json({ "dist-tags": { latest: "1.0.3" } });
	if (url.startsWith("http://evil.example/")) return json({ "dist-tags": { latest: "999.0.0", next: "999.9.9" } });
	if (url.startsWith("https://mirror.example/")) return json({ "dist-tags": { latest: "1.0.4" } });
	return json({}, 404);
};

// D1：客户端伪造 http://evil.example + official:true + authoritative:true（未 allowInsecure）
//     → official 必须 false；明文源未显式 allowInsecure → 降级为非权威并给可读 note
const d1Snap = await svc.setSources([
	{ name: "伪造源", url: "http://evil.example", enabled: true, official: true, authoritative: true, type: "registry" },
	{ name: "官方源 (npm)", url: "https://registry.npmjs.org/", enabled: true, official: false, type: "registry" },
	{ name: "自定义镜像", url: "https://mirror.example", enabled: true, official: true, authoritative: true, type: "registry" }
]);
const d1ByUrl = Object.fromEntries(d1Snap.sources.map((s) => [s.url, s]));
ok(d1ByUrl["https://registry.npmjs.org"]?.official === true && d1ByUrl["https://registry.npmjs.org"]?.authoritative === true,
	"D1 内置 npmjs 源按白名单 official=true / authoritative=true（客户端自报 official:false 被忽略）");
ok(d1ByUrl["http://evil.example"]?.official === false && d1ByUrl["http://evil.example"]?.authoritative === false && d1ByUrl["http://evil.example"]?.insecure === true,
	`D1 伪造 http 源 official=false / authoritative=false / insecure=true（实际 ${d1ByUrl["http://evil.example"]?.official}/${d1ByUrl["http://evil.example"]?.authoritative}/${d1ByUrl["http://evil.example"]?.insecure}）`);
ok(typeof d1ByUrl["http://evil.example"]?.note === "string" && d1ByUrl["http://evil.example"].note.includes("allowInsecure"),
	`D1 明文源被降级时给出可读 note（实际 note=${String(d1ByUrl["http://evil.example"]?.note)?.slice(0, 40)}…）`);
ok(d1ByUrl["https://mirror.example"]?.official === false && d1ByUrl["https://mirror.example"]?.authoritative === true,
	"D1 自定义 https 源显式 authoritative:true 才升权威（official 仍 false）");

// D2：端到端 —— 伪造源返回 999.0.0（even official:true）也不能覆盖官方权威源的 1.0.3
await svc.setSources([
	{ name: "伪造源", url: "http://evil.example", enabled: true, official: true, type: "registry" },
	{ name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, type: "registry" }
]);
net.resetNetworkState();
const d2 = await net.fetchLatestAcross("victim-plugin", svc.sources, { force: true });
ok(d2.version === "1.0.3" && d2.sourceName === "官方源 (npm)" && d2.sourceTrust === SOURCE_TRUST.AUTHORITATIVE && d2.degraded === false,
	`D2 伪造源 999.0.0 不覆盖权威源：选中 ${d2.version}（source=${d2.sourceName}, trust=${d2.sourceTrust}）`);

// D3：显式 authoritative:true 的源在官方源不可达时仍能独立完成版本裁决（内网/离线场景）
await svc.setSources([
	{ name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, type: "registry" },
	{ name: "内网镜像", url: "https://mirror.example", enabled: true, official: false, authoritative: true, type: "registry" }
]);
const d3Fetch = globalThis.fetch;
globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : input?.url ?? String(input);
	if (url.startsWith("https://registry.npmjs.org/")) throw new TypeError("fetch failed");
	if (url.startsWith("https://mirror.example/")) return json({ "dist-tags": { latest: "1.0.4" } });
	return json({}, 404);
};
net.resetNetworkState();
const d3 = await net.fetchLatestAcross("victim-plugin", svc.sources, { force: true });
globalThis.fetch = d3Fetch;
ok(d3.version === "1.0.4" && d3.sourceName === "内网镜像" && d3.sourceTrust === SOURCE_TRUST.AUTHORITATIVE && d3.degraded === false,
	`D3 官方源不可达时显式权威的自定义源仍独立裁决：${d3.version}（trust=${d3.sourceTrust}, degraded=${d3.degraded}）`);

// D4：明文 http 源 + 显式 authoritative + allowInsecure 才升权威；official 仍只能来自白名单
const d4 = await svc.setSources([
	{ name: "内网 registry", url: "http://10.0.0.5:4873", enabled: true, official: true, authoritative: true, allowInsecure: true, type: "registry" }
]);
ok(d4.sources[0]?.authoritative === true && d4.sources[0]?.insecure === true && d4.sources[0]?.official === false && d4.sources[0]?.allowInsecure === true,
	`D4 明文源显式 authoritative+allowInsecure 才升权威（official=${d4.sources[0]?.official}, insecure=${d4.sources[0]?.insecure}）`);

// D5：源变更写操作历史（审计：前后 URL / 权威层 / 是否含明文）
const d5History = svc.operationHistory().operations.find((item) => item.action === "setSources");
ok(d5History !== void 0 && d5History.label === "更新源配置" && typeof d5History.detail === "string"
	&& d5History.detail.includes("权威层") && d5History.detail.includes("含明文源"),
	`D5 setSources 写入操作历史（detail=${String(d5History?.detail)?.slice(0, 80)}…）`);
const d5Sidecar = JSON.parse(readFileSync(join(profileDir, "plugin-manager.json"), "utf8"));
ok(Array.isArray(d5Sidecar.history) && d5Sidecar.history.some((item) => item.action === "setSources" && typeof item.detail === "string"),
	"D5 审计记录已落进侧车 history（重启后仍可查）");

// D6：侧车读回时重新判定（明文源的 allowInsecure/authoritative 不能靠文件自报被静默继承）
const d6Reload = new PluginManagerPro(makeCtx(profileDir), { protectedEntries: [], settleTimeoutMs: 200 });
ok(d6Reload.sources.length === 1 && d6Reload.sources[0].insecure === true && d6Reload.sources[0].authoritative === true
	&& d6Reload.sources[0].allowInsecure === true && d6Reload.sources[0].official === false,
	`D6 侧车读回仍由服务端重判（authoritative=${d6Reload.sources[0]?.authoritative}, allowInsecure=${d6Reload.sources[0]?.allowInsecure}）`);
//#endregion

//#region E. A2 dist-tags.next 白名单化 + prerelease 过滤（A 报告 S3）
const eNpm = { name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, authoritative: true, type: "registry" };
const eCustom = { name: "自定义源", url: "https://custom.test", enabled: true, official: false, authoritative: false, type: "registry" };
let eMeta = {};
globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : input?.url ?? String(input);
	if (url.startsWith("https://registry.npmjs.org/")) return json({ "dist-tags": eMeta });
	if (url.startsWith("https://custom.test/")) return json({ "dist-tags": eMeta });
	return json({}, 404);
};

// E1：@deepseek-ai/* 在权威源仍优先 next（现状保留；next 允许是 prerelease）
net.resetNetworkState();
eMeta = { latest: "1.0.0", next: "2.0.0-rc.1" };
const e1 = await net.fetchLatestVersion("@deepseek-ai/foo", eNpm, { force: true });
ok(e1.version === "2.0.0-rc.1", `E1 @deepseek-ai/* 在权威源优先 next（${e1.version}）`);

// E2：普通包忽略 next，只取 latest
net.resetNetworkState();
eMeta = { latest: "1.0.0", next: "9.9.9-rc.1" };
const e2 = await net.fetchLatestVersion("foo", eNpm, { force: true });
ok(e2.version === "1.0.0", `E2 普通包忽略 next，只取 latest（${e2.version}）`);

// E3：latest 本身是 prerelease → 视为无可用版本（不得把 RC 推给用户）
net.resetNetworkState();
eMeta = { latest: "1.0.0-beta.1" };
const e3 = await net.fetchLatestVersion("foo", eNpm, { force: true });
ok(e3.version === null && e3.reason === net.REASON.NOT_FOUND,
	`E3 latest 是 prerelease → 视为无可用版本（version=${String(e3.version)}, reason=${e3.reason}）`);

// E4：自定义源即使配置了 next 也不采用
net.resetNetworkState();
eMeta = { latest: "1.0.0", next: "9.9.9" };
const e4 = await net.fetchLatestVersion("@deepseek-ai/foo", eCustom, { force: true });
ok(e4.version === "1.0.0", `E4 自定义源的 next 不采用（${e4.version}）`);
//#endregion

//#region F. A3 downloads 目录 provenance：无记录拒绝、记录+摘要匹配才安装（B 报告 S1）
const dlProfile = mkdtempSync(join(tmpdir(), "pm-dlprov-"));
const dlDir = join(dlProfile, "downloads");
mkdirSync(dlDir, { recursive: true });
writeFileSync(join(dlProfile, "package.json"), JSON.stringify({
	name: "dlprov-profile",
	private: true,
	dependencies: { "victim-plugin": "1.0.0" }
}, null, 2) + "\n", "utf8");
writeFileSync(join(dlProfile, "plugin-manager.json"), JSON.stringify({
	version: 2,
	sources: [
		{ name: "官方源 (npm)", url: "https://registry.npmjs.org", enabled: true, official: true, type: "registry" },
		{ name: "GitHub 官方仓库", url: "https://github.com/good/victim-plugin", enabled: true, official: true, type: "github" }
	],
	pendingDownloads: []
}, null, 2) + "\n", "utf8");
const dlSvc = new PluginManagerPro(makeCtx(dlProfile), { protectedEntries: [], settleTimeoutMs: 200 });
// 下载目录指向临时目录（不碰真实 $DSH_HOME/downloads）
dlSvc.downloadDir = () => dlDir;

/** 造一个 512 字节 tar 头（ustar，普通文件）。 */
function tarHeader(name, size) {
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, 100, "utf8");
	header.write("0000644", 100, 7, "ascii");
	header.write("0000000", 108, 7, "ascii");
	header.write("0000000", 116, 7, "ascii");
	header.write(size.toString(8).padStart(11, "0"), 124, 11, "ascii");
	header.write("00000000000", 136, 11, "ascii");
	header.write("        ", 148, 8, "ascii");
	header.write("0", 156, 1, "ascii");
	header.write("ustar", 257, 5, "ascii");
	header.write("00", 263, 2, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
	return header;
}
/** 最小 npm 包归档：只含 package/package.json（name/version 可自定）。 */
function makePackageTgz(name, version) {
	const body = Buffer.from(JSON.stringify({ name, version, dsh: { bundle: "./cordis.patch.yml" } }), "utf8");
	const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
	return gzipSync(Buffer.concat([tarHeader("package/package.json", body.length), body, padding, Buffer.alloc(1024, 0)]));
}

// 安装全部打桩：本测试只验证 provenance 判定，不真跑 pnpm、不真装包
let fInstallCalls = [];
dlSvc.installDownloadedArchive = async (name) => {
	fInstallCalls.push(name);
	return { ok: true, message: null, added: [] };
};

// F1：无 provenance 记录的 tgz → 拒绝 + 写 .failed（"删 .failed 即显式确认"约定不变）
fInstallCalls = [];
writeFileSync(join(dlDir, "rogue-evil-plugin.tgz"), makePackageTgz("evil-plugin", "9.9.9"));
const f1 = await dlSvc.checkDownloads();
const f1Failed = f1.failed.find((item) => item.name === "rogue-evil-plugin.tgz");
ok(fInstallCalls.length === 0 && f1Failed !== void 0 && f1Failed.message.includes("未找到来源记录") && f1Failed.message.includes(".failed"),
	`F1 无来源记录的 tgz 被拒绝，未调用安装（calls=${fInstallCalls.length}，message=${String(f1Failed?.message)?.slice(0, 50)}…）`);
ok(existsSync(join(dlDir, ".rogue-evil-plugin.tgz.failed")), "F1 拒绝时写 .failed stamp（删除它才是显式确认重试）");

// F2：updateBrowser 生成下载链接时写 sidecar.pendingDownloads（URL + name@version + 摘要）
const fAssetSha = "a".repeat(64); // 假摘要：与该包的真实 tgz 必然不一致，留给 F3 验"摘要不符拒绝"
globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : input?.url ?? String(input);
	if (url.startsWith("https://raw.githubusercontent.com/good/victim-plugin/")) return json({ name: "victim-plugin", version: "9.9.9" });
	if (url.startsWith("https://api.github.com/repos/good/victim-plugin/releases/latest")) {
		return json({
			tag_name: "v9.9.9",
			assets: [{ name: "victim-plugin-9.9.9.tgz", browser_download_url: "https://example.com/victim-plugin-9.9.9.tgz", digest: `sha256:${fAssetSha}`, size: 1234 }]
		});
	}
	if (url.startsWith("https://registry.npmjs.org/")) return json({}, 404);
	return json({}, 404);
};
net.resetNetworkState();
const f2 = await dlSvc.updateBrowser(["victim-plugin"]);
const fRec = dlSvc.sidecar.pendingDownloads.find((item) => item.packageName === "victim-plugin" && item.version === "9.9.9");
ok(f2.items.length === 1 && f2.items[0].status === "need-download" && f2.items[0].url === "https://example.com/victim-plugin-9.9.9.tgz",
	`F2 updateBrowser 生成下载链接（status=${f2.items[0]?.status}）`);
ok(fRec !== void 0 && fRec.expect?.integrity === `sha256-${fAssetSha}` && fRec.expect?.size === 1234 && fRec.sourceName === "GitHub 官方仓库",
	`F2 pendingDownloads 记录含 name/version/摘要/size（记录=${JSON.stringify(fRec?.expect)}）`);
const fSidecar = JSON.parse(readFileSync(join(dlProfile, "plugin-manager.json"), "utf8"));
ok(Array.isArray(fSidecar.pendingDownloads) && fSidecar.pendingDownloads.some((item) => item.packageName === "victim-plugin"),
	"F2 provenance 记录已落进侧车文件（重启后仍能据此判定下载来源）");

// F3：有记录但摘要不匹配 → 拒绝安装，记录保留（不重复噪音、不静默安装）
fInstallCalls = [];
writeFileSync(join(dlDir, "victim-plugin-9.9.9.tgz"), makePackageTgz("victim-plugin", "9.9.9"));
const f3 = await dlSvc.checkDownloads();
const f3Failed = f3.failed.find((item) => item.name === "victim-plugin-9.9.9.tgz");
ok(fInstallCalls.length === 0 && f3Failed !== void 0 && f3Failed.message.includes("摘要不匹配"),
	`F3 记录+摘要不匹配被拒绝（calls=${fInstallCalls.length}，message=${String(f3Failed?.message)?.slice(0, 40)}…）`);
ok(dlSvc.sidecar.pendingDownloads.some((item) => item.packageName === "victim-plugin"), "F3 摘要不符时记录保留");

// F4：记录 + 摘要一致才安装；成功后移除记录并落盘
const fGoodTgz = makePackageTgz("good-plugin", "2.0.0");
const fGoodSha = createHash("sha256").update(fGoodTgz).digest("hex");
writeFileSync(join(dlDir, "good-plugin-2.0.0.tgz"), fGoodTgz);
dlSvc.rememberPendingDownload({ url: "https://example.com/good-plugin-2.0.0.tgz", packageName: "good-plugin", version: "2.0.0", sourceName: "GitHub 官方仓库", expect: { integrity: `sha256-${fGoodSha}` } });
fInstallCalls = [];
const f4 = await dlSvc.checkDownloads();
ok(fInstallCalls.length === 1 && fInstallCalls[0] === "good-plugin-2.0.0.tgz" && f4.installed.includes("good-plugin-2.0.0.tgz"),
	`F4 记录+摘要一致才安装（install calls=${JSON.stringify(fInstallCalls)}）`);
ok(existsSync(join(dlDir, ".good-plugin-2.0.0.tgz.installed")), "F4 安装成功写 .installed stamp");
ok(!dlSvc.sidecar.pendingDownloads.some((item) => item.packageName === "good-plugin"), "F4 安装成功后移除 provenance 记录");
const fSidecar2 = JSON.parse(readFileSync(join(dlProfile, "plugin-manager.json"), "utf8"));
ok(!fSidecar2.pendingDownloads.some((item) => item.packageName === "good-plugin"), "F4 记录移除已落盘到侧车");

// F5：只有 size 不算校验（size 不是内容摘要）—— 有来源记录即安装，不宣称已校验摘要
const fSizeTgz = makePackageTgz("size-only-plugin", "1.0.0");
writeFileSync(join(dlDir, "size-only-plugin-1.0.0.tgz"), fSizeTgz);
dlSvc.rememberPendingDownload({ url: "https://example.com/size-only-plugin-1.0.0.tgz", packageName: "size-only-plugin", version: "1.0.0", sourceName: "GitHub 官方仓库", expect: { size: 1 } });
fInstallCalls = [];
const f5 = await dlSvc.checkDownloads();
ok(fInstallCalls.length === 1 && f5.installed.includes("size-only-plugin-1.0.0.tgz"),
	`F5 only-size 不作校验凭证，但来源记录仍放行（calls=${JSON.stringify(fInstallCalls)}）`);

// F6：记录里的摘要格式坏掉 → fail-closed 拒绝（不能静默降级成"无摘要"放行）
const fBadTgz = makePackageTgz("bad-digest-plugin", "1.0.0");
writeFileSync(join(dlDir, "bad-digest-plugin-1.0.0.tgz"), fBadTgz);
dlSvc.rememberPendingDownload({ url: "https://example.com/bad-digest-plugin-1.0.0.tgz", packageName: "bad-digest-plugin", version: "1.0.0", sourceName: "GitHub 官方仓库", expect: { integrity: "sha256-nothex" } });
fInstallCalls = [];
const f6 = await dlSvc.checkDownloads();
const f6Failed = f6.failed.find((item) => item.name === "bad-digest-plugin-1.0.0.tgz");
ok(fInstallCalls.length === 0 && f6Failed !== void 0 && f6Failed.message.includes("无法识别"),
	`F6 摘要格式坏掉 → fail-closed 拒绝（calls=${fInstallCalls.length}，message=${String(f6Failed?.message)?.slice(0, 30)}…）`);
//#endregion

rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
rmSync(mixDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
rmSync(dlProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
//#endregion

if (failures.length > 0) {
	console.error(`RESULT: FAIL (${failures.length} 项)\n - ` + failures.join("\n - "));
	process.exit(1);
}
console.log("RESULT: PASS — 权威层由服务端判定（伪造源/v999.0.0 不生效、显式 authoritative 可独立裁决）/ 兜底标 degraded / dshfind 已移除 / next 仅 @deepseek-ai/*+权威源且过滤 prerelease / downloads 目录仅有 provenance 记录且摘要匹配才安装");
process.exit(0);
