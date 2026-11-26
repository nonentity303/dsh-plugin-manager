#!/usr/bin/env node
/**
 * drydock-doctor.mjs — 离线只读诊断报告 CLI（1.1.0 桌面版支持 M4）。
 *
 * 设计目标（用户视角）：Electron 起不来的时候，普通用户不会开终端、不知道 DSH_HOME
 * 在哪、看不懂 cordis.patch.yml、连日志在哪也不知道。这条命令要能一条命令产出
 * **一份用户能直接粘贴给插件作者/官方**的诊断文本，且**零风险**：
 *   - 默认只把中文报告打到 stdout，**不落盘**；
 *   - 不写 profile、不启停进程、不解析日志取 token（详见 lib/diagnostics.mjs 的只读承诺）。
 *
 * 用法（对齐 bin/dsh-boot.mjs 的风格：--help / isDirectRun() 保护 / 退出码语义）：
 *   node bin/drydock-doctor.mjs               人读中文报告（stdout）
 *   node bin/drydock-doctor.mjs --json        机器可读 JSON（stdout）
 *   node bin/drydock-doctor.mjs --out <file>  同时落盘（默认不落盘；落盘路径打印到 stderr）
 *   node bin/drydock-doctor.mjs --profile web 聚焦某个 profile（名称或目录）
 *   node bin/drydock-doctor.mjs --home D:\x 覆盖 DSH_HOME
 *   node bin/drydock-doctor.mjs --include-logs / --no-logs  是否包含日志尾部（默认不含）
 *
 * 退出码：
 *   0 = 收集完成（**即使有 unavailable 段**也算成功：缺数据不等于失败）
 *   1 = 完全无法定位 DSH_HOME（或 --out 报告落盘失败）
 *   2 = 参数错误（未知参数 / 选项缺取值 / --include-logs 与 --no-logs 互斥）
 *
 * 注意：本文件**不注册进 package.json 的 bin**（那是共享文件，由 lead 统一改）；
 * 建议的 bin 行见交付说明。
 */
import { realpathSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { collectDiagnostics, defaultResourcesDirs, renderReport, SCHEMA } from "../lib/diagnostics.mjs";

const SELF = fileURLToPath(import.meta.url);

const HELP_TEXT = `dsh-drydock 离线只读诊断报告（drydock-doctor）

用法：
  node bin/drydock-doctor.mjs [选项]

选项：
  --json            输出机器可读 JSON（默认输出人读中文报告）
  --out <file>      同时把报告写入文件（默认不落盘；落盘绝对路径打印到 stderr）
  --profile <name|dir>
                    只聚焦某个 profile（名称如 web / desktop，或直接给目录）
  --home <dir>      覆盖 DSH_HOME（默认按 $DSH_HOME > ~/.dsh 解析）
  --include-logs    包含引擎日志尾部（每 profile 最多 64 KiB，官方 stderr 口径）
  --no-logs         不包含引擎日志尾部（默认行为；与 --include-logs 互斥）
  --help, -h        显示本帮助

报告内容（数据源按官方桌面版诊断文档 + 真包静态分析）：
  · 环境 / DSH_HOME 与全部候选（解析优先级：--home > $DSH_HOME > ~/.dsh）
  · profile 清单：package.json、cordis.patch.yml（大小/BOM/是否空 patch/条目数）、
    lock、.open-boot.pid、drydock 侧车 plugin-manager.json、.dsh-market/state.json
  · 桌面 profile 状态：是否初始化、lock 内容（截断 200 字符）、dsh.profile.bundles
  · 桌面宿主：安装目录 resources/app.asar/dsh/desktop-runtime.json 的 release
    （version / hostProtocolVersion / nodeVersion / pnpmVersion，只读前部、不整读 4.7 MB）、
    resources/runtime/versions.json、桌面自带 CLI（不是 npm 的 dsh）
  · 官方恢复痕迹检测（空 patch + cordis.patch.yml.bak-<时间戳> → 建议"恢复后自愈"）
  · 崩溃报告 <userData>/logs/crash-<UTC>-<source>.log（最新 3 份，每份只读前 4 KiB）
  · 插件操作记录 <userData>/plugin-operations（最多 100 条 / 64 KiB）
  · 端口事实：候选端口清单 + 每个端口是否有监听（**不**据此断言引擎健康）

退出码：
  0 = 收集完成（即使有"不可用"段）
  1 = 完全无法定位 DSH_HOME（或报告落盘失败）
  2 = 参数错误（含 --out 指向桌面安装目录：那里只读，拒绝写入）

示例：
  node bin/drydock-doctor.mjs --profile desktop --json --out .\\doctor.json
  node bin/drydock-doctor.mjs --home "D:\\dsh-home" --include-logs
  DSH_DESKTOP_RESOURCES_DIR="C:\\...\\resources" node bin/drydock-doctor.mjs   # 已解包的安装目录

说明：报告已脱敏（令牌/密钥/邮箱/绝对路径里的用户名）；含"不可用"段属正常，
      表示那一项在你这台机器上不存在（例如没装桌面版就没有崩溃报告）。
      桌面安装目录里的 app.asar / desktop-runtime.json 只读，不会写；--out 默认不落盘，
      显式落盘时写到用户指定路径（落在桌面安装目录会被拒绝）。
`;

/**
 * 解析 argv。错误进 `errors`（由 main 转成退出码 2），不在解析阶段直接退出。
 */
function parseArgs(argv) {
	const args = {
		help: false,
		json: false,
		out: null,
		profile: null,
		home: null,
		includeLogs: false,
		errors: []
	};
	const wantValue = (option, index) => {
		const value = argv[index + 1];
		if (value === undefined || value === "" || (value.startsWith("-") && value !== "-")) {
			args.errors.push(`选项 ${option} 缺少取值`);
			return null;
		}
		return value;
	};
	let sawInclude = false;
	let sawNoLogs = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case "--help":
			case "-h":
				args.help = true;
				break;
			case "--json":
				args.json = true;
				break;
			case "--include-logs":
				sawInclude = true;
				break;
			case "--no-logs":
				sawNoLogs = true;
				break;
			case "--out": {
				const value = wantValue(argument, index);
				if (value !== null) {
					args.out = value;
					index += 1;
				}
				break;
			}
			case "--profile": {
				const value = wantValue(argument, index);
				if (value !== null) {
					args.profile = value;
					index += 1;
				}
				break;
			}
			case "--home": {
				const value = wantValue(argument, index);
				if (value !== null) {
					args.home = value;
					index += 1;
				}
				break;
			}
			default:
				if (argument.startsWith("-")) args.errors.push(`无法识别的参数 ${argument}`);
				else args.errors.push(`多余的位置参数 ${argument}`);
				break;
		}
	}
	if (sawInclude && sawNoLogs) args.errors.push("--include-logs 与 --no-logs 互斥，只能选一个");
	args.includeLogs = sawInclude;
	return args;
}

