#!/usr/bin/env node
/**
 * test-ux.mjs — U1「兜底页 UX」静态验收（不依赖浏览器）。
 *
 * 覆盖三张页面的字符串 / HTML 结构断言：
 *   1. `/plugins` 兜底页：每个写操作 handler 都有 toast（发起 + 结果）、按钮 loading 态、
 *      结果卡片前移到用户插件列表之前、结果卡片 revealPanel 滚动 + 高亮。
 *   2. `/` 启动页：自检→修复→启动 有"在跑"的证据（spinner + 已等待 N 秒），失败/409 会停转。
 *   3. `/rescue` 救援页：每个按钮点击先进入 loading 态（禁用 + "处理中"文案）+ 发起文案 + 取消文案。
 *
 * 做法：直接调用 bin/open-boot.mjs 的 bootPageHtml / pluginsPageHtml 与
 * bin/rescue-daemon.mjs 的 rescuePageHtml 拿到真实 HTML，再用"函数体提取（花括号配平）"做断言，
 * 不 eval、不起服务、不开浏览器。
 *
 * 退出码：0 = 全绿；1 = 有断言失败。
 */
process.env.DSH_LAUNCHER_IMPORT_ONLY = "1"; // 导入 open-boot 时不得就地起服务（会 bind 3081）

const { bootPageHtml, pluginsPageHtml } = await import("./bin/open-boot.mjs");
const { rescuePageHtml } = await import("./bin/rescue-daemon.mjs");

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
	if (cond) {
		pass++;
		return true;
	}
	failures.push(name + (detail ? ` — ${detail}` : ""));
	console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
	return false;
}

/** 提取 `[async] function NAME(...) { ... }` 的函数体（花括号配平；这三张页面的函数体里没有含花括号的字符串）。 */
function extractFn(html, name) {
	const start = html.indexOf(`function ${name}(`);
	if (start < 0) return "";
	const braceStart = html.indexOf("{", start);
	if (braceStart < 0) return "";
	let depth = 0;
	for (let i = braceStart; i < html.length; i++) {
		const ch = html[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return html.slice(start, i + 1);
		}
	}
	return "";
}
/** 截取 startMarker（含）到 endMarker（不含）之间的文本；两个 markern 都必须唯一出现在期望位置。 */
function between(html, startMarker, endMarker) {
	const s = html.indexOf(startMarker);
	if (s < 0) return "";
	const e = html.indexOf(endMarker, s + startMarker.length);
	return e < 0 ? html.slice(s) : html.slice(s, e);
}
const count = (text, needle) => (text ? text.split(needle).length - 1 : 0);

// ---------------------------------------------------------------- 生成三张页面
const pluginHtml = pluginsPageHtml({ token: "t0ken", enginePort: 3180, launcherPort: 3181 });
const bootHtml = bootPageHtml({ token: "t0ken", enginePort: 3180 });
const rescueHtml = rescuePageHtml({ apiPrefix: "/rescue", enginePort: 3180, token: "t0ken" });

console.log("== U1 /plugins 兜底页 ==");

// —— 1. 回归锚点：被别的测试/外部逻辑依赖的结构不能被 UX 改动破坏
ok("兜底页保留一次性令牌 meta（外部测试与写接口依赖）",
	pluginHtml.includes('<meta name="dsh-pm-token" content="t0ken">') && pluginHtml.includes("X-DSH-PM-Token"),
	`meta=${pluginHtml.includes('meta name="dsh-pm-token"')} header=${pluginHtml.includes("X-DSH-PM-Token")}`);
ok("兜底页保留全部工具栏按钮 id（refresh/checkUpd/health/theme/restart/stop）",
	["refreshBtn", "checkUpdBtn", "healthBtn", "themeBtn", "restartBtn", "stopBtn"].every((id) => pluginHtml.includes(`id="${id}"`)));
ok("兜底页保留结果区 / 列表锚点（updRows / healthRows / stepRows / coreRows / userRows / toasts）",
	["updRows", "healthRows", "stepRows", "coreRows", "userRows", "toasts"].every((id) => pluginHtml.includes(`id="${id}"`)));

