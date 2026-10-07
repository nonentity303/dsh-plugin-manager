#!/usr/bin/env node
// pack.mjs — dev helper: build the client bundle, then produce the install tarball.
//
// Dev-only tool (not published). The canonical release path is `npm run pack`
// (see docs/RELEASING.md); this script exists for people who prefer a node entry
// point and it always operates on the repository root, regardless of cwd.
//
// 用法：
//   node tools/dev/pack.mjs                # build.mjs + npm pack（产出 .tgz）
//   node tools/dev/pack.mjs --dry-run      # build.mjs + npm pack --dry-run（只看文件清单，不落盘）
//   node tools/dev/pack.mjs --no-build     # 跳过 build.mjs（仅打包）
//   node tools/dev/pack.mjs --help
//
// 修复记录（兼容性审计 C-15，low · **本机实测**）：
//   旧写法 `execFileSync("npm.cmd", ["pack"])` 在 Node ≥ 18.20/20.12/22/24 上**必抛 EINVAL**
//   （CVE-2024-27980 之后的加固：Windows 上 .cmd/.bat 不能裸 spawn），实测：
//     "npm.cmd"  error= EINVAL  status= null
//     "npm"      error= ENOENT  status= null   ← Node 不做 PATHEXT 解析
//     shell:true status= 0                     ← 能成，但有引号/拼接坑
//   两条"直连"路都不通 → 改用 **`process.execPath` + `npm-cli.js`**（零 shell、零转义），
//   与仓库已有的正解 tools/dev/npm-preflight.mjs:18 / lib/platform.js:resolveNpmCliPath 保持一致；
//   拿不到 npm-cli.js 时退到 `cmd.exe /d /s /c "npm pack"`（参数是常量，无注入面），最后才用裸 `npm`。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

if (has("--help") || has("-h")) {
	console.log(`pack.mjs — ${pkg.name}@${pkg.version} 的本地打包助手

用法：
  node tools/dev/pack.mjs               build.mjs + npm pack（产出 <name>-<version>.tgz）
  node tools/dev/pack.mjs --dry-run     build.mjs + npm pack --dry-run（列文件清单，不落盘）
  node tools/dev/pack.mjs --no-build    跳过 build.mjs，只打包
  node tools/dev/pack.mjs --help

注：canonical 发布路径是 \`npm run pack\`（= node build.mjs && npm pack），见 docs/RELEASING.md。
    本脚本在 Node ≥22 上曾因 npm.cmd EINVAL 必失败（C-15），现已改为 node + npm-cli.js。`);
	process.exit(0);
}

/**
 * 定位 npm 的 CLI 入口（跨平台、参数零转义）。
 * @returns {{path:string|null, candidates:string[]}}
 */
export function resolveNpmCli({ execPath = process.execPath, env = process.env, exists = existsSync } = {}) {
	const candidates = [];
	if (typeof env.npm_execpath === "string" && /npm-cli\.js$/i.test(env.npm_execpath)) candidates.push(env.npm_execpath);
	const nodeDir = dirname(execPath);
	candidates.push(join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"));            // Windows / 官方安装包布局
	candidates.push(join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")); // Unix 前缀布局
	if (typeof env.APPDATA === "string" && env.APPDATA !== "") {
		candidates.push(join(env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js"));
	}
	candidates.push("/usr/lib/node_modules/npm/bin/npm-cli.js");
	candidates.push("/usr/local/lib/node_modules/npm/bin/npm-cli.js");
	for (const candidate of candidates) {
		try {
			if (exists(candidate)) return { path: candidate, candidates };
		} catch { /* 单个候选探测失败不影响其余 */ }
	}
	return { path: null, candidates };
}

const NPM_CLI = resolveNpmCli();

/** 跑 npm（stdio 直连终端；不由本脚本捕获输出）。 */
function runNpm(args) {
	if (NPM_CLI.path !== null) {
		console.log(`[pack] npm 调用路线：node ${NPM_CLI.path} ${args.join(" ")}`);
		return execFileSync(process.execPath, [NPM_CLI.path, ...args], { cwd: ROOT, stdio: "inherit" });
	}
	if (process.platform === "win32") {
		const comspec = process.env.ComSpec || join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
		console.log(`[pack] 未找到 npm-cli.js，退回 cmd.exe：${args.join(" ")}`);
		return execFileSync(comspec, ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd: ROOT, stdio: "inherit" });
	}
	console.log(`[pack] 未找到 npm-cli.js，退回 PATH 上的 npm：${args.join(" ")}`);
	return execFileSync("npm", args, { cwd: ROOT, stdio: "inherit" });
}

const dryRun = has("--dry-run");
console.log(`building + packing ${pkg.name}@${pkg.version} (root: ${ROOT})`);

if (!has("--no-build")) {
	execFileSync(process.execPath, [join(ROOT, "build.mjs")], { cwd: ROOT, stdio: "inherit" });
}
runNpm(dryRun ? ["pack", "--dry-run"] : ["pack"]);
console.log(dryRun
	? "[pack] dry-run 完成（未产出 .tgz）"
	: `expected artifact: ${pkg.name}-${pkg.version}.tgz (in ${ROOT})`);
