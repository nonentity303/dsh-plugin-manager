#!/usr/bin/env node
/**
 * tools/dev/verify-triple.mjs — 三方 sha256 比对：
 *   ① git 远端（GitHub master 的 tree，按 blob 取内容 —— 这是"源码分发"那一份）
 *   ② npm registry 上已发布的 tgz（用户 `dsh plugin add` 实际拿到的）
 *   ③ 本地：工作树文件 + 本地打出的 tgz
 *
 * 输出：逐文件 sha256 表 + 差异诊断（首个不同字节位置）。
 * 用法：node tools/dev/verify-triple.mjs [--ref master]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const refIdx = argv.indexOf("--ref");
const REF = refIdx >= 0 ? argv[refIdx + 1] : "master";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ---------- tar 解析（读 gzip 后的 tar 里的文件内容） ----------
function readTar(buf) {
	const tar = gunzipSync(buf);
	const out = new Map();
	let off = 0;
	while (off + 512 <= tar.length) {
		const name = tar.toString("utf8", off, off + 100).replace(/\0.*$/, "").trim();
		if (!name) break;
		const size = parseInt(tar.toString("utf8", off + 124, off + 136).replace(/\0.*$/, "").trim() || "0", 8);
		if (name.startsWith("package/")) out.set(name.slice("package/".length), tar.subarray(off + 512, off + 512 + size));
		off += 512 + Math.ceil(size / 512) * 512;
	}
	return out;
}

// ---------- 用 gh 打 GitHub API（Node 的 fetch 在本机常被 TLS 掐断，gh 更稳） ----------
function ghApi(path) {
	const raw = execFileSync("gh", ["api", path], { maxBuffer: 1e9 });
	return JSON.parse(raw.toString("utf8"));
}
function ghApiRaw(path) {
	return execFileSync("gh", ["api", path], { maxBuffer: 1e9 });
}

console.log(`三方比对：${pkg.name}@${pkg.version}   (git ref=${REF})\n`);

// ---------- ① git 远端 ----------
console.log("① 拉取 git 远端 tree …");
const refInfo = ghApi(`repos/nonentity303/dsh-plugin-manager/git/ref/heads/${REF}`);
const headSha = refInfo.object.sha;
const tree = ghApi(`repos/nonentity303/dsh-plugin-manager/git/trees/${headSha}?recursive=1`);
const remoteBlobs = new Map();
for (const e of tree.tree || []) if (e.type === "blob") remoteBlobs.set(e.path, e.sha);
console.log(`   远端 HEAD = ${headSha.slice(0, 12)}，blob 数 = ${remoteBlobs.size}`);

// 发布白名单（package.json 的 files）
const whitelist = [
	"lib/aggregate.js", "lib/client.js", "lib/compare-versions.js", "lib/downloader.js",
	"lib/enginectl.mjs", "lib/index.js", "lib/platform.js", "lib/preflight.mjs",
	"lib/readme-intro.js", "lib/remote.js", "lib/rescue.js",
	"bin/dsh-boot.cmd", "bin/dsh-boot.mjs", "bin/open-boot.mjs", "bin/rescue-daemon.mjs",
	"cordis.patch.yml", "README.md", "LICENSE", "package.json",
];

// 远端文件内容（按 blob sha 取，走 git blob API —— 用 base64 解码，避免编码问题）
const remoteFiles = new Map();
for (const rel of whitelist) {
	const sha = remoteBlobs.get(rel);
	if (!sha) {
		remoteFiles.set(rel, null);
		continue;
	}
	try {
		const blob = ghApi(`repos/nonentity303/dsh-plugin-manager/git/blobs/${sha}`);
		remoteFiles.set(rel, Buffer.from(blob.content, blob.encoding || "base64"));
	} catch (e) {
		remoteFiles.set(rel, null);
	}
}

// ---------- ② npm registry tgz ----------
console.log("② 下载 npm registry 上的 tgz …");
const meta = await (await fetch(`https://registry.npmjs.org/${pkg.name}`, { headers: { "user-agent": "dsh" } })).json();
const pub = meta.versions[pkg.version];
const pubTgz = Buffer.from(await (await fetch(pub.dist.tarball)).arrayBuffer());
const pubFiles = readTar(pubTgz);
const pubIntegrity = "sha512-" + createHash("sha512").update(pubTgz).digest("base64");
console.log(`   ${pub.dist.tarball}`);
console.log(`   大小 ${pubTgz.length} B | integrity 自洽: ${pubIntegrity === pub.dist.integrity ? "✅" : "❌"}`);

// ---------- ③ 本地 ----------
console.log("③ 读本地工作树 + 本地 tgz …\n");
const localTgzPath = join(ROOT, `${pkg.name}-${pkg.version}.tgz`);
const localFiles = new Map();
for (const rel of whitelist) {
	const p = join(ROOT, rel);
	localFiles.set(rel, existsSync(p) ? readFileSync(p) : null);
}
const localTgzFiles = existsSync(localTgzPath) ? readTar(readFileSync(localTgzPath)) : null;
console.log(`   本地 tgz: ${existsSync(localTgzPath) ? localTgzPath : "（不存在，用 npm pack 生成后再比）"}\n`);

// ---------- 比对表 ----------
const h = (b) => (b === null || b === undefined ? "—— 缺失 ——" : sha256(b).slice(0, 16));
const size = (b) => (b === null || b === undefined ? "-" : String(b.length));

console.log("文件".padEnd(24) + "git远端 sha256(前16)".padEnd(24) + "npm线上 sha256(前16)".padEnd(24) + "本地 sha256(前16)".padEnd(24) + "三者一致");
console.log("-".repeat(110));
let allSame = true;
for (const rel of whitelist) {
	const g = h(remoteFiles.get(rel));
	const n = h(pubFiles.get(rel));
	const l = h(localFiles.get(rel));
	const same = g === n && n === l;
	if (!same) allSame = false;
	console.log(rel.padEnd(24) + g.padEnd(24) + n.padEnd(24) + l.padEnd(24) + (same ? "✅" : "❌"));
}

console.log("\n大小对照（git远端 / npm线上 / 本地）:");
for (const rel of whitelist) {
	const g = size(remoteFiles.get(rel)), n = size(pubFiles.get(rel)), l = size(localFiles.get(rel));
	if (g !== n || n !== l) console.log(`  ${rel.padEnd(24)} ${g.padStart(8)} / ${n.padStart(8)} / ${l.padStart(8)}   ← 大小不同`);
}

// ---------- 差异诊断 ----------
console.log("\n差异诊断（首个不同字节）:");
for (const rel of whitelist) {
	const a = remoteFiles.get(rel), b = pubFiles.get(rel), c = localFiles.get(rel);
	if (sha256(a ?? Buffer.alloc(0)) === sha256(b ?? Buffer.alloc(0)) && sha256(b ?? Buffer.alloc(0)) === sha256(c ?? Buffer.alloc(0))) continue;
	const pairs = [["git远端 vs npm线上", a, b], ["npm线上 vs 本地", b, c]];
	for (const [label, x, y] of pairs) {
		if (!x || !y) continue;
		if (x.equals(y)) continue;
		const n = Math.min(x.length, y.length);
		let i = 0;
		while (i < n && x[i] === y[i]) i++;
		console.log(`  ${rel} [${label}] 首个差异 @${i}: "${x.subarray(i, i + 30).toString("utf8").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}" vs "${y.subarray(i, i + 30).toString("utf8").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`);
	}
}

// ---------- 本地 tgz 与线上 tgz ----------
if (localTgzFiles) {
	let same = localTgzFiles.size === pubFiles.size;
	for (const [k, v] of pubFiles) {
		const lv = localTgzFiles.get(k);
		if (!lv || !lv.equals(v)) same = false;
	}
	console.log(`\n本地 tgz vs npm 线上 tgz：${same ? "✅ 逐文件一致" : "❌ 有差异"}`);
	const localTgzHash = sha256(readFileSync(localTgzPath));
	const pubHash = sha256(pubTgz);
	console.log(`  本地 tgz sha256: ${localTgzHash}`);
	console.log(`  线上 tgz sha256: ${pubHash}`);
}

console.log(`\n结论：git 远端 ↔ npm 线上 ↔ 本地 ${allSame ? "✅ 三者逐文件 sha256 完全一致" : "❌ 存在差异（见上表）"}`);
