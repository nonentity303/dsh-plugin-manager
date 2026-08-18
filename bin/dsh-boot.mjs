#!/usr/bin/env node
/**
 * dsh-boot.mjs — Steam 式启动序列（P1-1）。
 *
 * 流程：verify（启动前自检）→ 有问题自动 fix（隔离坏 bundle，可逆）→ 拉起 `dsh web` → 健康等待。
 * 相当于在引擎启动前设一道"安检"，坏插件被自动拦下，避免主进程崩溃。
 *
 * 用法：
 *   node bin/dsh-boot.mjs [--profile <dir>] [--dsh <cmd>] [--repair-only] [--wait-ms <n>]
 *   --repair-only  只执行 verify+fix，不启动引擎（供 watchdog 调用）
 *
 * 退出码：
 *   0 = 引擎已就绪（或 repair-only 下 profile 健康）
 *   1 = 启动后仍未就绪（或 fix 无法解决）
 *   2 = verify 发现问题且 fix 后仍有问题（repair-only）
 */
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { verifyProfile, fixProfile } from "../lib/preflight.mjs";
import { ENGINE_PORT, probe, startEngine } from "../lib/enginectl.mjs";

const PROFILE_DEFAULT = join(homedir(), ".dsh", "profiles", "web");

function parseArgs(argv) {
	const args = { profile: PROFILE_DEFAULT, dsh: "dsh", repairOnly: false, waitMs: 45000 };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--profile" && argv[i + 1]) { args.profile = resolve(argv[++i]); }
		else if (argv[i] === "--dsh" && argv[i + 1]) { args.dsh = argv[++i]; }
		else if (argv[i] === "--wait-ms" && argv[i + 1]) { args.waitMs = Number(argv[i + 1]) || 45000; i++; }
		else if (argv[i] === "--repair-only") { args.repairOnly = true; }
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const log = (line) => console.log(`[dsh-boot] ${line}`);

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
				process.exit(2);
			}
		}
	} else {
		log("✓ profile 配置正常");
	}

	if (args.repairOnly) {
		log("repair-only 模式结束：退出码 0");
		process.exit(0);
	}

	// 3) 启动
	if (await probe(ENGINE_PORT)) {
		log(`✓ 引擎已在 ${ENGINE_PORT} 运行，无需启动`);
		process.exit(0);
	}
	log(`③ 启动引擎（${args.dsh} web，等待最长 ${Math.round(args.waitMs / 1000)}s）…`);
	const result = await startEngine({ profileDir: args.profile, dshCmd: args.dsh, waitMs: args.waitMs });
	if (result.ok) {
		log(`✓ ${result.message}`);
		process.exit(0);
	}
	log(`✗ ${result.message}`);
	if (result.log) log(`  日志：${result.log}`);
	log("  可打开 http://127.0.0.1:3081/ 使用独立救援中心，或运行 --repair-only 排查");
	process.exit(1);
}

await main();