/**
 * 桌面安装目录只读：`--out` 落在 `<安装目录>/resources` 里一律拒绝（app.asar / desktop-runtime.json
 * 只读）。返回"包含该目标的安装目录"或 null。
 */
function installDirContaining(target) {
	const normalized = target.replace(/\//g, "\\").toLowerCase();
	for (const dir of defaultResourcesDirs({})) {
		const base = dir.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
		if (normalized === base || normalized.startsWith(`${base}\\`)) return dir;
	}
	return null;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stdout.write(HELP_TEXT);
		return 0;
	}
	if (args.errors.length > 0) {
		console.error(`[drydock-doctor] 参数错误：${args.errors.join("；")}`);
		console.error("[drydock-doctor] 用 --help 查看用法。");
		return 2;
	}
	const outTarget = args.out ? resolve(args.out) : null;
	if (outTarget) {
		const blocked = installDirContaining(outTarget);
		if (blocked) {
			console.error(`[drydock-doctor] 拒绝把报告写进桌面安装目录：${outTarget}`);
			console.error(`[drydock-doctor] 安装目录（${blocked}）里的 app.asar / desktop-runtime.json 只读；请换一个输出路径。退出码 2`);
			return 2;
		}
	}

	const diagnostics = await collectDiagnostics({
		dshHome: args.home,
		profile: args.profile,
		includeLogs: args.includeLogs
	});
	const text = args.json ? JSON.stringify(diagnostics, null, 2) : renderReport(diagnostics);
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

	if (args.out) {
		const target = outTarget ?? resolve(args.out);
		try {
			writeFileSync(target, text.endsWith("\n") ? text : `${text}\n`, "utf8");
		} catch (error) {
			// 落盘失败不影响已经打到 stdout 的报告；但明确报错 + 非 0 退出，绝不静默
			console.error(`[drydock-doctor] 报告落盘失败：${target}（${error.code ?? error.message}）；上面的报告仍已输出到 stdout。`);
			return 1;
		}
		console.error(`[drydock-doctor] 报告已写入：${target}（未使用 --out 时默认不落盘）`);
	}

	if (!diagnostics.home.resolved) {
		console.error(`[drydock-doctor] 无法定位 DSH_HOME（见报告「DSH_HOME」段）：可用 --home <dir> 指定。退出码 1`);
		return 1;
	}
	return 0;
}

/**
 * 只在"直接运行本文件"时执行入口（被 import 时不执行，便于测试）。
 * 语义与 bin/dsh-boot.mjs:151-162 完全对齐（同一判定，不另写一套）。
 */
function isDirectRun() {
	if (process.env.DSH_LAUNCHER_IMPORT_ONLY === "1") return false;
	const entry = process.argv[1];
	if (!entry) return false;
	const norm = (path) => {
		try {
			return realpathSync(path).replace(/\\/g, "/").toLowerCase();
		} catch {
			try {
				return resolve(path).replace(/\\/g, "/").toLowerCase();
			} catch {
				return path;
			}
		}
	};
	return norm(entry) === norm(SELF);
}

if (isDirectRun()) {
	process.exit(await main());
}

export { HELP_TEXT, SCHEMA, main, parseArgs };
