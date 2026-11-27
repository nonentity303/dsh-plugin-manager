#!/usr/bin/env node
/**
 * self-update.mjs — **drydock 自己的更新流程**（1.1.0-desktop.1 起）。
 *
 * 目标（用户口径）：从**权威源**（或用户显式选择的本地 tgz）拿到**合法**包之后，自己完成升级与重启，
 * 重启前用「现在 / 稍后」提示让人做主 —— 而不是让人去翻 npm / 手动敲 pnpm。
 *
 * 合法性怎么算（fail-closed，任何一条不满足就拒绝，不下载、不落盘、不改 profile）：
 *   1. **权威源**：只认 `https://registry.npmjs.org` 的 packument；`dist-tags` 决定"该通道的当前版本"
 *      （web → `latest`、desktop → `desktop`；未知形态按 web 处理，宁可少更新也不擅自升桌面通道）。
 *   2. **名字要对**：packument 的 `name` 必须等于本包名（防同名镜像/拼写劫持）。
 *   3. **版本要新**：必须严格高于当前版本；降级需显式 `allowDowngrade`（回滚走单独路径，不走更新）。
 *   4. **摘要必须给且必须对上**：用 npm 的 `dist.integrity`（SRI，sha512 优先）作为期望摘要，
 *      下载时逐字节校验（复用 `lib/downloader.js` 的三道门禁：明文 http 拒 / 无摘要拒 / 不匹配删文件）。
 *   5. **tarball 必须 https**：http 一律拒（含 https→http 降级）。
 *   6. **本地 tgz**：没有权威源可对照 → 必须由人**显式**指定（`--accept-local <文件>`），
 *      落盘时记录 sha512 + `source: "local-file"`，并在提示里明写"未经权威源比对"。
 *
 * 谁能真正装：只有 **web 形态**（`engineLifecycle === "own"`）。桌面形态的 profile 由 Electron 独占
 * （官方 CLI 对 `profile "desktop"` 直接报错），所以桌面形态**只提示、不自动装**，把选择权交给人。
 *
 * 状态文件：`<DSH_HOME>/.drydock/self-update.json`（原子写；坏数据自愈为"无待处理更新"，绝不沿用半截状态）。
 *
 * 全部外部依赖可注入（`getJson` / `download` / `run` / `fsx` / `now` / `spawn`），所以 `test-self-update.mjs`
 * 能在无网络、无 pnpm、无真实进程的情况下跑完整个状态机。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import https from "node:https";
import { compareVersions } from "./compare-versions.js";
import { downloadUrl } from "./downloader.js";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const SELF_UPDATE_SCHEMA = 1;
/** 形态 → 该形态该跟的 dist-tag。未知形态按 web（`latest`）处理：宁可少更新，也不擅自升桌面通道。 */
export const DIST_TAG_BY_FORM = Object.freeze({ web: "latest", desktop: "desktop", unknown: "latest" });
/** 更新阶段（状态机）。`running` 是不可中断的中间态：worker 崩了会被 `--status` 判成 failed 并给回滚建议。 */
export const PHASES = Object.freeze(["pending", "running", "applied", "failed", "cancelled"]);

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

/** 该形态该跟哪个 dist-tag。 */
export function distTagForForm(form) {
	return DIST_TAG_BY_FORM[form] ?? DIST_TAG_BY_FORM.unknown;
}

/** 该形态能否"自己装 + 自己重启"。桌面形态的 profile 由 Electron 独占 → 只能提示。 */
export function canSelfApply(form) {
	return form === "web";
}

/** 状态文件路径（机器级：一份安装就是一个待处理更新）。 */
export function statePath(dshHome) {
	return join(dshHome, ".drydock", "self-update.json");
}

/** 待处理更新的暂存目录（tgz 落这儿，升级装的就是它）。 */
export function stagingDir(dshHome) {
	return join(dshHome, ".drydock", "self-update");
}

