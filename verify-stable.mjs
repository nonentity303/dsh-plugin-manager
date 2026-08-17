// verify-stable.mjs — verify the MAIN environment (port 3080, plugin v0.6.4).
// Pure ASCII (PS 5.1 GBK trap).
const PORT = process.env.VERIFY_PORT || "3080";
const post = async (method, args) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "vs-" + Date.now(), method, payload: { args } })
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
  ok(entries.length > 100, `entries=${entries.length}`);
  const missing = entries.filter((e) => e.origin !== "builtin" && e.origin !== "user").length;
  ok(missing === 0, `all entries carry origin (missing=${missing})`);
  const builtin = entries.filter((e) => e.origin === "builtin").length;
  const user = entries.filter((e) => e.origin === "user").length;
  ok(builtin > 100 && user >= 5, `origin split builtin=${builtin} user=${user}`);
  const expectActive = ["plugin-manager-pro", "dsh-market", "better-sidebar", "office", "dsh-doc-reader", "dsh-better-sidebar-plugin-office"];
  for (const id of expectActive) {
    const e = entries.find((x) => x.configId === id);
    ok(e !== undefined && e.phase === "active", `entry ${id} active (phase=${e && e.phase})`);
  }
  // README 简介提取：用户 mod 不应再是"（无简介）"
  for (const id of ["dsh-market", "better-sidebar", "office", "dsh-doc-reader"]) {
    const e = entries.find((x) => x.configId === id);
    if (e) ok(e.description !== "（无简介）" && e.description.length > 8, `entry ${id} has readme intro (${e.description.slice(0, 40)})`);
  }
  const broken = entries.filter((e) => e.phase === "failed");
  ok(broken.length === 0, `no failed entries (${broken.length})`);
}
const catalog = await post("pluginManagerPro/marketCatalog", {});
ok(catalog.ok && ["live", "cache"].includes(catalog.value.source) && catalog.value.count > 500, `marketCatalog ${catalog.ok ? catalog.value.source : "?"} count=${catalog.ok ? catalog.value.count : "?"}`);
const diagnose = await post("pluginManagerPro/diagnose", {});
ok(diagnose.ok, "diagnose ok (rescue wire)");
const vp = await post("pluginManagerPro/verifyProfile", {});
ok(vp.ok && vp.value.ok === true, `verifyProfile ok (v0.6.4 fix) ${vp.ok ? JSON.stringify(vp.value.issues) : ""}`);
const rescuePage = await fetch(`http://127.0.0.1:${PORT}/rescue`);
ok(rescuePage.status === 200 && (await rescuePage.text()).includes("rescue"), "GET /rescue 200 with content");
const { writeFileSync } = await import("node:fs");
writeFileSync("C:\\Users\\35129\\Documents\\harness\\plugin-manager\\.stable-verify.json", JSON.stringify({
  port: PORT,
  list: list.ok ? { entries: list.value.entries.length } : null,
  market: catalog.ok ? { source: catalog.value.source, count: catalog.value.count } : null,
  verifyProfile: vp.ok ? vp.value : null,
  failures
}, null, 2), "utf8");
if (failures.length > 0) { console.error("STABLE VERIFY FAILED:", failures.join("; ")); process.exit(1); }
console.log("STABLE VERIFY OK");
