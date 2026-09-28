#!/usr/bin/env node
/**
 * dsh-boot.mjs — Steam 式启动序列（P1-1）。
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
 * 用法：
 *   node bin/dsh-boot.mjs [--profile <dir>] [--dsh <cmd>] [--repair-only] [--wait-ms <n>] [--pause] [--cwd <dir>]
 *   --repair-only  只执行 verify+fix，不启动引擎（供 watchdog 调用）
 *   --pause        结束时等按键再关闭窗口（供 open-boot 弹出的可见启动窗口使用）
 *   --help         显示用法
 *
 * 退出码：
 *   0 = 引擎已就绪（或 repair-only 下 profile 健康）
 *   1 = 启动后仍未就绪（或 fix 无法解决）
 *   2 = verify 发现问题且 fix 后仍有问题（repair-only）
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyProfile, fixProfile, isolateFailedEntries } from "../lib/preflight.mjs";
import { ENGINE_PORT, chdirStable, engineHealth, portOwner, probe, startEngineWithQuarantine } from "../lib/enginectl.mjs";

const SELF = fileURLToPath(import.meta.url);
const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");

const HELP_TEXT = `DSH 启动序列（自检 → 修复 → 启动 → 健康等待）

用法：
  node bin/dsh-boot.mjs [选项]

选项：
  --profile <dir>   profile 目录（默认 ~/.dsh/profiles/web）
  --dsh <cmd>       启动引擎的命令（默认 dsh；含空格的路径也可用）
  --repair-only     只执行 verify + fix，不启动引擎（退出码 0=健康 / 2=修复后仍有问题）
  --wait-ms <n>     启动后等待引擎就绪的最长时间（默认 45000）
  --pause           结束时等按键再关闭窗口（供 open-boot 弹出的可见启动窗口使用）
  --cwd <dir>       引擎工作目录（默认用户主目录，避免锁住包目录）
  --help            显示本帮助

退出码：0=就绪 / 1=未就绪 / 2=repair-only 修复未完成
`;

function parseArgs(argv) {
	const args = { profile: PROFILE_DEFAULT, dsh: "dsh", repairOnly: false, waitMs: 45000, pause: false, help: false, cwd: null, unknown: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile" && argv[i + 1]) { args.profile = resolve(argv[++i]); }
		else if (argv[i] === "--dsh" && argv[i + 1]) { args.dsh = argv[++i]; }
		else if (argv[i] === "--cwd" && argv[i + 1]) { args.cwd = resolve(argv[++i]); }
		// 只自增一次（历史 bug 见审计③ L6）
		else if (argv[i] === "--wait-ms" && argv[i + 1]) { args.waitMs = Number(argv[++i]) || 45000; }
		else if (argv[i] === "--repair-only") { args.repairOnly = true; }
		else if (argv[i] === "--pause") { args.pause = true; }
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
	// 稳定 cwd（审计③ L2）：引擎的 cwd 不能落在本包 node_modules / profile 目录里
	chdirStable(args.cwd);

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
		log(`  拒绝把它当成"引擎已就绪"；请先结束该进程（任务管理器 / 3081 救援页），或确认 profile/端口是否用错。`);
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
	log(`  可打开 http://127.0.0.1:3081/ 使用独立救援中心，或运行 --repair-only 排查`);
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
