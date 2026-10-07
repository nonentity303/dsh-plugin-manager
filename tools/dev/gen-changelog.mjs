#!/usr/bin/env node
/**
 * tools/dev/gen-changelog.mjs — 从 `docs/releases/*.md` 生成仓库根 `CHANGELOG.md`
 * （Keep a Changelog 风格，版本倒序）。
 *
 * 用法：
 *   node tools/dev/gen-changelog.mjs            写入 CHANGELOG.md
 *   node tools/dev/gen-changelog.mjs --check    只校验：与生成结果一致 → exit 0，不一致 → exit 1
 *   node tools/dev/gen-changelog.mjs --stdout   打印生成结果（不写文件）
 *   node tools/dev/gen-changelog.mjs --help
 *
 * 设计约束（审计口径）：
 *   1. **幂等**：输出只由 `docs/releases/*.md` 的内容决定 —— 不含时间戳、不看 git 状态、
 *      不依赖 `Date.now()`；同一份输入重复运行逐字节相同。
 *   2. **不猜数字**：发布日期只从两处取 —— 发布说明里的内联日期（`20xx-xx-xx`），
 *      或下面的 `RELEASE_DATES` 表；两处都没有 → 该版本不写日期（不推断）。
 *   3. 版本倒序（`0.9.0` → `0.7.0`）；`x.y.z-<n>`（如 `0.8.3-1`）按第 4 段比较。
 *
 * 输入文件识别规则（**只认这两个形态**，其余一律忽略）：
 *   - `RELEASE_NOTES_<version>.md`（历史命名）
 *   - `<version>.md`，version = `x.y.z` 或 `x.y.z-<n>`（当前版本命名）
 *   → `0.9.0-verify.md`、`RELEASE_NOTES_INTERNAL_0.9.0.md` 这类**验收/内部分析**文件
 *     不会被当成发布说明（它们不是版本）。
 *
 * 解析规则（发布说明的写法差异很大，这里做保守归一）：
 *   - 章节：`##` / `###` 标题 → 按关键词归到 Added / Changed / Fixed / Removed / Security；
 *     说明性章节（安装 / 测试 / 验证 / 注意事项 / 已知限制 / 版本定位 / 升级路径 / 与竞品差异…）跳过。
 *   - 条目：顶层 `- ` / `* ` / `1. ` 行；其后的**缩进续行**并入同一行（中文按原样拼接）。
 *   - 表格：非跳过章节里的表格数据行按 `单元格 — 单元格` 转成条目（表头与分隔行丢弃）。
 *   - 摘要：头部引用块（去掉"版本/日期/执行者/任务/目标"行）→ 找不到则用首个段落 → 再用 H1 标题。
 *
 * 日期表来源（逐个可核对）：
 *   - 0.9.0    ：npm `dist-tags.latest` 时间戳 `2026-09-30T01:41:01Z`（`docs/RELEASING.md` §0bis）
 *   - 0.8.3-1  ：文件内联 `· 2026-09-28`
 *   - 0.8.2    ：文件内联 + GitHub Release `v0.8.2` published_at `2026-09-04T06:01:21Z`
 *   - 0.8.1    ：文件内联 + GitHub Release `v0.8.1` published_at `2026-09-04T05:29:08Z`
 *   - 0.8.0    ：文件内联 `· 2026-09-04`（该版本没有 GitHub Release）
 *   - 0.7.4    ：GitHub Release `v0.7.4` published_at `2026-08-18T13:37:39Z`
 *   - 0.7.3    ：GitHub Release `v0.7.3` published_at `2026-08-18T11:28:30Z`
 *   - 0.7.2 / 0.7.1 / 0.7.0：无内联日期、无 GitHub Release、无 tag → **不写日期**
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const RELEASES_DIR = join(ROOT, "docs", "releases");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

/** 仅在发布说明没有内联日期时使用（来源见文件头注释）。 */
const RELEASE_DATES = {
	"0.9.0": "2026-09-30",
	"0.8.3-1": "2026-09-28",
	"0.8.2": "2026-09-04",
	"0.8.1": "2026-09-04",
	"0.8.0": "2026-09-04",
	"0.7.4": "2026-08-18",
	"0.7.3": "2026-08-18"
};

/** Keep a Changelog 的五个分类（顺序固定 → 输出稳定）。 */
const CATEGORIES = [
	{ id: "Added", heading: "### Added · 新增" },
	{ id: "Changed", heading: "### Changed · 变更" },
	{ id: "Fixed", heading: "### Fixed · 修复" },
	{ id: "Removed", heading: "### Removed · 移除" },
	{ id: "Security", heading: "### Security · 安全" }
];

/** 归一化标题：去掉编号（1. / ①…）与前导符号/emoji，便于关键词匹配。 */
function normalizeTitle(title) {
	return title
		.replace(/^[#\s]+/, "")
		.replace(/^[0-9０-９]+\s*[.、)）]?\s*/, "")
		.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "")
		.replace(/^[^\p{L}\p{N}]+/u, "")
		.trim();
}

