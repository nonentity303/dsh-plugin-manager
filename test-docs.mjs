// test-docs.mjs — 文档/发布件口径断言（离线、零依赖、无网络）
// 用法: node test-docs.mjs
//
// 为什么需要它（A 报告 S9）：README 曾停留在 1.0.1 的安全模型上（还写着 dshfind、公平取最高版本、
// "npm 包名将在下个版本迁移"），与代码直接矛盾，会误导读者对安全边界的判断。
// 1.0.4 起根 README 拆成「第一屏：特色 + 安装 + 升级自查」的入口页，细节进 docs/；
// 这里把「版本号动态一致」「行数上限」「第一屏必须出现什么」「信任模型事实不得丢」「拆分文件齐全」
// 都钉成断言，防止再次漂移。
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function lineCount(text) {
	return text.replace(/\n$/, "").split("\n").length;
}

function firstLines(text, n) {
	return text.replace(/\n$/, "").split("\n").slice(0, n).join("\n");
}

const pkg = JSON.parse(readText("package.json", "package.json"));
const version = String(pkg.version ?? "");

// ── (a) README / README.en 里的版本号必须等于 package.json 的 version（动态，不写死）──────
// 2026-11-27：版本号可能带**通道后缀**（如 `1.1.0-desktop.1`），所以下面的正则认完整 semver 预发布段，
// 不能只认 `x.y.z` —— 否则新通道一上线，"版本一致"这条断言就永久红（属于断言本身过时，不是文档错）。
const readme = readText("README.md", "README.md");
const readmeEn = readText("README.en.md", "README.en.md");

function versionFrom(text, re, label) {
	const m = re.exec(text);
	if (m === null) throw new Error(`${label} 找不到版本标注行（正则 ${re}）`);
	return m[1];
}

check("README.md 版本号 == package.json version", () => {
	const got = versionFrom(readme, /本页对应版本[：:]\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)/, "README.md");
	if (got !== version) throw new Error(`README.md 写的是 ${got}，package.json 是 ${version}`);
	return `package.json ${version} → README.md ${got}`;
});

check("README.en.md 版本号 == package.json version", () => {
	const got = versionFrom(readmeEn, /Current version[：:]\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)/i, "README.en.md");
	if (got !== version) throw new Error(`README.en.md 写的是 ${got}，package.json 是 ${version}`);
	return `package.json ${version} → README.en.md ${got}`;
});

// ── (b) 行数上限：根 README 是入口页，不是手册 ───────────────────────────────────
const README_MAX_LINES = 180;
const README_EN_MAX_LINES = 140;
check(`README.md ≤ ${README_MAX_LINES} 行`, () => {
	const n = lineCount(readme);
	if (n > README_MAX_LINES) throw new Error(`README.md 现有 ${n} 行，超过 ${README_MAX_LINES} 行上限（细节应移入 docs/）`);
	return `${n} 行`;
});
check(`README.en.md ≤ ${README_EN_MAX_LINES} 行`, () => {
	const n = lineCount(readmeEn);
	if (n > README_EN_MAX_LINES) throw new Error(`README.en.md 现有 ${n} 行，超过 ${README_EN_MAX_LINES} 行上限`);
	return `${n} 行`;
});

