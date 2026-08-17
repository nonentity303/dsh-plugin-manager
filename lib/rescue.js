/**
 * /rescue 独立救援页：完全自包含的 HTML（无外部依赖、不依赖任何客户端插件/设置页），
 * 直接调用 /api 网关的救砖方法。浏览器访问 http://127.0.0.1:3080/rescue 即可使用。
 *
 * v0.5.2：增加醒目反馈 —— 顶部状态横幅（引擎在线/离线）、自动诊断、
 * Toast 通知、按钮执行态、操作结果内联展示。
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
  p.sub { color: #8b949e; font-size: 13px; margin: 0 0 16px; }
  .banner { border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
  .banner.ok { background: #14281a; border: 1px solid #2e7d32; color: #81c784; }
  .banner.bad { background: #2a1414; border: 1px solid #b33; color: #ff8a80; }
  .banner.warn { background: #2a2414; border: 1px solid #b3a000; color: #ffd54f; }
  .banner small { font-weight: 400; color: inherit; opacity: .8; }
  .card { background: #1a1f26; border: 1px solid #2a323c; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
  .card h2 { font-size: 14px; margin: 0 0 10px; }
  button { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 7px; border: 1px solid #3a4450; background: #232a33; color: #e6e8eb; cursor: pointer; margin: 0 6px 6px 0; }
  button:hover:not(:disabled) { background: #2c3540; }
  button:disabled { opacity: .55; cursor: default; }
  button.primary { background: #d64541; border-color: #d64541; color: #fff; font-weight: 600; }
  button.danger { background: #b33; border-color: #b33; color: #fff; }
  button.ok { background: #2e7d32; border-color: #2e7d32; color: #fff; }
  .issue { border: 1px solid #4a1d1d; background: #241414; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
  .issue b { color: #ff8a80; }
  .issue pre { margin: 6px 0 0; font-size: 11px; color: #b0a8a8; white-space: pre-wrap; word-break: break-all; max-height: 80px; overflow: auto; }
  .result { margin-top: 10px; font-size: 13px; }
  .result.ok { color: #81c784; }
  .result.warn { color: #ffd54f; }
  .result.bad { color: #ff8a80; }
  .result pre { margin: 6px 0 0; font-size: 12px; color: #8b949e; white-space: pre-wrap; font-family: ui-monospace, monospace; }
  .log { font-size: 12px; color: #6b7280; white-space: pre-wrap; font-family: ui-monospace, monospace; margin-top: 8px; max-height: 160px; overflow: auto; }
  .muted { color: #6b7280; font-size: 12px; }
  label { font-size: 13px; display: flex; align-items: center; gap: 8px; margin-bottom: 10px; cursor: pointer; }
  #toast-wrap { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 9999; display: flex; flex-direction: column; gap: 8px; width: min(560px, 90vw); }
  .toast { padding: 10px 14px; border-radius: 8px; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.5); animation: slide .2s ease; }
  .toast.ok { background: #14281a; border: 1px solid #2e7d32; color: #81c784; }
  .toast.bad { background: #2a1414; border: 1px solid #b33; color: #ff8a80; }
  .toast.warn { background: #2a2414; border: 1px solid #b3a000; color: #ffd54f; }
  .toast.info { background: #16202b; border: 1px solid #2a5c8a; color: #8ab8ff; }
  @keyframes slide { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<main>
  <h1>🛟 DSH 插件管理器 · 救援中心</h1>
  <p class="sub">独立于设置页的救砖入口：诊断 → 隔离/卸载问题插件 → 修复引擎 → 重启。所有操作直连宿主网关。</p>

  <div id="status-banner" class="banner warn">⏳ 正在连接引擎…</div>

  <div class="card">
    <h2>① 诊断（自动运行）</h2>
    <button id="diag-btn" onclick="diagnose()">重新诊断</button>
    <span id="diag-status" class="muted"></span>
    <div id="diag-result" style="margin-top:10px"></div>
  </div>

  <div class="card">
    <h2>② 一键修复引擎</h2>
    <p class="muted">重置本管理器写入的开关 → 自动隔离全部失败插件 → 清空缓存。</p>
    <button id="repair-btn" class="primary" onclick="repair()">执行修复</button>
    <div id="repair-result" class="result"></div>
  </div>

  <div class="card">
    <h2>③ 重启引擎</h2>
    <p class="muted">当前进程退出，约 2 秒后自动拉起新实例。</p>
    <button id="restart-btn" class="danger" onclick="restart()">重启 dsh web</button>
    <div id="restart-result" class="result"></div>
  </div>

  <div class="card">
    <h2>④ 启动前自检</h2>
    <p class="muted">检查 bundles 可解析性与补丁文件——坏 bundle 会让引擎起不来，这里可以一键隔离。</p>
    <button id="verify-btn" onclick="verifyProfile()">运行检查</button>
    <button id="fix-btn" class="danger" onclick="fixProfile()">修复引擎配置</button>
    <div id="verify-result" class="result"></div>
  </div>

  <div class="card">
    <h2>⑤ 卸载插件（profile 依赖）</h2>
    <p class="muted">卸载会从 profile 的 package.json 移除依赖与 bundles 条目，重启后生效。</p>
    <div id="uninstall-list"></div>
    <div id="uninstall-result" class="result"></div>
  </div>

  <div class="card">
    <h2>⑥ 自动隔离</h2>
    <label><input type="checkbox" id="auto-q"> 加载失败的插件自动禁用（默认关闭）</label>
    <button id="auto-btn" class="ok" onclick="saveAuto()">保存</button>
    <span id="auto-status" class="muted"></span>
  </div>

  <div class="card">
    <h2>操作日志</h2>
    <div id="log" class="log"></div>
  </div>
</main>
<div id="toast-wrap"></div>
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

function toast(message, type) {
  const wrap = document.getElementById("toast-wrap");
  const el = document.createElement("div");
  el.className = "toast " + (type || "info");
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 3600);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 4000);
}

function setBanner(kind, html) {
  const b = document.getElementById("status-banner");
  b.className = "banner " + kind;
  b.innerHTML = html;
}

function setBusy(id, busy) {
  const el = document.getElementById(id);
  if (el) el.disabled = busy;
}

function setResult(id, kind, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = "result " + kind;
  el.textContent = text;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function diagnose() {
  setBusy("diag-btn", true);
  const status = document.getElementById("diag-status");
  const box = document.getElementById("diag-result");
  status.textContent = "诊断中…";
  try {
    const result = await rpc("pluginManagerPro/diagnose", {});
    const issues = result.issues || [];
    status.textContent = "发现 " + issues.length + " 个问题条目";
    if (issues.length === 0) {
      box.innerHTML = '<p class="result ok">✓ 未发现加载失败或运行期错误。</p>';
      toast("✓ 诊断完成：0 个问题", "ok");
      log("diagnose: 0 issues");
      return;
    }
    box.innerHTML = issues.map((issue) =>
      '<div class="issue"><b>' + esc(issue.configId) + '</b> <span class="muted">' + esc(issue.moduleName) + ' · ' + esc(issue.phase) + '</span>' +
      (issue.error ? '<pre>' + esc(issue.error) + '</pre>' : '') +
      '<div style="margin-top:8px">' +
      (issue.suggestion === "disable" ? '<button onclick="quarantine(\\'' + issue.entryId + '\\', this)">禁用此插件</button>' : '<span class="muted">救援保护条目</span>') +
      (issue.canUninstall ? '<button class="danger" onclick="uninstallPkg(\\'' + esc(issue.moduleName) + '\\', this)">卸载</button>' : '') +
      '</div></div>'
    ).join("");
    toast("⚠ 诊断发现 " + issues.length + " 个问题条目", "warn");
    log("diagnose: " + issues.length + " issues");
  } catch (e) {
    status.textContent = "诊断失败";
    setResult("diag-result", "bad", "诊断失败：" + e.message);
    toast("诊断失败：" + e.message, "bad");
    log("diagnose error: " + e.message);
  } finally {
    setBusy("diag-btn", false);
  }
}

async function quarantine(entryId, btn) {
  if (btn) btn.disabled = true;
  try {
    const result = await rpc("pluginManagerPro/quarantine", { entryIds: [entryId] });
    const item = result.items && result.items[0];
    const msg = item ? (item.status + (item.message ? "：" + item.message : "")) : "完成";
    log("quarantine " + entryId + " -> " + msg);
    toast(item && item.status === "disabled" ? "✓ 已禁用 " + entryId : "⚠ " + msg, item && item.status === "disabled" ? "ok" : "warn");
    await diagnose();
  } catch (e) {
    log("quarantine error: " + e.message);
    toast("隔离失败：" + e.message, "bad");
  }
}

async function repair() {
  setBusy("repair-btn", true);
  setResult("repair-result", "", "执行中…");
  try {
    const result = await rpc("pluginManagerPro/repairHarness", {});
    const lines = (result.actions || []).map((a) => "· " + a.action + ": " + a.detail).join("\\n");
    setResult("repair-result", "ok", "✓ 修复完成\\n" + lines + "\\n重启命令：" + esc(result.restartCommand || "dsh web"));
    toast("✓ 修复完成（" + (result.actions || []).length + " 项操作）", "ok");
    (result.actions || []).forEach((a) => log(a.action + ": " + a.detail));
    await diagnose();
  } catch (e) {
    setResult("repair-result", "bad", "修复失败：" + e.message);
    toast("修复失败：" + e.message, "bad");
    log("repair error: " + e.message);
  } finally {
    setBusy("repair-btn", false);
  }
}

function restart() {
  if (!confirm("确认重启 dsh web 引擎？当前页面将断连，约 3-5 秒后恢复（请刷新页面）。")) return;
  setBusy("restart-btn", true);
  setResult("restart-result", "warn", "正在重启引擎…当前页面即将断连，请稍后刷新。");
  rpc("pluginManagerPro/restartHarness", {}).then((result) => {
    setResult("restart-result", "ok", esc(result.message));
    toast("引擎重启已接受：约 3-5 秒后恢复，请刷新页面", "ok");
    log("restartHarness accepted");
  }).catch((e) => {
    setResult("restart-result", "bad", esc(e.message));
    toast("重启失败：" + e.message, "bad");
    setBusy("restart-btn", false);
  });
}

async function verifyProfile() {
  setBusy("verify-btn", true);
  setResult("verify-result", "", "检查中…");
  try {
    const result = await rpc("pluginManagerPro/verifyProfile", {});
    if (result.ok) {
      setResult("verify-result", "ok", "✓ profile 配置正常，引擎可以正常启动。");
      toast("✓ 启动前自检通过", "ok");
    } else {
      const lines = (result.issues || []).map((i) => "⚠ " + i.name + ": " + i.reason).join("\\n");
      setResult("verify-result", "bad", lines);
      toast("⚠ 发现 " + (result.issues || []).length + " 个问题（引擎可能无法启动）", "warn");
    }
    log("verifyProfile ok=" + result.ok);
  } catch (e) {
    setResult("verify-result", "bad", "检查失败：" + e.message);
    toast("检查失败：" + e.message, "bad");
  } finally {
    setBusy("verify-btn", false);
  }
}

async function fixProfile() {
  if (!confirm("确认执行？将备份并隔离损坏的 bundle、还原损坏的补丁文件。")) return;
  setBusy("fix-btn", true);
  setResult("verify-result", "", "修复中…");
  try {
    const result = await rpc("pluginManagerPro/fixProfile", {});
    const lines = (result.actions || []).map((a) => "· " + a.action + ": " + a.detail).join("\\n");
    setResult("verify-result", result.ok ? "ok" : "bad", (result.message ? result.message + "\\n" : "") + lines);
    toast(result.ok ? "✓ 引擎配置已修复" : "⚠ 修复未完全成功", result.ok ? "ok" : "warn");
    (result.actions || []).forEach((a) => log(a.action + ": " + a.detail));
    await verifyProfile();
  } catch (e) {
    setResult("verify-result", "bad", "修复失败：" + e.message);
    toast("修复失败：" + e.message, "bad");
  } finally {
    setBusy("fix-btn", false);
  }
}

async function uninstallPkg(packageName, btn) {
  if (!confirm("确认卸载 " + packageName + " ？重启 profile 后生效，如需恢复请重新 dsh plugin add。")) return;
  if (btn) btn.disabled = true;
  try {
    const result = await rpc("pluginManagerPro/uninstallPackages", { packageNames: [packageName] });
    const item = result.items && result.items[0];
    const msg = item ? (item.status === "removed" ? "已卸载" : (item.message || item.status)) : "完成";
    log("uninstall " + packageName + " -> " + msg);
    toast(item && item.status === "removed" ? "✓ 已卸载 " + packageName + "（重启后生效）" : "⚠ " + msg, item && item.status === "removed" ? "ok" : "warn");
    loadUninstall();
  } catch (e) {
    toast("卸载失败：" + e.message, "bad");
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
      '<button class="danger" onclick="uninstallPkg(\\'' + esc(e.moduleName).replace(/\\\\/g, "\\\\") + '\\', this)">卸载</button></div>'
    ).join("");
  } catch (e) {
    box.innerHTML = '<span class="result bad">读取失败：' + esc(e.message) + '</span>';
  }
}

async function saveAuto() {
  const on = document.getElementById("auto-q").checked;
  setBusy("auto-btn", true);
  try {
    await rpc("pluginManagerPro/setRescueConfig", { config: { autoQuarantine: on } });
    document.getElementById("auto-status").textContent = "已保存（" + (on ? "开启" : "关闭") + "）";
    toast("✓ 自动隔离已" + (on ? "开启" : "关闭"), "ok");
    log("setRescueConfig autoQuarantine=" + on);
  } catch (e) {
    document.getElementById("auto-status").textContent = "保存失败：" + e.message;
    toast("保存失败：" + e.message, "bad");
  } finally {
    setBusy("auto-btn", false);
  }
}

(async function init() {
  try {
    const snap = await rpc("pluginManagerPro/list", {});
    const entries = (snap.entries || []).length;
    const sources = (snap.sources || []).length;
    setBanner("ok", "✅ 引擎在线 <small>profile=" + esc(snap.profileName) + " · 条目 " + entries + " · 更新源 " + sources + "</small>");
    toast("✅ 已连接引擎（profile: " + esc(snap.profileName) + "）", "ok");
    log("connected: profile=" + snap.profileName + " entries=" + entries);
  } catch (e) {
    setBanner("bad", "❌ 无法连接引擎 <small>" + esc(e.message) + " —— 请确认 dsh web 正在运行；若因坏插件无法启动，请使用桌面「DeepSeek Harness Web UI」救援启动</small>");
    toast("❌ 无法连接引擎：" + e.message, "bad");
    log("init failed: " + e.message);
  }
  try {
    const cfg = await rpc("pluginManagerPro/getRescueConfig", {}).catch(() => null);
    document.getElementById("auto-q").checked = !!(cfg && cfg.autoQuarantine);
  } catch (e) { /* ignore */ }
  loadUninstall();
  diagnose();
})();
</script>
</body>
</html>
`;

export { RESCUE_HTML };
