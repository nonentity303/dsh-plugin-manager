// check-vendor.mjs — 断言迁移包 vendor/ 里预置的插件 tarball 与仓库当前状态一致（版本 + **内容**）。
//
// 背景（审计④ R3/R15 → F5）：migration/pkg/main/vendor 里曾长期躺着 0.7.4 的旧启动器；
// 更隐蔽的是 **版本号一致但内容陈旧**（0.9.0 的 tgz 是若干修复轮之前打的），旧版断言只比
// `package/package.json` 的 version，会把它整个放行 —— 新机器就装出"没有 H1–H5 修复、
// bin 还缺 isDirectRun 守卫"的包。因此本脚本在版本断言之外增加**内容级 sha256 断言**。
//
// 断言清单：
//   1. manifest.json 的 _meta["dsh-plugin-manager-pro"] 必须存在（pack 时写入的期望版本）
//   2. vendored tgz 内 package/package.json 的 version 必须等于该期望版本
//   3. 期望版本必须等于仓库 package.json 的 version
//   4. 内容级（F5）：白名单里工作树的每个文件都必须在 tgz 内出现且 sha256 一致（缺文件/改了没重打包 → 失败）
//   5. 内容级（F5）：tgz 内每个文件都必须在工作树里存在且 sha256 一致（tgz 比工作树新/旧都算失败）
//
// 比对基准是**运行本脚本时的工件树**：t15 等后续轮次改完 README/package.json 后重新 pack + 覆盖 vendor，
// 本断言仍然成立（见 docs/RELEASING.md §5）。
//
// 迁移包不在本机时（单仓库 clone / CI）→ 打印 SKIP 并 exit 0，不阻塞。
// 可用 VENDOR_DIR 覆盖 vendor 目录位置。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const REPO_VERSION = REPO_PACKAGE.version;
const VENDOR = process.env.VENDOR_DIR ?? join(ROOT, "..", "migration", "pkg", "main", "vendor");
const DEP = "dsh-plugin-manager-pro";

const problems = [];
const okNotes = [];

/** 读 JSON 文本：容忍 BOM（PowerShell 5.1 的 Set-Content -Encoding utf8 会写 BOM，dsh boot 会因此挂掉）。 */
function readJsonFile(path) {
	const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	try {
		return JSON.parse(text);
	} catch (error) {
		console.error(`JSON 解析失败: ${path}\n  ${error.message}`);
		process.exit(1);
	}
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const short = (hex) => (hex === null ? "(缺失)" : hex.slice(0, 16));
const toPosix = (p) => p.replace(/\\/g, "/");

/** 无外部依赖读取 .tgz：gunzip + 解析 ustar 头（npm pack 的产物）。返回 Map<name, Buffer>。 */
function readTarGz(filePath) {
	const buffer = gunzipSync(readFileSync(filePath));
	const files = new Map();
	const parseSize = (field) => {
		const text = field.replace(/\0.*$/s, "").trim();
		if (text === "") return 0;
		// base-256（大文件）与八进制两种编码
		if (field.charCodeAt(0) & 0x80) {
			let value = 0;
			for (const byte of Buffer.from(text, "latin1")) value = value * 256 + byte;
			return value;
		}
		return Number.parseInt(text, 8) || 0;
	};
	let offset = 0;
	let pendingLongName = null;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break; // 归档结束标记
		const field = (start, length) => header.subarray(start, start + length).toString("latin1").replace(/\0.*$/s, "");
		const size = parseSize(field(124, 12));
		const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]);
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		const prefix = field(345, 155);
		const rawName = field(0, 100);
		const name = pendingLongName ?? (prefix === "" ? rawName : `${prefix}/${rawName}`);
		pendingLongName = null;
		if (type === "L") pendingLongName = buffer.subarray(dataStart, dataEnd).toString("utf8").replace(/\0+$/, "");
		else if (type === "0") files.set(name, Buffer.from(buffer.subarray(dataStart, dataEnd)));
		offset = dataEnd + (size > 0 ? Math.ceil(size / 512) * 512 - size : 0);
	}
	return files;
}

/** 展开 package.json 的 files 白名单（支持 `dir/*.ext` 与整目录）→ 工作树相对路径（POSIX、已排序）。 */
function expandShippedFiles() {
	const collected = new Set();
	const addFile = (absPath) => {
		if (existsSync(absPath) && statSync(absPath).isFile()) collected.add(toPosix(relative(ROOT, absPath)));
	};
	for (const spec of REPO_PACKAGE.files ?? []) {
		const normalized = toPosix(spec).replace(/^\.\//, "");
		if (normalized.includes("*")) {
			const slash = normalized.lastIndexOf("/");
			const dir = slash === -1 ? "." : normalized.slice(0, slash);
			const pattern = normalized.slice(slash + 1);
			const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
			const absDir = join(ROOT, dir);
			if (!existsSync(absDir)) continue;
			for (const name of readdirSync(absDir)) if (regex.test(name)) addFile(join(absDir, name));
			continue;
		}
		const abs = join(ROOT, normalized);
		if (existsSync(abs) && statSync(abs).isDirectory()) {
			const walk = (dir) => {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					const full = join(dir, entry.name);
					if (entry.isDirectory()) walk(full);
					else if (entry.isFile()) addFile(full);
				}
			};
			walk(abs);
			continue;
		}
		addFile(abs);
	}
	// package.json 不在 files 白名单里，但 npm pack 一定会带上，且它决定安装后的元数据 —— 纳入比对。
	collected.add("package.json");
	return [...collected].sort();
}

