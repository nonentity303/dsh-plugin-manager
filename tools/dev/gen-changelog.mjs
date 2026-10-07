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
 *   3. **排列口径 = 发布顺序（新→旧，Keep a Changelog 惯例）**：日期倒序；**同一天：同族的预发布版在
 *      正式版之上**（本项目预发布是正式版之后补发的：0.9.1 已发布 → 才有 0.9.1-rc2，"后发布的在上"）；
 *      **没有日期**的版本垫底（内部按版本倒序）。理由：`0.9.1-rc2` 在 semver 上低于 `0.9.1`，但它发布在
 *      0.9.1 **之后** —— CHANGELOG 是按"哪天发了什么"读的，所以主键是发布日期。（t32 原始口径"版本倒序"
 *      会把后发的预发布版藏到下面；t33 定为发布顺序。）
 *      **已知局限**：同日没有时刻信息 —— 将来若某个 rc 是正式版**之前**发的（正常节奏），同日同族时它也会
 *      在上面；要精确就让发布说明的日期写**实际发布日**（跨日自然分先后）。
 *   4. **预发布版必须有可见标注**：段头写成 `## [0.9.1-rc2] - 2026-10-07（预发布）`，别让读者
 *      把它当正式版。带预发布标签的形态：`-rcN` / `-rc.N` / `-alpha.N` / `-beta.N`；
 *      历史形态 `x.y.z-<n>`（如 `0.8.3-1`）段头保持不变（既有 CHANGELOG 零变化）。
 *   5. **不允许静默漏版**：`docs/releases/` 下任何"版本号打头"的文件都必须被识别成发布说明，
 *      否则 `main()` 直接 **exit 1**（见 `uncollectedVersionFiles`）。只有 `NON_RELEASE_SUFFIXES`
 *      里列出的验收/内部分析文件（如 `0.9.0-verify.md`）例外 —— 这样 `--check` 不会因为
 *      "文件压根没被识别"而假绿。
 *
 * 输入文件识别规则（**只认这两个形态**，其余一律忽略）：
 *   - `RELEASE_NOTES_<version>.md`（历史命名）
 *   - `<version>.md`，version = `x.y.z`、`x.y.z-<n>`（历史）或预发布形态
 *     `x.y.z-rcN` / `x.y.z-rc.N` / `x.y.z-alpha.N` / `x.y.z-beta.N`
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

/** 版本号语法（t32）：`x.y.z` / `x.y.z-<n>`（历史"第 4 段"形态）/ `-rcN` / `-rc.N` / `-alpha.N` / `-beta.N`。 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+)|-(rc|alpha|beta)[.-]?(\d+)?)?$/i;
/** 发布说明文件名（同上形态；历史命名 `RELEASE_NOTES_<version>.md` 另见 `collectReleaseFiles`）。 */
const RELEASE_FILE_RE = /^(\d+\.\d+\.\d+(?:-\d+|-(?:rc|alpha|beta)[.-]?\d*)?)\.md$/i;
/** 预发布标签的先后（semver：alpha < beta < rc < 正式版）；数字越大越"新"。 */
const PRE_RANK = { alpha: 1, beta: 2, rc: 3, official: 9 };
/**
 * 明确**不算**发布说明的「版本号打头」文件名后缀（验收 / 内部 / 操练报告等，故意不进 CHANGELOG）。
 * 出现没列在这里的"版本号打头"文件名 → `uncollectedVersionFiles` 会拦下并 exit 1。
 */
const NON_RELEASE_SUFFIXES = ["verify", "internal", "notes", "report", "audit", "checklist", "rehearsal", "probe"];

/**
 * 解析版本号 → `{ parts, prerelease, preRank, preNum }`；不可解析返回 `null`。
 * - `parts` 沿用历史口径：第 4 段是 `-<n>` 形态的数字（`0.8.3-1` → `[0,8,3,1]`，比 `0.8.3` 新）。
 * - `prerelease`：`"rc" | "alpha" | "beta"`；**正式版与历史 `-<n>` 形态都是 `null`**（段头不带标注）。
 * - `preRank`：按 semver 排序用（rc 3 > beta 2 > alpha 1，正式版 9）。注意**同一日期**的先后由
 *   `compareSameDateDesc` 决定（本项目预发布是正式版之后补发的 → 同日同族时预发布版在上），
 *   这里的 `preRank` 只在"预发布 vs 预发布"以及无日期分组里起作用。
 */
function parseVersion(version) {
	const m = VERSION_RE.exec(String(version));
	if (m === null) return null;
	const tag = m[5] === void 0 ? null : m[5].toLowerCase();
	return {
		parts: [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === void 0 ? 0 : Number(m[4])],
		prerelease: tag,
		preRank: tag === null ? PRE_RANK.official : PRE_RANK[tag],
		preNum: m[6] === void 0 ? 0 : Number(m[6])
	};
}

/** 是否「带预发布标签」的版本（`-rcN` 等）；历史 `-<n>` 形态返回 false（段头保持既有写法）。 */
function isPrerelease(version) {
	const parsed = parseVersion(version);
	return parsed !== null && parsed.prerelease !== null;
}

