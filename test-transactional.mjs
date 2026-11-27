// test-transactional.mjs — 1.0.0-rc.2 事务链集成测试（假 pnpm 矩阵 + patch 清理 + EBUSY fail-closed
// + PKG_NAME_RE 表驱动 + 鉴权矩阵 + 单飞 409）。全程隔离：临时 profile + 临时 DSH_HOME +
// 独立端口（launcher 3094 / engine 3096）+ 假 pnpm（PATH 注入），不触碰 live 引擎/启动器。
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createRawServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chunkMatchesPackage, removePatchEntriesFromFile } from "./lib/patch-clean.mjs";

const ROOT = process.cwd();
const PORT = 3094;          // 启动器（open-boot 服务模式）
const ENGINE_PORT = 3096;   // 引擎端口（engineBusyGate 探测目标，必须隔离）
const tmp = mkdtempSync(join(tmpdir(), "pm-tx-"));
const profile = join(tmp, "profile");
const home = join(tmp, "home");
const fakebin = join(tmp, "fakebin");
const fakeLog = join(tmp, "pnpm-calls.log");
const modeFile = join(tmp, "pnpm-mode.txt");
mkdirSync(join(profile, "node_modules", "@example"), { recursive: true });
mkdirSync(join(home, "logs"), { recursive: true });
mkdirSync(fakebin, { recursive: true });

const TARGET = "@example/user-mod";
const NEIGHBOR = "@example/user-mod-extra";
const OTHER = "@example/other-plugin";
const manifest0 = {
	name: "tx-profile", private: true,
	dependencies: { "@deepseek-ai/dsh-base": "0.2.2-rc.5", [TARGET]: "1.0.0", [NEIGHBOR]: "1.0.0" },
	dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", TARGET, NEIGHBOR] } }
};
writeFileSync(join(profile, "package.json"), JSON.stringify(manifest0, null, 2), "utf8");
// patch fixture：目标包的 3 种真实形态 + 2 个邻居块（含 target 名字的**超串**，验证不误删）
const patch0 = [
	"# patch fixture（test-transactional 生成）",
	`- target: "${OTHER}"`,
	"  keys:",
	`    - name: "${OTHER}"`,
	`- target: "${TARGET}"`,
	"  keys:",
	`    - name: ${TARGET}`,                        // 形态①：行级无引号
	`- target: "${TARGET}"`,
	"  keys:",
	`    - name: "${TARGET}",`,                     // 形态②：行级带引号 + 尾逗号
	`- target: "${TARGET}"`,
	"  keys:",
	`    - [{ id: "${TARGET}", enabled: true }, { id: "sub", enabled: false }]`, // 形态③：块级 flow-style
	`- target: "${NEIGHBOR}"`,
	"  keys:",
	`    - name: "${NEIGHBOR}"`                     // 邻居块：target 的名字是它的**前缀超串**
].join("\n") + "\n";
writeFileSync(join(profile, "cordis.patch.yml"), patch0, "utf8");

// ---- 假 pnpm：pnpm.cmd 包装 + node 脚本；行为由 mode 文件控制（ok / fail / timeout）
writeFileSync(join(fakebin, "pnpm.cmd"), "@echo off\r\nnode \"%~dp0fake-pnpm.cjs\" %*\r\n", "utf8");
writeFileSync(join(fakebin, "fake-pnpm.cjs"), `\
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
let mode = "ok";
try { mode = fs.readFileSync(process.env.PM_FAKE_MODE_FILE, "utf8").trim() || "ok"; } catch {}
try { fs.appendFileSync(process.env.PM_FAKE_LOG, JSON.stringify({ args, mode }) + "\\n"); } catch {}
const sub = args[0];
if (sub === "remove") {
	if (mode === "fail") { process.stderr.write("ERR_PNPM_FAKE_FAIL simulated pnpm remove failure\\n"); process.exit(1); }
	if (mode === "timeout") { console.log("fake remove hanging (simulating stuck pnpm)"); setInterval(() => {}, 1000); return; }
	const pkg = args[1];
	const manifestPath = path.join(process.cwd(), "package.json");
	const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	delete m.dependencies[pkg];
	fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
	console.log("fake removed " + pkg);
	process.exit(0);
}
if (sub === "ls") { console.log("fake-ls: nothing matches"); process.exit(0); }
if (sub === "outdated") { console.log("{}"); process.exit(0); }
console.log("fake pnpm ok");
process.exit(0);
`, "utf8");
const setMode = (mode) => writeFileSync(modeFile, mode, "utf8");
setMode("ok");

