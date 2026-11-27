#!/usr/bin/env node
/**
 * tools/dev/deprecate-legacy.mjs — 对旧包 dsh-plugin-manager-pro 的 0.9.1 之前版本做弃用加固
 *
 * 为什么不用 `npm deprecate`：CLI 在非 TTY 下直接抛 EOTP（`otplease` 不发 webauth），
 * 且错误里的 authUrl 被打码；与 publish-webauth 同款绕行：raw PUT 读 `npm-notice`
 * 拿未打码的一次性授权 URL → 浏览器安全密钥 → 页面 16 位 OTP → 带 `npm-otp` 头重 PUT。
 *
 * 用法：
 *   node tools/dev/deprecate-legacy.mjs --plan
 *      只读：列出目标版本、当前弃用状态、将写入的文案（零写入）
 *   node tools/dev/deprecate-legacy.mjs --apply
 *      第一次 PUT：若 401 且带 npm-notice，打印授权 URL 后退出（code 2）
 *   node tools/dev/deprecate-legacy.mjs --apply --otp <16位>
 *      带 OTP 重 PUT；200 {"success":true} 即完成
 *
 * 目标：< 0.9.1 的正式版 + 0.9.1-rc2 预发布（0.9.1 自身保留已有弃用提示）。
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PKG = "dsh-plugin-manager-pro";
const REG = "https://registry.npmjs.org";
const UA = `npm/11.19.0 node/${process.versions.node} win32 x64`;
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const OTP = args.includes("--otp") ? String(args[args.indexOf("--otp") + 1] || "") : "";

const MESSAGE_LEGACY = "⛔ 0.9.1 之前的版本已淘汰：存在已知供应链风险（CVE-494 类投毒链），且 Node<22.14 加载即崩。请勿安装；升级到 dsh-drydock@^1.0.4（dsh plugin --profile web add dsh-drydock@^1.0.4）。";
const MESSAGE_RC = "⛔ 预发布存档，切勿使用；请升级到 dsh-drydock@^1.0.4。";

const grabToken = (file) => {
	if (!existsSync(file)) return null;
	const m = readFileSync(file, "utf8").match(/_authToken\s*=\s*(\S+)/);
	return m ? m[1] : null;
};
const token = grabToken(join(homedir(), ".npmrc")) || grabToken(join(process.cwd(), ".npmrc"));
if (!token) {
	console.error("✘ 找不到 _authToken（用户 ~/.npmrc）");
	process.exit(1);
}

const plan = (doc) => {
	const targets = [];
	for (const [version, meta] of Object.entries(doc.versions ?? {})) {
		const messages = [];
		if (version === "0.9.1-rc2" || version.includes("-")) messages.push(MESSAGE_RC);
		else if (version !== "0.9.1" && compare(version, "0.9.1") < 0) messages.push(MESSAGE_LEGACY);
		if (messages.length === 0) continue;
		targets.push({ version, current: meta.deprecated ?? null, next: messages[0] });
	}
	return targets;
};

/** 极简 semver 比较（只处理 x.y.z 正式版）。 */
function compare(a, b) {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i += 1) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

const getDoc = async () => {
	const res = await fetch(`${REG}/${PKG}`, { headers: { accept: "application/json", "user-agent": UA } });
	if (!res.ok) throw new Error(`GET packument 失败：HTTP ${res.status}`);
	return await res.json();
};

const putDoc = async (doc) => {
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": UA,
		"npm-command": "deprecate"
	};
	if (OTP) headers["npm-otp"] = OTP;
	const res = await fetch(`${REG}/${PKG}`, { method: "PUT", headers, body: JSON.stringify(doc) });
	return { status: res.status, notice: res.headers.get("npm-notice"), body: await res.text() };
};

const doc = await getDoc();
const targets = plan(doc);
console.log(`包：${PKG}；目标版本 ${targets.length} 个：`);
for (const t of targets) console.log(`  ${t.version.padEnd(10)} 当前弃用=${t.current ? "有" : "无"} → ${t.next.slice(0, 40)}…`);
if (!APPLY) {
	console.log("\n--plan 模式：零写入。加 --apply 执行（首次会打印授权 URL）。");
	process.exit(0);
}

for (const t of targets) doc.versions[t.version].deprecated = t.next;
const result = await putDoc(doc);
console.log(`PUT 结果：HTTP ${result.status}`);
if (result.status === 200) {
	console.log("✅ 弃用加固完成");
	process.exit(0);
}
if (result.status === 401 && result.notice) {
	console.log(`\n需要安全密钥认证（一次性 URL，只开一次）：\n${result.notice}`);
	console.log("\n浏览器完成 Windows Hello 后，把页面上的 16 位 OTP 传入：");
	console.log(`  node tools/dev/deprecate-legacy.mjs --apply --otp <16位>`);
	process.exit(2);
}
console.log(result.body.slice(0, 400));
process.exit(1);
