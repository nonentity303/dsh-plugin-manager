// verify-sandbox.mjs — verify the sandbox test profile (port 3081, plugin v0.6.4).
// Pure ASCII (PS 5.1 GBK trap). Isolated from the main env (3080).
const PORT = process.env.VERIFY_PORT || "3081";
const post = async (method, args) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "sb-" + Date.now(), method, payload: { args } })
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return { http: res.status, raw: text.slice(0, 200) }; }
  return json.result;
};
const failures = [];
const ok = (cond, label) => { if (cond) console.log("OK:", label); else { failures.push(label); console.error("FAIL:", label); } };

const list = await post("pluginManagerPro/list", {});
ok(list.ok, "list ok");
if (list.ok) {
  const entries = list.value.entries;
  const builtin = entries.filter((e) => e.origin === "builtin").length;
  const user = entries.filter((e) => e.origin === "user").length;
  const missing = entries.filter((e) => e.origin !== "builtin" && e.origin !== "user").length;
  ok(missing === 0, `all entries carry origin (missing=${missing})`);
  ok(builtin > 50 && user >= 1, `origin split builtin=${builtin} user=${user}`);
  const pm = entries.find((e) => e.configId === "plugin-manager-pro");
  ok(pm !== undefined && pm.phase === "active" && pm.origin === "user", "plugin-manager-pro active + origin=user");
}
const catalog = await post("pluginManagerPro/marketCatalog", {});
ok(catalog.ok && ["live", "cache"].includes(catalog.value.source) && catalog.value.count > 500, `marketCatalog ${catalog.ok ? catalog.value.source : "?"} count=${catalog.ok ? catalog.value.count : "?"}`);
const withNpm = catalog.ok ? catalog.value.items.find((i) => i.npm) : null;
if (withNpm) {
  const dr = await post("pluginManagerPro/marketInstall", { target: { name: withNpm.name, npm: withNpm.npm, url: withNpm.url }, dryRun: true });
  ok(dr.ok && dr.value.status === "dry-run" && dr.value.method === "npm", "marketInstall npm dry-run");
}
const diagnose = await post("pluginManagerPro/diagnose", {});
ok(diagnose.ok, "diagnose ok (rescue wire)");
const vp = await post("pluginManagerPro/verifyProfile", {});
ok(vp.ok && vp.value.ok === true, `verifyProfile ok (v0.6.4 fix) ${vp.ok ? JSON.stringify(vp.value.issues) : ""}`);
const rescuePage = await fetch(`http://127.0.0.1:${PORT}/rescue`);
ok(rescuePage.status === 200 && (await rescuePage.text()).includes("rescue"), "GET /rescue 200 with content");
// toggle persistence: pick a non-protected entry, flip, flip back, check patch file
if (list.ok) {
  const target = list.value.entries.find((e) => !e.protected && !e.archived);
  if (target) {
    const r1 = await post("pluginManagerPro/setEnabled", { entryId: target.entryId, enabled: !target.enabled });
    const r2 = await post("pluginManagerPro/setEnabled", { entryId: target.entryId, enabled: target.enabled });
    ok(r1.ok && r2.ok, `toggle persistence ok (${target.configId})`);
  } else {
    ok(false, "no toggle target found");
  }
}
const { readFileSync, writeFileSync } = await import("node:fs");
let patchText = "";
try { patchText = readFileSync("C:\\Users\\35129\\.dsh\\profiles\\web-test\\cordis.patch.yml", "utf8"); } catch {}
ok(/Managed by dsh-plugin-manager-pro/.test(patchText), "patch file written by manager");
writeFileSync("C:\\Users\\35129\\Documents\\harness\\plugin-manager\\.sandbox-verify.json", JSON.stringify({
  port: PORT,
  list: list.ok ? { entries: list.value.entries.length, builtin: list.value.entries.filter((e) => e.origin === "builtin").length, user: list.value.entries.filter((e) => e.origin === "user").length } : null,
  market: catalog.ok ? { source: catalog.value.source, count: catalog.value.count } : null,
  verifyProfile: vp.ok ? vp.value : null,
  failures
}, null, 2), "utf8");
if (failures.length > 0) { console.error("SANDBOX VERIFY FAILED:", failures.join("; ")); process.exit(1); }
console.log("SANDBOX VERIFY OK");
