#!/usr/bin/env node
/**
 * boot-snapshot.mjs — **启动配置快照 + 启动前差异告警**（对齐 `docs/review/DESIGN_1.0.5_启动配置差异感知.md`）。
 *
 * 要解决的实测案例（2026-11-27）：3080 / 3081 共用 `~/.dsh/profiles/web` 一个 profile。
 * 用户在 3081 兜底页禁用 wallpaper（= 从 `dsh.profile.bundles` 摘掉）后，open-boot supervisor
 * 恰好自动重启了 3080 —— 禁用态被这次启动固化，3080 起来就"插件没了"；再次启用又必须重启才回来。
 * 三个事实叠加：**共用 profile** + **引擎只在启动时读配置**（dsh 引擎无 fs.watch）+ **没有任何变更提示**。
 *
 * 本模块只做"记忆 + 比对 + 定性"，不做引擎热加载（那是引擎侧的事）：
 *   - 记忆：引擎**成功启动后**把当时的 `bundles / deps / patch 行数` 按 **engine 键（端口）** 原子写进
 *     `<profile>/.plugin-manager/boot-snapshot.json`（必须分键：共用 profile 时互相覆盖会让 diff 全是噪音）；
 *   - 比对：下次拉起引擎**之前**算 `added / removed / version-changed / patch-changed`；
 *   - 定性：拿既有的 `plugin-manager.json` 的 `history` 交叉核对 —— 有记录 = 用户经管理台改的
 *     （如实说"上次管理台操作后未重启，本次启动已按该状态加载"）；无记录 = 绕过管理台的变更
 *     （"请确认来源"，这才是供应链安全真正要抓的信号）。
 *
 * 硬约束（沿用本包一贯原则）：
 *   - **快照自身的问题永不拦启动**：读不到/写一半/schema 不符 → 当"无快照"，只写不比；
 *   - 零新依赖、纯文件 sidecar、原子写（tmp + rename）；
 *   - 全部依赖可注入（fsx / now），便于离线测试。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BOOT_SNAPSHOT_SCHEMA = 1;
export const BOOT_SNAPSHOT_DIR = ".plugin-manager";
export const BOOT_SNAPSHOT_NAME = "boot-snapshot.json";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nowIso = (now) => new Date(typeof now === "function" ? now() : Date.now()).toISOString();

function resolveFsx(fsx) {
	if (isPlainObject(fsx)) {
		const pick = (k, fallback) => (typeof fsx[k] === "function" ? fsx[k].bind(fsx) : fallback);
		return {
			existsSync: pick("existsSync", existsSync),
			readFileSync: pick("readFileSync", readFileSync),
			mkdirSync: pick("mkdirSync", mkdirSync),
			writeFileSync: pick("writeFileSync", writeFileSync),
			renameSync: pick("renameSync", renameSync),
			rmSync: pick("rmSync", rmSync)
		};
	}
	return { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync };
}

export function bootSnapshotPath(profileDir) {
	return join(profileDir, BOOT_SNAPSHOT_DIR, BOOT_SNAPSHOT_NAME);
}

/** 读快照：不存在 / 坏 JSON / schema 不符 → `null`（调用方当"无快照"处理，绝不因此拦启动）。 */
export function readBootSnapshot({ profileDir, fsx = null } = {}) {
	const f = resolveFsx(fsx);
	if (typeof profileDir !== "string" || profileDir === "") return null;
	try {
		const file = bootSnapshotPath(profileDir);
		if (!f.existsSync(file)) return null;
		const parsed = JSON.parse(String(f.readFileSync(file, "utf8")));
		if (!isPlainObject(parsed) || parsed.schema !== BOOT_SNAPSHOT_SCHEMA) return null;
		if (!isPlainObject(parsed.engines)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** 原子写快照；失败返回 `{ok:false}`（不抛：旁路记录不该拖垮启动流程）。 */
export function writeBootSnapshot(snapshot, { profileDir, fsx = null } = {}) {
	const f = resolveFsx(fsx);
	if (typeof profileDir !== "string" || profileDir === "") return { ok: false, error: "缺少 profileDir" };
	const file = bootSnapshotPath(profileDir);
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		f.mkdirSync(dirname(file), { recursive: true });
		f.writeFileSync(tmp, `${JSON.stringify({ schema: BOOT_SNAPSHOT_SCHEMA, ...snapshot }, null, 2)}\n`, "utf8");
		f.renameSync(tmp, file);
		return { ok: true, file };
	} catch (error) {
		try {
			f.rmSync(tmp, { force: true });
		} catch {
			/* 清理失败不影响主结论 */
		}
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** 从 profile 清单 + patch 行数捕获一份引擎状态（纯函数）。 */
export function captureEngineState({ manifest, patchRows = null, port, pid = null, now = Date.now } = {}) {
	const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? [...manifest.dsh.profile.bundles].sort() : [];
	const deps = {};
	for (const [name, spec] of Object.entries(manifest?.dependencies ?? {})) {
		deps[name] = typeof spec === "string" ? spec : String(spec ?? "");
	}
	return {
		at: nowIso(now),
		pid: Number.isInteger(pid) ? pid : null,
		port: typeof port === "string" || typeof port === "number" ? String(port) : null,
		bundles,
		deps,
		patchRows: Number.isInteger(patchRows) ? patchRows : null
	};
}

/**
 * 比较"上次成功启动的状态"与"这次要启动的状态"（纯函数）。
 * @returns {{empty: boolean, added: string[], removed: string[], versionChanged: Array<{name: string, from: string, to: string}>, patchChanged: {from: number|null, to: number|null}|null, summary: string}}
 */
export function diffEngineState(previous, current) {
	if (!isPlainObject(previous) || !isPlainObject(current)) {
		return { empty: true, added: [], removed: [], versionChanged: [], patchChanged: null, summary: "无上次启动快照：只记录、不比对" };
	}
	const prevBundles = new Set(Array.isArray(previous.bundles) ? previous.bundles : []);
	const curBundles = new Set(Array.isArray(current.bundles) ? current.bundles : []);
	const added = [...curBundles].filter((name) => !prevBundles.has(name)).sort();
	const removed = [...prevBundles].filter((name) => !curBundles.has(name)).sort();
	const versionChanged = [];
	const prevDeps = isPlainObject(previous.deps) ? previous.deps : {};
	const curDeps = isPlainObject(current.deps) ? current.deps : {};
	// 已经在 added/removed 里报过的名字不再重复报一次"版本从 X 变成 null" —— 那只是同一件事的噪音。
	const alreadyReported = new Set([...added, ...removed]);
	for (const name of [...new Set([...Object.keys(prevDeps), ...Object.keys(curDeps)])].sort()) {
		if (alreadyReported.has(name)) continue;
		if (prevDeps[name] !== curDeps[name]) versionChanged.push({ name, from: prevDeps[name] ?? null, to: curDeps[name] ?? null });
	}
	const patchChanged =
		Number.isInteger(previous.patchRows) && Number.isInteger(current.patchRows) && previous.patchRows !== current.patchRows
			? { from: previous.patchRows, to: current.patchRows }
			: null;
	const parts = [];
	if (added.length > 0) parts.push(`新增 ${added.length} 个（${added.join(", ")}）`);
	if (removed.length > 0) parts.push(`少了 ${removed.length} 个（${removed.join(", ")}）`);
	if (versionChanged.length > 0) parts.push(`版本变了 ${versionChanged.length} 个（${versionChanged.map((v) => `${v.name}: ${v.from ?? "?"} → ${v.to ?? "?"}`).join("; ")}）`);
	if (patchChanged !== null) parts.push(`patch 顶层行数 ${patchChanged.from} → ${patchChanged.to}`);
	return {
		empty: parts.length === 0,
		added,
		removed,
		versionChanged,
		patchChanged,
		summary: parts.length === 0 ? "与上次成功启动相比，配置没有变化" : parts.join("；")
	};
}

/**
 * 用既有 history 给差异**定性**（只做定性、不当数据源：`dsh plugin add` / 手跑 pnpm / 手改 package.json 都不进 history）。
 * @returns {{matched: Array<{name: string, action: string|null, at: string|null}>, unmatched: string[], tone: "user-action"|"unmanaged"|"clean", text: string}}
 */
export function classifyDiff(diff, history = []) {
	const names = [...new Set([...(diff?.added ?? []), ...(diff?.removed ?? []), ...(diff?.versionChanged ?? []).map((v) => v.name)])];
	if (names.length === 0) return { matched: [], unmatched: [], tone: "clean", text: diff?.summary ?? "配置没有变化" };
	const records = Array.isArray(history) ? history : [];
	// 既有 sidecar 的 history 形状是 `{id, at, action, label, detail, result, undone, undo}` —— **没有 packageNames 字段**，
	// 包名只出现在 label / detail / undo 里，所以按"文本里出现该包名"匹配（宁可比粗，不要比漏）。
	const haystackOf = (record) => {
		const parts = [record?.label, record?.detail, record?.packageName, Array.isArray(record?.packageNames) ? record.packageNames.join(" ") : null];
		let undoText = "";
		try {
			undoText = record?.undo === void 0 ? "" : JSON.stringify(record.undo);
		} catch {
			undoText = "";
		}
		return `${parts.filter((part) => typeof part === "string").join(" ")} ${undoText}`;
	};
	const matched = [];
	const unmatched = [];
	for (const name of names) {
		const hit = records.find((record) => haystackOf(record).includes(name));
		if (hit === void 0) unmatched.push(name);
		else matched.push({ name, action: hit.action ?? hit.kind ?? null, at: typeof hit.at === "string" ? hit.at : null });
	}
	const tone = matched.length > 0 ? "user-action" : "unmanaged";
	const text =
		tone === "user-action"
			? `上次管理台操作过 ${matched.map((m) => m.name).join(", ")}，但之后没重启过引擎：本次启动已按当前状态加载。`
			: `配置变更未经过插件管理器（可能是 dsh CLI / 手工编辑 / 其他工具）：请确认来源 —— ${unmatched.join(", ")}。`;
	return { matched, unmatched, tone, text };
}

/** 把某端口的最新状态写进快照（保留其它引擎的键 + 记录最近一次 diff 供页面展示）。 */
export function updateEngineSnapshot(snapshot, { port, state, diff = null, now = Date.now } = {}) {
	const key = String(port ?? state?.port ?? "");
	if (key === "") return { schema: BOOT_SNAPSHOT_SCHEMA, engines: {} };
	const base = isPlainObject(snapshot?.engines) ? { ...snapshot.engines } : {};
	base[key] = {
		...(isPlainObject(base[key]) ? base[key] : {}),
		...state,
		port: key
	};
	return {
		schema: BOOT_SNAPSHOT_SCHEMA,
		engines: base,
		lastDiff: diff === null ? snapshot?.lastDiff ?? null : { at: nowIso(now), port: key, ...diff },
		updatedAt: nowIso(now)
	};
}

/** 引擎身份键：端口优先（supervisor / rescue-daemon 都已知自己的端口）。 */
export function engineKeyOf(port) {
	return port === null || port === void 0 || port === "" ? "" : String(port);
}
