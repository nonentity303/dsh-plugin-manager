#!/usr/bin/env node
/**
 * tools/dev/sync-status.mjs — 生成 / 刷新 `status.json`（**我们对下游的唯一机器可读事实源**）。
 *
 * 为什么要这个文件（2026-11-27 用户提出的割裂问题）：
 *   · npm 页面渲染的是 `dist-tags.latest` **那个版本的 tarball 里的 README** —— 不发新版就改不了；
 *   · ADP 等第三方目录有自己的构建节奏（我们的条目里 `version` 字段就停在 1.0.0）；
 *   · 结果同一个包在三个地方显示三个版本，每次更新都要等对方 + 沟通，成本很高。
 *
 * 解法不是"每次去催"，而是**分层**：
 *   1. 易变信息（版本号）→ 徽章（shields.io 实时渲染，连快照都显示当前值）；
 *   2. 结构化信息（各通道版本 / 安装命令 / 兼容性）→ 本脚本产出的 `status.json`；
 *   3. 下游只需**一次**改成读 `status.json`（或直接读 npm registry 的 dist-tags），之后零沟通。
 *
 * 用法：
 *   node tools/dev/sync-status.mjs                # 打印将生成的内容（不写文件）
 *   node tools/dev/sync-status.mjs --write        # 写 status.json（离线：只用本地 package.json + channels.json）
 *   node tools/dev/sync-status.mjs --write --online   # 额外抓 registry 的 dist-tags 一并写进去
 *
 * 退出码：0 = 成功；1 = 失败（`--write` 时文件不会被写坏：原子写 tmp + rename）。
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const ONLINE = argv.includes("--online");
const OUT = join(ROOT, "status.json");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const channels = JSON.parse(readFileSync(join(ROOT, "release", "channels.json"), "utf8"));

/** 从 package.json.repository 里取 owner/repo（支持 "github:owner/repo"、git+https、ssh 三种写法）。 */
function repoOf(p) {
	const raw = typeof p.repository === "string" ? p.repository : p.repository?.url ?? "";
	const m = String(raw).match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
	return m ? `${m[1]}/${m[2]}` : "nonentity303/dsh-drydock";
}

/**
 * 每个启用的通道给出**两行**：稳定行（releaseTag，如 latest）与预览行（prereleaseTag，如 next / desktop）。
 * 这样下游拿到的是一张"哪个口对应哪个 dist-tag、该跑什么安装命令"的完整表，不用再猜。
 */
const channelRows = Object.entries(channels.channels ?? {})
	.filter(([, cfg]) => cfg && cfg.enabled !== false && !cfg.placeholder)
	.flatMap(([name, cfg]) => {
		const rows = [];
		if (cfg.releaseTag) {
			rows.push({
				name,
				maturity: "stable",
				title: cfg.title ?? name,
				distTag: cfg.releaseTag,
				install: cfg.install?.stable ? { command: cfg.install.stable } : {}
			});
		}
		if (cfg.prereleaseTag) {
			rows.push({
				name,
				maturity: "preview",
				title: cfg.title ?? name,
				distTag: cfg.prereleaseTag,
				install: cfg.install?.preview ? { command: cfg.install.preview } : {}
			});
		}
		return rows;
	});

/**
 * 从工作区版本推断"这个版本会发到哪个通道"（与 tools/dev/channels.mjs 同口径，这里只做展示用）。
 * `-rc.N` → next；`-desktop.N` → desktop；`-community.N` → community；无后缀 → latest。
 */
function channelOfVersion(version) {
	const m = String(version).match(/^\d+\.\d+\.\d+-(?:(\d+\.\d+\.\d+)-)?([a-z]+)(?:[.-]\d+)?$/i);
	if (!m) return "latest";
	const id = (m[2] || "").toLowerCase();
	const cfg = Object.entries(channels.channels ?? {}).find(([, c]) => (c.prereleaseId ?? "").toLowerCase() === id || (c.prereleaseAliases ?? []).includes(id));
	return cfg ? cfg[0] : id;
}

async function fetchDistTags() {
	const response = await fetch(`https://registry.npmjs.org/-/package/${encodeURIComponent(pkg.name)}/dist-tags`, {
		headers: { accept: "application/json", "user-agent": "dsh-drydock-sync-status" }
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return await response.json();
}

const workingChannel = channelOfVersion(pkg.version);
const doc = {
	schema: 1,
	package: pkg.name,
	repo: repoOf(pkg),
	docs: {
		readme: "https://github.com/nonentity303/dsh-drydock/blob/master/README.md",
		channels: "https://github.com/nonentity303/dsh-drydock/blob/master/docs/版本与轨道.md",
		selfUpdate: "https://github.com/nonentity303/dsh-drydock/blob/master/docs/自更新.md"
	},
	generatedAt: new Date().toISOString(),
	// 工作区当前版本（= master 上准备发的那个版本），以及它属于哪个通道
	working: { version: pkg.version, channel: workingChannel },
	channels: channelRows,
	compat: {
		dsh: pkg.engines?.dsh ?? pkg.peerDependencies?.dsh ?? null,
		node: pkg.engines?.node ?? null
	},
	notes: [
		"这是 dsh-drydock 对下游的机器可读事实源：通道 / 安装命令 / 兼容性 / 当前工作区版本。",
		"下游目录（ADP 等）建议直接读本文件或 npm registry 的 dist-tags，而不是缓存 README 里的文字与版本号。",
		"README 顶部徽章是实时的，快照页面也能显示当前通道版本。"
	]
};

if (ONLINE) {
	try {
		const tags = await fetchDistTags();
		doc.registry = { distTags: tags, fetchedAt: new Date().toISOString() };
		for (const row of doc.channels) if (row.distTag && tags[row.distTag]) row.publishedVersion = tags[row.distTag];
	} catch (error) {
		doc.registry = { error: error instanceof Error ? error.message : String(error), fetchedAt: new Date().toISOString() };
	}
}

const text = `${JSON.stringify(doc, null, 2)}\n`;

if (!WRITE) {
	console.log(text);
	process.exit(0);
}

const tmp = `${OUT}.tmp-${process.pid}`;
try {
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, OUT);
} catch (error) {
	try {
		rmSync(tmp, { force: true });
	} catch {
		/* 清理失败不影响结论 */
	}
	console.error(`✘ 写 status.json 失败：${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

const changed = !existsSync(OUT) || true; // 写成功后必然"已更新"；是否真变由 git diff 判定
console.log(`✓ status.json 已更新（${doc.channels.length} 个通道）${changed ? "" : ""}`);
for (const row of doc.channels) console.log(`  ${row.name.padEnd(8)} dist-tag=${String(row.distTag).padEnd(8)} ${row.publishedVersion ? `线上 ${row.publishedVersion}` : ""}`);
