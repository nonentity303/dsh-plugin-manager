// verify-origin.mjs — after-engine-restart endpoint check for v0.6.2 origin field.
// Pure ASCII on purpose (PS 5.1 reads no-BOM UTF-8 as GBK when invoked via scripts).
const post = async (method, args) => {
  const res = await fetch(`http://127.0.0.1:3080/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "verify-" + Date.now(), method, payload: { args } })
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return { http: res.status, raw: text.slice(0, 300) }; }
  return json.result;
};
const result = {};
const list = await post("pluginManagerPro/list", {});
if (!list.ok) {
  console.error("list failed:", JSON.stringify(list.error));
  process.exit(1);
}
const entries = list.value.entries;
const builtin = entries.filter((e) => e.origin === "builtin").length;
const user = entries.filter((e) => e.origin === "user").length;
const missing = entries.filter((e) => e.origin !== "builtin" && e.origin !== "user").length;
console.log(`list ok; entries=${entries.length} builtin=${builtin} user=${user} missing-origin=${missing}`);
for (const e of entries.filter((x) => x.origin === "user")) {
  console.log(`  user: ${e.configId} | pkg=${e.packageName} | phase=${e.phase}`);
}
if (missing > 0 || user === 0 || builtin === 0) {
  console.error("ORIGIN VERIFY FAILED");
  process.exit(1);
}
const catalog = await post("pluginManagerPro/marketCatalog", {});
console.log("marketCatalog:", catalog.ok ? `source=${catalog.value.source} count=${catalog.value.count}` : JSON.stringify(catalog.error));
result.list = { entries: entries.length, builtin, user };
result.catalog = catalog.ok ? { source: catalog.value.source, count: catalog.value.count } : null;
const { writeFileSync } = await import("node:fs");
writeFileSync("C:\\Users\\35129\\Documents\\harness\\plugin-manager\\.origin-verify.json", JSON.stringify(result, null, 2), "utf8");
console.log("ORIGIN VERIFY OK");