// —— 2. 结果卡片前移：#healthPanel / #updPanel / #stepPanel 必须排在 #userRows 与 #coreRows 之前
const idx = (needle) => pluginHtml.indexOf(needle);
const iUserRows = idx('id="userRows"');
const iCoreRows = idx('id="coreRows"');
const iHealth = idx('id="healthPanel"');
const iUpd = idx('id="updPanel"');
const iStep = idx('id="stepPanel"');
ok("#healthPanel 在 HTML 中的位置索引 < #userRows（结果区不再被长列表顶出视口）",
	iHealth > 0 && iUserRows > 0 && iHealth < iUserRows, `health=${iHealth} userRows=${iUserRows}`);
ok("#updPanel / #stepPanel 同样前移到列表之前",
	iUpd > 0 && iStep > 0 && iUpd < iUserRows && iStep < iUserRows, `upd=${iUpd} step=${iStep} userRows=${iUserRows}`);
ok("结果区排在核心组件卡片之前（紧跟顶部工具栏与状态行）",
	iHealth < iCoreRows && iUpd < iCoreRows && iStep < iCoreRows, `health=${iHealth} core=${iCoreRows}`);
ok("工具栏卡片本身仍在结果区之前",
	idx('id="engstate"') < iHealth && idx('id="engstate"') > 0);

// —— 3. 统一反馈机制存在
ok("统一按钮 loading 态实现存在（setBusy / withBusy）",
	extractFn(pluginHtml, "setBusy").length > 0 && extractFn(pluginHtml, "withBusy").length > 0);
ok("结果卡片落点实现存在（revealPanel：scrollIntoView + nearest/start 对齐 + flash 高亮）",
	extractFn(pluginHtml, "revealPanel").includes("scrollIntoView") &&
	extractFn(pluginHtml, "revealPanel").includes('"nearest"') &&
	extractFn(pluginHtml, "revealPanel").includes('"start"') &&
	extractFn(pluginHtml, "revealPanel").includes("flash"));
ok("高亮动画有 CSS 支撑（@keyframes cardflash / .card.flash / button.busy）",
	pluginHtml.includes("@keyframes cardflash") && pluginHtml.includes(".card.flash") && pluginHtml.includes("button.busy"));
ok("toast 不拦截点击（#toasts pointer-events:none）且禁用开关不吞事件（input:disabled pointer-events:none）",
	pluginHtml.includes("pointer-events:none") &&
	/#toasts\{[^}]*pointer-events:none/.test(pluginHtml) &&
	/\.toggle input:disabled\{pointer-events:none\}/.test(pluginHtml));
ok("失败 toast 必带原因（failText 兜住服务端未返回原因的情况）",
	extractFn(pluginHtml, "failText").includes("服务端未返回原因"));

// —— 4. 每个写操作入口：发起态 + toast（结果 / 失败原因）
const handlers = [
	["doUpdate（行内/更新卡片按钮）", extractFn(pluginHtml, "doUpdate")],
	["doUninstall（行内卸载按钮）", extractFn(pluginHtml, "doUninstall")],
	["loadBundles（刷新按钮）", extractFn(pluginHtml, "loadBundles")],
	["refreshUpdates（检查更新按钮）", extractFn(pluginHtml, "refreshUpdates")],
	["runHealth（mod 体检按钮）", extractFn(pluginHtml, "runHealth")],
	["restartBtn（重启引擎）", between(pluginHtml, 'document.getElementById("restartBtn").addEventListener("click"', 'document.getElementById("stopBtn").addEventListener("click"')],
	["stopBtn（停止本启动器）", between(pluginHtml, 'document.getElementById("stopBtn").addEventListener("click"', 'document.getElementById("userRows").addEventListener("change"')],
	["userRows（行内启用/禁用开关）", between(pluginHtml, 'document.getElementById("userRows").addEventListener("change"', "var engineUp = false;")],
	["市场详情按钮", between(pluginHtml, 'var mk = el("button", null, "市场详情");', "row.appendChild(mk);")],
	["核心组件开关（disabled 但要点出原因）", between(pluginHtml, "if (b.core) {", "return label;")],
	["主题按钮点击", between(pluginHtml, 'themeBtn.addEventListener("click", function(){', 'themeBtn.addEventListener("pointerdown"')]
];
for (const [name, body] of handlers) {
	ok(`${name}：存在且至少 1 处 toast 反馈`, body.length > 0 && count(body, "toast(") >= 1, `len=${body.length} toast=${count(body, "toast(")}`);
}
for (const [name, minToasts] of [["doUpdate（行内/更新卡片按钮）", 2], ["doUninstall（行内卸载按钮）", 2], ["loadBundles（刷新按钮）", 1], ["refreshUpdates（检查更新按钮）", 1], ["runHealth（mod 体检按钮）", 1], ["userRows（行内启用/禁用开关）", 2], ["restartBtn（重启引擎）", 1], ["stopBtn（停止本启动器）", 1]]) {
	const body = handlers.find(([n]) => n === name)[1];
	ok(`${name}：发起 + 结果都有 toast（≥${minToasts} 处）`, count(body, "toast(") >= minToasts, `toast=${count(body, "toast(")}`);
}
ok("写操作失败 toast 带原因（doUpdate / doUninstall / loadBundles / refreshUpdates / runHealth 都走 failText）",
	["doUpdate", "doUninstall", "loadBundles", "refreshUpdates", "runHealth"].every((fn) => extractFn(pluginHtml, fn).includes("failText(")));
