/**
 * platform.js — 跨平台路径/工具探测（纯函数，可单测）。
 *
 * 覆盖：npm 全局 node_modules 根（Windows: APPDATA\npm；Linux/macOS: npm root -g
 * 探测 + 常见路径 + nvm 版本目录）。全部返回「候选目录」列表，调用方自行 existsSync。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const NPM_ROOT_CACHE = { at: 0, roots: null };
const NPM_ROOT_TTL = 10 * 60 * 1000;

/**
 * 平台无关的 npm 全局根候选（纯函数，便于测试）。
 * @param platform - process.platform 值（"win32" / "darwin" / "linux" 等）。
 * @param env - 环境变量（用于 APPDATA / HOME）。
 * @param home - 用户主目录。
 * @param probeRoot - 可选：`npm root -g` 的探测结果（null = 不探测）。
 * @param scanNvm - 可选：nvm 版本目录扫描结果（null = 不扫描）。
 */
export function npmGlobalRootsFor(platform, env, home, probeRoot = null, scanNvm = null) {
	const roots = [];
	if (platform === "win32") {
		const appData = env?.APPDATA;
		if (typeof appData === "string" && appData !== "") {
			roots.push(join(appData, "npm", "node_modules"));
		}
	} else {
		// 1) npm root -g 权威探测（nvm / volta / fnm / 自编译等都能覆盖）
		if (typeof probeRoot === "string" && probeRoot !== "") {
			roots.push(probeRoot);
		}
		// 2) 常见全局前缀
		if (typeof home === "string" && home !== "") {
			roots.push(join(home, ".npm-global", "node_modules"));
			roots.push(join(home, ".local", "lib", "node_modules"));
		}
		roots.push("/usr/local/lib/node_modules");
		roots.push("/usr/lib/node_modules");
		// 3) nvm 各版本目录（每个版本的 lib/node_modules）
		if (Array.isArray(scanNvm)) {
			for (const versionDir of scanNvm) {
				roots.push(join(versionDir, "lib", "node_modules"));
			}
		}
	}
	// 去重（保持顺序）
	const seen = new Set();
	return roots.filter((root) => {
		if (seen.has(root)) return false;
		seen.add(root);
		return true;
	});
}

/** 扫描 ~/.nvm/versions/node 下所有已装 Node 版本目录。 */
export function scanNvmVersionDirs(home) {
	const dir = join(home, ".nvm", "versions", "node");
	try {
		if (!existsSync(dir)) return [];
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => join(dir, d.name));
	} catch {
		return [];
	}
}

/** 执行 `npm root -g`（失败静默返回 null）。 */
export function probeNpmGlobalRoot() {
	try {
		const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15000, windowsHide: true });
		if (result.status === 0 && typeof result.stdout === "string") {
			const line = result.stdout.trim().split(/\r?\n/)[0] ?? "";
			return line !== "" ? line : null;
		}
	} catch {
		// 探测失败 -> 常见路径兜底
	}
	return null;
}

/**
 * 当前平台的 npm 全局 node_modules 根候选（带 10 分钟缓存）。
 */
export function npmGlobalRoots() {
	const now = Date.now();
	if (NPM_ROOT_CACHE.roots !== null && now - NPM_ROOT_CACHE.at < NPM_ROOT_TTL) {
		return NPM_ROOT_CACHE.roots;
	}
	const home = homedir();
	const roots = npmGlobalRootsFor(
		process.platform,
		process.env,
		home,
		probeNpmGlobalRoot(),
		process.platform === "win32" ? null : scanNvmVersionDirs(home)
	);
	NPM_ROOT_CACHE.at = now;
	NPM_ROOT_CACHE.roots = roots;
	return roots;
}

/** 清缓存（更新/卸载后调用，让新安装的全局包路径生效）。 */
export function clearNpmGlobalRootCache() {
	NPM_ROOT_CACHE.roots = null;
}