let failures = 0;
// 挂起保险丝：2 分钟仍未跑完（多半是清理阶段的 socket 卡住）→ 直接判失败退出，不留僵进程
setTimeout(() => { console.log("FAIL: 挂起保险丝触发（>120s 未完成）"); process.exit(1); }, 120000).unref();
const check = (name, cond, detail = "") => {
	console.log(`${cond ? "OK" : "FAIL"}: ${name}${cond ? "" : " — " + detail}`);
	if (!cond) failures++;
};
const readManifest = () => JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 启动器（服务模式；PATH 注入假 pnpm；pnpm 默认超时降到 1.2s 供 timeout 用例）
const child = spawn(process.execPath, [join(ROOT, "bin", "open-boot.mjs"), "--port", String(PORT), "--profile", profile, "--no-window"], {
	env: {
		...process.env, DSH_HOME: home, DSH_ENGINE_PORT: String(ENGINE_PORT),
		DSH_PM_PNPM_TIMEOUT_MS: "1200",
		PM_FAKE_LOG: fakeLog, PM_FAKE_MODE_FILE: modeFile,
		PATH: `${fakebin};${process.env.PATH}`
	},
	stdio: ["ignore", "pipe", "pipe"], windowsHide: true
});
child.stderr.on("data", (d) => process.stderr.write(`[launcher] ${d}`));

const base = `http://127.0.0.1:${PORT}`;
async function until(fn, ms = 15000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try { const v = await fn(); if (v) return v; } catch { /* 未就绪 */ }
		await sleep(300);
	}
	return null;
}

