#!/usr/bin/env node
/**
 * test-isolation.mjs — 「桌面代码不得污染网页运行时」的静态契约（离线、零依赖、无网络、无 spawn）。
 *
 * 背景（为什么需要它）：桌面版支持（1.1.0 那条线）实测是 **+9,375/−44** 的改动，其中
 * `lib/` 下 5 个桌面专用模块共 4,683 行 —— 但如果网页宿主（lib/index.js，DSH 在网页形态里加载的入口）
 * **静态 import** 了任何一个会探测环境 / 读写盘 / 起进程的桌面模块，那么所有网页用户都会承担它的副作用。
 * 本文件把这条边界钉成断言：
 *
 *   ① host 入口的本地静态 import 必须落在白名单内（新增模块 = 显式改白名单，逼你写一句理由）；
 *   ② 桌面专用模块（capabilities / envprobe / diagnostics / rescue-profile / lib/desktop/**）
 *      禁止被 host 入口或客户端 bundle 源码静态 import；
 *   ③ host 入口不得直接 import `bin/**`（那是独立进程，不是运行时依赖）；
 *   ④ （可选，`--budget <baseRef>`）"污染预算"：本次改动落在热文件上的行数超过阈值就 FAIL。
 *
 * ④ 需要 `git`（会 spawn 子进程）。本机受限沙箱里 spawn 会 EPERM —— 此时打印 SKIP 并**不影响**前三项的结论，
 * 也不会把"没测"伪装成"通过"（口径：SKIP ≠ PASS）。
 *
 * 用法：
 *   node test-isolation.mjs                 # 只跑 ①②③（发布前必跑）
 *   node test-isolation.mjs --budget origin/master   # 额外跑污染预算
 *
 * 退出码：0 = 全部通过（允许 SKIP）；1 = 有 FAIL。
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * host 入口允许的本地模块（白名单：**只增不改**，每加一个都要能说清"它是纯函数、无副作用"）。
 * 现状依据：lib/index.js 的 7 个本地依赖全是纯计算/资源模块。
 */
const HOST_ALLOWED_LOCAL = new Set([
	"./rescue.js",
	"./ports.mjs",
	"./readme-intro.js",
	"./platform.js",
	"./aggregate.js",
	"./compare-versions.js",
	"./downloader.js",
	// 桌面支持合并后唯一允许新增的 host 侧依赖：纯函数目录/分区计算，无 I/O、无进程、无探测。
	"./bundles-official.mjs",
]);

/** 桌面专用（或进程专用）模块：绝不允许进入网页宿主运行时。 */
const FORBIDDEN_IN_HOST = [
	/capabilities\.mjs$/,
	/envprobe\.mjs$/,
	/diagnostics\.mjs$/,
	/rescue-profile\.mjs$/,
	/(^|\/)desktop\//,
	/^\.\.\/bin\//,
];

/** 污染预算：单次改动落在这些"热文件"上的增删行数上限（超过就要打 desktop-change 标签并说明 web 影响面）。 */
const HOT_FILES = [
	"lib/enginectl.mjs",
	"bin/open-boot.mjs",
	"bin/rescue-daemon.mjs",
	"bin/dsh-boot.mjs",
	"lib/index.js",
	"src/client.jsx",
];
const BUDGET = { add: 80, del: 20 };

const results = [];
function check(name, fn) {
	let detail = "";
	let ok = false;
	try {
		detail = fn() ?? "";
		ok = true;
	} catch (error) {
		detail = error instanceof Error ? error.message : String(error);
	}
	results.push({ name, ok, detail });
}
function skip(name, reason) {
	results.push({ name, ok: true, skipped: true, detail: reason });
}

function readText(rel) {
	const file = join(ROOT, rel);
	if (!existsSync(file)) throw new Error(`文件不存在：${rel}`);
	return readFileSync(file, "utf8");
}

/**
 * 抽取模块的**静态** import 说明符（不含动态 import()）。
 * 覆盖三种写法：`import x from "m"`、多行 `} from "m"`、副作用 `import "m"`。
 */
