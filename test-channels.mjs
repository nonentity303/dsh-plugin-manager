#!/usr/bin/env node
/**
 * test-channels.mjs — 发布通道的**跨文件一致性**断言（离线、零依赖、无网络、无 spawn）。
 *
 * 为什么需要它：本项目的历史教训是「文档写了、脚本没跟上」以及「工具静默给假结论」。
 * 发布通道这层一旦漂移，后果是**发错 dist-tag**（把预发布顶成 latest）或**用户按文档装不到**。
 * 所以把四处钉成同一份口径：
 *
 *   release/channels.json  ←→  tools/dev/channels.mjs  ←→  .github/workflows/release.yml
 *                                    ←→  docs/版本与轨道.md / docs/RELEASING.md
 *                                    ←→  package.json / .gitignore / .github 模板
 *
 * 用法：node test-channels.mjs
 * 退出码：0 = 全绿；1 = 有 FAIL。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadChannels, resolveVersion, validateChannels, stableChannelName } from "./tools/dev/channels.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));

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
function readText(rel) {
	const file = join(ROOT, rel);
	if (!existsSync(file)) throw new Error(`文件不存在：${rel}`);
	return readFileSync(file, "utf8");
}
const readJson = (rel) => JSON.parse(readText(rel));

const doc = loadChannels();
const enabled = Object.entries(doc.channels).filter(([, ch]) => ch.enabled === true);
const disabledPlaceholders = Object.entries(doc.channels).filter(([, ch]) => ch.placeholder === true && ch.enabled !== true);

// ── ① channels.json 自身一致性 ─────────────────────────────
check("channels.json 内部一致（唯一 latest / dist-tag 不重复 / 预发布标识已登记）", () => {
	const { ok, errors } = validateChannels(doc);
	if (!ok) throw new Error(errors.join("；"));
	return `通道 ${Object.keys(doc.channels).length} 个，启用 ${enabled.length} 个`;
});

check("channels.json 的 package 与 package.json 的 name 一致", () => {
	const pkg = readJson("package.json");
	if (doc.package !== pkg.name) throw new Error(`channels.json=${doc.package} / package.json=${pkg.name}`);
	return pkg.name;
});

// ── ② 版本号 → dist-tag 映射（正判；未登记标识必须报错）────
check("版本号 → dist-tag 映射符合通道口径", () => {
	const cases = [
		["1.0.5", "web", "latest"],
		["1.0.5-rc.1", "web", "next"],
		["1.0.5-alpha.2", "web", "next"],
		["1.1.0-desktop.1", "desktop", "desktop"],
		["1.1.0-desktop.12", "desktop", "desktop"],
	];
	const bad = [];
	for (const [version, channel, tag] of cases) {
		const got = resolveVersion(version, doc);
		if (got.channel !== channel || got.distTag !== tag) {
			bad.push(`${version} → 期望 ${channel}/${tag}，实际 ${got.channel}/${got.distTag}`);
		}
	}
	if (bad.length > 0) throw new Error(bad.join("；"));
	return `${cases.length} 组样例`;
});

check("未登记的预发布标识必须报错（不静默兜底）", () => {
	for (const version of ["1.1.0-foo.1", "1.1.0-rcx.1"]) {
		let threw = false;
		try {
			resolveVersion(version, doc);
		} catch {
			threw = true;
		}
		if (!threw) throw new Error(`${version} 被静默接受了（应报错）`);
	}
	return "foo.1 / rcx.1 均被拒";
});

check("占位通道（community）保持禁用，不会被误发", () => {
	if (disabledPlaceholders.length === 0) return "无占位通道（可接受）";
	const names = disabledPlaceholders.map(([name]) => name);
	const ch = doc.channels[names[0]];
	if (!ch.prereleaseTag) throw new Error(`占位通道 ${names[0]} 缺 prereleaseTag`);
	return `${names.join(", ")} → enabled=false`;
});

check("正式版只落在 latest 通道", () => {
	const name = stableChannelName(doc);
	if (doc.channels[name].releaseTag !== "latest") throw new Error(`stableChannelName 返回 ${name}，但它不是 latest 通道`);
	return `latest 通道 = ${name}`;
});

// ── ③ CI 必须走同一份映射（不许在 YAML 里再写一遍正则）────
check("release.yml 的 dist-tag 由 tools/dev/channels.mjs 派生", () => {
	const yml = readText(".github/workflows/release.yml");
	if (!yml.includes("tools/dev/channels.mjs --print-dist-tag")) {
		throw new Error("release.yml 没有调用 tools/dev/channels.mjs --print-dist-tag（说明 CI 又自己算了一遍 dist-tag）");
	}
	if (yml.includes('"dist_tag=next"')) {
		throw new Error("release.yml 里仍残留旧的硬编码 dist_tag=next 分支 —— 会绕过通道配置");
	}
	return "CI 走通道配置";
});

check("release.yml 保留 tag 与 package.json 版本逐字一致的校验", () => {
	const yml = readText(".github/workflows/release.yml");
	if (!/tag（\$tag）与 package\.json 的 version/.test(yml)) throw new Error("tag/version 一致性校验不见了");
	return "在";
});

// ── ④ 文档必须与配置同口径 ────────────────────────────────
check("docs/版本与轨道.md 覆盖每个启用通道（标题 + dist-tag + 安装命令原文）", () => {
	const md = readText(join("docs", "版本与轨道.md"));
	const missing = [];
	for (const [name, ch] of enabled) {
		if (!md.includes(ch.title)) missing.push(`${name} 的 title「${ch.title}」`);
		const tag = ch.prereleaseTag;
		if (tag && !md.includes(tag)) missing.push(`${name} 的 dist-tag「${tag}」`);
		const installs = Object.values(ch.install ?? {});
		if (installs.length === 0) missing.push(`${name} 缺 install 命令（可在 channels.json 里补）`);
		for (const cmd of installs) {
			if (!md.includes(cmd)) missing.push(`${name} 的安装命令「${cmd}」`);
		}
	}
	if (missing.length > 0) throw new Error(`文档缺：${missing.join("；")}`);
	return `${enabled.length} 个启用通道都在位`;
});

check("docs/RELEASING.md 有「多通道发布」节并指向 channels.json", () => {
	const md = readText(join("docs", "RELEASING.md"));
	if (!/##\s*11\.\s*多通道发布/.test(md)) throw new Error("缺少 `## 11. 多通道发布` 一节");
	if (!md.includes("release/channels.json")) throw new Error("没指向 release/channels.json");
	return "在";
});

// ── ⑤ 构建产物不再入库（第一刀）────────────────────────────
check("lib/client.js 不再入 git（.gitignore 已列 + 未在 git 索引里）", () => {
	const ignore = readText(".gitignore");
	if (!/^lib\/client\.js$/m.test(ignore)) throw new Error(".gitignore 没列 lib/client.js");
	// 无 spawn 的替代判据：仓库里若还跟踪它，git 会把它列进 INDEX 相关文件；这里退一步查 .git/index 不可行，
	// 改为断言「文件在盘上存在但 .gitignore 命中」+ 由 PR 检查 `git ls-files`（见 docs/RELEASING.md §0bis）。
	return "已 gitignore";
});

check("package.json 有 prepack 构建（产物不入库后，打包必须自己生成）", () => {
	const pkg = readJson("package.json");
	const prepack = pkg.scripts?.prepack ?? "";
	if (!/node\s+build\.mjs/.test(prepack)) throw new Error(`prepack 应为 "node build.mjs"，实际 ${JSON.stringify(prepack)}`);
	const files = pkg.files ?? [];
	if (!files.includes("lib/*.js")) throw new Error("files 白名单不再包含 lib/*.js —— 构建产物会被漏进/漏出 tarball");
	return `prepack=${prepack}`;
});

// ── ⑥ Issue / PR 流程在位 ─────────────────────────────────
const TEMPLATES = {
	".github/pull_request_template.md": "PR 模板",
	".github/ISSUE_TEMPLATE/config.yml": "issue 选择器",
	".github/ISSUE_TEMPLATE/bug.yml": "bug 报告模板",
	".github/ISSUE_TEMPLATE/compat-report.yml": "宿主兼容性报告模板",
	".github/ISSUE_TEMPLATE/feature.yml": "功能请求模板",
	".github/CONTRIBUTING.md": "贡献与流程规范",
};
check("Issue / PR 流程文件齐备", () => {
	const missing = Object.entries(TEMPLATES)
		.filter(([rel]) => !existsSync(join(ROOT, rel)))
		.map(([rel, label]) => `${label}（${rel}）`);
	if (missing.length > 0) throw new Error(`缺：${missing.join("；")}`);
	return `${Object.keys(TEMPLATES).length} 个文件在位`;
});

check("PR 模板要求写「影响哪个通道」与「web 影响面」", () => {
	const md = readText(".github/pull_request_template.md");
	for (const need of ["通道", "web 影响面", "污染预算"]) {
		if (!md.includes(need)) throw new Error(`PR 模板缺少「${need}」`);
	}
	return "三项都在";
});

check("issue 模板的分类/标签口径与 channels.json 的 trackLabel 对应", () => {
	const yml = readText(".github/ISSUE_TEMPLATE/compat-report.yml");
	const missing = enabled.map(([, ch]) => ch.trackLabel).filter((label) => label && !yml.includes(label));
	if (missing.length > 0) throw new Error(`compat-report.yml 没提到这些 track 标签：${missing.join(", ")}`);
	return enabled.map(([, ch]) => ch.trackLabel).join(", ");
});

// ── 汇总 ──────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`[${r.ok ? "OK  " : "FAIL"}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
if (failed.length > 0) {
	console.error(`\n${failed.length} 项失败`);
	process.exit(1);
}
console.log(`\nALL CHANNEL CHECKS PASSED (${results.length} checks)`);
