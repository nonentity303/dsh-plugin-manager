#!/usr/bin/env node
/**
 * dsh-boot.mjs — Steam 式启动序列（P1-1）+ 1.1.0 桌面版救援链（S5）。
 *
 * 流程：verify（启动前自检）→ 有问题自动 fix（隔离坏 bundle，可逆）→ 拉起 `dsh web` → 健康等待。
 * 相当于在引擎启动前设一道"安检"，坏插件被自动拦下，避免主进程崩溃。
 *
 * v0.9.0-2（审计③ 修复 L2/L4/L7）：
 *  - 健康判定用 HTTP 握手 + dsh 身份指纹（裸 TCP 监听器不算"引擎已就绪"）；
 *    3080 被非 dsh 进程占用时明确报错并退出码 1，不误判为已运行。
 *  - 引擎立刻退出（坏命令/端口冲突）时**立即失败**，不再空等整个超时；
 *    失败输出带上日志绝对路径与日志尾部，便于现场定位。
 *  - 显式使用稳定 cwd（默认用户主目录，--cwd 可覆盖），避免把包目录当工作目录。
 *  - 新增 `--help`。
 *
 * v1.1.0（桌面版移植 M5，契约 F5/F6，红线第 1/2 条）新增两条**官方通道**能力：
 *  - `--rescue-profile`：不走"启动本 profile"，改为走官方 `dsh rescue --from-default-profile web`
 *    建/重建救援 profile 并启动它（rescue 是官方 help 里的示例名 —— 官方自己推荐"从出厂 web 模板造救援 profile"）。
 *    **桌面 profile 下一律拒绝**（code: desktop-delegated）：桌面场景绝不 spawn Host。
 *  - `--heal-recovery`：官方恢复（禁用第三方 bundle + 把 cordis.patch.yml 改名
 *    `cordis.patch.yml.bak-<timestamp>` + 下次启动建空 patch）之后，从侧车 `plugin-manager.json`
 *    与 `.rescue-bak-*` 备份**重建归属行**。默认 dry-run 只打印计划；`--apply` 才真写，
 *    并把 `--confirm <profileName>` 当二次确认；desktop 还要 `--allow-desktop`。
 *    持锁（`profiles/desktop/lock` 存在）时**一律拒绝写盘**并给只读预览。
 *
 * 用法：
 *   node bin/dsh-boot.mjs [--profile <dir>] [--dsh <cmd>] [--repair-only] [--wait-ms <n>] [--pause] [--cwd <dir>]
 *   node bin/dsh-boot.mjs --rescue-profile [--dsh <cmd>] [--wait-ms <n>] [--cwd <dir>]
 *   node bin/dsh-boot.mjs --heal-recovery [--profile <dir>] [--apply --confirm <profileName> [--allow-desktop]]
 *
 * 退出码：
 *   0 = 引擎已就绪（或 repair-only 下 profile 健康 / dry-run 计划已打印）
 *   1 = 启动后仍未就绪（或 fix 无法解决 / 救援与自愈执行失败）
 *   2 = verify 发现问题且 fix 后仍有问题（repair-only）；或参数冲突（--rescue-profile 与 --heal-recovery 互斥）
 *   3 = 被安全门拒绝（desktop 持锁 / 未确认 / 未允许 desktop / 桌面场景拒绝 spawn Host）
 */
import { realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyProfile, fixProfile, isolateFailedEntries } from "../lib/preflight.mjs";
import { ENGINE_PORT, chdirStable, engineHealth, portOwner, probe, startEngineWithQuarantine, waitForEngine } from "../lib/enginectl.mjs";
import { entryUrlOf, launcherPortFromEnv } from "../lib/ports.mjs";
import {
	DEFAULT_TEMPLATE,
	RESCUE_PROFILE_NAME,
	buildRescueProfile,
	detectOfficialRecoveryTraces,
	planSelfHeal,
	resolveDshHome,
	selfHealAfterRecovery
} from "../lib/rescue-profile.mjs";

