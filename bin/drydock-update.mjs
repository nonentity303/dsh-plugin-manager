#!/usr/bin/env node
/**
 * dsh-drydock-update — drydock 自更新（1.1.0-desktop.1 起）
 *
 * 一条命令走完：**查权威源 → 校验并暂存 → 现在/稍后 → 停引擎 → 装新包 → 健康检查 → 重启（失败自动回滚）**。
 *
 * 用法：
 *   dsh-drydock-update --check                 # 只查（不下载、不写状态）
 *   dsh-drydock-update --fetch                 # 下载 + 校验 + 落暂存，然后打印「现在 / 稍后」提示
 *   dsh-drydock-update --accept-local <tgz>    # 用本地 tgz（必须显式确认来源）
 *   dsh-drydock-update --prompt                # 有 pending 就输出提示文本（给 UI / 脚本用）
 *   dsh-drydock-update --now                   # 现在升级：起一个脱离父进程的 worker 去停引擎→装→重启
 *   dsh-drydock-update --later                 # 稍后：保留 pending，下次启动再提示
 *   dsh-drydock-update --status [--json]       # 看状态（不改任何东西）
 *   dsh-drydock-update --rollback              # 失败后手动回滚到当前记录的版本
 *   dsh-drydock-update --worker                # 内部：worker 本体（由 --now 拉起，不建议手敲）
 *
 * 安全默认：
 *   · 只认 npm 官方 registry 的 **https** tarball + **SRI 摘要**；无摘要 / http / 名字不符 / 降级一律拒；
 *   · 本地 tgz 必须 `--accept-local`（没有权威源可对照，记录 sha512 且标注 source=local-file）；
 *   · 桌面形态**绝不自己装**（profile 由 Electron 独占）——只提示，由人按官方流程操作；
 *   · `--now` 才动引擎；`--no-restart` 可只装不重启（你自己重启）。
 *
 * 退出码：0 = 正常；1 = 有错误 / 更新失败；2 = 用法错误。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	NPM_REGISTRY,
	canSelfApply,
	checkForUpdate,
	decide,
	distTagForForm,
	localCandidate,
	promptText,
	readState,
	resolveDshHome,
	spawnDetachedWorker,
	stageCandidate,
	statePath,
	statusText,
	writeState
} from "../lib/self-update.mjs";
import { runWorker } from "../lib/self-update.mjs";
import { engineHealth, startEngine, stopEngine, waitForEngine } from "../lib/enginectl.mjs";
import { readHostProfile, resolveHostForm } from "../lib/host-profile.mjs";

const SELF = fileURLToPath(import.meta.url);
const PKG_NAME = "dsh-drydock";

const HELP = `用法: dsh-drydock-update [选项]

  --check                 只查权威源（不下载、不写状态）
  --fetch                 下载 + 校验 + 落暂存，打印「现在 / 稍后」提示
  --accept-local <tgz>    用本地 tgz（必须显式确认来源；记录 sha512，标注未经权威源比对）
  --prompt                输出待处理更新的提示文本（没有则退出码 0、空白）
  --now                   现在升级（起 detached worker：停引擎 → 装 → 健康检查 → 重启；失败回滚）
  --later                 稍后（保留 pending，下次启动再提示）
  --status [--json]       查看状态（只读）
  --rollback              按状态里记录的 currentVersion 手动回滚
  --worker                内部 worker 本体（由 --now 拉起）

路径与形态：
  --home <dir>            DSH_HOME（默认 $DSH_HOME > ~/.dsh）
  --profile <名|目录>     目标 profile（默认 web；桌面形态请传 desktop）
  --form <web|desktop>    覆盖形态判定（默认读首启画像 host-profile.json，没有就实测一次、不落盘）
  --dsh <命令>            dsh CLI（默认 dsh；Windows 会经 cmd /c 调 .cmd）
  --registry <url>        权威源（默认 ${NPM_REGISTRY}；只允许 https）
  --no-restart            只装不重启（你自己重启引擎）
  --json                  机器可读输出
  --help, -h              本帮助

状态文件：<DSH_HOME>/.drydock/self-update.json（原子写；坏数据自愈为"无待处理更新"）
暂存目录：<DSH_HOME>/.drydock/self-update/`;

function parseArgs(argv) {
	const opt = (name, fallback = null) => {
		const i = argv.indexOf(name);
		if (i < 0) return fallback;
		const v = argv[i + 1];
		return v && !v.startsWith("--") ? v : fallback;
	};
	const has = (n) => argv.includes(n);
	return {
		help: has("--help") || has("-h"),
		check: has("--check"),
		fetch: has("--fetch"),
		acceptLocal: opt("--accept-local", null),
		prompt: has("--prompt"),
		now: has("--now"),
		later: has("--later"),
		status: has("--status"),
		rollback: has("--rollback"),
		worker: has("--worker"),
		json: has("--json"),
		noRestart: has("--no-restart"),
		force: has("--force"),
		home: opt("--home", null),
		profile: opt("--profile", "web"),
		form: opt("--form", null),
		dsh: opt("--dsh", "dsh"),
		registry: opt("--registry", NPM_REGISTRY),
		unknown: argv.filter((a, i) => a.startsWith("-") && !HELP_FLAGS.has(a) && !(i > 0 && HELP_FLAGS_WITH_VALUE.has(argv[i - 1])))
	};
}
const HELP_FLAGS = new Set(["--help", "-h", "--check", "--fetch", "--prompt", "--now", "--later", "--status", "--rollback", "--worker", "--json", "--no-restart", "--force", "--accept-local", "--home", "--profile", "--form", "--dsh", "--registry"]);
const HELP_FLAGS_WITH_VALUE = new Set(["--accept-local", "--home", "--profile", "--form", "--dsh", "--registry"]);

/** 目标 profile 目录：名字 → `<DSH_HOME>/profiles/<名字>`；给绝对路径则原样用。 */
function resolveProfileDir({ dshHome, profile }) {
	if (typeof profile === "string" && /[\\/]/.test(profile)) return resolve(profile);
	return join(dshHome, "profiles", profile);
}

