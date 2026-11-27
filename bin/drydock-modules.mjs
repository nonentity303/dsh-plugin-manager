#!/usr/bin/env node
/**
 * dsh-drydock-modules — 环境剥离审计（1.1.0 起）
 *
 * 回答三个问题，一条命令：
 *   1. 这台机器上的 drydock 认为自己跑在**哪种宿主**（web / desktop / unknown），凭什么这么判；
 *   2. 按该形态，**哪些环境专属模块会被装载、哪些被剥离**（剥离 = 连 import 都不发生）；
 *   3. 「本环境永远不会执行的代码」共有多少行、分别是哪些文件 —— 这就是"死代码审查"的输入清单。
 *
 * 用法：
 *   npx dsh-drydock-modules                  # 人读报告（不 import 任何环境专属模块）
 *   npx dsh-drydock-modules --json           # 机器可读（CI / issue 里可直接贴）
 *   npx dsh-drydock-modules --audit          # 只列被剥离的文件 + 行数 + 理由
 *   npx dsh-drydock-modules --refresh        # 强制重新探测并覆盖画像（换机器/换安装方式后用）
 *   npx dsh-drydock-modules --load           # 真正装载适用模块（验证"该装的装得起来"）
 *   npx dsh-drydock-modules --profile <名>   # 只看某个 profile 的判定？—— 本命令是**机器级**的，不吃 profile
 *
 * 退出码：0 = 正常；1 = 装载失败（仅 --load）；2 = 用法错误。
 */
import { ensureHostProfile, hostProfilePath, HOST_PROFILE_TTL_MS } from "../lib/host-profile.mjs";
import { auditModules, loadModules } from "../lib/host-registry.mjs";

const HELP = `用法: dsh-drydock-modules [--json] [--audit] [--refresh] [--load]

  （默认）   人读报告：形态判定 + 装载/剥离清单 + 剥离行数
  --json     机器可读（含 evidence 与每个模块的行数）
  --audit    只列被剥离的文件、行数与理由
  --refresh  强制重新探测并覆盖 host-profile.json
  --load     真正 import 适用模块（默认只算不装）
  --help     本帮助

画像文件：<DSH_HOME>/.drydock/host-profile.json（机器级；TTL ${Math.round(HOST_PROFILE_TTL_MS / 86400000)} 天）`;

function main(argv = process.argv.slice(2)) {
	const known = ["--json", "--audit", "--refresh", "--load", "--help", "-h"];
	const unknown = argv.filter((a) => !known.includes(a));
	if (unknown.length > 0) {
		console.error(`未知参数：${unknown.join(" ")}\n\n${HELP}`);
		return 2;
	}
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(HELP);
		return 0;
	}

	const json = argv.includes("--json");
	const auditOnly = argv.includes("--audit");
	const refresh = argv.includes("--refresh");

	const ensured = ensureHostProfile({ force: refresh });
	const form = ensured.profile.form;
	const audit = auditModules(form);
	const file = hostProfilePath(ensured.profile.dshHome ?? "");

	return run({ json, auditOnly, refresh, ensured, form, audit, file, argv }).catch((error) => {
		console.error(`环境剥离审计失败：${error instanceof Error ? error.message : String(error)}`);
		return 1;
	});
}

async function run({ json, auditOnly, refresh, ensured, form, audit, file, argv }) {
	const wantLoad = argv.includes("--load");
	const loadResult = wantLoad ? await loadModules(form) : null;

	if (json) {
		console.log(
			JSON.stringify(
				{
					schema: 1,
					generatedAt: new Date().toISOString(),
					hostProfile: { file, ...ensured.profile },
					cache: { source: ensured.source, firstLaunch: ensured.firstLaunch, expired: ensured.expired, writeOk: ensured.write?.ok !== false },
					audit,
					loaded: loadResult ? { loaded: loadResult.loaded, failed: loadResult.failed } : null
				},
				null,
				2
			)
		);
		return loadResult && loadResult.failed.length > 0 ? 1 : 0;
	}

	const p = ensured.profile;
	if (auditOnly) {
		console.log(`宿主形态：${form}（来源 ${p.source}）  画像：${file}`);
		if (audit.stripped.length === 0) {
			console.log("本环境没有需要剥离的环境专属模块（所有登记模块都适用）。");
			return 0;
		}
		console.log("");
		console.log("本环境永远不会执行的文件：");
		for (const item of audit.stripped) {
			console.log(`  - ${item.id}  ${item.file}  ${item.lines ?? "?"} 行`);
			console.log(`      能力键 ${item.capability} = ${JSON.stringify(item.value)}（需要 ${JSON.stringify(item.expect)}）`);
			console.log(`      理由：${item.reason}`);
		}
		console.log("");
		console.log(`合计剥离 ${audit.totalStrippedLines} 行（占登记模块 ${audit.totalStrippedLines + audit.totalLoadableLines} 行）。`);
		console.log("提示：新增环境专属模块时，在 lib/host-registry.mjs 的 ENV_MODULES 里登记一条，它就会自动进这份清单。");
		return 0;
	}

	console.log(`drydock 环境剥离审计${refresh ? "（已强制重新探测）" : ""}`);
	console.log(`  宿主形态   : ${form}（来源：${p.source}，置信度 ${p.confidence ?? "?"}）`);
	console.log(`  判定理由   : ${p.reason}`);
	console.log(`  画像文件   : ${file}`);
	console.log(`  首次探测   : ${p.firstLaunchAt}    最近探测：${p.profiledAt}`);
	if (p.previousForm && p.previousForm !== form) console.log(`  ⚠ 形态变化 : ${p.previousForm} → ${form}（已按新形态重算装载表）`);
	if (ensured.write && ensured.write.ok === false) console.log(`  ⚠ 画像写入失败：${ensured.write.error}（本次仍按探测结果执行）`);

	console.log("");
	console.log("装载（本环境需要，会 import）：");
	if (audit.loadable.length === 0) console.log("  （无）");
	for (const item of audit.loadable) {
		console.log(`  ✓ ${item.id.padEnd(18)} ${item.file}  ${item.lines ?? "?"} 行${item.capability ? `  [${item.capability}=${JSON.stringify(item.value)}]` : ""}`);
	}

	console.log("");
	console.log("剥离（本环境不需要，连 import 都不会发生）：");
	if (audit.stripped.length === 0) console.log("  （无）");
	for (const item of audit.stripped) {
		console.log(`  ✂ ${item.id.padEnd(18)} ${item.file}  ${item.lines ?? "?"} 行  [${item.capability}=${JSON.stringify(item.value)}]`);
		console.log(`      理由：${item.reason}`);
	}
	console.log("");
	console.log(`合计：装载 ${audit.totalLoadableLines} 行 / 剥离 ${audit.totalStrippedLines} 行（占登记模块 ${audit.totalLoadableLines + audit.totalStrippedLines} 行）。`);

	if (loadResult) {
		console.log("");
		console.log(`实际装载：${loadResult.loaded.length} 个（${loadResult.loaded.join(", ") || "无"}）`);
		for (const fail of loadResult.failed) console.log(`  ✘ ${fail.id} 装载失败：${fail.error}`);
	}

	console.log("");
	console.log("说明：剥离是**文件级**的（一个模块整体装载或整体剥离），所以环境专属逻辑必须独立成文件；");
	console.log("      边界由 test-isolation.mjs（host 侧 import 白名单）与 test-host-strip.mjs（本表）共同守。");
	return loadResult && loadResult.failed.length > 0 ? 1 : 0;
}

main().then((code) => process.exit(code));
