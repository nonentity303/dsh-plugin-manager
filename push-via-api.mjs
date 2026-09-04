// push-via-api.mjs — 当 github.com:443 被墙时，用 Git Data API (api.github.com) 推送本地 commit。
// 用法: node push-via-api.mjs <local-commit-sha> <branch> [tag]
import { execSync } from "node:child_process";

const repo = "nonentity303/dsh-plugin-manager";
const commitSha = process.argv[2];
const branch = process.argv[3] || "master";
const tag = process.argv[4] || null;
if (!commitSha) { console.error("usage: node push-via-api.mjs <commit> [branch] [tag]"); process.exit(1); }

const token = execSync("gh auth token", { encoding: "utf8" }).trim();
const api = "https://api.github.com";
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "dsh-gitapi-push" };
const j = (r) => r.json();

async function apiReq(method, path, body) {
	const res = await fetch(`${api}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}

// 1) 本地 tree 全量
const treeLines = execSync(`git ls-tree -r ${commitSha}`, { encoding: "utf8" }).split("\n").filter(Boolean);
const entries = treeLines.map((line) => {
	const [meta, type, sha, ...rest] = line.split(/\s+/);
	return { path: rest.join(" "), mode: meta, type, sha };
});
console.log(`local tree: ${entries.length} entries (commit ${commitSha})`);

// 2) 远端现有 blob（parent 分支当前 sha 的 tree）
let parentSha = null;
try {
	const ref = await apiReq("GET", `/repos/${repo}/git/ref/heads/${branch}`);
	parentSha = ref.object.sha;
} catch { parentSha = null; console.log("branch ref not found (first push?)"); }
const remoteBlobs = new Set();
if (parentSha) {
	const rt = await apiReq("GET", `/repos/${repo}/git/trees/${parentSha}?recursive=1`);
	for (const t of rt.tree || []) if (t.type === "blob") remoteBlobs.add(t.sha);
}

// 3) 创建缺失的 blob
const newBlobs = entries.filter((e) => e.type === "blob" && !remoteBlobs.has(e.sha));
console.log(`blobs to create: ${newBlobs.length}`);
for (const e of newBlobs) {
	const content = execSync(`git cat-file -p ${e.sha}`, { encoding: "utf8", maxBuffer: 1e8 });
	const blob = await apiReq("POST", `/repos/${repo}/git/blobs`, {
		content: Buffer.from(content, "utf8").toString("base64"),
		encoding: "base64"
	});
	if (blob.sha !== e.sha) throw new Error(`blob sha mismatch for ${e.path}`);
	console.log(`  blob ok: ${e.path}`);
}

// 4) 创建 tree
const tree = await apiReq("POST", `/repos/${repo}/git/trees`, {
	base_tree: parentSha ? undefined : undefined,
	tree: entries.map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha }))
});
console.log(`tree: ${tree.sha}`);

// 5) 创建 commit
const commit = await apiReq("POST", `/repos/${repo}/git/commits`, {
	message: execSync(`git log -1 --format=%s%n%n%b ${commitSha}`, { encoding: "utf8" }).trim(),
	tree: tree.sha,
	parents: parentSha ? [parentSha] : []
});
console.log(`commit: ${commit.sha}`);

// 6) 更新分支 ref
await apiReq("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log(`branch ${branch} -> ${commit.sha}`);

// 7) 可选：创建 tag（轻量 tag = 指向 commit 的 ref）
if (tag) {
	try {
		await apiReq("POST", `/repos/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha: commit.sha });
		console.log(`tag ${tag} -> ${commit.sha}`);
	} catch (e) {
		console.log(`tag ${tag}: ${e.message}`);
	}
}
console.log("DONE");
