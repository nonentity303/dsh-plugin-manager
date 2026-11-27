#!/usr/bin/env node
/**
 * host-profile.mjs — **安装后首次启动的环境探测与画像持久化**（1.1.0 起）。
 *
 * 解决的问题：同一个包要同时服务「网页宿主 / 官方桌面宿主 / 社区桌面」，而桌面专属代码如果不区分环境装载，
 * 就会出现两类成本：① 网页用户白白承担桌面代码的副作用；② 审阅者要逐行判断"这段在网页上会不会跑"。
 *
 * 本模块只做三件事：
 *   1. **判定形态**：显式覆盖（`DSH_DRYDOCK_HOST`）优先，否则用 `lib/envprobe.mjs` 的 `probeEnv()` 实测；
 *   2. **首启落盘**：把结论 + 证据 + 能力表 id **原子写入** `<DSH_HOME>/.drydock/host-profile.json`，
 *      之后各进程读缓存即可（探测一次，不每次启动都扫盘）；
 *   3. **给出可审计的事实**：谁判定、凭什么、什么时候、是否覆盖。
 *
 * 边界（写清，避免"看起来像做了更多"）：
 *   - **只写自己的 sidecar**：不写 profile 的 `package.json` / `state.json` / `node_modules`，不碰桌面锁。
 *   - 缓存损坏 / schema 变更 / `--refresh` → 重新探测并覆盖（自愈，不静默沿用坏数据）。
 *   - `unknown` 形态**不启用任何桌面专属行为**；能力表按网页版回落（与 `lib/capabilities.mjs` 同口径）。
 *
 * 全部外部依赖可注入（`env` / `fsx` / `homeDir` / `platform` / `now`），因此 `test-host-strip.mjs` 能离线断言。
 */
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import * as nodeFs from "node:fs";
import { probeEnv } from "./envprobe.mjs";

/** 画像 sidecar 的 schema 版本；不兼容时直接重探测（不做迁移代码，避免历史包体堆积）。 */
export const HOST_PROFILE_SCHEMA = 1;
/** 允许的形态。`unknown` = 判定不出（宁可少开能力，也不误开桌面专属行为）。 */
export const HOST_FORMS = Object.freeze(["web", "desktop", "unknown"]);
/** 显式覆盖的环境变量名（运维/测试用；非法值会被忽略并记进证据）。 */
export const HOST_OVERRIDE_ENV = "DSH_DRYDOCK_HOST";
/** 缓存有效期（毫秒）：超过则下次启动重探测一次。默认 30 天（形态不会天天变，但换机器/换安装方式要能跟上）。 */
export const HOST_PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** 归一化 fs 依赖（注入的 fs 只提供需要的四个函数即可）。 */
function resolveFsx(fsx) {
	if (isPlainObject(fsx)) {
		return {
			readFileSync: typeof fsx.readFileSync === "function" ? fsx.readFileSync.bind(fsx) : null,
			existsSync: typeof fsx.existsSync === "function" ? fsx.existsSync.bind(fsx) : nodeFs.existsSync,
			mkdirSync: typeof fsx.mkdirSync === "function" ? fsx.mkdirSync.bind(fsx) : nodeFs.mkdirSync,
			renameSync: typeof fsx.renameSync === "function" ? fsx.renameSync.bind(fsx) : nodeFs.renameSync,
			writeFileSync: typeof fsx.writeFileSync === "function" ? fsx.writeFileSync.bind(fsx) : nodeFs.writeFileSync,
			rmSync: typeof fsx.rmSync === "function" ? fsx.rmSync.bind(fsx) : nodeFs.rmSync
		};
	}
	return {
		readFileSync: nodeFs.readFileSync,
		existsSync: nodeFs.existsSync,
		mkdirSync: nodeFs.mkdirSync,
		renameSync: nodeFs.renameSync,
		writeFileSync: nodeFs.writeFileSync,
		rmSync: nodeFs.rmSync
	};
}

/** `DSH_HOME` 的解析口径：显式 env > `~/.dsh`（空白视为未设置）。 */
export function resolveDshHome({ env = process.env, homeDir = null } = {}) {
	const raw = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
	if (raw !== "") return raw;
	const home = typeof homeDir === "string" && homeDir.trim() !== "" ? homeDir.trim() : homedir();
	return join(home, ".dsh");
}

/** 画像文件路径：`<DSH_HOME>/.drydock/host-profile.json`（机器级，不是 profile 级）。 */
export function hostProfilePath(dshHome) {
	return join(dshHome, ".drydock", "host-profile.json");
}

/**
 * 判定宿主形态。优先级：显式覆盖 > probeEnv 实测 > `web` 兜底。
 * @returns {{form: "web"|"desktop"|"unknown", source: "override"|"probe", confidence: number, reason: string, evidence: object[], probe: object|null}}
 */