function staticImportsOf(source) {
	const specifiers = new Set();
	const patterns = [
		/^[ \t]*import\s+(?:[^"'()]*?\s+from\s+)?"([^"]+)"/gm,
		/^[ \t]*\}\s*from\s+"([^"]+)"/gm,
	];
	for (const re of patterns) {
		for (const m of source.matchAll(re)) specifiers.add(m[1]);
	}
	return [...specifiers];
}

const isLocal = (spec) => spec.startsWith("./") || spec.startsWith("../");

// ── ① host 入口本地依赖白名单 ───────────────────────────────
check("host 入口（lib/index.js）只 import 白名单内的本地模块", () => {
	const imports = staticImportsOf(readText("lib/index.js"));
	const local = imports.filter(isLocal);
	const outside = local.filter((s) => !HOST_ALLOWED_LOCAL.has(s));
	if (outside.length > 0) {
		throw new Error(
			`host 新增了白名单外的本地依赖：${outside.join(", ")}\n` +
				`    若它是纯函数模块，请在 test-isolation.mjs 的 HOST_ALLOWED_LOCAL 里加一行并说明理由；\n` +
				`    若它探测环境/读写盘/起进程，请改成「由 bin/** 引用」或「运行时注入」，不要进 host。`,
		);
	}
	return `本地依赖 ${local.length} 个：${local.join(", ")}`;
});

// ── ② 桌面专用模块不得进入 host 或客户端源码 ────────────────
for (const entry of ["lib/index.js", "src/client.jsx"]) {
	check(`${entry} 不静态 import 桌面专用模块`, () => {
		const imports = staticImportsOf(readText(entry));
		const hits = imports.filter((s) => FORBIDDEN_IN_HOST.some((re) => re.test(s)));
		if (hits.length > 0) throw new Error(`命中了禁止项：${hits.join(", ")}`);
		return `${imports.length} 个 import，命中 0`;
	});
}

// ── ③ host 不得依赖 bin/** ────────────────────────────────
check("host 入口不 import bin/**（启动器是独立进程）", () => {
	const imports = staticImportsOf(readText("lib/index.js"));
	const hits = imports.filter((s) => /bin\//.test(s));
	if (hits.length > 0) throw new Error(`命中了：${hits.join(", ")}`);
	return "命中 0";
});

// ── ④ 污染预算（可选，需要 git）────────────────────────────
const budgetIdx = process.argv.indexOf("--budget");
if (budgetIdx >= 0) {
	const base = process.argv[budgetIdx + 1];
	if (!base || base.startsWith("--")) {
		results.push({ name: "污染预算（--budget <baseRef>）", ok: true, skipped: true, detail: "未给 baseRef，跳过" });
	} else {
		let numstat = null;
		let gitError = null;
		try {
			numstat = execFileSync("git", ["diff", "--numstat", `${base}...HEAD`], { cwd: ROOT, encoding: "utf8" });
		} catch (error) {
			gitError = error instanceof Error ? error.message : String(error);
		}
		if (numstat === null) {
			skip("污染预算", `git 不可用（受限沙箱的已知边界，不是缺陷）：${String(gitError).split("\n")[0]}`);
		} else {
			check(`热文件污染预算（≤ +${BUDGET.add}/−${BUDGET.del}） vs ${base}`, () => {
				const rows = numstat
					.split("\n")
					.filter(Boolean)
					.map((line) => line.split("\t"))
					.map(([add, del, file]) => ({ add: Number(add) || 0, del: Number(del) || 0, file: file.replace(/^"|"$/g, "") }))
					.filter((r) => HOT_FILES.includes(r.file));
				const over = rows.filter((r) => r.add > BUDGET.add || r.del > BUDGET.del);
				const summary = rows.map((r) => `${r.file} +${r.add}/−${r.del}`).join("；") || "热文件 0 处改动";
				if (over.length > 0) {
					throw new Error(
						`超预算：${over.map((r) => `${r.file} +${r.add}/−${r.del}`).join("；")}\n` +
							`    处理：在 PR 里打 desktop-change 标签并逐条写"web 影响面"；若已连续两轮超预算，重评估是否拆线。`,
					);
				}
				return summary;
			});
		}
	}
}

// ── 汇总 ──────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
for (const r of results) {
	const tag = r.skipped ? "SKIP" : r.ok ? "OK  " : "FAIL";
	console.log(`[${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
if (failed.length > 0) {
	console.error(`\n${failed.length} 项失败（SKIP ${skipped.length} 项不算通过）`);
	process.exit(1);
}
console.log(`\nALL ISOLATION TESTS PASSED (${results.length - skipped.length} checks, ${skipped.length} skipped)`);