ok("长耗时操作开始前先 toast「正在…」（更新/卸载/体检/检查更新）",
	["doUpdate", "doUninstall", "refreshUpdates", "runHealth"].every((fn) => extractFn(pluginHtml, fn).includes('"warn")') || extractFn(pluginHtml, fn).includes("toast(")) &&
	extractFn(pluginHtml, "runHealth").includes("正在做 mod 体检"));
ok("按钮 loading 态覆盖工具栏写操作（刷新/检查更新/体检用 withBusy，重启/停止用 setBusy）",
	["refreshBtn", "checkUpdBtn", "healthBtn"].every((id) =>
		between(pluginHtml, `document.getElementById("${id}").addEventListener("click"`, "});").includes("withBusy")) &&
	between(pluginHtml, 'document.getElementById("restartBtn").addEventListener("click"', 'document.getElementById("stopBtn")').includes("setBusy") &&
	between(pluginHtml, 'document.getElementById("stopBtn").addEventListener("click"', 'document.getElementById("userRows")').includes("setBusy"));
ok("行内开关点击后进入禁用态（防重复点击）",
	between(pluginHtml, 'document.getElementById("userRows").addEventListener("change"', "var engineUp = false;").includes("input.disabled = true"));
ok("doUpdate / doUninstall 期间按钮显示「更新中…/卸载中…」",
	extractFn(pluginHtml, "doUpdate").includes('"更新中…"') && extractFn(pluginHtml, "doUninstall").includes('"卸载中…"'));
ok("取消操作也有 toast（doUpdate / doUninstall / 重启 / 停止 都不是静默返回）",
	["doUpdate", "doUninstall"].every((fn) => /已取消/.test(extractFn(pluginHtml, fn))) &&
	/已取消/.test(between(pluginHtml, 'document.getElementById("restartBtn").addEventListener("click"', 'document.getElementById("stopBtn")')) &&
	/已取消/.test(between(pluginHtml, 'document.getElementById("stopBtn").addEventListener("click"', 'document.getElementById("userRows")')));

// —— 5. 结果可见性：runHealth / refreshUpdates 完成后滚动到结果卡片
ok("runHealth 成功后调用 revealPanel(\"healthPanel\")（滚动 + 高亮到体检结果）",
	extractFn(pluginHtml, "runHealth").includes('revealPanel("healthPanel")'));
ok("refreshUpdates 成功后调用 revealPanel(\"updPanel\")",
	extractFn(pluginHtml, "refreshUpdates").includes('revealPanel("updPanel")'));
ok("卸载结果（步骤日志）也会 revealPanel(\"stepPanel\")",
	extractFn(pluginHtml, "doUninstall").includes('revealPanel("stepPanel")'));
ok("体检结论 toast 带关键数字与人话（组件数 / 正常 / 可疑 / 异常）",
	extractFn(pluginHtml, "runHealth").includes("体检完成") && extractFn(pluginHtml, "runHealth").includes("/ 异常 "));
ok("#health 直达仍能看见结果（location.hash + hashchange 都会触发 runHealth）",
	pluginHtml.includes('location.hash === "#health"') && pluginHtml.includes('"hashchange"') && pluginHtml.includes("runHealth();"));