/** 读状态；不存在 / 坏 JSON / schema 不符 → `null`（自愈，不沿用半截状态）。 */
export function readState({ dshHome, fsx = null } = {}) {
	const f = resolveFsx(fsx);
	if (typeof dshHome !== "string" || dshHome === "") return null;
	const file = statePath(dshHome);
	try {
		if (!f.existsSync(file)) return null;
		const parsed = JSON.parse(String(f.readFileSync(file, "utf8")));
		if (!isPlainObject(parsed) || parsed.schema !== SELF_UPDATE_SCHEMA) return null;
		if (typeof parsed.targetVersion !== "string" || !PHASES.includes(parsed.phase)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** 原子写状态；失败返回 `{ok:false,error}`，不抛（更新状态写不进去也不该把流程炸掉）。 */
export function writeState(state, { dshHome, fsx = null } = {}) {
	const f = resolveFsx(fsx);
	if (typeof dshHome !== "string" || dshHome === "") return { ok: false, error: "缺少 dshHome" };
	const file = statePath(dshHome);
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		f.mkdirSync(dirname(file), { recursive: true });
		f.writeFileSync(tmp, `${JSON.stringify({ ...state, schema: SELF_UPDATE_SCHEMA }, null, 2)}\n`, "utf8");
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

export function clearState({ dshHome, fsx = null } = {}) {
	const f = resolveFsx(fsx);
	try {
		f.rmSync(statePath(dshHome), { force: true });
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** 解析 `DSH_HOME`（显式 env > `~/.dsh`）。 */
export function resolveDshHome({ env = process.env, homeDir = null } = {}) {
	const raw = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
	if (raw !== "") return raw;
	const home = typeof homeDir === "string" && homeDir.trim() !== "" ? homeDir.trim() : homedir();
	return join(home, ".dsh");
}

/** 极简 HTTPS GET JSON（可注入替换；不跟随到 http、超时后失败）。 */
export function httpsGetJson(url, { timeoutMs = 8000 } = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		if (!/^https:\/\//i.test(url)) {
			rejectPromise(new Error(`拒绝非 https 请求：${url}`));
			return;
		}
		const req = https.get(url, { headers: { accept: "application/json" } }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				rejectPromise(new Error(`HTTP ${res.statusCode}：${url}`));
				return;
			}
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				try {
					resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch (error) {
					rejectPromise(new Error(`返回不是合法 JSON：${error instanceof Error ? error.message : String(error)}`));
				}
			});
		});
		req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${timeoutMs}ms）：${url}`)));
		req.on("error", rejectPromise);
	});
}

/**
 * 评估候选版本（纯函数）：把"这个候选能不能更新"的所有门禁集中在一处。
 * @returns {{ok: boolean, code: string, message: string, target?: object, currentVersion: string, channel: string}}
 */
export function evaluateCandidate({ name, currentVersion, form, packument, registry = NPM_REGISTRY, allowDowngrade = false }) {
	const channel = distTagForForm(form);
	const fail = (code, message) => ({ ok: false, code, message, currentVersion, channel });

	if (!isPlainObject(packument)) return fail("bad-packument", "权威源返回的 packument 不是对象，已中止");
	if (packument.name !== name) return fail("name-mismatch", `packument 的 name 是 ${JSON.stringify(packument.name)}，期望 ${name}（可能被同名镜像/写法劫持）`);
	const tags = isPlainObject(packument["dist-tags"]) ? packument["dist-tags"] : {};
	const target = typeof tags[channel] === "string" ? tags[channel] : null;
	if (target === null) return fail("no-channel-version", `该源上没有 dist-tag「${channel}」指向的版本（可能还没发这个通道）`);

	const versions = isPlainObject(packument.versions) ? packument.versions : {};
	const meta = isPlainObject(versions[target]) ? versions[target] : null;
	if (meta === null) return fail("missing-version-meta", `packument 里没有 ${name}@${target} 的元数据`);

	const dist = isPlainObject(meta.dist) ? meta.dist : {};
	const tarball = typeof dist.tarball === "string" ? dist.tarball : "";
	const integrity = typeof dist.integrity === "string" ? dist.integrity.trim() : "";
	if (!/^https:\/\//i.test(tarball)) return fail("tarball-not-https", `tarball 不是 https：${tarball || "（空）"}（明文或缺失一律拒）`);
	if (!/^(sha512|sha384|sha256)-/.test(integrity)) return fail("no-integrity", `${name}@${target} 的 dist.integrity 缺失或不是 SRI（${JSON.stringify(dist.integrity ?? null)}）—— 没有摘要就无法发现替换，拒`);

	const cmp = compareVersions(target, currentVersion);
	if (cmp === 0) return fail("up-to-date", `已经是最新（${channel} 通道 = ${target}）`);
	if (cmp < 0 && !allowDowngrade) return { ok: false, code: "downgrade-refused", message: `目标 ${target} 低于当前 ${currentVersion}：更新流程不做降级（回滚请走 --rollback，或显式 allowDowngrade）`, currentVersion, channel };

	return {
		ok: true,
		code: "update-available",
		message: `${currentVersion} → ${target}（通道 ${channel}）`,
		currentVersion,
		channel,
		target: {
			name,
			version: target,
			tarball,
			integrity,
			shasum: typeof dist.shasum === "string" ? dist.shasum : null,
			size: Number.isInteger(dist.unpackedSize) ? null : typeof dist.size === "number" ? dist.size : null,
			registry
		}
	};
}

/** 查权威源并评估（网络在 `getJson` 里，可注入）。 */
export async function checkForUpdate({ name, currentVersion, form, registry = NPM_REGISTRY, getJson = httpsGetJson, allowDowngrade = false }) {
	const packument = await getJson(`${registry.replace(/\/$/, "")}/${encodeURIComponent(name)}`);
	return evaluateCandidate({ name, currentVersion, form, packument, registry, allowDowngrade });
}

/**
 * 把候选包下载到暂存目录并**逐字节校验**（复用 downloader 的三道门禁）。
 * @returns {Promise<{ok: boolean, code?: string, message?: string, file?: string, bytes?: number}>}
 */
export async function stageCandidate({ candidate, dshHome, download = downloadUrl, log = () => {}, fsx = null }) {
	const f = resolveFsx(fsx);
	if (!candidate?.target?.tarball || !candidate?.target?.integrity) return { ok: false, code: "bad-candidate", message: "候选缺少 tarball / integrity，拒" };
	const dir = stagingDir(dshHome);
	try {
		f.mkdirSync(dir, { recursive: true });
	} catch (error) {
		return { ok: false, code: "staging-unwritable", message: `暂存目录不可写：${error instanceof Error ? error.message : String(error)}` };
	}
	const result = await download(
		candidate.target.tarball,
		log,
		{ expect: { integrity: candidate.target.integrity, size: candidate.target.size ?? void 0 }, allowUnverified: false, allowInsecure: false }
	);
	const status = typeof result?.status === "string" ? result.status : result?.ok === true ? "ok" : "failed";
	if (status !== "ok" && status !== "success") {
		return { ok: false, code: `download-${status}`, message: result?.message ?? "下载/校验失败（未落盘或已删除）" };
	}
	const file = result?.file ?? result?.path ?? null;
	if (typeof file !== "string" || file === "") return { ok: false, code: "download-no-file", message: "下载器报告成功但没有给出文件路径" };
	// 注意：这里只校验**字节**（integrity 来自权威 packument，等于"就是发布者发的那份字节"）。
	// 内容层面的包名/版本校验在安装时由 pnpm + profile 的 package.json 落实；本地 tgz 没有摘要可比，只能靠人确认。
	return { ok: true, message: `已校验并暂存：${file}`, file, bytes: result?.bytes ?? null };
}

/**
 * 从本地 tgz **文件名**里取版本号（`dsh-drydock-1.2.0.tgz` / `dsh-drydock-1.1.0-desktop.2.tgz`）。
 * 取不到就退回 `local:<文件名>` —— 绝不假装知道版本（UI 里那一行是要给人看的）。
 */
export function versionFromLocalTarball(file) {
	const base = String(file ?? "").split(/[\\/]/).pop() ?? "";
	const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)\.tgz$/i.exec(base);
	return m === null ? null : m[1];
}

/**
 * 本地 tgz 候选（用户显式给文件时的路径）。没有权威源可对照 —— 必须由人显式承认。
 */
export async function localCandidate({ file, name, currentVersion, form, acceptLocal = false, dshHome, fsx = null }) {
	if (!acceptLocal) return { ok: false, code: "local-needs-ack", message: "本地 tgz 没有权威源可对照：请显式加 --accept-local 表示你确认该文件来源" };
	const f = resolveFsx(fsx);
	const abs = resolve(file);
	if (!f.existsSync(abs)) return { ok: false, code: "local-missing", message: `本地文件不存在：${abs}` };
	try {
		f.mkdirSync(stagingDir(dshHome), { recursive: true });
	} catch {
		/* 目录已存在即可 */
	}
	const guessed = versionFromLocalTarball(abs);
	return {
		ok: true,
		code: "local-candidate",
		message: `本地 tgz：${abs}（未经权威源比对，按你显式确认处理${guessed === null ? "" : `；文件名解析出版本 ${guessed}`}）`,
		currentVersion,
		channel: distTagForForm(form),
		target: {
			name,
			version: guessed ?? `local:${abs.split(/[\\/]/).pop() ?? abs}`,
			tarball: abs,
			integrity: null,
			local: true,
			versionFromFilename: guessed !== null,
			registry: null
		}
	};
}

/** 生成「现在 / 稍后」提示文本（UI、CLI、issue 里共用同一段文案）。 */
export function promptText(state, { canApply = null } = {}) {
	if (!isPlainObject(state)) return "";
	const apply = canApply === null ? canSelfApply(state.form) : canApply;
	const lines = [
		`drydock 有新版本：${state.currentVersion} → ${state.targetVersion}（通道 ${state.channel}）`
	];
	if (state.source === "local-file") lines.push("  ⚠ 来源：本地 tgz（未经权威源比对，按你显式确认处理）");
	else lines.push(`  来源：${state.registry ?? NPM_REGISTRY}（摘要已校验：${String(state.integrity ?? "").slice(0, 24)}…）`);
	if (apply) {
		lines.push("  现在升级 = 停引擎 → 安装新包 → 健康检查 → 重启引擎（3080 会短暂不可用，约 10–30 秒；失败自动回滚）");
		lines.push("  [现在] dsh-drydock-update --now      [稍后] dsh-drydock-update --later");
	} else {
		lines.push("  ⚠ 当前是桌面形态：profile 由官方应用独占，drydock 不会自己装/重启。");
		lines.push("     请从系统托盘完全退出桌面版，再用桌面版自带 CLI 安装该版本（见 docs/版本与轨道.md）。");
		lines.push("  [知道了] dsh-drydock-update --later");
	}
	return lines.join("\n");
}

/** 记录决策（pending → now / later）。 */
export function decide(state, decision, { now = Date.now } = {}) {
	if (!isPlainObject(state)) return { ok: false, code: "no-state", message: "没有待处理更新" };
	if (decision !== "now" && decision !== "later") return { ok: false, code: "bad-decision", message: `决策只能是 now / later，收到 ${JSON.stringify(decision)}` };
	if (!canSelfApply(state.form) && decision === "now") {
		return { ok: false, code: "desktop-delegated", message: "桌面形态不能自己装：profile 由官方应用独占。请按提示手动安装，或先 --later。" };
	}
	return { ok: true, state: { ...state, decision, decidedAt: nowIso(now) } };
}

/** `--status` 的人读摘要（不改状态）。 */
export function statusText(state, { now = Date.now } = {}) {
	if (state === null) return "没有待处理的自更新（self-update.json 不存在或已失效）";
	const ageMin = Math.max(0, Math.round((now() - Date.parse(state.decidedAt ?? state.fetchedAt ?? new Date().toISOString())) / 60000));
	return [
		`待处理更新：${state.currentVersion} → ${state.targetVersion}（通道 ${state.channel}，形态 ${state.form}）`,
		`  阶段：${state.phase}${state.decision ? `，决策：${state.decision}` : "，决策：未决定"}`,
		`  暂存：${state.stagedFile ?? "（未下载）"}`,
		`  时间：${ageMin} 分钟前${state.phase === "running" ? "（running 是中间态：若进程已不在，请用 --status 判定并手动回滚）" : ""}`,
		state.lastError ? `  最近错误：${state.lastError}` : ""
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * 后台 worker：真正执行「停引擎 → 装包 → 健康检查 → 启引擎」，失败则回滚。
 * 全部动作可注入（`run` / `stopEngine` / `startEngine` / `health`），便于测试状态机与顺序。
 */
export async function runWorker({
	state,
	dshHome,
	profileDir,
	dshCmd = "dsh",
	deps = {},
	log = () => {}
} = {}) {
	const {
		run = defaultRun,
		stopEngine = null,
		startEngine = null,
		health = null,
		waitForEngine = null,
		writeState: write = (s) => writeState(s, { dshHome })
	} = deps;

	const steps = [];
	const record = (name, ok, detail) => {
		steps.push({ name, ok, at: nowIso(), detail: detail === void 0 ? null : detail });
		log(`  ${ok ? "✓" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
	};

	if (!isPlainObject(state)) return { ok: false, code: "no-state", message: "没有待处理更新", steps };
	if (!canSelfApply(state.form)) return { ok: false, code: "desktop-delegated", message: "桌面形态不自己装（profile 由官方应用独占）", steps };

	const current = { ...state, phase: "running", startedAt: nowIso(), steps: [] };
	write(current);

	const target = state.stagedFile;
	if (typeof target !== "string" || target === "") {
		record("检查暂存包", false, "没有 stagedFile（--fetch 没成功？）");
		write({ ...current, phase: "failed", lastError: "缺少暂存包", steps });
		return { ok: false, code: "no-staged-file", message: "缺少暂存包", steps };
	}

	// ① 引擎是否在跑（决定后面要不要拉起来）
	let engineWasRunning = false;
	if (typeof health === "function") {
		try {
			const r = await health();
			engineWasRunning = r === true || (isPlainObject(r) && r.ok === true);
		} catch {
			engineWasRunning = false;
		}
	}
	record("探测引擎状态", true, engineWasRunning ? "在跑" : "未运行");

	// ② 停引擎（必须成功，否则装包会撞文件锁）
	if (typeof stopEngine === "function") {
		try {
			const r = await stopEngine(profileDir);
			const ok = r === true || (isPlainObject(r) && r.ok === true);
			record("停止引擎", ok, isPlainObject(r) ? r.message ?? null : null);
			if (!ok && engineWasRunning) {
				write({ ...current, phase: "failed", lastError: "停止引擎失败", steps });
				return { ok: false, code: "stop-failed", message: "停止引擎失败，已中止（未安装任何东西）", steps };
			}
		} catch (error) {
			record("停止引擎", false, error instanceof Error ? error.message : String(error));
			write({ ...current, phase: "failed", lastError: `停止引擎抛错：${error instanceof Error ? error.message : String(error)}`, steps });
			return { ok: false, code: "stop-failed", message: "停止引擎抛错，已中止", steps };
		}
	}

	// ③ 装新包（唯一改 profile 的动作；失败即回滚路径由 ⑤ 处理）
	const install = await run(dshCmd, ["plugin", "--profile", profileDir, "add", target, "--config.minimumReleaseAge=0"]);
	record("安装新版本", install.ok, install.ok ? null : `退出码 ${install.code}`);
	if (!install.ok) {
		const rollback = await rollbackTo({ run, dshCmd, profileDir, version: state.currentVersion, log, record });
		write({ ...current, phase: "failed", lastError: `安装失败（退出码 ${install.code}）`, rollback, steps });
		return { ok: false, code: "install-failed", message: "安装新版本失败", steps, rollback };
	}

	// ④ 拉起并等健康
	if (typeof startEngine === "function") {
		try {
			const started = await startEngine(profileDir);
			const ok = isPlainObject(started) ? started.ok !== false : true;
			const healthy = typeof waitForEngine === "function" ? await waitForEngine() : ok;
			record("重启引擎", ok && healthy !== false, isPlainObject(started) ? started.message ?? null : null);
			if (!(ok && healthy !== false)) {
				const rollback = await rollbackTo({ run, dshCmd, profileDir, version: state.currentVersion, log, record });
				write({ ...current, phase: "failed", lastError: "重启后健康检查失败", rollback, steps });
				return { ok: false, code: "unhealthy", message: "新版本启动后健康检查失败，已回滚", steps, rollback };
			}
		} catch (error) {
			record("重启引擎", false, error instanceof Error ? error.message : String(error));
			write({ ...current, phase: "failed", lastError: `重启抛错：${error instanceof Error ? error.message : String(error)}`, steps });
			return { ok: false, code: "start-failed", message: "重启抛错", steps };
		}
	}

	record("完成", true, `${state.currentVersion} → ${state.targetVersion}`);
	write({ ...current, phase: "applied", finishedAt: nowIso(), steps });
	return { ok: true, code: "applied", message: `已升级到 ${state.targetVersion}`, steps };
}

async function rollbackTo({ run, dshCmd, profileDir, version, log, record }) {
	log(`  ↩ 回滚到 ${version}`);
	const r = await run(dshCmd, ["plugin", "--profile", profileDir, "add", `dsh-drydock@${version}`, "--config.minimumReleaseAge=0"]);
	record("回滚", r.ok, r.ok ? version : `退出码 ${r.code}`);
	return { ok: r.ok, version, code: r.ok ? 0 : r.code };
}

/** 默认子进程执行器：Windows 上 `.cmd` 不能裸 spawn（CVE-2024-27980），统一走 cmd /c。 */
export function defaultRun(cmd, args, { cwd = process.cwd(), timeoutMs = 300000 } = {}) {
	return new Promise((resolvePromise) => {
		const isWin = process.platform === "win32";
		const spawnImpl = isWin ? nodeSpawn("cmd.exe", ["/d", "/s", "/c", [cmd, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ")], { cwd, windowsHide: true }) : nodeSpawn(cmd, args, { cwd, windowsHide: true });
		let done = false;
		const finish = (code) => {
			if (done) return;
			done = true;
			resolvePromise({ ok: code === 0, code });
		};
		spawnImpl.on("error", () => finish(-1));
		spawnImpl.on("exit", (code) => finish(code === null ? -1 : code));
		setTimeout(() => {
			if (!done) {
				try {
					spawnImpl.kill();
				} catch {
					/* 已退出 */
				}
				finish(-2);
			}
		}, timeoutMs);
	});
}

/** 起一个**脱离父进程**的 worker（父进程可能是正在被替换的引擎 → 必须 detached）。 */
export function spawnDetachedWorker({ selfPath, dshHome, spawn = nodeSpawn, logFile = null }) {
	const args = [selfPath, "--worker", "--home", dshHome];
	try {
		let out = "ignore";
		if (logFile !== null) {
			mkdirSync(dirname(logFile), { recursive: true });
			out = openSync(logFile, "a");
		}
		const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out], windowsHide: true });
		child.unref();
		return { ok: true, pid: child.pid ?? null };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