export function resolveHostForm({ env = process.env, fsx = null, homeDir = null, platform = process.platform, probe = probeEnv } = {}) {
	const f = resolveFsx(fsx);
	const rawOverride = typeof env?.[HOST_OVERRIDE_ENV] === "string" ? env[HOST_OVERRIDE_ENV].trim().toLowerCase() : "";
	const overrideNote =
		rawOverride === ""
			? null
			: HOST_FORMS.includes(rawOverride)
				? { signal: HOST_OVERRIDE_ENV, matched: true, message: `显式覆盖：按 ${rawOverride} 处理（不实测）` }
				: { signal: HOST_OVERRIDE_ENV, matched: false, message: `覆盖值「${rawOverride}」不合法（只认 ${HOST_FORMS.join(" / ")}），已忽略并改走实测` };

	if (overrideNote?.matched) {
		return {
			form: rawOverride,
			source: "override",
			confidence: 1,
			reason: overrideNote.message,
			evidence: [overrideNote],
			probe: null
		};
	}

	let result = null;
	try {
		result = probe({ env, fsx: f, homeDir, platform });
	} catch (error) {
		// 探测本身失败也要给出可读结论：按 web 处理（能力表最保守的那套是 web；桌面专属能力默认不开）。
		return {
			form: "web",
			source: "probe",
			confidence: 0,
			reason: `环境探测抛错，已按 web 兜底：${error instanceof Error ? error.message : String(error)}`,
			evidence: overrideNote ? [overrideNote] : [],
			probe: null
		};
	}

	const kind = typeof result?.kind === "string" && HOST_FORMS.includes(result.kind) ? result.kind : "web";
	const evidence = [];
	if (overrideNote) evidence.push(overrideNote);
	if (typeof result?.reason === "string" && result.reason !== "") evidence.push({ signal: "probeEnv", matched: true, message: result.reason });
	return {
		form: kind,
		source: "probe",
		confidence: typeof result?.confidence === "number" ? result.confidence : 0,
		reason: typeof result?.reason === "string" && result.reason !== "" ? result.reason : "探测未给出理由",
		evidence,
		probe: isPlainObject(result) ? result : null
	};
}

/** 读缓存；不存在 / 损坏 / schema 不符 → `null`（调用方据此重探测，绝不沿用坏数据）。 */
export function readHostProfile({ dshHome, fsx = null } = {}) {
	if (typeof dshHome !== "string" || dshHome === "") return null;
	const f = resolveFsx(fsx);
	const file = hostProfilePath(dshHome);
	try {
		if (!f.existsSync(file)) return null;
		const parsed = JSON.parse(String(f.readFileSync(file, "utf8")));
		if (!isPlainObject(parsed)) return null;
		if (parsed.schema !== HOST_PROFILE_SCHEMA) return null;
		if (!HOST_FORMS.includes(parsed.form)) return null;
		if (typeof parsed.profiledAt !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

/** 原子写（tmp + rename）；失败返回 `{ ok: false, error }`，不抛 —— 画像写不进去也不该拖垮启动。 */
export function writeHostProfile(profile, { dshHome, fsx = null } = {}) {
	const f = resolveFsx(fsx);
	const home = typeof dshHome === "string" && dshHome !== "" ? dshHome : profile?.dshHome;
	if (typeof home !== "string" || home === "") return { ok: false, error: "缺少 dshHome" };
	const file = hostProfilePath(home);
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		f.mkdirSync(dirname(file), { recursive: true });
		f.writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
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

/**
 * 首启探测入口（幂等）：有新鲜缓存就复用，否则探测 + 落盘。
 * @returns {{profile: object, firstLaunch: boolean, source: "cache"|"probe"|"override", write: object, expired: boolean}}
 */
export function ensureHostProfile({
	env = process.env,
	fsx = null,
	homeDir = null,
	platform = process.platform,
	dshHome = null,
	force = false,
	now = () => new Date(),
	probe = probeEnv
} = {}) {
	const f = resolveFsx(fsx);
	const home = typeof dshHome === "string" && dshHome !== "" ? dshHome : resolveDshHome({ env, homeDir });
	const cached = readHostProfile({ dshHome: home, fsx: f });
	const nowDate = now();
	const nowIso = nowDate.toISOString();
	const age = cached === null ? null : nowDate.getTime() - Date.parse(cached.profiledAt);
	const expired = age !== null && Number.isFinite(age) && age > HOST_PROFILE_TTL_MS;

	if (!force && cached !== null && !expired) {
		return { profile: cached, firstLaunch: false, source: "cache", write: { ok: true, file: hostProfilePath(home) }, expired: false };
	}

	const resolved = resolveHostForm({ env, fsx: f, homeDir, platform, probe });
	// 探测若给出了权威 dshHome（`envprobe.detectHomeCandidates` 的口径，桌面版可能不是 `~/.dsh`），以它为准。
	const probedHome = typeof resolved.probe?.dshHome === "string" && resolved.probe.dshHome !== "" ? resolved.probe.dshHome : null;
	const finalHome = probedHome ?? home;
	const profile = {
		schema: HOST_PROFILE_SCHEMA,
		form: resolved.form,
		source: resolved.source,
		confidence: resolved.confidence,
		reason: resolved.reason,
		evidence: resolved.evidence,
		dshHome: finalHome,
		platform,
		profiledAt: nowIso,
		firstLaunchAt: cached?.firstLaunchAt ?? nowIso,
		previousForm: cached?.form ?? null
	};
	const write = writeHostProfile(profile, { dshHome: finalHome, fsx: f });
	return {
		profile,
		firstLaunch: cached === null,
		source: resolved.source === "override" ? "override" : "probe",
		write,
		expired
	};
}
