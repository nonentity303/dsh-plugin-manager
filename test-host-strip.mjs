#!/usr/bin/env node
/**
 * test-host-strip.mjs — 首启环境探测 + 环境专属模块剥离的契约测试（离线、零网络）。
 *
 * 断言什么（每条都能对应到"死代码审查"的一个疑问）：
 *   ① 形态判定的优先级与边界：显式覆盖 > 实测；未初始化的 desktop 目录 → unknown（不误开桌面行为）；
 *   ② 首启只探测一次并落盘：第二次读缓存、字节不变；`--refresh`/缓存损坏/schema 不符会自愈重探测；
 *   ③ 剥离是真剥离：`loadModules('desktop')` 对 `rescue-profile` **一次都不 import**（loader 计数为 0）；
 *   ④ 装载失败不拖垮整体：注入抛错的 loader，只会进 `failed`；
 *   ⑤ 审计清单可量化：被剥离文件的行数、总行数、文件缺失时只记 `missing` 不抛；
 *   ⑥ 形态未知按网页表回落（与 capabilitiesFor 同口径），绝不因为"可能不是桌面"就开桌面专属行为。
 *
 * 用法：node test-host-strip.mjs
 * 退出码：0 = 全绿；1 = 有 FAIL。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HOST_PROFILE_SCHEMA,
	HOST_PROFILE_TTL_MS,
	ensureHostProfile,
	hostProfilePath,
	readHostProfile,
	resolveHostForm
} from "./lib/host-profile.mjs";
import { ENV_MODULES, auditModules, loadModules, modulePath, planModules } from "./lib/host-registry.mjs";

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
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
	}
}

// ── 夹具：一个临时 DSH_HOME ────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), "drydock-host-strip-"));
const DSH_HOME = join(TMP, ".dsh");
const BASE = { env: { DSH_HOME }, homeDir: TMP, platform: "win32" };
const cleanup = () => {
	try {
		rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* 清理失败不影响结论 */
	}
};
process.on("exit", cleanup);

const desktopDir = join(DSH_HOME, "profiles", "desktop");

// ── ① 形态判定 ────────────────────────────────────────────
await verify("空环境判定为 web（无 electron / 无桌面 profile）", () => {
	const r = resolveHostForm(BASE);
	eq(r.form, "web", "form");
	eq(r.source, "probe", "source");
	return r.reason.slice(0, 40);
});

await verify("只有未初始化的 desktop 目录 → unknown（不误开桌面专属行为）", () => {
	mkdirSync(desktopDir, { recursive: true });
	const r = resolveHostForm(BASE);
	eq(r.form, "unknown", "form");
	return `confidence=${r.confidence}`;
});

await verify("desktop 目录已初始化（package.json + lock）→ desktop", () => {
	writeFileSync(join(desktopDir, "package.json"), '{"name":"desktop"}\n');
	writeFileSync(join(desktopDir, "lock"), "{}\n");
	const r = resolveHostForm(BASE);
	eq(r.form, "desktop", "form");
	return `confidence=${r.confidence}`;
});

await verify("显式覆盖 DSH_DRYDOCK_HOST 优先于实测", () => {
	const r = resolveHostForm({ ...BASE, env: { DSH_HOME, DSH_DRYDOCK_HOST: "web" } });
	eq(r.form, "web", "form");
	eq(r.source, "override", "source");
	eq(r.confidence, 1, "confidence");
	return "override 生效";
});

await verify("非法覆盖值被忽略并留下证据（不静默生效）", () => {
	const r = resolveHostForm({ ...BASE, env: { DSH_HOME, DSH_DRYDOCK_HOST: "foo" } });
	eq(r.form, "desktop", "form 仍按实测");
	const note = r.evidence.find((e) => e.signal === "DSH_DRYDOCK_HOST");
	if (!note || note.matched !== false) throw new Error("没有留下「覆盖值不合法」的证据");
	return note.message.slice(0, 40);
});

