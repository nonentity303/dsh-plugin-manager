#!/usr/bin/env node
/**
 * tools/dev/publish-webauth.mjs — 用「安全密钥 / Windows Hello」完成 npm 发布的 2FA
 *
 * 背景（为什么需要这个脚本）：
 *   本机 npm 11.19.0 在发布被 2FA 拦下时，只认 `--otp`（TOTP 六位码），
 *   并不会读取 registry 返回的 `npm-notice` 响应头——而那个头里才是
 *   「用安全密钥认证」的入口：
 *     npm-notice: Open https://www.npmjs.com/login/<uuid> to use your security key for authentication
 *   所以对"只用 WebAuthn/Windows Hello、没有 TOTP"的账号，CLI 会卡在
 *   "This operation requires a one-time password" 上，且打印出来的 URL 还被 *** 打码。
 *
 * 本脚本做的事：
 *   1) 发一个**无害的探测请求**（PUT 空 body 到包名，必然被拒，不会改动 registry），
 *      从响应头里取未打码的 npm-notice 网址；
 *   2) 用系统默认浏览器（Edge）打开它，你在浏览器里用 Windows Hello 确认；
 *   3) 轮询一个哨兵请求，直到不再返回 401（= 认证已生效）或超时；
 *   4) 认证生效后调用 npm publish 完成发布（带 --otp 时会自动带上）。
 *
 * 用法：
 *   node tools/dev/publish-webauth.mjs            # 走浏览器授权流程
 *   node tools/dev/publish-webauth.mjs --no-open  # 只打印网址，不自动开浏览器
 *   node tools/dev/publish-webauth.mjs --wait 300 # 等待秒数（默认 180）
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const NO_OPEN = argv.includes("--no-open");
const waitIdx = argv.indexOf("--wait");
const WAIT_S = waitIdx >= 0 ? Number(argv[waitIdx + 1] || 180) : 180;

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const REG = "https://registry.npmjs.org";
const UA = `npm/11.19.0 node/${process.versions.node} win32 x64`;

const grabToken = (file) => {
	if (!existsSync(file)) return null;
	const m = readFileSync(file, "utf8").match(/_authToken\s*=\s*(\S+)/);
	return m ? m[1] : null;
};
// 候选 token：项目 .npmrc 优先，其次用户级（npm login 写入的那枚）
const candidates = [
	{ label: "项目 .npmrc", token: grabToken(join(ROOT, ".npmrc")) },
	{ label: "用户 ~/.npmrc", token: grabToken(join(homedir(), ".npmrc")) },
].filter((c) => c.token);

if (!candidates.length) {
	console.error("✘ 找不到 _authToken（项目 .npmrc / 用户 .npmrc）");
	process.exit(1);
}

const PROBE_BODY = () =>
	JSON.stringify({
		_id: `${pkg.name}@0.0.0-probe`,
		name: pkg.name,
		version: "0.0.0-probe",
		description: "auth probe",
		"dist-tags": { latest: "0.0.0-probe" },
		versions: { "0.0.0-probe": { name: pkg.name, version: "0.0.0-probe" } },
		_attachments: {},
	});

const probeWith = async (token) => {
	// 必须带合法结构 body，否则 registry 在 auth 之前先返回 400，分不清「认证通过」与「body 不合法」
	const res = await fetch(`${REG}/${pkg.name}`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"npm-command": "publish",
			"user-agent": UA,
		},
		body: PROBE_BODY(),
	});
	return { status: res.status, notice: res.headers.get("npm-notice"), auth: res.headers.get("www-authenticate") };
};

const openBrowser = (url) => {
	if (NO_OPEN) return;
	try {
		spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
		console.log("   （已用默认浏览器打开）");
	} catch (e) {
		console.log("   ✘ 自动打开失败，请手动复制上面的网址：", e.message);
	}
};

const main = async () => {
	console.log(`包：${pkg.name}@${pkg.version}`);

	// 挑出「真正有写权限」的那枚 token：401 = 认证层通过（只是缺 2FA）；404 = 无效/无写权限（registry 故意掩盖）
	let chosen = null;
	for (const c of candidates) {
		const r = await probeWith(c.token);
		const tag = r.status === 401 ? "✅ 有写权限" : r.status === 404 ? "❌ 无写权限（404 掩盖 401）" : `? HTTP ${r.status}`;
		console.log(`  ${c.label.padEnd(13)} ${c.token.slice(0, 12)}…${c.token.slice(-6)}  HTTP ${r.status}  ${tag}`);
		if (r.status === 401 && !chosen) chosen = { ...c, notice: r.notice };
	}
	if (!chosen) {
		console.log("\n✘ 没有一枚 token 具备发布权限。请重签一枚带 Read and write 的 token。");
		process.exit(1);
	}
	console.log(`\n使用：${chosen.label} 的 token`);

	if (!chosen.notice) {
		console.log("✘ 该 token 未触发安全密钥流程（registry 没给 npm-notice）。");
		console.log("  可选：① 换一枚带 Bypass 2FA 的 granular token ② 用 --otp <6位> 发布");
		process.exit(1);
	}
	const url = chosen.notice.replace(/^Open\s+/, "").replace(/\s+to use your security key.*$/, "").trim();
	console.log("\n用安全密钥（Windows Hello）完成认证：");
	console.log("  " + url + "\n");
	writeFileSync(join(ROOT, "auth-url-last.txt"), url + "\n", "utf8");
	openBrowser(url);

	// 让 npm 用这枚 token 发布（写成临时 env，避免动到仓库里的 .npmrc）
	const publishEnv = { ...process.env, npm_config_cache: join(ROOT, ".npm-cache") };
	publishEnv[`npm_config_//registry.npmjs.org/:_authToken`] = chosen.token;

	console.log(`等待认证生效（最多 ${WAIT_S} 秒）…`);
	console.log("  进度判据：反复尝试**真正的发布**——npm 的 web token 是写进 CLI 会话的，");
	console.log("  只有真的调 publish 才知道认证到底生效没有（探测请求看不出浏览器会话）。");
	const start = Date.now();
	const deadline = start + WAIT_S * 1000;
	let attempt = 0;
	while (Date.now() < deadline) {
		attempt++;
		await new Promise((r) => setTimeout(r, 20000));
		const el = Math.round((Date.now() - start) / 1000);
		const r = spawnSync("npm", ["publish", "--tag", "latest"], {
			cwd: ROOT,
			encoding: "utf8",
			shell: true,
			env: publishEnv,
		});
		const out = (r.stdout || "") + (r.stderr || "");
		if (r.status === 0 && out.includes(`+ ${pkg.name}@`)) {
			process.stdout.write("\n");
			console.log(`✅ 第 ${attempt} 次尝试发布成功（用时约 ${el}s）`);
			console.log(out.split("\n").filter(Boolean).slice(-6).join("\n"));
			process.exit(0);
		}
		if (/EOTP|one-time password/i.test(out)) {
			process.stdout.write(`  [${el}s] 第 ${attempt} 次：仍未认证（EOTP）\r`);
			continue;
		}
		process.stdout.write("\n");
		console.log(`✘ 第 ${attempt} 次尝试失败，且不是 2FA 问题（退出码 ${r.status}）：`);
		console.log(out.split("\n").filter(Boolean).slice(-12).join("\n"));
		process.exit(1);
	}
	console.log("");
	console.log("✘ 等待超时：认证仍未生效。可以重跑本脚本（会换新链接），或改用带 Bypass 2FA 的 token。");
	process.exit(1);
};

main().catch((e) => {
	console.error("失败：", e && e.message);
	process.exit(1);
});
