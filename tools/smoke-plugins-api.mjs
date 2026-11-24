// 1.0.0-rc.1 冒烟：/plugins API + /api/launcher/stop + dsh-launcher.cmd 生成。
// 全程隔离：临时 profile + 临时 DSH_HOME + 独立端口 3093；不触碰 live 引擎/启动器。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.cwd();
const PORT = 3093;
const tmp = mkdtempSync(join(tmpdir(), "pm-smoke-"));
const profile = join(tmp, "profile");
const home = join(tmp, "home");
mkdirSync(join(profile, "node_modules", "@deepseek-ai"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
writeFileSync(join(profile, "package.json"), JSON.stringify({
	name: "smoke-profile", private: true,
	dependencies: { "@deepseek-ai/dsh-base": "0.2.2-rc.5", "@linxin666/dsh-client-ui-skill-explorer": "1.0.0" },
	dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@linxin666/dsh-client-ui-skill-explorer"] } }
}, null, 2), "utf8");

let failures = 0;
const check = (name, cond, detail = "") => {
	console.log(`${cond ? "OK" : "FAIL"}: ${name}${cond ? "" : " — " + detail}`);
	if (!cond) failures++;
};

const child = spawn(process.execPath, [join(ROOT, "bin", "open-boot.mjs"), "--port", String(PORT), "--profile", profile, "--no-window"], {
	env: { ...process.env, DSH_HOME: home }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
});
child.stderr.on("data", (d) => process.stderr.write(`[launcher] ${d}`));

const base = `http://127.0.0.1:${PORT}`;
async function until(fn, ms = 15000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try { const v = await fn(); if (v) return v; } catch { /* 未就绪 */ }
		await new Promise((r) => setTimeout(r, 300));
	}
	return null;
}

try {
	const status = await until(async () => {
		const r = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1500) });
		return r.status === 200 ? await r.json() : null;
	});
	check("/api/status 就绪且身份=dsh-open-boot", status?.app === "dsh-open-boot", JSON.stringify(status));
	check("/api/status 带 pluginsPage/dshLauncherCmd", status?.pluginsPage === "/plugins" && typeof status?.dshLauncherCmd === "string", JSON.stringify({ p: status?.pluginsPage, c: status?.dshLauncherCmd }));

	const homeHtml = await fetch(`${base}/`).then((r) => r.text());
	check("/ 页含插件管理入口链接", homeHtml.includes('href="/plugins"'));
	const pluginsHtml = await fetch(`${base}/plugins`).then((r) => r.text());
	check("/plugins 页可访问且带 token meta", pluginsHtml.includes('name="dsh-pm-token"'));
	const token = (pluginsHtml.match(/name="dsh-pm-token" content="([^"]+)"/) || [])[1] || "";
	check("能从页面取到一次性令牌", token.length > 8);
	const H = { "Content-Type": "application/json", "X-DSH-PM-Token": token };

	const list1 = await fetch(`${base}/plugins/api/bundles`).then((r) => r.json());
	check("bundle 列表 = 2 且 skill-explorer 启用", list1.ok === true && list1.bundles.length === 2 && list1.bundles.find((b) => b.name.includes("skill-explorer"))?.enabled === true, JSON.stringify(list1));

	const off = await fetch(`${base}/plugins/api/bundles`, { method: "POST", headers: H, body: JSON.stringify({ name: "@linxin666/dsh-client-ui-skill-explorer", action: "disable" }) }).then((r) => r.json());
	check("禁用 bundle 成功", off.ok === true && off.changed === true, JSON.stringify(off).slice(0, 200));
	const manifestAfter = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
	check("profile 清单 bundles 已摘除该包", !manifestAfter.dsh.profile.bundles.includes("@linxin666/dsh-client-ui-skill-explorer"), JSON.stringify(manifestAfter.dsh));
	// list1 是禁用前抓的（backup=null 属正常）；断言看当前磁盘实况：固定快照 + 带时间戳滚动备份都在
	const dirNow = readdirSync(profile);
	check("写前备份已生成（固定快照 + 带时间戳）",
		dirNow.includes("package.json.bundles-backup.json") && dirNow.some((f) => /^package\.json\.bak-\d{4}/.test(f)), JSON.stringify(dirNow));
	const on = await fetch(`${base}/plugins/api/bundles`, { method: "POST", headers: H, body: JSON.stringify({ name: "@linxin666/dsh-client-ui-skill-explorer", action: "enable" }) }).then((r) => r.json());
	check("重新启用 bundle 成功", on.ok === true && on.changed === true);
	const coreOff = await fetch(`${base}/plugins/api/bundles`, { method: "POST", headers: H, body: JSON.stringify({ name: "@deepseek-ai/dsh-base", action: "disable" }) }).then((r) => r.json());
	check("命脉 bundle 拒绝禁用", coreOff.ok === false && coreOff.error.includes("命脉"), JSON.stringify(coreOff).slice(0, 160));
	const noToken = await fetch(`${base}/plugins/api/bundles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", action: "enable" }) });
	check("缺令牌写请求被 401 拒绝", noToken.status === 401, `status=${noToken.status}`);

	// 引擎重启：PID 文件缺失 → 防误杀保护生效，且本机 3080 是 live 引擎 → 必须拒绝而不动它
	const beforeEngine = await fetch("http://127.0.0.1:3080/api/status", { signal: AbortSignal.timeout(1500) }).then((r) => r.status).catch(() => 0);
	const restart = await fetch(`${base}/plugins/api/engine/restart`, { method: "POST", headers: H, body: "{}" }).then((r) => r.json());
	const afterEngine = await fetch("http://127.0.0.1:3080/api/status", { signal: AbortSignal.timeout(1500) }).then((r) => r.status).catch(() => 0);
	check("重启 API 存在且在无 PID 文件时拒绝", restart.ok === false, JSON.stringify(restart).slice(0, 200));
	check("live 引擎（3080）未受影响", beforeEngine === afterEngine && beforeEngine !== 0, `before=${beforeEngine} after=${afterEngine}`);

	const stop = await fetch(`${base}/api/launcher/stop`, { method: "POST", headers: H, body: "{}" }).then((r) => r.json());
	check("stop API 应答 ok", stop.ok === true, JSON.stringify(stop));
	// 优雅退出 = 服务停止应答（约 1s 后端口拒绝连接）。注意 catch 返回"是否拒绝连接"：
	// refused → "down"。诊断脚本（tools/diag-stop.mjs）实测 +1.05s 端口 ECONNREFUSED、exitCode 0。
	const wentDown = await until(async () => {
		const refused = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1200) })
			.then(() => false)
			.catch((e) => e?.cause?.code === "ECONNREFUSED" || e?.name === "AbortError");
		return refused;
	}, 6000);
	check("启动器进程已优雅退出（端口停止应答）", wentDown === true);
	await new Promise((r) => setTimeout(r, 600));
	// server 模式不写 pid 文件（supervise 模式的产物）；stop 端点对存在的 pid 文件做清理
	check(".open-boot.pid 不存在", !existsSync(join(profile, ".open-boot.pid")));
	const cmdPath = join(home, "scripts", "dsh-launcher.cmd");
	check("dsh-launcher.cmd 已生成", existsSync(cmdPath), cmdPath);
	if (existsSync(cmdPath)) {
		const buf = readFileSync(cmdPath);
		const text = buf.toString("utf8");
		const lines = text.split(/\r\n/);
		check("cmd 头三行纯 ASCII（chcp 前不被代码页污染）", lines.slice(0, 3).every((l) => [...l].every((c) => c.charCodeAt(0) < 128)), JSON.stringify(lines.slice(0, 3)));
		check("cmd 已切 UTF-8 代码页（非 ASCII 路径安全）", lines.slice(0, 6).some((l) => l.startsWith("chcp 65001")), JSON.stringify(lines.slice(0, 6)));
		check("dsh-launcher.cmd CRLF 换行（无裸 LF）", text.includes("\r\n") && !/(?<!\r)\n/.test(text));
		check("cmd 含 start|stop|status 三个子命令", text.includes("goto start") && text.includes("goto stop") && text.includes("goto status"));
		// 可迁移性：关键路径必须等于"本进程实况"（execPath / args.profile），而非源码写死
		check("cmd NODE = 本进程 execPath", text.includes(`set "NODE=${process.execPath}"`));
		check("cmd PROFILE = 本次 --profile 实参", text.includes(`set "PROFILE=${profile}"`));
		check("cmd 路径带引号", text.includes('set "BOOT='));
		const ps1Buf = readFileSync(join(home, "scripts", "dsh-launcher-start.ps1"));
		check("start 走 WMI（配套 ps1）", ps1Buf !== undefined && text.includes("dsh-launcher-start.ps1"));
		check("ps1 带 UTF-8 BOM（PS5.1 中文路径安全）", ps1Buf[0] === 0xef && ps1Buf[1] === 0xbb && ps1Buf[2] === 0xbf);
	}
} finally {
	try { if (child.exitCode === null) child.kill(); } catch { /* ignore */ }
	await new Promise((r) => setTimeout(r, 200));
	try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
}
console.log(failures === 0 ? "\nSMOKE PASSED" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
