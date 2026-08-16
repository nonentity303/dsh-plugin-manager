/**
 * /rescue 独立救援页：完全自包含的 HTML（无外部依赖、不依赖任何客户端插件/设置页），
 * 直接调用 /api 网关的救砖方法。浏览器访问 http://127.0.0.1:3080/rescue 即可使用。
 */
const RESCUE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH 插件管理器 · 救援中心</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #111418; color: #e6e8eb; margin: 0; padding: 24px; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: #8b949e; font-size: 13px; margin: 0 0 20px; }
  .card { background: #1a1f26; border: 1px solid #2a323c; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
  .card h2 { font-size: 14px; margin: 0 0 10px; }
  button { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 7px; border: 1px solid #3a4450; background: #232a33; color: #e6e8eb; cursor: pointer; margin: 0 6px 6px 0; }
  button:hover { background: #2c3540; }
  button.primary { background: #d64541; border-color: #d64541; color: #fff; font-weight: 600; }
  button.danger { background: #b33; border-color: #b33; color: #fff; }
  button.ok { background: #2e7d32; border-color: #2e7d32; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .issue { border: 1px solid #4a1d1d; background: #241414; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .issue b { color: #ff8a80; }
  .issue pre { margin: 6px 0 0; font-size: 11px; color: #b0a8a8; white-space: pre-wrap; word-break: break-all; max-height: 80px; overflow: auto; }
  .ok-note { color: #81c784; font-size: 13px; }
  .warn-note { color: #ffd54f; font-size: 13px; }
  .log { font-size: 12px; color: #8b949e; white-space: pre-wrap; font-family: ui-monospace, monospace; margin-top: 8px; max-height: 160px; overflow: auto; }
  .muted { color: #6b7280; font-size: 12px; }
  label { font-size: 13px; display: flex; align-items: center; gap: 8px; margin-bottom: 10px; cursor: pointer; }
</style>
</head>
<body>
<main>
  <h1>🛟 DSH 插件管理器 · 救援中心</h1>
  <p class="sub">独立于设置页的救砖入口：诊断 → 隔离/卸载问题插件 → 修复引擎 → 重启。所有操作直连宿主网关，不依赖任何界面插件。</p>

  <div class="card">
    <h2>① 诊断</h2>
    <button onclick="diagnose()">运行诊断</button>
    <span id="diag-status" class="muted"></span>
    <div id="diag-result" style="margin-top:10px"></div>
  </div>

  <div class="card">
    <h2>② 一键修复引擎</h2>
    <p class="muted">重置本管理器写入的开关 → 自动隔离全部失败插件 → 清空缓存。</p>
    <button class="primary" onclick="repair()">执行修复</button>
    <div id="repair-result" style="margin-top:10px"></div>
  </div>

  <div class="card">
    <h2>③ 重启引擎</h2>
    <p class="muted">当前进程退出，约 2 秒后自动拉起新实例（需要 Node 可执行文件仍在原路径）。</p>
    <button class="danger" onclick="restart()">重启 dsh web</button>
    <div id="restart-result" style="margin-top:10px"></div>
  </div>

  <div class="card">
    <h2>④ 卸载插件（profile 依赖）</h2>
    <p class="muted">卸载前请先确认：该操作会从 profile 的 package.json 移除依赖与 bundles 条目，重启后生效。</p>
    <div id="uninstall-list"></div>
    <div id="uninstall-result" style="margin-top:10px"></div>
  </div>

  <div class="card">
    <h2>⑤ 自动隔离</h2>
    <label><input type="checkbox" id="auto-q"> 加载失败的插件自动禁用（默认关闭）</label>
    <button class="ok" onclick="saveAuto()">保存</button>
    <span id="auto-status" class="muted"></span>
  </div>

  <div class="card">
    <h2>操作日志</h2>
    <div id="log" class="log"></div>
  </div>
</main>
<script>
const BASE = "/api";
let rpcSeq = 0;

async function rpc(method, payload) {
  const body = { type: "client-request", rpcId: "rescue-" + (++rpcSeq), method, payload: payload === undefined ? {} : { args: payload } };
  const res = await fetch(BASE + "/" + method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const full = await res.json();
  if (!full.result.ok) throw new Error((full.result.error && full.result.error.message) || "RPC failed");
  return full.result.value;
}

function log(line) {
  const el = document.getElementById("log");
  const stamp = new Date().toLocaleTimeString();
  el.textContent += "[" + stamp + "] " + line + "\\n";
  el.scrollTop = el.scrollHeight;
}

async function diagnose() {
  const status = document.getElementById("diag-status");
  const box = document.getElementById("diag-result");
  status.textContent = "诊断中…";
  try {
    const result = await rpc("pluginManagerPro/diagnose", {});
    const issues = result.issues || [];
    status.textContent = "发现 " + issues.length + " 个问题条目";
    if (issues.length === 0) {
      box.innerHTML = '<p class="ok-note">✓ 未发现加载失败或运行期错误。</p>';
      log("diagnose: 0 issues");
      return;
    }
    box.innerHTML = issues.map((issue) =>
      '<div class="issue"><b>' + esc(issue.configId) + '</b> <span class="muted">' + esc(issue.moduleName) + ' · ' + esc(issue.phase) + '</span>' +
      (issue.error ? '<pre>' + esc(issue.error) + '</pre>' : '') +
      '<div style="margin-top:8px">' +
      (issue.suggestion === "disable" ? '<button onclick="quarantine(\'' + issue.entryId + '\')">禁用此插件</button>' : '<span class="muted">救援保护条目</span>') +
      (issue.canUninstall ? '<button class="danger" onclick="uninstallPkg(\'' + esc(issue.moduleName) + '\')">卸载</button>' : '') +
      '</div></div>'
    ).join("");
    log("diagnose: " + issues.length + " issues");
  } catch (e) {
    status.textContent = "诊断失败：" + e.message;
    log("diagnose error: " + e.message);
  }
}

async function quarantine(entryId) {
  try {
    const result = await rpc("pluginManagerPro/quarantine", { entryIds: [entryId] });
    const item = result.items && result.items[0];
    log("quarantine " + entryId + " -> " + (item ? item.status : "?") + (item && item.message ? ": " + item.message : ""));
    alert(item ? item.status + (item.message ? "：" + item.message : "") : "完成");
    diagnose();
  } catch (e) {
    log("quarantine error: " + e.message);
    alert("隔离失败：" + e.message);
  }
}

async function repair() {
  const box = document.getElementById("repair-result");
  box.innerHTML = '<span class="muted">执行中…</span>';
  try {
    const result = await rpc("pluginManagerPro/repairHarness", {});
    box.innerHTML = '<span class="ok-note">✓ 修复完成</span><div class="log">' +
      (result.actions || []).map((a) => esc("· " + a.action + ": " + a.detail)).join("\\n") +
      '</div><p class="muted">如需让禁用/重置生效，可执行 ③ 重启引擎，或在终端运行：<code>' + esc(result.restartCommand || "dsh web") + '</code></p>';
    (result.actions || []).forEach((a) => log(a.action + ": " + a.detail));
    diagnose();
  } catch (e) {
    box.innerHTML = '<span class="warn-note">修复失败：' + esc(e.message) + '</span>';
    log("repair error: " + e.message);
  }
}

function restart() {
  if (!confirm("确认重启 dsh web 引擎？当前页面将断连，约 3-5 秒后恢复（请刷新页面）。")) return;
  rpc("pluginManagerPro/restartHarness", {}).then((result) => {
    document.getElementById("restart-result").innerHTML = '<span class="ok-note">' + esc(result.message) + '</span>';
    log("restartHarness accepted");
  }).catch((e) => {
    document.getElementById("restart-result").innerHTML = '<span class="warn-note">' + esc(e.message) + '</span>';
  });
}

async function uninstallPkg(packageName) {
  if (!confirm("确认卸载 " + packageName + " ？重启 profile 后生效，如需恢复请重新 dsh plugin add。")) return;
  try {
    const result = await rpc("pluginManagerPro/uninstallPackages", { packageNames: [packageName] });
    const item = result.items && result.items[0];
    log("uninstall " + packageName + " -> " + (item ? item.status : "?"));
    alert(item ? (item.status === "removed" ? "已卸载" : item.message) : "完成");
    loadUninstall();
  } catch (e) {
    alert("卸载失败：" + e.message);
    log("uninstall error: " + e.message);
  }
}

async function loadUninstall() {
  const box = document.getElementById("uninstall-list");
  try {
    const snap = await rpc("pluginManagerPro/list", {});
    const managed = (snap.entries || []).filter((e) => e.managed);
    if (managed.length === 0) {
      box.innerHTML = '<p class="muted">没有可卸载的 profile 依赖。</p>';
      return;
    }
    box.innerHTML = managed.map((e) =>
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #232a33">' +
      '<span>' + esc(e.configId) + ' <span class="muted">' + esc(e.moduleName) + '</span></span>' +
      '<button class="danger" onclick="uninstallPkg(\\'' + esc(e.moduleName).replace(/\\\\/g, "\\\\") + '\\')">卸载</button></div>'
    ).join("");
  } catch (e) {
    box.innerHTML = '<span class="warn-note">读取失败：' + esc(e.message) + '</span>';
  }
}

async function saveAuto() {
  const on = document.getElementById("auto-q").checked;
  try {
    await rpc("pluginManagerPro/setRescueConfig", { config: { autoQuarantine: on } });
    document.getElementById("auto-status").textContent = "已保存";
    log("setRescueConfig autoQuarantine=" + on);
  } catch (e) {
    document.getElementById("auto-status").textContent = "保存失败：" + e.message;
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

(async function init() {
  try {
    const snap = await rpc("pluginManagerPro/list", {});
    log("连接正常 · profile=" + snap.profileName + " · 条目=" + (snap.entries || []).length);
    const cfg = await rpc("pluginManagerPro/getRescueConfig", {}).catch(() => null);
    document.getElementById("auto-q").checked = !!(cfg && cfg.autoQuarantine);
  } catch (e) {
    log("初始化失败（围栏/网关不可达？）: " + e.message);
  }
  loadUninstall();
})();
</script>
</body>
</html>
`;

export { RESCUE_HTML };
