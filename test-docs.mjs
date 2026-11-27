// test-docs.mjs — 文档/发布件口径断言（离线、零依赖、无网络）
// 用法: node test-docs.mjs
//
// 为什么需要它（A 报告 S9）：README 曾停留在 1.0.1 的安全模型上（还写着 dshfind、公平取最高版本、
// "npm 包名将在下个版本迁移"），与代码直接矛盾，会误导读者对安全边界的判断。
// 这里把"文档版本号 == package.json version"和几条关键口径钉成断言，防止再次漂移。
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

const results = [];
/** 记录一条断言；不抛异常，最后统一汇总（一次跑出所有问题比逐条修快）。 */
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

function readText(relPath, label) {
	const file = join(ROOT, relPath);
	if (!existsSync(file)) throw new Error(`${label} 不存在：${relPath}`);
	return readFileSync(file, "utf8");
}

const pkg = JSON.parse(readText("package.json", "package.json"));
const version = String(pkg.version ?? "");

// ── (a) README / README.en 里的版本号必须等于 package.json 的 version ──────────────
const readme = readText("README.md", "README.md");
const readmeEn = readText("README.en.md", "README.en.md");

function versionFrom(text, re, label) {
	const m = re.exec(text);
	if (m === null) throw new Error(`${label} 找不到版本标注行（正则 ${re}）`);
	return m[1];
}

check("README.md 版本号 == package.json version", () => {
	const got = versionFrom(readme, /本页对应版本[：:]\s*(\d+\.\d+\.\d+)/, "README.md");
	if (got !== version) throw new Error(`README.md 写的是 ${got}，package.json 是 ${version}`);
	return `1.0.3 → ${got}`;
});

check("README.en.md 版本号 == package.json version", () => {
	const got = versionFrom(readmeEn, /Current version[：:]\s*(\d+\.\d+\.\d+)/i, "README.en.md");
	if (got !== version) throw new Error(`README.en.md 写的是 ${got}，package.json 是 ${version}`);
	return `1.0.3 → ${got}`;
});

// ── (b) 过时表述必须删干净（S9 的四条：dshfind / 取最高版本 / 下个版本迁移 / 正式发布版 1.0.0）──
const README_STALE = {
	"dshfind（插件超市源已整体移除）": "dshfind",
	"取最高版本（已改为 registry 权威）": "取最高版本",
	"下个版本迁移（包名已迁移完成）": "下个版本迁移",
	"正式发布版 1.0.0（当前是 1.0.3）": "正式发布版 1.0.0"
};
check("README.md 不含过时表述", () => {
	const hits = [];
	for (const [label, needle] of Object.entries(README_STALE)) {
		if (readme.includes(needle)) hits.push(label);
	}
	if (hits.length > 0) throw new Error(`仍有 ${hits.length} 处：${hits.join("；")}`);
	return `${Object.keys(README_STALE).length} 个模式均未命中`;
});

const README_EN_STALE = {
	"dshfind": "dshfind",
	"highest version wins（已改为权威层比较）": "highest version wins",
	"Published release 1.0.0（已改为 Current version）": "Published release 1.0.0",
	"will be marked deprecated（弃用提示已挂）": "will be marked deprecated"
};
check("README.en.md 不含过时表述", () => {
	const hits = [];
	for (const [label, needle] of Object.entries(README_EN_STALE)) {
		if (readmeEn.includes(needle)) hits.push(label);
	}
	if (hits.length > 0) throw new Error(`仍有 ${hits.length} 处：${hits.join("；")}`);
	return `${Object.keys(README_EN_STALE).length} 个模式均未命中`;
});

// ── 新口径的关键事实必须在位（否则"删干净"变成"什么都没写"）──────────────────────
const README_FACTS = {
	"默认源含 npm 官方": "registry.npmjs.org",
	"默认源含 npmmirror": "npmmirror",
	"显式权威字段 authoritative": "authoritative",
	"明文源开关 allowInsecure": "allowInsecure",
	"明文仅兜底口径": "明文 · 仅兜底",
	"next 只在 @deepseek-ai/*": "@deepseek-ai/*",
	"下载目录 provenance": "provenance",
	"旧包已挂弃用提示": "已挂弃用提示"
};
check("README.md 覆盖 1.0.3 信任模型口径", () => {
	const missing = Object.entries(README_FACTS).filter(([, needle]) => !readme.includes(needle)).map(([label]) => label);
	if (missing.length > 0) throw new Error(`缺少：${missing.join("；")}`);
	return `${Object.keys(README_FACTS).length} 条事实均在位`;
});

