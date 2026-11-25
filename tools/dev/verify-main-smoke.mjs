// verify-main-smoke.mjs — 主实例（3080）v0.8 冒烟：只读端点 + 自检 + 救援页。
// Pure ASCII. Usage: VERIFY_PORT=3080 node verify-main-smoke.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = process.env.VERIFY_PORT || "3080";
const PROFILE_DIR = process.env.VERIFY_PROFILE_DIR || join(homedir(), ".dsh", "profiles", "web");

const post = async (method, args) => {
	const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "client-request", rpcId: "sm-" + Date.now(), method, payload: { args } })
	});
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { return { http: res.status, raw: text.slice(0, 200) }; }
	return json;
};

const failures = [];
const ok = (cond, label) => { if (cond) console.log("OK:", label); else { failures.push(label); console.error("FAIL:", label); } };

const list = await post("pluginManagerPro/list", {});
ok(list.result?.ok === true, "list ok");
const entries = list.result?.value?.entries ?? [];
// 改名兼容：新包 configId=drydock（旧包 plugin-manager-pro），两代都认
const pm = entries.find((e) => e.configId === "drydock" || e.configId === "plugin-manager-pro");
ok(pm !== undefined && pm.phase === "active" && pm.origin === "user", "manager (drydock/plugin-manager-pro) active origin=user");
ok(entries.every((e) => ["builtin", "local", "github", "npm"].includes(e.source)), "all entries carry source");
function readInstalledPkg(name) {
	try { return JSON.parse(readFileSync(join(PROFILE_DIR, "node_modules", name, "package.json"), "utf8")); } catch { return null; }
}
const installedPkg = readInstalledPkg("dsh-drydock") ?? readInstalledPkg("dsh-plugin-manager-pro");
if (installedPkg === null) throw new Error("installed manager package.json not found (dsh-drydock / dsh-plugin-manager-pro)");
ok(/^0\.8\.\d+$/.test(installedPkg.version), "installed manager version 0.8.x (got " + installedPkg.version + ")");

const vp = await post("pluginManagerPro/verifyProfile", {});
ok(vp.result?.ok === true && vp.result?.value?.ok === true, "verifyProfile ok");
const diag = await post("pluginManagerPro/diagnose", {});
ok(diag.result?.ok === true, "diagnose ok");
const hist = await post("pluginManagerPro/operationHistory", {});
ok(hist.result?.ok === true && Array.isArray(hist.result?.value?.operations), "operationHistory ok (new endpoint)");
const scen = await post("pluginManagerPro/scenarioList", {});
ok(scen.result?.ok === true && Array.isArray(scen.result?.value?.scenarios), "scenarioList ok (new endpoint)");
const prev = await post("pluginManagerPro/uninstallPreview", { packageNames: ["dshmarket"] });
ok(prev.result?.ok === true && prev.result?.value?.packages?.[0]?.canUninstall === true, "uninstallPreview ok (read-only)");

const rescuePage = await fetch(`http://127.0.0.1:${PORT}/rescue`);
ok(rescuePage.status === 200 && (await rescuePage.text()).includes("rescue"), "GET /rescue 200");

if (failures.length > 0) { console.error("MAIN SMOKE FAILED (" + failures.length + "):\n - " + failures.join("\n - ")); process.exit(1); }
console.log("MAIN SMOKE OK (port " + PORT + ")");