/** 版本倒序（同一天的多版本细分用）：第 4 段 → 预发布标签 → 预发布序号。 */
function compareVersionsDesc(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (pa === null || pb === null) return String(b).localeCompare(String(a));
	for (let i = 0; i < 4; i += 1) {
		if (pa.parts[i] !== pb.parts[i]) return pb.parts[i] - pa.parts[i];
	}
	if (pa.preRank !== pb.preRank) return pb.preRank - pa.preRank;
	if (pa.preNum !== pb.preNum) return pb.preNum - pa.preNum;
	return String(a).localeCompare(String(b));
}

/**
 * 同一天内部的先后（t33 口径）：**同族的预发布版在正式版之上**。
 * 依据：本项目的预发布版是在正式版**之后补发**的（0.9.1 已发布 → 才有 0.9.1-rc2），所以"后发布的在上"
 * 才符合发布顺序；`（预发布）` 标注保证读者不会把它误认为正式版。
 * **已知局限（边界写清）**：若将来某个 rc 是在正式版**之前**发布的（正常节奏），同日同族时它也会在上面 ——
 * 同一天没有时刻信息，无法区分先后；要精确就靠"发布说明的日期写实际发布日"（跨日自然分先后）。
 * 只有**同族**（同一 `x.y.z`）才谈"预发布 vs 正式"；同日的其它版本（如 0.8.2/0.8.1/0.8.0）仍按版本倒序。
 */
function compareSameDateDesc(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (pa === null || pb === null) return compareVersionsDesc(a, b);
	const sameFamily = pa.parts[0] === pb.parts[0] && pa.parts[1] === pb.parts[1] && pa.parts[2] === pb.parts[2];
	const aPre = pa.prerelease !== null;
	const bPre = pb.prerelease !== null;
	if (sameFamily && aPre !== bPre) return aPre ? -1 : 1; // 预发布版在上
	return compareVersionsDesc(a, b);
}

/**
 * 发布顺序排序（新→旧）：① 有日期的在前、日期倒序（ISO 字符串可直接比）；② 同一天按
 * `compareSameDateDesc`（同族预发布版在上，其余按版本倒序）；③ 无日期的垫底（内部同样按版本倒序）。
 * 入参是 `{ version, date }`（`date` 来自发布说明的内联日期或 `RELEASE_DATES`）。
 */
function compareByReleaseOrder(a, b) {
	if (a.date !== b.date) {
		if (a.date === null) return 1;
		if (b.date === null) return -1;
		return a.date < b.date ? 1 : -1;
	}
	return compareSameDateDesc(a.version, b.version);
}

/** docs/releases 下的发布说明（不把验收/内部分析文件当版本）。排序在拿到日期之后做（见 `render`）。 */
function collectReleaseFiles() {
	const files = [];
	for (const name of readdirSync(RELEASES_DIR)) {
		if (!name.endsWith(".md")) continue;
		const legacy = /^RELEASE_NOTES_(.+)\.md$/.exec(name);
		const current = RELEASE_FILE_RE.exec(name);
		const version = legacy !== null ? legacy[1] : current !== null ? current[1] : null;
		if (version === null || parseVersion(version) === null) continue;
		files.push({ version, file: name, path: join(RELEASES_DIR, name) });
	}
	return files;
}

/**
 * 「版本号打头、却没被识别成发布说明」的文件列表 —— 静默漏版的来源（t32 回归护栏）。
 * 这些文件不会进 CHANGELOG，而 `--check` 又只比对生成结果 → 假绿。允许例外：`NON_RELEASE_SUFFIXES`
 * 里列出的验收/内部分析文件（如 `0.9.0-verify.md`）。注释里明确：非 md、不以 `x.y.z` 打头、
 * 已收录的文件都不算。
 */
function uncollectedVersionFiles() {
	const collected = new Set(collectReleaseFiles().map((item) => item.file));
	const stray = [];
	for (const name of readdirSync(RELEASES_DIR)) {
		if (!name.endsWith(".md") || collected.has(name)) continue;
		const base = name.slice(0, -3);
		if (!/^\d+\.\d+\.\d+([-+.]|$)/.test(base)) continue;
		const tail = base.replace(/^\d+\.\d+\.\d+[-+]?/, "");
		if (tail === "" || NON_RELEASE_SUFFIXES.includes(tail.split(/[.-]/)[0].toLowerCase())) continue;
		stray.push(name);
	}
	return stray;
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
	const releases = collectReleaseFiles().map((item) => ({ ...item, ...parseRelease(item.path, item.version) }));
	releases.sort(compareByReleaseOrder);
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
	for (const release of releases) {
		const { date, summary, entries } = release;
		// 预发布版必须一眼可见（t32）：`## [0.9.1-rc2] - 2026-10-07（预发布）`
		const label = isPrerelease(release.version) ? "（预发布）" : "";
		out.push(`## [${release.version}]${date === null ? "" : ` - ${date}`}${label}`);
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
	// t32 护栏：docs/releases 下有「版本号打头但没被识别」的文件 → 立刻失败，别让 --check 假绿
	const stray = uncollectedVersionFiles();
	if (stray.length > 0) {
		console.error(`✘ docs/releases/ 下有「版本号打头、但没被当成发布说明」的文件（不会进 CHANGELOG）：${stray.join("、")}`);
		console.error("   修法：改文件名，或扩展本脚本的版本号/文件名识别规则（VERSION_RE / RELEASE_FILE_RE）；");
		console.error("   若确属验收·内部分析文件，请把它的后缀加进脚本里的 NON_RELEASE_SUFFIXES。");
		return 1;
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
