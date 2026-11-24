/**
 * patch-clean.mjs — cordis.patch.yml 条目块归属判定与清理（1.0.0-rc.2 P1-1）。
 *
 * 背景（审查报告 P1-1）：旧实现的 needle 是 `chunk.some(line => line.includes("name: " + pkgName))`，
 * 只能命中**无引号**的 `name: dsh-vision-router`。真实 patch 里还有两种不匹配形态：
 *   ① 带引号（loader 重写 / scoped 包）：`name: "@caob23/dsh-browser-control"`；
 *   ② 只有 id（管理器自写块 / flow-style JSON）：`- id: dsh-xxx`、`{id:"dsh-xxx",enabled:false}`。
 * 任一形态漏清 → dsh-app-boot 启动时 warn「找不到补丁目标」，虽不炸启动但留下幽灵配置。
 *
 * 匹配规则（按条目块 `- ` 分块后逐块判定）：
 *   行级：`^\s*(-\s+)?["']?(name|id)["']?\s*:\s*(["'])<pkg>\3\s*,?\s*$` —— 容忍引号/尾逗号；
 *   块级（flow-style）：`(^|[{,\s])["']?(name|id)["']?\s*:\s*(["'])<pkg>\3` —— 整块 JSON 一行的形态。
 * 两种都要求值**整体精确等于包名**（引号或行尾锚定），不会把 `dsh-foo` 误判进 `dsh-foo-bar`。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 行级形态：`- name: "pkg"` / `name: pkg` / `- id: pkg` / `"name": "pkg",`（引号与尾逗号可选）。
 * 引号形态由回引 \\3 锚定值边界；无引号形态靠行尾锚定（`\\s*,?\\s*$`）——`user-mod-extra`
 * 对 pkg=user-mod 不命中（值整体精确等于包名）。
 */
function entryLineRe(pkgName) {
	return new RegExp(`^\\s*(-\\s+)?["']?(name|id)["']?\\s*:\\s*(["']?)${escapeRegExp(pkgName)}\\3\\s*,?\\s*$`);
}

/**
 * 块级 flow-style 形态：`[{id:"pkg",enabled:false},…]` / `{ "name": "pkg", … }`。
 * 引号形态由回引 \\3 锚定；无引号形态由前瞻边界（空白/逗号/花括号/结尾）锚定，
 * 同样不会把 `user-mod` 误判进 `user-mod-extra`。
 */
function flowEntryRe(pkgName) {
	return new RegExp(`(^|[{,\\s])["']?(name|id)["']?\\s*:\\s*(["']?)${escapeRegExp(pkgName)}\\3(?=[\\s,}\\]]|$)`);
}

/**
 * 判定一个条目块（`- ` 开头的行及其后续缩进行）是否归属某包。
 * 纯函数，供单测直接断言；pkgName 非法（空/非字符串）一律 false。
 */
export function chunkMatchesPackage(chunkLines, pkgName) {
	if (!Array.isArray(chunkLines) || typeof pkgName !== "string" || pkgName.trim() === "") return false;
	if (chunkLines.some((line) => entryLineRe(pkgName).test(line))) return true;
	return flowEntryRe(pkgName).test(chunkLines.join("\n"));
}

/**
 * 从 patch 文件里删掉归属 pkgName 的顶层 `- ` 条目块；首个条目块之前的注释/空行原样保留。
 * 文件不存在视为无需清理（ok:true）；返回 { ok, removed, total, detail }。
 * 仅当 removed > 0 时才写盘（调用方据 removed/total 判断是否需要人工确认）。
 */
export function removePatchEntriesFromFile(file, pkgName) {
	let text;
	try { text = readFileSync(file, "utf8"); }
	catch { return { ok: true, removed: 0, total: 0, detail: "patch 文件不存在，无需清理" }; }
	const lines = text.split(/\r?\n/);
	const header = [];
	let i = 0;
	while (i < lines.length && !/^- /.test(lines[i])) { header.push(lines[i]); i += 1; }
	const chunks = [];
	let current = null;
	for (; i < lines.length; i += 1) {
		if (/^- /.test(lines[i])) { current = [lines[i]]; chunks.push(current); }
		else if (current) current.push(lines[i]);
	}
	const kept = [...header];
	let removed = 0;
	for (const chunk of chunks) {
		if (chunkMatchesPackage(chunk, pkgName)) { removed += 1; continue; }
		kept.push(...chunk);
	}
	if (removed > 0) writeFileSync(file, kept.join("\n"), "utf8");
	return { ok: true, removed, total: chunks.length, detail: null };
}

/** 便捷入口：profile 目录下的 cordis.patch.yml（open-boot 卸载事务走这个）。 */
export function removePatchEntriesFor(profile, pkgName) {
	return removePatchEntriesFromFile(join(profile, "cordis.patch.yml"), pkgName);
}