console.log("\n== U1 / 启动页（自检→修复→启动）==");
ok("启动页保留令牌 meta（外部测试依赖）", bootHtml.includes('<meta name="dsh-pm-token" content="t0ken">'));
ok("启动页有「正在跑」的视觉证据：spinner + 已等待秒数计时器",
	bootHtml.includes('class="spinner" id="spin"') && bootHtml.includes('id="elapsed"') &&
	bootHtml.includes("setInterval") && bootHtml.includes("已等待 "));
ok("转圈不是永久的：成功 / 失败 / 409 / 异常分支都会停转（stopSpin 至少 4 处调用）",
	count(bootHtml, "stopSpin()") >= 4, `stopSpin=${count(bootHtml, "stopSpin()")}`);
ok("409（已有启动流程在执行）会停转并给出下一步指引，不再无限转圈",
	/if \(r\.code === 409\)[\s\S]{0,400}stopSpin\(\)/.test(bootHtml) && bootHtml.includes("本页不会自动跳转"));
ok("启动/自检/修复结果都有日志行（不是只有转圈没有文字）",
	bootHtml.includes("自检：") && bootHtml.includes("修复：") && bootHtml.includes("引擎已启动"));

console.log("\n== U1 /rescue 救援页 ==");
ok("救援页保留令牌 meta 与全套 API 路径（test-launcher 的锚点不回归）",
	rescueHtml.includes('<meta name="dsh-pm-token" content="t0ken">') &&
	["/api/verify", "/api/fix", "/api/start", "/api/stop", "/api/status"].every((p) => rescueHtml.includes(p)));
ok("五个按钮都把自身传给 handler（onclick=\"... (this)\"），才能做 loading 态",
	count(rescueHtml, "(this)") >= 5, `(this)=${count(rescueHtml, "(this)")}`);
ok("救援页有 busy/withBusy 实现（禁用按钮 + 还原文案 + 完成闪一下）",
	rescueHtml.includes("function busy(") && rescueHtml.includes("async function withBusy(") &&
	rescueHtml.includes("btn.disabled = true"));
for (const [name, body] of [
	["runVerify", extractFn(rescueHtml, "runVerify")],
	["runFix", extractFn(rescueHtml, "runFix")],
	["runStatus", extractFn(rescueHtml, "runStatus")],
	["startAndOpen", extractFn(rescueHtml, "startAndOpen")],
	["runStop", extractFn(rescueHtml, "runStop")]
]) {
	ok(`救援页 ${name}：点击即进入 loading 态（withBusy）+ 先显示「…中」再出结果`,
		body.includes("withBusy(") && body.includes("show("), `len=${body.length}`);
}
ok("救援页每个操作都有「发起中」文案（检查中/修复中/读取中/启动中/停止中）",
	["检查中…", "修复中…", "正在读取引擎", "正在启动引擎", "正在停止引擎"].every((s) => rescueHtml.includes(s)));
ok("救援页取消操作有明确回执（已取消…）",
	rescueHtml.includes("已取消修复") && rescueHtml.includes("已取消停止"));
ok("救援页失败信息带原因（检查/修复失败都区分 error 与兜底）",
	rescueHtml.includes("检查失败：") && rescueHtml.includes("修复失败：") && rescueHtml.includes("请求失败："));

// —— 三页共同的"操作发起"反馈下限
console.log("\n== U1 跨页面 ==");
ok("三页各自至少有一条「操作发起」反馈（兜底页 withBusy / 启动页 spinner+计时 / 救援页 busy）",
	pluginHtml.includes("withBusy(") && bootHtml.includes('class="spinner" id="spin"') && rescueHtml.includes("withBusy("));
ok("反馈不止写日志：三页都有可见的 toast / 状态行 / 结果区文案",
	pluginHtml.includes("function toast(") && bootHtml.includes('id="elapsed"') && rescueHtml.includes('id="out"'));

if (failures.length > 0) {
	console.error(`\nRESULT: FAIL（${failures.length}/${pass + failures.length} 条断言失败）\n - ` + failures.join("\n - "));
	process.exit(1);
}
console.log(`\nRESULT: PASS（${pass} checks）`);
process.exit(0);