try {
	const status = await until(async () => {
		const r = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1500) });
		return r.status === 200 ? await r.json() : null;
	});
	check("启动器服务就绪", status?.app === "dsh-open-boot", JSON.stringify(status));

	const pluginsHtml = await fetch(`${base}/plugins`).then((r) => r.text());
	const token = (pluginsHtml.match(/name="dsh-pm-token" content="([^"]+)"/) || [])[1] || "";
	const H = { "Content-Type": "application/json", "X-DSH-PM-Token": token };
	check("能取到一次性令牌", token.length > 8);

	// ---- 1) 鉴权矩阵（P1-6）：5 个端点 × 无令牌/错令牌/对令牌
	const authEndpoints = [
		["GET", "/plugins/api/updates", null],
		["GET", "/plugins/api/health", null],
		["POST", "/plugins/api/update", JSON.stringify({ name: "@example/nonexistent-pkg" })],
		["POST", "/plugins/api/uninstall", JSON.stringify({ name: "@example/nonexistent-pkg" })],
		["POST", "/plugins/api/bundles", JSON.stringify({ name: "@example/nonexistent-pkg", action: "enable" })]
	];
	for (const [method, path, body] of authEndpoints) {
		const none = await fetch(`${base}${path}`, { method, body });
		const wrong = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", "X-DSH-PM-Token": "deadbeef".repeat(6) }, body });
		const right = await fetch(`${base}${path}`, { method, headers: H, body });
		check(`鉴权矩阵 ${method} ${path}：无令牌 401 / 错令牌 401 / 对令牌非 401`,
			none.status === 401 && wrong.status === 401 && right.status !== 401,
			`none=${none.status} wrong=${wrong.status} right=${right.status}`);
	}

	// ---- 2) PKG_NAME_RE 表驱动（从源码提取正则字面量，钉死白名单口径）
	const src = readFileSync(join(ROOT, "bin", "open-boot.mjs"), "utf8");
	const reMatch = src.match(/const PKG_NAME_RE = (\/.+\/);/);
	const PKG_NAME_RE = reMatch ? eval(reMatch[1]) : null;
	check("PKG_NAME_RE 可从源码提取", PKG_NAME_RE instanceof RegExp, String(PKG_NAME_RE));
	const validNames = ["dsh-vision-router", "@caob23/dsh-browser-control", "a", "pkg.name_1-x", "@scope.ok/pkg-1.2_3"];
	const invalidNames = ["", " dsh", "dsh ", "@scope/", "/name", "pkg;rm -rf", "pkg\n", "-lead", "pkg|x", "@scope/pkg extra"];
	check("PKG_NAME_RE 合法包名全部放行", validNames.every((n) => PKG_NAME_RE.test(n)), JSON.stringify(validNames.filter((n) => !PKG_NAME_RE.test(n))));
	check("PKG_NAME_RE 非法包名全部拒绝", invalidNames.every((n) => !PKG_NAME_RE.test(n)), JSON.stringify(invalidNames.filter((n) => PKG_NAME_RE.test(n))));

	// ---- 3) patch 清理：3 形态全命中 + 前缀超串不误删（纯函数，跑在副本上）
	check("chunkMatchesPackage：行级无引号", chunkMatchesPackage([`    - name: ${TARGET}`], TARGET) === true);
	check("chunkMatchesPackage：行级带引号+尾逗号", chunkMatchesPackage([`    - name: "${TARGET}",`], TARGET) === true);
	check("chunkMatchesPackage：flow-style 块", chunkMatchesPackage([`- keys: [{ id: "${TARGET}", enabled: true }]`], TARGET) === true);
	check("chunkMatchesPackage：前缀超串不误删", chunkMatchesPackage([`    - name: "${NEIGHBOR}"`], TARGET) === false);
	const patchCopy = join(tmp, "patch-copy.yml");
	copyFileSync(join(profile, "cordis.patch.yml"), patchCopy);
	const patchRes = removePatchEntriesFromFile(patchCopy, TARGET);
	check("patch 清理：3 形态全命中（removed=3/total=5）", patchRes.removed === 3 && patchRes.total === 5, JSON.stringify(patchRes));
	const keptText = readFileSync(patchCopy, "utf8");
	check("patch 清理：邻居块（超串名）与头注释保留（不过度删除）",
		keptText.includes(`name: "${NEIGHBOR}"`) && keptText.includes(`name: "${OTHER}"`) && keptText.startsWith("# patch fixture"),
		keptText.slice(0, 200));

	// ---- 4) 卸载成功矩阵（mode=ok）：全绿事务 + bundles 摘除 + patch 三形态清理 + 备份齐全
	// 1.0.3 S3：GET /plugins/api/bundles 也必须带令牌（不再裸奔），这里用已登录头 H
	const bundlesBefore = (await fetch(`${base}/plugins/api/bundles`, { headers: H }).then((r) => r.json())).bundles;
	check("bundle 列表含目标与邻居", bundlesBefore.some((b) => b.name === TARGET) && bundlesBefore.some((b) => b.name === NEIGHBOR), JSON.stringify(bundlesBefore));
	const okRes = await fetch(`${base}/plugins/api/uninstall`, { method: "POST", headers: H, body: JSON.stringify({ name: TARGET }) }).then((r) => r.json());
	check("卸载成功：ok=true", okRes.ok === true, JSON.stringify(okRes).slice(0, 400));
	const stepByName = (res, action) => (res.steps || []).find((s) => s.action === action);
	check("卸载成功：pnpm-remove / bundle-cleanup / patch-cleanup 均 ok",
		stepByName(okRes, "pnpm-remove")?.status === "ok" && stepByName(okRes, "bundle-cleanup")?.status === "ok" && stepByName(okRes, "patch-cleanup")?.status === "ok",
		JSON.stringify(okRes.steps).slice(0, 400));
	const manifestAfterOk = readManifest();
	check("卸载成功：dependencies 已摘除目标", !(TARGET in manifestAfterOk.dependencies), JSON.stringify(manifestAfterOk.dependencies));
	check("卸载成功：dsh.profile.bundles 已摘除目标（P1-2）", !manifestAfterOk.dsh.profile.bundles.includes(TARGET), JSON.stringify(manifestAfterOk.dsh));
	check("卸载成功：patch 三形态条目全部清除",
		!readFileSync(join(profile, "cordis.patch.yml"), "utf8").includes(`name: ${TARGET}`) &&
		!readFileSync(join(profile, "cordis.patch.yml"), "utf8").includes(`name: "${TARGET}"`) &&
		!readFileSync(join(profile, "cordis.patch.yml"), "utf8").includes(`id: "${TARGET}"`), "");
	check("卸载成功：邻居 patch 条目仍在（不过度删除）", readFileSync(join(profile, "cordis.patch.yml"), "utf8").includes(`name: "${NEIGHBOR}"`), "");
	const dirAfterOk = readdirSync(profile);
	check("卸载成功：清单滚动备份 + patch 一次性备份都生成",
		dirAfterOk.some((f) => /^package\.json\.bak-\d{4}/.test(f)) && dirAfterOk.some((f) => /^cordis\.patch\.yml\.uninstall-bak-/.test(f)), JSON.stringify(dirAfterOk));
	check("卸载成功：原子写后 manifest 仍是合法 JSON（P2-3）", JSON.parse(readFileSync(join(profile, "package.json"), "utf8")).name === "tx-profile");

	// ---- 5) 卸载失败矩阵（mode=fail）：pnpm 非零退出 → 清单回滚、patch 不动
	setMode("fail");
	const manifestBeforeFail = readFileSync(join(profile, "package.json"), "utf8");
	const patchBeforeFail = readFileSync(join(profile, "cordis.patch.yml"), "utf8");
	const failRes = await fetch(`${base}/plugins/api/uninstall`, { method: "POST", headers: H, body: JSON.stringify({ name: NEIGHBOR }) }).then((r) => r.json());
	check("卸载失败：ok=false 且提示已回滚清单", failRes.ok === false && (failRes.error || "").includes("回滚"), JSON.stringify(failRes).slice(0, 300));
	check("卸载失败：清单已回滚（内容与调用前逐字节一致）", readFileSync(join(profile, "package.json"), "utf8") === manifestBeforeFail, "");
	check("卸载失败：patch 文件未被改动", readFileSync(join(profile, "cordis.patch.yml"), "utf8") === patchBeforeFail, "");
	check("卸载失败：dependencies 仍含目标（回滚生效）", NEIGHBOR in readManifest().dependencies, "");
	setMode("ok");

	// ---- 6) 卸载超时矩阵（mode=timeout）：超时杀**自己启动的**子树 → 不回滚后继续、报明确错误
	setMode("timeout");
	const manifestBeforeTimeout = readFileSync(join(profile, "package.json"), "utf8");
	const t0 = Date.now();
	const timeoutRes = await fetch(`${base}/plugins/api/uninstall`, { method: "POST", headers: H, body: JSON.stringify({ name: NEIGHBOR }) }).then((r) => r.json());
	check("卸载超时：ok=false 且在超时窗内返回（含杀树+确认死亡）", timeoutRes.ok === false && Date.now() - t0 < 15000, `elapsed=${Date.now() - t0}ms ${JSON.stringify(timeoutRes).slice(0, 300)}`);
	check("卸载超时：steps 记录 pnpm-remove fail（含超时标记）", stepByName(timeoutRes, "pnpm-remove")?.status === "fail" && JSON.stringify(timeoutRes.steps).includes("超时"), JSON.stringify(stepByName(timeoutRes, "pnpm-remove")).slice(0, 200));
	check("卸载超时：清单保持调用前状态（不盲目回滚半成品，P1-4）", readFileSync(join(profile, "package.json"), "utf8") === manifestBeforeTimeout, "");
	// 杀树有效性：超时后 fake-pnpm 的 node 进程不应残留（轮询 5s）
	let leaked = null;
	for (let i = 0; i < 10; i += 1) {
		const q = spawnSync("powershell", ["-NoProfile", "-Command",
			"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'fake-pnpm' } | Select-Object -First 1 ProcessId | ConvertTo-Json -Compress"],
			{ encoding: "utf8", windowsHide: true, timeout: 8000 });
		const out = String(q.stdout || "").trim();
		leaked = out && out !== "null" && out !== "" ? out : null;
		if (!leaked) break;
		await sleep(500);
	}
	check("卸载超时：假 pnpm 子树已被 taskkill 清干净（无残留进程）", leaked === null, `leaked=${leaked}`);
	setMode("ok");

	// ---- 7) 单飞 409（P2-1）：第一个事务在执行中时，第二个 uninstall 与 update 都被 409 拒绝
	setMode("timeout");
	const flightA = fetch(`${base}/plugins/api/uninstall`, { method: "POST", headers: H, body: JSON.stringify({ name: NEIGHBOR }) }).then((r) => r.json());
	await sleep(400);
	const flightB = await fetch(`${base}/plugins/api/uninstall`, { method: "POST", headers: H, body: JSON.stringify({ name: NEIGHBOR }) }).then((r) => r.json());
	const flightC = await fetch(`${base}/plugins/api/update`, { method: "POST", headers: H, body: JSON.stringify({ name: NEIGHBOR }) }).then((r) => r.json());
	check("单飞：并发第二个 uninstall 得 409（busy=true）", flightB.busy === true, JSON.stringify(flightB).slice(0, 200));
	check("单飞：同飞道的 update 也得 409（同一把闸门）", flightC.busy === true, JSON.stringify(flightC).slice(0, 200));
	const a = await flightA;
	check("单飞：第一个事务最终完成并返回 ok=false（超时路径）", a && a.ok === false, JSON.stringify(a).slice(0, 200));
	setMode("ok");
	await sleep(300);

	// ---- 8) EBUSY fail-closed（P1-3）：裸 TCP 监听器（accept 不回包）在引擎端口上 → 握手超时 → 拒绝硬删
	const rawSockets = new Set();
	const raw = createRawServer((socket) => {
		rawSockets.add(socket);
		socket.on("close", () => rawSockets.delete(socket));
	});
	await new Promise((r) => raw.listen(ENGINE_PORT, "127.0.0.1", r));
	const manifestBeforeEbusy = readFileSync(join(profile, "package.json"), "utf8");
	const ebusyUninstall = await fetch(`${base}/plugins/api/uninstall`, { method: "POST", headers: H, body: JSON.stringify({ name: NEIGHBOR }) }).then((r) => r.json());
	check("EBUSY：裸监听器下 uninstall 被拒（blocked=engine-unknown）", ebusyUninstall.ok === false && ebusyUninstall.blocked === "engine-unknown", JSON.stringify(ebusyUninstall).slice(0, 300));
	check("EBUSY：错误文案含端口与监听者提示（fail-closed 而非当作引擎已停）", (ebusyUninstall.error || "").includes(`端口 ${ENGINE_PORT} 有监听者`), String(ebusyUninstall.error).slice(0, 200));
	const ebusyUpdate = await fetch(`${base}/plugins/api/update`, { method: "POST", headers: H, body: JSON.stringify({ name: NEIGHBOR }) }).then((r) => r.json());
	check("EBUSY：裸监听器下 update 同样被拒", ebusyUpdate.ok === false && ebusyUpdate.blocked === "engine-unknown", JSON.stringify(ebusyUpdate).slice(0, 200));
	check("EBUSY：两次拒绝均零副作用（清单逐字节一致）", readFileSync(join(profile, "package.json"), "utf8") === manifestBeforeEbusy, "");
	// 客户端 abort 后服务器侧 socket 可能停在半开状态：先显式销毁再 close，否则 close 回调永不触发
	for (const socket of rawSockets) socket.destroy();
	await new Promise((r) => raw.close(r));
} finally {
	try { if (child.exitCode === null) child.kill(); } catch { /* ignore */ }
	await sleep(300);
	try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
}
console.log(failures === 0 ? "\nTRANSACTIONAL TESTS PASSED" : `\nTRANSACTIONAL TESTS FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