/** 章节 → 分类；`null` = 说明性章节，不进 CHANGELOG。默认 Changed。 */
function classify(h2, h3) {
	const text = normalizeTitle(`${h2} ${h3 ?? ""}`);
	if (text === "") return "Changed";
	if (/(安装|升级|回退|升级路径|已知限制|注意事项|参考部署|与竞品差异|版本定位|文件清单|复现清单|发布说明)/.test(text)) return null;
	if (/(测试|验证|专项检查|自检|复核|对照|工件清单|结论)/.test(text)) return null;
	if (/(新增|新功能|现在你可以|Added)/i.test(text)) return "Added";
	if (/(移除|删除|取消|废弃|Removed)/i.test(text)) return "Removed";
	if (/(安全|Security)/i.test(text)) return "Security";
	if (/(修复|修正|Fix|补丁)/i.test(text)) return "Fixed";
	return "Changed";
}

/** 续行拼接：边界两侧都是中日韩字符 → 直接拼；否则按 Markdown 软换行补一个空格。 */
function joinContinuation(prev, next) {
	const cjk = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
	const bothCjk = cjk.test(prev.slice(-1)) && cjk.test(next.slice(0, 1));
	return bothCjk ? prev + next : `${prev} ${next}`;
}

function versionParts(version) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(version);
	if (m === null) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === void 0 ? 0 : Number(m[4])];
}

function compareVersionsDesc(a, b) {
	const pa = versionParts(a);
	const pb = versionParts(b);
	for (let i = 0; i < 4; i += 1) {
		if (pa[i] !== pb[i]) return pb[i] - pa[i];
	}
	return a.localeCompare(b);
}

/** docs/releases 下的发布说明（不把验收/内部分析文件当版本）。 */
function collectReleaseFiles() {
	const files = [];
	for (const name of readdirSync(RELEASES_DIR)) {
		if (!name.endsWith(".md")) continue;
		const legacy = /^RELEASE_NOTES_(.+)\.md$/.exec(name);
		const current = /^(\d+\.\d+\.\d+(?:-\d+)?)\.md$/.exec(name);
		const version = legacy !== null ? legacy[1] : current !== null ? current[1] : null;
		if (version === null || versionParts(version) === null) continue;
		files.push({ version, file: name, path: join(RELEASES_DIR, name) });
	}
	files.sort((a, b) => compareVersionsDesc(a.version, b.version));
	return files;
}

/** 表格行 → 单元格（`\|` 是单元格里的字面竖线，不能当分隔符）。 */
const ESCAPED_PIPE = "\u0001";
function splitCells(line) {
	return line
		.replace(/\\\|/g, ESCAPED_PIPE)
		.replace(/^\s*\|/, "")
		.replace(/\|\s*$/, "")
		.split("|")
		.map((c) => c.trim().replaceAll(ESCAPED_PIPE, "|"));
}