// ── ② 首启落盘与缓存自愈 ──────────────────────────────────
await verify("首启探测并落盘（firstLaunch=true，profile 文件可用）", () => {
	const r = ensureHostProfile({ ...BASE, dshHome: DSH_HOME });
	eq(r.firstLaunch, true, "firstLaunch");
	eq(r.profile.form, "desktop", "form");
	eq(r.profile.schema, HOST_PROFILE_SCHEMA, "schema");
	eq(r.write.ok, true, "write.ok");
	const onDisk = JSON.parse(readFileSync(hostProfilePath(DSH_HOME), "utf8"));
	eq(onDisk.form, "desktop", "磁盘上的 form");
	return hostProfilePath(DSH_HOME);
});

await verify("第二次启动读缓存（firstLaunch=false，文件字节不变）", () => {
	const before = readFileSync(hostProfilePath(DSH_HOME), "utf8");
	const r = ensureHostProfile({ ...BASE, dshHome: DSH_HOME });
	eq(r.firstLaunch, false, "firstLaunch");
	eq(r.source, "cache", "source");
	const after = readFileSync(hostProfilePath(DSH_HOME), "utf8");
	if (before !== after) throw new Error("缓存命中时不应重写画像文件");
	return "缓存命中";
});

await verify("--refresh（force）重新探测并更新 profiledAt", () => {
	const before = readHostProfile({ dshHome: DSH_HOME });
	const r = ensureHostProfile({ ...BASE, dshHome: DSH_HOME, force: true });
	eq(r.firstLaunch, false, "firstLaunch（不是首次）");
	if (r.profile.profiledAt === before.profiledAt) throw new Error("force 后 profiledAt 应更新");
	if (r.profile.firstLaunchAt !== before.firstLaunchAt) throw new Error("firstLaunchAt 应保持首次时间");
	return r.profile.profiledAt;
});

await verify("缓存损坏 → 自愈重探测（不沿用坏数据）", () => {
	writeFileSync(hostProfilePath(DSH_HOME), "{ 这不是 JSON");
	if (readHostProfile({ dshHome: DSH_HOME }) !== null) throw new Error("损坏的缓存不应被接受");
	const r = ensureHostProfile({ ...BASE, dshHome: DSH_HOME });
	eq(r.firstLaunch, true, "firstLaunch（缓存无效视为首启）");
	eq(r.profile.form, "desktop", "form");
	return "已重写";
});

await verify("schema 版本不符 → 重探测（不做迁移，避免历史包体堆积）", () => {
	writeFileSync(hostProfilePath(DSH_HOME), JSON.stringify({ schema: 999, form: "web", profiledAt: new Date().toISOString() }));
	if (readHostProfile({ dshHome: DSH_HOME }) !== null) throw new Error("schema 不符的缓存不应被接受");
	const r = ensureHostProfile({ ...BASE, dshHome: DSH_HOME });
	eq(r.profile.schema, HOST_PROFILE_SCHEMA, "schema");
	return "已重写";
});

await verify("到期（超过 TTL）会重探测", () => {
	const stale = { ...readHostProfile({ dshHome: DSH_HOME }) };
	stale.profiledAt = new Date(Date.now() - HOST_PROFILE_TTL_MS - 60_000).toISOString();
	writeFileSync(hostProfilePath(DSH_HOME), JSON.stringify(stale));
	const r = ensureHostProfile({ ...BASE, dshHome: DSH_HOME });
	eq(r.expired, true, "expired");
	return "TTL 生效";
});

// ── ③ 剥离 = 连 import 都不发生 ────────────────────────────
await verify("planModules：web 装载 rescue-profile，desktop 剥离它", () => {
	const web = planModules("web");
	const desktop = planModules("desktop");
	if (!web.loadable.some((m) => m.id === "rescue-profile")) throw new Error("web 形态应装载 rescue-profile");
	if (desktop.loadable.some((m) => m.id === "rescue-profile")) throw new Error("desktop 形态不应装载 rescue-profile");
	const hit = desktop.stripped.find((m) => m.id === "rescue-profile");
	if (!hit) throw new Error("desktop 形态应把 rescue-profile 记进剥离清单");
	if (!/delegated|托管/.test(hit.reason)) throw new Error(`剥离理由应来自能力表，实际：${hit.reason}`);
	return hit.reason.slice(0, 30);
});

