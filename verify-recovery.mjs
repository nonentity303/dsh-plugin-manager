// verify-recovery.mjs — full post-restart verification for the rebuilt profile (v0.6.3).
// Pure ASCII (PS 5.1 GBK trap). Checks: list+origin, mod entries active, marketCatalog,
// rescue methods wire format, /rescue page 200.
const post = async (method, args) => {
  const res = await fetch(`http://127.0.0.1:3080/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "vr-" + Date.now(), method, payload: { args } })
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
  ok(builtin > 100 && user >= 6, `origin split builtin=${builtin} user=${user}`);
  const expectActive = ["plugin-manager-pro", "dsh-market"];
  for (const id of expectActive) {
    const e = entries.find((x) => x.configId === id);
    ok(e !== undefined && e.phase === "active", `entry ${id} active (phase=${e && e.phase})`);
  }
  for (const e of entries.filter((x) => x.origin === "user")) {
    console.log(`  user: ${e.configId} | pkg=${e.packageName} | phase=${e.phase}`);
  }
  const broken = entries.filter((e) => e.phase === "failed");
  ok(broken.length === 0, `no failed entries (${broken.length})`);
}
const catalog = await post("pluginManagerPro/marketCatalog", {});
ok(catalog.ok && catalog.value.source === "live" && catalog.value.count > 500, `marketCatalog live count=${catalog.ok ? catalog.value.count : "?"}`);
const diagnose = await post("pluginManagerPro/diagnose", {});
ok(diagnose.ok, "diagnose ok (rescue wire)");
const verify = await post("pluginManagerPro/verifyProfile", {});
ok(verify.ok && verify.value.ok === true, "verifyProfile ok (rescue wire)");
const rescuePage = await fetch("http://127.0.0.1:3080/rescue");
ok(rescuePage.status === 200 && (await rescuePage.text()).includes("rescue"), "GET /rescue 200 with content");
const list2 = await post("pluginManagerPro/list", {});
ok(list2.ok, "second list ok");
const { writeFileSync } = await import("node:fs");
writeFileSync("C:\\Users\\35129\\Documents\\harness\\plugin-manager\\.recovery-verify.json", JSON.stringify({
  list: list.ok ? { entries: list.value.entries.length, builtin: list.value.entries.filter((e) => e.origin === "builtin").length, user: list.value.entries.filter((e) => e.origin === "user").length } : null,
  market: catalog.ok ? { source: catalog.value.source, count: catalog.value.count } : null,
  failures
}, null, 2), "utf8");
if (failures.length > 0) { console.error("VERIFY FAILED:", failures.join("; ")); process.exit(1); }
console.log("RECOVERY VERIFY OK");