if (!existsSync(join(VENDOR, "manifest.json"))) {
	console.log(`SKIP: vendor dir not found: ${VENDOR}`);
	console.log(`      (run from a full workspace, or set VENDOR_DIR, to check the migration package)`);
	process.exit(0);
}

const manifest = readJsonFile(join(VENDOR, "manifest.json"));
const tgz = manifest[DEP];
const expected = manifest._meta?.[DEP] ?? null;

if (!tgz) problems.push(`manifest.json 缺少 "${DEP}" 条目`);
if (!expected) problems.push(`manifest.json 缺少 _meta["${DEP}"]（vendor 期望版本，pack 时必须写入）`);
if (expected && expected !== REPO_VERSION) {
	problems.push(`vendor 期望版本 ${expected} != 仓库 package.json version ${REPO_VERSION}`);
}

let tgzVersion = null;
let tarEntries = new Map();
let tgzPath = null;
if (tgz) {
	tgzPath = join(VENDOR, tgz);
	if (!existsSync(tgzPath)) {
		problems.push(`manifest 指向的 tarball 不存在: ${tgzPath}`);
	} else {
		try {
			tarEntries = readTarGz(tgzPath);
			const manifestEntry = tarEntries.get("package/package.json");
			if (manifestEntry === undefined) {
				problems.push("tarball 内缺少 package/package.json（无法读取版本）");
			} else {
				tgzVersion = JSON.parse(manifestEntry.toString("utf8")).version ?? null;
			}
		} catch (error) {
			problems.push(`无法读取 ${tgz}（${error instanceof Error ? error.message : String(error)}）`);
		}
		if (tgzVersion !== null && tgzVersion !== expected) {
			problems.push(`tarball 内版本 ${tgzVersion} != manifest 期望版本 ${expected}（vendor 未刷新）`);
		}
	}
}

// ---------- 内容级断言（F5） ----------
const contentDiff = [];
if (tgzPath !== null && existsSync(tgzPath) && tarEntries.size > 0) {
	const shipped = expandShippedFiles();
	// 4) 工作树 → tgz：白名单文件必须都在，且 sha256 一致（"改了源码没重打包" 在这里被抓到）
	for (const rel of shipped) {
		const worktreeHash = sha256(readFileSync(join(ROOT, rel)));
		const entry = tarEntries.get(`package/${rel}`);
		const tgzHash = entry === undefined ? null : sha256(entry);
		if (tgzHash !== worktreeHash) contentDiff.push({ rel, tgzHash, worktreeHash });
	}
	// 5) tgz → 工作树：tgz 里多出来或内容过期的文件同样算失败
	for (const [name, entry] of tarEntries) {
		if (!name.startsWith("package/")) continue;
		const rel = name.slice("package/".length);
		if (rel.endsWith("/")) continue;
		const abs = join(ROOT, rel);
		if (!existsSync(abs) || !statSync(abs).isFile()) {
			contentDiff.push({ rel, tgzHash: sha256(entry), worktreeHash: null });
			continue;
		}
		const worktreeHash = sha256(readFileSync(abs));
		const tgzHash = sha256(entry);
		if (tgzHash !== worktreeHash && !contentDiff.some((item) => item.rel === rel)) {
			contentDiff.push({ rel, tgzHash, worktreeHash });
		}
	}
	if (contentDiff.length > 0) {
		problems.push(`tgz 内容与工作树不一致（${contentDiff.length} 个文件；版本号一致时旧断言会漏掉这种陈旧）`);
	} else {
		okNotes.push(`内容级一致：${shipped.length} 个文件 sha256 与工作树逐文件相同`);
	}
}

console.log(`repo version : ${REPO_VERSION}`);
console.log(`vendor entry : ${tgz ?? "(missing)"} (expected ${expected ?? "?"}, inside ${tgzVersion ?? "?"})`);
console.log(`vendor dir   : ${VENDOR}`);
if (tgzPath !== null && existsSync(tgzPath)) {
	console.log(`tgz sha256   : ${sha256(readFileSync(tgzPath))}`);
	console.log(`tgz entries  : ${tarEntries.size}`);
}
for (const note of okNotes) console.log(`OK           : ${note}`);

if (problems.length > 0) {
	if (contentDiff.length > 0) {
		console.error(`内容差异（文件 / tgz 内 sha256 / 工作树 sha256）：`);
		for (const item of contentDiff) {
			console.error(`  - ${item.rel}\n      tgz      ${short(item.tgzHash)}\n      工作树   ${short(item.worktreeHash)}`);
		}
	}
	console.error(`VENDOR CHECK FAILED (${problems.length}):\n - ` + problems.join("\n - "));
	console.error(`修复：在**最后一轮源码修改之后**重新 npm run pack，并把新 tgz 覆盖到 ${VENDOR}（见 docs/RELEASING.md §5），然后重跑本脚本。`);
	process.exit(1);
}
console.log(`VENDOR CHECK OK: ${DEP}@${tgzVersion} == package.json version，且 tgz 内容与工作树逐文件一致`);