const SELF = fileURLToPath(import.meta.url);
const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");

const HELP_TEXT = `DSH 启动序列（自检 → 修复 → 启动 → 健康等待）

用法：
  node bin/dsh-boot.mjs [选项]
  node bin/dsh-boot.mjs --rescue-profile [选项]
  node bin/dsh-boot.mjs --heal-recovery [--apply --confirm <profileName> [--allow-desktop]]

选项：
  --profile <dir>   profile 目录（默认 ~/.dsh/profiles/web）
  --dsh <cmd>       启动引擎的命令（默认 dsh；含空格的路径也可用）
  --repair-only     只执行 verify + fix，不启动引擎（退出码 0=健康 / 2=修复后仍有问题）
  --wait-ms <n>     启动后等待引擎就绪的最长时间（默认 45000）
  --pause           结束时等按键再关闭窗口（供 open-boot 弹出的可见启动窗口使用）
  --cwd <dir>       引擎工作目录（默认用户主目录，避免锁住包目录）

救援 profile 与恢复后自愈（1.1.0 桌面版支持）：
  --rescue-profile  不走"启动本 profile"：走**官方通道**建/重建救援 profile 并启动它
                    （执行 dsh rescue --from-default-profile web —— 官方 help 里的示例用法）。
                    完全不走 npm 的 dsh plugin --profile <x>，因此不需要绕 rejectElectronProfile，
                    也绝不碰 desktop profile。桌面 profile 下一律拒绝（code: desktop-delegated）。
  --heal-recovery   检测桌面官方"恢复"留下的痕迹（空 patch / cordis.patch.yml.bak-<时间戳> /
                    package.json.bundles 被摘），并打印**自愈计划**（默认 dry-run，只读不写）。
  --apply           与 --heal-recovery 合用才真正写盘：写前自动备份（.rescue-bak-<时间戳>）、
                    只动带归属标记的行、写完复检（失败自动回滚）。
  --confirm <name>  与 --apply 合用的**二次确认**：必须等于目标 profile 名（如 web / desktop）。
  --allow-desktop   显式允许对 desktop profile 写盘（只在 --apply 时需要；不加则拒绝对 desktop
                    写盘并给中文原因，退出码 3）。dry-run 只读预览不需要它。
  --help            显示本帮助

退出码：0=就绪 / 1=未就绪或执行失败 / 2=repair-only 修复未完成或参数冲突 /
        3=被安全门拒绝（desktop 持锁 / 未确认 / 未允许 desktop / 桌面场景拒绝 spawn Host）
`;

