/**
 * readme-intro.js — 从插件包提取一句话简介（纯函数，无外部依赖，可单测）。
 *
 * 优先级：README.zh.md 第一段 → package.json.description → README.md 第一段。
 * 结果按 `文件路径@mtime` 缓存（包更新后 mtime 变化自动失效）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LEN = 80;
const CACHE = new Map();

/** 清理一行 markdown：图片/链接/行内代码/加粗/斜体/引用/列表标记。 */
function stripMarkdown(line) {
	return line
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")   // 图片
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 -> 文本
		.replace(/`([^`]*)`/g, "$1")            // 行内代码
		.replace(/\*\*([^*]+)\*\*/g, "$1")      // 加粗
		.replace(/\*([^*]+)\*/g, "$1")          // 斜体
		.replace(/^>\s?/, "")                   // 引用
		.replace(/^[-*+]\s+/, "")               // 列表项
		.trim();
}

/** 从 markdown 全文提取第一句像样的简介。 */
export function extractIntro(markdown) {
	if (typeof markdown !== "string" || markdown.trim() === "") return null;
	const lines = markdown.split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "") continue;
		if (/^#{1,6}\s/.test(line)) continue;      // 标题
		if (/^```/.test(line)) continue;          // 代码块
		if (/^<!--/.test(line)) continue;         // 注释
		if (/^!\[/.test(line)) continue;          // 图片行
		if (/^\|/.test(line) && /\|$/.test(line)) continue; // 表格行
		if (/^[\s|:\-]+$/.test(line)) continue;   // 表格分隔线
		if (/^\[[^\]]*\]\([^)]*\)$/.test(line)) continue; // 纯链接行（导航）
		const cleaned = stripMarkdown(line);
		if (cleaned.length < 8) continue;         // 太短（徽章、单字）
		return cleaned.length > MAX_LEN ? `${cleaned.slice(0, MAX_LEN)}…` : cleaned;
	}
	return null;
}

/** 包在某个 node_modules 根下的相对目录（支持 @scope/pkg）。 */
function relDir(packageName) {
	return packageName.startsWith("@")
		? packageName.split("/").slice(0, 2).join("/")
		: packageName;
}

function cached(file, read) {
	try {
		const mtime = statSync(file).mtimeMs;
		const key = `${file}@${mtime}`;
		if (CACHE.has(key)) return CACHE.get(key);
		const value = read();
		CACHE.set(key, value);
		return value;
	} catch {
		return null;
	}
}

/**
 * 提取包简介。
 * @param packageName - 包名（支持 @scope/pkg）。
 * @param roots - node_modules 根目录候选列表（profile node_modules 等），按序查找。
 * @returns 简介文本或 null。
 */
export function readmeIntro(packageName, roots) {
	if (typeof packageName !== "string" || packageName === "") return null;
	for (const root of roots ?? []) {
		const dir = join(root, relDir(packageName));
		// 1) README.zh.md 第一段（中文简介最佳）
		for (const name of ["README.zh.md", "README.zh-CN.md", "README_zh.md"]) {
			const file = join(dir, name);
			if (!existsSync(file)) continue;
			const intro = cached(file, () => extractIntro(readFileSync(file, "utf8")));
			if (intro !== null) return intro;
		}
		// 2) package.json description（npm 包自带精炼描述）
		const manifestFile = join(dir, "package.json");
		if (existsSync(manifestFile)) {
			const desc = cached(manifestFile, () => {
				try {
					const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
					return typeof manifest?.description === "string" && manifest.description.trim() !== "" ? manifest.description.trim() : null;
				} catch {
					return null;
				}
			});
			if (desc !== null) return desc.length > MAX_LEN ? `${desc.slice(0, MAX_LEN)}…` : desc;
		}
		// 3) README.md 第一段
		for (const name of ["README.md", "readme.md"]) {
			const file = join(dir, name);
			if (!existsSync(file)) continue;
			const intro = cached(file, () => extractIntro(readFileSync(file, "utf8")));
			if (intro !== null) return intro;
		}
	}
	return null;
}