/** 把一份发布说明压成 {date, summary, entries:{Added:[],Changed:[],Fixed:[],Removed:[],Security:[]}} */
function parseRelease(path, version) {
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	const headerEnd = lines.findIndex((l) => /^##\s/.test(l));
	const header = lines.slice(0, headerEnd === -1 ? lines.length : headerEnd);

	const inlineDate = header.map((l) => /(20\d\d-\d\d-\d\d)/.exec(l)?.[1]).find((d) => d !== void 0) ?? null;
	const date = inlineDate ?? RELEASE_DATES[version] ?? null;

	const quote = header
		.filter((l) => l.trim().startsWith(">"))
		.map((l) => l.replace(/^\s*>\s?/, "").trim())
		.filter((l) => l !== "" && !/^(版本|日期|执行者|任务|目标|依据)[:：]/.test(l))
		.map((l) => l.replace(/^主题[:：]\s*/, ""));
	const title = (lines.find((l) => /^#\s/.test(l)) ?? "").replace(/^#\s*/, "").trim();
	const firstParagraph = lines
		.map((l) => l.trim())
		.find((l) => l !== "" && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("|") && !l.startsWith("-") && !l.startsWith("*") && !/^\d+\./.test(l));
	let summary = (quote.length > 0 ? quote : firstParagraph !== void 0 ? [firstParagraph] : [title]).join(" ").replace(/\*\*/g, "").trim();
	if (summary.length > 260) summary = `${summary.slice(0, 257).trimEnd()}…`;

	const entries = Object.fromEntries(CATEGORIES.map((c) => [c.id, []]));
	let h2 = "";
	let h3 = null;
	let inFence = false;
	let tableSeen = 0; // 当前表格块内已跳过的行数（0=表头待丢，1=分隔行待丢）
	let lastIndex = null; // 上一条目的索引（用于缩进续行）

	const push = (category, text) => {
		const clean = text.replace(/\s+$/, "");
		if (clean === "" || clean.startsWith("|")) return;
		if (!entries[category].includes(clean)) {
			entries[category].push(clean);
			lastIndex = clean;
		}
	};

	for (const raw of lines) {
		if (/^\s*```/.test(raw)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		const heading = /^(#{2,4})\s+(.*)$/.exec(raw);
		if (heading !== null && heading[1].length <= 3) {
			if (heading[1].length === 2) {
				h2 = heading[2].trim();
				h3 = null;
			} else {
				h3 = heading[2].trim();
			}
			tableSeen = 0;
			lastIndex = null;
			continue;
		}

		const category = classify(h2, h3);
		if (category === null) continue;

		// 缩进续行 → 并入上一条（发布说明里长句会折行；缩进子条目除外，它们自己成条）
		if (/^\s+\S/.test(raw) && lastIndex !== null && !/^\s*(?:[-*]|\d+\.)\s/.test(raw)) {
			const merged = joinContinuation(lastIndex, raw.trim());
			const list = entries[category];
			const at = list.indexOf(lastIndex);
			if (at >= 0) {
				list[at] = merged;
				lastIndex = merged;
			}
			continue;
		}

		// 表格数据行
		if (/^\s*\|/.test(raw)) {
			const cells = splitCells(raw);
			tableSeen += 1;
			if (tableSeen <= 2) continue; // 表头 + 分隔行
			if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
			const [first, ...rest] = cells.filter((c, i) => !(i > 0 && c === ""));
			if (first === void 0) continue;
			push(category, rest.length > 0 ? `${first} — ${rest.join(" — ")}` : first);
			continue;
		}

		// 条目：- / * / 1.（允许缩进一级：子条目同样收录）
		const bullet = /^\s*[-*]\s+(.*)$/.exec(raw) ?? /^\s*\d+\.\s+(.*)$/.exec(raw);
		if (bullet === null) {
			tableSeen = 0;
			continue;
		}
		tableSeen = 0;
		push(category, bullet[1].trim());
	}

	return { date, summary, entries };
}

function render() {
	const files = collectReleaseFiles();
	const out = [];
	out.push("# 变更日志（Changelog）");
	out.push("");
	out.push("> 本文件**由脚本生成**，请勿手工编辑：发布说明改完后执行 `node tools/dev/gen-changelog.mjs`。");
	out.push("> 校验：`node tools/dev/gen-changelog.mjs --check`（不一致 → exit 1）。");
	out.push(">");
	out.push("> 数据来源：`docs/releases/*.md`（每个版本倒序排列，完整说明见对应文件）；生成规则见 [`tools/dev/gen-changelog.mjs`](tools/dev/gen-changelog.mjs)。");
	out.push("> 日期口径：发布说明里的内联日期，或脚本内 `RELEASE_DATES` 表（来源逐条列在脚本注释里）；**找不到出处就不写日期**");
	out.push("> （新版本发布后把发布日期回填进发布说明再重跑本脚本即可 —— 见 `docs/RELEASING.md` §10 第 13 步）。");
	out.push("> GitHub Releases 另见 <https://github.com/nonentity303/dsh-plugin-manager/releases>。");
	out.push("");
	out.push("## [Unreleased]");
	out.push("");
	out.push("> 尚未发布的改动不在本文件；开发中的版本号见 `package.json` 的 `version`（发布流程见 [`docs/RELEASING.md`](docs/RELEASING.md)）。");
	out.push("");
	for (const release of files) {
		const { date, summary, entries } = parseRelease(release.path, release.version);
		out.push(`## [${release.version}]${date === null ? "" : ` - ${date}`}`);
		out.push("");
		if (summary !== "") {
			out.push(`> ${summary}`);
			out.push("");
		}
		for (const category of CATEGORIES) {
			const items = entries[category.id];
			if (items.length === 0) continue;
			out.push(category.heading);
			out.push("");
			for (const item of items) out.push(`- ${item}`);
			out.push("");
		}
		out.push(`> 完整发布说明：[\`docs/releases/${release.file}\`](docs/releases/${release.file})`);
		out.push("");
	}
	return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("用法: node tools/dev/gen-changelog.mjs [--check|--stdout|--help]");
		return 0;
	}
	const generated = render();
	if (argv.includes("--stdout")) {
		process.stdout.write(generated);
		return 0;
	}
	if (argv.includes("--check")) {
		if (!existsSync(CHANGELOG)) {
			console.error("✘ CHANGELOG.md 不存在：先跑 `node tools/dev/gen-changelog.mjs`");
			return 1;
		}
		const current = readFileSync(CHANGELOG, "utf8");
		if (current === generated) {
			console.log("✓ CHANGELOG.md 与 docs/releases/ 一致（无差异）");
			return 0;
		}
		const a = current.split("\n");
		const b = generated.split("\n");
		let i = 0;
		while (i < Math.max(a.length, b.length) && a[i] === b[i]) i += 1;
		console.error(`✘ CHANGELOG.md 与生成结果不一致（首个差异在第 ${i + 1} 行）`);
		console.error(`   现有: ${a[i] === void 0 ? "<文件结束>" : a[i]}`);
		console.error(`   生成: ${b[i] === void 0 ? "<文件结束>" : b[i]}`);
		console.error("   修复: node tools/dev/gen-changelog.mjs");
		return 1;
	}
	writeFileSync(CHANGELOG, generated, "utf8");
	console.log(`✓ 已生成 CHANGELOG.md（${generated.split("\n").length - 1} 行）`);
	return 0;
}

process.exitCode = main();