function parseArgs(argv) {
	const args = {
		profile: PROFILE_DEFAULT,
		dsh: "dsh",
		repairOnly: false,
		waitMs: 45000,
		pause: false,
		help: false,
		cwd: null,
		// 1.1.0 桌面版救援链
		rescueProfile: false,
		healRecovery: false,
		apply: false,
		confirm: null,
		allowDesktop: false,
		unknown: []
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile" && argv[i + 1]) { args.profile = resolve(argv[++i]); }
		else if (argv[i] === "--dsh" && argv[i + 1]) { args.dsh = argv[++i]; }
		else if (argv[i] === "--cwd" && argv[i + 1]) { args.cwd = resolve(argv[++i]); }
		// 只自增一次（历史 bug 见审计③ L6）
		else if (argv[i] === "--wait-ms" && argv[i + 1]) { args.waitMs = Number(argv[++i]) || 45000; }
		else if (argv[i] === "--repair-only") { args.repairOnly = true; }
		else if (argv[i] === "--pause") { args.pause = true; }
		// --confirm 取不到值时不吞掉下一个开关（与 --profile 同一判定风格）
		else if (argv[i] === "--confirm") {
			if (argv[i + 1] && !argv[i + 1].startsWith("-")) args.confirm = argv[++i];
			else args.confirm = "";
		}
		else if (argv[i] === "--rescue-profile") { args.rescueProfile = true; }
		else if (argv[i] === "--heal-recovery") { args.healRecovery = true; }
		else if (argv[i] === "--apply") { args.apply = true; }
		else if (argv[i] === "--allow-desktop") { args.allowDesktop = true; }
		else if (argv[i] === "--help" || argv[i] === "-h") { args.help = true; }
		else if (argv[i].startsWith("-")) { args.unknown.push(argv[i]); }
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const log = (line) => console.log(`[dsh-boot] ${line}`);
	if (args.help) { console.log(HELP_TEXT); return 0; }
	if (args.unknown.length > 0) log(`⚠ 无法识别的参数（已忽略）：${args.unknown.join(" ")}（用 --help 查看用法）`);
	if (args.apply && !args.healRecovery) log("⚠ --apply 只与 --heal-recovery 合用；当前模式下已忽略。");
	// 稳定 cwd（审计③ L2）：引擎的 cwd 不能落在本包 node_modules / profile 目录里
	chdirStable(args.cwd);

	if (args.rescueProfile && args.healRecovery) {
		log("✗ 参数冲突：--rescue-profile 与 --heal-recovery 互斥（前者会启动一个 Host，后者只读/写 patch 行）。");
		log("  请只选一个：--rescue-profile（引擎坏了、要另起救援 profile）或 --heal-recovery（官方恢复之后补回归属行）。");
		return 2;
	}
	if (args.rescueProfile) return await runRescueProfile(args, log);
	if (args.healRecovery) return await runHealRecovery(args, log);

	if (!process.argv.includes("--profile")) {
		log(`profile 默认: ${args.profile}（可用 --profile 指定）`);
	}
	log(`profile: ${args.profile}`);

	// 1) 自检
	log("① 启动前自检 verify…");
	const verify = verifyProfile(args.profile);

	if (!verify.ok && verify.issues.length > 0) {
		log(`发现 ${verify.issues.length} 个问题：`);
		for (const issue of verify.issues) log(`  ✗ ${issue.name}: ${issue.reason}`);
		// 2) 修复（隔离坏 bundle / 恢复损坏补丁）
		log("② 自动修复 fix…");
		const fixed = fixProfile(args.profile);
		log(`修复结果：${fixed.message || "完成"}`);
		const recheck = verifyProfile(args.profile);
		if (!recheck.ok && recheck.issues.length > 0) {
			log("✗ 修复后仍存在问题（可能需要手动处理）：");
			for (const issue of recheck.issues) log(`  ✗ ${issue.name}: ${issue.reason}`);
			if (args.repairOnly) {
				log("repair-only 模式结束：退出码 2");
				return 2;
			}
		}
	} else {
		log("✓ profile 配置正常");
	}

	if (args.repairOnly) {
		log("repair-only 模式结束：退出码 0");
		return 0;
	}

	// 3) 启动（健康 = HTTP 握手 + 身份，而不是"端口能连"）
	const health = await engineHealth(ENGINE_PORT);
	if (health.ok) {
		log(`✓ 引擎已在 ${ENGINE_PORT} 运行（HTTP 握手正常），无需启动`);
		return 0;
	}
	if (await probe(ENGINE_PORT)) {
		const owner = portOwner(ENGINE_PORT);
		log(`✗ 端口 ${ENGINE_PORT} 被${owner ? ` pid ${owner}` : "其他进程"}占用，但它不是 dsh 引擎（HTTP 握手失败）。`);
		log(`  拒绝把它当成"引擎已就绪"；请先结束该进程（任务管理器 / 启动器救援页 ${entryUrlOf(launcherPortFromEnv())} ），或确认 profile/端口是否用错。`);
		return 1;
	}
	log(`③ 启动引擎（${args.dsh} web，等待最长 ${Math.round(args.waitMs / 1000)}s）…`);
	const result = await startEngineWithQuarantine({
		profileDir: args.profile, dshCmd: args.dsh, isolateFailedEntries, waitMs: args.waitMs, cwd: args.cwd
	});
	if (result.ok) {
		if (result.quarantined && result.quarantined.length > 0) {
			log(`⚠ 运行期失败条目已自动隔离（${result.quarantined.join(", ")}）并重试成功`);
			log(`✓ ${result.message}`);
		} else {
			log(`✓ ${result.message}`);
		}
		log(`→ 正在打开 http://127.0.0.1:${ENGINE_PORT}/（若浏览器未自动跳转，请手动打开）`);
		return 0;
	}
	// 失败信息里 startEngine 已带日志绝对路径与日志尾部
	log(`✗ ${result.message}`);
	if (result.quarantineMessage) log(`  隔离尝试：${result.quarantineMessage}`);
	if (result.failedEarly) log(`  （引擎进程立刻退出：已提前判定失败，未空等超时）`);
	log(`  可打开 ${entryUrlOf(launcherPortFromEnv())} 使用独立救援中心，或运行 --repair-only 排查`);
	return 1;
}

/**
 * `--rescue-profile`：走官方通道建/重建救援 profile 并启动它。
 * 红线 2：桌面 profile 下一律拒绝（绝不 spawn 桌面 Host），退出码 3（安全门）。
 */
async function runRescueProfile(args, log) {
	const profileName = basename(args.profile);
	if (profileName.toLowerCase() === "desktop") {
		log("✗ 拒绝执行 --rescue-profile：桌面场景绝不 spawn / kill Host（契约红线 2）。");
		log("  code: desktop-delegated");
		log("  原因：--rescue-profile 走官方 `dsh rescue --from-default-profile <模板>`，该命令会**启动**救援 profile 的 Host；"
			+ "桌面版独占 profiles/desktop 与进程级单实例锁，引擎生命周期归 Electron（能力表 engineLifecycle: delegated）。");
		log("  请改用：① 从系统托盘完全退出 DeepSeek Harness 后重开；"
			+ "② 或 --heal-recovery 修复 cordis.patch.yml 归属行（只需文件读写，不需要启停 Host）。");
		log(`  也可以在**完全退出桌面版之后**，自行在终端执行官方命令：${args.dsh} rescue --from-default-profile ${DEFAULT_TEMPLATE}`);
		return 3;
	}

	// 引擎已在跑 → 不重建：官方 --from-default-profile 是「重建」（会删掉现有 rescue 目录与备份），
	// 且新 Host 会和现有引擎抢同一个端口。
	const health = await engineHealth(ENGINE_PORT);
	if (health.ok) {
		log(`✓ 引擎已在 ${ENGINE_PORT} 运行（HTTP 握手正常），无需救援重建；未改动任何 profile。`);
		log(`  说明：官方 --from-default-profile 是「重建」——它会删除现有 ${RESCUE_PROFILE_NAME} 目录（含 cordis.patch.yml 与 .rescue-bak-* 备份），`
			+ `且新 Host 会和现有引擎抢 ${ENGINE_PORT}。真要重建请先停掉引擎。`);
		return 0;
	}
	if (await probe(ENGINE_PORT)) {
		const owner = portOwner(ENGINE_PORT);
		log(`✗ 端口 ${ENGINE_PORT} 被${owner ? ` pid ${owner}` : "其他进程"}占用，但它不是 dsh 引擎（HTTP 握手失败）。`);
		log(`  救援 profile 启动后会监听 ${ENGINE_PORT}，现在启动必然失败；请先释放该端口再重试。未改动任何 profile。`);
		return 1;
	}

	const homeInfo = resolveDshHome({ profileDir: args.profile, env: process.env });
	log(`① 走官方通道重建救援 profile（DSH_HOME=${homeInfo.home}；来源：${homeInfo.source}）…`);
	const build = await buildRescueProfile({
		dshHome: homeInfo.home,
		sourceTemplate: DEFAULT_TEMPLATE,
		profileName: RESCUE_PROFILE_NAME,
		dshCmd: args.dsh,
		dryRun: false,
		// 追加给 web 应用的参数（官方 CLI 的自身开关必须在前，其余原样透传给应用）
		extraArgs: ["--port", String(ENGINE_PORT), "--no-open"],
		cwd: args.cwd,
		logDir: join(homeInfo.home, "logs")
	});
	for (const step of build.steps) log(step);
	if (build.warnings.length > 0) for (const warning of build.warnings) log(`⚠ ${warning}`);
	log(`理由：${build.reason}`);

	if (!build.ok) {
		log(`✗ 救援 profile 创建/启动失败（code: ${build.code}）。`);
		if (build.logPath) log(`  日志：${build.logPath}`);
		if (build.command) log(`  可手动重跑官方命令：${build.command}`);
		return build.code === "desktop-delegated" ? 3 : 1;
	}

	log(`② 等待救援引擎就绪（端口 ${ENGINE_PORT}，最长 ${Math.round(args.waitMs / 1000)}s）…`);
	const ready = await waitForEngine(ENGINE_PORT, args.waitMs, 300, engineHealth);
	if (ready) {
		log(`✓ 救援引擎已就绪：http://127.0.0.1:${ENGINE_PORT}/`);
		log(`  这个 profile 完全来自出厂模板（${build.profileDir}），没继承你 web profile 的第三方插件 —— 引擎坏掉时用它进得去。`);
		return 0;
	}
	log("✗ 救援引擎在超时内未通过 HTTP 健康检查（可能是命令立刻退出或域名/端口冲突）。");
	if (build.logPath) log(`  日志：${build.logPath}`);
	log(`  可手动重跑官方命令：${build.command}`);
	return 1;
}

/**
 * `--heal-recovery`：官方恢复之后从侧车 + 备份重建归属行。
 * 默认 dry-run（只打印计划）；`--apply` 才写，且需要 `--confirm <profileName>`（+ desktop 的 `--allow-desktop`）。
 */
async function runHealRecovery(args, log) {
	const profileDir = args.profile;
	const profileName = basename(profileDir);
	const isDesktop = profileName.toLowerCase() === "desktop";
	log(`profile：${profileDir}${isDesktop ? "（desktop：Electron 独占，drydock 只做 cordis.patch.yml 级可逆写）" : ""}`);

	log("① 检测官方恢复痕迹（只读）…");
	const traces = detectOfficialRecoveryTraces({ profileDir });
	for (const item of traces.evidence) log(`  · [${item.code}] ${item.detail}`);
	log(`  结论：${traces.detected ? "检测到官方恢复痕迹" : "未检测到官方恢复痕迹"}（置信度 ${traces.confidence}）——${traces.reason}`);

	log("② 生成自愈计划（只读，不写盘）…");
	const plan = planSelfHeal({ profileDir });
	for (const line of plan.message.split("\n")) log(`  ${line}`);
	if (plan.bomStripped.length > 0) log(`  ⚠ BOM：已识别并剥离 ${plan.bomStripped.length} 处（写盘一律无 BOM）`);

	if (plan.willRestore.length + plan.willAdd.length === 0) {
		log("✓ 无需恢复：侧车与备份里的归属行都已在 patch 中（或没有可用备份）。未改动任何文件。");
		return 0;
	}

	if (!args.apply) {
		log("ℹ 默认 dry-run：以上只是计划，**未写盘**。");
		log(`  要真正执行：--heal-recovery --apply --confirm ${profileName}${isDesktop ? " --allow-desktop" : ""}`);
		if (isDesktop && plan.desktopLocked) log("  ⚠ 该 desktop profile 现在被 Electron 持锁：真执行会被拒绝（code: desktop-locked）——请先从系统托盘完全退出。");
		return 0;
	}

	// ---- 安全门（与 lib/rescue-profile.mjs 同序；这里先给出更直白的中文原因）
	if (isDesktop && !args.allowDesktop) {
		log("✗ 拒绝写盘：没有 --allow-desktop。");
		log("  原因：desktop profile 由 Electron 独占（F8）；写盘必须先由人显式允许（这是刻意的双确认之一）。");
		log(`  本次未改动任何文件。确认后重跑：--heal-recovery --apply --confirm ${profileName} --allow-desktop`);
		return 3;
	}
	if (typeof args.confirm !== "string" || args.confirm === "" || args.confirm !== profileName) {
		log(`✗ 拒绝写盘：二次确认不匹配（需要 --confirm ${profileName}${typeof args.confirm === "string" && args.confirm !== "" ? `，收到 ${args.confirm}` : "，当前未提供"}）。`);
		log("  原因：自愈会改写 cordis.patch.yml，必须由人确认**目标 profile 名**（双确认的另一半）。");
		log("  本次未改动任何文件。");
		return 3;
	}

	log("③ 执行自愈（写前备份 → 只动带归属标记的行 → 复检）…");
	log(`  目标 profile：${profileName}${isDesktop ? "（desktop）" : ""}`);
	for (const row of plan.willRestore) log(`  · 将改动：${row.name ?? row.id}（disabled: ${row.disabled}，${row.action}）`);
	for (const row of plan.willAdd) log(`  · 将改动：${row.name ?? row.id}（disabled: ${row.disabled}，来源 ${row.from}）`);

	const heal = selfHealAfterRecovery({ profileDir, dryRun: false, confirm: args.confirm, allowDesktop: args.allowDesktop === true });
	for (const line of heal.message.split("\n")) log(`  ${line}`);
	if (!heal.ok) {
		const zeroChange = heal.code === "desktop-locked" || heal.code === "confirm-required" || heal.code === "desktop-not-allowed" || heal.code === "backup-failed" || heal.code === "read-failed";
		log(`✗ 自愈未完成（code: ${heal.code}）——${zeroChange ? "整个目录一个字节都没变" : "已回滚到写前状态（见上面说明）"}。`);
	}
	if (heal.ok) {
		log(`✓ 自愈完成（code: ${heal.code}）${heal.backupPath ? `；写前备份：${heal.backupPath}` : ""}`);
		log("  注意：改的是 patch 行，**不是**已装包。下次引擎启动时这些归属行会重新生效；第三方插件更新/重装后仍建议跑一次 verify。");
		return 0;
	}
	if (heal.code === "desktop-locked" || heal.code === "confirm-required" || heal.code === "desktop-not-allowed") return 3;
	return 1;
}

/**
 * 只在"直接运行本文件"时执行入口（被 import 时不执行，便于测试）。
 * 语义与 bin/open-boot.mjs:776-792 完全对齐（同一判定，不另写一套）。
 */
function isDirectRun() {
	if (process.env.DSH_LAUNCHER_IMPORT_ONLY === "1") return false;
	const entry = process.argv[1];
	// argv[1] 缺失（`node -e "import(...)"` / `--input-type=module -e`）说明不是"运行脚本"：
	// 此时若判成直接运行，会在 import 时就地启动引擎/改 cwd。→ 一律不执行入口。
	if (!entry) return false;
	const norm = (p) => {
		try { return realpathSync(p).replace(/\\/g, "/").toLowerCase(); }
		catch { try { return resolve(p).replace(/\\/g, "/").toLowerCase(); } catch { return p; } }
	};
	return norm(entry) === norm(SELF);
}

if (isDirectRun()) {
	const code = await main();

	// 可见启动窗口模式：把结果留在屏幕上，等按键再关（非交互场景不阻塞）
	if (parseArgs(process.argv.slice(2)).pause && process.stdin.isTTY) {
		try { process.title = "DSH 启动器"; } catch { }
		process.stdout.write(code === 0 ? "\n按任意键关闭此窗口…" : "\n启动未成功，按任意键关闭此窗口…");
		await new Promise((resolveWait) => {
			try { process.stdin.setRawMode(true); } catch { }
			process.stdin.resume();
			process.stdin.once("data", () => {
				try { process.stdin.setRawMode(false); } catch { }
				process.stdin.pause();
				resolveWait();
			});
		});
	}
	process.exit(code);
}

export { HELP_TEXT, main, parseArgs };