// ── (c) 第一屏（前 80 行）必须让读者看到「特色 + 安装 + 升级自查」──────────────────
const INSTALL_CMD = "dsh plugin --profile web add dsh-drydock";
check("README.md 前 80 行含安装命令", () => {
	const head = firstLines(readme, 80);
	if (!head.includes(INSTALL_CMD)) throw new Error(`前 80 行没有安装命令 "${INSTALL_CMD}"`);
	return `含 "${INSTALL_CMD}"`;
});
check("README.md 前 80 行含「升级」引导", () => {
	const head = firstLines(readme, 80);
	if (!head.includes("升级")) throw new Error("前 80 行没有升级 / 弃用引导（0.9.1 之前老用户必须看得到）");
	return "含「升级自查」引导";
});
check("README.md 含 hero 定位句「当引擎起不来的时候，它还在」", () => {
	if (!readme.includes("当引擎起不来的时候，它还在")) throw new Error("缺少 hero 定位句");
	return "hero 句在位";
});
check("README.md 有「四个主打特色」且四类特色齐全", () => {
	if (!/四个主打特色/.test(readme)) throw new Error("缺「四个主打特色」小节");
	const needed = {
		"独立救援工具链": /独立救援工具链/,
		"事务化卸载": /事务化卸载/,
		"更新源信任模型": /更新源信任模型/,
		"3081 兜底页": /3081\s*兜底页/,
	};
	const missing = Object.entries(needed).filter(([, re]) => !re.test(readme)).map(([label]) => label);
	if (missing.length > 0) throw new Error(`四个主打特色缺：${missing.join("、")}`);
	return "4 类特色均在位";
});
check("README.md 前 80 行含「安装」与「升级自查」小节标题", () => {
	const head = firstLines(readme, 80);
	if (!/##\s*安装/.test(head)) throw new Error("前 80 行没有「安装」小节");
	if (!/##\s*升级自查/.test(head)) throw new Error("前 80 行没有「升级自查」小节");
	return "安装 + 升级自查都在第一屏";
});
check("README.en.md 前 80 行含安装命令与 upgrade 引导", () => {
	const head = firstLines(readmeEn, 80);
	if (!head.includes(INSTALL_CMD)) throw new Error(`前 80 行没有安装命令 "${INSTALL_CMD}"`);
	if (!/upgrade/i.test(head)) throw new Error("前 80 行没有 upgrade / deprecation 引导");
	return "英文第一屏含安装 + 升级";
});

// ── (d) 过时表述必须删干净（S9 的四条：dshfind / 取最高版本 / 下个版本迁移 / 正式发布版 1.0.0）──
const README_STALE = {
	"dshfind（插件超市源已整体移除）": "dshfind",
	"取最高版本（已改为 registry 权威）": "取最高版本",
	"下个版本迁移（包名已迁移完成）": "下个版本迁移",
	"正式发布版 1.0.0（版本号必须动态跟 package.json）": "正式发布版 1.0.0",
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
	dshfind: "dshfind",
	"highest version wins（已改为权威层比较）": "highest version wins",
	"Published release 1.0.0（已改为 Current version）": "Published release 1.0.0",
	"will be marked deprecated（弃用提示已挂）": "will be marked deprecated",
};
check("README.en.md 不含过时表述", () => {
	const hits = [];
	for (const [label, needle] of Object.entries(README_EN_STALE)) {
		if (readmeEn.includes(needle)) hits.push(label);
	}
	if (hits.length > 0) throw new Error(`仍有 ${hits.length} 处：${hits.join("；")}`);
	return `${Object.keys(README_EN_STALE).length} 个模式均未命中`;
});

// ── (e) 新口径的关键事实不得在拆分中丢失（README 或 docs/SECURITY.md 任一处写到即可）─────
const securityPath = "docs/SECURITY.md";
const security = existsSync(join(ROOT, securityPath)) ? readFileSync(join(ROOT, securityPath), "utf8") : "";
const zhCorpus = `${readme}\n${security}`;

const README_FACTS = {
	"默认源含 npm 官方": "registry.npmjs.org",
	"默认源含 npmmirror": "npmmirror",
	"显式权威字段 authoritative": "authoritative",
	"明文源开关 allowInsecure": "allowInsecure",
	"明文仅兜底口径": "明文 · 仅兜底",
	"next 只在 @deepseek-ai/*": "@deepseek-ai/*",
	"下载目录 provenance": "provenance",
	"旧包已挂弃用提示": "已挂弃用提示",
};
check("信任模型 / 弃用口径事实在 README 或 docs/SECURITY.md", () => {
	const missing = Object.entries(README_FACTS).filter(([, needle]) => !zhCorpus.includes(needle)).map(([label]) => label);
	if (missing.length > 0) throw new Error(`README 与 docs/SECURITY.md 都缺少：${missing.join("；")}`);
	return `${Object.keys(README_FACTS).length} 条事实均在位`;
});

const README_EN_FACTS = {
	authoritative: "authoritative",
	allowInsecure: "allowInsecure",
	npmmirror: "npmmirror",
	"next track": "next",
	provenance: "provenance",
	"plaintext fallback label": "plaintext · fallback only",
};
check("README.en.md 覆盖 1.0.3 信任模型口径", () => {
	const missing = Object.entries(README_EN_FACTS).filter(([, needle]) => !readmeEn.includes(needle)).map(([label]) => label);
	if (missing.length > 0) throw new Error(`缺少：${missing.join("；")}`);
	return `${Object.keys(README_EN_FACTS).length} 条事实均在位`;
});

// ── (f) 拆分后的 docs 必须齐全，且 docs/README.md 索引指向它们 ──────────────────────
const NEW_DOCS = ["INSTALL.md", "USAGE.md", "SECURITY.md", "RESCUE.md", "COMPATIBILITY.md", "FAQ.md"];
check("docs/ 下 6 个新文档存在且非空", () => {
	const bad = [];
	for (const name of NEW_DOCS) {
		const rel = `docs/${name}`;
		const file = join(ROOT, rel);
		if (!existsSync(file)) {
			bad.push(`${rel} 不存在`);
			continue;
		}
		const text = readFileSync(file, "utf8");
		if (text.length < 500) bad.push(`${rel} 过短（${text.length} 字符）`);
		if (!/^#\s/m.test(text)) bad.push(`${rel} 缺一级标题`);
	}
	if (bad.length > 0) throw new Error(bad.join("；"));
	return `${NEW_DOCS.length} 个文件均存在`;
});

check("docs/README.md 索引包含 6 个新文档", () => {
	const index = readText("docs/README.md", "docs/README.md");
	const missing = NEW_DOCS.filter((name) => !index.includes(name));
	if (missing.length > 0) throw new Error(`索引里缺少：${missing.join("、")}`);
	return "6 个新文档均已入索引";
});

check("docs/README-full.md 标注为 0.9.1 存档、非当前手册", () => {
	const text = readText("docs/README-full.md", "docs/README-full.md");
	if (!/0\.9\.1/.test(text)) throw new Error("没写 0.9.1 存档");
	if (!/存档|归档/.test(text)) throw new Error("没写「存档 / 归档」");
	if (!/不是当前版本手册|非当前手册|不是当前手册/.test(text)) throw new Error("没说明「不是当前版本手册」");
	return "0.9.1 存档标注在位";
});

// ── (g) README / docs 相对链接不得断（拆分最容易留下的坑）──────────────────────────
check("README 与 docs 的相对链接可达（不含 0.9.1 存档全文）", () => {
	const files = ["README.md", "README.en.md", "docs/README.md", ...NEW_DOCS.map((n) => `docs/${n}`)];
	const broken = [];
	for (const rel of files) {
		const text = readText(rel, rel);
		const base = dirname(join(ROOT, rel));
		for (const raw of text.match(/\]\(([^)\s]+)\)/g) ?? []) {
			const target = raw.slice(2, -1).split("#")[0];
			if (target === "" || /^(https?:|mailto:)/i.test(target)) continue;
			if (!existsSync(resolve(base, decodeURI(target)))) broken.push(`${rel} → ${target}`);
		}
	}
	if (broken.length > 0) throw new Error(`断链 ${broken.length} 处：${broken.join("；")}`);
	return `${files.length} 个文档相对链接全部可达`;
});

// ── (h) docs/releases/<version>.md 必须存在，且写明本版内容 ──────────────────────
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

// ── (i) CHANGELOG 必须有本版条目 ──────────────────────────────────────────────
check("CHANGELOG.md 含本版条目", () => {
	const text = readText("CHANGELOG.md", "CHANGELOG.md");
	if (!text.includes(version)) throw new Error(`CHANGELOG.md 里没有 ${version}`);
	if (!text.includes(`## [${version}]`)) throw new Error(`缺少 "## [${version}]" 条目标题（跑 node tools/dev/gen-changelog.mjs 生成）`);
	return `含 ## [${version}]`;
});

// ── (j) 发布件一致性：scripts.test 末尾挂上本测试 ────────────────────────────────
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
