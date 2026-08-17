// verify-refresh.mjs — 实测全量刷新耗时与成功率（v0.6.8：限流熔断 + 8 并发 + 240s 超时）。
// Pure ASCII. Usage: VERIFY_PORT=3081 node verify-refresh.mjs
const PORT = process.env.VERIFY_PORT || "3081";
const post = async (method, args) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "rf-" + Date.now(), method, payload: { args } })
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return { http: res.status, raw: text.slice(0, 200) }; }
  return json.result;
};
const failures = [];
const ok = (cond, label) => { if (cond) console.log("OK:", label); else { failures.push(label); console.error("FAIL:", label); } };

// 清版本缓存（setSources 等价效果）后计时 refresh
const t0 = Date.now();
const result = await post("pluginManagerPro/refresh", {});
const elapsed = Date.now() - t0;
console.log(`refresh completed in ${elapsed}ms, ok=${result.ok}`);
ok(result.ok, `refresh ok (${elapsed}ms)`);
ok(elapsed < 120000, `refresh under 120s (took ${Math.round(elapsed / 1000)}s)`);
if (result.ok) {
  const entries = result.value.entries;
  const withUpdate = entries.filter((e) => e.needsUpdate === true).length;
  const unknown = entries.filter((e) => e.needsUpdate === null && e.installedVersion !== null).length;
  console.log(`entries=${entries.length} needsUpdate=${withUpdate} unknown=${unknown}`);
  ok(unknown < entries.length * 0.5, `not too many unknown version states (${unknown}/${entries.length})`);
  // 再次 refresh 应命中缓存大幅提速
  const t1 = Date.now();
  await post("pluginManagerPro/refresh", {});
  const elapsed2 = Date.now() - t1;
  console.log(`second refresh in ${elapsed2}ms`);
  ok(elapsed2 < 30000, `cached refresh under 30s (took ${Math.round(elapsed2 / 1000)}s)`);
}
const { writeFileSync } = await import("node:fs");
writeFileSync("C:\\Users\\35129\\Documents\\harness\\plugin-manager\\.refresh-verify.json", JSON.stringify({
  port: PORT,
  firstMs: elapsed,
  secondMs: null,
  failures
}, null, 2), "utf8");
if (failures.length > 0) { console.error("REFRESH VERIFY FAILED:", failures.join("; ")); process.exit(1); }
console.log("REFRESH VERIFY OK");