await verify("desktop 形态下 loadModules **一次都不 import** 被剥离模块", async () => {
	const calls = [];
	const spy = async (path) => {
		calls.push(path);
		return {};
	};
	const r = await loadModules("desktop", { load: spy });
	const rescuePath = modulePath("./rescue-profile.mjs");
	if (calls.includes(rescuePath)) throw new Error("被剥离的 rescue-profile 竟然被 import 了");
	if (!r.loaded.includes("diagnostics")) throw new Error("diagnostics 应装载");
	return `装载 ${r.loaded.length} 个，rescue 调用 0 次`;
});

await verify("web 形态下 loadModules 会 import rescue-profile（对照）", async () => {
	const calls = [];
	const spy = async (path) => {
		calls.push(path);
		return {};
	};
	const r = await loadModules("web", { load: spy });
	if (!calls.includes(modulePath("./rescue-profile.mjs"))) throw new Error("web 形态应 import rescue-profile");
	eq(r.loaded.includes("rescue-profile"), true, "loaded 含 rescue-profile");
	return `装载 ${r.loaded.length} 个`;
});

await verify("装载失败不拖垮整体（进 failed，其余继续）", async () => {
	const spy = async (path) => {
		if (path.endsWith("diagnostics.mjs")) throw new Error("模拟装载失败");
		return {};
	};
	const r = await loadModules("desktop", { load: spy });
	if (r.failed.length !== 1 || r.failed[0].id !== "diagnostics") throw new Error(`failed 记录不对：${JSON.stringify(r.failed)}`);
	if (!r.loaded.includes("bundles-official")) throw new Error("其他模块应继续装载");
	return r.failed[0].error;
});

// ── ④ 审计清单 ────────────────────────────────────────────
await verify("auditModules：剥离清单带文件路径与行数（死代码审查输入）", () => {
	const audit = auditModules("desktop");
	const hit = audit.stripped.find((m) => m.id === "rescue-profile");
	if (!hit) throw new Error("剥离清单缺 rescue-profile");
	if (!(typeof hit.lines === "number" && hit.lines > 0)) throw new Error(`行数应为正数，实际 ${hit.lines}`);
	if (!(audit.totalStrippedLines >= hit.lines)) throw new Error("合计行数应 ≥ 单文件行数");
	return `剥离 ${audit.totalStrippedLines} 行 / 装载 ${audit.totalLoadableLines} 行`;
});

await verify("auditModules：文件读不到只记 missing，不抛", () => {
	const audit = auditModules("desktop", {
		readFile: () => {
			throw new Error("ENOENT: 模拟文件缺失");
		}
	});
	eq(audit.stripped.every((m) => m.missing === true), true, "missing 标记");
	return "缺失不抛";
});

await verify("未知形态按网页表回落（capabilitiesFor 同口径）", () => {
	const plan = planModules("unknown");
	eq(plan.table.id, "web", "回落的能力表");
	if (!plan.loadable.some((m) => m.id === "rescue-profile")) throw new Error("unknown 应按 web 表装载 rescue-profile");
	return "unknown → web 表";
});

await verify("登记表里的文件都真实存在（防「登记了不存在的模块」）", () => {
	const missing = ENV_MODULES.filter((m) => {
		try {
			readFileSync(modulePath(m.file), "utf8");
			return false;
		} catch {
			return true;
		}
	});
	if (missing.length > 0) throw new Error(`登记表指向不存在的文件：${missing.map((m) => m.file).join(", ")}`);
	return `${ENV_MODULES.length} 个模块都在位`;
});

// ── 汇总 ──────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`[${r.ok ? "OK  " : "FAIL"}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
if (failed.length > 0) {
	console.error(`\n${failed.length} 项失败`);
	process.exit(1);
}
console.log(`\nALL HOST-STRIP TESTS PASSED (${results.length} checks)`);