/** 当前安装版本：优先读 profile 里真实安装的那份 package.json；读不到就退回本包自己。 */
function resolveCurrentVersion(profileDir) {
	const candidates = [join(profileDir, "node_modules", PKG_NAME, "package.json"), join(dirname(dirname(SELF)), "package.json")];
	for (const file of candidates) {
		try {
			if (!existsSync(file)) continue;
			const v = JSON.parse(readFileSync(file, "utf8")).version;
			if (typeof v === "string" && v !== "") return v;
		} catch {
			/* 换下一个候选 */
		}
	}
	return null;
}

/** 形态：显式 --form > 首启画像 > 实测一次（只读，不落盘）。 */
function resolveForm({ dshHome, override }) {
	if (override === "web" || override === "desktop" || override === "unknown") return { form: override, source: "--form 覆盖" };
	const cached = readHostProfile({ dshHome });
	if (cached !== null) return { form: cached.form, source: `首启画像（${cached.profiledAt}）` };
	const probed = resolveHostForm();
	return { form: probed.form, source: `实测（${probed.reason.slice(0, 40)}…，未落盘）` };
}

function out(json, payload, text) {
	if (json) console.log(JSON.stringify(payload, null, 2));
	else console.log(text);
}

async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(HELP);
		return 0;
	}
	if (args.unknown.length > 0) {
		console.error(`未知参数：${args.unknown.join(" ")}\n\n${HELP}`);
		return 2;
	}
	if (!/^https:\/\//i.test(args.registry)) {
		console.error(`拒绝非 https 权威源：${args.registry}`);
		return 2;
	}

	const dshHome = typeof args.home === "string" && args.home !== "" ? resolve(args.home) : resolveDshHome();
	const profileDir = resolveProfileDir({ dshHome, profile: args.profile });
	const currentVersion = resolveCurrentVersion(profileDir);
	if (currentVersion === null) {
		console.error(`读不到当前版本（profile 未安装 ${PKG_NAME}？）：${profileDir}`);
		return 1;
	}
	const { form, source: formSource } = resolveForm({ dshHome, override: args.form });

	// ── --status（只读）──────────────────────────────────────
	if (args.status) {
		const state = readState({ dshHome });
		out(
			args.json,
			{
				dshHome,
				profileDir,
				form,
				formSource,
				currentVersion,
				channel: distTagForForm(form),
				canApply: canSelfApply(form),
				state,
				prompt: promptText(state, { canApply: canSelfApply(state?.form ?? form) })
			},
			statusText(state)
		);
		return 0;
	}

	// ── --prompt（只读）──────────────────────────────────────
	if (args.prompt) {
		const state = readState({ dshHome });
		// 提示文案必须按**状态里记录的形态**渲染（暂存时的形态），而不是当前机器的形态：
		// 否则桌面暂存的包可能在网页机器上被渲染成「现在」按钮，点了必然失败。
		const promptForm = state?.form ?? form;
		const text = promptText(state, { canApply: canSelfApply(promptForm) });
		if (args.json) console.log(JSON.stringify({ state, canApply: canSelfApply(promptForm) }, null, 2));
		else if (text !== "") console.log(text);
		return 0;
	}

	// ── --later ─────────────────────────────────────────────
	if (args.later) {
		const state = readState({ dshHome });
		const d = decide(state, "later");
		if (!d.ok) {
			console.error(d.message);
			return 1;
		}
		writeState(d.state, { dshHome });
		console.log(`已选「稍后」：${state.targetVersion} 保留在暂存里，下次启动会再提示（dsh-drydock-update --now 可随时继续）`);
		return 0;
	}

	// ── --now：起 detached worker ────────────────────────────
	if (args.now) {
		const state = readState({ dshHome });
		if (state === null) {
			console.error("没有待处理更新：先跑 dsh-drydock-update --fetch");
			return 1;
		}
		const d = decide(state, "now");
		if (!d.ok) {
			console.error(d.message);
			return 1;
		}
		const running = { ...d.state, phase: "running", startedAt: new Date().toISOString(), dshHome, profileDir, form, dshCmd: args.dsh, noRestart: args.noRestart === true };
		writeState(running, { dshHome });
		const spawned = spawnDetachedWorker({ selfPath: SELF, dshHome, logFile: join(dshHome, ".drydock", "self-update-worker.log") });
		if (!spawned.ok) {
			writeState({ ...running, phase: "failed", lastError: `worker 启动失败：${spawned.error}` }, { dshHome });
			console.error(`worker 启动失败：${spawned.error}`);
			return 1;
		}
		writeState({ ...running, workerPid: spawned.pid }, { dshHome });
		console.log(
			args.noRestart
				? `已开始升级到 ${state.targetVersion}：只装不重启（你稍后自己重启引擎生效）；日志：${join(dshHome, ".drydock", "self-update-worker.log")}`
				: `已开始升级到 ${state.targetVersion}：引擎会短暂重启（日志：${join(dshHome, ".drydock", "self-update-worker.log")}）`
		);
		console.log("进度：dsh-drydock-update --status");
		return 0;
	}

	// ── --rollback ──────────────────────────────────────────
	if (args.rollback) {
		const state = readState({ dshHome });
		const version = state?.currentVersion ?? currentVersion;
		const r = await runWorker({
			state: { ...(state ?? {}), form: "web", stagedFile: `${PKG_NAME}@${version}`, currentVersion: currentVersion, targetVersion: version },
			dshHome,
			profileDir,
			dshCmd: args.dsh,
			deps: { stopEngine, startEngine, waitForEngine, health: () => engineHealth() },
			log: (line) => console.log(line)
		});
		console.log(r.ok ? `已回滚到 ${version}` : `回滚失败：${r.message}`);
		return r.ok ? 0 : 1;
	}

	// ── --worker（内部）────────────────────────────────────
	if (args.worker) {
		const state = readState({ dshHome });
		if (state === null) {
			console.error("worker：没有待处理更新，退出");
			return 1;
		}
		const r = await runWorker({
			state,
			dshHome,
			profileDir: state.profileDir ?? profileDir,
			dshCmd: state.dshCmd ?? args.dsh,
			deps: args.noRestart || state.noRestart === true ? { stopEngine, health: () => engineHealth() } : { stopEngine, startEngine, waitForEngine, health: () => engineHealth() },
			log: (line) => console.log(line)
		});
		console.log(r.ok ? `✓ ${r.message}` : `✘ ${r.message}`);
		return r.ok ? 0 : 1;
	}

	// ── --accept-local ──────────────────────────────────────
	if (typeof args.acceptLocal === "string") {
		const cand = await localCandidate({ file: args.acceptLocal, name: PKG_NAME, currentVersion, form, acceptLocal: true, dshHome });
		if (!cand.ok) {
			console.error(cand.message);
			return 1;
		}
		const state = {
			phase: "pending",
			name: PKG_NAME,
			form,
			channel: distTagForForm(form),
			currentVersion,
			targetVersion: cand.target.version,
			stagedFile: resolve(args.acceptLocal),
			integrity: null,
			registry: null,
			source: "local-file",
			fetchedAt: new Date().toISOString(),
			dshHome,
			profileDir
		};
		writeState(state, { dshHome });
		out(
			args.json,
			{ dshHome, profileDir, form, currentVersion, channel: state.channel, canApply: canSelfApply(form), state, prompt: promptText(state, { canApply: canSelfApply(form) }) },
			`${cand.message}\n\n${promptText(state, { canApply: canSelfApply(form) })}`
		);
		return 0;
	}

	// ── --check / --fetch（不指定时默认 --check）────────────
	const checked = await checkForUpdate({ name: PKG_NAME, currentVersion, form, registry: args.registry, allowDowngrade: args.force });
	if (!args.fetch) {
		if (args.json) console.log(JSON.stringify({ dshHome, profileDir, form, formSource, currentVersion, ...checked }, null, 2));
		else console.log(`${checked.ok ? "有更新" : "无更新"}：${checked.message}`);
		return checked.ok ? 0 : 0;
	}
	if (!checked.ok) {
		console.log(`没有可更新的版本：${checked.message}`);
		return 0;
	}

	console.log(`发现新版本：${checked.message}`);
	console.log(`  权威源：${args.registry}`);
	console.log(`  tarball：${checked.target.tarball}`);
	console.log(`  摘要：${checked.target.integrity.slice(0, 32)}…`);
	const staged = await stageCandidate({ candidate: checked, dshHome, log: (line) => console.log(`  ${line}`) });
	if (!staged.ok) {
		console.error(`下载/校验失败：${staged.message}`);
		return 1;
	}
	const state = {
		phase: "pending",
		name: PKG_NAME,
		form,
		channel: checked.channel,
		currentVersion,
		targetVersion: checked.target.version,
		stagedFile: staged.file,
		integrity: checked.target.integrity,
		tarball: checked.target.tarball,
		registry: args.registry,
		source: "registry",
		fetchedAt: new Date().toISOString(),
		dshHome,
		profileDir
	};
	writeState(state, { dshHome });
	out(
		args.json,
		{ dshHome, profileDir, form, currentVersion, channel: state.channel, canApply: canSelfApply(form), state, prompt: promptText(state, { canApply: canSelfApply(form) }) },
		`${staged.message}\n\n${promptText(state, { canApply: canSelfApply(form) })}`
	);
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(`自更新失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		process.exit(1);
	});