const README_EN_FACTS = {
	"authoritative": "authoritative",
	"allowInsecure": "allowInsecure",
	"npmmirror": "npmmirror",
	"next track": "next",
	"provenance": "provenance",
	"plaintext fallback label": "plaintext · fallback only"
};
check("README.en.md 覆盖 1.0.3 信任模型口径", () => {
	const missing = Object.entries(README_EN_FACTS).filter(([, needle]) => !readmeEn.includes(needle)).map(([label]) => label);
	if (missing.length > 0) throw new Error(`缺少：${missing.join("；")}`);
	return `${Object.keys(README_EN_FACTS).length} 条事实均在位`;
});

// ── (c) docs/releases/<version>.md 必须存在，且写明本版内容 ──────────────────────
const releasePath = `docs/releases/${version}.md`;
check(`${releasePath} 存在且含版本号`, () => {
	const text = readText(releasePath, "发布说明");
	if (!text.includes(version)) throw new Error(`文件里没有出现 ${version}`);
	return `${releasePath}（${text.length} 字符）`;
});

check(`${releasePath} 写明并入 c955b9d 的 ADP 文案修正`, () => {
	const text = readText(releasePath, "发布说明");
	if (!text.includes("c955b9d")) throw new Error("没写 1.0.2 之后本地待发布的文案修正（commit c955b9d）");
	return "含 c955b9d";
});

check(`${releasePath} 的测试证据表已由队长收口填写`, () => {
	const text = readText(releasePath, "发布说明");
	if (text.includes("（由队长在收口时填写）")) throw new Error("发布说明里仍有「（由队长在收口时填写）」占位：未跑过的测试不能写成全绿");
	// 证据表必须覆盖本版新增/修改的测试套件（名字出现即可，不校验具体数字，避免每次跑测试都要改文档）
	for (const name of ["test-security-provenance.mjs", "test-downloader.mjs", "test-ux.mjs", "test-launcher.mjs", "test-docs.mjs"]) {
		if (!text.includes(name)) throw new Error(`证据表缺少 ${name} 的结果行`);
	}
	return "无占位且覆盖 5 个关键套件";
});

// ── (d) CHANGELOG 必须有本版条目 ──────────────────────────────────────────────
check("CHANGELOG.md 含本版条目", () => {
	const text = readText("CHANGELOG.md", "CHANGELOG.md");
	if (!text.includes(version)) throw new Error(`CHANGELOG.md 里没有 ${version}`);
	if (!text.includes(`## [${version}]`)) throw new Error(`缺少 "## [${version}]" 条目标题（跑 node tools/dev/gen-changelog.mjs 生成）`);
	return `含 ## [${version}]`;
});

// ── 发布件一致性：scripts.test 末尾挂上本测试 ────────────────────────────────
check("package.json scripts.test 末尾挂了 test-docs.mjs", () => {
	const test = String(pkg.scripts?.test ?? "");
	if (!/&& node test-docs\.mjs$/.test(test)) throw new Error(`scripts.test 末尾不是 "&& node test-docs.mjs"：${test.slice(-60)}`);
	return "已挂载";
});

// ── 汇总输出 ────────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, ok, detail } of results) {
	if (ok) {
		console.log(`PASS ${name} — ${detail}`);
	} else {
		failed += 1;
		console.error(`FAIL ${name}\n     原因：${detail}`);
	}
}

if (failed > 0) {
	console.error(`\n测试失败：${failed}/${results.length} 项未通过（文档与 package.json version=${version} 口径不一致）`);
	process.exit(1);
}
console.log(`\n全部通过：${results.length}/${results.length} 项（package.json version=${version}）`);
process.exit(0);
